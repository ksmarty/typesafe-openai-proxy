/**
 * Was that sentence meant for the assistant?
 *
 * A voice assistant hears the whole room. Anything the fast path declines is forwarded to
 * the model server, and the model answers whatever text arrives — so a remark between two
 * people ("we should get that door fixed") came back as a confident attempt at the house.
 *
 * The decision model is the right judge and is asked every time (`Q.addressed`). This
 * module is the fallback for the turns where no model was asked at all: a pass-through
 * install, the backend turned off, a model that is unreachable.
 *
 * Note what it does *not* do: it never treats a short sentence as unaddressed just because
 * it is not a command. "thanks", "yes", "ignore that" are replies to the assistant, and
 * silencing them would be a different bug from the one this fixes. Only sentences that are
 * structurally a remark — a report about a third party, a question aimed at someone in the
 * room, narration, a plan between people — come back false. Anything else is `null`, which
 * means "forward it, exactly as before".
 */

import type { Catalog } from './types.js';
import { normalise } from './util.js';

export interface AddresseeVerdict {
  /**
   * true - spoken to the assistant, false - a remark that happened to be overheard,
   * null - cannot tell from the text alone.
   */
  addressed: boolean | null;
  /**
   * Probability that the sentence was NOT addressed to the assistant, 0..1. A pattern
   * match is 0.9 rather than 1 so that raising `listening.confidence` past 0.9 turns the
   * local reader off without disabling the feature.
   */
  notAddressed: number;
  /** One line explaining the verdict, for the trace. */
  reason: string;
}

/** A verb that only makes sense as an instruction to something. */
const IMPERATIVE =
  /\b(turn|switch|set|dim|brighten|open|close|lock|unlock|play|pause|resume|mute|unmute|increase|decrease|raise|lower|toggle|arm|disarm|activate|run|clean|vacuum|add|complete|remove|put|shut|broadcast|restart|make it|find|search|start|write|tell me|show me|give me|remind)\b/;

/** Shapes a question put to the assistant arrives in. */
const ASSISTANT_QUESTION =
  /\?|^(is|are|was|were|do|does|did|can|could|would|will|should|may|what|which|who|where|when|how|any)\b|\b(please|thank you)\b/;

/** A question aimed at the person standing next to you. */
const SOCIAL_QUESTION =
  /^(did|do|does|have|has|are|were|can|could) you (see|saw|hear|heard|watch|watched|catch|caught|notice|noticed|remember|know about|know what|get|got|think)\b/;

/** A report about somebody else: "my wife says the lights are still on". */
const THIRD_PARTY_REPORT =
  /\b(he|she|they|him|her|them|my (wife|husband|partner|son|daughter|mother|father|mum|mom|dad|brother|sister|neighbour|neighbor|friend)|mum|mom|dad)\b[^.]*\b(said|says|told|tells|thinks?|wants?|asked|mentioned|reckons?)\b/;

/** A plan between people, with nothing to act on yet. */
const FIRST_PERSON_PLAN =
  /^(i|we)\b[^.]*\b('ll|’ll| will| should| need to| have to| want to| am going to| are going to| gotta| must| might| can)\b/;

/** Narration about the world: "there is a car outside", "it is getting late". */
const NARRATION = /^(it|there|that|this|he|she|they|someone|somebody|everyone|nobody|the)\b[^.]*\b(is|are|was|were|has|have|looks|seems)\b/;

/** A statement about the other person: "you should have seen it". */
const SECOND_PERSON_STATEMENT = /^you\b|\babout you\b|\byou know\b/;

function namesSomethingInTheHouse(spoken: string, catalog: Catalog): boolean {
  for (const entity of catalog.entities) {
    // A prompt-parsed name can carry the punctuation that separated it from the id.
    const name = normalise(entity.name).replace(/[^a-z0-9]+$/, '');
    if (name && spoken.includes(name)) return true;
    // The object id is a fallback for a prompt-parsed catalog with no friendly names.
    const id = entity.id.split('.')[1]?.replace(/_/g, ' ').trim();
    if (id && id.length > 3 && spoken.includes(id)) return true;
  }
  for (const area of catalog.areas) {
    const name = normalise(area.name);
    if (name && spoken.includes(name)) return true;
  }
  return false;
}

export function judgeAddressee(text: string, catalog: Catalog): AddresseeVerdict {
  const spoken = normalise(text);
  if (!spoken) return { addressed: null, notAddressed: 0.5, reason: 'nothing was said' };

  const named = namesSomethingInTheHouse(spoken, catalog);
  const aQuestion = ASSISTANT_QUESTION.test(spoken);

  // The remark readings come first, because they are the only ones that can be wrong in a
  // way nobody notices: a RemarkPattern fired on a real request means the house stops
  // listening. All of them are checked before the request shapes, and the ones that could
  // mistake an instruction for a remark switch off as soon as the sentence is also a
  // question.
  if (SOCIAL_QUESTION.test(spoken)) {
    return { addressed: false, notAddressed: 0.9, reason: 'a question aimed at another person, not the assistant' };
  }
  if (!aQuestion && THIRD_PARTY_REPORT.test(spoken)) {
    return { addressed: false, notAddressed: 0.9, reason: 'a report about somebody else, not the assistant' };
  }
  if (!aQuestion && FIRST_PERSON_PLAN.test(spoken)) {
    return { addressed: false, notAddressed: 0.9, reason: 'a plan between people, not a request to the assistant' };
  }
  if (!aQuestion && NARRATION.test(spoken)) {
    return { addressed: false, notAddressed: 0.9, reason: 'a statement about the room, not a request to the assistant' };
  }

  // From here the shapes a request arrives in. A question that is not a remark is put to
  // somebody in the room, and the assistant is one of them.
  if (aQuestion) return { addressed: true, notAddressed: 0, reason: 'a question' };
  if (IMPERATIVE.test(spoken)) return { addressed: true, notAddressed: 0, reason: 'an instruction' };
  // "close that door" is a request even when no device is named: the speaker is pointing at
  // something in the room.
  if (/\b(that|this|it)\b/.test(spoken)) {
    return { addressed: true, notAddressed: 0, reason: 'refers to something present' };
  }
  if (named) return { addressed: true, notAddressed: 0, reason: 'names something in the house' };

  if (SECOND_PERSON_STATEMENT.test(spoken)) {
    return { addressed: false, notAddressed: 0.9, reason: 'a remark to somebody in the room, not the assistant' };
  }

  return {
    addressed: null,
    notAddressed: 0.5,
    reason: 'cannot tell from the text whether it was addressed to the assistant',
  };
}

export { IMPERATIVE as ASSISTANT_IMPERATIVE, ASSISTANT_QUESTION };
