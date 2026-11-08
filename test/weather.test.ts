/**
 * The weather, in the forecast service's words.
 *
 * Three things are pinned here: the reader (which sentences are a question about the weather
 * and which are about the house, a command, or another city), the answer (the summary the
 * service wrote, for the time frame that was asked about), and the failure path (no key, an
 * error, a timeout — the module answers nothing and the turn is forwarded as before).
 *
 * A stub Pirate Weather server stands in for the real one, so the shape of the reply is the
 * shape the API actually returns and no test depends on the network.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { defaultConfig, type Config } from '../src/config.js';
import { clearCatalogCache } from '../src/catalog.js';
import { fastPathStatus, runPipeline } from '../src/pipeline.js';
import {
  clearWeatherCache,
  coordinatesFor,
  readWeatherQuestion,
  requestedSummaryLanguage,
  summaryLanguage,
  unitsFor,
  weatherAnswer,
  weatherFor,
  type WeatherReport,
} from '../src/weather.js';
import type { OpenAITool } from '../src/types.js';

/** A reply shaped like the real one, with the parts this feature reads. */
const REPORT: WeatherReport = {
  currently: { summary: 'Light Rain', temperature: 6.72, apparentTemperature: 3.65, icon: 'rain' },
  minutely: { summary: 'Flurries for the hour.' },
  hourly: { summary: 'Possible light rain until tonight and foggy starting tonight.' },
  daily: {
    summary: 'Light rain on Wednesday and Thursday, with highs dipping to 6°C on Tuesday.',
    data: [
      {
        summary: 'Possible light rain until night and foggy overnight.',
        temperatureHigh: 9.2,
        temperatureLow: 4.8,
      },
      { summary: 'Misty until afternoon, returning overnight.', temperatureHigh: 9.3, temperatureLow: 3.2 },
    ],
  },
  timezone: 'Europe/Amsterdam',
  flags: { units: 'si' },
};

// --- what is a question about the weather ---------------------------------

test('a question about the weather outside is read as one', () => {
  const expected: [string, string][] = [
    ['what is the weather like?', 'now'],
    ['whats the weather?', 'now'],
    ['how is the weather?', 'now'],
    ['is it raining?', 'now'],
    ['is it going to rain?', 'next_hour'],
    ['will it rain?', 'next_hour'],
    ['will it rain tomorrow?', 'tomorrow'],
    ['what is the forecast for tomorrow?', 'tomorrow'],
    ['is it going to rain today?', 'today'],
    ['what is the forecast?', 'now'],
    ['will it snow tonight?', 'tonight'],
    ['what is the weather this week?', 'week'],
    ['what is the forecast for the week ahead?', 'week'],
    ['is it going to rain in the next hour?', 'next_hour'],
    ['what is the weather like this afternoon?', 'rest_of_day'],
    ['is it windy outside?', 'now'],
    ['is it cold outside?', 'now'],
  ];
  for (const [text, subject] of expected) {
    const read = readWeatherQuestion(text);
    assert.ok(read, `"${text}" should be a weather question`);
    assert.equal(read!.subject, subject, `"${text}" should be about ${subject}`);
  }
});

test('a sentence that is about the house, a command or another city is not', () => {
  const house = ['Bedroom', 'Desk Lamp', 'Thermostat'];
  for (const text of [
    'is the bedroom warm?',
    'what is the temperature in the bedroom?',
    'is the thermostat set to 21?',
    'set the thermostat to 21 degrees',
    'close the blinds, it is sunny outside',
    'turn on the heating',
    'it is raining outside',
    'what is the weather in Amsterdam?',
    'what is the weather in London?',
    'is it raining in Paris?',
    'the weather was lovely yesterday',
    'what is the temperature?',
  ]) {
    assert.equal(readWeatherQuestion(text, house), null, `"${text}" should not be read as a weather question`);
  }
});

