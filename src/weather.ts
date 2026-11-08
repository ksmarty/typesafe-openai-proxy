/**
 * The weather, in someone else's words.
 *
 * Pirate Weather is a Dark Sky–compatible service, and the thing it shares with Dark Sky is
 * the part that matters here: it does not only return numbers and condition codes, it returns
 * **written summaries** — "Light rain on Wednesday and Thursday, with highs dipping to 6 °C on
 * Tuesday" — in the language the request asked for. That is what a house should say when
 * somebody asks about the weather, and it is why the answer is not composed here from
 * condition codes: a sentence the proxy invented would be a worse sentence than the one the
 * forecast service already wrote.
 *
 * So this module asks one question, keeps the answer for a few minutes (a forecast does not
 * change between two questions), and hands back the summary that matches what was asked —
 * now, the next hour, today, tonight, tomorrow, the rest of the day or the week ahead.
 *
 * Everything here fails soft. A missing key, an unreachable service, a bad reply: the module
 * answers `null` and the caller forwards the request exactly as it did before the feature
 * existed. The weather must never be the reason a turn breaks.
 */

import { note } from './log.js';
import type { Config } from './config.js';
import { fetchWithTimeout, normalise } from './util.js';

/** The parts of the Pirate Weather reply this module reads. */
export interface WeatherReport {
  currently?: { summary?: string; temperature?: number; apparentTemperature?: number; icon?: string };
  minutely?: { summary?: string };
  hourly?: { summary?: string; data?: { summary?: string; temperature?: number }[] };
  daily?: { summary?: string; data?: WeatherDay[] };
  timezone?: string;
  flags?: { units?: string };
}

export interface WeatherDay {
  summary?: string;
  temperatureHigh?: number;
  temperatureLow?: number;
  temperatureMax?: number;
  temperatureMin?: number;
}

/**
 * What was asked about. The time frame decides which summary is spoken; the summary itself
 * is always Pirate Weather's, never a sentence assembled from numbers.
 */
export type WeatherSubject = 'now' | 'next_hour' | 'today' | 'tonight' | 'tomorrow' | 'week' | 'rest_of_day';

export interface WeatherQuestion {
  subject: WeatherSubject;
  /** The language the question came in, so the summary comes back in the same one. */
  language?: string;
}

/** The languages Pirate Weather writes summaries in. Anything else falls back to English. */
const SUMMARY_LANGUAGES = new Set([
  'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'fa', 'fi',
  'fr', 'ga', 'gd', 'he', 'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'ka', 'kn', 'ko', 'kw', 'lv', 'ml', 'mr',
  'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'ta', 'te', 'tet', 'tr', 'uk', 'ur', 'vi',
  'zh',
]);

/** `nl-NL` -> `nl`, and only when the service actually writes in it. */
export function summaryLanguage(language: string | undefined): string {
  const code = (language ?? '').split(/[-_]/)[0]?.trim().toLowerCase() ?? '';
  return SUMMARY_LANGUAGES.has(code) ? code : 'en';
}

/**
 * The language the summaries are asked for in: the pinned setting when there is one, else the
 * language of the request.
 *
 * The temperature sentence is written in this language, not in the request's, so a pinned
 * summary language can never come back with a sentence about it in another one.
 */
export function requestedSummaryLanguage(
  config: Config['weather'],
  language: string | undefined,
): string {
  return summaryLanguage(config?.language || language);
}

/**
 * The one sentence about temperature that is not the forecast service's.
 *
 * It is a template rather than prose because it has to agree with the language of the
 * summary around it. A language with no template here gets no temperature sentence at all:
 * an English "currently 7 degrees" after a Dutch summary is worse than saying less.
 */
