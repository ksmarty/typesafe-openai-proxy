/**
 * Reminders, said the way people say them.
 *
 * Home Assistant needs a conversation agent to decide *which* tool to call, and a reminder
 * sentence has nothing to decide: "remind me to take out the trash in 30 minutes" is a
 * `ReminderCreate` with a title and a duration, and every word of it is already in the
 * sentence. Sending it to the model buys a round trip and a chance to misread the title.
 *
 * So this reader does the classification itself, the way `music.ts` and `clock.ts` do theirs,
 * and answers with the integration's own tool call. There is no model call anywhere in this
 * file, which is the whole point: a reminder is understood, not guessed at.
 *
 * What it reads, in the vocabulary `ha-reminders` declares:
 *
 *  - `ReminderCreate` — "remind me to water the plants in 30 minutes" (`minutes`),
 *    "… at 7 am" (`time`, which the integration repeats daily), "… when I get home"
 *    (`direction: enter` + `zone`), "… when I leave work" (`direction: leave` + `zone`).
 *  - `ReminderList` — "list my reminders", "what reminders do I have".
 *  - `ReminderComplete` — "complete reminder water the plants", "mark reminder … as done".
 *  - `ReminderSnooze` — "snooze reminder water the plants for 10 minutes".
 *  - `ReminderDelete` — "delete reminder water the plants", "delete reminder number 2".
 *
 * Two deliberate choices:
 *
 *  1. **Duration and time are converted, not passed through.** The integration accepts
 *     `minutes` as a number and `time` as `8pm` or `20:00` and nothing else — a bare "at 8",
 *     "noon" or "half an hour" is rejected by its own parsers (`util.py`). This reader turns
 *     what was said into the shape the integration understands, so a sentence that used to
 *     fail its validation now works.
 *  2. **Anything it cannot place is forwarded.** "remind me to call the plumber" names no
 *     time, and the integration's answer to that is a clarification, not a call: the model
 *     can ask the follow-up question, so the sentence is left to it. A reader that guessed
 *     "in 15 minutes" would create a reminder nobody asked for.
 *
 * The integration is only used when the request offers its tools — `ha_reminders__*` is what
 * Home Assistant puts in `tools[]` when it is installed — so a house without ha-reminders
 * behaves exactly as before.
 */

import { clockNow } from './clock.js';
import type { Config } from './config.js';
import { findTool, type ToolInventory } from './toolcall.js';
import type { ToolCallPlan } from './types.js';

/** The intents ha-reminders registers with Home Assistant's LLM API. */
const TOOLS = {
  create: 'ReminderCreate',
  list: 'ReminderList',
  complete: 'ReminderComplete',
  snooze: 'ReminderSnooze',
  delete: 'ReminderDelete',
} as const;

type Kind = keyof typeof TOOLS;

/** The domain the integration's tools are namespaced under. */
const DOMAIN = 'ha_reminders';

export interface ReminderDecision {
  plan: ToolCallPlan;
  /** Why the trace shows this turn was decided here rather than by the model. */
  reason: string;
}

export interface ReminderInput {
  utterance: string;
  inventory: ToolInventory;
  config: Config;
  /** Home Assistant's system prompt, for the clock a bare "at 7" is resolved against. */
  systemPrompt?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** Minutes in one of the units a duration may be spoken in. */
const UNIT_MINUTES: Record<string, number> = {
  minute: 1,
  minutes: 1,
  min: 1,
  mins: 1,
  hour: 60,
  hours: 60,
  hr: 60,
  hrs: 60,
  day: 1440,
  days: 1440,
  week: 10080,
  weeks: 10080,
};

/** The integration validates `minutes` as a slot range of 1..10080 (one week). */
const MIN_MINUTES = 1;
const MAX_MINUTES = 10080;

/**
 * The sentence as the reader compares it: single-spaced, no trailing punctuation, straight
 * apostrophes.
 *
 * The case is left alone on purpose. A title is spoken back to the user in a notification, so
 * "remind me to email Dr. Chen in 2 hours" must keep "Dr. Chen" — every pattern below therefore
 * matches case-insensitively instead of lowercasing the sentence first. Colons and digits are
 * kept too: "8:30 pm" has to survive to be read as a time.
 */
function speechOf(utterance: string): string {
  return utterance
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;]+$/g, '')
    .trim();
}

