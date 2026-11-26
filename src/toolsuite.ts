/**
 * The Tools for Assist integration (llm_intents): travel time, first of all.
 *
 * [Tools for Assist](https://github.com/skye-harris/llm_intents) registers its own tools with
 * Home Assistant's LLM API — `get_route`, `find_places`, `search_web`, `get_weather_forecast`,
 * `search_wikipedia`, `calculate`, `unit_convert`, `search_youtube`, `play_video`,
 * `get_device_history_context`, `calendar_day_info` — and Home Assistant offers them to the
 * model server exactly like its own intents, under the API's name (`llm_intents__get_route`).
 *
 * Two things follow from that. The proxy is not the tool runner here: Home Assistant runs the
 * call against Google, Wikipedia, Brave and the rest, so its result is a *live* answer and this
 * module only ever formats it. Nothing in this file caches a result, and the proxy never
 * replays one: a travel time that is a minute old is a wrong travel time, and the decision
 * cache refuses questions for the same reason. The integration caches its Places lookups and
 * its YouTube searches; the Routes API call itself is made afresh every time, with
 * `routingPreference: TRAFFIC_AWARE`, which is what makes the number include traffic.
 *
 * And the proxy can *ask* for one of those tools before the model is consulted. "How long to
 * get to the airport?" is a tool call with two arguments, not something to reason about, so
 * `readTravelQuestion` reads it here and the pipeline emits `get_route` directly. The route
 * itself still comes from Home Assistant and Google — the fast path only saves the model round
 * trip.
 *
 * The reader is deliberately narrow: it answers when it recognises a travel question and can
 * name the destination, and returns `null` otherwise, so an utterance it cannot place is
 * forwarded exactly as it was before this file existed.
 */

export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT' | 'TWO_WHEELER';

export interface TravelQuestion {
  /** The destination, as the person said it: "the airport", "Tesco on Mill Road". */
  destination: string;
  /** The mode the sentence itself named, if any. */
  mode?: TravelMode;
}

/** Tools the integration registers. Everything else offered is Home Assistant's own. */
const TOOLS_FOR_ASSIST = new Set([
  'get_route',
  'find_places',
  'search_web',
  'get_weather_forecast',
  'search_wikipedia',
  'search_youtube',
  'play_video',
  'calculate',
  'unit_convert',
  'get_device_history_context',
  'calendar_day_info',
]);

/**
 * The tool's own name, without the API prefix Home Assistant adds.
 *
 * `llm_intents__get_route` is how it appears in `tools[]`; `get_route` is how the integration
 * names it and how the speech rules are written, so both spellings have to work here.
 */
function shortName(tool: string): string {
  const index = tool.lastIndexOf('__');
  return index === -1 ? tool : tool.slice(index + 2);
}

/** Is this tool name one the Tools for Assist integration provides? */
export function isToolsForAssistTool(tool: string | undefined): boolean {
  return Boolean(tool) && TOOLS_FOR_ASSIST.has(shortName(tool as string));
}

/** Lower case, punctuation and runs of space removed: what the readers match against. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Question openings that name a journey, longest first so "how long does it take to get to"
 * is tried before "how long to" and leaves nothing of itself behind.
 */
const OPENINGS: string[] = [
  'how long does it take to get to',
  'how long will it take to get to',
  'how long would it take to get to',
  'how long does it take to drive to',
  'how long does it take to walk to',
  'how long does it take to cycle to',
  'how long does it take to get',
  'how long will it take to',
  'how long is the drive to',
  'how long is the walk to',
  'how long is the ride to',
  "how long's the drive to",
  "how long's the ride to",
  'how long to get to',
  'how long to go to',
  'how long to drive to',
  'how long to walk to',
  'how long to cycle to',
  'how long to travel to',
  'how far is it from here to',
  'how far is it to',
  'how far away is',
  'how far is',
  'what is the traffic like on the way to',
  "what's the traffic like on the way to",
  'what is the traffic like to',
  "what's the traffic like to",
  'how is the traffic to',
  "how's the traffic to",
  'when should i leave to get to',
  'when should i leave for',
  'what is the quickest way to',
  "what's the quickest way to",
  'what is the fastest way to',
  "what's the fastest way to",
];

