/**
 * Utterance extraction: numbers, percentages, colours, magnitudes and state words.
 *
 * The decision model answers *what to do*; this module only finds spans a slot can
 * be filled from. A span the model does not pick is simply not used.
 */

export interface ExtractionOptions {
  /** Entity display names, so a media query can strip the target from the utterance. */
  entityNames?: string[];
}

export interface ValueCandidate {
  /** Stable option id for the `value_pick` question. */
  id: string;
  /** What the user actually said. */
  text: string;
  kind: 'percent' | 'number' | 'color' | 'state' | 'item';
  /** Normalised value for the slot. */
  value: string | number;
}

export interface Extraction {
  candidates: ValueCandidate[];
  percent?: number;
  number?: number;
  color?: string;
  stateWord?: string;
  magnitude?: 'slight' | 'moderate' | 'large' | 'maximum';
  /** Free text after a list command ("add milk to the shopping list"). */
  item?: string;
  /** Content to search for and play. */
  mediaQuery?: string;
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
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

export const COLORS: Record<string, string> = {
  red: 'red',
  crimson: 'red',
  orange: 'orange',
  amber: 'amber',
  yellow: 'yellow',
  green: 'green',
  lime: 'green',
  teal: 'teal',
  turquoise: 'turquoise',
  cyan: 'cyan',
  blue: 'blue',
  navy: 'blue',
  indigo: 'indigo',
  violet: 'violet',
  purple: 'purple',
  magenta: 'magenta',
  pink: 'pink',
  white: 'white',
  'warm white': 'warm white',
  'cool white': 'cool white',
  'soft white': 'white',
};

const MAGNITUDES: { words: string[]; magnitude: Extraction['magnitude'] }[] = [
  { words: ['a bit', 'a touch', 'slightly', 'a little', 'a shade', 'just a'], magnitude: 'slight' },
  { words: ['a lot', 'much', 'way', 'considerably', 'significantly', 'a great deal'], magnitude: 'large' },
  { words: ['all the way', 'as far as it goes', 'full blast', 'maximum', 'max'], magnitude: 'maximum' },
];

const STATE_WORDS: Record<string, string> = {
  on: 'on',
  off: 'off',
  open: 'open',
  opened: 'open',
  closed: 'closed',
  close: 'closed',
  unlocked: 'unlocked',
  locked: 'locked',
  playing: 'playing',
  paused: 'paused',
  unavailable: 'unavailable',
};

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function pushUnique(list: ValueCandidate[], candidate: ValueCandidate): void {
  if (!candidate.id) return;
  if (list.some((entry) => entry.id === candidate.id)) return;
  list.push(candidate);
}

export function extract(text: string, options: ExtractionOptions = {}): Extraction {
  const lower = ` ${text.toLowerCase()} `;
  const candidates: ValueCandidate[] = [];
  const out: Extraction = { candidates };

  // Percentages: "30%", "thirty percent", "to 40 percent".
  const percentMatch = lower.match(/(\d{1,3})\s*(?:%|percent|per cent)/);
  if (percentMatch?.[1]) {
    const value = Number(percentMatch[1]);
    out.percent = value;
    pushUnique(candidates, {
      id: `pct_${value}`,
      text: percentMatch[0].trim(),
      kind: 'percent',
      value,
    });
  } else {
    for (const [word, value] of Object.entries(NUMBER_WORDS)) {
      if (new RegExp(`\\b${word}\\s+(?:%|percent|per cent)`, 'i').test(lower)) {
        out.percent = value;
        pushUnique(candidates, { id: `pct_${value}`, text: `${word} percent`, kind: 'percent', value });
        break;
      }
    }
  }

  // Half / quarter / all the way as percentages.
  const fractions: [RegExp, number, string][] = [
    [/\bhalfway\b|\bhalf(?: way)?\b/, 50, 'halfway'],
    [/\bquarter\b/, 25, 'a quarter'],
    [/\bthree quarters\b/, 75, 'three quarters'],
    [/\b(?:all the way|fully|full|completely)\b/, 100, 'all the way'],
  ];
  for (const [pattern, value, label] of fractions) {
    if (pattern.test(lower)) {
      pushUnique(candidates, { id: `pct_${value}`, text: label, kind: 'percent', value });
      out.percent ??= value;
    }
  }

  // Temperatures: "to 21 degrees", "21.5°", "twenty one degrees".
  const degreeMatch = lower.match(/(-?\d{1,3}(?:[.,]\d)?)\s*(?:°|degrees?|deg\b)/);
  if (degreeMatch?.[1]) {
    const value = Number(degreeMatch[1].replace(',', '.'));
    out.number = value;
    pushUnique(candidates, { id: `num_${value}`, text: degreeMatch[0].trim(), kind: 'number', value });
  } else {
    for (const [word, value] of Object.entries(NUMBER_WORDS)) {
      if (new RegExp(`\\b${word}\\s+(?:degrees?|deg\\b)`, 'i').test(lower)) {
        out.number = value;
        pushUnique(candidates, { id: `num_${value}`, text: `${word} degrees`, kind: 'number', value });
        break;
      }
    }
  }

  // Colours.
  for (const [word, value] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      out.color ??= value;
      pushUnique(candidates, { id: `color_${slug(value)}`, text: word, kind: 'color', value });
    }
  }

