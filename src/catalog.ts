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
import { normalise, titleCase } from './util.js';

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

/** One JSON message over Home Assistant's WebSocket API. */
function wsQuery<T>(url: string, token: string, messages: Record<string, unknown>[], timeoutMs = 8000): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    const results: T[] = [];
    let settled = false;
    let index = 0;

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

    const timer = setTimeout(() => finish(new Error('Home Assistant WebSocket timed out')), timeoutMs);

    const sendNext = (): void => {
      const message = messages[index];
      if (!message) {
        finish();
        return;
      }
      ws.send(JSON.stringify({ id: index + 1, ...message }));
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      let payload: { id?: number; type?: string; success?: boolean; result?: unknown; error?: { message?: string } };
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
        sendNext();
        return;
      }
      if (payload.type !== 'result') return;
      if (payload.success === false) {
        finish(new Error(payload.error?.message ?? 'Home Assistant refused the request'));
        return;
      }
      results.push(payload.result as T);
      index += 1;
      sendNext();
    });

    ws.addEventListener('error', () => finish(new Error('Home Assistant WebSocket error')));
    ws.addEventListener('close', () => finish());
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

/** Structured catalog straight from Home Assistant. */
export async function catalogFromHomeAssistant(config: Config): Promise<Catalog> {
  const base = config.catalog.haUrl.replace(/\/+$/, '');
  if (!base || !config.catalog.haToken) throw new Error('Home Assistant URL and token are not configured');
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/websocket`;

  const [areas, devices, floors, entities, states] = await wsQuery<
    RegistryArea[] | RegistryDevice[] | RegistryFloor[] | RegistryEntity[] | StateRow[]
  >(wsUrl, config.catalog.haToken, [
    { type: 'config/area_registry/list' },
    { type: 'config/device_registry/list' },
    { type: 'config/floor_registry/list' },
    { type: 'config/entity_registry/list' },
    { type: 'get_states' },
  ], 12000);

  return catalogFromRegistries({
    areas: (areas ?? []) as RegistryArea[],
    devices: (devices ?? []) as RegistryDevice[],
    floors: (floors ?? []) as RegistryFloor[],
    entities: (entities ?? []) as RegistryEntity[],
    states: (states ?? []) as StateRow[],
  });
}

/** Registry rows in, catalog out. Separate from the socket so it can be tested. */
export function catalogFromRegistries(input: {
  areas: RegistryArea[];
  devices: RegistryDevice[];
  floors: RegistryFloor[];
  entities: RegistryEntity[];
  states: StateRow[];
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

  const out: CatalogEntity[] = [];
  for (const entity of entityList) {
    const id = entity.entity_id;
    if (!id) continue;
    // Skip what a conversation agent would not be exposed anyway.
    if (entity.disabled_by || entity.hidden_by || entity.entity_category) continue;
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
    note: `${entitiesSorted.length} entities, ${areaById.size} areas from Home Assistant`,
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
export async function getCatalog(config: Config, prompt?: string): Promise<Catalog> {
  const wantHa = Boolean(config.catalog.haUrl && config.catalog.haToken);
  const fresh = cache && Date.now() - cache.at < config.catalog.cacheMs;

  if (wantHa && fresh) return cache!.catalog;
  if (wantHa && inFlight) return inFlight;

  if (wantHa) {
    inFlight = catalogFromHomeAssistant(config)
      .then((catalog) => {
        cache = { catalog, at: Date.now() };
        return catalog;
      })
      .catch((error: unknown) => {
        const fallback = prompt ? catalogFromPrompt(prompt) : emptyCatalog();
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

export function cachedCatalog(): Catalog | null {
  return cache?.catalog ?? null;
}

export function clearCatalogCache(): void {
  cache = null;
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
