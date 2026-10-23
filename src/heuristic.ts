/**
 * The built-in heuristic decision backend.
 *
 * It produces the *same typed answers* a System One model does, so the router, the
 * gates and the tool mapping are exercised identically - but it is a keyword matcher,
 * not a calibrated model. It exists so the proxy is demoable, testable and usable
 * before a decision server is configured. Scores become probabilities through a
 * softmax, which means an unclear utterance lands near-uniform and fails the same
 * confidence gates a real model would fail, and is forwarded upstream.
 */

import type { DecisionResponse, Answer, ChoiceAnswer, QuestionSet } from './types.js';
import type { DecideInput } from './systemone.js';
import type { BuiltQuestions } from './questions.js';
import { Q, NO_AREA, NO_SINGLE_ENTITY, NO_DOMAIN, NOT_TARGETED, actionQuestion } from './questions.js';
import { extract, extractListItem, extractMediaQuery } from './extract.js';
import type { CatalogEntity } from './types.js';
import { normalise, round } from './util.js';

export interface HeuristicInput extends DecideInput {
  built: BuiltQuestions;
}

const TEMPERATURE = 3.5;

function softmax(scores: Record<string, number>): Record<string, number> {
  const entries = Object.entries(scores);
  if (entries.length === 0) return {};
  const max = Math.max(...entries.map(([, score]) => score * TEMPERATURE));
  const exps = entries.map(([key, score]) => [key, Math.exp(score * TEMPERATURE - max)] as const);
  const total = exps.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(exps.map(([key, value]) => [key, round(value / total, 4)]));
}

function choose(scores: Record<string, number>): ChoiceAnswer {
  const probabilities = softmax(scores);
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const [top] = ranked[0] ?? ['', 0];
  return {
    type: 'choice',
    choice: top,
    probabilities,
    confidence: ranked[0]?.[1] ?? 0,
  };
}

function noul(value: number): Answer {
  return { type: 'noul', noul: round(Math.max(0, Math.min(1, value)), 3) };
}

function has(text: string, pattern: RegExp | string): boolean {
  if (pattern instanceof RegExp) return pattern.test(text);
  // Callers pass the utterance already wrapped in spaces, so this is a whole-word match.
  return text.includes(` ${pattern} `);
}

function countMatches(text: string, words: string[]): number {
  return words.reduce((count, word) => (has(text, word) ? count + 1 : count), 0);
}

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  light: ['light', 'lights', 'lamp', 'lamps', 'bulb', 'bulbs', 'brightness', 'dim', 'dimmer', 'brighter', 'illuminate'],
  switch: ['plug', 'socket', 'coffee maker', 'kettle', 'heater', 'dishwasher', 'appliance', 'outlet', 'switch'],
  cover: ['blind', 'blinds', 'curtain', 'curtains', 'shade', 'shades', 'shutter', 'shutters', 'garage', 'gate', 'awning', 'awning open'],
  lock: ['lock', 'locks', 'locked', 'unlock', 'unlocked', 'deadbolt', 'door lock'],
  fan: ['fan', 'fans', 'ceiling fan'],
  climate: ['thermostat', 'heating', 'heat', 'ac', 'air conditioning', 'radiator', 'degrees', 'warm', 'cool', 'temperature'],
  media_player: ['speaker', 'speakers', 'tv', 'television', 'music', 'volume', 'sonos', 'radio', 'play', 'pause', 'song', 'track'],
  scene: ['scene', 'mood'],
  script: ['script', 'routine'],
  vacuum: ['vacuum', 'roomba', 'robot vacuum'],
  humidifier: ['humidifier', 'dehumidifier', 'humidity'],
  water_heater: ['boiler', 'water heater'],
  button: ['button'],
  todo: ['shopping list', 'todo list', 'to do list', 'list'],
};