  // Magnitudes.
  for (const { words, magnitude } of MAGNITUDES) {
    if (words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower))) {
      const current = out.magnitude;
      // "a bit" loses to a later "all the way"; large/maximum beat slight.
      const rank = { slight: 1, moderate: 2, large: 3, maximum: 4 } as const;
      if (!current || rank[magnitude!] > rank[current]) out.magnitude = magnitude;
      break;
    }
  }

  // State words, for "are the lights on" style queries.
  for (const [word, state] of Object.entries(STATE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      out.stateWord ??= state;
      pushUnique(candidates, { id: `state_${slug(state)}`, text: word, kind: 'state', value: state });
    }
  }

  // Free text the decision model can pick for a slot that needs it: list items
  // ("add milk to the shopping list") and media queries ("play jazz on the
  // kitchen speaker"). Without these the todo/media actions can never fire.
  const item = extractListItem(text);
  if (item) {
    out.item = item;
    pushUnique(candidates, { id: `item_${slug(item)}`, text: item, kind: 'item', value: item });
  }
  const mediaQuery = extractMediaQuery(text, options.entityNames ?? []);
  if (mediaQuery) {
    out.mediaQuery = mediaQuery;
    pushUnique(candidates, { id: `item_${slug(mediaQuery)}`, text: mediaQuery, kind: 'item', value: mediaQuery });
  }

  return out;
}

/** Pull the free-text item out of a list command: "add milk to the shopping list". */
export function extractListItem(text: string): string | undefined {
  const patterns = [
    /^\s*(?:add|put|append)\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?[\w\s]*list\b/i,
    /^\s*(?:mark|check|tick)\s+(.+?)\s+(?:as\s+)?(?:done|off|complete|bought)\b/i,
    /^\s*(?:remove|delete|take)\s+(.+?)\s+(?:from|off)\s+(?:the\s+)?[\w\s]*list\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/** Pull the media query out of "play some jazz on the kitchen speaker". */
export function extractMediaQuery(text: string, entityNames: string[]): string | undefined {
  let rest = text;
  for (const name of entityNames) {
    rest = rest.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  const match = rest.match(/\b(?:play|stream|put on)\s+(.+?)(?:\s+(?:on|in|at)\s+.*)?$/i);
  if (!match?.[1]) return undefined;
  const query = match[1].replace(/\b(?:the|a|an|some|music|track|song|please|now)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return query.length > 1 ? query : undefined;
}
