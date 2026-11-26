/**
 * Conversation that is not a command.
 *
 * A voice assistant hears plenty of sentences that are about the conversation rather than
 * about the house: "no you", "ignore that", "thanks", "wait". The decision model was never
 * asked to classify those, so they used to reach the router as a command and either got
 * forwarded after a pointless model round trip or — worse — nudged a device.
 *
 * This is a deliberately small, cheap filter: it only fires when the sentence is short, has
 * no command verb, names no device or room, and opens with a word that only makes sense as
 * conversation. Anything it is unsure about is left to the decision model.
 */

import type { Catalog } from './types.js';
import { normalise } from './util.js';

/** Openers that are conversation, not an instruction. */
const CHATTER_OPENER =
  /^(no|nope|nah|yes|yeah|yep|yup|ok|okay|sure|right|hmm+|hm+|um+|uh+|er+|ah+|oh+|ignore|ignored|forget|never ?mind|nevermind|stop|quit|cancel|actually|wait|hold on|thanks|thank you|thx|ta|hello|hi|hey|yo|please|sorry|oops|wrong|not that|nothing|whatever|anyway|lol|haha|maybe|dunno|idk|who|what|why|how come|huh|eh|well|so|you|me|i|do you|can you|are you|did you|is that|was that)\b/;

/** The verbs that make a sentence an instruction, whatever else it contains. */
const COMMAND_VERBS =
  'turn|switch|set|dim|brighten|open|close|lock|unlock|play|pause|resume|mute|unmute|increase|decrease|raise|lower|toggle|arm|disarm|activate|run|clean|vacuum|add|complete|remove|put|make|shut|kill|broadcast|restart|reboot|find|search|start';

const COMMAND_VERB = new RegExp(`\\b(${COMMAND_VERBS})\\b`);

/** The same verbs where they matter most: the word the sentence opens with. */
const LEADING_COMMAND_VERB = new RegExp(`^(${COMMAND_VERBS})\\b`);

/** A sentence longer than this is not a terse aside; let the model read it. */
const MAX_WORDS = 6;

/** Openers that ask something of the world rather than react to the conversation. */
const QUESTION_OPENER =
  /^(what|whats|which|whichever|whose|who|whom|why|when|where|how|is|are|was|were|am|do|does|did|can|could|should|would|will|shall|any|tell me)\b/;

/**
 * Whether the sentence asks a question, whether or not the transcriber wrote the question mark.
 *
 * A question is the decision model's to classify, not the chatter filter's: the questionnaire
 * already separates a `query` from `information` from `unclear`, and the model can weigh a
 * sentence the keyword list cannot ("who won the game last night"). The chatter filter stays
 * for what it is good at — a terse aside that carries no question at all ("thanks", "never
 * mind") — where a model round trip would buy nothing.
 */
export function looksLikeQuestion(text: string): boolean {
  const spoken = normalise(text);
  if (!spoken) return false;
  if (/\?\s*$/.test(text.trim())) return true;
  return QUESTION_OPENER.test(spoken);
}

/**
 * Whether the sentence contains a verb that makes it an instruction, whatever else it holds.
 * Exported because "this could be a command" is the guard every other reader needs before it
 * calls a sentence something else: a roll call of names is only a roll call when nothing in it
 * asks for anything.
 */
export function hasCommandVerb(text: string): boolean {
  return COMMAND_VERB.test(text);
}

/**
 * Whether the sentence opens with one of those verbs. A part of a sentence that starts with a
 * verb is an instruction even when the rest of it is names ("turn on kitchen lights"); a part that
 * merely contains one is often a device whose name holds the word ("Deadbolt Detector Lock State").
 */
export function startsWithCommandVerb(text: string): boolean {
  return LEADING_COMMAND_VERB.test(text);
}

/**
 * The reason this sentence is conversation rather than a command, or null when it might be
 * one. Cheap enough to run on every request: no allocation beyond a normalised copy.
 */
export function looksLikeChatter(text: string, catalog: Catalog): string | null {
  const spoken = normalise(text);
  if (!spoken) return null;

  const words = spoken.split(' ').filter(Boolean);
  if (words.length > MAX_WORDS) return null;
  if (COMMAND_VERB.test(spoken)) return null;

  // Naming a device or a room means the sentence is about the house, so the decision model
  // should see it even when it is only two words long ("kitchen off").
  for (const entity of catalog.entities) {
    const name = normalise(entity.name);
    if (name && spoken.includes(name)) return null;
  }
  for (const area of catalog.areas) {
    const name = normalise(area.name);
    if (name && spoken.includes(name)) return null;
  }

  if (!CHATTER_OPENER.test(spoken)) return null;
  return `conversation, not a command ("${text.trim()}" names no device, room or action)`;
}
