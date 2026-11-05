/** Process-wide in-memory state: the trace ring, counters and anything pending. */

import { loadConfig } from './config.js';
import type { Plan, TraceEntry } from './types.js';

export const startedAt = Date.now();

export const trace: TraceEntry[] = [];

/** Requests that never reached a decision model. */
export const stats = {
  requests: 0,
  toolCalls: 0,
  forwarded: 0,
  bypassed: 0,
  ignored: 0,
  clarifications: 0,
  confirmations: 0,
  errors: 0,
  decisionMs: 0,
  routable: 0,
};

export interface PendingConfirmation {
  plan: Extract<Plan, { kind: 'tool' } | { kind: 'calls' }>;
  utterance: string;
  expiresAt: number;
}

/** One armed yes/no question per conversation. */
export const pendingConfirmations = new Map<string, PendingConfirmation>();

/** Tool calls we issued, so the follow-up round can be spoken locally. */
export const issuedCalls = new Map<
  string,
  {
    action: string;
    targets: string[];
    domain?: string;
    tool?: string;
    /** The slots we sent, so a custom sentence can name the list item it added. */
    args?: Record<string, unknown>;
    /**
     * The trace entry of the turn that issued this call. The speech round that answers the
     * call is nested under that turn in the dashboard, so one sentence is one row however
     * many HTTP requests it took.
     */
    turnId?: string;
    at: number;
  }
>();

/** Long enough for a slow model round trip, short enough not to grab an unrelated turn. */
const TURN_TTL_MS = 120 * 1000;

/**
 * The turns a conversation has been on, keyed by the sentence that started each.
 *
 * A forwarded request goes to the model server, which may answer it with a tool call of its
 * own; Home Assistant runs it and replays it in a follow-up request. That follow-up has no
 * `issuedCalls` entry to point at, and without one the two rows read as unrelated requests —
 * and a speech rule had nothing to match, so a plain question was answered with silence.
 *
 * Keyed by sentence rather than "the newest turn", because Home Assistant replays the whole
 * conversation back and two questions in a row would otherwise attach the first one's answer
 * to the second one's row.
 */
export const turnBySession = new Map<string, Map<string, { id: string; at: number; category?: string }>>();

/** Turns remembered per conversation. Home Assistant starts a new conversation often enough. */
const TURNS_PER_SESSION = 12;

/** Remember the turn this sentence started. */
export function rememberTurn(session: string, utterance: string, id: string, category?: string): void {
  let turns = turnBySession.get(session);
  if (!turns) {
    turns = new Map();
    turnBySession.set(session, turns);
  }
  // Re-asking the same sentence supersedes the old turn rather than piling up.
  turns.delete(utterance);
  turns.set(utterance, { id, at: Date.now(), ...(category ? { category } : {}) });
  while (turns.size > TURNS_PER_SESSION) {
    const oldest = turns.keys().next().value;
    if (oldest === undefined) break;
    turns.delete(oldest);
  }
}

/**
 * The turn this sentence is following up on, if it is recent enough to own the answer.
 *
 * The category comes back too: a question is owed an answer, and a follow-up round that
 * answers one should not be silenced by a default meant for commands.
 */
export function lastTurnFor(
  session: string,
  utterance: string,
): { id: string; category?: string } | undefined {
  const turns = turnBySession.get(session);
  const turn = turns?.get(utterance);
  if (!turns || !turn) return undefined;
  if (turn.at <= Date.now() - TURN_TTL_MS) {
    turns.delete(utterance);
    if (!turns.size) turnBySession.delete(session);
    return undefined;
  }
  return { id: turn.id, ...(turn.category ? { category: turn.category } : {}) };
}

/** Both maps are pruned when they grow past this, so a long-running proxy cannot leak. */
const MAP_CAP = 200;
/** Issued calls older than this are useless: the follow-up round already happened. */
const ISSUED_TTL_MS = 10 * 60 * 1000;

/** Drop expired confirmations and cap both maps at their newest entries. */
export function pruneState(): void {
  const now = Date.now();
  for (const [key, pending] of pendingConfirmations) {
    if (pending.expiresAt <= now) pendingConfirmations.delete(key);
  }
  if (pendingConfirmations.size > MAP_CAP) {
    const excess = pendingConfirmations.size - MAP_CAP;
    let removed = 0;
    for (const key of pendingConfirmations.keys()) {
      if (removed >= excess) break;
      pendingConfirmations.delete(key);
      removed += 1;
    }
  }
  for (const [id, call] of issuedCalls) {
    if (call.at <= now - ISSUED_TTL_MS) issuedCalls.delete(id);
  }
  for (const [session, turns] of turnBySession) {
    for (const [utterance, turn] of turns) {
      if (turn.at <= now - TURN_TTL_MS) turns.delete(utterance);
    }
    if (!turns.size) turnBySession.delete(session);
  }
  if (issuedCalls.size > MAP_CAP) {
    const excess = issuedCalls.size - MAP_CAP;
    let removed = 0;
    for (const key of issuedCalls.keys()) {
      if (removed >= excess) break;
      issuedCalls.delete(key);
      removed += 1;
    }
  }
}

/** One row per request that reached /v1, whether or not it became a turn. */
export interface SeenRequest {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
}

export const requestLog: SeenRequest[] = [];

export function rememberRequest(entry: SeenRequest): void {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.length = 50;
}

export function rememberTrace(entry: TraceEntry): void {
  pruneState();
  trace.unshift(entry);
  const limit = Math.max(10, loadConfig().routing.traceLimit);
  if (trace.length > limit) trace.length = limit;
}

/** Fold a late measurement (how long the model server took) into an existing entry. */
export function updateTrace(id: string, patch: Partial<TraceEntry>): void {
  const entry = trace.find((candidate) => candidate.id === id);
  if (entry) Object.assign(entry, patch);
}

export function averageDecisionMs(): number {
  const decisions = stats.routable + stats.forwarded;
  return decisions === 0 ? 0 : Math.round(stats.decisionMs / decisions);
}

/** How often the fast path actually decided something. */
export function routableShare(): number {
  return stats.requests === 0 ? 0 : stats.routable / stats.requests;
}
