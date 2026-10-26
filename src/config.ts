import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { allFields, clampSettings, getPath, isMaskedValue, maskSecrets, pruneInvalid, setPath } from './schema.js';

export type DecisionBackend = 'none' | 'systemone' | 'heuristic';

export interface DecisionThresholds {
  minMargin: number;
  actTerse: number;
  actExplicit: number;
  clarifyFloor: number;
  categoryQuery: number;
  categoryInformation: number;
  categoryCancel: number;
  categoryUnclear: number;
  queryKind: number;
  domain: number;
  entity: number;
  area: number;
  scope: number;
  scopeWholeHouse: number;
  actionProbability: number;
  noulRisky: number;
  noulCompound: number;
  noulHereRelative: number;
  riskyAction: number;
  riskyTarget: number;
}

export interface Config {
  server: {
    host: string;
    port: number;
    /** Optional bearer token the proxy requires. Empty disables the check. */
    apiKey: string;
  };  decision: {
    /**
     * Which decision model to use.
     *
     * `none` is the default and the honest one: with no backend configured the proxy
     * decides nothing and forwards every request, so installing it changes no behaviour
     * until you point it at a server. `systemone` talks to a typed decision model,
     * `heuristic` is the built-in offline matcher.
     */
    backend: DecisionBackend;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    /**
     * When false (the default) the fast path only runs for a request whose model is
     * `ROUTER_MODEL`. The proxy is installed and observable, but decides nothing until
     * it is asked to — so pointing an existing client at it cannot change behaviour.
     */
    autoStart: boolean;
    /** How many options one question may offer (Ollama caps this at 26). */
    maxOptions: number;
    /** Ask before unlocking, opening a garage or disarming, however sure we are. */
    alwaysConfirmRisky: boolean;
    inlineEntityDescriptions: boolean;
    /** Keep the last N turns of the conversation in the decision state. */
    historyTurns: number;
    /** Send the whole catalog in the state even when the entity question is narrowed. */
    maxEntities: number;
  };
  routing: {
    enabled: boolean;
    /** Send requests here even when Home Assistant's matcher would have handled them. */
    thresholds: DecisionThresholds;
    /** Percentage of requests sampled into the in-memory trace ring. */
    traceLimit: number;
  };
  speech: {
    /**
     * What speaks the result of a tool call:
     * `upstream` - forward the follow-up turn to the inference server (any language),
     * `template` - compose a short sentence locally (fast, needs a template),
     * `empty`    - say nothing.
     */
    afterTool: 'upstream' | 'template' | 'empty';
    /** Seconds a confirmation question stays armed. */
    confirmSeconds: number;
    /** Per-language templates, `{entity}` and `{action}` are substituted. */
    templates: Record<string, { done: string; clarify: string; confirm: string }>;
  };
  catalog: {
    /** `http://homeassistant.local:8123` - enables the structured catalog + live state. */
    haUrl: string;
    haToken: string;
    cacheMs: number;
    /** Area used for "turn on the lights" when no area is named. */
    defaultArea: string;
    /**
     * Keep only the entities Home Assistant exposes to Assist, instead of every entity
     * in the registry. Same list the voice assistant works from, so the decision model
     * sees what can actually be acted on.
     */
    exposedOnly: boolean;
  };
  upstream: {
    /** The inference server hass_local_openai_llm used to point at. Required. */
    baseUrl: string;
    apiKey: string;
    /**
     * Reuse `decision.apiKey` for forwarded requests when no upstream key is set.
     *
     * Both servers are often the same provider — OpenRouter serving the decision
     * model and the fallback model — so one key is enough, and it never has to be
     * copied out of a field the dashboard only shows twelve characters of.
     */
    apiKeyFromDecision: boolean;
    /**
     * Model name to send upstream when the request names the proxy's own model
     * (`typesafe-router`) or names nothing. Without it, a forwarded request asks
     * the inference server for a model called "typesafe-router", which does not
     * exist and comes back as a 400.
     */
    model: string;
    timeoutMs: number;
  };
}

