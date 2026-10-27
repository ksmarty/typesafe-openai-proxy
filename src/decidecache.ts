/**
 * Decisions that were already made.
 *
 * Most voice traffic is repetition: the same sentence, minutes apart, against the same house.
 * A cached answer saves the whole model round trip (300–900 ms and several thousand tokens),
 * which is by far the largest cost in a turn once the catalog is small.
 *
 * Two things keep it honest:
 *  - the key covers the sentence, the language, the default area, the question set and the
 *    model, so a different request or a changed house is a miss;
 *  - questions are never cached, because their answer depends on live entity state.
 */

import type { DecisionResponse, QuestionSet } from './types.js';
import { sha1 } from './util.js';

interface Entry {
  at: number;
  value: DecisionResponse;
}

const MAX_ENTRIES = 200;
const entries = new Map<string, Entry>();

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

export function cachedDecision(key: string, ttlMs: number): DecisionResponse | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    entries.delete(key);
    return null;
  }
  return hit.value;
}

export function rememberDecision(key: string, value: DecisionResponse): void {
  entries.delete(key);
  entries.set(key, { at: Date.now(), value });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

export function decisionCacheSize(): number {
  return entries.size;
}

export function clearDecisionCache(): void {
  entries.clear();
}
