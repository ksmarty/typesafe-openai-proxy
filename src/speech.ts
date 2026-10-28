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

import { ACTION_VERBS, ACTIONS, DOMAIN_LABELS } from './actions.js';
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

/** The first rule that matches this call, or null. */
export function ruleFor(rules: SpeechRule[] | undefined, call: CallDescriptor): SpeechRule | null {
  if (!rules?.length) return null;
  const candidates = descriptorsOf(call).map((value) => value.toLowerCase());
  for (const rule of rules) {
    const match = (rule.match ?? '').trim().toLowerCase();
    if (!match) continue;
    // `todo.*` matches every todo action; anything else is an exact descriptor.
    const pattern = match.endsWith('.*') ? match.slice(0, -1) : match;
    const hit = candidates.some((value) => (pattern.endsWith('.') ? value.startsWith(pattern) : value === pattern));
    if (hit) return rule;
  }
  return null;
}

/** `light.desk_lamp` -> `Desk Lamp`, so a custom sentence reads like one. */
export function humanTarget(targets: string[] | undefined): string {
  const first = targets?.[0];
  if (!first) return '';
  const tail = first.includes('.') ? first.split('.').slice(1).join('.') : first;
  return tail
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

/** Fill `{entity}` and `{action}` in a custom sentence. */
export function interpolateSpeech(
  template: string,
  values: { entity?: string; action?: string },
): string {
  return template
    .replace(/\{entity\}/gi, values.entity ?? '')
    .replace(/\{action\}/gi, values.action ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when this call should produce no speech at all. */
export function isSilentCall(rules: SpeechRule[] | undefined, call: CallDescriptor): boolean {
  return ruleMode(rules, call) === 'silent';
}

/** One plausible entity per domain, so a preview reads like a real reply. */
const SAMPLE_ENTITY: Record<string, string> = {
  light: 'light.desk_lamp',
  switch: 'switch.coffee_machine',
  fan: 'fan.bedroom',
  cover: 'cover.office_blind',
  lock: 'lock.front_door',
  climate: 'climate.office',
  media_player: 'media_player.living_room',
  vacuum: 'vacuum.robot',
  todo: 'todo.shopping_list',
  scene: 'scene.movie_night',
  humidifier: 'humidifier.bedroom',
  water_heater: 'water_heater.boiler',
  script: 'script.goodnight',
  button: 'button.doorbell',
  input_boolean: 'input_boolean.guest_mode',
};

/**
 * The domain and action a rule most likely means, for the preview only.
 *
 * A rule can be written five ways, so this walks them: an intent name is resolved through the
 * action table (which knows every intentHome Assistant offers), `domain.action` is split, a
 * `domain.*` or bare domain takes the first action that domain has, and a bare action takes the
 * first domain that has it.
 */
export function samplePairFor(match: string): { domain: string; action: string } {
  const text = (match ?? '').trim();
  const entries = Object.keys(ACTIONS).map((key) => {
    const [domain, action] = key.split(':');
    return { domain: domain ?? '', action: action ?? '' };
  });
  const fallback = { domain: 'light', action: 'turn_on' };
  if (!text) return fallback;

  const byIntent = Object.entries(ACTIONS).find(([, spec]) => spec.intentType === text);
  if (byIntent) {
    const [domain, action] = byIntent[0].split(':');
    return { domain: domain ?? 'light', action: action ?? 'turn_on' };
  }
  if (text.endsWith('.*')) {
    const domain = text.slice(0, -2).toLowerCase();
    const first = entries.find((entry) => entry.domain === domain);
    return first ? { domain, action: first.action } : fallback;
  }
  if (text.includes('.')) {
    const [rawDomain, rawAction] = text.split('.');
    const wantDomain = (rawDomain ?? 'light').toLowerCase();
    const wantAction = (rawAction ?? 'turn_on').toLowerCase();
    if (ACTIONS[`${wantDomain}:${wantAction}`]) return { domain: wantDomain, action: wantAction };
    // A domain with an action it does not have (a typo, or "todo.add" for "todo.add_item").
    const first = entries.find((entry) => entry.domain === wantDomain);
    return first ? { domain: wantDomain, action: first.action } : fallback;
  }
  const domain = text.toLowerCase();
  if (DOMAIN_LABELS[domain]) {
    const first = entries.find((entry) => entry.domain === domain);
    return first ? { domain, action: first.action } : fallback;
  }
  const action = domain;
  const first = entries.find((entry) => entry.action === action);
  return first ? { domain: first.domain, action } : fallback;
}

/** What a custom sentence would say for a plausible call — shown under the field as a preview. */
export function previewForRule(rule: SpeechRule): string {
  if (rule.mode !== 'custom') return '';
  const { domain, action } = samplePairFor(rule.match);
  return interpolateSpeech(rule.say ?? '', {
    action: ACTION_VERBS[action] ?? action.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    entity: humanTarget([SAMPLE_ENTITY[domain] ?? `${domain}.example`]),
  });
}