export const DEFAULT_TEMPLATES = {
  en: {
    done: '{action} {entity}.',
    clarify: 'Which one did you mean: {options}?',
    confirm: 'Do you want me to {action} the {entity}?',
  },
};

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  minMargin: 0.15,
  actTerse: 0.75,
  actExplicit: 0.5,
  clarifyFloor: 0.3,
  // Ported from the reference implementation's const.py, fitted to jev-1.13.0.
  categoryQuery: 0.45,
  categoryInformation: 0.55,
  categoryCancel: 0.6,
  categoryUnclear: 0.55,
  queryKind: 0.5,
  domain: 0.5,
  entity: 0.6,
  area: 0.55,
  scope: 0.55,
  scopeWholeHouse: 0.6,
  actionProbability: 0.55,
  noulRisky: 0.5,
  noulCompound: 0.7,
  noulHereRelative: 0.6,
  riskyAction: 0.85,
  riskyTarget: 0.75,
};

export function defaultConfig(): Config {
  return {
    server: { host: '0.0.0.0', port: Number(process.env.PORT) || 8080, apiKey: '' },
    decision: {
      backend: 'none',
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 8000,
      autoStart: false,
      maxOptions: 255,
      alwaysConfirmRisky: true,
      inlineEntityDescriptions: false,
      historyTurns: 2,
      maxEntities: 400,
    },
    routing: { enabled: true, thresholds: { ...DEFAULT_THRESHOLDS }, traceLimit: 50 },
    speech: { afterTool: 'template', confirmSeconds: 90, templates: structuredClone(DEFAULT_TEMPLATES) },
    catalog: { haUrl: '', haToken: '', cacheMs: 30000, defaultArea: '', exposedOnly: true },
    upstream: { baseUrl: '', apiKey: '', apiKeyFromDecision: false, model: '', timeoutMs: 120000 },
  };
}

const CONFIG_PATH = resolve(process.env.DATA_DIR || 'data', 'config.json');

/** Deep-merge saved values onto the defaults, so a partial file is fine. */
function merge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override as T;
  if (typeof override !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] = current !== undefined && typeof current === 'object' && !Array.isArray(current)
      ? merge(current, value)
      : value;
  }
  return out as T;
}

let cached: Config | null = null;

export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  const config = defaultConfig();
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown;
      cached = merge(config, saved);
    } else {
      cached = config;
    }
  } catch {
    cached = config;
  }
  applyEnv(cached);
  return cached;
}

/** Env wins over the file, so a container can be configured without a volume. */
function applyEnv(config: Config): void {
  const env = process.env;
  if (env.PORT) config.server.port = Number(env.PORT);
  if (env.HOST) config.server.host = env.HOST;
  if (env.PROXY_API_KEY) config.server.apiKey = env.PROXY_API_KEY;
  if (env.UPSTREAM_BASE_URL) config.upstream.baseUrl = env.UPSTREAM_BASE_URL;
  if (env.UPSTREAM_API_KEY) config.upstream.apiKey = env.UPSTREAM_API_KEY;
  if (env.UPSTREAM_API_KEY_FROM_DECISION !== undefined && env.UPSTREAM_API_KEY_FROM_DECISION !== '') {
    config.upstream.apiKeyFromDecision = /^(1|true|yes|on)$/i.test(env.UPSTREAM_API_KEY_FROM_DECISION);
  }
  if (env.UPSTREAM_MODEL) config.upstream.model = env.UPSTREAM_MODEL;
  if (env.SYSTEMONE_BASE_URL) config.decision.baseUrl = env.SYSTEMONE_BASE_URL;
  if (env.SYSTEMONE_API_KEY) config.decision.apiKey = env.SYSTEMONE_API_KEY;
  if (env.SYSTEMONE_MODEL) config.decision.model = env.SYSTEMONE_MODEL;
  if (env.DECISION_BACKEND === 'systemone' || env.DECISION_BACKEND === 'heuristic' || env.DECISION_BACKEND === 'none') {
    config.decision.backend = env.DECISION_BACKEND;
  }
  if (env.AUTO_START !== undefined && env.AUTO_START !== '') {
    config.decision.autoStart = /^(1|true|yes|on)$/i.test(env.AUTO_START);
  }
  if (env.HA_URL) config.catalog.haUrl = env.HA_URL;
  if (env.HA_TOKEN) config.catalog.haToken = env.HA_TOKEN;
}

