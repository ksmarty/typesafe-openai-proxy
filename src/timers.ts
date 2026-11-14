/**
 * Timers, said the way kiosk-satellite says them.
 *
 * Home Assistant keeps timers itself: `HassStartTimer`, `HassCancelTimer`,
 * `HassCancelAllTimers`, `HassIncreaseTimer`, `HassDecreaseTimer`, `HassPauseTimer`,
 * `HassUnpauseTimer` and `HassTimerStatus` are intents of the intent integration, and a
 * timer belongs to the `device_id` of the conversation that started it rather than to an
 * entity in the house. A kiosk-satellite is such an owner: it registers itself as a timer
 * device, so "set a pasta timer for 8 minutes" said near it starts a timer that rings on
 * that kiosk, and "pause the pasta timer" pauses the same one.
 *
 * A timer sentence has nothing for a model to decide. "Add 2 minutes to my timer" is one
 * intent with one duration, and every word of it is already in the sentence, so sending it
 * to the model buys a round trip and a chance to misread the number. This reader classifies
 * it, the way `music.ts`, `media.ts` and `reminders.ts` do theirs, and answers with Home
 * Assistant's own tool call. There is no model call anywhere in this file.
 *
 * Two things about timers have to be respected rather than discovered:
 *
 *  1. **The start split is the identity.** Home Assistant stores the slots a start call
 *     carried (`start_hours`, `start_minutes`, `start_seconds`) and `_find_timer` compares
 *     them with `==` — a slot that was absent is `None`, so a later control call that sends
 *     `start_hours: 0` for a timer started with `{minutes: 10}` matches nothing. So a
 *     duration always becomes one canonical split (`10 minutes` → `{minutes: 10}`,
 *     `1 hour` → `{hours: 1}`, `90 seconds` → `{seconds: 90}`), and a control sentence that
 *     names a length replays that same split.
 *  2. **Several timers can be running on one kiosk.** "Set two timers for 10 minutes",
 *     "set timers for 5 and 10 minutes", "cancel the pasta timer, keep the rice one" — the
 *     first is several calls in one turn, and the second needs to know which timer was
 *     meant. Nothing outside Home Assistant lists the running timers, so this reader keeps
 *     a small ledger of the timers it started itself (device, name, split, length): it is
 *     used to replay a split and to ask which timer was meant when two are running, and it
 *     is pruned once a timer has run out. A timer started by something else is not in the
 *     ledger, which is fine — an unnamed control call leaves the choosing to Home Assistant,
 *     exactly as kiosk-satellite's own `timerSlots` does.
 *
 * Anything this reader is not sure of is forwarded to the model: a status question ("what
 * timers are running" — only Home Assistant's `TimerManager` knows, and it reports slots
 * rather than a sentence), a timer with no length, a house where Home Assistant offers none
 * of these intents. Nothing is ever refused here.
 */

import type { Config } from './config.js';
import { speechTemplates } from './config.js';
import { parseAmount } from './reminders.js';
import { findTool, type ToolInventory } from './toolcall.js';
import type { ClarifyPlan, MultiCallPlan, OpenAIToolFunction, ToolCall, ToolCallPlan } from './types.js';

/** The intent integration's timer intents, as Home Assistant offers them to a model. */
const TOOLS = {
  start: 'HassStartTimer',
  cancel: 'HassCancelTimer',
  cancel_all: 'HassCancelAllTimers',
  increase: 'HassIncreaseTimer',
  decrease: 'HassDecreaseTimer',
  pause: 'HassPauseTimer',
  unpause: 'HassUnpauseTimer',
} as const;

type Kind = keyof typeof TOOLS;

/** The domain every timer action is reported under. There is no `timer` entity behind it. */
const DOMAIN = 'timer';

export type TimerPlan = ToolCallPlan | MultiCallPlan | ClarifyPlan;

export interface TimerDecision {
  plan: TimerPlan;
  /** Why the trace shows this turn was decided here rather than by the model. */
  reason: string;
}

