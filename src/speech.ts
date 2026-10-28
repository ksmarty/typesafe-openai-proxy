/**
 * What to say after a call, per call.
 *
 * A house is not uniform: "turn on the lights" wants no reply, "add milk to the shopping list"
 * does, and a lock wants confirmation spoken. `speech.afterTool` was one answer for all of it,
 * so this adds ordered rules that decide per call.
 *
 * A rule matches the call's intent name (`HassTurnOn`), its `domain.action` (`todo.add`), its
 * domain (`light`) or its action (`turn_on`), case-insensitively, as a whole token or as a
 * prefix ending in `.`. The first matching rule wins; with no match the `speech.afterTool`
 * default applies.
 */

import type { SpeechRule } from './config.js';

export interface CallDescriptor {
  tool?: string;
  domain?: string;
  action?: string;
}

/** Everything a rule can be written against, most specific first. */
export function descriptorsOf(call: CallDescriptor): string[] {
  const out: string[] = [];
  if (call.tool) out.push(call.tool);
  if (call.domain && call.action) out.push(`${call.domain}.${call.action}`);
  if (call.domain) out.push(call.domain);
  if (call.action) out.push(call.action);
  return out;
}

/**
 * 'silent' when a rule says so, 'speak' when a rule says so, null when no rule matched (the
 * caller then uses its default mode).
 */
export function ruleMode(rules: SpeechRule[] | undefined, call: CallDescriptor): 'speak' | 'silent' | null {
  if (!rules?.length) return null;
  const candidates = descriptorsOf(call).map((value) => value.toLowerCase());
  for (const rule of rules) {
    const match = (rule.match ?? '').trim().toLowerCase();
    if (!match) continue;
    // `todo.*` matches every todo action; anything else is an exact descriptor.
    const pattern = match.endsWith('.*') ? match.slice(0, -1) : match;
    const hit = candidates.some((value) => (pattern.endsWith('.') ? value.startsWith(pattern) : value === pattern));
    if (hit) return rule.mode === 'silent' ? 'silent' : 'speak';
  }
  return null;
}

/** True when this call should produce no speech at all. */
export function isSilentCall(rules: SpeechRule[] | undefined, call: CallDescriptor): boolean {
  return ruleMode(rules, call) === 'silent';
}