test('the summary language follows the request, and only when the service writes in it', () => {
  assert.equal(summaryLanguage('nl-NL'), 'nl');
  assert.equal(summaryLanguage('en'), 'en');
  assert.equal(summaryLanguage('zh-CN'), 'zh');
  assert.equal(summaryLanguage('xx'), 'en');
  assert.equal(summaryLanguage(undefined), 'en');
});

test('units follow the locale, and a pinned choice always wins', () => {
  const config = (units: string): Config['weather'] => ({ ...defaultConfig().weather, units });
  assert.equal(unitsFor(config('auto'), 'en-US'), 'us');
  assert.equal(unitsFor(config('auto'), 'nl-NL'), 'si');
  assert.equal(unitsFor(config('auto'), undefined), 'si');
  assert.equal(unitsFor(config('uk'), 'en-US'), 'uk');
});

test('coordinates come from the settings, else from Home Assistant', () => {
  const base = defaultConfig().weather;
  assert.deepEqual(coordinatesFor({ ...base, latitude: 52.37, longitude: 4.9 }, { latitude: 1, longitude: 2 }), {
    latitude: 52.37,
    longitude: 4.9,
  });
  assert.deepEqual(coordinatesFor(base, { latitude: 52.37, longitude: 4.9 }), { latitude: 52.37, longitude: 4.9 });
  assert.equal(coordinatesFor({ ...base, haZoneCoordinates: false }, { latitude: 52.37, longitude: 4.9 }), null);
  assert.equal(coordinatesFor(base, null), null);
  assert.equal(coordinatesFor(base, undefined), null);
});

// --- what is said ---------------------------------------------------------

test('a question about the weather now is the service’s summary plus the temperature', () => {
  assert.equal(
    weatherAnswer(REPORT, { subject: 'now', language: 'en' }),
    'Light Rain. Currently 7°, feeling like 4°.',
  );
});

test('the temperature sentence is omitted when the summary is all there is', () => {
  assert.equal(weatherAnswer({ currently: { summary: 'Overcast.' } }, { subject: 'now' }), 'Overcast.');
  assert.equal(weatherAnswer({}, { subject: 'now' }), null);
});

test('a summary without a full stop still reads as a sentence', () => {
  assert.equal(weatherAnswer({ currently: { summary: 'Overcast' } }, { subject: 'now' }), 'Overcast.');
});

test('rain in the next hour is the minutely summary', () => {
  assert.equal(weatherAnswer(REPORT, { subject: 'next_hour' }), 'Flurries for the hour.');
});

test('today and tonight are the day summary with its range', () => {
  const answer = weatherAnswer(REPORT, { subject: 'today', language: 'en' });
  assert.ok(answer);
  assert.match(answer!, /Possible light rain until night and foggy overnight\./);
  assert.match(answer!, /A high of 9° and a low of 5°\./);
});

test('tomorrow is tomorrow’s own summary', () => {
  const answer = weatherAnswer(REPORT, { subject: 'tomorrow', language: 'en' });
  assert.equal(answer, 'Misty until afternoon, returning overnight. A high of 9° and a low of 3°.');
});

test('the week ahead is the daily summary', () => {
  assert.equal(
    weatherAnswer(REPORT, { subject: 'week' }),
    'Light rain on Wednesday and Thursday, with highs dipping to 6°C on Tuesday.',
  );
});

test('the rest of the day is the hourly summary', () => {
  assert.equal(
    weatherAnswer(REPORT, { subject: 'rest_of_day' }),
    'Possible light rain until tonight and foggy starting tonight.',
  );
});

test('a language with no temperature template says less rather than mixing languages', () => {
  const answer = weatherAnswer(REPORT, { subject: 'now', language: 'ja' });
  assert.equal(answer, 'Light Rain.');
  const dutch = weatherAnswer(REPORT, { subject: 'now', language: 'nl' });
  assert.equal(dutch, 'Light Rain. Op dit moment 7°, gevoelstemperatuur 4°.');
});