export interface TimerInput {
  utterance: string;
  inventory: ToolInventory;
  config: Config;
  /** The kiosk that heard the sentence: a timer belongs to its device, not to the house. */
  deviceId?: string;
  /** Language for the "which timer" question, when one has to be asked. */
  language?: string;
}

/** A duration as Home Assistant stores it: the slots a start call carried, nothing else. */
interface Split {
  hours?: number;
  minutes?: number;
  seconds?: number;
}

/** A timer this reader started, so a later sentence can point at it. */
interface StartedTimer {
  device: string;
  name?: string;
  split: Split;
  seconds: number;
  at: number;
}

const STARTED: StartedTimer[] = [];

/** Enough for a houseful of kiosks and a kitchen's worth of pasta timers. */
const STARTED_CAP = 32;

/** Seconds in one of the units a duration is spoken in. */
const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
  day: 86400,
  days: 86400,
};

/** Words that describe the timer rather than name it: "set a second timer". */
const NAME_STOP = new Set([
  'a',
  'an',
  'the',
  'another',
  'new',
  'one',
  'two',
  'three',
  'four',
  'five',
  'second',
  'third',
  'fourth',
  'next',
  'last',
  'other',
  'quick',
  'short',
  'little',
  'small',
  'big',
  'extra',
  'few',
  'couple',
]);

/** "two timers", "three timers": how many timers one length is started as. */
const COUNT_WORDS: Record<string, number> = {
  both: 2,
  couple: 2,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/** Verbs that start a timer rather than change a running one. */
const CREATE = /\b(?:set|start|begin|create|make|give me|put on|i need|i want)\b/;

/** Verbs that make a running timer longer, when the sentence also says how much. */
const ADDING = /\b(?:add|extend|increase|top up|give me|put on|more)\b/;

/** Verbs that make a running timer shorter, when the sentence also says how much. */
const SHORTENING = /\b(?:subtract|decrease|reduce|take|cut|remove|shave|drop|less)\b/;

/**
 * The sentence as the reader compares it: single-spaced, no trailing punctuation, straight
 * apostrophes.
 *
 * The case is left alone on purpose: a timer's name is spoken back by the kiosk and shown in
 * its list, so "set a Pasta timer for 8 minutes" must keep "Pasta". Every pattern below
 * therefore matches case-insensitively instead of lowercasing the sentence first.
 */
function speechOf(utterance: string): string {
  return utterance
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;]+$/g, '')
    .trim();
}

