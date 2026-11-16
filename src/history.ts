/**
 * What the dashboard remembers between runs.
 *
 * A container update replaces the image and every in-memory array with it, which used to
 * take the whole decision history with it: the calls the proxy made, what was said back,
 * and the request log all started empty after an upgrade. Those are exactly the rows you
 * look at when something behaved oddly yesterday.
 *
 * The file lives in the data directory next to config.json and decision-cache.json, so it
 * survives an image update in the same way. Writes are debounced and atomic (a temporary
 * file renamed into place); a read-only or full data directory is ignored rather than
 * allowed to break a request.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TraceEntry } from './types.js';

const HISTORY_FILE = 'history.json';
const VERSION = 1;
const SAVE_DELAY_MS = 1500;
/** More than the dashboard ever asks for, few enough that the file stays small. */
const MAX_PERSISTED_TRACE = 1000;
const MAX_PERSISTED_REQUESTS = 50;

export interface StoredRequest {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
}

/** The shape written to disk. `savedAt` is for the reader, not for any logic. */
export interface HistorySnapshot {
  version: number;
  savedAt?: number;
  trace: TraceEntry[];
  requests: StoredRequest[];
  stats: Record<string, number>;
}

let directory = resolve(process.env.DATA_DIR || 'data');
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

export function historyPath(): string {
  return resolve(directory, HISTORY_FILE);
}

/**
 * Point history at the data directory and read what an earlier run saved.
 *
 * Returns the contents once, on the first call in this process, so the caller can put them
 * back into the live arrays. Later calls only move the directory, matching
 * `configureDecisionCache`.
 */
export function configureHistory(options?: { directory?: string }): HistorySnapshot | null {
  if (options?.directory) directory = options.directory;
  if (loaded) return null;
  loaded = true;
  return readHistory();
}

export function readHistory(): HistorySnapshot | null {
  try {
    const raw = readFileSync(historyPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<HistorySnapshot> | null;
    if (!parsed || parsed.version !== VERSION) return null;
    const trace = Array.isArray(parsed.trace)
      ? parsed.trace.filter(isTraceEntry).slice(0, MAX_PERSISTED_TRACE)
      : [];
    const requests = Array.isArray(parsed.requests)
      ? parsed.requests.filter(isStoredRequest).slice(0, MAX_PERSISTED_REQUESTS)
      : [];
    const stats: Record<string, number> = {};
    if (parsed.stats && typeof parsed.stats === 'object') {
      for (const [key, value] of Object.entries(parsed.stats)) {
        if (typeof value === 'number' && Number.isFinite(value)) stats[key] = value;
      }
    }
    return { version: VERSION, trace, requests, stats };
  } catch {
    // No file yet, or one an older build left half-written: start empty rather than fail boot.
    return null;
  }
}

/** Debounced write. Several trace updates in one turn become one file write. */
export function scheduleHistorySave(provide: () => HistorySnapshot): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveHistoryNow(provide);
  }, SAVE_DELAY_MS);
  saveTimer.unref();
}

/** Write immediately: used on shutdown, where a pending timer would never fire. */
export function saveHistoryNow(provide: () => HistorySnapshot): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const snapshot = provide();
    const body = JSON.stringify({
      version: VERSION,
      savedAt: Date.now(),
      trace: snapshot.trace.slice(0, MAX_PERSISTED_TRACE),
      requests: snapshot.requests.slice(0, MAX_PERSISTED_REQUESTS),
      stats: snapshot.stats,
    });
    mkdirSync(directory, { recursive: true });
    const target = historyPath();
    writeFileSync(`${target}.tmp`, body, 'utf8');
    renameSync(`${target}.tmp`, target);
  } catch {
    // A read-only data directory must not break a decision.
  }
}

function isTraceEntry(value: unknown): value is TraceEntry {
  const entry = value as TraceEntry | null;
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.at === 'number' &&
      typeof entry.route === 'string' &&
      Array.isArray(entry.gates),
  );
}

function isStoredRequest(value: unknown): value is StoredRequest {
  const request = value as StoredRequest | null;
  return Boolean(
    request &&
      typeof request === 'object' &&
      typeof request.at === 'number' &&
      typeof request.method === 'string' &&
      typeof request.path === 'string' &&
      typeof request.status === 'number' &&
      typeof request.ms === 'number',
  );
}
