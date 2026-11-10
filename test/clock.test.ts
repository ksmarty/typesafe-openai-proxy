/**
 * Telling the time, in words.
 *
 * These pin the three decisions the feature rests on: the reply is the bare spoken time
 * ("five twenty-two", "five o'clock" on the hour, never a.m. or p.m.); the clock comes from
 * the configured zone, else Home Assistant's own prompt clock, else the process; and only a
 * question about the time here is answered this way — a date, another city or a command that
 * happens to say "time" takes the normal path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { clockAnswer, clockFromPrompt, clockNow, isTimeQuestion, numberWords, spokenTime } from '../src/clock.js';
import { defaultConfig, type Config } from '../src/config.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import { catalogFromRegistries, clearCatalogCache } from '../src/catalog.js';
import { fastPathStatus, runPipeline } from '../src/pipeline.js';
import { extract } from '../src/extract.js';
import { Q, buildQuestions } from '../src/questions.js';
import type { Answer, Catalog, OpenAITool } from '../src/types.js';

function at(hours: number, minutes: number): Date {
  return new Date(2026, 4, 8, hours, minutes, 0, 0);
}

function clock(timezone = ''): Config['clock'] {
  return { timezone };
}

// --- the wording -----------------------------------------------------------

test('numbers below a hundred are words, never digits', () => {
  assert.equal(numberWords(0), 'zero');
  assert.equal(numberWords(7), 'seven');
  assert.equal(numberWords(13), 'thirteen');
  assert.equal(numberWords(20), 'twenty');
  assert.equal(numberWords(22), 'twenty two');
  assert.equal(numberWords(59), 'fifty nine');
});

test('the hour is read on a clock face, never with a.m. or p.m.', () => {
  assert.equal(spokenTime(at(5, 22)), 'five twenty-two');
  assert.equal(spokenTime(at(17, 22)), 'five twenty-two');
  assert.equal(spokenTime(at(0, 30)), 'twelve thirty');
  assert.equal(spokenTime(at(12, 30)), 'twelve thirty');
  assert.equal(spokenTime(at(23, 59)), 'eleven fifty-nine');
  assert.ok(!/am|pm|a\.m|p\.m/i.test(spokenTime(at(17, 22))));
});

test('the minutes are hyphenated, so a time is two words and not three', () => {
  // A voice reads "five twenty two" as three numbers; "five twenty-two" is one time.
  assert.equal(spokenTime(at(5, 22)), 'five twenty-two');
  assert.equal(spokenTime(at(5, 45)), 'five forty-five');
  assert.equal(spokenTime(at(21, 59)), 'nine fifty-nine');
  assert.equal(spokenTime(at(5, 20)).split(' ').length, 2);
  assert.equal(spokenTime(at(5, 10)).split(' ').length, 2);
});

test('the top of the hour is o’clock', () => {
  assert.equal(spokenTime(at(5, 0)), "five o'clock");
  assert.equal(spokenTime(at(17, 0)), "five o'clock");
  assert.equal(spokenTime(at(0, 0)), "twelve o'clock");
  assert.equal(spokenTime(at(12, 0)), "twelve o'clock");
});

test('minutes below ten take an “oh” so they are not heard as one number', () => {
  assert.equal(spokenTime(at(9, 5)), 'nine oh five');
  assert.equal(spokenTime(at(9, 9)), 'nine oh nine');
  assert.equal(spokenTime(at(9, 10)), 'nine ten');
});

// --- the clock it reads ----------------------------------------------------

test('Home Assistant’s own clock is read out of the system prompt', () => {
  const prompt = ['You are a voice assistant.', 'Current time is 9:41 AM.', 'Available Devices:'].join('\n');
  const read = clockFromPrompt(prompt);
  assert.ok(read);
  assert.equal(read!.getHours(), 9);
  assert.equal(read!.getMinutes(), 41);
  assert.equal(clockFromPrompt('nothing to see'), null);
});

test('the prompt clock means the hour it says, in either half of the day', () => {
  const pm = clockFromPrompt('Current time is 5:22 PM.');
  assert.ok(pm);
  assert.equal(spokenTime(pm!), 'five twenty-two');
  const am = clockFromPrompt('Current time is 12:05 am.');
  assert.ok(am);
  assert.equal(spokenTime(am!), 'twelve oh five');
  const noMeridiem = clockFromPrompt('The current time is 14:07.');
  assert.ok(noMeridiem);
  assert.equal(spokenTime(noMeridiem!), 'two oh seven');
});

/** The hour right now in a zone, so the assertion does not depend on when the suite runs. */
function hourIn(timezone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  return Number(formatted) % 24;
}

test('a configured timezone wins over the clock in the prompt', () => {
  for (const zone of ['UTC', 'Pacific/Kiritimati', 'America/New_York']) {
    const hour = hourIn(zone);
    const onFace = hour % 12 === 0 ? 12 : hour % 12;
    // The prompt says one o'clock; a zone answer has to ignore it.
    const spoken = spokenTime(clockNow(clock(zone), 'Current time is 1:00 AM.'));
    assert.ok(
      spoken.startsWith(`${numberWords(onFace)} `),
      `${zone} should be read as ${numberWords(onFace)}, not ${spoken}`,
    );
  }
});