/** Case- and space-insensitive comparison, the way Home Assistant compares timer names. */
function fold(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Every duration in the sentence, in the order it was said.
 *
 * Two shapes need care. "5 and 10 minutes" is two durations sharing one unit and not one of
 * fifteen minutes, so a window of words that joins them is refused and the earlier numbers
 * are picked up again by walking back over the "and". "Half an hour" is one duration whose
 * amount is a word, which is why the amount is read by `parseAmount` from `reminders.ts`
 * rather than by a numeric regular expression.
 */
function readSpans(spoken: string): { seconds: number; start: number }[] {
  const words = spoken.toLowerCase().split(/[^a-z0-9.:]+/).filter(Boolean);
  const spans: { seconds: number; start: number }[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const unitSeconds = UNIT_SECONDS[words[i] ?? ''];
    if (!unitSeconds) continue;

    let amount: number | null = null;
    let from = i;
    for (let size = 4; size >= 1; size -= 1) {
      const start = i - size;
      if (start < 0) continue;
      const slice = words.slice(start, i);
      if (slice.some((word) => UNIT_SECONDS[word] !== undefined)) continue;
      const joined = slice.join(' ');
      // "5 and 10" is two durations; "1 and a half" is one.
      if (/\band\b/.test(joined) && !/\band\s+a\s+half$/.test(joined)) continue;
      const value = parseAmount(joined);
      if (value === null || value <= 0) continue;
      amount = value;
      from = start;
      break;
    }
    if (amount === null) continue;

    spans.push({ seconds: Math.round(amount * unitSeconds), start: from });

    // "an hour and a half", "ten minutes and a half": the half is said after the unit, so it
    // is added to the span just read instead of being read as a window of its own.
    if (words[i + 1] === 'and' && words[i + 2] === 'a' && words[i + 3] === 'half') {
      const last = spans[spans.length - 1];
      if (last) last.seconds += unitSeconds / 2;
      i += 3;
    }

    // "5 and 10 minutes", "5, 10 and 15 minutes": the numbers before this one share its unit.
    let cursor = from;
    while (cursor > 0) {
      const bridge = words[cursor - 1] === 'and' ? cursor - 2 : cursor - 1;
      if (bridge < 0) break;
      const word = words[bridge] ?? '';
      if (UNIT_SECONDS[word] !== undefined) break;
      const value = parseAmount(word);
      if (value === null || value <= 0) break;
      spans.push({ seconds: Math.round(value * unitSeconds), start: bridge });
      cursor = bridge;
    }
  }

  return spans.sort((left, right) => left.start - right.start);
}

/** A name the sentence gives a timer, and where it was said. */
interface Named {
  name: string;
  start: number;
}

/**
 * The names in the sentence, in order.
 *
 * kiosk-satellite's own phrases are "set a pasta timer for 8 minutes" and "pause the pasta
 * timer", so a name is what sits between an article and the word "timer". "Called pasta" and
 * "named pasta" are read as well, because they are how people disambiguate out loud.
 */
function readNames(spoken: string): Named[] {
  const names: Named[] = [];

  const add = (raw: string, at: number): void => {
    const name = raw.replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, '');
    if (!name || name.length > 32) return;
    const folded = fold(name);
    if (NAME_STOP.has(folded) || folded.includes('timer')) return;
    if (names.some((known) => fold(known.name) === folded)) return;
    names.push({ name, start: at + raw.indexOf(name) });
  };

  const article = /\b(?:a|an|the|another|my|our)\s+([a-z][a-z' -]{0,24}?)\s+timers?\b/gi;
  for (let match = article.exec(spoken); match; match = article.exec(spoken)) {
    if (match[1]) add(match[1], match.index);
  }

  const called = /\b(?:called|named)\s+([a-z][a-z' -]{0,24}?)(?=\s+(?:for|in|to|that|and|which)\b|[.,!?;]|$)/gi;
  for (let match = called.exec(spoken); match; match = called.exec(spoken)) {
    if (match[1]) add(match[1], match.index);
  }

  return names.sort((left, right) => left.start - right.start);
}

/**
 * The split Home Assistant will store, and the one a later control call has to replay.
 *
 * Only the slots a start call carried are stored, so nothing here is ever zero: `{minutes:
 * 10}` rather than `{hours: 0, minutes: 10, seconds: 0}`. Seconds only appear when the
 * duration is not a whole number of minutes, because that is how a person says it too.
 */
export function splitOf(totalSeconds: number): Split {
  if (totalSeconds <= 0) return {};
  if (totalSeconds % 60 !== 0) return { seconds: totalSeconds };
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return { minutes };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? { hours } : { hours, minutes: rest };
}

/** A split back as seconds. */
function secondsOf(split: Split): number {
  return (split.hours ?? 0) * 3600 + (split.minutes ?? 0) * 60 + (split.seconds ?? 0);
}

/** "10 minutes", "1 hour 30 minutes", "90 seconds": a length as it is spoken. */
function labelOf(split: Split): string {
  const parts: string[] = [];
  if (split.hours) parts.push(`${split.hours} hour${split.hours === 1 ? '' : 's'}`);
  if (split.minutes) parts.push(`${split.minutes} minute${split.minutes === 1 ? '' : 's'}`);
  if (split.seconds) parts.push(`${split.seconds} second${split.seconds === 1 ? '' : 's'}`);
  return parts.join(' ') || 'that';
}

/** The slots an offered tool actually declares, which is what may be sent to it. */
function declared(tool: OpenAIToolFunction): Set<string> {
  return new Set(Object.keys(tool.parameters?.properties ?? {}));
}

/** Drop any argument the offered tool does not declare: a slot it lacks would be rejected. */
function allowed(slots: Set<string>, args: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null && slots.has(key)) kept[key] = value;
  }
  return kept;
}

/** The `hours`/`minutes`/`seconds` half of `HassStartTimer`, or null when it takes none. */
function startArgs(
  split: Split,
  name: string | undefined,
  slots: Set<string>,
): Record<string, unknown> | null {
  const args = allowed(slots, {
    hours: split.hours,
    minutes: split.minutes,
    seconds: split.seconds,
    name,
  });
  if (args.hours === undefined && args.minutes === undefined && args.seconds === undefined) return null;
  return args;
}

/** The `start_hours`/`start_minutes`/`start_seconds` half of a control call. */
function startStarArgs(split: Split, slots: Set<string>): Record<string, unknown> {
  return allowed(slots, {
    start_hours: split.hours,
    start_minutes: split.minutes,
    start_seconds: split.seconds,
  });
}

/** Whether two timers are the same one, for the ledger. */
function sameTimer(known: StartedTimer, wanted: { name?: string; split?: Split }): boolean {
  if (wanted.name && known.name) return fold(known.name) === fold(wanted.name);
  if (wanted.name || known.name) return false;
  if (!wanted.split) return false;
  return (
    known.split.hours === wanted.split.hours &&
    known.split.minutes === wanted.split.minutes &&
    known.split.seconds === wanted.split.seconds
  );
}

/** Add a timer to the ledger, replacing an identical one and keeping the ledger small. */
function rememberTimer(entry: StartedTimer): void {
  const index = STARTED.findIndex((known) => known.device === entry.device && sameTimer(known, entry));
  if (index >= 0) STARTED.splice(index, 1);
  STARTED.push(entry);
  if (STARTED.length > STARTED_CAP) STARTED.splice(0, STARTED.length - STARTED_CAP);
}

/** Forget the timers a cancel or a cancel-all ended. */
function forgetTimers(device: string, wanted?: { name?: string; split?: Split }): void {
  for (let i = STARTED.length - 1; i >= 0; i -= 1) {
    const known = STARTED[i];
    if (!known || known.device !== device) continue;
    if (wanted && !sameTimer(known, wanted)) continue;
    STARTED.splice(i, 1);
  }
}

/** The ledger's timers this kiosk started that have not run out yet. */
function runningTimers(device: string, now: number): StartedTimer[] {
  for (let i = STARTED.length - 1; i >= 0; i -= 1) {
    const known = STARTED[i];
    if (!known) continue;
    if (known.at + known.seconds * 1000 <= now) STARTED.splice(i, 1);
  }
  return STARTED.filter((known) => known.device === device);
}

/** The ledger's timers, described so the "which one" question can list them. */
function labelsOf(timers: StartedTimer[]): string[] {
  const labels: string[] = [];
  for (const timer of timers) {
    const base = timer.name ? `${timer.name} timer` : `${labelOf(timer.split)} timer`;
    let label = base;
    let copy = 2;
    while (labels.includes(label)) {
      label = `${base} (${copy})`;
      copy += 1;
    }
    labels.push(label);
  }
  return labels;
}

/** A timer sentence: what it asks for, and what it asks about. */
interface Reading {
  kind: Kind;
  /** The timer being controlled, when the sentence says which. */
  name?: string;
  split?: Split;
  /** Lengths the sentence names, when it names more than one. */
  splits?: Split[];
  /** How much to add or take off, for an increase or a decrease. */
  delta?: Split;
  /** The timers one length is started as. */
  starts: { split: Split; name?: string }[];
}

/** "cancel all timers", "stop every timer": every timer of this kiosk in one intent. */
function isCancelAll(lower: string): boolean {
  if (!/\ball\b/.test(lower)) return false;
  if (!/\btimers\b/.test(lower)) return false;
  return /\b(?:cancel|stop|clear|end|delete|remove|kill|get rid of)\b/.test(lower);
}

/** How many timers one length is started as: "set two timers for 10 minutes". */
function countAsked(lower: string): number | null {
  const match = /\b(two|three|four|five|six|couple|both)\s+(?:\w+\s+)?timers?\b/.exec(lower);
  if (!match?.[1]) return null;
  return COUNT_WORDS[match[1]] ?? null;
}

/** The timers a start sentence asks for, one per length, in the order they were said. */
function readStarts(seconds: number[], names: Named[], count: number | null): { split: Split; name?: string }[] {
  const lengths = seconds.filter((value) => value > 0);
  if (lengths.length === 0) return [];

  const pairs: { seconds: number; name?: string }[] = [];
  if (names.length === 0) {
    for (const length of lengths) pairs.push({ seconds: length });
    // "set two timers for 10 minutes": the sampled length, started the number of times asked.
    const wanted = count ?? 1;
    if (pairs.length === 1 && wanted > 1) {
      for (let extra = 1; extra < wanted; extra += 1) pairs.push({ seconds: lengths[0] ?? 0 });
    }
  } else if (names.length === lengths.length) {
    lengths.forEach((length, index) => {
      const named = names[index];
      pairs.push(named ? { seconds: length, name: named.name } : { seconds: length });
    });
  } else if (names.length === 1) {
    const first = names[0];
    lengths.forEach((length, index) => {
      pairs.push(index === 0 && first ? { seconds: length, name: first.name } : { seconds: length });
    });
  } else {
    // More names than lengths: the same length for each name, which is how people say it.
    for (const named of names) pairs.push({ seconds: lengths[0] ?? 0, name: named.name });
  }

  return pairs
    .filter((pair) => pair.seconds > 0)
    .map((pair) => ({ split: splitOf(pair.seconds), ...(pair.name ? { name: pair.name } : {}) }));
}

/**
 * Read a timer sentence into what it asks for, or null when it asks something this reader
 * does not answer.
 *
 * The order of the tests is the order of the verbs: a length with "add" extends, a length with
 * "set" starts, "pause" without a length pauses. A sentence with the word timer and none of
 * them — "what timers are running", "how long is left on the pasta timer" — is left to the
 * model, because only Home Assistant's `TimerManager` knows and its answer is slots, not a
 * sentence this reader could compose.
 */
function readReading(spoken: string, lower: string): Reading | null {
  const spans = readSpans(spoken);
  const names = readNames(spoken);
  const seconds = spans.map((span) => span.seconds);
  const name = names[0]?.name;

  if (isCancelAll(lower)) return { kind: 'cancel_all', starts: [] };

  const creating =
    CREATE.test(lower) || /\b(?:a|an|another)\s+(?:\w+\s+){0,2}?timers?\b/i.test(lower);

  if (seconds.length > 0 && !creating) {
    const adding = ADDING.test(lower);
    const shortening = SHORTENING.test(lower);
    if (adding || shortening) {
      // "add 2 minutes to the 10 minute timer": the first length is the change, a later one
      // that matches a length the ledger knows names the timer it applies to.
      const delta = splitOf(seconds[0] ?? 0);
      if (secondsOf(delta) === 0) return null;
      // The later lengths are the timer the change applies to, when the ledger knows it.
      const later = seconds.slice(1).map((value) => splitOf(value));
      return {
        kind: adding ? 'increase' : 'decrease',
        delta,
        ...(name ? { name } : {}),
        ...(later.length > 0 && !name ? { splits: later } : {}),
        starts: [],
      };
    }
  }

  // A length with a control verb points at the timer it started: "cancel the 10 minute timer".
  if (seconds.length > 0 && !creating) {
    if (/\b(?:pause|hold)\b/.test(lower)) {
      return { kind: 'pause', ...(name ? { name } : {}), splits: seconds.map(splitOf), starts: [] };
    }
    if (/\b(?:resume|unpause|continue|carry on)\b/.test(lower)) {
      return { kind: 'unpause', ...(name ? { name } : {}), splits: seconds.map(splitOf), starts: [] };
    }
    if (/\b(?:cancel|stop|kill|delete|clear|end|get rid of)\b/.test(lower)) {
      return { kind: 'cancel', ...(name ? { name } : {}), splits: seconds.map(splitOf), starts: [] };
    }
  }

  if (seconds.length === 0) {
    if (/\b(?:pause|hold)\b/.test(lower)) return { kind: 'pause', ...(name ? { name } : {}), starts: [] };
    if (/\b(?:resume|unpause|continue|restart|carry on)\b/.test(lower) || /\bstart\b.*\bagain\b/.test(lower)) {
      return { kind: 'unpause', ...(name ? { name } : {}), starts: [] };
    }
    if (/\b(?:cancel|stop|kill|delete|clear|end|get rid of)\b/.test(lower)) {
      return { kind: 'cancel', ...(name ? { name } : {}), starts: [] };
    }
    return null;
  }

  const starts = readStarts(seconds, names, countAsked(lower));
  if (starts.length === 0) return null;
  return { kind: 'start', starts };
}

/**
 * Which running timer a sentence means.
 *
 * A name is the user's own answer, so it wins. A length comes next, because "the 10 minute
 * timer" is how kiosk-satellite's own finding rule describes a timer that was not named. Two
 * timers this kiosk started and no way to tell them apart is the one case worth asking about:
 * Home Assistant's answer to that call is an error, and its error is not a question.
 */
function pickTarget(
  reading: Reading,
  running: StartedTimer[],
  wanted?: Split,
): { name?: string; split?: Split; label: string } | { ask: string[] } {
  if (reading.name) {
    const known = running.find((timer) => timer.name && fold(timer.name) === fold(reading.name!));
    return {
      name: reading.name,
      ...(known ? { split: known.split } : {}),
      label: `${reading.name} timer`,
    };
  }

  const split = wanted ?? reading.split ?? reading.splits?.[0];
  if (split) {
    const seconds = secondsOf(split);
    const known = running.find((timer) => timer.seconds === seconds || secondsOf(timer.split) === seconds);
    if (known) return { split: known.split, label: labelsOf([known])[0] ?? 'that timer' };
    return { split, label: `${labelOf(split)} timer` };
  }

  if (running.length === 1 && running[0]) {
    const only = running[0];
    return { split: only.split, label: labelsOf([only])[0] ?? 'that timer' };
  }
  if (running.length > 1) return { ask: labelsOf(running) };
  // Nothing of this kiosk's is known to be running: Home Assistant itself falls back to the
  // only timer of the device, which is how kiosk-satellite answers "pause my timer".
  return { label: 'the timer' };
}

/** An unmatched call, when the request offers that intent. */
function place(
  kind: Kind,
  args: Record<string, unknown>,
  targets: string[],
  inventory: ToolInventory,
  reason: string,
): TimerDecision | null {
  const tool = findTool(inventory, TOOLS[kind]);
  if (!tool) return null;
  return {
    plan: {
      kind: 'tool',
      tool: tool.name,
      args: allowed(declared(tool.function), args),
      targets,
      action: `timer_${kind}`,
      domain: DOMAIN,
    },
    reason,
  };
}

/**
 * Classify a timer sentence, or return null to leave it to the model.
 *
 * Null is the answer for every sentence this reader is not sure of: a status question, a
 * timer with no length, or a house where Home Assistant offers none of the timer intents.
 */
export function timerPlan({
  utterance,
  inventory,
  config,
  deviceId,
  language,
}: TimerInput): TimerDecision | null {
  const spoken = speechOf(utterance);
  if (!spoken) return null;
  // Every phrase here names a timer: "pause" on its own is the music reader's, and stays so.
  if (!/\btimers?\b/i.test(spoken)) return null;

  const lower = spoken.toLowerCase();
  const reading = readReading(spoken, lower);
  if (!reading) return null;

  const device = deviceId ?? '';
  const now = Date.now();
  const running = runningTimers(device, now);

  if (reading.kind === 'cancel_all') {
    const decision = place(
      'cancel_all',
      {},
      ['all timers'],
      inventory,
      'timers: cancel every timer of this kiosk, no model call',
    );
    if (decision) forgetTimers(device);
    return decision;
  }

  if (reading.kind === 'start') {
    const tool = findTool(inventory, TOOLS.start);
    if (!tool) return null;
    const slots = declared(tool.function);
    const calls: ToolCall[] = [];
    for (const start of reading.starts) {
      const args = startArgs(start.split, start.name, slots);
      if (!args) return null;
      calls.push({
        tool: tool.name,
        args,
        targets: [start.name ? `${start.name} timer` : `${labelOf(start.split)} timer`],
        action: 'timer_start',
        domain: DOMAIN,
      });
    }
    const first = calls[0];
    if (!first) return null;
    const described = reading.starts
      .map((start) => `${start.name ? `"${start.name}" ` : ''}${labelOf(start.split)}`)
      .join(', ');
    const reason =
      calls.length === 1
        ? `timers: start ${described} on this kiosk, no model call`
        : `timers: start ${calls.length} timers in one turn (${described}), no model call`;

    for (const [index, start] of reading.starts.entries()) {
      rememberTimer({
        device,
        ...(start.name ? { name: start.name } : {}),
        split: start.split,
        seconds: secondsOf(start.split),
        at: now + index,
      });
    }

    if (calls.length === 1) return { plan: { kind: 'tool', ...first }, reason };
    return { plan: { kind: 'calls', calls, action: 'timer_start', domain: DOMAIN }, reason };
  }

  const kind = reading.kind;
  const tool = findTool(inventory, TOOLS[kind]);
  if (!tool) return null;
  const slots = declared(tool.function);

  // An increase or a decrease always arrives with a length; a control call never has to.
  if ((kind === 'increase' || kind === 'decrease') && !reading.delta) return null;

  // "cancel the 5 and 10 minute timers": one call per timer the sentence named.
  const wanted = reading.splits && reading.splits.length > 1 ? reading.splits : [undefined];
  const resolved: { name?: string; split?: Split; label: string }[] = [];
  for (const split of wanted) {
    const target = pickTarget(reading, running, split);
    if ('ask' in target) {
      const template = speechTemplates(config, language).clarify;
      const text = template.replace('{options}', target.ask.join(' or '));
      return {
        plan: { kind: 'clarify', text, options: target.ask },
        reason: `timers: ${target.ask.length} timers are running on this kiosk and the sentence named none`,
      };
    }
    resolved.push(target);
  }
  const verbs: Record<Exclude<Kind, 'start' | 'cancel_all'>, string> = {
    cancel: 'cancel',
    pause: 'pause',
    unpause: 'resume',
    increase: 'add',
    decrease: 'take off',
  };
  const verb = verbs[kind];
  const change = reading.delta
    ? `${labelOf(reading.delta)} ${kind === 'increase' ? 'to' : 'from'} `
    : '';
  const described = resolved.map((target) => target.label).join(' and ');
  // A label already reads as a phrase ("the timer"), so it is not given a second article.
  const stated = /^(?:the|that|this)\b/.test(described) ? described : `the ${described}`;
  const reason =
    resolved.length > 1
      ? `timers: ${verb} ${change}${described} in one turn, no model call`
      : `timers: ${verb} ${change}${stated}, no model call`;

  const calls: ToolCall[] = resolved.map((target) => ({
    tool: tool.name,
    args: allowed(slots, {
      ...(target.name ? { name: target.name } : {}),
      ...(target.split ? startStarArgs(target.split, slots) : {}),
      ...(reading.delta
        ? { hours: reading.delta.hours, minutes: reading.delta.minutes, seconds: reading.delta.seconds }
        : {}),
    }),
    targets: [target.label],
    action: `timer_${kind}`,
    domain: DOMAIN,
  }));
  const only = calls[0];
  if (!only) return null;

  if (kind === 'cancel') {
    for (const target of resolved) {
      forgetTimers(device, {
        ...(target.name ? { name: target.name } : {}),
        ...(target.split ? { split: target.split } : {}),
      });
    }
  }

  if (calls.length === 1) return { plan: { kind: 'tool', ...only }, reason };
  return { plan: { kind: 'calls', calls, action: `timer_${kind}`, domain: DOMAIN }, reason };
}