const TEMPERATURE_TEMPLATE: Record<string, { now: string; range: string }> = {
  en: { now: 'Currently {temp}, feeling like {feels}.', range: 'A high of {high} and a low of {low}.' },
  nl: { now: 'Op dit moment {temp}, gevoelstemperatuur {feels}.', range: 'Maximum {high}, minimum {low}.' },
  de: { now: 'Aktuell {temp}, gefühlt {feels}.', range: 'Höchstwert {high}, Tiefstwert {low}.' },
  fr: { now: 'Actuellement {temp}, ressenti {feels}.', range: 'Maximum {high}, minimum {low}.' },
  es: { now: 'Ahora {temp}, sensación de {feels}.', range: 'Máxima {high}, mínima {low}.' },
  it: { now: 'Adesso {temp}, percepiti {feels}.', range: 'Massima {high}, minima {low}.' },
  pt: { now: 'Neste momento {temp}, sensação de {feels}.', range: 'Máxima {high}, mínima {low}.' },
  sv: { now: 'Just nu {temp}, känns som {feels}.', range: 'Högst {high}, lägst {low}.' },
  da: { now: 'Lige nu {temp}, føles som {feels}.', range: 'Højst {high}, lavest {low}.' },
};

/**
 * A temperature, written the way it reads in every language: `7°`.
 *
 * Not "7 degrees": the word would be English inside a Dutch or French sentence. The degree
 * sign carries the meaning and the unit is already in the summary the service wrote.
 */
