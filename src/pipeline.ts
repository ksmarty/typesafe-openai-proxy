/**
 * One conversation turn, from the incoming chat request to the response.
 *
 * The order matters and encodes the design: a round that already carries a tool
 * result is a *speech* round, a question we asked last turn may be answered by this
 * utterance, and only then does the decision model get a say. Anything the fast path
 * declines goes to the inference server with the request untouched.
 */

import type { ServerResponse } from 'node:http';

import { ACTION_VERBS } from './actions.js';

import { getCatalog, homeSignature } from './catalog.js';
import { directStatePlan } from './answer.js';
import { looksLikeChatter } from './chatter.js';
import { judgeAddressee } from './addressee.js';
import { actionPhrase, humanTarget, interpolateSpeech, ruleFor } from './speech.js';
import { cachedDecision, decisionKey, isQuestion, rememberDecision } from './decidecache.js';
import { loadConfig, ROUTER_MODEL, type Config } from './config.js';
import { extract } from './extract.js';
import { heuristicDecide } from './heuristic.js';
import { buildQuestions, Q } from './questions.js';
import { noulOf, route as routeRequest } from './router.js';
import {
  completionId,
  forwardUpstream,
  NO,
  respondText,
  respondToolCalls,
  speechForLastTool,
  YES,
  type ChunkOptions,
} from './respond.js';
import { issuedCalls, pendingConfirmations, rememberTrace, stats, updateTrace } from './state.js';
import { splitClauses } from './compound.js';
import { decide, DecisionUnavailable } from './systemone.js';
import { inventoryFor } from './toolcall.js';
import type {
  Answer,
  Catalog,
  Gate,
  OpenAIChatRequest,
  OpenAIMessage,
  Plan,
  RouteResult,
  ToolCall,
  TraceEntry,
} from './types.js';
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

/** The trace entry for a turn that was heard but not addressed to the assistant. */
function ignoredEntry(
  startedAt: number,
  utterance: string,
  catalog: Catalog,
  toolsOffered: string[],
  catalogMs: number,
  reason: string,
  extra: Partial<TraceEntry> = {},
): TraceEntry {
  return {
    ...extra,
    id: uid('trace'),
    at: startedAt,
    utterance,
    route: 'ignore',
    reason,
    gates: [],
    backend: 'off',
    catalogSource: catalog.source,
    catalogExposure: catalog.exposure,
    ...(toolsOffered.length ? { toolsOffered } : {}),
    timings: { catalogMs, questionsMs: 0, decideMs: 0 },
    totalMs: Date.now() - startedAt,
  };
}

/**
 * Was this sentence addressed to the assistant?
 *
 * The answer decides whether a turn that the fast path cannot handle itself is forwarded
 * for the model to act on, or answered with silence because it was a remark between people
 * that the microphone happened to catch.
 *
 * Two readers, in order of authority:
 *  1. the decision model's answer to `Q.addressed`, when one was asked;
 *  2. the local pattern reader (`src/addressee.ts`), when `listening.local` is on and no
 *     model answered — a pass-through install, the backend switched off, a model that is
 *     down.
 *
 * Anything neither reader is sure about is forwarded exactly as before.
 */
