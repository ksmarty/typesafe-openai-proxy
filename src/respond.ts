/**
 * Talking back to hass_local_openai_llm in the shape it already understands:
 * OpenAI chat completions, either JSON or server-sent events.
 */

import type { ServerResponse } from 'node:http';

import { ACTION_VERBS } from './actions.js';
import { cachedCatalog } from './catalog.js';
import { ROUTER_MODEL, loadConfig, upstreamApiKey, type Config } from './config.js';
import { issuedCalls, stats } from './state.js';
import type { Catalog, CatalogEntity, OpenAIChatRequest } from './types.js';
import { fetchWithTimeout, uid } from './util.js';

export interface ChunkOptions {
  model: string;
  stream: boolean;
  id: string;
}

export function completionId(): string {
  return `chatcmpl-${uid('c').slice(2)}`;
}

export function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function chunk(options: ChunkOptions, delta: Record<string, unknown>, finish?: string): string {
  return JSON.stringify({
    id: options.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });
}

function sseHead(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
}

export function respondText(options: ChunkOptions, text: string, response: ServerResponse): void {
  if (!options.stream) {
    jsonResponse(response, 200, {
      id: options.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: options.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }
  sseHead(response);
  response.write(`data: ${chunk(options, { role: 'assistant' })}\n\n`);
  if (text) response.write(`data: ${chunk(options, { content: text })}\n\n`);
  response.write(`data: ${chunk(options, {}, 'stop')}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

export interface PreparedCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Answer with one or more tool calls.
 *
 * Home Assistant executes every call in the reply, in order, and sends one tool result
 * per call, so a request that names two rooms can be satisfied in a single turn instead
 * of one room per turn.
 */
export function respondToolCalls(
  options: ChunkOptions,
  calls: PreparedCall[],
  response: ServerResponse,
): void {
  const payload = calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.args },
  }));

  if (!options.stream) {
    jsonResponse(response, 200, {
      id: options.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: options.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: payload },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    return;
  }
  sseHead(response);
  response.write(`data: ${chunk(options, { role: 'assistant' })}\n\n`);
  response.write(
    `data: ${chunk(options, {
      tool_calls: payload.map((call, index) => ({ index, ...call })),
    })}\n\n`,
  );
  response.write(`data: ${chunk(options, {}, 'tool_calls')}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

/**
 * The body to send on. The client's `model` is normally passed through untouched,
 * but the proxy's own model name is not a model the inference server has: a
 * request that used it to opt into the fast path and then fell through to the
 * backend must be forwarded under the configured upstream model.
 */
function bodyForUpstream(rawBody: string, request: OpenAIChatRequest, active: Config): string {
  const requested = (request.model ?? '').trim();
  if (requested && requested !== ROUTER_MODEL) return rawBody;
  const model = (active.upstream.model ?? '').trim();
  if (!model) return rawBody;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, model });
  } catch {
    return rawBody;
  }
}

/** Hand the request, untouched, to the inference server hass_local_openai_llm used to use. */
export async function forwardUpstream(
  request: OpenAIChatRequest,
  rawBody: string,
  response: ServerResponse,
  /** Overridden by the tests; the server always uses the saved configuration. */
  override?: Config,
): Promise<void> {
  const active = override ?? loadConfig();
  const options: ChunkOptions = {
    model: request.model ?? 'proxy',
    stream: Boolean(request.stream),
    id: completionId(),
  };

  if (!active.upstream.baseUrl) {
    stats.errors += 1;
    respondText(
      options,
      'This request needs your model server, and the proxy has none configured. ' +
        'Open the dashboard → Settings → Fallback inference server and set its URL.',
      response,
    );
    return;
  }

  const url = `${active.upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = bodyForUpstream(rawBody, request, active);
  const key = upstreamApiKey(active);
  try {
    const upstream = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: request.stream ? 'text/event-stream' : 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body,
      },
      active.upstream.timeoutMs,
    );

    if (!upstream.ok || !upstream.body) {
      stats.errors += 1;
      const text = await upstream.text().catch(() => '');
      const hint =
        (upstream.status === 400 || upstream.status === 404) && /model/i.test(text)
          ? ' Set the model name for forwarded requests in Settings → Fallback inference server.'
          : '';
      respondText(
        options,
        `The inference server returned ${upstream.status}. ${text.slice(0, 200)}${hint}`,
        response,
      );
      return;
    }

    response.writeHead(upstream.status, {
      'content-type':
        upstream.headers.get('content-type') ??
        (request.stream ? 'text/event-stream; charset=utf-8' : 'application/json'),
      'cache-control': 'no-store',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    stats.errors += 1;
    respondText(
      options,
      `The inference server is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      response,
    );
  }
}