/** A sentence opening on one of these is a command, not a question about a journey. */
const COMMAND =
  /^(set|turn|open|close|start|stop|play|pause|send|add|remind|tell|make|put|dim|lock|unlock|mute|cancel|delete|remove|drive|take|navigate)\b/;

/** Something in the house answers to this word, so the sentence is about the house. */
const DEVICE_WORD =
  /\b(lamp|light|lights|bulb|plug|socket|switch|fan|blind|blinds|curtain|heater|thermostat|radiator|door|lock|garage|vacuum|speaker|tv|television|kettle|oven|dishwasher|washing machine)\b/;

const MODES: [RegExp, TravelMode][] = [
  [/\b(on foot|walk|walking|by foot)\b/, 'WALK'],
  [/\b(bike|bicycle|cycle|cycling)\b/, 'BICYCLE'],
  [/\b(public transport|transit|bus|train|tram|subway|metro)\b/, 'TRANSIT'],
  [/\b(motorbike|motorcycle|scooter|moped)\b/, 'TWO_WHEELER'],
  [/\b(drive|driving|by car|car)\b/, 'DRIVE'],
];

/** Trailing noise a person adds to a spoken question, not part of the destination. */
const TRAILERS: [RegExp, string][] = [
  [/\s+(please|thanks|thank you)$/, ''],
  [/\s+(right now|at the moment|now|today)$/, ''],
  [/\s+from (here|home|work|the office)$/, ''],
  [/\s+(by car|by bus|by train|on foot|by bike|by bicycle)$/, ''],
];

/** A destination that is really a time, a duration or an aside, not a place. */
const NOT_A_PLACE =
  /^(it|that|this|there|here|long|far|mins?|minutes?|hours?|about|roughly|approximately|me|us|now)$/;

/**
 * Read a travel question, or `null` when this is not one.
 *
 * `houseNames` are the entity and area names (and aliases) in the catalog: a sentence that
 * mentions one of them is about the house — "how long has the hall light been on?" — and is
 * left to the model rather than sent to Google as a destination.
 */
export function readTravelQuestion(text: string, houseNames: string[] = []): TravelQuestion | null {
  const spoken = normalise(text);
  if (!spoken) return null;
  if (COMMAND.test(spoken)) return null;
  if (DEVICE_WORD.test(spoken)) return null;
  for (const name of houseNames) {
    const value = normalise(name);
    if (value.length > 2 && spoken.includes(value)) return null;
  }

  const opening = OPENINGS.find((phrase) => spoken.startsWith(phrase));
  if (!opening) return null;

  let rest = spoken.slice(opening.length).trim();
  // "how long to drive to tesco": the opening stopped before the verb the sentence named.
  rest = rest.replace(/^(get|go|drive|walk|cycle|ride|travel|commute|leave)\b\s*/, '');
  rest = rest.replace(/^to\s+/, '');
  for (const [pattern, replacement] of TRAILERS) rest = rest.replace(pattern, replacement).trim();
  rest = rest.replace(/\s+/g, ' ').trim();
  if (!rest) return null;
  if (NOT_A_PLACE.test(rest)) return null;
  // A destination is a name, not a paragraph; and a bare number is not one either.
  if (rest.split(' ').length > 8) return null;
  if (!/\p{L}/u.test(rest)) return null;

  const mode = MODES.find(([pattern]) => pattern.test(spoken))?.[1];
  return { destination: rest, ...(mode ? { mode } : {}) };
}

/**
 * The arguments for `get_route`.
 *
 * `departure_time` is left out on purpose: omitted means "now", and now is the only journey
 * this reader understands. A sentence about leaving later ("… tomorrow at eight") is not
 * recognised above, so it is forwarded and the model can fill the argument in itself.
 */
export function travelArgs(question: TravelQuestion, configured: string): Record<string, unknown> {
  const chosen = question.mode ?? (MODES.find(([, mode]) => mode === configured.toUpperCase())?.[1] ?? undefined);
  return {
    destination: question.destination,
    ...(chosen ? { mode: chosen } : {}),
  };
}

/** English only: these sentences are composed here, and a wrong-language one is worse. */
function speaksEnglish(language: string | undefined): boolean {
  return !language || /^en\b/i.test(language.replace('_', '-'));
}

