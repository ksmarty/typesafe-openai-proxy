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

  const areaList = (areas ?? []) as RegistryArea[];
  const deviceList = (devices ?? []) as RegistryDevice[];
  const floorList = (floors ?? []) as RegistryFloor[];
  const entityList = (entities ?? []) as RegistryEntity[];
  const stateList = (states ?? []) as StateRow[];

  const floorName = new Map<string, string>();
  for (const floor of floorList) {
    if (floor.floor_id && floor.name) floorName.set(floor.floor_id, floor.name);
  }
  const areaById = new Map<string, CatalogArea>();
  for (const area of areaList) {
    if (!area.area_id || !area.name) continue;
    areaById.set(area.area_id, {
      id: area.area_id,
      name: area.name,
      ...(area.floor_id && floorName.has(area.floor_id) ? { floor: floorName.get(area.floor_id)! } : {}),
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
    out.push({
      id,
      name: friendly,
      domain,
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

  for (const line of prompt.split(/\r?\n/)) {
    idPattern.lastIndex = 0;
    const match = idPattern.exec(line);
    if (!match?.[1] || !match[2]) continue;
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
      .replace(/\b(area|domain|state|entities|names?)\b:?/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    entities.push({
      id,
      name: name ? titleCase(name) : (id.split('.')[1] ?? id).replace(/_/g, ' '),
      domain,
      state: (stateMatch?.[1] ?? 'unknown').trim().toLowerCase(),
    });
  }

  const sorted = sortEntities(entities);
  return {
    areas: [],
    entities: sorted,
    domains: domainsOf(sorted),
    source: 'prompt',
    builtAt: Date.now(),
    note: sorted.length
      ? `${sorted.length} entities parsed from the request prompt`
      : 'nothing recognised in the request prompt',
  };
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

