/**
 * Decisions that were already made.
 *
 * Most voice traffic is repetition: the same sentence, minutes apart, against the same house.
 * A cached answer saves the whole model round trip (300–900 ms and several thousand tokens),
 * which is by far the largest cost in a turn once the catalog is small.
 *
 * Three things keep it honest:
 *  - the key covers the sentence, the language, the default area, the question set, the model
 *    and a signature of the exposed entities (`homeSignature`: ids and rooms, never state), so
 *    a rebuilt catalog is still a hit while an added, removed or re-exposed entity is a miss;
 *  - questions are never cached, because their answer depends on live entity state;
 *  - nothing expires on a clock. "Turn on the kitchen lights" is still the same decision
 *    tomorrow, and a container restart should not pay for it again, so the entries are written
 *    to the data directory and read back at boot.
 */

import { resolve } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { DecisionResponse, QuestionSet } from './types.js';
import { sha1 } from './util.js';

const CACHE_FILE = 'decision-cache.json';
const SAVE_DELAY_MS = 2000;

interface Entry {
  at: number;
  value: DecisionResponse;
}

const MAX_ENTRIES = 500;
const entries = new Map<string, Entry>();

let persist = true;
let directory = resolve(process.env.DATA_DIR || 'data');
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

export function decisionCacheDirectory(): string {
  return directory;
}

/** Where the cache lives on disk (inside the mounted data directory). */
export function decisionCachePath(): string {
  return resolve(directory, CACHE_FILE);
}

/**
 * Point the cache at the data directory and, the first time, read what an earlier run saved.
 * Called on boot and whenever the settings are saved, so toggling persistence takes effect
 * without a restart.
 */
export function configureDecisionCache(options: { persist?: boolean; directory?: string }): void {
  if (options.directory) directory = options.directory;
  if (typeof options.persist === 'boolean') persist = options.persist;
  if (!loaded) {
    loaded = true;
    loadDecisionCache();
  }
}

export function loadDecisionCache(): number {
  entries.clear();
  if (!persist) return 0;
  try {
    const raw = readFileSync(decisionCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; entries?: [string, Entry][] };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return 0;
    for (const [key, entry] of parsed.entries.slice(-MAX_ENTRIES)) {
      if (typeof key === 'string' && entry && typeof entry === 'object' && entry.value) {
        entries.set(key, { at: Number(entry.at) || Date.now(), value: entry.value });
      }
    }
    return entries.size;
  } catch {
    return 0;
  }
}

function scheduleSave(): void {
  if (!persist || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDecisionCache();
  }, SAVE_DELAY_MS);
  saveTimer.unref();
}

export function saveDecisionCache(): void {
  if (!persist) return;
  try {
    mkdirSync(directory, { recursive: true });
    const body = JSON.stringify({ version: 1, entries: [...entries.entries()] });
    const target = decisionCachePath();
    writeFileSync(`${target}.tmp`, body, 'utf8');
    renameSync(`${target}.tmp`, target);
  } catch {
    // A read-only data directory must not break a decision.
  }
}

/** Is this a question rather than a command? Those depend on state and are not cached. */
export function isQuestion(utterance: string): boolean {
  return /\?\s*$|^(is|are|was|were|do|does|did|what|which|who|where|when|how|any)\b/i.test(utterance);
}

export function decisionKey(input: {
  utterance: string;
  language?: string;
  model: string;
  baseUrl: string;
  spokenFromArea?: string;
  questions: QuestionSet;
  /** Stable across catalog rebuilds: ids and rooms, never timestamps or live state. */
  homeSignature: string;
}): string {
  return sha1(
    JSON.stringify([
      input.model,
      input.baseUrl,
      input.utterance.trim().toLowerCase(),
      input.language ?? '',
      input.spokenFromArea ?? '',
      input.homeSignature,
      Object.entries(input.questions).map(([key, question]) => [key, question.type, question.instructions, question.criteria]),
    ]),
  );
}

export function cachedDecision(key: string): DecisionResponse | null {
  return entries.get(key)?.value ?? null;
}

export function rememberDecision(key: string, value: DecisionResponse): void {
  entries.delete(key);
  entries.set(key, { at: Date.now(), value });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  scheduleSave();
}

export function decisionCacheSize(): number {
  return entries.size;
}

export function clearDecisionCache(): void {
  entries.clear();
  scheduleSave();
}