const ACTION_KEYWORDS: Record<string, Record<string, string[]>> = {
  light: {
    turn_on: ['turn on', 'switch on', 'put on', 'lights on', 'light on', 'enable'],
    turn_off: ['turn off', 'switch off', 'shut off', 'lights off', 'light off', 'kill'],
    toggle: ['toggle', 'flip'],
    brighter: ['brighter', 'brighten', 'turn it up', 'more light', 'more brightness'],
    dimmer: ['dimmer', 'dim', 'turn it down', 'less light', 'lower the brightness'],
    set_brightness: ['brightness', 'percent', 'to \d+', 'set the light'],
    set_color: ['color', 'colour', 'red', 'blue', 'green', 'warm white', 'cool white', 'orange', 'purple', 'pink'],
  },
  switch: {
    turn_on: ['turn on', 'switch on', 'start the', 'power on'],
    turn_off: ['turn off', 'switch off', 'stop the', 'power off'],
    toggle: ['toggle', 'flip'],
  },
  cover: {
    open: ['open', 'raise', 'lift', 'draw back', 'up'],
    close: ['close', 'lower', 'shut', 'draw'],
    stop: ['stop', 'halt', 'freeze'],
    set_position: ['position', 'percent', 'halfway', 'to \d+'],
  },
  lock: { lock: ['lock', 'secure', 'bolt'], unlock: ['unlock', 'open the door', 'let me in'] },
  fan: {
    turn_on: ['turn on', 'switch on', 'start'],
    turn_off: ['turn off', 'switch off', 'stop'],
    faster: ['faster', 'speed up', 'turn it up'],
    slower: ['slower', 'slow down', 'turn it down'],
    set_speed: ['speed', 'percent', 'to \d+'],
  },
  climate: {
    turn_on: ['turn on', 'switch on'],
    turn_off: ['turn off', 'switch off'],
    warmer: ['warmer', 'heat up', 'turn it up', 'hotter'],
    cooler: ['cooler', 'cool down', 'turn it down', 'colder'],
    set_temperature: ['set the temperature', 'to \d+', 'degrees', 'thermostat to'],
  },
  media_player: {
    play: ['play', 'resume', 'continue', 'start the music'],
    pause: ['pause', 'stop the music', 'hold on'],
    next: ['next track', 'skip', 'next song'],
    previous: ['previous track', 'go back', 'previous song'],
    louder: ['louder', 'volume up', 'turn it up'],
    quieter: ['quieter', 'volume down', 'turn it down'],
    set_volume: ['volume', 'percent', 'to \d+'],
    mute: ['mute', 'silence'],
    unmute: ['unmute', 'unsilence'],
    search_and_play: ['play some', 'play the song', 'play the album', 'stream'],
  },
  scene: { activate: ['activate', 'apply', 'set the scene', 'turn on'] },
  script: { run: ['run', 'start', 'trigger'] },
  vacuum: {
    start: ['start', 'clean', 'vacuum', 'go'],
    return_to_base: ['dock', 'return to base', 'go home', 'charge'],
    clean_area: ['clean the', 'clean in'],
  },
  humidifier: {
    turn_on: ['turn on', 'switch on'],
    turn_off: ['turn off', 'switch off'],
    set_humidity: ['humidity', 'percent', 'to \d+'],
    set_mode: ['mode', 'auto', 'sleep'],
  },
  water_heater: { turn_on: ['turn on', 'switch on'], turn_off: ['turn off', 'switch off'] },
  button: { press: ['press', 'push', 'trigger'] },
  input_boolean: { turn_on: ['turn on', 'switch on'], turn_off: ['turn off', 'switch off'], toggle: ['toggle', 'flip'] },
  todo: {
    add_item: ['add', 'put', 'append'],
    complete_item: ['mark', 'check off', 'done', 'complete', 'bought'],
    remove_item: ['remove', 'delete', 'take off'],
  },
};