/** The dashboard shows secrets masked; a save that echoes the mask back means "leave it". */
export const SECRET_MASK = '••••••';

/**
 * A request that names this model is asking for the fast path explicitly, which is how
 * the proxy can be installed and tried without changing anything for existing clients.
 */
export const ROUTER_MODEL = 'typesafe-router';

/**
 * The bearer token a forwarded request carries.
 *
 * An explicit upstream key always wins, so setting one is never overridden. When it is
 * empty and `apiKeyFromDecision` is on, the decision model's key is reused — one
 * OpenRouter key for both endpoints, without copying it out of a masked field.
 */
export function upstreamApiKey(config: Config): string {
  const own = (config.upstream.apiKey ?? '').trim();
  if (own) return own;
  return config.upstream.apiKeyFromDecision ? (config.decision.apiKey ?? '').trim() : '';
}

function isSecretPath(key: string): boolean {
  return key.endsWith('.apiKey') || key.endsWith('.haToken');
}

/**
 * Apply a partial config, keeping values in range.
 *
 * `clampSettings` is the single source of truth for types and bounds, so every setting the
 * dashboard can render is also validated here. Returns the saved config plus the keys the
 * server had to adjust, so the caller can say so instead of silently editing them.
 */
export function saveConfig(patch: unknown): { config: Config; adjusted: { key: string; value: unknown }[] } {
  const current = structuredClone(loadConfig()) as unknown as Record<string, unknown>;
  const incoming = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  // A masked secret in the payload is the form echoing back what it was given, not a change.
  for (const field of allFields()) {
    if (field.type === 'password' && isSecretPath(field.key) && isMaskedValue(getPath(incoming, field.key), SECRET_MASK)) {
      setPath(incoming, field.key, getPath(current, field.key) ?? '');
    }
  }
  // A value the schema cannot read is ignored rather than stored, so a typo in a select or a
  // non-numeric number never reaches the pipeline; the previous value stays.
  const ignored = pruneInvalid(incoming);
  const next = merge(current, incoming) as unknown as Record<string, unknown>;
  const adjusted = [
    ...ignored.map(({ key, value }) => ({ key, value: getPath(next, key), ignored: value })),
    ...clampSettings(next),
  ];
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cached = next as unknown as Config;
  applyEnv(cached);
  return { config: cached, adjusted };
}

function readPath(root: Record<string, unknown>, parts: string[]): unknown {
  let cursor: unknown = root;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function writePath(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

/**
 * Put only these settings back to their defaults.
 *
 * The dashboard resets the page you are looking at, not the whole file: wiping a Home
 * Assistant token or a decision URL because someone wanted the look of one tab back is
 * a data loss, not a reset.
 */
export function resetConfigPaths(paths: string[]): Config {
  const defaults = defaultConfig() as unknown as Record<string, unknown>;
  const next = structuredClone(loadConfig(true)) as unknown as Record<string, unknown>;
  let touched = 0;
  for (const path of paths) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) continue;
    const value = readPath(defaults, parts);
    if (value === undefined) continue;
    writePath(next, parts, structuredClone(value));
    touched += 1;
  }
  if (!touched) return loadConfig(true);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cached = next as unknown as Config;
  applyEnv(cached);
  return cached;
}

/** Put every stored value back to the built-in default. */
export function resetConfig(): Config {
  const config = defaultConfig();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  cached = config;
  applyEnv(cached);
  return cached;
}

export function configPath(): string {
  return CONFIG_PATH;
}

/** Config with the key fields hidden, for the dashboard. */
export function publicConfig(): Config {
  const config = structuredClone(loadConfig()) as unknown as Record<string, unknown>;
  maskSecrets(config, SECRET_MASK);
  return config as unknown as Config;
}
