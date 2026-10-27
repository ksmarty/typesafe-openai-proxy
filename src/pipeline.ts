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
  respondToolCalls,
  speechForLastTool,
  speechForToolRound,
  YES,
  type ChunkOptions,
} from './respond.js';
import { issuedCalls, pendingConfirmations, rememberTrace, stats, updateTrace } from './state.js';
import { splitClauses } from './compound.js';
import { decide, DecisionUnavailable } from './systemone.js';
import { inventoryFor } from './toolcall.js';
import type { Gate, OpenAIChatRequest, OpenAIMessage, Plan, RouteResult, ToolCall, TraceEntry } from './types.js';
import { sha1, textOf, uid } from './util.js';

function languageOf(request: OpenAIChatRequest): string | undefined {
  const candidate = (request as Record<string, unknown>).language;
  return typeof candidate === 'string' && candidate.length < 12 ? candidate : undefined;
}

function systemPromptOf(messages: OpenAIMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join('\n');
}

function lastUserMessage(messages: OpenAIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = textOf(message.content).trim();
    if (text) return text;
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
    const text = textOf(message.content).trim();
    if (!text) continue;
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) continue;
    said.push({ text, said_by: message.role });
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
  // Ready but idle is the confusing state: the backend is configured, yet nothing is
  // decided until a request asks for it. Say so where the status is read.
  const idle = active.decision.autoStart
    ? ''
    : ` — idle until a request names the model "${ROUTER_MODEL}" ("Start deciding on its own" is off)`;
  if (active.decision.backend === 'heuristic') {
    return { ready: true, reason: `built-in heuristic (no model needed)${idle}` };
  }
  return { ready: true, reason: `System One at ${active.decision.baseUrl}${idle}` };
}

