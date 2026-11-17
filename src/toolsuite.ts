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
    const expression = typeof args?.expression === 'string' ? args.expression.trim() : '';
    return sentence(expression ? `${expression} is ${String(answer)}` : `That's ${String(answer)}`);
  }
  if (name === 'unit_convert') {
    const answer = record.value;
    if (answer === undefined || answer === null || answer === '') return '';
    const unit = typeof args?.to_unit === 'string' ? args.to_unit.trim() : '';
    return sentence(`That's ${String(answer)}${unit ? ` ${unit}` : ''}`);
  }
  return '';
}
