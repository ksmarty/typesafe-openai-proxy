/**
 * Splitting a genuinely compound sentence into clauses the fast path can each decide.
 *
 * "Turn off the lights and lock the door" is two actions. The decision model flags it
 * with the compound question, but the split itself is lexical: conjunctions and commas
 * are where people put the seam.
 *
 * The rule that keeps this safe is that every clause has to be able to stand on its own.
 * "Turn on the kitchen and the living room lights" splits into a clause with no verb, so
 * it is rejected here and handled as one action across two targets instead. A split that
 * looks wrong still has to survive the router: if any clause cannot be resolved on its
 * own, the whole sentence is forwarded rather than half of it being executed.
 */

/** Verbs that make a clause a request on its own. */
const VERB = new RegExp(
  '\\b(?:' +
    [
      'turn', 'switch', 'set', 'dim', 'brighten', 'open', 'close', 'lock', 'unlock',
      'play', 'pause', 'stop', 'start', 'mute', 'unmute', 'increase', 'decrease',
      'raise', 'lower', 'toggle', 'arm', 'disarm', 'activate', 'run', 'clean',
      'vacuum', 'add', 'remove', 'complete', 'put', 'make', 'shut', 'kill',
    ].join('|') +
    ')\\b',
  'i',
);

/** Where a sentence is joined: "and", "then", "also", "plus", a comma or a semicolon. */
const SEAM = /\s*(?:[,;]|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s+/i;

/**
 * The clauses of a compound request, or an empty array when the sentence is not one.
 *
 * Deliberately conservative: two to four clauses, each at least two words long, each
 * carrying a verb. Anything else is left alone, because a wrong split turns one good
 * call into several wrong ones.
 */
export function splitClauses(text: string): string[] {
  const sentence = (text ?? '').trim();
  if (sentence.length < 6) return [];
  const parts = sentence
    .split(SEAM)
    .map((part) => part.replace(/^\s*(?:and|then|also|plus)\s+/i, '').trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2 || parts.length > 4) return [];
  const usable = parts.filter((part) => VERB.test(` ${part} `) && part.split(/\s+/).length >= 2);
  if (usable.length < 2) return [];
  // Every piece has to survive, otherwise the seam we picked was inside a target name.
  if (usable.length !== parts.length) return [];
  return usable;
}