const DISTANCE_UNITS: Record<string, [string, string]> = {
  mi: ['mile', 'miles'],
  km: ['kilometre', 'kilometres'],
  ft: ['foot', 'feet'],
  m: ['metre', 'metres'],
};

/** "8.4 mi" reads as "mi" to a speech engine; it should read as "8.4 miles". */
function spokenDistance(value: string): string {
  const match = /^([\d.,]+)\s*([a-z]+)$/i.exec(value.trim());
  if (!match) return value;
  const [, raw, unit] = match;
  const pair = DISTANCE_UNITS[(unit ?? '').toLowerCase()];
  if (!pair || !raw) return value;
  const number = Number(raw.replace(/,/g, ''));
  return `${raw} ${number === 1 ? pair[0] : pair[1]}`;
}

/** `8`, `226.8`, `0.5`: a number a speech engine reads without stumbling. */
function spokenNumber(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return String(value).trim();
  return String(Math.round(number * 100) / 100);
}

/** `fluid_ounce` → "fluid ounces", `ml` → "ml": a unit as it is said out loud. */
function spokenUnit(unit: string): string {
  const words = unit.replace(/_/g, ' ').trim();
  if (!words) return '';
  if (words === 'ml' || words === 'celsius' || words === 'fahrenheit') return words;
  return /s$/.test(words) ? words : `${words}s`;
}

function sentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const body = trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
}

interface RouteResult {
  destination?: string;
  destination_name?: string;
  destination_query?: string;
  distance?: string;
  duration?: string;
  duration_without_traffic?: string;
  travel_mode?: string;
}

/**
 * A sentence for a route, from the tool result Home Assistant sent back.
 *
 * `{"result": {...}}` is the shape the integration returns; an error is `{"error": "..."}`,
 * which says nothing rather than "no route found" in a voice nobody asked for.
 */
export function speakRoute(data: unknown, args?: Record<string, unknown>): string {
  const payload = (data ?? {}) as Record<string, unknown>;
  if (typeof payload.error === 'string' && payload.error.trim()) return '';
  const route = (payload.result ?? payload) as RouteResult;
  const duration = typeof route.duration === 'string' ? route.duration.trim() : '';
  if (!duration) return '';
  const destination =
    (typeof route.destination_name === 'string' && route.destination_name.trim()) ||
    (typeof route.destination_query === 'string' && route.destination_query.trim()) ||
    (typeof route.destination === 'string' && route.destination.trim()) ||
    (typeof args?.destination === 'string' && args.destination.trim()) ||
    '';
  const distance = typeof route.distance === 'string' && route.distance.trim() ? spokenDistance(route.distance.trim()) : '';
  const where = destination ? ` to ${destination}` : '';
  const far = distance ? `, ${distance}` : '';
  return sentence(`It's ${duration}${where}${far}`);
}

/**
 * A call one of the suite's readers worked out, before the tool inventory is consulted.
 *
 * `tool` is the integration's own name (`search_web`, not `llm_intents__search_web`): the
 * pipeline looks the offered spelling up in the inventory, exactly as it does for `get_route`.
 */
export interface SuiteQuestion {
  tool: 'search_web' | 'search_wikipedia' | 'calculate' | 'unit_convert' | 'find_places';
  args: Record<string, unknown>;
  /** The thing asked about, for the trace line: the query, the expression, the place. */
  about: string;
}

