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
 * the configured silence, no decision call and no model round trip. Anything else — a verb
 * anywhere, a question, a name the catalog does not know, two names where four are needed — is
 * left alone, because a sentence the proxy cannot read is exactly what the model is for.
 */

import { startsWithCommandVerb } from './chatter.js';
import type { Catalog } from './types.js';
import { normalise } from './util.js';

/** How a list of names is separated when it is spoken: commas, semicolons, "and", "then". */
const SEPARATOR = /\s*(?:,|;|\/|\band\b|\bthen\b|\bor\b)\s*/;

/** Fewer names than this is a short phrase that something else should read. */
const MIN_NAMES = 4;

/** The share of the sentence that has to be catalog names before the whole thing is a list. */
const MIN_SHARE = 0.75;

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
  if (matched.length / segments.length < MIN_SHARE) return null;
  // A part that opens with a verb is an instruction: "Kitchen Lights, Bed Lights, turn on" reads
  // as a list, but "turn on" is what the sentence is for. A verb merely inside a part is not, since
  // Home Assistant names devices with those words — "Play Music", "Deadbolt Detector Lock State".
  if (rest.some((segment) => startsWithCommandVerb(segment))) return null;

  const opening = text.trim();
  const shown = opening.length > 48 ? `${opening.slice(0, 48)}…` : opening;
  return `roll call, not a command ("${shown}" is ${matched.length} device names in a row and no action) — the microphone heard the assistant's own list`;
}
