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
 * The summary can also be said the way a person would: the `natural` style keeps the same
 * sentence and frames it inside a spoken one ("Right now it's light rain, and it's 7° out"),
 * rotating the wording between answers so two questions in a row do not sound identical. That
 * framing is the only thing written here — the forecast is always the service's own words, and
 * a language with no phrasing of its own gets the plain answer rather than a half-translated
 * sentence.
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

/**
 * How much of the answer is said, and in which order.
 *
 * The first four keep the forecast as its own sentence: they differ only in whether the
 * temperature is added, whether the day's range comes with it, and whether the number comes
 * first. `natural` is the conversational one — it frames the summary inside a spoken sentence
 * and rotates between a few wordings, so two questions in a row do not sound like a machine.
 * The words are still the service's; only the frame around them is written here.
 */
export type WeatherStyle = 'summary' | 'current' | 'full' | 'temperature_first' | 'natural';

/** The style named by a setting, with anything unrecognised meaning `current`. */
export function weatherStyle(value: string | undefined): WeatherStyle {
  const wanted = (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (wanted === 'summary' || wanted === 'full' || wanted === 'temperature_first' || wanted === 'natural') {
    return wanted;
  }
  return 'current';
}

export interface WeatherQuestion {
  subject: WeatherSubject;
  /** The language the question came in, so the summary comes back in the same one. */
  language?: string;
  /** How much to say. Empty means `current`: the summary, then the temperature. */
  style?: string;
  /** Pin the wording a natural answer uses. Tests use it; a real answer rotates. */
  variant?: number;
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
 * The conversational answer, in the languages that have a frame for it.
 *
 * `lead` introduces the time frame and `moment`, `span` and `bare` are the sentence shapes:
 * right now with a temperature, a day with its high and low, and a stretch of time that only
 * has a summary. Every pattern keeps the service's summary intact; the placeholders only
 * decide whether its first letter is lowered, whether it stands alone, and what is said around
 * it. A language without an entry here falls back to the `current` composition, so this table
 * can grow one language at a time without breaking the others.
 */
interface NaturalTemplates {
  lead: Record<WeatherSubject, string[]>;
  moment: string[];
  span: string[];
  bare: string[];
}

const NATURAL_TEMPLATES: Record<string, NaturalTemplates> = {
  en: {
    lead: {
      now: ['Right now', 'At the moment', 'Outside right now'],
      next_hour: ['For the next hour', 'In the next hour'],
      today: ['Today', 'For today'],
      tonight: ['Tonight', 'For tonight'],
      tomorrow: ['Tomorrow', 'For tomorrow'],
      week: ['Looking ahead', 'This week'],
      rest_of_day: ['For the rest of the day', 'Later today'],
    },
    moment: [
      "{lead} it's {summary}, and it's {temp} out — though it feels more like {feels}.",
      '{Summary} {leadLower}. {temp} outside, feeling closer to {feels}.',
      "{lead}: {SummarySentence} It's {temp}, and it feels like {feels}.",
    ],
    span: [
      "{lead} it's {summary}, with a high of {high} and a low of {low}.",
      '{lead}: {SummarySentence} High of {high}, low of {low}.',
      'For {leadLower}, {summary} — a high of {high} and a low of {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead}, {summary}.'],
  },
  nl: {
    lead: {
      now: ['Nu', 'Op dit moment', 'Momenteel'],
      next_hour: ['Het komende uur', 'Voor het komende uur'],
      today: ['Vandaag', 'Voor vandaag'],
      tonight: ['Vanavond', 'Voor vanavond'],
      tomorrow: ['Morgen', 'Voor morgen'],
      week: ['Deze week', 'Vooruitkijkend'],
      rest_of_day: ['Voor de rest van de dag', 'Later vandaag'],
    },
    moment: [
      '{lead} is het {summary}, {temp} buiten, maar het voelt als {feels}.',
      '{Summary} {leadLower}. {temp} buiten, gevoelstemperatuur {feels}.',
      '{lead}: {SummarySentence} Het is {temp} buiten, en het voelt als {feels}.',
    ],
    span: [
      '{lead} is het {summary}, met een maximum van {high} en een minimum van {low}.',
      '{lead}: {SummarySentence} Maximum {high}, minimum {low}.',
      'Voor {leadLower} wordt het {summary}, met een maximum van {high} en een minimum van {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead} is het {summary}.'],
  },
  de: {
    lead: {
      now: ['Gerade', 'Im Moment', 'Momentan'],
      next_hour: ['In der nächsten Stunde', 'Für die nächste Stunde'],
      today: ['Heute', 'Für heute'],
      tonight: ['Heute Abend', 'Für heute Abend'],
      tomorrow: ['Morgen', 'Für morgen'],
      week: ['Diese Woche', 'Vorausschauend'],
      rest_of_day: ['Für den Rest des Tages', 'Später heute'],
    },
    moment: [
      '{lead} ist es {summary}, {temp} draußen, es fühlt sich wie {feels} an.',
      '{Summary} {leadLower}. {temp} draußen, gefühlt {feels}.',
      '{lead}: {SummarySentence} {temp} draußen, es fühlt sich wie {feels} an.',
    ],
    span: [
      '{lead} ist es {summary}, mit einem Höchstwert von {high} und einem Tiefstwert von {low}.',
      '{lead}: {SummarySentence} Höchstwert {high}, Tiefstwert {low}.',
      'Für {leadLower} wird es {summary}, mit einem Höchstwert von {high} und einem Tiefstwert von {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead} ist es {summary}.'],
  },
  fr: {
    lead: {
      now: ['Maintenant', 'En ce moment', 'Dehors'],
      next_hour: ['Pour la prochaine heure', "Dans l'heure à venir"],
      today: ["Aujourd'hui", "Pour aujourd'hui"],
      tonight: ['Ce soir', 'Pour ce soir'],
      tomorrow: ['Demain', 'Pour demain'],
      week: ['Cette semaine', 'Pour la semaine à venir'],
      rest_of_day: ['Pour le reste de la journée', "Plus tard aujourd'hui"],
    },
    moment: [
      '{lead}, {summary}. Il fait {temp} dehors, mais le ressenti est de {feels}.',
      '{Summary} {leadLower}. {temp} dehors, ressenti {feels}.',
      '{lead} : {SummarySentence} Il fait {temp} dehors, et le ressenti est de {feels}.',
    ],
    span: [
      '{lead}, {summary}, avec un maximum de {high} et un minimum de {low}.',
      '{lead} : {SummarySentence} Maximum {high}, minimum {low}.',
      'Pour {leadLower}, {summary}, avec un maximum de {high} et un minimum de {low}.',
    ],
    bare: ['{lead} : {SummarySentence}', '{lead}, {summary}.'],
  },
  es: {
    lead: {
      now: ['Ahora', 'En este momento', 'Fuera'],
      next_hour: ['Para la próxima hora', 'En la próxima hora'],
      today: ['Hoy', 'Para hoy'],
      tonight: ['Esta noche', 'Para esta noche'],
      tomorrow: ['Mañana', 'Para mañana'],
      week: ['Esta semana', 'Con vistas a la semana'],
      rest_of_day: ['Para el resto del día', 'Más tarde hoy'],
    },
    moment: [
      '{lead}, hay {summary}, {temp} fuera, aunque se siente como {feels}.',
      '{Summary} {leadLower}. {temp} fuera, sensación de {feels}.',
      '{lead}: {SummarySentence} Hace {temp} fuera, y se siente como {feels}.',
    ],
    span: [
      '{lead}, hay {summary}, con una máxima de {high} y una mínima de {low}.',
      '{lead}: {SummarySentence} Máxima {high}, mínima {low}.',
      'Para {leadLower}, hay {summary}, con una máxima de {high} y una mínima de {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead}, hay {summary}.'],
  },
  it: {
    lead: {
      now: ['Adesso', 'In questo momento', 'Fuori'],
      next_hour: ['Per la prossima ora', "Nell'ora successiva"],
      today: ['Oggi', 'Per oggi'],
      tonight: ['Stasera', 'Per stasera'],
      tomorrow: ['Domani', 'Per domani'],
      week: ['Questa settimana', 'Guardando avanti'],
      rest_of_day: ['Per il resto della giornata', 'Più tardi oggi'],
    },
    moment: [
      "{lead}, c'è {summary}, {temp} fuori, ma sembrano {feels}.",
      '{Summary} {leadLower}. {temp} fuori, percepiti {feels}.',
      "{lead}: {SummarySentence} Ci sono {temp} fuori, e sembrano {feels}.",
    ],
    span: [
      "{lead}, c'è {summary}, con una massima di {high} e una minima di {low}.",
      '{lead}: {SummarySentence} Massima {high}, minima {low}.',
      "Per {leadLower}, c'è {summary}, con una massima di {high} e una minima di {low}.",
    ],
    bare: ['{lead}: {SummarySentence}', "{lead}, c'è {summary}."],
  },
  pt: {
    lead: {
      now: ['Agora', 'Neste momento', 'Lá fora'],
      next_hour: ['Para a próxima hora', 'Na próxima hora'],
      today: ['Hoje', 'Para hoje'],
      tonight: ['Esta noite', 'Para esta noite'],
      tomorrow: ['Amanhã', 'Para amanhã'],
      week: ['Esta semana', 'Olhando em frente'],
      rest_of_day: ['Para o resto do dia', 'Mais tarde hoje'],
    },
    moment: [
      '{lead}, há {summary}, {temp} lá fora, mas parece {feels}.',
      '{Summary} {leadLower}. {temp} lá fora, sensação de {feels}.',
      '{lead}: {SummarySentence} Estão {temp} lá fora, e parece {feels}.',
    ],
    span: [
      '{lead}, há {summary}, com uma máxima de {high} e uma mínima de {low}.',
      '{lead}: {SummarySentence} Máxima {high}, mínima {low}.',
      'Para {leadLower}, há {summary}, com uma máxima de {high} e uma mínima de {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead}, há {summary}.'],
  },
  sv: {
    lead: {
      now: ['Just nu', 'För tillfället', 'Ute'],
      next_hour: ['Den närmaste timmen', 'För den närmaste timmen'],
      today: ['I dag', 'För i dag'],
      tonight: ['I kväll', 'För i kväll'],
      tomorrow: ['I morgon', 'För i morgon'],
      week: ['Den här veckan', 'Framåt'],
      rest_of_day: ['För resten av dagen', 'Senare i dag'],
    },
    moment: [
      '{lead} är det {summary}, {temp} ute, men det känns som {feels}.',
      '{Summary} {leadLower}. {temp} ute, känns som {feels}.',
      '{lead}: {SummarySentence} Det är {temp} ute, och det känns som {feels}.',
    ],
    span: [
      '{lead} är det {summary}, med en högsta på {high} och en lägsta på {low}.',
      '{lead}: {SummarySentence} Högst {high}, lägst {low}.',
      'För {leadLower} blir det {summary}, med en högsta på {high} och en lägsta på {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead} är det {summary}.'],
  },
  da: {
    lead: {
      now: ['Lige nu', 'I øjeblikket', 'Udenfor'],
      next_hour: ['Den næste time', 'For den næste time'],
      today: ['I dag', 'For i dag'],
      tonight: ['I aften', 'For i aften'],
      tomorrow: ['I morgen', 'For i morgen'],
      week: ['Denne uge', 'Fremadrettet'],
      rest_of_day: ['For resten af dagen', 'Senere i dag'],
    },
    moment: [
      '{lead} er det {summary}, {temp} udenfor, men det føles som {feels}.',
      '{Summary} {leadLower}. {temp} udenfor, føles som {feels}.',
      '{lead}: {SummarySentence} Det er {temp} udenfor, og det føles som {feels}.',
    ],
    span: [
      '{lead} er det {summary}, med en højeste på {high} og en laveste på {low}.',
      '{lead}: {SummarySentence} Højst {high}, lavest {low}.',
      'For {leadLower} bliver det {summary}, med en højeste på {high} og en laveste på {low}.',
    ],
    bare: ['{lead}: {SummarySentence}', '{lead} er det {summary}.'],
  },
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

/** The summary in the three shapes a natural pattern can need. */
interface SummaryParts {
  /** Mid-sentence: first letter lowered, no final punctuation. */
  flow: string;
  /** Sentence-initial: as written, no final punctuation. */
  head: string;
  /** Standing alone: as written, with a final punctuation mark. */
  quote: string;
}

function summaryParts(summary: string | undefined, language: string): SummaryParts | null {
  const text = (summary ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const quote = /[.!?…]$/.test(text) ? text : `${text}.`;
  const head = text.replace(/[.!?…]+$/, '').trim();
  if (!head) return null;
  // A short summary is often title case ("Light Rain"), and lowering only its first letter
  // would leave "light Rain". Lower the whole short title, but never in German, where the
  // nouns are capitalised on purpose. Longer summaries are sentence case, so their weekdays
  // and places keep their capitals.
  const words = head.split(' ');
  const title = words.length > 1 && words.length <= 3 && words.every((word) => /^[A-ZÀ-Þ]/.test(word));
  const flow = title && language !== 'de' ? head.toLowerCase() : head.charAt(0).toLowerCase() + head.slice(1);
  return { flow, head, quote };
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * Which wording is used next.
 *
 * Rotated rather than picked at random: the same question asked twice should not come back
 * with the same sentence, and a counter guarantees that where a random pick can repeat. Tests
 * pin a wording with `variant` and reset the counter; a real answer takes the next one.
 */
let naturalAnswers = 0;

export function resetWeatherAnswerRotation(): void {
  naturalAnswers = 0;
}

/**
 * The conversational answer: the service's summary inside a spoken frame.
 *
 * Returns null when this language has no frame, or when the report does not carry the summary
 * the question needs. The caller then uses the default composition, so a language without
 * templates still answers as it did before rather than forwarding.
 */
function naturalAnswer(report: WeatherReport, question: WeatherQuestion): string | null {
  const templates = NATURAL_TEMPLATES[summaryLanguage(question.language)];
  if (!templates) return null;
  const variant = question.variant ?? naturalAnswers++;

  const leadFor = (subject: WeatherSubject): string => {
    const leads = templates.lead[subject];
    return leads[variant % leads.length] ?? leads[0] ?? '';
  };
  const speak = (
    family: 'moment' | 'span' | 'bare',
    lead: string,
    values: Record<string, string>,
  ): string | null => {
    const patterns = templates[family];
    // The lead and the pattern turn on separate wheels, so the pairings vary and the same
    // question asked twice does not come back with the same sentence.
    const pattern = patterns[variant % patterns.length] ?? patterns[0] ?? '';
    const text = fill(pattern, { lead, leadLower: lowerFirst(lead), ...values })
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  };
  const said = (summary: string | undefined): Record<string, string> | null => {
    const parts = summaryParts(summary, summaryLanguage(question.language));
    return parts ? { summary: parts.flow, Summary: parts.head, SummarySentence: parts.quote } : null;
  };
  const dayAnswer = (
    words: Record<string, string>,
    day: WeatherDay,
    lead: string,
  ): string | null => {
    const high = degrees(day.temperatureHigh ?? day.temperatureMax);
    const low = degrees(day.temperatureLow ?? day.temperatureMin);
    return high && low ? speak('span', lead, { ...words, high, low }) : speak('bare', lead, words);
  };

  const currently = report.currently ?? {};
  const today = report.daily?.data?.[0] ?? {};
  const tomorrow = report.daily?.data?.[1] ?? {};

  switch (question.subject) {
    case 'now': {
      const words = said(currently.summary);
      if (!words) return null;
      const lead = leadFor('now');
      const temp = degrees(currently.temperature);
      if (!temp) return speak('bare', lead, words);
      return speak('moment', lead, {
        ...words,
        temp,
        feels: degrees(currently.apparentTemperature) || temp,
      });
    }
    case 'next_hour': {
      const words = said(report.minutely?.summary) ?? said(report.hourly?.data?.[0]?.summary);
      return words ? speak('bare', leadFor('next_hour'), words) : null;
    }
    case 'today':
    case 'tonight': {
      const words = said(today.summary);
      return words ? dayAnswer(words, today, leadFor(question.subject)) : null;
    }
    case 'tomorrow': {
      const words = said(tomorrow.summary);
      return words ? dayAnswer(words, tomorrow, leadFor('tomorrow')) : null;
    }
    case 'week': {
      const words = said(report.daily?.summary);
      return words ? speak('bare', leadFor('week'), words) : null;
    }
    case 'rest_of_day': {
      const words = said(report.hourly?.summary);
      return words ? speak('bare', leadFor('rest_of_day'), words) : null;
    }
    default:
      return null;
  }
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
  const requested = weatherStyle(question.style);
  // The natural style is written per language. Where there is no frame for it — or where the
  // report does not carry what it needs — the default composition answers instead, so this
  // can only ever say more, never fall silent.
  if (requested === 'natural') {
    const natural = naturalAnswer(report, question);
    if (natural) return natural;
  }
  const style = requested === 'natural' ? 'current' : requested;
  const template = TEMPERATURE_TEMPLATE[language];
  const currently = report.currently ?? {};
  const today = report.daily?.data?.[0] ?? {};
  const tomorrow = report.daily?.data?.[1] ?? {};

  /** The day's range, when the report carries both ends of it. */
  const rangeOf = (day: WeatherDay): string => {
    const high = degrees(day.temperatureHigh ?? day.temperatureMax);
    const low = degrees(day.temperatureLow ?? day.temperatureMin);
    return template && high && low ? fill(template.range, { high, low }) : '';
  };

  switch (question.subject) {
    case 'now': {
      const said = sentence(currently.summary);
      if (style === 'summary') return said || null;
      const temperature =
        template && typeof currently.temperature === 'number'
          ? fill(template.now, {
              temp: degrees(currently.temperature),
              feels: degrees(currently.apparentTemperature) || degrees(currently.temperature),
            })
          : '';
      // `full` also gives the day either side of right now, which is what most people mean.
      const range = style === 'full' ? rangeOf(today) : '';
      const ordered = style === 'temperature_first' ? join(temperature, said) : join(said, temperature);
      return join(ordered, range) || null;
    }
    case 'next_hour': {
      // The minutely block is the one that answers "is it going to rain in the next hour".
      const said = sentence(report.minutely?.summary) || sentence(report.hourly?.data?.[0]?.summary);
      return said || null;
    }
    case 'today':
    case 'tonight': {
      const said = sentence(today.summary);
      if (style === 'summary') return said || null;
      const range = rangeOf(today);
      const ordered = style === 'temperature_first' ? join(range, said) : join(said, range);
      return ordered || null;
    }
    case 'tomorrow': {
      const said = sentence(tomorrow.summary);
      if (!said) return null;
      if (style === 'summary') return said;
      const range = rangeOf(tomorrow);
      const ordered = style === 'temperature_first' ? join(range, said) : join(said, range);
      return ordered || null;
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