test('a pinned summary language governs the temperature sentence too', () => {
  const base = defaultConfig().weather;
  // A French summary with an English question must not produce an English temperature line.
  assert.equal(requestedSummaryLanguage({ ...base, language: 'fr' }, 'en-US'), 'fr');
  assert.equal(requestedSummaryLanguage({ ...base, language: '' }, 'nl-NL'), 'nl');
  assert.equal(requestedSummaryLanguage({ ...base, language: '' }, undefined), 'en');
  assert.equal(requestedSummaryLanguage({ ...base, language: 'xx' }, 'en'), 'en');
});

test('the style decides how much is said, and never rewords the summary', () => {
  // The default: the service's sentence, then the temperature.
  assert.equal(
    weatherAnswer(REPORT, { subject: 'now', language: 'en', style: 'current' }),
    'Light Rain. Currently 7°, feeling like 4°.',
  );
  // The service's sentence alone.
  assert.equal(weatherAnswer(REPORT, { subject: 'now', language: 'en', style: 'summary' }), 'Light Rain.');
  // Right now, with the day either side of it.
  assert.equal(
    weatherAnswer(REPORT, { subject: 'now', language: 'en', style: 'full' }),
    'Light Rain. Currently 7°, feeling like 4°. A high of 9° and a low of 5°.',
  );
  // The number first, because that is what was really asked.
  assert.equal(
    weatherAnswer(REPORT, { subject: 'now', language: 'en', style: 'temperature_first' }),
    'Currently 7°, feeling like 4°. Light Rain.',
  );
  // An unknown style reads as the default rather than answering with nothing.
  assert.equal(
    weatherAnswer(REPORT, { subject: 'now', language: 'en', style: 'shouty' }),
    'Light Rain. Currently 7°, feeling like 4°.',
  );
});

test('a style adds no half sentence in a language with no temperature template', () => {
  assert.equal(weatherAnswer(REPORT, { subject: 'now', language: 'ja', style: 'full' }), 'Light Rain.');
  assert.equal(weatherAnswer(REPORT, { subject: 'now', language: 'ja', style: 'temperature_first' }), 'Light Rain.');
  assert.equal(weatherAnswer(REPORT, { subject: 'now', language: 'ja', style: 'summary' }), 'Light Rain.');
});

test('the other time frames follow the same style', () => {
  assert.equal(
    weatherAnswer(REPORT, { subject: 'today', language: 'en', style: 'summary' }),
    'Possible light rain until night and foggy overnight.',
  );
  assert.equal(
    weatherAnswer(REPORT, { subject: 'tomorrow', language: 'en', style: 'temperature_first' }),
    'A high of 9° and a low of 3°. Misty until afternoon, returning overnight.',
  );
  assert.equal(weatherAnswer(REPORT, { subject: 'next_hour', language: 'en', style: 'full' }), 'Flurries for the hour.');
});

// --- the service ----------------------------------------------------------

let stub: Server;
let baseUrl = '';
let requested: string[] = [];
let responder: (url: string) => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify(REPORT),
});

