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
    at: number;
  }
>();

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
