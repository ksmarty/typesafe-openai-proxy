/**
 * One conversation turn, from the incoming chat request to the response.
 *
 * The order matters and encodes the design: a round that already carries a tool
 * result is a *speech* round, a question we asked last turn may be answered by this
 * utterance, and only then does the decision model get a say. Anything the fast path
 * declines goes to the inference server with the request untouched.
 */

import type { ServerResponse } from 'node:http';

import { getCatalog } from './catalog.js';
import { loadConfig, ROUTER_MODEL, type Config } from './config.js';
import { extract } from './extract.js';
import { heuristicDecide } from './heuristic.js';
import { buildQuestions } from './questions.js';
import { route as routeRequest } from './router.js';
import {
  completionId,
  forwardUpstream,
  NO,
  respondText,
  respondToolCall,
  speechForLastTool,
  YES,
  type ChunkOptions,
} from './respond.js';
import { issuedCalls, pendingConfirmations, rememberTrace, stats } from './state.js';
import { decide, DecisionUnavailable } from './systemone.js';
import { inventoryFor } from './toolcall.js';
import type { OpenAIChatRequest, OpenAIMessage, Plan, RouteResult, TraceEntry } from './types.js';
import { sha1, uid } from './util.js';

function languageOf(request: OpenAIChatRequest): string | undefined {
  const candidate = (request as Record<string, unknown>).language;
  return typeof candidate === 'string' && candidate.length < 12 ? candidate : undefined;
}

function systemPromptOf(messages: OpenAIMessage[]): string {
  return messages
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

function lastUserMessage(messages: OpenAIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return undefined;
}

/** A stable identity per Home Assistant conversation. */
function sessionKey(request: OpenAIChatRequest, systemPrompt: string): string {
  const explicit = (request as Record<string, unknown>).conversation_id;
  if (typeof explicit === 'string' && explicit) return explicit;
  const device = (request as Record<string, unknown>).device_id;
  return sha1(`${device ?? ''}|${systemPrompt.slice(0, 400)}|${request.model ?? ''}`);
}

function historyOf(messages: OpenAIMessage[], turns: number): { text: string; said_by: 'user' | 'assistant' }[] {
  if (turns <= 0) return [];
  const said: { text: string; said_by: 'user' | 'assistant' }[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) continue;
    said.push({ text: message.content.trim(), said_by: message.role });
  }
  return said.slice(-turns * 2);
}

export interface PipelineResult {
  route: RouteResult;
  entry: TraceEntry;
  /** Why the fast path was skipped, when it was. */
  bypass?: string;
}

/** Is the fast path willing to decide, and if not, why not? */
export function fastPathStatus(active: Config): { ready: boolean; reason: string } {
  if (!active.routing.enabled) return { ready: false, reason: 'routing is switched off' };
  if (active.decision.backend === 'none') {
    return { ready: false, reason: 'no decision backend configured' };
  }
  if (active.decision.backend === 'systemone' && !active.decision.baseUrl) {
    return { ready: false, reason: 'no decision base URL configured' };
  }
  if (active.decision.backend === 'systemone' && !active.decision.model) {
    return { ready: false, reason: 'no decision model name configured' };
  }
  if (active.decision.backend === 'heuristic') {
    return { ready: true, reason: 'built-in heuristic (no model needed)' };
  }
  return { ready: true, reason: `System One at ${active.decision.baseUrl}` };
}

/** Decide, then route. Never executes anything. */
export async function runPipeline(
  request: OpenAIChatRequest,
  utterance: string,
  systemPrompt: string,
  active: Config = loadConfig(),
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const readiness = fastPathStatus(active);
  const inventory = inventoryFor(request.tools);
  const catalog = await getCatalog(active, systemPrompt);
  const extraction = extract(utterance, {
    entityNames: catalog.entities.map((entity) => entity.name),
  });
  const built = buildQuestions(catalog, extraction, {
    maxOptions: active.decision.maxOptions,
    defaultArea: active.catalog.defaultArea,
  });

  const decision =
    active.decision.backend === 'systemone' && active.decision.baseUrl
      ? await decide({
          utterance,
          catalog,
          questions: built.questions,
          spokenFromAreaName: active.catalog.defaultArea,
          language: languageOf(request),
          config: active,
          conversation: historyOf(request.messages, active.decision.historyTurns),
        })
      : heuristicDecide({
          utterance,
          catalog,
          questions: built.questions,
          spokenFromAreaName: active.catalog.defaultArea,
          language: languageOf(request),
          config: active,
          built,
        });

  const result: RouteResult = active.routing.enabled
    ? routeRequest({
        utterance,
        language: languageOf(request),
        catalog,
        answers: decision.answers,
        built,
        extraction,
        config: active,
        inventory,
      })
    : { plan: { kind: 'forward', reason: 'routing disabled' } as Plan, gates: [], reason: 'routing disabled' };

  const entry: TraceEntry = {
    id: uid('trace'),
    at: Date.now(),
    utterance,
    ...(languageOf(request) ? { language: languageOf(request) } : {}),
    route: result.plan.kind,
    reason: result.reason,
    ...(result.plan.kind === 'tool' ? { tool: result.plan.tool, args: result.plan.args } : {}),
    ...(result.category ? { category: result.category } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.target ? { target: result.target } : {}),
    gates: result.gates,
    decisionMs: decision.latencyMs,
    totalMs: Date.now() - startedAt,
    inputTokens: decision.inputTokens,
    backend: decision.backend,
    catalogSource: catalog.source,
    entities: catalog.entities.length,
    model: decision.model,
    ...(result.plan.kind === 'clarify' ? { clarification: result.plan.text } : {}),
  };

  if (!readiness.ready) {
    entry.backend = 'off';
    entry.reason = `pass-through: ${readiness.reason}`;
  }

  stats.requests += 1;
  // Only a real decision counts toward the average; pass-throughs and probes don't.
  if (readiness.ready) stats.decisionMs += decision.latencyMs;
  switch (result.plan.kind) {
    case 'tool':
      stats.toolCalls += 1;
      stats.routable += 1;
      break;
    case 'forward':
      stats.forwarded += 1;
      break;
    case 'clarify':
      stats.clarifications += 1;
      break;
    case 'confirm':
      stats.confirmations += 1;
      break;
    default:
      break;
  }
  rememberTrace(entry);

  return { route: result, entry, ...(readiness.ready ? {} : { bypass: readiness.reason }) };
}