test('a timezone that is not understood falls back to the prompt clock', () => {
  const read = clockNow(clock('Not/AZone'), 'Current time is 3:07 PM.');
  assert.equal(read.getHours(), 15);
  assert.equal(read.getMinutes(), 7);
});

test('the prompt clock is used when no timezone is set, and the process clock when it says nothing', () => {
  const fromPrompt = clockNow(clock(''), 'Current time is 6:03 AM.');
  assert.equal(spokenTime(fromPrompt), 'six oh three');
  const fromProcess = clockNow(clock(''), 'no clock here');
  assert.ok(Math.abs(fromProcess.getTime() - Date.now()) < 2000);
});

// --- what is a request for the time ---------------------------------------

test('a question about the time here is a request for the clock', () => {
  for (const text of [
    'what time is it',
    'what time is it?',
    'what time is it now',
    "what's the time",
    'whats the time?',
    'what is the time',
    'what time do you have',
    'have you got the time',
    'got the time',
    'do you know what time it is',
    'tell me the time',
    'time',
    'the time?',
  ]) {
    assert.ok(isTimeQuestion(text), `"${text}" should ask for the time`);
  }
});

test('a date, another city or a command is not a request for the clock', () => {
  for (const text of [
    "what's the date",
    'what day is it',
    'what time is it in Tokyo',
    'what time is it in London?',
    'set a timer for five minutes',
    'set an alarm for seven',
    'turn on the kitchen light at seven',
    'remind me at eight',
    'the time we went to the beach was lovely',
  ]) {
    assert.ok(!isTimeQuestion(text), `"${text}" should not be read as a clock request`);
  }
});

test('a request for the clock answers with the bare spoken time', () => {
  const answer = clockAnswer('what time is it?', clock(''), 'Current time is 5:22 PM.');
  assert.equal(answer, 'five twenty-two');
  assert.equal(clockAnswer('what time is it?', clock(''), 'Current time is 5:00 PM.'), "five o'clock");
  assert.equal(clockAnswer("what's the date", clock(''), 'Current time is 5:22 PM.'), null);
});

// --- through the router and the pipeline ----------------------------------

const HOME: Catalog = catalogFromRegistries({
  areas: [{ area_id: 'office', name: 'Office' }],
  floors: [],
  devices: [],
  entities: [{ entity_id: 'light.desk_lamp', name: 'Desk Lamp', area_id: 'office' }],
  states: [{ entity_id: 'light.desk_lamp', state: 'on', attributes: {} }],
});

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassGetCurrentTime', 'HassGetCurrentDate'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } },
}));

const PROMPT = ['Current time is 5:22 PM.', 'Available Devices:', '- Desk Lamp: light.desk_lamp (area: Office)'].join('\n');

function routeTime(utterance: string, systemPrompt?: string) {
  const extraction = extract(utterance, { entityNames: HOME.entities.map((one) => one.name) });
  const built = buildQuestions(HOME, extraction, { maxOptions: 40 });
  const answers: Record<string, Answer> = {
    [Q.category]: { type: 'choice', choice: 'query', probabilities: { query: 0.97 }, confidence: 0.97 },
    [Q.queryKind]: { type: 'choice', choice: 'time_or_date', probabilities: { time_or_date: 0.93, needs_prose: 0.03 }, confidence: 0.93 },
  };
  const base = defaultConfig();
  return route({
    utterance,
    catalog: HOME,
    answers,
    built,
    extraction,
    config: { ...base, decision: { ...base.decision, autoStart: true } },
    inventory: inventoryFor(TOOLS),
    ...(systemPrompt ? { systemPrompt } : {}),
  });
}

test('the router answers the time in words even when Home Assistant offers the intent', () => {
  const result = routeTime('what time is it?', PROMPT);
  assert.equal(result.plan.kind, 'text', JSON.stringify(result.gates));
  if (result.plan.kind !== 'text') return;
  assert.equal(result.plan.text, 'five twenty-two');
  assert.match(result.reason, /spoken in words/);
});

test('the router still calls Home Assistant for the date', () => {
  const result = routeTime("what's the date?", PROMPT);
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'HassGetCurrentDate');
});

test('the pipeline answers the time with no model call at all', async () => {
  clearCatalogCache();
  const base = defaultConfig();
  const active: Config = {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    routing: { ...base.routing, enabled: true },
  };
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'what time is it?' }], tools: TOOLS },
    'what time is it?',
    PROMPT,
    active,
  );
  assert.equal(result.route.plan.kind, 'text', JSON.stringify(result.route.gates));
  if (result.route.plan.kind !== 'text') return;
  assert.equal(result.route.plan.text, 'five twenty-two');
  assert.equal(result.entry.timings?.decideMs, 0);
  assert.equal(result.entry.backend, 'off');
  // The fast path being off does not stop the clock: it needs no model.
  assert.equal(fastPathStatus({ ...active, decision: { ...base.decision, backend: 'none' } }).ready, false);
});
