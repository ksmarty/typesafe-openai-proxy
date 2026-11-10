/**
 * Telling the time, in words.
 *
 * Home Assistant can answer "what time is it?" itself with `HassGetCurrentTime`, but that
 * response is either read digit by digit or phrased by the conversation agent — "It is
 * 17:22" or "The current time is 5:22 PM" — and neither is what a clock in a room should
 * say. The reply wanted here is the one a person gives: **"five twenty-two"**, **"five
 * o'clock"** on the hour, never a.m. or p.m., because the answer is spoken aloud and the
 * part of the day is obvious from the moment it is heard.
 *
 * So the proxy answers the time itself. That is the only way to own the wording, and it
 * costs nothing: no model call, no intent round trip.
 *
 * The clock it reads, in order:
 *  1. `clock.timezone`, when it is set — an IANA zone such as `Europe/Amsterdam`;
 *  2. the time Home Assistant already put in this request's system prompt ("Current time
 *     is 9:41 AM."), which is in the home's own timezone and needs no request of its own;
 *  3. the process clock, which is the container's `TZ`.
 *
 * What it deliberately does not do: answer a question about another place ("what time is
 * it in Tokyo"), or a question about the date — both are forwarded as before.
 */

import type { Config } from './config.js';
import { normalise } from './util.js';

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS: Record<number, string> = {
  2: 'twenty',
  3: 'thirty',
  4: 'forty',
  5: 'fifty',
};

/** `22` -> `twenty two`, `9` -> `nine`. Never a digit. */
export function numberWords(value: number): string {
  const n = Math.max(0, Math.floor(value));
  if (n < 20) return ONES[n] ?? String(n);
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const name = TENS[tens];
  if (!name) return String(n);
  return ones ? `${name} ${ONES[ones]}` : name;
}

/**
 * The hour as it is read on a clock face: 0 and 12 are twelve, 17 is five.
 *
 * This is why no a.m./p.m. is ever needed: "five" is the right word at five in the morning
 * and at five in the afternoon, and the listener knows which one it is.
 */
function hourWords(hours24: number): string {
  const onFace = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return numberWords(onFace);
}

/**
 * Minutes the way a clock face reads them: `twenty-two`, hyphenated, so a spoken time is two
 * words ("five twenty-two") and not three ("five twenty two"), which a voice reads as two
 * separate numbers.
 */
function minuteWords(minutes: number): string {
  return numberWords(minutes).replace(' ', '-');
}

/**
 * The time as a person says it: `five twenty-two`, and `five o'clock` at the top of the
 * hour. Minutes below ten take "oh" (`nine oh five`) so they are not heard as a number.
 */
export function spokenTime(date: Date): string {
  const hour = hourWords(date.getHours());
  const minutes = date.getMinutes();
  if (minutes === 0) return `${hour} o'clock`;
  if (minutes < 10) return `${hour} oh ${numberWords(minutes)}`;
  return `${hour} ${minuteWords(minutes)}`;
}

/** `9:41 AM.` at the front of Home Assistant's system prompt. */
const PROMPT_TIME =
  /\b(?:the\s+)?(?:current\s+)?time\s+is\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i;

/**
 * The time Home Assistant reported in this request's system prompt.
 *
 * The date carries that wall time in its *local* fields, because it is only ever read with
 * `getHours()`/`getMinutes()`: the prompt is already in the home's timezone, so a second
 * conversion would be a guess. Returns null when the prompt says no time.
 */
export function clockFromPrompt(prompt: string): Date | null {
  if (!prompt) return null;
  const match = PROMPT_TIME.exec(prompt);
  if (!match?.[1] || !match[2]) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[3] ?? '').toLowerCase().replace(/\./g, '');
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (minutes > 59 || hours > 23) return null;

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
}

/** The wall time in an IANA zone, as local fields. Null when the zone is not understood. */
function zonedNow(timezone: string): Date | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const at: Record<string, number> = {};
    for (const part of parts) {
      if (part.type === 'literal') continue;
      at[part.type] = Number(part.value);
    }
    const year = at.year;
    const hour = at.hour;
    if (year === undefined || hour === undefined) return null;
    if (!Number.isFinite(year) || !Number.isFinite(hour)) return null;
    const month = at.month ?? 1;
    const day = at.day ?? 1;
    const minute = at.minute ?? 0;
    const second = at.second ?? 0;
    return new Date(year, month - 1, day, hour === 24 ? 0 : hour, minute, second, 0);
  } catch {
    return null;
  }
}

/**
 * The clock the proxy reads: the configured zone, else Home Assistant's prompt clock, else
 * the process clock. Only `getHours()`/`getMinutes()` of the result are meaningful.
 */
export function clockNow(clock: Config['clock'], systemPrompt?: string): Date {
  const timezone = (clock?.timezone ?? '').trim();
  if (timezone) {
    const zoned = zonedNow(timezone);
    if (zoned) return zoned;
  }
  const fromPrompt = systemPrompt ? clockFromPrompt(systemPrompt) : null;
  if (fromPrompt) return fromPrompt;
  return new Date();
}

/**
 * The shapes a spoken request for the clock arrives in.
 *
 * Deliberately narrow: a command that happens to contain "time" ("set a timer for five
 * minutes") or a question about somewhere else ("what time is it in Tokyo") is not matched
 * and takes the normal path.
 */
const TIME_QUESTION = new RegExp(
  [
    // "what time", "what's the time", "what is the current time". The apostrophe is already a
    // space by here (`normalise`), so "what's" reads as "what s".
    '\\bwhat(?:\\s*s|\\s+is)?\\s+(?:the\\s+)?(?:current\\s+)?time\\b',
    '\\bwhat\\s+time\\s+is\\s+it(?:\\s+now)?\\b',
    '\\bwhat\\s+time\\s+(?:do\\s+you\\s+have|have\\s+you\\s+got)\\b',
    '\\b(?:got|have|know)\\s+the\\s+time\\b',
    '\\btell\\s+me\\s+the\\s+time\\b',
    '\\bknow\\s+what\\s+time\\s+it\\s+is\\b',
  ].join('|'),
  'i',
);

/**
 * A question about a clock somewhere else — "what time is it in Tokyo" — which this cannot
 * answer honestly, because it only knows the time in this house.
 */
const ELSEWHERE = /\btime\b[^?]*\b(?:in|at|for)\s+\w/;

/** True when the sentence is a request for the current time, in this house. */
export function isTimeQuestion(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const spoken = normalise(raw);
  if (!spoken) return false;
  if (ELSEWHERE.test(` ${spoken} `)) return false;
  if (/\b(date|day|today|tomorrow|yesterday|month|year)\b/.test(spoken)) return false;

  // "the time?" or "time": the whole sentence, so nothing else was asked.
  if (/^(the\s+)?time$/.test(spoken)) return true;

  // Otherwise it has to be shaped like a question, so a statement that mentions the time
  // ("I know the time", "remember the time we…") is left alone.
  const question =
    /\?\s*$/.test(raw) || /^\s*(what|whats|when|is|are|do|does|have|got|tell|know)\b/i.test(raw);
  if (!question) return false;
  return TIME_QUESTION.test(spoken);
}

/**
 * The bare spoken answer to a request for the time — "five twenty-two" — or null when the
 * sentence is not one.
 *
 * Bare on purpose: it is spoken as the whole reply, with no "It is" in front of it.
 */
export function clockAnswer(text: string, clock: Config['clock'], systemPrompt?: string): string | null {
  if (!isTimeQuestion(text)) return null;
  return spokenTime(clockNow(clock, systemPrompt));
}
