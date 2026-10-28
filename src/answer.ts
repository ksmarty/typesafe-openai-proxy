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

/** "is", "are", "was", "were" — the shape of a yes/no question about one thing. */
const STATE_LEAD = /^(is|are|was|were|tell me if|check if|do you know if|has|have)\s+/;

/** The words a speaker uses to ask about a state rather than give an order. */
const STATE_TAIL = /\b(on|off|open|closed|locked|unlocked|running|playing|paused|home|away)\b/;

/**
 * A plain yes/no question about one device, answered from the catalogue instead of the
 * decision model.
 *
 * "Is the desk lamp on?" needs no model: the sentence names the device and the state, and the
 * catalogue already holds that state. This is the single most common query in a voice
 * assistant, so skipping the round trip takes it from ~400 ms to a couple of milliseconds.
 * Anything it cannot read with certainty returns null and takes the normal path.
 */
export function directStatePlan(
  catalog: Catalog,
  text: string,
): { text: string; entity: CatalogEntity } | null {
  const spoken = normalise(text);
  if (!spoken) return null;
  if (!STATE_LEAD.test(spoken)) return null;

  const body = spoken.replace(STATE_LEAD, '').replace(/[?.!]+$/, '').trim();
  if (!body) return null;

  const tail = STATE_TAIL.exec(body);
  if (!tail) return null;
  const asked = tail[1] ?? '';

  // The device has to be named outright and only once, or the choice is a guess.
  const named = catalog.entities
    .filter((entity) => {
      const name = normalise(entity.name);
      return name.length > 2 && ` ${body} `.includes(` ${name} `);
    })
    .sort((left, right) => right.name.length - left.name.length);
  if (named.length !== 1) return null;

  const entity = named[0]!;
  // "is the office light on" where the light is a dimmer: the answer is the state, not a guess.
  const phrase = statePhrase(entity);
  if (!phrase) return null;
  if (asked === 'on' || asked === 'off' || asked === 'open' || asked === 'closed') {
    // The question fixes the polarity; answering "on" to "is it off" would be a trap.
    return { text: answerDeviceState(entity), entity };
  }
  return { text: `The ${entity.name} is ${phrase}.`, entity };
}
