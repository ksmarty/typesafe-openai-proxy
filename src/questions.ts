/**
 * The question set sent with every decision request.
 *
 * One request asks everything at once - category, scope, target, action, values -
 * and each question is answered independently against shared state, so a single
 * forward pass yields a fully typed plan. Ids and criteria text are ported from the
 * reference implementation so a model calibrated on it behaves the same here.
 */

import { ACTION_LABELS, DOMAIN_LABELS, actionsForDomain } from './actions.js';
import type { Catalog, CatalogEntity, Question, QuestionSet } from './types.js';
import type { Extraction } from './extract.js';

export const Q = {
  category: 'category',
  compound: 'compound',
  scope: 'scope',
  hereRelative: 'here_relative',
  queryKind: 'query_kind',
  risky: 'risky',
  changeDirection: 'change_direction',
  magnitude: 'magnitude',
  targetArea: 'target_area',
  targetEntity: 'target_entity',
  targetDomain: 'target_domain',
  valuePick: 'value_pick',
} as const;

export const actionQuestion = (domain: string): string => `action_${domain}`;

export const NO_AREA = 'no_area';
export const NO_SINGLE_ENTITY = 'no_single_entity';
export const NO_DOMAIN = 'none';
export const NOT_TARGETED = 'not_targeted';

export const STATIC_QUESTIONS: QuestionSet = {
  [Q.category]: {
    type: 'choice',
    instructions:
      'What kind of request is `request.text`? Judge the request as a whole, not the individual words.',
    criteria: {
      command: 'Asks for something in the home to be changed: on, off, open, close, lock, dim, set, play, start.',
      query:
        'Asks for the current state of the home, read back: whether something is on, what a temperature is, how many are open, what time it is.',
      information: 'Asks for knowledge or explanation that is not a reading of the home.',
      cancel: 'Withdraws or cancels what was just asked for, with nothing new requested.',
      unclear: 'Too vague or incomplete to tell what is wanted, or not addressed to the home at all.',
    },
  },
  [Q.compound]: {
    type: 'noul',
    instructions:
      'Does `request.text` ask for more than one thing to be done - several commands, or a command plus a question, that a single action cannot satisfy?',
    criteria: {
      true: "Two or more separate things: 'turn off the lights and lock the door', 'dim the kitchen and play music'.",
      false: 'One thing, however many rooms or devices it covers: the whole house, every light, both blinds in one room.',
    },
  },
  [Q.scope]: {
    type: 'choice',
    instructions:
      'How wide is the target of `request.text`? Use `request.spoken_from_area` for "here" only when no room is named.',
    criteria: {
      whole_house: "Everything of some kind, everywhere in the home: 'all the lights', 'turn everything off', 'lock up the house'.",
      floor: "Everything of some kind on one floor or level: 'the lights upstairs', 'close the blinds downstairs'.",
      area: "Everything of some kind in one room or area: 'the kitchen lights', 'turn off the bedroom'.",
      single: 'One specific device, either named outright or made obvious by the context.',
      not_a_target: 'Nothing in the home is being targeted at all.',
    },
  },
  [Q.hereRelative]: {
    type: 'noul',
    instructions:
      "Does `request.text` depend on where the speaker is standing rather than naming a room? The speaker is in the area named by `request.spoken_from_area`.",
    criteria: {
      true: "Uses 'here', 'in this room', 'in here', or refers to 'the lights' or 'the fan' with no room named, so only the speaker's own room makes sense.",
      false: 'Names a room, a floor, the whole house, or one specific device unambiguously.',
    },
  },
  [Q.changeDirection]: {
    type: 'choice',
    instructions:
      'If `request.text` changes a numeric setting - brightness, temperature, volume, openness, speed or humidity - does it name a specific target value, or only a direction to move in?',
    criteria: {
      absolute: "A specific value is named or clearly implied: 'to 30 percent', 'to 21 degrees', 'halfway', 'all the way open'.",
      increase: "Only more, with no value: brighter, warmer, louder, faster, open it more, turn it up.",
      decrease: 'Only less, with no value: dimmer, cooler, quieter, slower, close it a bit, turn it down.',
      no_numeric: 'No numeric setting is involved in the request.',
    },
  },
  [Q.magnitude]: {
    type: 'choice',
    instructions:
      'If `request.text` asks for a relative change without naming a value, how large a change does the user mean?',
    criteria: {
      slight: "'a bit', 'a touch', 'slightly', 'a little', 'a shade'.",
      moderate: "A plain comparative with no qualifier: 'brighter', 'warmer', 'turn it up', 'open it more'.",
      large: "'much', 'a lot', 'way', 'considerably', 'significantly'.",
      maximum: "'all the way', 'as far as it goes', 'full', 'max'.",
      not_applicable: 'No relative change is being asked for, either because a value was named or because nothing numeric is involved.',
    },
  },
  [Q.queryKind]: {
    type: 'choice',
    instructions: 'If `request.text` is a question about the home, what kind of question is it?',
    criteria: {
      device_state: 'Whether one named device is on or off, open or closed, locked or unlocked, or what value it currently reads.',
      count: "How many things are in some state, or whether any are: 'are any windows open', 'how many lights are on'.",
      temperature: 'The temperature of a room, or of the home.',
      time_or_date: "The current time, or today's date.",
      needs_prose: "A question about the home that needs a written explanation or a summary across several devices: 'is everything locked up', 'what's going on downstairs'.",
      not_a_query: 'The request is not a question about the home.',
    },
  },
  [Q.risky]: {
    type: 'noul',
    instructions: 'If it were carried out, would `request.text` reduce the physical security of the home, or be hard to undo?',
    criteria: {
      true: 'Unlocking a door, opening a garage door, gate, exterior door or window, disarming an alarm, or anything else that leaves the home accessible from outside.',
      false: 'Lights, media, climate, scenes, routines, appliances, and anything that locks, closes or arms.',
    },
  },
};