export function addresseeVerdict(
  active: Config,
  utterance: string,
  catalog: Catalog,
  answers?: Record<string, Answer>,
): { silent: boolean; reason: string } {
  if (!active.listening.enabled) return { silent: false, reason: 'listening is switched off' };

  const fromModel = answers ? noulOf(answers, Q.addressed) : undefined;
  if (typeof fromModel === 'number') {
    // `addressed` is a noul: the number is the probability that it WAS meant for us.
    const notAddressed = 1 - fromModel;
    if (notAddressed >= active.listening.confidence) {
      return {
        silent: true,
        reason: `not addressed to the assistant (the decision model read it as ${Math.round(notAddressed * 100)}% a remark)`,
      };
    }
    return { silent: false, reason: 'the decision model read it as addressed to the assistant' };
  }

  if (!active.listening.local) return { silent: false, reason: 'no model answered and the local reader is off' };

  const verdict = judgeAddressee(utterance, catalog);
  if (verdict.notAddressed >= active.listening.confidence) {
    return { silent: true, reason: `not addressed to the assistant (${verdict.reason})` };
  }
  return { silent: false, reason: verdict.reason };
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
    // Nothing can be called, but a remark that was overheard must still not be answered.
    const verdict = addresseeVerdict(active, utterance, catalog);
    if (verdict.silent) {
      const entry = ignoredEntry(startedAt, utterance, catalog, toolsOffered, catalogMs, verdict.reason);
      rememberTrace(entry);
      stats.requests += 1;
      stats.ignored += 1;
      return {
        route: { plan: { kind: 'ignore', reason: verdict.reason, silence: active.speech.silence }, gates: [], reason: verdict.reason },
        entry,
      };
    }
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
  // "Is the desk lamp on?" is a catalogue lookup, not a decision: the state is already here,
  // so answering locally turns the most common query into a couple of milliseconds.
  if (active.routing.enabled) {
    const direct = directStatePlan(catalog, utterance);
    if (direct) {
      const reason = `state question about ${direct.entity.id} — answered from the catalog, no model call`;
      const entry: TraceEntry = {
        id: uid('trace'),
        at: startedAt,
        utterance,
        route: 'text',
        reason,
        gates: [],
        category: 'query',
        backend: 'off',
        catalogSource: catalog.source,
        catalogExposure: catalog.exposure,
        toolsOffered,
        timings: { catalogMs, questionsMs: 0, decideMs: 0 },
        totalMs: Date.now() - startedAt,
      };
      rememberTrace(entry);
      stats.requests += 1;
      return {
        route: { plan: { kind: 'text', text: direct.text } as Plan, gates: [], reason, category: 'query' },
        entry,
      };
    }
  }

  const entityNames = catalog.entities.map((entity) => entity.name);

  // "no you", "ignore that", "thanks" — conversation, not a command. Answering it with a
  // decision call would cost a round trip and could nudge a device; the model server is the
  // right reader for it.
  if (active.routing.enabled) {
    const chatter = looksLikeChatter(utterance, catalog);
    if (chatter) {
      // "ignore that", "no you", "thanks": the model is the right reader for a reply to the
      // assistant, but a remark that was never addressed to it is answered with silence.
      const verdict = addresseeVerdict(active, utterance, catalog);
      if (verdict.silent) {
        const entry = ignoredEntry(startedAt, utterance, catalog, toolsOffered, catalogMs, verdict.reason);
        rememberTrace(entry);
        stats.requests += 1;
        stats.ignored += 1;
        return {
          route: {
            plan: { kind: 'ignore', reason: verdict.reason, silence: active.speech.silence },
            gates: [],
            reason: verdict.reason,
          },
          entry,
        };
      }
      const entry: TraceEntry = {
        id: uid('trace'),
        at: startedAt,
        utterance,
        route: 'forward',
        reason: chatter,
        gates: [],
        backend: 'off',
        catalogSource: catalog.source,
        catalogExposure: catalog.exposure,
        toolsOffered,
        timings: { catalogMs, questionsMs: 0, decideMs: 0 },
        totalMs: Date.now() - startedAt,
      };
      rememberTrace(entry);
      stats.requests += 1;
      stats.bypassed += 1;
      return {
        route: { plan: { kind: 'forward', reason: chatter } as Plan, gates: [], reason: chatter },
        entry,
        bypass: chatter,
      };
    }
  }

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

    // A repeated sentence against an unchanged house does not need another model round trip.
    const key =
      active.decision.cache && !isQuestion(text)
        ? decisionKey({
            utterance: text,
            language: languageOf(request),
            model: active.decision.model,
            baseUrl: active.decision.baseUrl,
            spokenFromArea: active.catalog.defaultArea,
            questions: built.questions,
            homeSignature: homeSignature(catalog),
          })
        : '';
    const remembered = key ? cachedDecision(key) : null;

    const decision =
      remembered ??
      (active.decision.backend === 'systemone' && active.decision.baseUrl
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
          }));
    if (!remembered && key) rememberDecision(key, decision);
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

  // The fast path cannot resolve this one — it was going to forward the sentence to the
  // model server, or ask a clarifying question aloud. Either way a remark that was never
  // addressed to the assistant must not be answered at all. When the decision model was
  // asked (`Q.addressed`) its answer is used; when it was not — a pass-through install, no
  // backend, a model that is down — the local reader decides.
  //
  // Only a plan that was already unsure of itself is judged here. A plan the fast path
  // resolved into a tool call is left alone: the model's answer to a brand-new question is
  // not yet calibrated against the house, and silencing a real command is worse than
  // answering a remark.
  const unresolved = result.plan.kind === 'forward' || result.plan.kind === 'clarify' || result.plan.kind === 'confirm';
  if (unresolved) {
    const verdict = addresseeVerdict(
      active,
      utterance,
      catalog,
      readiness.ready ? first.decision.answers : undefined,
    );
    if (verdict.silent) {
      const ignored = ignoredEntry(startedAt, utterance, catalog, toolsOffered, catalogMs, verdict.reason, {
        ...(readiness.ready
          ? {
              decisionMs: decision.latencyMs,
              backend: decision.backend,
              model: decision.model,
              timings: { catalogMs, questionsMs, decideMs: decision.latencyMs },
              entities: catalog.entities.length,
              ...(decision.cached ? { decisionCached: true } : {}),
            }
          : {}),
      });
      rememberTrace(ignored);
      stats.requests += 1;
      stats.ignored += 1;
      return {
        route: {
          plan: { kind: 'ignore', reason: verdict.reason, silence: active.speech.silence },
          gates: result.gates,
          reason: verdict.reason,
        },
        entry: ignored,
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
    ...(decision.cached ? { decisionCached: true } : {}),
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
    const utterance = lastUserMessage(request.messages ?? []) ?? '';
    const reason = !wanted
      ? `pass-through: model "${request.model ?? ''}" is not "${ROUTER_MODEL}" and autoStart is off`
      : active.decision.backend === 'none'
        ? 'pass-through: no decision backend configured'
        : 'pass-through: no decision base URL configured';

    // No model will be asked on this path, so the local reader is the only thing that can
    // tell a request from a remark. Without it, every overheard sentence is forwarded and
    // answered.
    if (active.listening.enabled && active.listening.local && utterance) {
      const catalog = await getCatalog(active, systemPromptOf(request.messages ?? []));
      const verdict = addresseeVerdict(active, utterance, catalog);
      if (verdict.silent) {
        rememberTrace({
          id: uid('trace'),
          at: Date.now(),
          utterance,
          route: 'ignore',
          reason: verdict.reason,
          gates: [],
          backend: 'off',
          catalogSource: catalog.source,
          ...(request.model ? { model: request.model } : {}),
        });
        stats.requests += 1;
        stats.ignored += 1;
        respondText(
          { model: request.model ?? 'proxy', stream: Boolean(request.stream), id: completionId() },
          active.speech.silence,
          response,
        );
        return;
      }
    }

    stats.requests += 1;
    stats.bypassed += 1;
    rememberTrace({
      id: uid('trace'),
      at: Date.now(),
      utterance,
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
    // Per-call policy first. A rule can silence a lamp, keep a shopping list speaking, or say
    // something of its own — one setting for every intent was too blunt.
    const described = toolMessages.map((message) => {
      const call = message.tool_call_id ? issuedCalls.get(message.tool_call_id) : undefined;
      return {
        message,
        args: call?.args,
        call: { tool: call?.tool, domain: call?.domain, action: call?.action, targets: call?.targets },
      };
    });
    const ruled = described.map(({ call }) => ruleFor(active.speech.rules, call));
    const silenced = ruled.filter((rule) => rule?.mode === 'silent').length;
    const silence = active.speech.silence || '';
    // A rule that says anything at all takes the round out of the model's hands.
    const ruleTookOver = ruled.some(Boolean);
    if (active.speech.afterTool === 'upstream' && !ruleTookOver) {
      await forwardUpstream(request, rawBody, response, override);
      return;
    }
    // null means "let Home Assistant, or the template, say it".
    const resolved = described.map((item, index) => {
      const rule = ruled[index];
      if (rule?.mode === 'silent') return '';
      if (rule?.mode === 'custom') {
        const template = rule.say ?? '';
        const spokenItem = spokenItemOf(item.args);
        return interpolateSpeech(template, {
          entity: humanTarget(item.call.targets),
          action: actionPhrase(item.call.action, template, spokenItem),
          item: spokenItem,
        });
      }
      // An explicit "speak" outranks the default, which is the point of the rule.
      if (rule?.mode === 'speak') return null;
      // No rule, so the default decides: "stay quiet" means quiet, anything else lets Home
      // Assistant or the template speak.
      return active.speech.afterTool === 'empty' ? '' : null;
    });
    const parts: string[] = [];
    described.forEach((item, index) => {
      const fixed = resolved[index];
      if (typeof fixed === 'string') {
        if (fixed) parts.push(fixed);
        return;
      }
      const said = speechForLastTool(
        item.message.tool_call_id,
        textOf(item.message.content) || undefined,
        languageOf(request),
      );
      if (said) parts.push(said);
    });
    const text = [...new Set(parts)].join(' ').trim();
    const reason = !text
      ? `silent by rule (${describeRules(described.map((item) => item.call))}, sent "${silence}")`
      : ruleTookOver
        ? `answered by rule (${describeRules(
            described.filter((_item, index) => resolved[index] !== null && resolved[index] !== '').map((item) => item.call),
          )}${silenced ? `, ${silenced} of ${toolMessages.length} silent` : ''})`
        : `answered from Home Assistant's tool result (speech.afterTool = "${active.speech.afterTool}")`;
    rememberTrace({
      id: uid('trace'),
      at: Date.now(),
      utterance: '',
      route: 'text',
      reason,
      gates: [],
      backend: 'speech',
      ...(toolMessage.tool_call_id ? { tool: toolMessage.tool_call_id } : {}),
    });
    // An empty string still starts a TTS job in some pipelines; a pause marker is silence.
    respondText(options(), text || silence, response);
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
      const usable =
        localPlan &&
        (localPlan.kind === 'tool' ||
          localPlan.kind === 'calls' ||
          localPlan.kind === 'clarify' ||
          localPlan.kind === 'confirm' ||
          localPlan.kind === 'ignore');
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
    case 'ignore':
      // Heard, judged a remark, answered with the configured silence.
      respondText(options(), plan.silence, response);
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
      tool: call.tool,
      args: call.args,
      at: Date.now(),
    });
    return { id, name: call.tool, args: JSON.stringify(call.args) };
  });
  respondToolCalls(options, prepared, response);
}

/** A past-tense verb for `{action}` in a custom sentence. */
function actionVerb(action: string | undefined): string {
  if (!action) return '';
  return ACTION_VERBS[action] ?? action.replace(/_/g, ' ');
}

/** The free-text item a list call carries, so "Added Milk" can name it. */
function spokenItemOf(args: Record<string, unknown> | undefined): string {
  const raw = args?.item ?? args?.text ?? args?.search_query;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** A short, readable identity for a round of calls, used in the trace reason. */
function describeRules(calls: { tool?: string; domain?: string; action?: string }[]): string {
  const names = calls.map((call) => call.tool ?? [call.domain, call.action].filter(Boolean).join('.') ?? 'call');
  return names.length > 1 ? `${names.length} calls: ${names.join(', ')}` : names[0] ?? 'no call';
}