/** Lower case, with the arithmetic kept: what the maths readers match against. */
function maths(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+\-*/%().\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Openings that introduce a sum rather than a question about the house. */
const CALC_OPENINGS = [
  'what is',
  "what's",
  'whats',
  'how much is',
  'how much does',
  'calculate',
  'work out',
  'solve',
];

/** Words for arithmetic, replaced by the operator `calculate` understands. */
const SUM_WORDS: [RegExp, string][] = [
  [/\bmultiplied by\b/g, '*'],
  [/\bto the power of\b/g, '**'],
  [/\bdivided by\b/g, '/'],
  [/\bpercent of\b/g, '*0.01*'],
  [/\bpercent\b/g, '*0.01'],
  [/\bsquared\b/g, '**2'],
  [/\bcubed\b/g, '**3'],
  [/\btimes\b/g, '*'],
  [/\bplus\b/g, '+'],
  [/\bminus\b/g, '-'],
  [/\bmod\b/g, '%'],
  [/% of\b/g, '*0.01*'],
  [/(\d)\s*x\s*(\d)/g, '$1*$2'],
];

/** Number words as values, so "two plus two" becomes something to calculate. */
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
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** The scales a spoken number can carry: "three hundred and five". */
const SCALE_WORDS: Record<string, number> = { hundred: 100, thousand: 1000 };

/**
 * Spoken numbers as digits: "what's two plus two" -> "2+2".
 *
 * People say their sums, and speech only hands over digits when they are written down.
 * A run of number words is read as one number ("twenty two" is 22, not 20 and 2); "and"
 * joins a scaled number ("one hundred and five") because that is the only place it appears
 * inside a number, so "two and two" stays two numbers and the expression is refused below
 * rather than silently becoming 22.
 */
function digitiseNumbers(text: string): string {
  const tokens = text.split(' ');
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const first = tokens[index] ?? '';
    if (!(first in NUMBER_WORDS) && !(first in SCALE_WORDS)) {
      out.push(first);
      index += 1;
      continue;
    }
    let value = 0;
    let scaled = false;
    while (index < tokens.length) {
      const token = tokens[index] ?? '';
      const next = tokens[index + 1] ?? '';
      if (token in NUMBER_WORDS) {
        value += NUMBER_WORDS[token] as number;
        index += 1;
      } else if (token in SCALE_WORDS) {
        value = (value || 1) * (SCALE_WORDS[token] as number);
        scaled = true;
        index += 1;
      } else if (token === 'and' && scaled && (next in NUMBER_WORDS || next in SCALE_WORDS)) {
        index += 1;
      } else break;
    }
    out.push(String(value));
  }
  return out.join(' ');
}

/** An expression `calculate`'s AST walk will accept, and nothing else. */
const SAFE_EXPRESSION = /^[-+*/().\d%]+$/;

/**
 * Read "what's 12 times 8?" as a calculator expression.
 *
 * The expression is built from the words themselves — `times` becomes `*`, `15% of` becomes
 * `*0.01*` — and then checked against the operator set the integration's safe evaluator
 * allows, so a sentence that carries any word this reader did not translate is refused
 * instead of being sent as a broken expression.
 */
function readCalculation(text: string): SuiteQuestion | null {
  const said = maths(text);
  const opening = CALC_OPENINGS.find((phrase) => said.startsWith(`${phrase} `));
  if (!opening) return null;
  let body = digitiseNumbers(said.slice(opening.length).trim());
  for (const [pattern, replacement] of SUM_WORDS) body = body.replace(pattern, replacement);
  body = body.replace(/\s+/g, '');
  if (!body || !/\d/.test(body)) return null;
  if (!SAFE_EXPRESSION.test(body)) return null;
  return {
    tool: 'calculate',
    args: { operation: 'expression', data: [body] },
    about: body,
  };
}

/** How each unit is written in the integration's arguments. */
const UNIT_WORDS: [string, string][] = [
  ['fluid ounces', 'fluid_ounce'],
  ['fluid ounce', 'fluid_ounce'],
  ['fl oz', 'fluid_ounce'],
  ['tablespoons', 'tablespoon'],
  ['tablespoon', 'tablespoon'],
  ['tbsp', 'tablespoon'],
  ['teaspoons', 'teaspoon'],
  ['teaspoon', 'teaspoon'],
  ['tsp', 'teaspoon'],
  ['millilitres', 'ml'],
  ['milliliters', 'ml'],
  ['millilitre', 'ml'],
  ['milliliter', 'ml'],
  ['ml', 'ml'],
  ['litres', 'liter'],
  ['liters', 'liter'],
  ['litre', 'liter'],
  ['liter', 'liter'],
  ['gallons', 'gallon'],
  ['gallon', 'gallon'],
  ['pints', 'pint'],
  ['pint', 'pint'],
  ['cups', 'cup'],
  ['cup', 'cup'],
  ['kilograms', 'kilogram'],
  ['kilogram', 'kilogram'],
  ['kgs', 'kilogram'],
  ['kg', 'kilogram'],
  ['milligrams', 'milligram'],
  ['milligram', 'milligram'],
  ['mgs', 'milligram'],
  ['mg', 'milligram'],
  ['grams', 'gram'],
  ['gram', 'gram'],
  ['pounds', 'pound'],
  ['pound', 'pound'],
  ['lbs', 'pound'],
  ['lb', 'pound'],
  ['ounces', 'ounce'],
  ['ounce', 'ounce'],
  ['oz', 'ounce'],
  ['stones', 'stone'],
  ['stone', 'stone'],
  ['celsius', 'celsius'],
  ['centigrade', 'celsius'],
  ['fahrenheit', 'fahrenheit'],
];