/** A spoken or numeric amount: "30", "thirty", "half", "an", "one and a half". */
export function parseAmount(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (!cleaned) return null;

  const numeric = /^\d+(?:\.\d+)?$/.exec(cleaned);
  if (numeric) return Number(numeric[0]);

  if (cleaned === 'half' || cleaned === 'a half' || cleaned === 'half an' || cleaned === 'half a') {
    return 0.5;
  }
  if (cleaned === 'a' || cleaned === 'an' || cleaned === 'one') return 1;

  const andHalf = /^(.+?)\s+and\s+a\s+half$/.exec(cleaned);
  if (andHalf?.[1] !== undefined) {
    const base = parseAmount(andHalf[1]);
    return base === null ? null : base + 0.5;
  }

  let total = 0;
  let seen = false;
  for (const word of cleaned.split(' ')) {
    if (word === 'and') continue;
    const value = NUMBER_WORDS[word] ?? TENS_WORDS[word];
    if (value === undefined) return null;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

/** "30 minutes", "half an hour", "two days" as a number of minutes, or null. */
export function parseDuration(text: string): number | null {
  const match = /^(.+?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)$/.exec(
    text.trim().toLowerCase().replace(/\s+/g, ' '),
  );
  if (!match?.[1] || !match[2]) return null;
  const amount = parseAmount(match[1]);
  const unit = UNIT_MINUTES[match[2]];
  if (amount === null || unit === undefined) return null;
  const minutes = Math.round(amount * unit);
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;
  return minutes;
}

function hhmm(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Resolve an hour and minute to minutes past midnight, choosing *when* a bare hour means.
 *
 * "at 7" is the next seven, morning or evening, whichever comes first; "at 7 pm" is
 * unambiguous. The clock is the one `clockNow` reads, which is Home Assistant's own time.
 */
function resolveMinutes(
  hour: number,
  minute: number,
  meridiem: 'am' | 'pm' | undefined,
  now: Date,
): number | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const hours = meridiem === 'am' ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
    return hours * 60 + minute;
  }

  if (hour > 23) return null;
  if (hour > 12) return hour * 60 + minute;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const morning = hour * 60 + minute;
  const evening = (hour + 12) * 60 + minute;
  const ordered = [morning, evening].sort((a, b) => a - b);
  for (const value of ordered) {
    if (value > nowMinutes) return value;
  }
  // Both have passed today, so the sentence means tomorrow: the morning one is next.
  return morning;
}

/**
 * A time of day as `HH:MM`, which is the shape the integration's `parse_time_text` accepts.
 *
 * Reads what people actually say — "8 pm", "8:30pm", "20:00", "noon", "midnight",
 * "quarter past seven", "half past 8 in the evening" — because the integration reads none of
 * those but the last two shapes.
 */
export function parseClockText(text: string, now: Date): string | null {
  let spoken = text.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!spoken) return null;

  let meridiem: 'am' | 'pm' | undefined;
  const partOfDay = /\s+in the\s+(morning|afternoon|evening|night)$/.exec(spoken);
  if (partOfDay?.[1]) {
    meridiem = partOfDay[1] === 'morning' ? 'am' : 'pm';
    spoken = spoken.slice(0, partOfDay.index).trim();
  }

  if (spoken === 'noon' || spoken === 'midday') return '12:00';
  if (spoken === 'midnight') return '00:00';

  const relative = /^(quarter|half)\s+(past|to)\s+(.+)$/.exec(spoken);
  if (relative?.[1] && relative[2] && relative[3]) {
    const base = parseHour(relative[3], meridiem, now);
    if (base === null) return null;
    const shift = relative[1] === 'quarter' ? 15 : 30;
    return hhmm(relative[2] === 'past' ? base + shift : base - shift);
  }

  const total = parseHour(spoken, meridiem, now);
  return total === null ? null : hhmm(total);
}

/** "8", "8:30", "8 pm", "8:30 pm" as minutes past midnight. */
function parseHour(text: string, meridiem: 'am' | 'pm' | undefined, now: Date): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const written = (match[3] as 'am' | 'pm' | undefined) ?? meridiem;
  return resolveMinutes(hour, minute, written, now);
}

