import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { parseAmount, parseClockText, parseDuration, reminderPlan } from '../src/reminders.js';
import { ruleFor } from '../src/speech.js';
import { inventoryFor } from '../src/toolcall.js';
import type { OpenAITool } from '../src/types.js';

/**
 * ha-reminders' five tools, with the slots `intents.py` declares: a title, and one of a
 * place (`direction` + `zone`), a duration (`minutes`) or a time of day (`time`).
 */
function tool(name: string, properties: Record<string, unknown>, required: string[] = []): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required } },
  };
}

function reminderTools(): OpenAITool[] {
  return [
    tool(
      'ha_reminders__ReminderCreate',
      {
        title: { type: 'string', description: 'What to be reminded about.' },
        direction: { type: 'string', enum: ['enter', 'leave'] },
        zone: { type: 'string' },
        minutes: { type: 'number' },
        time: { type: 'string' },
      },
      ['title'],
    ),
    tool('ha_reminders__ReminderList', {}),
    tool('ha_reminders__ReminderComplete', { title: { type: 'string' } }, ['title']),
    tool('ha_reminders__ReminderSnooze', { title: { type: 'string' }, minutes: { type: 'number' } }, ['title']),
    tool('ha_reminders__ReminderDelete', { title: { type: 'string' }, number: { type: 'number' } }),
  ];
}

const PROMPT = ['Available Devices:', 'Kitchen Ceiling (light.kitchen_ceiling): on'].join('\n');

function config(patch: Partial<Config['reminders']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', autoStart: true, historyTurns: 0 },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    reminders: { ...base.reminders, ...patch },
  };
}

async function decide(text: string, active: Config = config(), tools: OpenAITool[] = reminderTools()) {
  clearCatalogCache();
  return runPipeline({ model: 'test', messages: [{ role: 'user', content: text }], tools }, text, PROMPT, active);
}

/** The plan of a sentence this reader is expected to understand. */
async function plan(text: string) {
  const result = await decide(text);
  if (result.route.plan.kind !== 'tool') {
    throw new Error(`expected a tool call for "${text}", got ${result.route.plan.kind}`);
  }
  return result.route.plan;
}

// ---------------------------------------------------------------------------
// What was said, as the integration's slots
// ---------------------------------------------------------------------------

test('a duration is read the way it is spoken', () => {
  assert.equal(parseDuration('30 minutes'), 30);
  assert.equal(parseDuration('ten minutes'), 10);
  assert.equal(parseDuration('90 minutes'), 90);
  assert.equal(parseDuration('half an hour'), 30);
  assert.equal(parseDuration('an hour'), 60);
  assert.equal(parseDuration('one and a half hours'), 90);
  assert.equal(parseDuration('two days'), 2880);
  assert.equal(parseDuration('a week'), 10080);
  // Outside the slot range the integration declares (1..10080), so it is not a duration.
  assert.equal(parseDuration('zero minutes'), null);
  assert.equal(parseDuration('eight days'), null);
  assert.equal(parseDuration('soon'), null);
});

test('an amount may be a number, a word, or half of something', () => {
  assert.equal(parseAmount('30'), 30);
  assert.equal(parseAmount('thirty'), 30);
  assert.equal(parseAmount('forty five'), 45);
  assert.equal(parseAmount('half'), 0.5);
  assert.equal(parseAmount('an'), 1);
  assert.equal(parseAmount('lots'), null);
});

test('a time of day becomes the HH:MM the integration validates', () => {
  const morning = new Date(2026, 1, 14, 10, 15);
  assert.equal(parseClockText('8 pm', morning), '20:00');
  assert.equal(parseClockText('8:30pm', morning), '20:30');
  assert.equal(parseClockText('20:00', morning), '20:00');
  assert.equal(parseClockText('7 am', morning), '07:00');
  assert.equal(parseClockText('noon', morning), '12:00');
  assert.equal(parseClockText('midnight', morning), '00:00');
  assert.equal(parseClockText('half past 8 in the evening', morning), '20:30');
  assert.equal(parseClockText('quarter to 9 pm', morning), '20:45');
  // A bare hour is the next one, which is how the integration itself reads "at 8".
  assert.equal(parseClockText('8', morning), '20:00');
  assert.equal(parseClockText('8', new Date(2026, 1, 14, 6, 0)), '08:00');
  assert.equal(parseClockText('the evening', morning), null);
  assert.equal(parseClockText('tomorrow', morning), null);
});

// ---------------------------------------------------------------------------
// The five intents
// ---------------------------------------------------------------------------

test('"remind me to … in 30 minutes" is one ReminderCreate, with no model call', async () => {
  const created = await plan('remind me to take out the trash in 30 minutes');
  assert.equal(created.tool, 'ha_reminders__ReminderCreate');
  assert.deepEqual(created.args, { title: 'take out the trash', minutes: 30 });
  assert.equal(created.action, 'reminder_create');
  assert.deepEqual(created.targets, ['take out the trash']);

  const result = await decide('remind me to take out the trash in 30 minutes');
  assert.equal(result.entry.backend, 'off');
  assert.match(result.entry.reason, /ha-reminders/);
});

