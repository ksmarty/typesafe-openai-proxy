/**
 * A roll call is not a command.
 *
 * Some turns are not a sentence at all: they are the catalog read aloud.
 *
 *   "Office, Living Room, Kitchen, Bedroom, Front Hall, …, Door."
 *
 * Speech-to-text produced that in a live install, and nothing in it asks for anything — it is
 * the assistant's own list of every name it knows, heard back through the microphone. The proxy
 * has no reader for it, so the sentence was long enough to skip the chatter filter, the decision
 * model found no intent in it, and the turn ended with the model server being handed forty device
 * names and asked what to do about them. Eleven seconds later it apologised for the list, spoke
 * an answer, and the answer was itself a list of things — which is how a satellite ends up
 * answering its own voice.
 *
 * This reader closes that loop. A sentence that is nothing but names the catalog already holds,
 * joined by commas or "and", with no verb, is not addressed to the assistant: the turn ends with
 * the configured silence, no decision call and no model round trip. Anything else — a part that
 * opens with a verb, a question, two names where four are needed — is left alone, because a
 * sentence the proxy cannot read is exactly what the model is for.
 */

import { startsWithCommandVerb } from './chatter.js';
import type { Catalog } from './types.js';
import { normalise } from './util.js';

/** How a list of names is separated when it is spoken: commas, semicolons, "and", "then". */
const SEPARATOR = /\s*(?:,|;|\/|\band\b|\bthen\b|\bor\b)\s*/;

/** Fewer names than this is a short phrase that something else should read. */
const MIN_NAMES = 4;

/**
 * How much of a *short* sentence has to be names before it is a list: "Office, Living Room,
 * Kitchen, Bedroom, garage" is somebody talking, not a catalog.
 */
const SHORT_SHARE = 0.75;

/**
 * The same share for a long one. A satellite reading a catalog out loud names far more than
 * Assist is exposed to — the live transcript behind this reader was 34 names of which the
 * catalog held 15 — so a strict share declines exactly the sentence the reader exists for.
 * Thirty-four parts separated by commas is decisive on its own; the share only says "and a
 * good part of it is even in the catalog".
 */
const LONG_SHARE = 0.35;

/** From this many parts on, a sentence is read aloud rather than spoken. */
const LONG_SEGMENTS = 8;

/** Whether any of a part's first words is a command verb, i.e. the part is an instruction. */
function opensWithVerb(part: string): boolean {
  const words = part.split(' ').filter(Boolean);
  for (let index = 0; index < Math.min(3, words.length); index += 1) {
    if (startsWithCommandVerb(words.slice(index).join(' '))) return true;
  }
  return false;
}

/**
 * The reason this sentence is a roll call rather than a command, or null when it might be one.
 *
 * Matching is on the whole segment: "kitchen lights" is a name, while "kitchen lights off" is a
 * name somebody gave an instruction — the extra word keeps it for the decision model, which is
 * the only reader that can tell "off" from the tail of "Projector Remote Projector Off".
 */
export function looksLikeRollCall(text: string, catalog: Catalog): string | null {
  const spoken = normalise(text);
  if (!spoken) return null;
  // A question is a question even when every word in it is a name ("which is the kitchen lights").
  if (/\?\s*$/.test(text)) return null;

  const names = new Set<string>();
  const remember = (value: string | undefined): void => {
    if (!value) return;
    const name = normalise(value);
    if (name) names.add(name);
  };
  for (const entity of catalog.entities) {
    remember(entity.name);
    for (const alias of entity.aliases ?? []) remember(alias);
  }
  for (const area of catalog.areas) {
    remember(area.name);
    for (const alias of area.aliases ?? []) remember(alias);
  }
  if (names.size === 0) return null;

  const segments = text
    .split(SEPARATOR)
    .map((segment) => normalise(segment))
    .filter(Boolean);
  if (segments.length < MIN_NAMES) return null;

  const matched = segments.filter((segment) => names.has(segment));
  const rest = segments.filter((segment) => !names.has(segment));
  if (matched.length < MIN_NAMES) return null;
  const needed = segments.length >= LONG_SEGMENTS ? LONG_SHARE : SHORT_SHARE;
  if (matched.length / segments.length < needed) return null;
  // A part that opens with a verb is an instruction: "Kitchen Lights, Bed Lights, turn on" reads
  // as a list, but "turn on" is what the sentence is for. A verb merely inside a part is not, since
  // Home Assistant names devices with those words — "Play Music", "Deadbolt Detector Lock State".
  // The first three words are close enough to the front: "Door turn on the office lamp" is a name
  // with no comma after it and still an instruction.
  if (rest.some(opensWithVerb)) return null;

  const opening = text.trim();
  const shown = opening.length > 48 ? `${opening.slice(0, 48)}…` : opening;
  return `roll call, not a command ("${shown}" is ${matched.length} device names in a row and no action) — the microphone heard the assistant's own list`;
}