/** Strip the scaffolding a title may still carry: "to …", "please", trailing "as done". */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^(?:to|that|about)\s+/i, '')
    .replace(/\s+(?:as\s+)?(?:done|complete|completed|finished)$/i, '')
    .replace(/\s+(?:please|for me|thanks|thank you)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A bare number in a delete: "2", "two", "second". */
function parseIndex(text: string): number | null {
  const cleaned = text.trim().toLowerCase();
  const numeric = /^\d+$/.exec(cleaned);
  if (numeric) return Number(numeric[0]);
  return NUMBER_WORDS[cleaned] ?? ORDINAL_WORDS[cleaned] ?? null;
}

interface CreateArgs {
  args: Record<string, unknown>;
  /** How the trace should describe what was understood. */
  note: string;
}

/**
 * Read a creation sentence into the integration's slots.
 *
 * The trigger decides the shape: a zone is `direction` + `zone`, a duration is `minutes`, a
 * time of day is `time`. A sentence with none of the three returns null and is forwarded,
 * because the right answer is the follow-up question, not a guess.
 */
function readCreate(spoken: string, now: Date): CreateArgs | null {
  // "remind me in 10 minutes to take out the trash" — the reverse of the usual order.
  const reversed =
    /^(?:please\s+)?(?:remind me|set (?:a|the|another) reminder|add (?:a|the|another) reminder|create (?:a|the|another) reminder|make (?:a|the|another) reminder)\s+in\s+(.+?)\s+(?:to|that|about)\s+(.+)$/i.exec(
      spoken,
    );
  if (reversed?.[1] && reversed[2]) {
    const minutes = parseDuration(reversed[1]);
    const title = cleanTitle(reversed[2]);
    if (minutes !== null && title) {
      return { args: { title, minutes }, note: `"${title}" in ${minutes} minutes` };
    }
  }

  const after =
    /^(?:please\s+|hey\s+|ok(?:ay)?\s+|so\s+|and\s+)*(?:can you |could you |would you |will you |i want you to |i need you to |i'd like you to )*(?:remind me|set (?:a|the|another) reminder|add (?:a|the|another) reminder|create (?:a|the|another) reminder|make (?:a|the|another) reminder|new reminder)\s+(.+)$/i.exec(
      spoken,
    )?.[1];
  if (!after) return null;

  // The place may be named first: "remind me when I get home to unpack the shopping" puts
  // the title after the zone, so that order is read before the usual one.
  const zoneFirst =
    /^when\s+(?:i|we)\s+(get|arrive|come|return|walk|leave|go|head out|set off|depart|exit)\b(?:\s+(?:to|at|in|into|back to|from|out of))?\s+(.+?)\s+to\s+(.+)$/i.exec(
      after,
    );
  if (zoneFirst?.[1] && zoneFirst[2] && zoneFirst[3]) {
    const direction = /^(?:get|arrive|come|return|walk)$/i.test(zoneFirst[1]) ? 'enter' : 'leave';
    const title = cleanTitle(zoneFirst[3]);
    const zone = cleanTitle(zoneFirst[2]);
    if (title && zone) {
      return {
        args: { title, direction, zone },
        note: direction === 'enter' ? `"${title}" when arriving at ${zone}` : `"${title}" when leaving ${zone}`,
      };
    }
  }

  const rest = after.replace(/^(?:to|that|about)\s+/i, '');

  // A place, first: "when I get home" is a zone trigger, whatever follows the zone name.
  const enter = /\s+when (?:i|we)\s+(?:get|arrive|come|return|walk)\b(?:\s+(?:to|at|in|into|back to))?\s+(.+)$/i.exec(
    rest,
  );
  if (enter?.[1]) {
    const title = cleanTitle(rest.slice(0, enter.index));
    const zone = cleanTitle(enter[1]);
    if (title && zone) {
      return { args: { title, direction: 'enter', zone }, note: `"${title}" when arriving at ${zone}` };
    }
  }

  const leave = /\s+when (?:i|we)\s+(?:leave|go|head out|set off|depart|exit)\b(?:\s+(?:from|out of))?\s+(.+)$/i.exec(
    rest,
  );
  if (leave?.[1]) {
    const title = cleanTitle(rest.slice(0, leave.index));
    const zone = cleanTitle(leave[1]);
    if (title && zone) {
      return { args: { title, direction: 'leave', zone }, note: `"${title}" when leaving ${zone}` };
    }
  }

  // "in 30 minutes" — only when the tail really is a duration, so "at 8 in the evening"
  // falls through to the clock below instead of being read as a number of minutes. The split
  // is at the *last* " in ", because a title may well contain one: "check in at the hotel".
  const relative = /^(.*)\s+in\s+(.+)$/i.exec(rest);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const minutes = parseDuration(relative[2].replace(/\s+from now$/i, ''));
    const title = cleanTitle(relative[1]);
    if (minutes !== null && title) {
      return { args: { title, minutes }, note: `"${title}" in ${minutes} minutes` };
    }
  }

  const absolute = /^(.*)\s+at\s+(.+)$/i.exec(rest);
  if (absolute?.[1] !== undefined && absolute[2] !== undefined) {
    const time = parseClockText(absolute[2], now);
    const title = cleanTitle(absolute[1]);
    if (time && title) {
      return { args: { title, time }, note: `"${title}" every day at ${time}` };
    }
  }

  return null;
}

/** "list my reminders", "what reminders do I have", "reminders". */
function isList(spoken: string): boolean {
  if (!/\breminders?\b/i.test(spoken)) return false;
  return (
    /^(?:please\s+)?(?:list|show|read|tell me|give me|say)\b/i.test(spoken) ||
    /^(?:my|our|the)?\s*reminders?$/i.test(spoken) ||
    /\bwhat (?:are|were) (?:my|our|the) reminders?\b/i.test(spoken) ||
    /\bwhat reminders? (?:do|did|have|are|should)\b/i.test(spoken) ||
    /\b(?:any|my|our) reminders? (?:today|left|still)\b/i.test(spoken)
  );
}

