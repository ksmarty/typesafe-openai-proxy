/**
 * One process: the OpenAI-compatible endpoint hass_local_openai_llm talks to, and the
 * dashboard you use to watch it think.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  catalogFromHomeAssistant,
  cachedCatalog,
  clearCatalogCache,
  emptyCatalog,
  getCatalog,
  promptExposure,
  probeExposure,
} from './catalog.js';
import {
  configPath,
  defaultConfig,
  loadConfig,
  publicConfig,
  resetConfig,
  resetConfigPaths,
  ROUTER_MODEL,
  saveConfig,
  upstreamApiKey,
} from './config.js';
import { fastPathStatus, handleChatCompletions, runPipeline } from './pipeline.js';
import { assistTools } from './toolcall.js';
import { installLogCapture, note, recentLogs } from './log.js';
import { jsonResponse } from './respond.js';
import { secretOrStored, settingsGroups } from './schema.js';
import { averageDecisionMs, pendingConfirmations, rememberRequest, rememberTrace, requestLog, routableShare, startedAt, stats, trace } from './state.js';
import { breakerState, listModels, resetBreaker } from './systemone.js';
import { ensureUiBundle } from './ui.js';
import { fetchWithTimeout, uid } from './util.js';
import type { Config } from './config.js';
import type { Catalog, OpenAIChatRequest, TraceEntry } from './types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(here, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function body(request: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** API bodies are small; malformed JSON is a client error, not a 500. */
async function jsonBody<T>(request: IncomingMessage): Promise<T> {
  const raw = await body(request, 1024 * 1024);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function authorised(request: IncomingMessage, key: string): boolean {
  if (!key) return true;
  const header = request.headers.authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token === key;
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(publicDir, relative));
  if (target !== publicDir && !target.startsWith(publicDir + sep)) return false;
  try {
    const content = await readFile(target);
    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // The dashboard is sometimes framed from another origin (an IDE preview, Home Assistant
      // iframe panel). Static assets are not secret, so allow the module script to load there.
      'access-control-allow-origin': '*',
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Env values are applied on top of the file on every load, so a saved setting can look like
 * it did nothing. Name them (never their values) and let the dashboard say so.
 */
function activeEnvOverrides(): string[] {
  const keys = [
    'PORT',
    'HOST',
    'PROXY_API_KEY',
    'UPSTREAM_BASE_URL',
    'UPSTREAM_API_KEY',
    'SYSTEMONE_BASE_URL',
    'SYSTEMONE_API_KEY',
    'SYSTEMONE_MODEL',
    'DECISION_BACKEND',
    'AUTO_START',
    'HA_URL',
    'HA_TOKEN',
  ];
  return keys.filter((key) => Boolean(process.env[key]));
}

/** The package version, from the manifest that sits next to dist/ or src/. */
let versionCache: string | null = null;

/** Read the manifest once and remember it, so status can name the build it is. */
export async function primeVersion(): Promise<string> {
  versionCache = await packageVersion();
  return versionCache;
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Environment variables the proxy honours: names always, values only where they are not secrets. */
function environment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PORT', 'HOST', 'DATA_DIR', 'DECISION_BACKEND', 'AUTO_START', 'SYSTEMONE_MODEL', 'UPSTREAM_MODEL', 'PROXY_HOST']) {
    if (process.env[key]) out[key] = process.env[key] as string;
  }
  for (const key of ['PROXY_API_KEY', 'UPSTREAM_API_KEY', 'SYSTEMONE_API_KEY', 'HA_TOKEN', 'TYPESAFE_PROXY_KEY']) {
    if (process.env[key]) out[key] = 'set (value withheld)';
  }
  for (const key of ['UPSTREAM_BASE_URL', 'SYSTEMONE_BASE_URL', 'HA_URL']) {
    if (process.env[key]) out[key] = process.env[key] as string;
  }
  return out;
}

function statusPayload(): Record<string, unknown> {
  const active = loadConfig();
  const catalog = cachedCatalog();
  return {
    ok: true,
    product: 'typesafe-routing-proxy',
    // Which build is answering. Without it, "the fix is not there" is unanswerable.
    version: versionCache ?? 'unknown',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    config: publicConfig(),
    configPath: configPath(),
    decision: {
      backend: active.decision.backend,
      model: active.decision.model,
      baseUrl: active.decision.baseUrl,
      autoStart: active.decision.autoStart,
      fastPath: fastPathStatus(active),
      breaker: breakerState(),
      averageMs: averageDecisionMs(),
    },
    catalog: {
      source: catalog?.source ?? 'none',
      entities: catalog?.entities.length ?? 0,
      areas: catalog?.areas.length ?? 0,
      builtAt: catalog?.builtAt ?? 0,
      note: catalog?.note,
      exposure: catalog?.exposure,
      promptExposure: promptExposure()?.size ?? 0,
    },
    routerModel: ROUTER_MODEL,
    stats: { ...stats, routableShare: Math.round(routableShare() * 1000) / 1000 },
    pending: pendingConfirmations.size,
    traceDepth: trace.length,
  };
}

/**
 * Record a request that never became a turn.
 *
 * A wrong API key used to leave the dashboard empty, which reads as "the proxy saw
 * nothing" when in fact it answered 401 on every attempt. Errors belong in the log the
 * dashboard shows, not only in the client's.
 */
function recordRefusal(httpStatus: number, reason: string): void {
  rememberTrace({
    id: uid('trace'),
    at: Date.now(),
    utterance: '',
    route: 'refused',
    reason,
    gates: [],
    httpStatus,
    totalMs: 0,
  });
  note(`refused ${httpStatus}: ${reason}`);
}

async function refreshCatalog(force: boolean): Promise<Catalog> {
  const active = loadConfig();
  if (force) clearCatalogCache();
  if (!active.catalog.haUrl || !active.catalog.haToken) return cachedCatalog() ?? emptyCatalog();
  if (force) return catalogFromHomeAssistant(active);
  return getCatalog(active);
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
  const path = url.pathname.replace(/^\/api/, '');

  if (path === '/status' && method === 'GET') {
    jsonResponse(response, 200, statusPayload());
    return true;
  }

  if (path === '/requests' && method === 'GET') {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? 20) || 20));
    jsonResponse(response, 200, { items: requestLog.slice(0, limit), total: requestLog.length });
    return true;
  }

  // Everything worth attaching to a bug report, in one file: the effective config
  // (secrets masked), what the server thinks its state is, the decisions it made,
  // and the recent output you would otherwise only see in `docker logs`.
  if (path === '/debug/bundle' && method === 'GET') {
    const active = loadConfig();
    const catalog = cachedCatalog();
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 100) || 100));
    const bundle = {
      generatedAt: new Date().toISOString(),
      meta: {
        product: 'typesafe-routing-proxy',
        version: await packageVersion(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      },
      environment: environment(),
      config: publicConfig(),
      configPath: configPath(),
      status: statusPayload(),
      catalog: catalog
        ? {
            source: catalog.source,
            note: catalog.note,
            builtAt: catalog.builtAt,
            areas: catalog.areas.map((area) => area.name),
            domains: catalog.domains,
            entities: catalog.entities.slice(0, 300).map((entity) => `${entity.id} (${entity.name})`),
            entityCount: catalog.entities.length,
            exposure: catalog.exposure,
          }
        : null,
      traces: trace.slice(0, limit),
      requests: requestLog.slice(0, 50),
      logs: recentLogs(),
      notes: [
        'Secrets are masked to their first 12 characters; they are not exported in full.',
        'Traces contain the utterances Assist sent, so review before sharing publicly.',
      ],
    };
    const name = `typesafe-proxy-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(bundle, null, 2));
    return true;
  }

  if (path === '/trace' && method === 'GET') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));
    const items = trace.slice(0, limit);
    jsonResponse(response, 200, { items, total: trace.length });
    return true;
  }

  if (path === '/trace' && method === 'DELETE') {
    trace.length = 0;
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (path === '/catalog' && method === 'GET') {
    const catalog = cachedCatalog();
    jsonResponse(response, 200, { catalog });
    return true;
  }

  if (path === '/catalog/exposure' && method === 'POST') {
    jsonResponse(response, 200, await probeExposure(loadConfig()));
    return true;
  }

  if (path === '/catalog/refresh' && method === 'POST') {
    const catalog = await refreshCatalog(true);
    jsonResponse(response, 200, {
      ok: true,
      catalog: {
        source: catalog.source,
        entities: catalog.entities.length,
        areas: catalog.areas.length,
        builtAt: catalog.builtAt,
        note: catalog.note,
        exposure: catalog.exposure,
      },
    });
    return true;
  }

  if (path === '/config' && method === 'GET') {
    jsonResponse(response, 200, { config: publicConfig(), path: configPath() });
    return true;
  }

  if (path === '/config' && method === 'POST') {
    const parsed = await jsonBody(request) as Record<string, unknown>;
    const before = loadConfig();
    const { config, adjusted } = saveConfig(parsed);
    const restartRequired = before.server.port !== config.server.port || before.server.host !== config.server.host;
    jsonResponse(response, 200, { ok: true, config: publicConfig(), adjusted, restartRequired });
    return true;
  }

  if (path === '/config/reset' && method === 'POST') {
    // `{ group }` resets one page of the dashboard. No group still resets everything,
    // because that is what an explicit "reset all" means.
    const parsed = await jsonBody<{ group?: string }>(request).catch(() => ({}) as { group?: string });
    const group = typeof parsed.group === 'string' && parsed.group ? parsed.group : undefined;
    const chosen = group ? settingsGroups().find((entry) => entry.id === group) : undefined;
    if (group && !chosen) {
      jsonResponse(response, 400, { error: `unknown settings group "${group}"` });
      return true;
    }
    const config = chosen ? resetConfigPaths(chosen.fields.map((field) => field.key)) : resetConfig();
    jsonResponse(response, 200, {
      ok: true,
      config: publicConfig(),
      ...(chosen ? { group: chosen.id, fields: chosen.fields.length } : {}),
    });
    return true;
  }

  // The dashboard renders itself from this, so a setting cannot exist on one side only.
  if (path === '/schema' && method === 'GET') {
    jsonResponse(response, 200, {
      groups: settingsGroups(),
      defaults: defaultConfig(),
      envOverrides: activeEnvOverrides(),
    });
    return true;
  }

  if (path === '/test/ha' && method === 'POST') {
    const parsed = await jsonBody(request) as { url?: string; token?: string };
    const active = loadConfig();
    const url = (parsed.url || active.catalog.haUrl).trim().replace(/\/+$/, '');
    const token = secretOrStored(parsed.token, active.catalog.haToken);
    if (!url || !token) {
      jsonResponse(response, 400, { ok: false, error: 'A URL and a long-lived token are both required.' });
      return true;
    }
    try {
      const catalog = await catalogFromHomeAssistant({
        ...active,
        catalog: { ...active.catalog, haUrl: url, haToken: token },
      });
      jsonResponse(response, 200, {
        ok: true,
        entities: catalog.entities.length,
        areas: catalog.areas.length,
        domains: catalog.domains.length,
        sample: catalog.entities.slice(0, 5).map((entity) => `${entity.name} (${entity.id})`),
        note: catalog.note,
        exposure: catalog.exposure,
      });
    } catch (error) {
      jsonResponse(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/test/decision' && method === 'POST') {
    const parsed = await jsonBody(request) as { url?: string; key?: string; model?: string };
    const active = loadConfig();
    const baseUrl = (parsed.url ?? active.decision.baseUrl).trim().replace(/\/+$/, '');
    if (!baseUrl) {
      jsonResponse(response, 200, {
        ok: false,
        error: 'No decision base URL set — the built-in heuristic is being used instead.',
      });
      return true;
    }
    try {
      const models = await listModels({
        ...active,
        decision: {
          ...active.decision,
          baseUrl,
          apiKey: secretOrStored(parsed.key, active.decision.apiKey),
        },
      });
      const typed = models.filter((model) => model.jev);
      jsonResponse(response, 200, {
        ok: true,
        models: models.map((model) => model.id),
        typed: typed.map((model) => model.id),
        note: typed.length
          ? `Typed decision model available: ${typed.map((model) => model.id).join(', ')}.`
          : 'Reachable, but no model advertises the "jev" capability — decisions will fail and requests will be forwarded.',
      });
    } catch (error) {
      jsonResponse(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/test/upstream' && method === 'POST') {
    const parsed = await jsonBody(request) as { url?: string; key?: string };
    const active = loadConfig();
    const base = (parsed.url || active.upstream.baseUrl).trim().replace(/\/+$/, '');
    const key = secretOrStored(parsed.key, upstreamApiKey(active));
    if (!base) {
      jsonResponse(response, 400, { ok: false, error: 'Set the fallback server URL first.' });
      return true;
    }
    try {
      const started = Date.now();
      const upstream = await fetchWithTimeout(
        `${base}/models`,
        { headers: key ? { authorization: `Bearer ${key}` } : {} },
        Math.min(active.upstream.timeoutMs, 15000),
      );
      const text = await upstream.text();
      let models: string[] = [];
      try {
        const parsedBody = JSON.parse(text) as { data?: { id?: string }[] };
        models = (parsedBody.data ?? []).map((entry) => String(entry.id ?? '')).filter(Boolean).slice(0, 25);
      } catch {
        // Not a model list; the status code still tells the reader it is reachable.
      }
      jsonResponse(response, 200, {
        ok: upstream.ok,
        status: upstream.status,
        ms: Date.now() - started,
        models,
        error: upstream.ok ? undefined : `HTTP ${upstream.status}: ${text.slice(0, 200)}`,
      });
    } catch (error) {
      jsonResponse(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/breaker/reset' && method === 'POST') {
    resetBreaker();
    jsonResponse(response, 200, { ok: true, breaker: breakerState() });
    return true;
  }

  if (path === '/probe' && method === 'POST') {
    const parsed = await jsonBody(request) as { text?: string };
    const text = (parsed.text ?? '').trim();
    if (!text) {
      jsonResponse(response, 400, { error: 'text is required' });
      return true;
    }
    // The probe always decides, whatever the live configuration says, so the dashboard
    // can be used to try the routing out before switching the fast path on.
    const active = loadConfig();
    const probeConfig: Config = {
      ...active,
      decision: { ...active.decision, backend: active.decision.backend === 'none' ? 'heuristic' : active.decision.backend },
    };
    // A dry run has no caller, so offer every intent we know: the point is to see
    // which Home Assistant call the decision would produce.
    const request0: OpenAIChatRequest = { model: ROUTER_MODEL, messages: [{ role: 'user', content: text }], tools: assistTools() };
    const result = await runPipeline(request0, text, '', probeConfig);
    jsonResponse(response, 200, {
      route: result.route,
      trace: result.entry,
      probeBackend: probeConfig.decision.backend,
      configuredBackend: active.decision.backend,
      fastPath: fastPathStatus(active),
    });
    return true;
  }

  if (path === '/models' && method === 'GET') {
    const active = loadConfig();
    const models = active.decision.baseUrl ? await listModels(active) : [];
    jsonResponse(response, 200, { models, backend: active.decision.backend });
    return true;
  }

  return false;
}

export function createApp() {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const method = request.method ?? 'GET';
      // Some supervisors mount the app under a path prefix; treat that as transparent.
      url.pathname = url.pathname.replace(/^\/preview\/[^/]+/, '') || '/';

      // One line per request, kept in memory for /api/debug/bundle: in a container
      // the only other view of this is `docker logs`, which is lost on restart.
      const started = Date.now();
      response.on('finish', () => {
        const spent = Date.now() - started;
        // Every request the machine API sees, kept for the dashboard: this is the
        // answer to "is anything reaching the container at all".
        if (url.pathname.startsWith('/v1/')) {
          rememberRequest({ at: started, method, path: url.pathname, status: response.statusCode, ms: spent });
        }
        if (url.pathname === '/debug/bundle') return;
        note(`${method} ${url.pathname}${url.search} -> ${response.statusCode} ${spent}ms`);
      });

      try {
        if (url.pathname === '/health') {
          const active = loadConfig();
          jsonResponse(response, 200, {
            ok: true,
            routing: active.routing.enabled,
            backend: active.decision.backend,
            deciding: fastPathStatus(active).ready,
            catalog: cachedCatalog()?.entities.length ?? 0,
          });
          return;
        }

        if (url.pathname.startsWith('/v1/')) {
          if (!authorised(request, loadConfig().server.apiKey)) {
            recordRefusal(401, 'the request carried the wrong bearer token — the API key in hass_local_openai_llm must match the one saved here');
            jsonResponse(response, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
            return;
          }

          if (url.pathname === '/v1/models' && method === 'GET') {
            const active = loadConfig();
            jsonResponse(response, 200, {
              object: 'list',
              data: [
                { id: 'typesafe-router', object: 'model', created: 0, owned_by: 'local' },
                ...(active.decision.model ? [{ id: active.decision.model, object: 'model', created: 0, owned_by: 'typesafe' }] : []),
              ],
            });
            return;
          }

          if (url.pathname === '/v1/chat/completions' && method === 'POST') {
            const raw = await body(request);
            let parsed: OpenAIChatRequest;
            try {
              parsed = JSON.parse(raw) as OpenAIChatRequest;
            } catch {
              recordRefusal(400, 'the request body was not valid JSON');
              jsonResponse(response, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
              return;
            }
            try {
              await handleChatCompletions(parsed, raw, response);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              recordRefusal(500, `the proxy threw while answering the turn: ${message}`);
              if (!response.headersSent) {
                jsonResponse(response, 500, { error: { message, type: 'invalid_request_error' } });
              }
            }
            return;
          }

          jsonResponse(response, 404, { error: { message: `unknown endpoint ${url.pathname}`, type: 'invalid_request_error' } });
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          const handled = await api(request, response, url, method);
          if (!handled) jsonResponse(response, 404, { error: `unknown endpoint ${url.pathname}` });
          return;
        }

        // Every browser asks for this whether or not the page declares an icon, and a 404
        // in the log on every page load reads like a fault. There is nothing to serve.
        if (url.pathname === '/favicon.ico') {
          response.writeHead(204, { 'cache-control': 'public, max-age=86400' });
          response.end();
          return;
        }

        if (await serveStatic(response, url.pathname)) return;
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof HttpError ? error.status : 500;
        if (!response.headersSent) jsonResponse(response, status, { error: message });
        else response.end();
      }
    })();
  });
}

export interface ServeOptions {
  port: number;
  host: string;
}

/** `--port 4100 --host 127.0.0.1`, for a supervisor that picks the port for us. */
function flag(name: string): string | undefined {
  const index = process.argv.findIndex((argument) => argument === `--${name}`);
  if (index !== -1) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith('--')) return next;
  }
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

export function startFromArgs(): void {
  const port = Number(flag('port'));
  const host = flag('host');
  startServer({
    ...(Number.isFinite(port) && port > 0 ? { port } : {}),
    ...(host ? { host } : {}),
  });
}

export function startServer(options?: Partial<ServeOptions>) {
  const active = loadConfig();
  const port = options?.port ?? active.server.port;
  const host = options?.host ?? active.server.host;
  const server = createApp();
  server.listen(port, host, async () => {
    installLogCapture();
    await primeVersion();
    note(`listening on http://${host}:${port} (version from package.json, captured for /api/debug/bundle)`);
    process.stdout.write(`typesafe routing proxy listening on http://${host}:${port}\n`);
    process.stdout.write(`  hass_local_openai_llm -> http://<this-host>:${port}/v1\n`);
    process.stdout.write(`  dashboard            -> http://<this-host>:${port}/\n`);
    const ui = await ensureUiBundle();
    if (ui === 'unavailable') {
      process.stdout.write('  note: public/app.js is missing — run npm run dev (or npm run build:ui) to bundle the dashboard\n');
    }
    if (!active.decision.baseUrl && active.decision.backend === 'systemone') {
      process.stdout.write('  note: decision backend is systemone but no base URL is set — set one in the dashboard\n');
    }
  });

  // Exit promptly on `docker stop` / `compose down` instead of waiting for the
  // default 10 s SIGKILL timeout: stop accepting work, drop idle keep-alive
  // sockets, and take a hard exit if something (an open stream) lingers.
  const shutdown = (signal: string) => {
    process.stdout.write(`${signal} received — closing\n`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}

export type { TraceEntry };

// Allow `tsx src/server.ts --port 4100` as well as `node dist/index.js`.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startFromArgs();
}
