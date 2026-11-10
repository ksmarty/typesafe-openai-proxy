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
import { DEFAULT_TEMPLATES, type SpeechTemplates } from './config.js';
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

/** The slots a state answer is composed from. */
export type StateSpeech = Pick<SpeechTemplates, 'yes' | 'no' | 'state' | 'unknown'>;

/** What a template says with its placeholders filled, as one clean sentence. */
function sentence(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The template for a slot, or the English default when the language leaves it empty. */
function slot(templates: StateSpeech | undefined, key: keyof StateSpeech): string {
  const chosen = templates?.[key]?.trim();
  return chosen || DEFAULT_TEMPLATES.en![key];
}

/**
 * The opposite of a state word, where a yes/no question about it has one. "Is it locked?"
 * answered from a state of `unlocked` is a no; without a pairing the entity simply cannot
 * answer that question, and the caller says the state instead.
 */
const OPPOSITE: Record<string, string> = {
  on: 'off',
  off: 'on',
  open: 'closed',
  closed: 'open',
  locked: 'unlocked',
  unlocked: 'locked',
  playing: 'paused',
  paused: 'playing',
  running: 'stopped',
  stopped: 'running',
  home: 'away',
  away: 'home',
  detected: 'clear',
  clear: 'detected',
};

/** States that plainly mean "not on", so "is it on?" can be answered with a no. */
const INACTIVE = new Set([
  'off',
  'standby',
  'closed',
  'idle',
  'paused',
  'stopped',
  'not_home',
  'away',
  'clear',
  'disconnected',
]);

function isActive(state: string): boolean {
  return ACTIVE.has(state.trim().toLowerCase());
}

/**
 * Whether the state that was asked about holds, or null when this entity cannot answer
 * that question at all — a door sensor cannot say whether the door is locked.
 */
function holds(entity: CatalogEntity, asked: string): boolean | null {
  const state = normalise(entity.state ?? '');
  if (!state || state === 'unknown' || state === 'unavailable') return null;
  if (state === asked) return true;
  if (state === OPPOSITE[asked]) return false;
  if (asked === 'on') return isActive(state) ? true : INACTIVE.has(state) ? false : null;
  if (asked === 'off') return isActive(state) ? false : INACTIVE.has(state) ? true : null;
  return null;
}

/** "Office Lights are on." / "Office Temperature is 21.5 °C." */
export function answerDeviceState(entity: CatalogEntity, templates?: StateSpeech): string {
  const phrase = statePhrase(entity);
  if (!phrase) return sentence(slot(templates, 'unknown'), { entity: entity.name });
  return sentence(slot(templates, 'state'), { entity: entity.name, state: phrase });
}

/**
 * "Yes, it's locked." / "No, it's not locked."
 *
 * Returns null when the state asked about is not one the entity reports, so the caller falls
 * back to saying the state plainly rather than inventing a yes or a no.
 */
export function answerPolarity(
  entity: CatalogEntity,
  asked: string,
  templates?: StateSpeech,
): string | null {
  const word = normalise(asked);
  const holdsNow = holds(entity, word);
  if (holdsNow === null) return null;
  const phrase = statePhrase(entity);
  if (!phrase) return null;
  return sentence(slot(templates, holdsNow ? 'yes' : 'no'), {
    entity: entity.name,
    // `{state}` is the word that was asked, so "is it off?" is answered "No, it's not off."
    state: word,
    actual: phrase,
  });
}

/**
 * The sentence that answers a state question about one entity: a yes or a no when the
 * question asked for one and the entity reports that state, otherwise the state itself.
 */
export function answerStateQuestion(
  entity: CatalogEntity,
  text: string,
  templates?: StateSpeech,
): string {
  const asked = STATE_TAIL.exec(normalise(text))?.[1] ?? '';
  const polar = asked ? answerPolarity(entity, asked, templates) : null;
  return polar ?? answerDeviceState(entity, templates);
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

/** Every name Home Assistant answers to for one entity, the way it would be spoken. */
function spokenNames(entity: CatalogEntity): string[] {
  return [entity.name, ...(entity.aliases ?? [])]
    .map((name) => normalise(name))
    .filter((name) => name.length > 2);
}

/**
 * A plain yes/no question about one device, answered from the catalogue instead of the
 * decision model.
 *
 * "Is the desk lamp on?" needs no model: the sentence names the device and the state, and the
 * catalogue already holds that state. This is the single most common query in a voice
 * assistant, so skipping the round trip takes it from ~400 ms to a couple of milliseconds.
 * Anything it cannot read with certainty returns null and takes the normal path.
 *
 * The answer is the yes or no that was asked for — "Yes, it's on." — with the templates the
 * config carries, so an installation can word it however it likes.
 */
export function directStatePlan(
  catalog: Catalog,
  text: string,
  templates?: StateSpeech,
): { text: string; entity: CatalogEntity } | null {
  const spoken = normalise(text);
  if (!spoken) return null;
  if (!STATE_LEAD.test(spoken)) return null;

  const body = spoken.replace(STATE_LEAD, '').replace(/[?¿.!。？]+$/, '').trim();
  if (!body) return null;

  const tail = STATE_TAIL.exec(body);
  if (!tail) return null;
  const asked = tail[1] ?? '';

  // The device has to be named outright, and when two names both fit the longer one wins
  // ("kitchen light" over "light") — that is how people mean it. Two entities whose names
  // fit equally well are a guess, so the sentence takes the normal path.
  const hits = catalog.entities
    .flatMap((entity) =>
      spokenNames(entity)
        .filter((name) => ` ${body} `.includes(` ${name} `))
        .map((name) => ({ entity, name })),
    )
    .sort((left, right) => right.name.length - left.name.length);

  let entity: CatalogEntity | undefined;
  if (hits.length) {
    const longest = hits[0]!.name.length;
    const equally = hits.filter((hit) => hit.name.length === longest);
    if (new Set(equally.map((hit) => hit.entity.id)).size !== 1) return null;
    entity = hits[0]!.entity;
  } else {
    // "the door" for "Door Sensor": the sentence names part of the entity rather than all of
    // it. Only taken when that entity reports the state that was asked, so a door sensor is
    // never made to answer "is the door locked?" — a lock, or an entity aliased "door", is.
    const subject = body
      .replace(new RegExp(`\\b${asked}\\b`, 'g'), ' ')
      .replace(/^(the|a|an|my|our|your)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject.length <= 2) return null;
    const able = catalog.entities.filter(
      (candidate) =>
        spokenNames(candidate).some((name) => ` ${name} `.includes(` ${subject} `)) &&
        holds(candidate, asked) !== null,
    );
    if (able.length !== 1) return null;
    entity = able[0]!;
  }

  // The state has to be readable at all: with nothing to report the model may know better.
  if (!statePhrase(entity)) return null;
  return { text: answerStateQuestion(entity, spoken, templates), entity };
}