/** Longest first, so "fluid ounces" is matched before "ounces". */
const UNIT_PATTERN = UNIT_WORDS.map(([word]) => word)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/ /g, '\\s+'))
  .join('|');

/** A number as people say it: `8`, `2.5`, `1/2`, `1 1/2`. */
const AMOUNT = '\\d+(?:[./]\\d+)?(?:\\s+\\d+/\\d+)?';

const UNIT_MAP = new Map(UNIT_WORDS);

function unitOf(said: string): string | undefined {
  return UNIT_MAP.get(said.replace(/\s+/g, ' ').trim());
}

/**
 * Read "how many grams in 8 ounces?" or "convert 2 cups to ml" as a `unit_convert` call.
 *
 * Both units have to be ones the integration knows, and both forms of the sentence put the
 * amount between them, so a question about a number of things in the house ("how many lights
 * are on?") names no unit and is refused.
 */
function readConversion(text: string): SuiteQuestion | null {
  const said = maths(text);
  const u = UNIT_PATTERN;
  const patterns: [RegExp, 'amount-from-to' | 'to-amount-from'][] = [
    [new RegExp(`^how many (${u}) (?:are |is )?(?:in|to) (?:an? )?(${AMOUNT}) (${u})$`), 'to-amount-from'],
    [new RegExp(`^(?:convert|change) (${AMOUNT}) (${u}) (?:to|into) (${u})$`), 'amount-from-to'],
    [
      new RegExp(
        `^(?:(?:what is|what's|whats) |how many ${u} (?:is|are) )?(${AMOUNT}) (?:degrees? )?(${u}) (?:in|to|into) (?:degrees? )?(${u})$`,
      ),
      'amount-from-to',
    ],
  ];
  for (const [pattern, shape] of patterns) {
    const match = pattern.exec(said);
    if (!match) continue;
    const [, one, two, three] = match;
    if (!one || !two || !three) continue;
    const amount = shape === 'to-amount-from' ? two : one;
    const from = unitOf(shape === 'to-amount-from' ? three : two);
    const to = unitOf(shape === 'to-amount-from' ? one : three);
    if (!from || !to) continue;
    return {
      tool: 'unit_convert',
      args: { amount, from_unit: from, to_unit: to },
      about: `${amount} ${from.replace('_', ' ')} in ${to.replace('_', ' ')}`,
    };
  }
  return null;
}

/** Openings that ask the web a question rather than the house. */
const WEB_OPENINGS: RegExp[] = [
  /^(?:please )?search (?:the web|online|the internet) for (.+)$/,
  /^(?:please )?google (.+)$/,
  /^(?:please )?look up (.+?) online$/,
  /^(?:please )?what does the web say about (.+)$/,
];

const WIKIPEDIA_OPENINGS: RegExp[] = [
  /^(?:please )?search wikipedia for (.+)$/,
  /^(?:please )?look up (.+?) on wikipedia$/,
  /^(?:please )?what does wikipedia say about (.+)$/,
  /^(?:please )?wikipedia (.+)$/,
];

/** Openings that ask where the nearest one of something is. */
const PLACE_OPENINGS: RegExp[] = [
  /^(?:please )?find (?:me )?(?:the )?(?:an? )?(?:nearest|closest|nearby) (.+)$/,
  /^(?:please )?search for (?:the )?(?:an? )?(?:nearest|closest|nearby) (.+)$/,
  /^(?:please )?where is the (?:nearest|closest) (.+)$/,
  /^(?:please )?find (?:me )?an? (.+?) (?:near me|nearby|near here|round here)$/,
];

