/**
 * "Nevermind." has to end the turn, not start a conversation with the model.
 *
 * The chatter filter sits in front of the decision and sends every short remark to the model,
 * so before this reader existed the phrases that mean "stop talking" cost a full model round
 * trip before Home Assistant heard HassNevermind. On a satellite answering out loud that round
 * trip is the delay the user hears.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { cancelPlan } from '../src/cancel.js';
import { defaultConfig, type Config } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { inventoryFor } from '../src/toolcall.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Living Room Lamp (light.living_room_lamp): off',
  'Desk Lamp (light.desk_lamp): off, area: Office',
  'Kitchen Speaker (media_player.kitchen_speaker): idle',
].join('\n');

function tool(name: string, properties: Record<string, unknown> = {}): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required: [] } },
  };
}

const TOOLS: OpenAITool[] = [
  tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' } }),
  tool('HassTurnOff', { name: { type: 'string' }, area: { type: 'string' } }),
  tool('HassGetState', { name: { type: 'string' } }),
  tool('HassNevermind'),
];

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    routing: { ...base.routing, enabled: true },
  };
}

async function decide(text: string, tools: OpenAITool[] = TOOLS) {
  clearCatalogCache();
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools },
    text,
    PROMPT,
    config(),
  );
}

test('"Nevermind." ends the turn with HassNevermind, without asking the model', async () => {
  for (const text of ['Nevermind.', 'never mind', 'no thanks', 'forget it', 'cancel that', 'stop', 'that is all']) {
    const result = await decide(text);
    assert.equal(result.route.plan.kind, 'tool', `"${text}" should be a call: ${JSON.stringify(result.route)}`);
    const plan = result.route.plan;
    if (plan.kind !== 'tool') throw new Error('unreachable');
    assert.equal(plan.tool, 'HassNevermind', `"${text}" should end the conversation`);
    assert.deepEqual(plan.args, {});
    assert.equal(plan.action, 'cancel');
    // Nothing was forwarded, so no model was consulted.
    assert.equal(result.entry.backend, 'off');
    assert.equal(result.entry.route, 'tool');
    assert.match(result.entry.reason ?? '', /no model call/);
  }
});

test('a cancel sentence that names something is left to the model', () => {
  const inventory = inventoryFor(TOOLS);
  for (const text of [
    'never mind the lights',
    'cancel the pasta timer',
    'forget the kitchen ceiling',
    'ignore the desk lamp',
    'no thanks turn it off',
  ]) {
    assert.equal(cancelPlan(text, inventory), null, `"${text}" is not a bare cancel`);
  }
});

test('without HassNevermind offered the sentence falls through to the model', async () => {
  const inventory = inventoryFor(TOOLS.filter((entry) => entry.function.name !== 'HassNevermind'));
  assert.equal(cancelPlan('nevermind', inventory), null);
});

test('"nevermind" is still recognisable as chatter, so the slow path stays intact', () => {
  // The reader runs first, but the filter that used to swallow the phrase is unchanged: a
  // conversation agent that offers no HassNevermind still gets the remark forwarded.
  assert.ok(cancelPlan('nevermind', inventoryFor(TOOLS)));
  assert.equal(cancelPlan('', inventoryFor(TOOLS)), null);
});

test('the catalog is not consulted: a cancel works with no devices in the prompt', () => {
  const inventory = inventoryFor(TOOLS);
  const plan = cancelPlan('Nevermind.', inventory);
  assert.ok(plan);
  assert.equal(plan!.plan.tool, 'HassNevermind');
  assert.match(plan!.reason, /"Nevermind\." ends the turn/);
});