function degrees(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `${Math.round(value)}°`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

/** The summary text, tidied so it reads as one sentence. */
function sentence(summary: string | undefined): string {
  const text = (summary ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The spoken answer to one question, from one report.
 *
 * Every branch reads a summary the service wrote and adds at most the temperature sentence
 * its language has a template for. Returns null when the report does not carry what the
 * question needs, so the caller forwards rather than answering with less than was asked.
 */
export function weatherAnswer(report: WeatherReport, question: WeatherQuestion): string | null {
  const language = summaryLanguage(question.language);
  const template = TEMPERATURE_TEMPLATE[language];
  const currently = report.currently ?? {};
  const today = report.daily?.data?.[0] ?? {};
  const tomorrow = report.daily?.data?.[1] ?? {};

  switch (question.subject) {
    case 'now': {
      const said = sentence(currently.summary);
      const temperature =
        template && typeof currently.temperature === 'number'
          ? fill(template.now, {
              temp: degrees(currently.temperature),
              feels: degrees(currently.apparentTemperature) || degrees(currently.temperature),
            })
          : '';
      const answer = join(said, temperature);
      return answer || null;
    }
    case 'next_hour': {
      // The minutely block is the one that answers "is it going to rain in the next hour".
      const said = sentence(report.minutely?.summary) || sentence(report.hourly?.data?.[0]?.summary);
      return said || null;
    }
    case 'today':
    case 'tonight': {
      const said = sentence(today.summary);
      const high = degrees(today.temperatureHigh ?? today.temperatureMax);
      const low = degrees(today.temperatureLow ?? today.temperatureMin);
      const range = template && high && low ? fill(template.range, { high, low }) : '';
      const answer = join(said, range);
      return answer || null;
    }
    case 'tomorrow': {
      const said = sentence(tomorrow.summary);
      if (!said) return null;
      const high = degrees(tomorrow.temperatureHigh ?? tomorrow.temperatureMax);
      const low = degrees(tomorrow.temperatureLow ?? tomorrow.temperatureMin);
      const range = template && high && low ? fill(template.range, { high, low }) : '';
      return join(said, range) || null;
    }
    case 'week':
      return sentence(report.daily?.summary) || null;
    case 'rest_of_day':
      return sentence(report.hourly?.summary) || null;
    default:
      return null;
  }
}

// --- the reader ------------------------------------------------------------

/** Words that only appear in a question about the weather outside. */
const WEATHER_WORD =
  /\b(weather|forecast|rain|rains|raining|rainy|snow|snows|snowing|snowy|sleet|hail|sun|sunny|sunshine|cloud|clouds|cloudy|overcast|wind|winds|windy|fog|foggy|mist|misty|storm|storms|stormy|thunder|thunderstorm|shower|showers|drizzle|drizzling|humid|frost|freezing)\b/;

/** Asking about the temperature, which is only the weather when it is asked about outside. */
const TEMPERATURE_WORD = /\b(temperature|warm|hot|cold|chilly|freezing|cool)\b/;

/** "outside", said the several ways people say it. */
const OUTSIDE = /\b(outside|out there|outdoors|out of doors|out)\b/;

/** A question, as opposed to a statement that happens to mention the weather. */
const ASKING = /\?\s*$|^\s*(what|whats|how|is|are|was|were|will|would|do|does|did|any|when)\b/i;

/** A command: "set the thermostat to 21" is not a question about the weather. */
const COMMAND = /^(set|start|stop|turn|switch|open|close|lock|unlock|add|remind|play|pause|make|put|dim|brighten|increase|decrease|raise|lower)\b/;

/** Things in the house. A sentence naming one is about that thing, not the weather. */
const DEVICE_WORD =
  /\b(thermostat|heating|radiator|boiler|air conditioning|aircon|ac|light|lights|lamp|lamps|fan|window|windows|door|doors|blind|blinds|curtain|curtains|plug|switch|switches|shower|tap|bed|bedroom|living room|kitchen|office|bathroom|garage|hall|hallway|attic|basement|cellar|couch|sofa)\b/;

/**
 * A place named after the weather word — "what's the weather in Amsterdam" — which this
 * cannot answer: the proxy knows one place, the one the key is configured for.
 *
 * Time words are allowed to follow, because "the forecast for tomorrow" is not a place.
 */
const TIME_WORDS =
  /\b(today|tonight|tomorrow|now|currently|right now|this morning|this afternoon|this evening|tonight|the morning|the afternoon|the evening|the night|overnight|this week|the week|the week ahead|the weekend|the next few days|the next days|the coming days|rest of the day|the rest of today|the rest of the week|later|next hour|the next hour|the hour|the next couple of hours)\b/;

/**
 * Where the question's time frame lands.
 *
 * The order matters and is deliberate: a stated frame always wins, and only a question with
 * no frame of its own is read as being about the near future ("is it going to rain?" wants
 * the next hour, not a statement about this second).
 */
const FRAME: { subject: WeatherSubject; pattern: RegExp }[] = [
  { subject: 'tomorrow', pattern: /\btomorrow\b|\bthe next day\b/ },
  { subject: 'tonight', pattern: /\btonight\b|\bovernight\b|\bthis evening\b|\bthe evening\b|\bthe night\b/ },
  { subject: 'week', pattern: /\b(this week|the week|the week ahead|the weekend|the next few days|the next days|the coming days|next week)\b/ },
  { subject: 'rest_of_day', pattern: /\b(the rest of (the )?(day|today)|later today|this afternoon|the afternoon|this morning|the morning)\b/ },
  { subject: 'today', pattern: /\b(today|the day)\b/ },
  { subject: 'next_hour', pattern: /\b(next|coming|this)\s+hour\b|\bnext couple of hours\b|\bin the hour\b/ },
  // No frame named, but the question is about rain that has not started yet.
  { subject: 'next_hour', pattern: /\b(going to|gonna|will it|is it going to)\s+(rain|snow|sleet|hail|shower)\b/ },
];

/**
 * Is this a request for the weather, and which part of it?
 *
 * Deliberately narrow. It has to be a question, it has to be about the weather, it must not
 * name a device or a room, and it must not name a place: a question about the weather in
 * Amsterdam, or about the bedroom, takes the normal path and is answered by the decision
 * model and the language model as before.
 */
export function readWeatherQuestion(text: string, houseNames: string[] = []): WeatherQuestion | null {
  const raw = text.trim();
  if (!raw) return null;
  const spoken = normalise(raw);
  if (!spoken) return null;
  if (COMMAND.test(spoken)) return null;
  if (!ASKING.test(raw)) return null;

  const aboutWeather = WEATHER_WORD.test(spoken);
  const aboutTemperature = TEMPERATURE_WORD.test(spoken);
  if (!aboutWeather && !aboutTemperature) return null;
  // A bare "what's the temperature" is a question about the house, not the sky: Home Assistant
  // has a climate intent for that. Only "outside" makes it the weather.
  if (!aboutWeather && !OUTSIDE.test(spoken)) return null;

  // Something in the house is named: "is the bedroom warm", "will it rain on the blinds".
  if (DEVICE_WORD.test(spoken)) return null;
  for (const name of houseNames) {
    const value = normalise(name);
    if (value.length > 2 && spoken.includes(value)) return null;
  }

  // A place named after the weather word, allowing a time frame to follow it.
  const elsewhere = /\b(?:in|at|for|around|near|on)\s+(\w[\w ]*)$/.exec(spoken);
  if (elsewhere?.[1] && !TIME_WORDS.test(elsewhere[1]) && !/^\w+$/.test(elsewhere[1].trim())) return null;
  if (elsewhere?.[1] && !TIME_WORDS.test(elsewhere[1])) {
    // "weather in amsterdam": the tail is a single word that is not a time frame.
    const tail = elsewhere[1].trim();
    if (!/^(it|here|us|me|the|this|that|my|our|these|those)$/.test(tail)) return null;
  }

  const subject = FRAME.find((entry) => entry.pattern.test(spoken))?.subject ?? 'now';
  return { subject };
}

// --- the service -----------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.pirateweather.net';
/** Ten minutes: a forecast does not change between two questions, and neither does the bill. */
const DEFAULT_CACHE_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 8_000;

interface CacheEntry {
  at: number;
  report: WeatherReport;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<WeatherReport | null>>();

export function clearWeatherCache(): void {
  cache.clear();
}

/** The units to ask in. `auto` reads the locale Home Assistant sent, then falls back to SI. */
export function unitsFor(config: Config['weather'], language: string | undefined): string {
  const configured = (config?.units ?? 'auto').trim().toLowerCase();
  if (['si', 'us', 'uk', 'ca'].includes(configured)) return configured;
  return /[-_]us$/i.test(language ?? '') ? 'us' : 'si';
}

/** Where to ask about: the configured coordinates, or Home Assistant's own home zone. */
export function coordinatesFor(
  config: Config['weather'],
  zoneHome: { latitude: number; longitude: number } | null | undefined,
): { latitude: number; longitude: number } | null {
  if (Number.isFinite(config?.latitude) && Number.isFinite(config?.longitude) && (config.latitude || config.longitude)) {
    return { latitude: config.latitude, longitude: config.longitude };
  }
  if (config?.haZoneCoordinates && zoneHome && Number.isFinite(zoneHome.latitude) && Number.isFinite(zoneHome.longitude)) {
    return zoneHome;
  }
  return null;
}

/**
 * The forecast for this house, cached and de-duplicated.
 *
 * Two questions a second apart, or two people asking at once, share one request to the
 * service. Every failure — no key, no coordinates, a 401, a timeout, unreadable JSON — is
 * `null` with a line in the log ring, never a thrown error inside a turn.
 */
export async function weatherFor(
  config: Config,
  options: { language?: string; zoneHome?: { latitude: number; longitude: number } | null } = {},
): Promise<WeatherReport | null> {
  const weather = config.weather;
  if (!weather?.apiKey) return null;
  const where = coordinatesFor(weather, options.zoneHome);
  if (!where) return null;

  const language = requestedSummaryLanguage(weather, options.language);
  const units = unitsFor(weather, options.language);
  const base = (weather.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = `${base}|${where.latitude.toFixed(3)},${where.longitude.toFixed(3)}|${units}|${language}`;

  const cacheMs = Number.isFinite(weather.cacheMs) && weather.cacheMs > 0 ? weather.cacheMs : DEFAULT_CACHE_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMs) return hit.report;

  const running = inflight.get(key);
  if (running) return running;

  const timeoutMs = Number.isFinite(weather.timeoutMs) && weather.timeoutMs > 0 ? weather.timeoutMs : DEFAULT_TIMEOUT_MS;
  const request = (async (): Promise<WeatherReport | null> => {
    const url =
      `${base}/forecast/${encodeURIComponent(weather.apiKey)}/${where.latitude.toFixed(4)},${where.longitude.toFixed(4)}` +
      `?units=${units}&lang=${language}&version=2&exclude=minutely`;
    try {
      const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, timeoutMs);
      if (!response.ok) {
        // Never log the URL: the key is in its path.
        note(`weather: Pirate Weather answered HTTP ${response.status} — forwarding weather questions instead`);
        return null;
      }
      const payload = (await response.json()) as WeatherReport;
      if (!payload || typeof payload !== 'object') return null;
      cache.set(key, { at: Date.now(), report: payload });
      return payload;
    } catch (error: unknown) {
      note(`weather: Pirate Weather could not be reached (${error instanceof Error ? error.message : String(error)})`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, request);
  return request;
}