const COMMAND_WORDS = [
  'turn on', 'turn off', 'switch on', 'switch off', 'put on', 'shut off', 'open', 'close', 'lock', 'unlock',
  'dim', 'brighten', 'brighter', 'dimmer', 'set', 'play', 'pause', 'resume', 'mute', 'unmute', 'start', 'stop',
  'vacuum', 'clean', 'press', 'run', 'activate', 'toggle', 'increase', 'decrease', 'raise', 'lower', 'skip',
];

const QUERY_WORDS = [
  'is', 'are', 'was', 'were', 'what', "what's", 'whats', 'how many', 'any', 'does', 'do', 'which', 'where',
  'status', 'how warm', 'how bright', 'how loud', 'who', 'when', 'temperature',
];

const INFORMATION_WORDS = ['explain', 'why', 'how does', 'history of', 'tell me about', 'joke', 'story', 'capital', 'meaning'];
const CANCEL_WORDS = ['never mind', 'nevermind', 'cancel', 'forget it', 'no thanks', 'ignore that', 'stop it'];

function scoreEntity(text: string, entity: CatalogEntity, domainHint?: string): number {
  const name = normalise(entity.name);
  if (!name) return 0;
  let score = 0;
  if (text.includes(` ${name} `)) score += 1;
  const tokens = name.split(' ').filter((token) => token.length > 2);
  if (tokens.length > 0) {
    const hit = tokens.filter((token) => text.includes(` ${token} `)).length;
    score += (hit / tokens.length) * 0.7;
    if (hit === tokens.length) score += 0.2;
  }
  if (entity.areaName) {
    const area = normalise(entity.areaName);
    if (area && text.includes(` ${area} `)) score += 0.35;
  }
  const synonyms = DOMAIN_KEYWORDS[entity.domain] ?? [];
  if (synonyms.some((word) => text.includes(` ${word} `))) score += 0.15;
  if (domainHint && entity.domain !== domainHint) score -= 0.4;
  return Math.max(0, score);
}