/**
 * What to say after Home Assistant ran a tool call.
 *
 * Home Assistant's own intent response carries the speech it would have spoken, so
 * prefer that: it is localised and already phrased. The template is the fallback.
 */
type Slot = { name?: string; type?: string };

/** Split an Assist success/failure list into the entities and the areas it names. */
function namesOf(slots: Slot[] | undefined): { entities: string[]; areas: string[] } {
  const pick = (type: string) =>
    (slots ?? [])
      .filter((slot) => slot.type === type && typeof slot.name === 'string' && slot.name.trim())
      .map((slot) => (slot.name as string).trim());
  return { entities: pick('entity'), areas: pick('area') };
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function speechFor(
  callId: string | undefined,
  toolContent: string | undefined,
  catalog: Catalog | null,
  /** Request language (`de`, `en-GB`, ...) - picks the template family to render with. */
  language?: string,
): string {
  const active = loadConfig();
  const info = callId ? issuedCalls.get(callId) : undefined;
  if (!info) return '';

  if (toolContent) {
    try {
      const parsed = JSON.parse(toolContent) as Record<string, unknown>;
      if (parsed.success === false) return '';
      const result = parsed.result as Record<string, unknown> | undefined;
      const speech = result?.speech as Record<string, unknown> | undefined;
      const plain = speech?.plain as Record<string, unknown> | undefined;
      // HA's intent response carries the localised sentence plus the slots it
      // was rendered from; prefer the sentence, then rebuild from the slots.
      const spoken =
        (typeof plain?.speech === 'string' && plain.speech.trim()) ||
        (typeof result?.speech === 'string' && (result.speech as string).trim()) ||
        '';
      if (spoken) return spoken.endsWith('.') ? spoken : `${spoken}.`;
      const slots = (plain?.extra_slots ?? plain?.speech_slots ?? speech?.slots) as
        | { name?: string; action?: string }
        | undefined;
      if (slots?.action) {
        const phrase = `${slots.action} ${slots.name ?? ''}`.replace(/\s+/g, ' ').trim();
        return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
      }
      // The shape Assist actually hands over: the intent's response data itself, with
      // whatever it acted on listed under `data.success`. Its `speech` is often `{}`,
      // which is why a turn used to be answered with a bare "Done." After v0.1.27 the
      // entities it affected are named instead.
      const assist = parsed as {
        response_type?: string;
        data?: { success?: Slot[]; failed?: Slot[] };
      };
      if (assist.response_type) {
        const verb = ACTION_VERBS[info.action] ?? 'Done with';
        const succeeded = namesOf(assist.data?.success);
        if (succeeded.entities.length) return `${verb} ${joinNames(succeeded.entities)}.`;
        if (succeeded.areas.length) return `${verb} ${joinNames(succeeded.areas)}.`;
        const failed = namesOf(assist.data?.failed);
        if (failed.entities.length) return `I could not reach ${joinNames(failed.entities)}.`;
      }
    } catch {
      /* not JSON: fall back to the template */
    }
  }

  const key = (language ?? 'en').split('-')[0] ?? 'en';
  const template = active.speech.templates[key] ?? active.speech.templates.en;
  if (!template) return '';
  const verb = ACTION_VERBS[info.action] ?? 'Done with';
  const targetId = info.targets[0];
  const entity: CatalogEntity | undefined = catalog?.entities.find((candidate) => candidate.id === targetId);
  const label = entity ? entity.name : (targetId ?? '').replace(/^[a-z_]+\./, '').replace(/_/g, ' ');
  return template.done
    .replace('{action}', verb)
    .replace('{entity}', label || 'that')
    .replace(/\s+/g, ' ')
    .trim();
}

export const YES = /^\s*(yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|confirm|please do|affirmative)\b/i;
export const NO = /^\s*(no|nope|nah|cancel|don'?t|stop|negative|forget it)\b/i;

/** Everything the follow-up round needs, resolved lazily. */
export function speechForLastTool(
  callId: string | undefined,
  content: string | undefined,
  language?: string,
): string {
  return speechFor(callId, content, cachedCatalog(), language);
}

/**
 * What to say after a turn that ran several calls.
 *
 * Home Assistant sends one tool result per call, so the round is spoken by joining what
 * each call came back with. Anything empty (a failure, a call it does not recognise) is
 * dropped rather than read out as a gap.
 */
export function speechForToolRound(
  results: { callId?: string; content?: string }[],
  language?: string,
): string {
  const catalog = cachedCatalog();
  const said = results
    .map((result) => speechFor(result.callId, result.content, catalog, language).trim())
    .filter((line) => line.length > 0);
  return [...new Set(said)].join(' ');
}