export const MAGNITUDE_STEPS: Record<string, number> = {
  slight: 0.1,
  moderate: 0.25,
  large: 0.5,
  maximum: 1,
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface BuiltQuestions {
  questions: QuestionSet;
  /** Option id -> catalog entity, for the entity question. */
  entityOptions: Map<string, CatalogEntity>;
  /** Option id -> area, for the area question. */
  areaOptions: Map<string, { id: string; name: string; floor?: string }>;
  /** Domains that got an action question. */
  actionDomains: string[];
  /** Entities offered, in the order they appear in the question. */
  entityOrder: CatalogEntity[];
}

export interface BuildOptions {
  maxOptions: number;
  /** Restrict the entity question to these candidates (second-stage narrowing). */
  entities?: CatalogEntity[];
  /** Domains to ask an action question for; defaults to every domain present. */
  domains?: string[];
  defaultArea?: string;
}

/** A short description of one entity, as a question option. */
export function describeEntity(entity: CatalogEntity): string {
  const bits = [entity.name, entity.domain.replace(/_/g, ' ')];
  // Aliases are what the speaker may actually say ("the big light"); the decision model
  // only sees these criteria, so they have to be in here.
  if (entity.aliases && entity.aliases.length) bits.push(`also called ${entity.aliases.join(', ')}`);
  if (entity.areaName) bits.push(entity.areaName);
  if (entity.deviceClass) bits.push(entity.deviceClass.replace(/_/g, ' '));
  if (entity.state) bits.push(`is ${entity.state}`);
  return bits.join(', ');
}

export function buildQuestions(
  catalog: Catalog,
  extraction: Extraction,
  options: BuildOptions,
): BuiltQuestions {
  const questions: QuestionSet = structuredClone(STATIC_QUESTIONS);
  const entityOptions = new Map<string, CatalogEntity>();
  const areaOptions = new Map<string, { id: string; name: string; floor?: string }>();

  // --- areas ---------------------------------------------------------------
  if (catalog.areas.length > 0) {
    const criteria: Record<string, string> = {};
    for (const area of catalog.areas.slice(0, options.maxOptions - 1)) {
      const id = `area_${slug(area.name) || area.id}`;
      if (criteria[id]) continue;
      const also = area.aliases && area.aliases.length ? ` (also called ${area.aliases.join(', ')})` : '';
      criteria[id] = `${area.name}, on ${area.floor}.`.replace(', on undefined.', '.');
      if (area.floor) criteria[id] = `${area.name}, on ${area.floor}.`;
      else criteria[id] = area.name;
      criteria[id] += also;
      areaOptions.set(id, area);
    }
    criteria[NO_AREA] = 'No room or area is named or implied by the request.';
    questions[Q.targetArea] = {
      type: 'choice',
      instructions:
        'Which area of the home does `request.text` mean? Choose an area only when the request is about everything of a kind in that room, or when the room narrows down which device is meant.',
      criteria,
    };
  }

  // --- entities ------------------------------------------------------------
  const candidates = options.entities ?? catalog.entities;
  const cap = Math.max(2, options.maxOptions - 1);
  const offered = candidates.slice(0, cap);
  if (offered.length > 0) {
    const criteria: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entity of offered) {
      let id = `e_${slug(entity.name)}`;
      if (seen.has(id)) id = `e_${slug(`${entity.name}_${entity.areaName ?? entity.id}`)}`;
      seen.add(id);
      criteria[id] = describeEntity(entity);
      entityOptions.set(id, entity);
    }
    criteria[NO_SINGLE_ENTITY] = 'No one specific device is being named - the request is about a whole kind of device, a room, a floor or the whole house.';
    questions[Q.targetEntity] = {
      type: 'choice',
      instructions:
        'Which single device does `request.text` act on? Choose one only when the request is about that one device; otherwise choose the option saying no specific device is named.',
      criteria,
    };
  }

  // --- domains -------------------------------------------------------------
  const domains = options.domains ?? catalog.domains;
  if (domains.length > 0) {
    const criteria: Record<string, string> = {};
    for (const domain of domains) {
      criteria[domain] = DOMAIN_LABELS[domain] ?? `${domain} entities.`;
    }
    if (domains.length > 1) criteria[NO_DOMAIN] = 'No particular kind of device is meant.';
    questions[Q.targetDomain] = {
      type: 'choice',
      instructions:
        'Which kind of device does `request.text` mean? Use the catalog to tell kinds apart: lamps and bulbs are lights, a coffee maker is a switch, blinds are covers.',
      criteria,
    };
  }

  // --- one action question per domain present ------------------------------
  const actionDomains = domains.filter((domain) => actionsForDomain(domain).length > 0);
  for (const domain of actionDomains) {
    const criteria: Record<string, string> = {};
    for (const action of actionsForDomain(domain)) {
      criteria[action] = ACTION_LABELS[domain]![action]!;
    }
    criteria[NOT_TARGETED] = `The request is clearly not about ${(DOMAIN_LABELS[domain] ?? domain).toLowerCase()} at all.`;
    questions[actionQuestion(domain)] = {
      type: 'choice',
      instructions: `If \`request.text\` is about ${domains.length > 1 ? 'this kind of device' : (DOMAIN_LABELS[domain] ?? domain).toLowerCase()}, what is it asking for?`,
      criteria,
    };
  }

  // --- values --------------------------------------------------------------
  if (extraction.candidates.length > 0) {
    const criteria: Record<string, string> = {};
    for (const candidate of extraction.candidates) {
      criteria[candidate.id] = `"${candidate.text}"`;
    }
    criteria.none = 'None of these spans is the value the request means.';
    questions[Q.valuePick] = {
      type: 'choice',
      instructions:
        'Which span of `request.text` states the value the request sets or asks about - the brightness, temperature, volume, position or colour?',
      criteria,
    };
  }

  return {
    questions,
    entityOptions,
    areaOptions,
    actionDomains,
    entityOrder: offered,
  };
}