export function heuristicDecide(input: HeuristicInput): DecisionResponse {
  const started = Date.now();
  const text = ` ${normalise(input.utterance)} `;
  const raw = input.utterance;
  const extraction = extract(raw, {
    entityNames: input.catalog.entities.map((entity) => entity.name),
  });
  const answers: Record<string, Answer> = {};
  const questions: QuestionSet = input.questions;
  const { built, catalog } = input;
  const item = extractListItem(raw);

  // --- category ------------------------------------------------------------
  if (questions[Q.category]) {
    const command = countMatches(text, COMMAND_WORDS);
    const query = countMatches(text, QUERY_WORDS);
    const information = countMatches(text, INFORMATION_WORDS);
    const cancel = countMatches(text, CANCEL_WORDS);
    const startsQuestion = /^\s*(is|are|was|were|what|how|which|where|who|when|do|does|can|did)\b/i.test(raw);
    answers[Q.category] = choose({
      command: command === 0 ? 0 : Math.min(1, 0.35 + command * 0.22),
      query: (query === 0 ? 0 : Math.min(1, 0.25 + query * 0.18)) + (startsQuestion ? 0.25 : 0),
      information: information === 0 ? 0 : Math.min(1, 0.3 + information * 0.3),
      cancel: cancel === 0 ? 0 : Math.min(1, 0.5 + cancel * 0.3),
      unclear: command + query + information + cancel === 0 ? 0.5 : 0.05,
    });
  }

  // --- compound ------------------------------------------------------------
  if (questions[Q.compound]) {
    const verbs = COMMAND_WORDS.filter((word) => text.includes(` ${word} `)).length;
    const conjunction = /\band\b|\bthen\b/i.test(raw);
    answers[Q.compound] = noul(verbs >= 2 && conjunction ? 0.8 : verbs >= 2 ? 0.55 : 0.05);
  }

  // --- scope ---------------------------------------------------------------
  const areaMatches = catalog.areas.filter((area) => {
    const name = normalise(area.name);
    return name.length > 2 && text.includes(` ${name} `);
  });
  const area = areaMatches[0];
  const domainsPresent = catalog.domains;
  const domainScores: Record<string, number> = {};
  for (const domain of domainsPresent) {
    const keywords = DOMAIN_KEYWORDS[domain] ?? [];
    const hits = keywords.filter((word) => text.includes(` ${word} `) || text.includes(` ${word}s `)).length;
    domainScores[domain] = hits === 0 ? 0 : Math.min(1, 0.4 + hits * 0.25);
  }
  const rankedDomains = Object.entries(domainScores).sort((a, b) => b[1] - a[1]);
  const domainHint = rankedDomains[0] && rankedDomains[0][1] > 0 ? rankedDomains[0][0] : undefined;

  const entityScores = catalog.entities.map((entity) => ({
    entity,
    score: scoreEntity(text, entity, domainHint),
  }));
  entityScores.sort((a, b) => b.score - a.score);
  const best = entityScores[0];
  const namedEntity = best && best.score >= 0.55 ? best.entity : undefined;

  if (questions[Q.scope]) {
    const allWords = countMatches(text, ['all', 'every', 'everything', 'everywhere', 'whole house', 'entire house']);
    const floorWords = catalog.areas.some((candidate) => candidate.floor && text.includes(` ${normalise(candidate.floor)} `));
    answers[Q.scope] = choose({
      whole_house: allWords > 0 ? Math.min(1, 0.5 + allWords * 0.3) : 0,
      floor: floorWords ? 0.7 : 0,
      area: area ? 0.8 : 0,
      single: namedEntity ? 0.85 : domainHint ? 0.35 : 0,
      not_a_target: 0.05,
    });
  }

  // --- here_relative -------------------------------------------------------
  if (questions[Q.hereRelative]) {
    const here = /\bhere\b|\bthis room\b|\bin here\b/i.test(raw);
    answers[Q.hereRelative] = noul(here ? 0.85 : 0.05);
  }

  // --- target_area ---------------------------------------------------------
  if (questions[Q.targetArea]) {
    const scores: Record<string, number> = {};
    for (const [optionId, optionArea] of built.areaOptions) {
      const name = normalise(optionArea.name);
      scores[optionId] = name && text.includes(` ${name} `) ? 0.9 : 0;
    }
    scores[NO_AREA] = area ? 0.02 : 0.6;
    answers[Q.targetArea] = choose(scores);
  }

  // --- target_entity -------------------------------------------------------
  if (questions[Q.targetEntity]) {
    const scores: Record<string, number> = {};
    for (const [optionId, entity] of built.entityOptions) {
      scores[optionId] = scoreEntity(text, entity, domainHint);
    }
    scores[NO_SINGLE_ENTITY] = namedEntity ? 0.05 : 0.55;
    answers[Q.targetEntity] = choose(scores);
  }

  // --- target_domain -------------------------------------------------------
  if (questions[Q.targetDomain]) {
    const scores: Record<string, number> = {};
    for (const domain of domainsPresent) scores[domain] = domainScores[domain] ?? 0;
    if (scores[NO_DOMAIN] === undefined) scores[NO_DOMAIN] = routeScoreDomainless(text) ? 0.02 : 0.5;
    answers[Q.targetDomain] = choose(scores);
  }

  // --- query_kind ----------------------------------------------------------
  if (questions[Q.queryKind]) {
    const timeWords = countMatches(text, ['time', 'clock', 'date', 'today', 'day is it']);
    const countWords = countMatches(text, ['how many', 'any', 'all of them']);
    const temperatureWords = countMatches(text, ['temperature', 'how warm', 'how cold', 'degrees']);
    answers[Q.queryKind] = choose({
      device_state: namedEntity ? 0.8 : domainHint ? 0.35 : 0,
      count: countWords ? 0.75 : 0,
      temperature: temperatureWords ? 0.8 : 0,
      time_or_date: timeWords ? 0.85 : 0,
      needs_prose: 0.05,
      not_a_query: 0.05,
    });
  }

  // --- risky ---------------------------------------------------------------
  if (questions[Q.risky]) {
    const risky =
      /\bunlock\b|\bdisarm\b|\bopen the (garage|gate|front door|back door|window)\b|\bgarage door\b.*\bopen\b/i.test(raw);
    answers[Q.risky] = noul(risky ? 0.9 : 0.05);
  }

  // --- change_direction / magnitude ---------------------------------------
  if (questions[Q.changeDirection]) {
    const absolute = extraction.percent !== undefined || extraction.number !== undefined;
    const increase = countMatches(text, ['brighter', 'brighten', 'warmer', 'louder', 'faster', 'more', 'up', 'increase', 'raise']);
    const decrease = countMatches(text, ['dimmer', 'cooler', 'quieter', 'slower', 'less', 'down', 'decrease', 'lower']);
    answers[Q.changeDirection] = choose({
      absolute: absolute ? 0.9 : 0,
      increase: increase ? Math.min(1, 0.5 + increase * 0.2) : 0,
      decrease: decrease ? Math.min(1, 0.5 + decrease * 0.2) : 0,
      no_numeric: absolute || increase || decrease ? 0.05 : 0.6,
    });
  }

  if (questions[Q.magnitude]) {
    answers[Q.magnitude] = choose({
      slight: extraction.magnitude === 'slight' ? 0.9 : 0,
      moderate: extraction.magnitude === 'moderate' ? 0.8 : 0.3,
      large: extraction.magnitude === 'large' ? 0.9 : 0,
      maximum: extraction.magnitude === 'maximum' ? 0.9 : 0,
      not_applicable: 0.4,
    });
  }

  // --- per-domain action questions ----------------------------------------
  for (const domain of built.actionDomains) {
    const key = actionQuestion(domain);
    if (!questions[key]) continue;
    const keywordTable = ACTION_KEYWORDS[domain] ?? {};
    const scores: Record<string, number> = {};
    for (const [action, words] of Object.entries(keywordTable)) {
      if (!questions[key]!.criteria[action]) continue;
      const hits = countMatches(text, words);
      scores[action] = hits === 0 ? 0 : Math.min(1, 0.45 + hits * 0.25);
    }
    if (questionHas(questions[key]!, NOT_TARGETED)) {
      const targeted = namedEntity?.domain === domain || domainHint === domain;
      scores[NOT_TARGETED] = targeted ? 0.02 : 0.45;
    }
    if (Object.keys(scores).length > 0) answers[key] = choose(scores);
  }

  // --- value_pick ----------------------------------------------------------
  if (questions[Q.valuePick]) {
    const scores: Record<string, number> = {};
    for (const candidate of extraction.candidates) {
      if (!questions[Q.valuePick]!.criteria[candidate.id]) continue;
      scores[candidate.id] = text.includes(normalise(candidate.text)) ? 0.85 : 0.05;
    }
    if (questions[Q.valuePick]!.criteria.none) scores.none = extraction.candidates.length > 0 ? 0.1 : 0.6;
    if (Object.keys(scores).length > 0) answers[Q.valuePick] = choose(scores);
  }

  // Free-text slots the heuristic can fill directly.
  if (item) answers.listItem = { type: 'choice', choice: 'item', probabilities: { item: 1 }, confidence: 1 };
  const media = extractMediaQuery(raw, catalog.entities.map((entity) => entity.name));
  if (media) answers.mediaQuery = { type: 'choice', choice: 'query', probabilities: { query: 1 }, confidence: 1 };

  return {
    model: 'heuristic',
    answers,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Date.now() - started,
    backend: 'heuristic',
  };
}

function questionHas(question: { criteria: Record<string, string> }, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(question.criteria, key);
}

function routeScoreDomainless(text: string): boolean {
  return /\bhome\b|\bhouse\b/.test(text);
}