export async function handleChatCompletions(
  request: OpenAIChatRequest,
  rawBody: string,
  response: ServerResponse,
  /** Overridden by the tests; the server always uses the saved configuration. */
  override?: Config,
): Promise<void> {
  const active = override ?? loadConfig();

  /**
   * Nothing is decided until the user asks for it. Two ways in: the configured backend
   * with autoStart on, or a request that names the router model explicitly — the second
   * is what makes the proxy safe to install in front of a working client, because a
   * request that does not ask for it is forwarded byte-for-byte.
   */
  const wanted = (request.model ?? '').trim() === ROUTER_MODEL || active.decision.autoStart;
  const canDecide =
    active.routing.enabled &&
    active.decision.backend !== 'none' &&
    (active.decision.backend !== 'systemone' || Boolean(active.decision.baseUrl));

  if (!wanted || !canDecide) {
    stats.requests += 1;
    stats.bypassed += 1;
    const reason = !wanted
      ? `pass-through: model "${request.model ?? ''}" is not "${ROUTER_MODEL}" and autoStart is off`
      : active.decision.backend === 'none'
        ? 'pass-through: no decision backend configured'
        : 'pass-through: no decision base URL configured';
    rememberTrace({
      id: uid('trace'),
      at: Date.now(),
      utterance: lastUserMessage(request.messages ?? []) ?? '',
      route: 'forward',
      reason,
      gates: [],
      backend: 'off',
      ...(request.model ? { model: request.model } : {}),
    });
    await forwardUpstream(request, rawBody, response, override);
    return;
  }

  const options = (): ChunkOptions => ({
    model: request.model ?? 'proxy',
    stream: Boolean(request.stream),
    id: completionId(),
  });

  const messages = request.messages ?? [];
  const systemPrompt = systemPromptOf(messages);
  const key = sessionKey(request, systemPrompt);

  // 1. A round carrying a tool result is a speech round.
  const toolMessage = [...messages].reverse().find((message) => message.role === 'tool');
  if (toolMessage) {
    if (active.speech.afterTool === 'upstream') {
      await forwardUpstream(request, rawBody, response, override);
      return;
    }
    if (active.speech.afterTool === 'empty') {
      respondText(options(), '', response);
      return;
    }
    const text = speechForLastTool(
      toolMessage.tool_call_id,
      typeof toolMessage.content === 'string' ? toolMessage.content : undefined,
      languageOf(request),
    );
    respondText(options(), text || 'Done.', response);
    return;
  }

  const utterance = lastUserMessage(messages);
  if (!utterance) {
    await forwardUpstream(request, rawBody, response, override);
    return;
  }

  // 2. An armed yes/no question, answered by this utterance.
  const pending = pendingConfirmations.get(key);
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      pendingConfirmations.delete(key);
    } else if (YES.test(utterance)) {
      pendingConfirmations.delete(key);
      emitToolCall(response, options(), pending.plan);
      rememberTrace({
        id: uid('trace'),
        at: Date.now(),
        utterance,
        route: 'tool',
        reason: 'confirmed by the speaker',
        tool: pending.plan.tool,
        args: pending.plan.args,
        gates: [],
        backend: 'confirmation',
      });
      return;
    } else if (NO.test(utterance)) {
      pendingConfirmations.delete(key);
      respondText(options(), 'Okay, cancelled.', response);
      return;
    } else {
      pendingConfirmations.delete(key);
    }
  }

  // 3. Decide and route.
  let result: PipelineResult;
  try {
    result = await runPipeline(request, utterance, systemPrompt, active);
  } catch (error) {
    if (error instanceof DecisionUnavailable) {
      stats.errors += 1;
      rememberTrace({
        id: uid('trace'),
        at: Date.now(),
        utterance,
        route: 'forward',
        reason: `decision unavailable: ${error.message}`,
        gates: [],
        error: error.message,
      });
      await forwardUpstream(request, rawBody, response, override);
      return;
    }
    stats.errors += 1;
    throw error;
  }

  const plan = result.route.plan;
  switch (plan.kind) {
    case 'tool':
      emitToolCall(response, options(), plan);
      return;
    case 'clarify':
    case 'text':
      respondText(options(), plan.text, response);
      return;
    case 'confirm':
      pendingConfirmations.set(key, {
        plan: plan.pending,
        utterance,
        expiresAt: Date.now() + active.speech.confirmSeconds * 1000,
      });
      respondText(options(), plan.text, response);
      return;
    case 'forward':
    default:
      await forwardUpstream(request, rawBody, response, override);
  }
}

function emitToolCall(
  response: ServerResponse,
  options: ChunkOptions,
  plan: Extract<Plan, { kind: 'tool' }>,
): void {
  const callId = uid('call');
  issuedCalls.set(callId, {
    action: plan.action,
    targets: plan.targets,
    ...(plan.domain ? { domain: plan.domain } : {}),
    at: Date.now(),
  });
  respondToolCall(options, { id: callId, name: plan.tool, args: JSON.stringify(plan.args) }, response);
}
