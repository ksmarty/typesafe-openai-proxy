import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { splitOf, timerPlan } from '../src/timers.js';
import { inventoryFor } from '../src/toolcall.js';
import type { OpenAITool } from '../src/types.js';

/**
 * The timer intents as Home Assistant offers them to a model.
 *
 * The slots are the ones `homeassistant/components/intent/timers.py` declares: a start call
 * carries `hours`/`minutes`/`seconds` and a name, a control call carries the split the timer
 * was started with (`start_hours`/`start_minutes`/`start_seconds`) plus a name or an area.
 */
function tool(name: string, properties: Record<string, unknown>, required: string[] = []): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required } },
  };
}

const SPLIT = {
  hours: { type: 'number' },
  minutes: { type: 'number' },
  seconds: { type: 'number' },
};

const START_SPLIT = {
  start_hours: { type: 'number' },
  start_minutes: { type: 'number' },
  start_seconds: { type: 'number' },
};

function timerTools(): OpenAITool[] {
  return [
    tool('HassStartTimer', { ...SPLIT, name: { type: 'string' }, conversation_command: { type: 'string' } }),
    tool('HassCancelTimer', { ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
    tool('HassCancelAllTimers', { area: { type: 'string' } }),
    tool('HassIncreaseTimer', { ...SPLIT, ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
    tool('HassDecreaseTimer', { ...SPLIT, ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
    tool('HassPauseTimer', { ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
    tool('HassUnpauseTimer', { ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
    tool('HassTimerStatus', { ...START_SPLIT, name: { type: 'string' }, area: { type: 'string' } }),
  ];
}

const PROMPT = ['Available Devices:', 'Kitchen Ceiling (light.kitchen_ceiling): on'].join('\n');

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', autoStart: true, historyTurns: 0 },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    timers: { enabled: true },
  };
}

/**
 * One kiosk per test.
 *
 * The reader keeps a ledger of the timers it started, keyed by the device that heard the
 * sentence, so a test that says "set a timer" and then "cancel my timer" has to be its own
 * kiosk — otherwise the timers another test started are the ones it is cancelling.
 */
let kiosks = 0;
function kiosk(): string {
  kiosks += 1;
  return `kiosk-${kiosks}`;
}

function decide(text: string, deviceId: string, tools: OpenAITool[] = timerTools(), active: Config = config()) {
  return timerPlan({ utterance: text, inventory: inventoryFor(tools), config: active, deviceId });
}

/** The plan of a sentence this reader is expected to understand. */
function plan(text: string, deviceId: string, tools: OpenAITool[] = timerTools()): Record<string, any> {
  const decision = decide(text, deviceId, tools);
  if (!decision) throw new Error(`expected a timer plan for "${text}", got null`);
  return decision.plan;
}

/** The one call of a sentence expected to be exactly one call. */
function call(text: string, deviceId: string, tools: OpenAITool[] = timerTools()) {
  const built = plan(text, deviceId, tools);
  assert.equal(built.kind, 'tool', `expected one call for "${text}", got ${built.kind}`);
  return built;
}

// ---------------------------------------------------------------------------
// The split Home Assistant stores, which is the timer's identity
// ---------------------------------------------------------------------------

test('a duration becomes the one split a later control call can replay', () => {
  assert.deepEqual(splitOf(600), { minutes: 10 });
  assert.deepEqual(splitOf(3600), { hours: 1 });
  assert.deepEqual(splitOf(5400), { hours: 1, minutes: 30 });
  assert.deepEqual(splitOf(90), { seconds: 90 });
  // Nothing here is zero: a slot that was not sent is `None` in Home Assistant, and `0` would
  // not match the timer that was started.
  assert.deepEqual(splitOf(0), {});
});

// ---------------------------------------------------------------------------
// Starting one, and several
// ---------------------------------------------------------------------------

test('"set a timer for 10 minutes" is one HassStartTimer, with no model call', () => {
  const started = call('set a timer for 10 minutes', kiosk());
  assert.equal(started.tool, 'HassStartTimer');
  assert.deepEqual(started.args, { minutes: 10 });
  assert.equal(started.action, 'timer_start');
  assert.equal(started.domain, 'timer');
  assert.deepEqual(started.targets, ['10 minutes timer']);
});

test('a named timer keeps its name and says it back', () => {
  const started = call('set a pasta timer for 8 minutes', kiosk());
  assert.deepEqual(started.args, { minutes: 8, name: 'pasta' });
  assert.deepEqual(started.targets, ['pasta timer']);
});

test('a duration said in words or halves is the same duration', () => {
  const device = kiosk();
  assert.deepEqual(call('set a timer for half an hour', device).args, { minutes: 30 });
  assert.deepEqual(call('start a timer for an hour and a half', device).args, { hours: 1, minutes: 30 });
  assert.deepEqual(call('set a timer for ninety seconds', device).args, { seconds: 90 });
  assert.deepEqual(call('set a timer for 90 seconds', device).args, { seconds: 90 });
});

test('two lengths in one sentence are two timers in one turn', () => {
  // "5 and 10 minutes" shares one unit: it is two timers, not one of fifteen minutes.
  const built = plan('set timers for 5 and 10 minutes', kiosk());
  assert.equal(built.kind, 'calls');
  assert.equal(built.calls.length, 2);
  assert.deepEqual(built.calls[0].args, { minutes: 5 });
  assert.deepEqual(built.calls[1].args, { minutes: 10 });
  assert.equal(built.action, 'timer_start');
  assert.equal(built.domain, 'timer');
});

test('a count starts the same length as many times as asked', () => {
  const built = plan('set two timers for 10 minutes', kiosk());
  assert.equal(built.kind, 'calls');
  assert.deepEqual(
    built.calls.map((each: { args: unknown }) => each.args),
    [{ minutes: 10 }, { minutes: 10 }],
  );
});

test('two names and two lengths become two named timers', () => {
  const built = plan('set a pasta timer for 8 minutes and a rice timer for 12 minutes', kiosk());
  assert.equal(built.kind, 'calls');
  assert.deepEqual(
    built.calls.map((each: { args: unknown }) => each.args),
    [
      { minutes: 8, name: 'pasta' },
      { minutes: 12, name: 'rice' },
    ],
  );
});

// ---------------------------------------------------------------------------
// Controlling one
// ---------------------------------------------------------------------------

test('"add 2 minutes to the pasta timer" replays the split it was started with', () => {
  const device = kiosk();
  call('set a pasta timer for 8 minutes', device);
  const extended = call('add 2 minutes to the pasta timer', device);
  assert.equal(extended.tool, 'HassIncreaseTimer');
  // The change, then the timer: Home Assistant matches on the exact start split, so the
  // eight minutes have to be sent back with the two.
  assert.deepEqual(extended.args, { minutes: 2, name: 'pasta', start_minutes: 8 });
  assert.deepEqual(extended.targets, ['pasta timer']);
});

test('"cancel the pasta timer" is HassCancelTimer with the same split', () => {
  const device = kiosk();
  call('set a pasta timer for 8 minutes', device);
  const canceled = call('cancel the pasta timer', device);
  assert.equal(canceled.tool, 'HassCancelTimer');
  assert.deepEqual(canceled.args, { name: 'pasta', start_minutes: 8 });
});

test('a length names the timer when nothing was given a name', () => {
  const device = kiosk();
  call('set a timer for 10 minutes', device);
  const canceled = call('cancel the 10 minute timer', device);
  assert.equal(canceled.tool, 'HassCancelTimer');
  assert.deepEqual(canceled.args, { start_minutes: 10 });
});

test('"pause my timer" pauses the only one running on this kiosk', () => {
  const device = kiosk();
  call('set a timer for 25 minutes', device);
  const paused = call('pause my timer', device);
  assert.equal(paused.tool, 'HassPauseTimer');
  assert.deepEqual(paused.args, { start_minutes: 25 });

  const resumed = call('resume my timer', device);
  assert.equal(resumed.tool, 'HassUnpauseTimer');
  assert.deepEqual(resumed.args, { start_minutes: 25 });
});

test('"cancel all timers" cancels every timer of this kiosk', () => {
  const device = kiosk();
  call('set a timer for 5 minutes', device);
  call('set a timer for 10 minutes', device);
  const cleared = call('cancel all timers', device);
  assert.equal(cleared.tool, 'HassCancelAllTimers');
  assert.deepEqual(cleared.args, {});
  assert.deepEqual(cleared.targets, ['all timers']);
  // The ledger is emptied by the cancel, so the next unnamed control sentence carries no
  // slots at all: Home Assistant falls back to the only timer of the device, the same way
  // kiosk-satellite answers "pause my timer" with nothing named.
  const bare = call('pause my timer', device);
  assert.equal(bare.tool, 'HassPauseTimer');
  assert.deepEqual(bare.args, {});
  assert.deepEqual(bare.targets, ['the timer']);
});

test('two timers running and neither named is a question, not a call', () => {
  const device = kiosk();
  call('set a timer for 5 minutes', device);
  call('set a timer for 10 minutes', device);
  const built = plan('cancel my timer', device);
  assert.equal(built.kind, 'clarify');
  assert.match(built.text, /5 minutes timer or 10 minutes timer/);
  assert.deepEqual(built.options, ['5 minutes timer', '10 minutes timer']);
});

// ---------------------------------------------------------------------------
// What is left to the model
// ---------------------------------------------------------------------------

test('a status question is left to the model, which reads Home Assistant’s slots', () => {
  const device = kiosk();
  call('set a timer for 10 minutes', device);
  assert.equal(decide('what timers are running', device), null);
  assert.equal(decide('how long is left on the pasta timer', device), null);
});

test('a house that offers no timer intents gets no timer decision', () => {
  assert.equal(decide('set a timer for 10 minutes', kiosk(), [tool('HassTurnOn', { name: { type: 'string' } })]), null);
  // Offered but without the slots a start call needs: nothing can be sent, so nothing is.
  assert.equal(decide('set a timer for 10 minutes', kiosk(), [tool('HassStartTimer', {})]), null);
});

test('a slot the offered tool does not declare is never sent', () => {
  // The kiosk's own blueprint-shaped tool without a name slot: the duration still starts it.
  const started = call('set a pasta timer for 8 minutes', kiosk(), [tool('HassStartTimer', SPLIT)]);
  assert.deepEqual(started.args, { minutes: 8 });
});

test('"pause" with no timer in the sentence stays the music reader’s', () => {
  assert.equal(decide('pause', kiosk()), null);
  assert.equal(decide('next song', kiosk()), null);
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

async function turn(text: string, tools: OpenAITool[] = timerTools()) {
  clearCatalogCache();
  return runPipeline({ model: 'test', messages: [{ role: 'user', content: text }], tools }, text, PROMPT, config());
}

test('a timer sentence is answered by this proxy, with the call on the trace', async () => {
  const result = await turn('set a pasta timer for 8 minutes');
  assert.equal(result.route.plan.kind, 'tool');
  assert.equal(result.entry.backend, 'off');
  assert.equal(result.entry.route, 'tool');
  assert.equal(result.entry.tool, 'HassStartTimer');
  assert.deepEqual(result.entry.args, { minutes: 8, name: 'pasta' });
  assert.match(result.entry.reason, /^timers: start/);
});

test('several timers in one turn are several calls on one trace', async () => {
  const result = await turn('set timers for 5 and 10 minutes');
  assert.equal(result.route.plan.kind, 'calls');
  assert.equal(result.entry.route, 'calls');
  assert.deepEqual(result.entry.calls, [
    { tool: 'HassStartTimer', args: { minutes: 5 } },
    { tool: 'HassStartTimer', args: { minutes: 10 } },
  ]);
});

test('the timers reader is off when the setting is off', async () => {
  const base = config();
  const active: Config = { ...base, timers: { enabled: false } };
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'set a timer for 10 minutes' }], tools: timerTools() },
    'set a timer for 10 minutes',
    PROMPT,
    active,
  );
  assert.notEqual(result.entry.tool, 'HassStartTimer');
});
