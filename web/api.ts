import type { SettingsGroup } from '../src/schema.js';
import type { Gate, TraceEntry } from '../src/types.js';

export interface Status {
  /** The build answering, so the UI can name it. */
  version?: string;
  ok: boolean;
  uptimeSeconds: number;
  configPath: string;
  decision: {
    backend: string;
    model: string;
    baseUrl: string;
    autoStart: boolean;
    fastPath: { ready: boolean; reason: string };
    breaker: { open: boolean; failures: number; until: number };
    averageMs: number;
  };
  catalog: { source: string; entities: number; areas: number; builtAt: number; note?: string };
  routerModel: string;
  stats: Record<string, number>;
  pending: number;
  traceDepth: number;
}

export interface SchemaResponse {
  groups: SettingsGroup[];
  defaults: Record<string, unknown>;
  envOverrides: string[];
}

export interface AdjustedValue {
  key: string;
  from?: unknown;
  to?: unknown;
}

export interface ConfigResponse {
  ok?: boolean;
  config: Record<string, unknown>;
  path?: string;
  adjusted?: AdjustedValue[];
  restartRequired?: boolean;
}

export interface ProbeResponse {
  route: {
    plan: { kind: string; [key: string]: unknown };
    gates: Gate[];
    reason: string;
    category?: string;
    action?: string;
    target?: string;
    risky?: boolean;
  };
  trace: TraceEntry;
  probeBackend: string;
  configuredBackend: string;
  fastPath: { ready: boolean; reason: string };
}

export interface TraceResponse {
  items: TraceEntry[];
  total: number;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  note?: string;
  status?: number;
  ms?: number;
  models?: string[];
  typed?: string[];
  entities?: number;
  areas?: number;
  domains?: number;
  sample?: string[];
}

/**
 * The dashboard is usually served from the origin root, but an iframe preview or a reverse proxy
 * can mount it under a path prefix. Resolve every call against the page's own directory first and
 * fall back to the origin root when that prefix is not proxied.
 */
function mountPath(): string {
  const path = window.location.pathname;
  if (path.endsWith('/')) return path;
  return path.includes('.') ? path.slice(0, path.lastIndexOf('/') + 1) : `${path}/`;
}

function endpointAt(base: string, path: string): string {
  const trimmed = path.replace(/^\/+/, '');
  return base === '/' ? `/${trimmed}` : `${base}${trimmed}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const options: RequestInit = {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  };
  const mounted = endpointAt(mountPath(), path);
  let response = await fetch(mounted, options);
  if (response.status === 404 && mounted !== path) response = await fetch(path, options);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const getStatus = () => call<Status>('/api/status');
export const getSchema = () => call<SchemaResponse>('/api/schema');
export const getConfig = () => call<ConfigResponse>('/api/config');
export const getTrace = (limit = 50) => call<TraceResponse>(`/api/trace?limit=${limit}`);
export const clearTrace = () => call<{ ok: boolean }>('/api/trace', { method: 'DELETE' });
export const resetBreaker = () => call<{ ok: boolean }>('/api/breaker/reset', { method: 'POST' });
export interface CatalogSummary {
  source: string;
  entities: number;
  areas: number;
  builtAt: number;
  note?: string;
}

export const refreshCatalog = () =>
  call<{ ok: boolean; catalog?: CatalogSummary }>('/api/catalog/refresh', { method: 'POST' });
export const probe = (text: string) =>
  call<ProbeResponse>('/api/probe', { method: 'POST', body: JSON.stringify({ text }) });
export const saveConfig = (config: Record<string, unknown>) =>
  call<ConfigResponse>('/api/config', { method: 'POST', body: JSON.stringify(config) });
/** Reset one settings page, or everything when no group is named. */
export const resetConfig = (group?: string) =>
  call<ConfigResponse & { group?: string; fields?: number }>('/api/config/reset', {
    method: 'POST',
    body: JSON.stringify(group ? { group } : {}),
  });

export const testHa = (url?: string, token?: string) =>
  call<TestResult>('/api/test/ha', { method: 'POST', body: JSON.stringify({ url, token }) });
export const testDecision = (url?: string, key?: string, model?: string) =>
  call<TestResult>('/api/test/decision', { method: 'POST', body: JSON.stringify({ url, key, model }) });
export const testUpstream = (url?: string, key?: string) =>
  call<TestResult>('/api/test/upstream', { method: 'POST', body: JSON.stringify({ url, key }) });

/**
 * Download the server's debug bundle (config with secrets masked, traces, logs).
 *
 * The file is produced by GET /api/debug/bundle, so the request path has to work
 * under a preview prefix just like every other call.
 */
export async function downloadDebugBundle(): Promise<string> {
  const response = await fetch(endpointAt(mountPath(), '/api/debug/bundle'));
  if (!response.ok) throw new Error(`the server answered ${response.status} for the debug bundle`);
  const blob = await response.blob();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `typesafe-proxy-debug-${stamp}.json`;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