const ABOUT_LIMIT = 24;

function aboutFrom(match: RegExpExecArray | null): string {
  const value = (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.split(' ').length > ABOUT_LIMIT) return '';
  if (!/\p{L}/u.test(value)) return '';
  return value;
}

/**
 * Read a sentence as a call to one of the suite's tools, or `null`.
 *
 * Order matters: the arithmetic and conversion readers work on symbols as well as words, so
 * they are tried before the prose readers, and every reader is narrow enough to decline a
 * sentence it does not positively recognise. `houseNames` keeps "the nearest lamp" out of
 * Google Places.
 */
export function readSuiteQuestion(text: string, houseNames: string[] = []): SuiteQuestion | null {
  const calculated = readCalculation(text);
  if (calculated) return calculated;
  const converted = readConversion(text);
  if (converted) return converted;

  const spoken = normalise(text);
  if (!spoken) return null;
  for (const pattern of WIKIPEDIA_OPENINGS) {
    const about = aboutFrom(pattern.exec(spoken));
    if (about) return { tool: 'search_wikipedia', args: { query: about }, about };
  }
  for (const pattern of WEB_OPENINGS) {
    const about = aboutFrom(pattern.exec(spoken));
    if (about) return { tool: 'search_web', args: { query: about }, about };
  }
  for (const pattern of PLACE_OPENINGS) {
    const about = aboutFrom(pattern.exec(spoken));
    if (!about) continue;
    // Something in the house answers to this name, so it is not a place.
    const atHome = houseNames.some((name) => {
      const value = normalise(name);
      return value.length > 2 && spoken.includes(value);
    });
    if (atHome) return null;
    return { tool: 'find_places', args: { query: about }, about };
  }
  return null;
}

/**
 * Tools whose result is prose, so only the model can phrase the answer.
 *
 * A search result, a list of places, a transcript of past states: reading one of these out
 * through a template produces "Done with search_web", which is worse than a model round trip.
 * The speech round forwards these to the model instead, unless a rule silenced them.
 */
const PROSE_TOOLS = new Set([
  'search_web',
  'search_wikipedia',
  'find_places',
  'search_youtube',
  'get_device_history_context',
  'get_weather_forecast',
  'play_video',
  'calendar_day_info',
]);

/** Does this tool's result have to be phrased by the model rather than spoken from a template? */
export function needsModelWords(tool: string | undefined): boolean {
  return Boolean(tool) && PROSE_TOOLS.has(shortName(tool as string));
}

/**
 * What to say after a Tools for Assist tool ran, in the tool's own terms.
 *
 * Returns `''` when this module cannot say it — an unknown tool, a language it does not write,
 * an error, a shape it does not recognise — so the caller can fall back to forwarding the
 * round to the model instead of speaking something invented.
 */
export function spokenToolResult(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
  content: string | undefined,
  language?: string,
): string {
  if (!tool || !isToolsForAssistTool(tool)) return '';
  const name = shortName(tool);
  if (!speaksEnglish(language)) return '';
  if (!content) return '';
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return '';
  }
  if (!data || typeof data !== 'object') return '';
  if (name === 'get_route') return speakRoute(data, args);

  const value = (data as { result?: unknown }).result;
  const record = (value ?? data) as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return '';
  if (name === 'calculate') {
    const answer = record.value;
    if (answer === undefined || answer === null || answer === '') return '';
    return sentence(`That's ${spokenNumber(answer)}`);
  }
  if (name === 'unit_convert') {
    const answer = record.value;
    if (answer === undefined || answer === null || answer === '') return '';
    const amount = typeof args?.amount === 'string' ? args.amount.trim() : '';
    const from = typeof args?.from_unit === 'string' ? spokenUnit(args.from_unit) : '';
    const to = typeof args?.to_unit === 'string' ? spokenUnit(args.to_unit) : '';
    const left = amount ? `${amount}${from ? ` ${from}` : ''}` : '';
    return sentence(left ? `${left} is ${spokenNumber(answer)}${to ? ` ${to}` : ''}` : `That's ${spokenNumber(answer)}${to ? ` ${to}` : ''}`);
  }
  return '';
}
