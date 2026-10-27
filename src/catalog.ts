/**
 * Building the catalog of what the speaker can actually control.
 *
 * Two sources, in this order:
 *  1. Home Assistant's WebSocket API (`config/entity_registry/list`, `config/area_registry/list`,
 *     `config/device_registry/list`) - authoritative, gives areas, floors and live state, and
 *     the exposure set the conversation agent is configured to see.
 *  2. The system prompt of the incoming request - whatever Home Assistant published there is
 *     by definition what the model was allowed to target. Format is version-dependent, so the
 *     parser is deliberately tolerant and simply finds nothing rather than guessing wrongly.
 */

import type { Catalog, CatalogArea, CatalogEntity } from './types.js';
import type { Config } from './config.js';
import { normalise, sha1, titleCase } from './util.js';
import { note } from './log.js';

interface CacheEntry {
  catalog: Catalog;
  at: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<Catalog> | null = null;

/** Domains whose state we can say something useful about. */
const DOMAIN_PRIORITY = [
  'light',
  'switch',
  'cover',
  'lock',
  'fan',
  'climate',
  'media_player',
  'scene',
  'script',
  'vacuum',
  'humidifier',
  'water_heater',
  'button',
  'input_boolean',
  'todo',
  'sensor',
  'binary_sensor',
  'number',
  'select',
  'alarm_control_panel',
  'valve',
];

function sortEntities(entities: CatalogEntity[]): CatalogEntity[] {
  const rank = (domain: string): number => {
    const index = DOMAIN_PRIORITY.indexOf(domain);
    return index === -1 ? DOMAIN_PRIORITY.length : index;
  };
  return entities.sort((a, b) => {
    const byDomain = rank(a.domain) - rank(b.domain);
    if (byDomain !== 0) return byDomain;
    const byArea = (a.areaName ?? '~').localeCompare(b.areaName ?? '~');
    if (byArea !== 0) return byArea;
    return a.name.localeCompare(b.name);
  });
}

function domainsOf(entities: CatalogEntity[]): string[] {
  return [...new Set(entities.map((entity) => entity.domain))].sort(
    (a, b) =>
      (DOMAIN_PRIORITY.indexOf(a) === -1 ? 99 : DOMAIN_PRIORITY.indexOf(a)) -
      (DOMAIN_PRIORITY.indexOf(b) === -1 ? 99 : DOMAIN_PRIORITY.indexOf(b)),
  );
}

/**
 * A batch of JSON messages over Home Assistant's WebSocket API.
 *
 * Every command is sent at once and answers are matched by `id`, because one slow command must
 * not starve the rest: a sequential batch shares a single deadline, and a large `get_states`
 * was enough to make the exposure list — the only authority on what Assist can see — time out
 * and disappear, leaving the whole registry in the catalog.
 */
function wsQuery<T>(
  url: string,
  token: string,
  messages: { type: string; optional?: boolean }[],
  timeoutMs = 8000,
  onSkip?: (type: string, reason: string) => void,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    const results: T[] = new Array(messages.length) as T[];
    const answered = new Set<number>();
    let settled = false;
    let sent = false;

    const firstMissing = (): number => messages.findIndex((_, index) => !answered.has(index));

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(results);
    };

    const timer = setTimeout(() => {
      const missing = firstMissing();
      if (missing >= 0) {
        onSkip?.(messages[missing]?.type ?? 'batch', `Home Assistant did not answer within ${timeoutMs} ms`);
        finish();
        return;
      }
      finish(new Error('Home Assistant WebSocket timed out'));
    }, timeoutMs);

    const sendAll = (): void => {
      if (sent) return;
      sent = true;
      messages.forEach((message, index) => ws.send(JSON.stringify({ id: index + 1, ...message })));
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      let payload: {
        id?: number;
        type?: string;
        success?: boolean;
        result?: unknown;
        error?: { message?: string; code?: string };
      };
      try {
        payload = JSON.parse(String(event.data)) as typeof payload;
      } catch {
        return;
      }
      if (payload.type === 'auth_required') return;
      if (payload.type === 'auth_invalid') {
        finish(new Error('Home Assistant rejected the token'));
        return;
      }
      if (payload.type === 'auth_ok') {
        sendAll();
        return;
      }
      if (payload.type !== 'result') return;

      const slot = typeof payload.id === 'number' ? payload.id - 1 : -1;
      const requested = messages[slot];
      if (!requested || answered.has(slot)) return;

      if (payload.success === false) {
        // An optional command is skipped: older cores do not implement every endpoint.
        if (!requested.optional) {
          finish(new Error(payload.error?.message ?? 'Home Assistant refused the request'));
          return;
        }
        onSkip?.(requested.type, payload.error?.message ?? payload.error?.code ?? 'refused');
        results[slot] = undefined as T;
      } else {
        results[slot] = payload.result as T;
      }
      answered.add(slot);
      if (answered.size === messages.length) finish();
    });

    ws.addEventListener('error', () => finish(new Error('Home Assistant WebSocket error')));
    ws.addEventListener('close', () => {
      const missing = firstMissing();
      if (missing >= 0) {
        onSkip?.(messages[missing]?.type ?? 'batch', 'Home Assistant closed the connection before answering');
      }
      finish();
    });
  });
}

