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

/** A verb that makes the sentence an instruction, whatever else it contains. */
const COMMAND_VERB =
  /\b(turn|switch|set|dim|brighten|open|close|lock|unlock|play|pause|resume|mute|unmute|increase|decrease|raise|lower|toggle|arm|disarm|activate|run|clean|vacuum|add|complete|remove|put|make|shut|kill|broadcast|restart|reboot|find|search|start)\b/;

/** A sentence longer than this is not a terse aside; let the model read it. */
const MAX_WORDS = 6;

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
