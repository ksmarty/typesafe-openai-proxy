import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Config } from '../src/config.js';
import type { OpenAITool } from '../src/types.js';

// Its own data dir, so the reset test can write a config file without touching anything real.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'trp-multi-'));

const { catalogFromPrompt, clearCatalogCache } = await import('../src/catalog.js');
const { defaultConfig, loadConfig, resetConfig, resetConfigPaths, saveConfig } = await import('../src/config.js');
const { splitClauses } = await import('../src/compound.js');
const { runPipeline } = await import('../src/pipeline.js');
const { settingsGroups } = await import('../src/schema.js');

const PROMPT = [
  'Available Devices:',
  'Kitchen Lights (light.kitchen_lights): off, area: Kitchen',
  'Kitchen Ceiling (light.kitchen_ceiling): off, area: Kitchen',
  'Living Room Lights (light.living_room_lights): off, area: Living Room',
  'Desk Lamp (light.desk_lamp): off, area: Office',
].join('\n');

const TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'HassTurnOn',
      description: 'turn on',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          area: { type: 'string' },
          floor: { type: 'string' },
          domain: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'HassTurnOff',
      description: 'turn off',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          area: { type: 'string' },
          floor: { type: 'string' },
          domain: { type: 'string' },
        },
        required: [],
      },
    },
  },
];

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '', defaultArea: '' },
    routing: { ...base.routing, enabled: true },
  };
}

async function decide(text: string) {
  clearCatalogCache();
  const catalog = catalogFromPrompt(PROMPT);
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    PROMPT,
    config(),
  );
}

// --- splitting ---------------------------------------------------------------

test('a sentence that names a list of targets is not split', () => {
  assert.deepEqual(splitClauses('turn on the kitchen and living room lights'), []);
  assert.deepEqual(splitClauses('turn on the kitchen lights'), []);
});

test('a sentence with two verbs and a seam is split', () => {
  assert.deepEqual(splitClauses('turn off the kitchen lights and turn on the desk lamp'), [
    'turn off the kitchen lights',
    'turn on the desk lamp',
  ]);
  assert.deepEqual(splitClauses('turn on the lamp, then open the blinds'), [
    'turn on the lamp',
    'open the blinds',
  ]);
});

// --- one action, several targets ---------------------------------------------

test('two rooms become two calls, one per room', async () => {
  const result = await decide('turn on the kitchen and living room lights');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'calls', JSON.stringify(result.route.gates));
  if (plan.kind !== 'calls') return;
  assert.equal(plan.calls.length, 2);
  assert.deepEqual(
    plan.calls.map((call) => call.args.area).sort(),
    ['Kitchen', 'Living Room'],
  );
  assert.deepEqual(new Set(plan.calls.map((call) => call.tool)), new Set(['HassTurnOn']));
  assert.deepEqual(new Set(plan.calls.map((call) => call.args.domain)), new Set(['light']));
});

test('two devices become two calls with an entity id each', async () => {
  const result = await decide('turn on the kitchen ceiling and the desk lamp');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'calls', JSON.stringify(result.route.gates));
  if (plan.kind !== 'calls') return;
  assert.deepEqual(
    plan.calls.map((call) => call.args.name).sort(),
    ['light.desk_lamp', 'light.kitchen_ceiling'],
  );
});

// --- compound: one call per clause -------------------------------------------

test('a compound sentence is decided clause by clause and sent as two calls', async () => {
  const result = await decide('turn off the kitchen lights and turn on the desk lamp');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'calls', `${result.reason} ${JSON.stringify(result.route.gates)}`);
  if (plan.kind !== 'calls') return;
  assert.equal(plan.calls.length, 2);
  const off = plan.calls.find((call) => call.tool === 'HassTurnOff');
  const on = plan.calls.find((call) => call.tool === 'HassTurnOn');
  assert.ok(off, 'the first clause turns the kitchen lights off');
  assert.ok(on, 'the second clause turns one lamp on');
  assert.match(JSON.stringify(off?.args), /kitchen/);
  assert.equal(on?.args.name, 'light.desk_lamp');
});

test('a clause the fast path cannot call forwards the whole sentence, not half of it', async () => {
  // Both clauses read as commands, so the split is attempted; the shopping-list clause
  // needs an intent this request does not offer, so nothing is sent at all.
  const result = await decide('turn off the kitchen lights and add milk to the shopping list');
  assert.equal(result.route.plan.kind, 'forward', JSON.stringify(result.route.plan));
});

// --- resetting one page ------------------------------------------------------

test('resetting one page leaves every other page alone', () => {
  saveConfig({
    decision: { baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.14', apiKey: 'sk-or-v1-secret' },
    catalog: { haUrl: 'http://homeassistant.local:8123', haToken: 'eyJhbGciOi-secret' },
    routing: { thresholds: { entity: 0.71 } },
  });

  const group = settingsGroups().find((entry) => entry.id === 'catalog');
  assert.ok(group);
  const after = resetConfigPaths(group!.fields.map((field) => field.key));

  // The catalog page went back to its default...
  assert.equal(after.catalog.haUrl, defaultConfig().catalog.haUrl);
  assert.equal(after.catalog.haToken, defaultConfig().catalog.haToken);
  // ...and nothing else moved, which is the whole point.
  assert.equal(after.decision.baseUrl, 'https://openrouter.ai/api');
  assert.equal(after.decision.model, 'typesafe/jev-1.14');
  assert.equal(after.decision.apiKey, 'sk-or-v1-secret');
  assert.equal(after.routing.thresholds.entity, 0.71);

  // A full reset still climbs back to the defaults.
  const everything = resetConfig();
  assert.equal(everything.decision.baseUrl, defaultConfig().decision.baseUrl);
  assert.equal(loadConfig(true).catalog.haToken, defaultConfig().catalog.haToken);
});
