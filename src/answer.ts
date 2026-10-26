/**
 * Answers a state question from the catalog.
 *
 * Home Assistant only offers `HassGetState` when its Assist API registers it; some
 * installations do not (and the intent is not part of every setup). Rather than forward
 * "is the office light on?" to a language model — seconds of latency for one boolean — the
 * proxy already holds the state of every exposed entity, so it answers directly. The reply
 * is ordinary assistant text, which the conversation agent speaks like any other answer.
 */

import type { Catalog, CatalogEntity } from './types.js';
import { normalise } from './util.js';

/** States that read better with a word than with the raw slug. */
const READABLE: Record<string, string> = {
  not_home: 'away',
  home: 'home',
  do_not_disturb: 'on do not disturb',
  unavailable: 'unavailable',
  heat_cool: 'set to heat or cool',
  above_horizon: 'above the horizon',
  below_horizon: 'below the horizon',
};

/** States that mean "on" in the sense a person asking the question means it. */
const ACTIVE = new Set([
  'on',
  'open',
  'unlocked',
  'playing',
  'home',
  'heat',
  'cool',
  'heat_cool',
  'auto',
  'dry',
  'fan_only',
  'cleaning',
  'active',
  'detected',
  'occupied',
]);

const PLURALS: Record<string, string> = {
  light: 'lights',
  switch: 'switches',
  fan: 'fans',
  cover: 'blinds',
  lock: 'locks',
  media_player: 'media players',
  climate: 'thermostats',
  sensor: 'sensors',
  binary_sensor: 'sensors',
  vacuum: 'vacuums',
  humidifier: 'humidifiers',
  scene: 'scenes',
  script: 'scripts',
  input_boolean: 'helpers',
  device_tracker: 'people',
};

function plural(domain: string): string {
  return PLURALS[domain] ?? `${domain.replace(/_/g, ' ')}s`;
}

/** The state as a person would say it, or null when there is nothing to say. */
function statePhrase(entity: CatalogEntity): string | null {
  const raw = (entity.state ?? '').trim();
  if (!raw || raw === 'unknown') return null;
  if (raw === 'unavailable' || raw === 'unavailable ') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const unit = entity.unit ? ` ${entity.unit}` : '';
    return `${raw}${unit}`;
  }
  return READABLE[raw] ?? raw.replace(/_/g, ' ');
}

function isActive(state: string): boolean {
  return ACTIVE.has(state.trim().toLowerCase());
}

/** "Office Lights are on." / "Office Temperature is 21.5 °C." */
export function answerDeviceState(entity: CatalogEntity): string {
  const phrase = statePhrase(entity);
  if (!phrase) return `I can't read the state of the ${entity.name} right now.`;
  return `The ${entity.name} is ${phrase}.`;
}

/**
 * "Two of the six lights are on: Office Lights and Desk Lamp."
 * Returns null when there is nothing in the catalog to count, so the caller can forward.
 */
export function answerCount(catalog: Catalog, domain: string, stateWord?: string): string | null {
  const pool = domain ? catalog.entities.filter((entity) => entity.domain === domain) : catalog.entities;
  if (!pool.length) return null;

  const wanted = stateWord ? normalise(stateWord) : '';
  const matches = wanted
    ? pool.filter((entity) => {
        const state = normalise(entity.state ?? '');
        return state === wanted || state.startsWith(wanted);
      })
    : pool.filter((entity) => isActive(entity.state ?? ''));

  const things = plural(domain);
  const wantedWords = wanted ? (READABLE[stateWord!.trim().toLowerCase()] ?? wanted) : 'on';

  if (!matches.length) {
    return `None of the ${pool.length} ${things} ${wanted ? 'are' : 'is'} ${wantedWords}.`.replace(
      'are is',
      'is',
    );
  }

  const shown = matches.slice(0, 4).map((entity) => entity.name);
  const list =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  const more = matches.length > shown.length ? ` and ${matches.length - shown.length} more` : '';
  const verb = matches.length === 1 ? 'is' : 'are';

  // One thing out of one stays a plain sentence: "The Office Blind is open."
  if (pool.length === 1) return `The ${list} is ${wantedWords}.`;
  if (matches.length === pool.length) {
    return `All ${pool.length} ${things} are ${wantedWords}: ${list}${more}.`;
  }
  return `${matches.length} of the ${pool.length} ${things} ${verb} ${wantedWords}: ${list}${more}.`;
}