interface RegistryEntity {
  entity_id?: string;
  aliases?: string[] | null;
  name?: string | null;
  original_name?: string | null;
  area_id?: string | null;
  device_id?: string | null;
  disabled_by?: string | null;
  hidden_by?: string | null;
  entity_category?: string | null;
}

interface RegistryArea {
  area_id?: string;
  name?: string;
  floor_id?: string | null;
  aliases?: string[] | null;
}

interface RegistryDevice {
  id?: string;
  area_id?: string | null;
  name?: string | null;
  name_by_user?: string | null;
}

interface RegistryFloor {
  floor_id?: string;
  name?: string;
}

interface StateRow {
  entity_id?: string;
  state?: string;
  attributes?: Record<string, unknown>;
}

/** Trimmed, de-duplicated, non-empty names. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name.length > 0 && name.length <= 80) out.add(name);
  }
  return [...out];
}

const LEVEL_ATTRIBUTES: {
  attribute: string;
  levelIn: NonNullable<CatalogEntity['levelIn']>;
  scale?: number;
}[] = [
  { attribute: 'brightness', levelIn: 'brightness' },
  { attribute: 'percentage', levelIn: 'percentage' },
  { attribute: 'current_position', levelIn: 'position' },
  { attribute: 'volume_level', levelIn: 'volume_level' },
  { attribute: 'temperature', levelIn: 'temperature' },
  { attribute: 'humidity', levelIn: 'humidity' },
];

function levelFrom(attributes: Record<string, unknown>): Pick<CatalogEntity, 'level' | 'levelIn'> {
  for (const { attribute, levelIn } of LEVEL_ATTRIBUTES) {
    const raw = attributes[attribute];
    if (typeof raw === 'number' && Number.isFinite(raw)) return { level: raw, levelIn };
  }
  return {};
}

/**
 * When Home Assistant refuses to report exposure, fall back to the entities it named in the
 * request's system prompt: that prompt lists what the conversation agent can see.
 *
 * Never guesses downward — if the prompt names nothing (a different prompt format), or names
 * almost everything, the registry stands.
 */
let lastPromptIds: Set<string> | null = null;

/** The entity ids the most recent request named; a refresh has no request of its own. */
export function rememberPromptExposure(ids: string[]): void {
  lastPromptIds = ids.length ? new Set(ids) : null;
}

export function promptExposure(): Set<string> | null {
  return lastPromptIds;
}

export function narrowFromPrompt(catalog: Catalog, prompt: string | undefined, config: Config): Catalog {
  if (!config.catalog.exposedOnly) return catalog;
  if (catalog.exposure?.ok !== false) return catalog;
  if (!prompt) {
    // No request in hand (the dashboard or a scheduled refresh): use the last one seen.
    if (!lastPromptIds) return catalog;
    if (lastPromptIds.size < 3 || lastPromptIds.size >= catalog.entities.length) return catalog;
    return narrowCatalog(catalog, lastPromptIds, 'Home Assistant did not report exposure, so these are the entities Assist last named');
  }
  const spoken = catalogFromPrompt(prompt);
  const ids = new Set(spoken.entities.map((entity) => entity.id));
  rememberPromptExposure([...ids]);
  if (ids.size < 3 || ids.size >= catalog.entities.length) return catalog;
  return narrowCatalog(catalog, ids, 'Home Assistant did not report exposure, so these are the entities this request named');
}

/**
 * Keep only the given entity ids, and say so in the note.
 *
 * Used when Home Assistant will not say what is exposed: the system prompt it sends already
 * names only the entities its conversation agent can see, so it is a usable stand-in.
 */
export function narrowCatalog(catalog: Catalog, ids: Set<string>, why: string): Catalog {
  const entities = catalog.entities.filter((entity) => ids.has(entity.id));
  if (!entities.length) return catalog;
  const usedAreas = new Set(entities.map((entity) => entity.areaId).filter(Boolean));
  const areas = catalog.areas.filter((area) => usedAreas.has(area.id));
  return {
    ...catalog,
    entities,
    domains: domainsOf(entities),
    ...(areas.length ? { areas } : {}),
    note: `${entities.length} of ${catalog.entities.length} entities (${why})`,
    exposure: {
      ok: false,
      ...(catalog.exposure?.reason ? { reason: catalog.exposure.reason } : {}),
      exposed: entities.length,
      registry: catalog.entities.length,
      used: 'prompt',
    },
  };
}