test('a duration the integration would refuse is converted, not passed through', async () => {
  assert.deepEqual((await plan('remind me to call the bank in half an hour')).args, {
    title: 'call the bank',
    minutes: 30,
  });
  assert.deepEqual((await plan('remind me in ten minutes to check the oven')).args, {
    title: 'check the oven',
    minutes: 10,
  });
});

test('"remind me to … at 7 am" is a daily reminder at that time', async () => {
  assert.deepEqual((await plan('remind me to water the plants at 7 am')).args, {
    title: 'water the plants',
    time: '07:00',
  });
});

test('a place makes it an enter or a leave reminder', async () => {
  assert.deepEqual((await plan('remind me when I get home to unpack the shopping')).args, {
    title: 'unpack the shopping',
    direction: 'enter',
    zone: 'home',
  });
  assert.deepEqual((await plan('remind me to unpack the shopping when I leave work')).args, {
    title: 'unpack the shopping',
    direction: 'leave',
    zone: 'work',
  });
});

test('the title keeps the words it was said with', async () => {
  assert.deepEqual((await plan('remind me to email Dr. Chen about the invoice in 2 hours')).args, {
    title: 'email Dr. Chen about the invoice',
    minutes: 120,
  });
  // A title may contain "in" and "at" without either being the trigger.
  assert.deepEqual((await plan('remind me to check in at the hotel at 9 pm')).args, {
    title: 'check in at the hotel',
    time: '21:00',
  });
});

test('"list my reminders" reads the list back', async () => {
  for (const said of ['list my reminders', 'what reminders do I have', 'show my reminders']) {
    const result = await plan(said);
    assert.equal(result.tool, 'ha_reminders__ReminderList');
    assert.deepEqual(result.args, {});
  }
});

test('"complete …", "mark … as done" and "I finished …" complete one', async () => {
  for (const said of [
    'complete reminder unpack the shopping',
    'mark reminder unpack the shopping as done',
    'I finished reminder unpack the shopping',
  ]) {
    const result = await plan(said);
    assert.equal(result.tool, 'ha_reminders__ReminderComplete');
    assert.deepEqual(result.args, { title: 'unpack the shopping' });
  }
});

test('"snooze … for 10 minutes" and a bare "snooze …"', async () => {
  assert.deepEqual((await plan('snooze reminder unpack the shopping for 10 minutes')).args, {
    title: 'unpack the shopping',
    minutes: 10,
  });
  // Without a duration the integration snoozes for its own default, so no `minutes` is sent.
  assert.deepEqual((await plan('snooze reminder unpack the shopping')).args, {
    title: 'unpack the shopping',
  });
});

test('"delete reminder number 2" deletes by position, by title otherwise', async () => {
  assert.deepEqual((await plan('delete reminder number 2')).args, { number: 2 });
  assert.deepEqual((await plan('delete reminder 2')).args, { number: 2 });
  assert.deepEqual((await plan('delete reminder unpack the shopping')).args, {
    title: 'unpack the shopping',
  });
});

// ---------------------------------------------------------------------------
// What is deliberately left alone
// ---------------------------------------------------------------------------

test('a reminder with no time is forwarded, where the model can ask', async () => {
  const result = await decide('remind me to call the plumber');
  assert.notEqual(result.route.plan.kind, 'tool');
});

test('without ha-reminders nothing is claimed', () => {
  const inventory = inventoryFor([tool('HassTurnOn', { name: { type: 'string' } })]);
  const result = reminderPlan({
    utterance: 'remind me to take out the trash in 30 minutes',
    inventory,
    config: config(),
  });
  assert.equal(result, null);
});

test('switching reminders off leaves the sentence to the model server', async () => {
  const result = await decide('remind me to take out the trash in 30 minutes', config({ enabled: false }));
  if (result.route.plan.kind === 'tool') {
    assert.notEqual(result.route.plan.tool, 'ha_reminders__ReminderCreate');
  }
});

test('a sentence that is not about reminders is untouched', async () => {
  const turnOn = tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' } });
  const result = await decide('turn on the kitchen ceiling', config(), [...reminderTools(), turnOn]);
  assert.equal(result.route.plan.kind, 'tool');
  if (result.route.plan.kind !== 'tool') return;
  assert.equal(result.route.plan.tool, 'HassTurnOn');
});

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

test('a reminder confirmation is spoken, not silenced by the default rules', () => {
  const call = { tool: 'ha_reminders__ReminderCreate', domain: 'ha_reminders', action: 'reminder_create' };
  assert.equal(ruleFor(defaultConfig().speech.rules, call), null);
  // …and a house that wants silence can say so, by tool or by the integration's domain.
  assert.equal(ruleFor([{ match: 'ha_reminders__ReminderCreate', mode: 'silent' }], call)?.mode, 'silent');
  assert.equal(ruleFor([{ match: 'ha_reminders.*', mode: 'silent' }], call)?.mode, 'silent');
});