/** "complete reminder …", "mark reminder … as done", "I finished reminder …". */
function readComplete(spoken: string): string | null {
  const patterns = [
    /^(?:please\s+)?(?:complete|finish|check off|tick off)\s+(?:the\s+|my\s+)?reminder\s+(.+)$/i,
    /^(?:please\s+)?mark\s+(?:the\s+|my\s+)?reminder\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/i,
    /^(?:please\s+)?(?:i\s+)?(?:finished|completed|did)\s+(?:the\s+|my\s+)?reminder\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(spoken);
    const title = match?.[1] ? cleanTitle(match[1]) : '';
    if (title) return title;
  }
  return null;
}

/** "delete reminder …", "delete reminder number 2", "remove reminder two". */
function readDelete(spoken: string): Record<string, unknown> | null {
  const match =
    /^(?:please\s+)?(?:delete|remove|cancel|drop|get rid of)\s+(?:the\s+|my\s+)?reminder\s+(.+)$/i.exec(spoken);
  if (!match?.[1]) return null;
  const tail = match[1].trim();
  const numbered = /^(?:number|no|#)\s+(.+)$/i.exec(tail);
  if (numbered?.[1]) {
    const index = parseIndex(numbered[1]);
    return index === null ? null : { number: index };
  }
  const bare = parseIndex(tail);
  if (bare !== null) return { number: bare };
  const title = cleanTitle(tail);
  return title ? { title } : null;
}

/** "snooze reminder … for 10 minutes", "snooze reminder …" (the integration defaults to 15). */
function readSnooze(spoken: string): Record<string, unknown> | null {
  const match = /^(?:please\s+)?snooze\s+(?:the\s+|my\s+)?reminder\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(spoken);
  if (!match?.[1]) return null;
  const title = cleanTitle(match[1]);
  if (!title) return null;
  if (match[2] === undefined) return { title };
  const minutes = parseDuration(match[2].replace(/^(?:the next|another)\s+/i, ''));
  return minutes === null ? null : { title, minutes };
}

/**
 * Turn a refusal-free reading into a tool call, when the request offers that tool.
 *
 * A request without ha-reminders carries none of these names, and then this returns null:
 * the reader never invents a call Home Assistant would reject.
 */
function place(kind: Kind, args: Record<string, unknown>, inventory: ToolInventory, reason: string): ReminderDecision | null {
  const tool = findTool(inventory, TOOLS[kind]);
  if (!tool) return null;
  const title = typeof args.title === 'string' ? args.title : undefined;
  const number = typeof args.number === 'number' ? String(args.number) : undefined;
  const targets = title ? [title] : number ? [number] : [];
  return {
    plan: {
      kind: 'tool',
      tool: tool.name,
      args,
      targets,
      action: `reminder_${kind}`,
      domain: DOMAIN,
    },
    reason,
  };
}

/**
 * Classify a reminder sentence, or return null to leave it to the model.
 *
 * Null is the answer for every sentence this reader is not sure of — a reminder with no
 * time, a sentence that merely mentions reminders, or a house where the integration is not
 * installed. Nothing is ever refused here; it is either understood or forwarded.
 */
export function reminderPlan({ utterance, inventory, config, systemPrompt }: ReminderInput): ReminderDecision | null {
  const spoken = speechOf(utterance);
  if (!spoken) return null;
  if (!/\breminders?\b/i.test(spoken) && !/^remind me\b/i.test(spoken)) return null;

  const now = clockNow(config.clock, systemPrompt);

  if (isList(spoken)) {
    return place('list', {}, inventory, 'reminders: read back the list from ha-reminders, no model call');
  }

  const create = readCreate(spoken, now);
  if (create) {
    return place('create', create.args, inventory, `reminders: ${create.note} via ha-reminders, no model call`);
  }

  const complete = readComplete(spoken);
  if (complete) {
    return place('complete', { title: complete }, inventory, `reminders: complete "${complete}", no model call`);
  }

  const snooze = readSnooze(spoken);
  if (snooze) {
    const title = String(snooze.title ?? '');
    const minutes = typeof snooze.minutes === 'number' ? ` for ${snooze.minutes} minutes` : '';
    return place('snooze', snooze, inventory, `reminders: snooze "${title}"${minutes}, no model call`);
  }

  const remove = readDelete(spoken);
  if (remove) {
    const what = typeof remove.title === 'string' ? `"${remove.title}"` : `number ${String(remove.number)}`;
    return place('delete', remove, inventory, `reminders: delete ${what}, no model call`);
  }

  return null;
}