/** `light.kitchen_ceiling` and nothing else. */
function isEntityId(value: string): boolean {
  return /^[a-z_]+\.[a-z0-9_]+$/.test(value);
}

/**
 * Home Assistant answers `homeassistant/expose_entity/list` in more than one shape:
 *   { exposed_entities: { conversation: { light.x: true } } }
 *   { exposed_entities: { light.x: true } }
 *   { light.x: { conversation: true } }
 * All of them collapse to entity_id -> exposed. Returns null when the answer cannot
 * be read, so the caller falls back to listing the registry instead of hiding entities.
 */
export function exposedToConversation(payload: unknown): Record<string, boolean> | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const inner =
    root.exposed_entities && typeof root.exposed_entities === 'object'
      ? (root.exposed_entities as Record<string, unknown>)
      : root;

  const perAssistant = inner.conversation;
  if (perAssistant && typeof perAssistant === 'object') {
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(perAssistant as Record<string, unknown>)) {
      if (isEntityId(id)) out[id] = value === true;
    }
    return Object.keys(out).length ? out : null;
  }

  // Entities are exposed to at least one assistant or they would not be listed at all, so an
  // answer that parses to nothing is an unusable answer, not a house with nothing exposed.

  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(inner)) {
    if (!isEntityId(id)) continue;
    if (typeof value === 'boolean') out[id] = value;
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.conversation === 'boolean') out[id] = record.conversation;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ask Home Assistant one question: which entities are exposed to Assist?
 *
 * Same command the catalog uses, but with nothing optional, so every refusal surfaces with the
 * wording Home Assistant used. This is what the dashboard's "Check exposure" button calls — a
 * wrong entity count should be explainable in one click.
 */
export interface ExposureProbe {
  ok: boolean;
  command: string;
  error?: string;
  count?: number;
  assistants?: Record<string, number>;
  sample?: string[];
  usable?: boolean;
}

export async function fetchExposureMap(config: Config): Promise<Record<string, boolean> | null> {
  const base = config.catalog.haUrl.replace(/\/+$/, '');
  if (!base || !config.catalog.haToken) return null;
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/websocket`;
  const [payload] = await wsQuery<unknown>(wsUrl, config.catalog.haToken, [
    { type: 'homeassistant/expose_entity/list' },
  ], 10000);
  return exposedToConversation(payload);
}

export async function probeExposure(config: Config): Promise<ExposureProbe> {
  const command = 'homeassistant/expose_entity/list';
  const base = config.catalog.haUrl.replace(/\/+$/, '');
  if (!base || !config.catalog.haToken) {
    return { ok: false, command, error: 'Home Assistant URL and token are not configured' };
  }
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/websocket`;
  let payload: unknown;
  try {
    const [result] = await wsQuery<unknown>(wsUrl, config.catalog.haToken, [{ type: command }], 10000);
    payload = result;
  } catch (error) {
    return { ok: false, command, error: error instanceof Error ? error.message : String(error) };
  }

  const parsed = exposedToConversation(payload);
  const assistants: Record<string, number> = {};
  const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const inner = (root.exposed_entities ?? root) as Record<string, unknown>;
  for (const value of Object.values(inner)) {
    if (!value || typeof value !== 'object') continue;
    for (const assistant of Object.keys(value as Record<string, unknown>)) {
      assistants[assistant] = (assistants[assistant] ?? 0) + 1;
    }
  }
  return {
    ok: true,
    command,
    count: parsed ? Object.values(parsed).filter(Boolean).length : 0,
    usable: Boolean(parsed),
    assistants,
    sample: parsed ? Object.entries(parsed).filter(([, on]) => on).slice(0, 5).map(([id]) => id) : [],
    ...(parsed
      ? {}
      : { error: 'Home Assistant answered, but the response named no entities exposed to Assist' }),
  };
}