before(async () => {
  stub = createServer((request, response) => {
    requested.push(request.url ?? '');
    const { status, body } = responder(request.url ?? '');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

function weatherConfig(overrides: Partial<Config['weather']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    weather: {
      ...base.weather,
      apiKey: 'stub-key',
      latitude: 52.3702,
      longitude: 4.8952,
      baseUrl,
      cacheMs: 600000,
      ...overrides,
    },
  };
}

test('a forecast is asked for once and reused', async () => {
  clearWeatherCache();
  requested = [];
  responder = () => ({ status: 200, body: JSON.stringify(REPORT) });
  const config = weatherConfig();
  const first = await weatherFor(config, { language: 'en-US' });
  const second = await weatherFor(config, { language: 'en-US' });
  assert.ok(first);
  assert.equal(second, first, 'the same report should come back from the cache');
  assert.equal(requested.length, 1, 'only one request should have been made');
  assert.match(requested[0]!, /^\/forecast\/stub-key\/52\.3702,4\.8952/);
  assert.match(requested[0]!, /units=us/);
  assert.match(requested[0]!, /lang=en/);
});

test('nothing is asked for without a key', async () => {
  clearWeatherCache();
  requested = [];
  assert.equal(await weatherFor(weatherConfig({ apiKey: '' })), null);
  assert.equal(requested.length, 0);
});

test('an error from the service answers nothing, so the turn is forwarded', async () => {
  clearWeatherCache();
  requested = [];
  responder = () => ({ status: 401, body: '{"error":"bad key"}' });
  assert.equal(await weatherFor(weatherConfig(), { language: 'en' }), null);
  assert.equal(requested.length, 1);
});

test('an unreachable service answers nothing', async () => {
  clearWeatherCache();
  assert.equal(await weatherFor(weatherConfig({ baseUrl: 'http://127.0.0.1:9' }), { language: 'en' }), null);
});

// --- through the pipeline -------------------------------------------------

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassGetCurrentTime'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } },
}));

const PROMPT = ['# Available Devices', '- Desk Lamp: light.desk_lamp (area: Office)'].join('\n');

async function ask(text: string, overrides: Partial<Config['weather']> = {}, config?: Config) {
  clearCatalogCache();
  clearWeatherCache();
  const active = config ?? weatherConfig(overrides);
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    PROMPT,
    active,
  );
}

test('the pipeline answers a weather question with no model call', async () => {
  responder = () => ({ status: 200, body: JSON.stringify(REPORT) });
  const result = await ask('is it going to rain?');
  assert.equal(result.route.plan.kind, 'text', JSON.stringify(result.route.gates));
  if (result.route.plan.kind !== 'text') return;
  assert.equal(result.route.plan.text, 'Flurries for the hour.');
  assert.equal(result.entry.timings?.decideMs, 0);
  assert.equal(result.entry.backend, 'off');
  assert.match(result.entry.reason, /forecast service, no model call/);
  assert.equal(result.entry.category, 'query');
});

test('a weather question is answered even with no decision backend, which is the point', async () => {
  responder = () => ({ status: 200, body: JSON.stringify(REPORT) });
  const base = weatherConfig();
  const off: Config = { ...base, decision: { ...base.decision, backend: 'none' } };
  const result = await ask('what is the weather like?', {}, off);
  assert.equal(result.route.plan.kind, 'text');
  if (result.route.plan.kind !== 'text') return;
  assert.match(result.route.plan.text, /Light Rain/);
  assert.equal(fastPathStatus(off).ready, false, 'the fast path is off, yet the weather is answered');
});

test('a question about the house is left to the decision model', async () => {
  responder = () => ({ status: 200, body: JSON.stringify(REPORT) });
  const result = await ask('is the desk lamp on?');
  assert.notEqual(result.entry.reason, 'the time — spoken in words, no model call');
  assert.ok(!/\bforecast service\b/.test(result.entry.reason), 'the weather must not answer a device question');
});

test('the style setting reaches what is spoken', async () => {
  responder = () => ({ status: 200, body: JSON.stringify(REPORT) });
  const result = await ask('what is the weather like?', { style: 'summary' });
  assert.equal(result.route.plan.kind, 'text');
  if (result.route.plan.kind !== 'text') return;
  assert.equal(result.route.plan.text, 'Light Rain.');
});

test('with no key configured nothing is fetched and the question is forwarded', async () => {
  requested = [];
  const base = defaultConfig();
  const active: Config = {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
  };
  const result = await ask('what is the weather like?', {}, active);
  assert.equal(requested.length, 0, 'no request should have been made');
  assert.ok(!/forecast service/.test(result.entry.reason));
});