/** Decide, then route. Never executes anything. */
export async function runPipeline(
  request: OpenAIChatRequest,
  utterance: string,
  systemPrompt: string,
  active: Config = loadConfig(),
): Promise<PipelineResult> {
  const startedAt = Date.now();
  let catalogMs = 0;
  let questionsMs = 0;
  const readiness = fastPathStatus(active);
  const inventory = inventoryFor(request.tools);
  const toolsOffered = [...inventory.keys()].sort().slice(0, 40);
  // Nothing can be called when the request brought no tool schemas: deciding would only
  // produce "X is not offered" for everything, which reads as a proxy fault when it is
  // actually the caller sending no intents.
  if (inventory.size === 0) {
    const catalogStarted = Date.now();
    const catalog = await getCatalog(active, systemPrompt);
    catalogMs = Date.now() - catalogStarted;
    const entry: TraceEntry = {
      id: uid('trace'),
      at: startedAt,
      utterance,
      route: 'forward',
      reason: 'pass-through: the request carried no tools, so no Home Assistant intent can be called',
      gates: [],
      backend: 'off',
      catalogSource: catalog.source,
      catalogExposure: catalog.exposure,
      toolsOffered: [],
      totalMs: Date.now() - startedAt,
    };
    rememberTrace(entry);
    stats.requests += 1;
    stats.bypassed += 1;
    return {
      route: { plan: { kind: 'forward', reason: entry.reason } as Plan, gates: [], reason: entry.reason },
      entry,
      bypass: entry.reason,
    };
  }
  const catalogStarted = Date.now();
  // A question about the home is answered from the catalog, so its state has to be fresh:
  // a 30 s old "locked" is worse than a 200 ms round trip.
  const catalog = await getCatalog(active, systemPrompt, {
    maxAgeMs: /\?\s*$|^(is|are|was|were|do|does|did|what|which|who|where|when|how|any)\b/i.test(
      utterance,
    )
      ? 2000
      : undefined,
  });
  catalogMs = Date.now() - catalogStarted;
  const entityNames = catalog.entities.map((entity) => entity.name);

  /**
   * Decide one sentence: extraction, question set, the model, then the routing gates.
   *
   * Kept as a closure so a compound sentence can be read clause by clause against the same
   * catalog, thresholds and tool inventory as the sentence as a whole.
   */
  const decideFor = async (text: string) => {
    const questionsStarted = Date.now();
    const extraction = extract(text, { entityNames });
    const built = buildQuestions(catalog, extraction, {
      maxOptions: active.decision.maxOptions,
      defaultArea: active.catalog.defaultArea,
    });
    questionsMs += Date.now() - questionsStarted;
    const decision =
      active.decision.backend === 'systemone' && active.decision.baseUrl
        ? await decide({
            utterance: text,
            catalog,
            questions: built.questions,
            spokenFromAreaName: active.catalog.defaultArea,
            language: languageOf(request),
            config: active,
            conversation: historyOf(request.messages, active.decision.historyTurns),
          })
        : heuristicDecide({
            utterance: text,
            catalog,
            questions: built.questions,
            spokenFromAreaName: active.catalog.defaultArea,
            language: languageOf(request),
            config: active,
            built,
          });
    const routed = routeRequest({
      utterance: text,
      language: languageOf(request),
      catalog,
      answers: decision.answers,
      built,
      extraction,
      config: active,
      inventory,
    });
    return { extraction, built, decision, routed };
  };

  const first = await decideFor(utterance);
  const { extraction, built, decision } = first;
  let result: RouteResult = active.routing.enabled
    ? first.routed
    : { plan: { kind: 'forward', reason: 'routing disabled' } as Plan, gates: [], reason: 'routing disabled' };

  // A compound sentence — "turn off the lights and lock the door" — is two actions, and one
  // action cannot satisfy it. Read each clause on its own and take the whole set only when
  // every clause resolved: acting on half a sentence is the outcome worth avoiding, so a
  // clause the fast path cannot read sends the whole sentence to the model instead.
  const clauses = active.routing.enabled ? splitClauses(utterance) : [];
  const answeredElsewhere = result.plan.kind === 'clarify' || result.plan.kind === 'confirm';
  if (clauses.length >= 2 && !answeredElsewhere) {
    const calls: ToolCall[] = [];
    const clauseGates: Gate[] = [];
    for (const clause of clauses) {
      const part = (await decideFor(clause)).routed;
      const plan = part.plan;
      if (plan.kind === 'calls') calls.push(...plan.calls);
      else if (plan.kind === 'tool') {
        calls.push({
          tool: plan.tool,
          args: plan.args,
          targets: plan.targets,
          action: plan.action,
          ...(plan.domain ? { domain: plan.domain } : {}),
        });
      } else break;
      clauseGates.push(...part.gates);
    }
    if (calls.length >= 2 && calls.length === clauses.length) {
      const head = calls[0]!;
      result = {
        plan: { kind: 'calls', calls, action: head.action, ...(head.domain ? { domain: head.domain } : {}) },
        gates: [...result.gates, ...clauseGates],
        reason: `compound request split into ${calls.length} calls`,
        category: 'command',
        action: head.action,
        target: head.targets[0],
      };
    } else if (result.plan.kind !== 'forward' || !/^compound/i.test(result.reason)) {
      result = {
        plan: { kind: 'forward', reason: 'compound request: at least one clause is not something the fast path can call' },
        gates: [...result.gates, ...clauseGates],
        reason: 'compound request: at least one clause is not something the fast path can call',
      };
    }
  }

  const entry: TraceEntry = {
    id: uid('trace'),
    at: Date.now(),
    utterance,
    ...(languageOf(request) ? { language: languageOf(request) } : {}),
    route: result.plan.kind,
    reason: result.reason,
    ...(result.plan.kind === 'tool' ? { tool: result.plan.tool, args: result.plan.args } : {}),
    ...(result.plan.kind === 'calls'
      ? { calls: result.plan.calls.map((call) => ({ tool: call.tool, args: call.args })) }
      : {}),
    ...(result.category ? { category: result.category } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.target ? { target: result.target } : {}),
    gates: result.gates,
    decisionMs: decision.latencyMs,
    timings: { catalogMs, questionsMs, decideMs: decision.latencyMs },
    totalMs: Date.now() - startedAt,
    inputTokens: decision.inputTokens,
    backend: decision.backend,
    catalogSource: catalog.source,
    catalogExposure: catalog.exposure,
    entities: catalog.entities.length,
    ...(toolsOffered.length ? { toolsOffered } : {}),
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
    case 'calls':
      stats.toolCalls += result.plan.calls.length;
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

  // 1. A round whose newest messages are tool results is a speech round.
  //
  // It has to be the newest thing in the request: a tool message further back is history.
  // Home Assistant replays the whole chat log, so "contains a tool result" is not the same
  // as "this turn is the answer to a tool call" — treating history as a speech round made
  // the proxy answer a brand-new question with the previous action's sentence
  // ("What's two plus two?" -> "Turned off Kitchen Lights.").
  const trailingTools: OpenAIMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool') break;
    trailingTools.unshift(message);
  }
  const toolMessages = trailingTools;
  const toolMessage = trailingTools[trailingTools.length - 1];
  if (toolMessage) {
    if (active.speech.afterTool === 'upstream') {
      await forwardUpstream(request, rawBody, response, override);
      return;
    }
    if (active.speech.afterTool === 'empty') {
      respondText(options(), '', response);
      return;
    }
    if (toolMessage) {
      rememberTrace({
        id: uid('trace'),
        at: Date.now(),
        utterance: '',
        route: 'text',
        reason: `answered from Home Assistant's tool result (speech.afterTool = "${active.speech.afterTool}")`,
        gates: [],
        backend: 'speech',
        ...(toolMessage.tool_call_id ? { tool: toolMessage.tool_call_id } : {}),
      });
    }
    const text =
      toolMessages.length > 1
        ? speechForToolRound(
            toolMessages.map((message) => ({
              ...(message.tool_call_id ? { callId: message.tool_call_id } : {}),
              content: textOf(message.content),
            })),
            languageOf(request),
          )
        : speechForLastTool(
            toolMessage.tool_call_id,
            textOf(toolMessage.content) || undefined,
            languageOf(request),
          );
    respondText(options(), text || 'Done.', response);
    return;
  }

  const utterance = lastUserMessage(messages);
  if (!utterance) {
    const shapes = [...new Set(messages.map((message) => `${message.role}:${Array.isArray(message.content) ? 'parts' : typeof message.content}`))];
    rememberTrace({
      id: uid('trace'),
      at: Date.now(),
      utterance: '',
      route: 'forward',
      reason: `pass-through: no user text to read in the request (${shapes.join(', ') || 'no messages'})`,
      gates: [],
      backend: 'off',
    });
    stats.requests += 1;
    stats.bypassed += 1;
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
        ...(pending.plan.kind === 'tool'
          ? { tool: pending.plan.tool, args: pending.plan.args }
          : { calls: pending.plan.calls.map((call) => ({ tool: call.tool, args: call.args })) }),
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
      // The model is unreachable, but the sentence may be one the local heuristic reads
      // without any doubt. Try it before handing a 30-second turn to the model server:
      // if it is not confident, nothing changes and the request is forwarded as before.
      const local = await runPipeline(request, utterance, systemPrompt, {
        ...active,
        decision: { ...active.decision, backend: 'heuristic' },
      }).catch(() => null);
      const localPlan = local?.route.plan;
      const usable = localPlan && (localPlan.kind === 'tool' || localPlan.kind === 'calls' || localPlan.kind === 'clarify' || localPlan.kind === 'confirm');
      if (local && usable) {
        const note = `decision unavailable (${error.message}) — read locally instead`;
        updateTrace(local.entry.id, { reason: note, error: error.message });
        result = { ...local, entry: { ...local.entry, reason: note } };
      } else {
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
    } else {
      stats.errors += 1;
      throw error;
    }
  }

  const plan = result.route.plan;
  switch (plan.kind) {
    case 'tool':
    case 'calls':
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
    default: {
      // A forwarded turn is as slow as the model server is; measure it, because that
      // number is the answer to "why did that take half a minute".
      const forwardStarted = Date.now();
      try {
        await forwardUpstream(request, rawBody, response, override);
      } finally {
        updateTrace(result.entry.id, {
          upstreamMs: Date.now() - forwardStarted,
          totalMs: Date.now() - result.entry.at,
        });
      }
      break;
    }
  }
}

/**
 * Send the call, or the calls.
 *
 * Each call gets its own id and is remembered against it, because the follow-up round
 * arrives as one tool message per call and each is spoken locally.
 */
function emitToolCall(
  response: ServerResponse,
  options: ChunkOptions,
  plan: Extract<Plan, { kind: 'tool' } | { kind: 'calls' }>,
): void {
  const calls = plan.kind === 'calls' ? plan.calls : [plan];
  const prepared = calls.map((call) => {
    const id = uid('call');
    issuedCalls.set(id, {
      action: call.action,
      targets: call.targets,
      ...(call.domain ? { domain: call.domain } : {}),
      at: Date.now(),
    });
    return { id, name: call.tool, args: JSON.stringify(call.args) };
  });
  respondToolCalls(options, prepared, response);
}