/** Structured catalog straight from Home Assistant. */
export async function catalogFromHomeAssistant(config: Config): Promise<Catalog> {
  const base = config.catalog.haUrl.replace(/\/+$/, '');
  if (!base || !config.catalog.haToken) throw new Error('Home Assistant URL and token are not configured');
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/websocket`;

  let exposureError: string | undefined;
  // Exposure is asked FIRST on purpose: it is a few kilobytes, it is the only authority on
  // what Assist can see, and a large get_states later in the batch must not starve it.
  const [exposed, areas, devices, floors, entities, states] = await wsQuery<
    RegistryArea[] | RegistryDevice[] | RegistryFloor[] | RegistryEntity[] | StateRow[] | unknown
  >(wsUrl, config.catalog.haToken, [
    { type: 'homeassistant/expose_entity/list', optional: true },
    { type: 'config/area_registry/list' },
    { type: 'config/device_registry/list' },
    { type: 'config/floor_registry/list' },
    { type: 'config/entity_registry/list' },
    { type: 'get_states' },
  ], 25000, (type, reason) => {
    if (type === 'homeassistant/expose_entity/list') exposureError = reason;
  });

  // Exposure comes from its own question, the same one the dashboard's Check exposure button
  // asks, so the button and the catalog can never disagree. The batched answer is only a
  // fallback: it shares a socket and a deadline with five other queries and can be lost.
  let conversation: Record<string, boolean> | null = null;
  if (config.catalog.exposedOnly) {
    try {
      conversation = await fetchExposureMap(config);
    } catch (error: unknown) {
      exposureError = error instanceof Error ? error.message : String(error);
    }
    if (!conversation) {
      conversation = exposedToConversation(exposed);
      if (conversation && !exposureError) exposureError = undefined;
      if (!conversation && !exposureError) exposureError = 'the exposure list could not be read';
    }
  }
  const catalog = catalogFromRegistries({
    areas: (areas ?? []) as RegistryArea[],
    devices: (devices ?? []) as RegistryDevice[],
    floors: (floors ?? []) as RegistryFloor[],
    entities: (entities ?? []) as RegistryEntity[],
    states: (states ?? []) as StateRow[],
    exposed: conversation,
    exposedOnly: config.catalog.exposedOnly,
  });
  const registry = ((entities ?? []) as RegistryEntity[]).length;
  note(
    conversation
      ? `catalog: ${Object.values(conversation).filter(Boolean).length} of ${registry} entities exposed to Assist`
      : `catalog: exposure not applied${exposureError ? ` (${exposureError})` : ''}, ${registry} entities in the registry`,
  );
  return {
    ...catalog,
    exposure: conversation
      ? {
          ok: true,
          exposed: Object.values(conversation).filter(Boolean).length,
          registry,
          used: 'expose_entity_list',
        }
      : {
          ok: false,
          // Says exactly what Home Assistant answered, so a wrong count is explainable.
          // An `unauthorized` here almost always means a non-admin token: the endpoint requires one.
          reason: exposureError
            ? /unauthori[sz]ed|admin/i.test(exposureError)
              ? `Home Assistant refused the exposure list (${exposureError}). Reading exposure needs a long-lived token from an administrator.`
              : exposureError
            : 'the exposure list could not be read',
          registry,
          used: 'none',
        },
  };
}

/** Registry rows in, catalog out. Separate from the socket so it can be tested. */
export function catalogFromRegistries(input: {
  areas: RegistryArea[];
  devices: RegistryDevice[];
  floors: RegistryFloor[];
  entities: RegistryEntity[];
  states: StateRow[];
  /** entity_id -> exposed to the conversation agent, when Home Assistant can say. */
  exposed?: Record<string, boolean> | null;
  /** Restrict the catalog to exposed entities (default true). */
  exposedOnly?: boolean;
}): Catalog {
  const {
    areas: areaList,
    devices: deviceList,
    floors: floorList,
    entities: entityList,
    states: stateList,
  } = input;

  const floorName = new Map<string, string>();
  for (const floor of floorList) {
    if (floor.floor_id && floor.name) floorName.set(floor.floor_id, floor.name);
  }
  const areaById = new Map<string, CatalogArea>();
  for (const area of areaList) {
    if (!area.area_id || !area.name) continue;
    const areaAliases = strings(area.aliases);
    areaById.set(area.area_id, {
      id: area.area_id,
      name: area.name,
      ...(area.floor_id && floorName.has(area.floor_id) ? { floor: floorName.get(area.floor_id)! } : {}),
      ...(areaAliases.length ? { aliases: areaAliases } : {}),
    });
  }
  const deviceArea = new Map<string, string | null | undefined>();
  for (const device of deviceList) {
    if (device.id) deviceArea.set(device.id, device.area_id ?? null);
  }
  const stateById = new Map<string, StateRow>();
  for (const row of stateList) {
    if (row.entity_id) stateById.set(row.entity_id, row);
  }

  const exposed = input.exposed ?? null;
  const exposedOnly = input.exposedOnly ?? true;
  let registryCount = 0;

  const out: CatalogEntity[] = [];
  for (const entity of entityList) {
    const id = entity.entity_id;
    if (!id) continue;
    // Skip what a conversation agent would not be exposed anyway.
    if (entity.disabled_by || entity.hidden_by || entity.entity_category) continue;
    registryCount += 1;
    // When Home Assistant tells us what is exposed to Assist, that is the truth: it is
    // the same list the voice assistant works from, so the decision model sees exactly
    // what can be acted on instead of the whole registry.
    if (exposed && exposedOnly && exposed[id] !== true) continue;
    const domain = id.split('.')[0];
    if (!domain) continue;
    const state = stateById.get(id);
    const areaId = entity.area_id ?? (entity.device_id ? deviceArea.get(entity.device_id) : undefined) ?? undefined;
    const area = areaId ? areaById.get(areaId) : undefined;
    const friendly =
      (state?.attributes?.friendly_name as string | undefined) ??
      entity.name ??
      entity.original_name ??
      id.split('.')[1]?.replace(/_/g, ' ') ??
      id;
    const aliases = strings(entity.aliases);
    out.push({
      id,
      name: friendly,
      domain,
      ...(aliases.length ? { aliases } : {}),
      state: state?.state ?? 'unknown',
      ...(areaId ? { areaId } : {}),
      ...(area ? { areaName: area.name, ...(area.floor ? { floor: area.floor } : {}) } : {}),
      ...(typeof state?.attributes?.device_class === 'string'
        ? { deviceClass: state.attributes.device_class }
        : {}),
      // The unit is what makes an answer read as a sentence ("21.5 °C") and what a value
      // slot needs to interpret a spoken number.
      ...(typeof state?.attributes?.unit_of_measurement === 'string' &&
      state.attributes.unit_of_measurement.trim()
        ? { unit: state.attributes.unit_of_measurement.trim() }
        : {}),
      ...levelFrom(state?.attributes ?? {}),
    });
  }

  // Keep only the domains the fast path can act on; anything else is noise to the model.
  const filtered = out.filter((entity) => DOMAIN_PRIORITY.includes(entity.domain));
  const entitiesSorted = sortEntities(filtered);
  return {
    areas: [...areaById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    entities: entitiesSorted,
    domains: domainsOf(entitiesSorted),
    source: 'ha-websocket',
    builtAt: Date.now(),
    note:
      exposed && exposedOnly
        ? `${entitiesSorted.length} of ${registryCount} entities exposed to Assist, ${areaById.size} areas`
        : `${entitiesSorted.length} entities, ${areaById.size} areas from Home Assistant`,
  };
}

/**
 * Tolerant parser for the "available devices" listing Home Assistant puts in the
 * system prompt. It understands the common `<domain>.<object_id>: <state>` shape and
 * the "- <name> (<domain>.<object_id>)" shape; either way the id is the anchor.
 */
export function catalogFromPrompt(prompt: string): Catalog {
  const entities: CatalogEntity[] = [];
  const seen = new Set<string>();
  const idPattern = /\b([a-z_]+)\.([a-z0-9_]+)\b/g;


  // Home Assistant renders the prompt in sections, and the section a device sits under
  // is often the only statement of where it is ("## Kitchen" then "- Ceiling Light
  // (light.kitchen_ceiling)"). Without that, an area-scoped request cannot resolve.
  let sectionArea: string | undefined;
  let last: CatalogEntity | undefined;

  for (const line of prompt.split(/\r?\n/)) {
    idPattern.lastIndex = 0;
    const match = idPattern.exec(line);
    if (!match?.[1] || !match[2]) {
      // An alias may be rendered on its own line under the device it belongs to.
      const aliasLine = ALIAS_LINE.exec(line.trim());
      if (last && aliasLine?.[1]) {
        last.aliases = [...(last.aliases ?? []), ...splitAliases(aliasLine[1])];
        continue;
      }
      const heading = headingArea(line);
      if (heading !== undefined) sectionArea = heading;
      continue;
    }
    const id = `${match[1]}.${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const domain = match[1];

    // Name: whatever precedes the id, minus bullets, brackets and separators.
    const before = line.slice(0, match.index).replace(/[*_`()[\]]/g, ' ');
    // State: what follows a colon or comma after the id.
    const after = line.slice(match.index + id.length);
    const stateMatch = after.match(/[:,-]\s*([a-z0-9 _.-]{1,40})/i);

    const name = before
      .replace(/^[\s\-•*]+/, '')
      .replace(/\b(area|domain|state|entities|names?|aliases?)\b:?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const areaName = matchArea(line) ?? sectionArea;
    const inlineAliases = splitAliases(ALIAS_INLINE.exec(line)?.[1] ?? '');
    const record: CatalogEntity = {
      id,
      name: name ? titleCase(name) : (id.split('.')[1] ?? id).replace(/_/g, ' '),
      domain,
      state: (stateMatch?.[1] ?? 'unknown').trim().toLowerCase(),
      ...(areaName ? { areaName, areaId: `area_${areaName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}` } : {}),
      ...(inlineAliases.length ? { aliases: inlineAliases } : {}),
    };
    entities.push(record);
    last = record;
  }

  const sorted = sortEntities(entities);
  const areaByName = new Map<string, CatalogArea>();
  for (const entity of sorted) {
    if (!entity.areaName) continue;
    const id = entity.areaId ?? `area_${entity.areaName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (!areaByName.has(id)) areaByName.set(id, { id, name: entity.areaName });
  }

  return {
    areas: [...areaByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    entities: sorted,
    domains: domainsOf(sorted),
    source: 'prompt',
    builtAt: Date.now(),
    note: sorted.length
      ? `${sorted.length} entities${areaByName.size ? `, ${areaByName.size} areas` : ''} parsed from the request prompt`
      : 'nothing recognised in the request prompt',
  };
}

// Home Assistant's listing usually says where the device is: ", in Kitchen",
// "in the Living Room", "area: Office". Without areas an area-scoped request
// ("all the kitchen lights") can never resolve, so keep them.
const AREA_PATTERN = /(?:\bin\s+(?:the\s+)?|\barea\s*:?\s*)([A-Za-z][\w' -]{1,38})/i;

// Home Assistant may render aliases inline ("… , aliases: Big Light, Ceiling") or on the
// line underneath ("- also called Big Light"). Both shapes are read.
const ALIAS_INLINE = /\b(?:aliases?|also called)\s*:?\s*([^;)]+)/i;
const ALIAS_LINE = /^(?:[-*•]\s*)?(?:aliases?|also called)\s*:?\s*(.+)$/i;

/** `"Big Light, Ceiling"` -> `["Big Light", "Ceiling"]`, trimmed and bounded. */
function splitAliases(raw: string): string[] {
  return raw
    .split(/[,;|]/)
    .map((part) => part.replace(/[*_`()]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 1 && part.length <= 60);
}

// Section words that are structure, not places.
const NOT_AN_AREA =
  /^(devices?|entities|areas?|floors?|services?|intents?|tools?|functions?|instructions|examples?|style|response|persona|context|home|summary|notes?|available .*)$/i;

/**
 * The area a section heading introduces, or `undefined` when the line is not a heading.
 *
 * Only `#`/`##` markdown headings and explicit `Area: X` lines count, and known
 * structural words are rejected, so a heading like `## Devices` never becomes a room.
 */
function headingArea(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 60) return undefined;
  if (/\b[a-z_]+\.[a-z0-9_]+\b/.test(trimmed)) return undefined;
  const markdown = /^#{1,4}\s+(.+)$/.exec(trimmed);
  const explicit = /^area\s*:\s*(.+)$/i.exec(trimmed);
  const raw = (markdown?.[1] ?? explicit?.[1] ?? '').trim();
  if (!raw) return undefined;
  const name = raw
    .replace(/[*_`]+/g, '')
    .replace(/\(.*$/, '')
    .replace(/[:.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 40) return undefined;
  if (NOT_AN_AREA.test(name)) return undefined;
  if (/\b(devices?|entities|areas|tools?|functions?)\b/i.test(name)) return undefined;
  return name;
}

/** The area named on one prompt line, if any. */
function matchArea(line: string): string | undefined {
  const match = AREA_PATTERN.exec(line);
  if (!match?.[1]) return undefined;
  const name = match[1]
    .replace(/\s*\(.*$/, '')
    .replace(/[,;:.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "in Kitchen" on a line about a light is an area; a trailing verb phrase is not.
  if (name.length < 2 || name.length > 40) return undefined;
  return name;
}

/** Cached catalog, rebuilt when stale. Never throws: falls back to the prompt. */
export async function getCatalog(
  config: Config,
  prompt?: string,
  options: { maxAgeMs?: number } = {},
): Promise<Catalog> {
  const wantHa = Boolean(config.catalog.haUrl && config.catalog.haToken);
  const ttl = Math.min(config.catalog.cacheMs, options.maxAgeMs ?? config.catalog.cacheMs);
  const fresh = cache && Date.now() - cache.at < ttl;

  if (wantHa && fresh) return cache!.catalog;
  if (wantHa && inFlight) return inFlight;

  if (wantHa) {
    inFlight = catalogFromHomeAssistant(config)
      .then((catalog) => {
        const narrowed = narrowFromPrompt(catalog, prompt, config);
        cache = { catalog: narrowed, at: Date.now() };
        return narrowed;
      })
      .catch((error: unknown) => {
        const fallback = prompt ? catalogFromPrompt(prompt) : emptyCatalog();
        if (prompt) rememberPromptExposure(fallback.entities.map((entity) => entity.id));
        return {
          ...fallback,
          note: `${fallback.note ?? ''} (Home Assistant unreachable: ${
            error instanceof Error ? error.message : String(error)
          })`.trim(),
        };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  if (prompt) {
    const parsed = catalogFromPrompt(prompt);
    if (parsed.entities.length > 0) return parsed;
  }
  if (cache) return cache.catalog;
  return emptyCatalog();
}

export function emptyCatalog(): Catalog {
  return {
    areas: [],
    entities: [],
    domains: [],
    source: 'empty',
    builtAt: Date.now(),
    note: 'no catalog: configure a Home Assistant URL and token, or turn on prompt parsing',
  };
}

/**
 * A fingerprint of the house that survives a rebuild.
 *
 * Entity ids and room names only: a rebuild every 30 s must not invalidate a cached decision,
 * but adding a light must.
 */
export function homeSignature(catalog: Catalog): string {
  return sha1(
    [
      catalog.areas.map((area) => area.id).sort().join(','),
      catalog.entities.map((entity) => entity.id).sort().join(','),
    ].join('|'),
  );
}

export function cachedCatalog(): Catalog | null {
  return cache?.catalog ?? null;
}

export function clearCatalogCache(): void {
  cache = null;
}

/** Remember a catalog that was built outside getCatalog (the Refresh button). */
export function rememberCatalog(catalog: Catalog): void {
  cache = { catalog, at: Date.now() };
}


// --- lexical fallbacks ------------------------------------------------------
//
// The decision model is the primary reader, but a sentence can name a room or a
// device outright. When the model is not confident, an exact, unique match in the
// words the user actually said is better evidence than a low probability — and it is
// the difference between "turn on the kitchen lights" working and being forwarded.

/** The single catalog area whose name or alias appears in the utterance, if exactly one does. */
export function uniqueAreaMention(catalog: Catalog, utterance: string): CatalogArea | undefined {
  const text = ` ${normalise(utterance)} `;
  const hits = catalog.areas
    .flatMap((area) => [area.name, ...(area.aliases ?? [])].map((name) => ({ area, name: normalise(name) })))
    .filter(({ name }) => name.length > 1)
    .filter(({ name }) => text.includes(` ${name} `) || text.includes(` ${name}s `))
    // Longest name wins: "living room" beats "room", "kitchen" does not beat "kitchenette".
    .sort((a, b) => b.name.length - a.name.length);
  if (!hits.length) return undefined;
  const best = hits[0]!;
  if (hits[1] && hits[1].name.length === best.name.length) return undefined;
  return best.area;
}

/** Domains the fast path can actually act on, for spotting a second target. */
const ACTIONABLE_DOMAINS = new Set([
  'light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'scene', 'script',
  'button', 'input_boolean', 'humidifier', 'water_heater', 'vacuum', 'todo', 'lock',
]);

export interface MentionedTarget {
  kind: 'area' | 'entity';
  id: string;
  name: string;
}

/**
 * Every distinct thing the sentence names outright, with nesting collapsed.
 *
 * Two named rooms, or a room plus a device somewhere else, means the speaker asked
 * for more than one thing ("the kitchen and the living room lights"). The fast path
 * acts on one target per turn, and acting on half of a request is worse than handing
 * the whole sentence to the model, so the router needs to be able to see this.
 */
/** The plural, group-shaped words that make "<room> lights" mean the room, not a device. */
const GROUP_WORDS = new Set([
  'lights', 'lamps', 'fans', 'blinds', 'covers', 'curtains', 'switches', 'plugs',
  'sockets', 'speakers', 'lighting', 'group', 'all',
]);

/**
 * Is this device the room's own group — "Kitchen Lights" rather than "Kitchen Ceiling"?
 *
 * People say "the kitchen lights" meaning the room, and Home Assistant often also exposes
 * a light group by that name. Counting both would turn one request into two.
 */
function isRoomGroup(entity: CatalogEntity, area: CatalogArea): boolean {
  const areaName = normalise(area.name);
  if (!areaName) return false;
  return [entity.name, ...(entity.aliases ?? [])].some((name) => {
    const value = normalise(name);
    if (!value.startsWith(areaName)) return false;
    const rest = value.slice(areaName.length).trim().split(/\s+/).filter(Boolean);
    return rest.length > 0 && rest.every((word) => GROUP_WORDS.has(word));
  });
}

export function mentionedTargets(catalog: Catalog, utterance: string): MentionedTarget[] {
  const text = ` ${normalise(utterance)} `;
  const areas = catalog.areas.filter((area) =>
    [area.name, ...(area.aliases ?? [])].some((name) => {
      const value = normalise(name);
      return value.length > 1 && (text.includes(` ${value} `) || text.includes(` ${value}s `));
    }),
  );
  // Every device whose name appears, before rooms absorb the ones standing inside them.
  const named = catalog.entities
    .filter((entity) => ACTIONABLE_DOMAINS.has(entity.domain))
    .filter((entity) =>
      [entity.name, ...(entity.aliases ?? [])].some((name) => {
        const value = normalise(name);
        return value.length > 2 && text.includes(` ${value} `);
      }),
    );
  // A room whose name survives only inside the name of a device that was matched is
  // saying which device is meant, not naming a second target: "the kitchen ceiling".
  const withoutDevices = named.reduce((carry, entity) => {
    let out = carry;
    for (const name of [entity.name, ...(entity.aliases ?? [])]) {
      const value = normalise(name);
      if (value.length > 2) out = out.split(` ${value} `).join(' ');
    }
    return out;
  }, text);
  const namedOnlyInsideADevice = (area: CatalogArea): boolean =>
    [area.name, ...(area.aliases ?? [])].some((name) => normalise(name).length > 1) &&
    [area.name, ...(area.aliases ?? [])].every((name) => {
      const value = normalise(name);
      return value.length <= 1 || !withoutDevices.includes(` ${value} `);
    });

  const roomGroups = new Set(
    named
      .filter((entity) => {
        const area = entity.areaId ? areas.find((entry) => entry.id === entity.areaId) : undefined;
        return area ? isRoomGroup(entity, area) : false;
      })
      .map((entity) => entity.id),
  );
  const keptAreas = areas.filter(
    (area) =>
      named.some((entity) => entity.areaId === area.id && roomGroups.has(entity.id)) ||
      !namedOnlyInsideADevice(area),
  );
  const keptAreaIds = new Set(keptAreas.map((area) => area.id));
  // A device inside a room that was named is the same target, not a second one.
  const entities = named
    .filter((entity) => !roomGroups.has(entity.id))
    .filter((entity) => !entity.areaId || !keptAreaIds.has(entity.areaId));

  const seen = new Set<string>();
  const out: MentionedTarget[] = [];
  for (const area of keptAreas) {
    if (seen.has(area.id)) continue;
    seen.add(area.id);
    out.push({ kind: 'area', id: area.id, name: area.name });
  }
  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    out.push({ kind: 'entity', id: entity.id, name: entity.name });
  }
  return out;
}

/**
 * The single catalog entity named outright in the utterance, if exactly one is.
 *
 * Aliases count: "the big light" is how a room is actually described, and Home
 * Assistant itself matches aliases, so the proxy must read them too.
 */
export function uniqueEntityMention(catalog: Catalog, utterance: string): CatalogEntity | undefined {
  const text = ` ${normalise(utterance)} `;
  const hits = catalog.entities
    .flatMap((entity) => [entity.name, ...(entity.aliases ?? [])].map((name) => ({ entity, name: normalise(name) })))
    .filter(({ name }) => name.length > 2 && text.includes(` ${name} `))
    .sort((a, b) => b.name.length - a.name.length);
  if (!hits.length) return undefined;
  const best = hits[0]!;
  const rival = hits.find((hit) => hit.name !== best.name && hit.name.length === best.name.length);
  if (rival) return undefined;
  // Two different devices that match the winning words are genuinely ambiguous.
  const same = new Set(hits.filter((hit) => hit.name === best.name).map((hit) => hit.entity.id));
  return same.size === 1 ? best.entity : undefined;
}

/**
 * Keep the catalog warm in the background.
 *
 * A request that finds a stale catalog pays the Home Assistant round trip (40-100 ms) before it
 * can even start deciding. Refreshing on a timer means a spoken command never pays it.
 */
let warmer: NodeJS.Timeout | null = null;

export function startCatalogWarmer(readConfig: () => Config): void {
  stopCatalogWarmer();
  const tick = async (): Promise<void> => {
    const config = readConfig();
    if (!config.catalog.haUrl || !config.catalog.haToken) return;
    try {
      await getCatalog(config);
    } catch {
      // A broken catalog must never crash the timer; the next tick tries again.
    }
  };
  void tick();
  warmer = setInterval(() => void tick(), Math.max(15000, readConfig().catalog.cacheMs / 2));
  warmer.unref();
}

export function stopCatalogWarmer(): void {
  if (warmer) clearInterval(warmer);
  warmer = null;
}
