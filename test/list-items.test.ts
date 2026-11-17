import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Config } from '../src/config.js';
import type { OpenAITool } from '../src/types.js';

// Its own data dir, so a saved config never leaks in from another test file.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'trp-list-'));

const { catalogFromPrompt, clearCatalogCache } = await import('../src/catalog.js');
const { defaultConfig } = await import('../src/config.js');
const { extractListItem, splitListItems } = await import('../src/extract.js');
const { runPipeline } = await import('../src/pipeline.js');

const PROMPT = [
  'Available Devices:',
  'Shopping List (todo.shopping_list): 3 items, area: Kitchen',
  'Kitchen Lights (light.kitchen_lights): off, area: Kitchen',
].join('\n');

const SLOTS = { type: 'object', properties: { name: { type: 'string' }, item: { type: 'string' } }, required: [] };

const TOOLS: OpenAITool[] = [
  { type: 'function', function: { name: 'HassListAddItem', description: 'add', parameters: SLOTS } },
  {
    type: 'function',
    function: {
      name: 'HassTurnOff',
      description: 'off',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } },
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

async function decide(text: string, tools: OpenAITool[] = TOOLS) {
  clearCatalogCache();
  const catalog = catalogFromPrompt(PROMPT);
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools },
    text,
    PROMPT,
    config(),
  );
}

// --- the split itself --------------------------------------------------------

test('a conjunction between two list items is a seam', () => {
  assert.deepEqual(splitListItems('peanut butter and jam'), ['peanut butter', 'jam']);
  assert.deepEqual(splitListItems('milk, eggs and bread'), ['milk', 'eggs', 'bread']);
  assert.deepEqual(splitListItems('milk & eggs plus bread'), ['milk', 'eggs', 'bread']);
  assert.deepEqual(splitListItems('milk along with eggs'), ['milk', 'eggs']);
});

test('a phrase that is not two items is left whole', () => {
  assert.deepEqual(splitListItems('milk'), ['milk']);
  assert.deepEqual(splitListItems(''), []);
  assert.deepEqual(splitListItems(undefined), []);
});

test('the sentence can ask for the phrase to stay together', () => {
  assert.deepEqual(splitListItems('fish and chips as one item'), ['fish and chips']);
  assert.deepEqual(splitListItems('fish and chips together'), ['fish and chips']);
  assert.deepEqual(splitListItems('macaroni cheese as a single item'), ['macaroni cheese']);
});

test('the whole phrase is still what extraction names', () => {
  // Splitting is the router's job: the extraction keeps the words as they were said.
  assert.equal(extractListItem('add peanut butter and jam to the shopping list'), 'peanut butter and jam');
});

// --- one call per item -------------------------------------------------------

test('two items on one list become two calls, in the order they were said', async () => {
  const result = await decide('add peanut butter and jam to the shopping list');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'calls', `${result.route.reason} ${JSON.stringify(result.route.gates)}`);
  if (plan.kind !== 'calls') return;
  assert.equal(plan.calls.length, 2);
  assert.deepEqual(
    plan.calls.map((call) => call.args.item),
    ['peanut butter', 'jam'],
  );
  assert.deepEqual(new Set(plan.calls.map((call) => call.tool)), new Set(['HassListAddItem']));
  assert.deepEqual(new Set(plan.calls.map((call) => call.args.name)), new Set(['todo.shopping_list']));
  assert.match(result.route.reason, /2 items/);
});

test('three items separated by a comma and a conjunction become three calls', async () => {
  const result = await decide('add milk, eggs and bread to the shopping list');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'calls', `${result.route.reason} ${JSON.stringify(result.route.gates)}`);
  if (plan.kind !== 'calls') return;
  assert.deepEqual(
    plan.calls.map((call) => call.args.item),
    ['milk', 'eggs', 'bread'],
  );
});

test('one item is still one call, not a one-call list', async () => {
  const result = await decide('add milk to the shopping list');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool', `${result.route.reason} ${JSON.stringify(result.route.gates)}`);
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassListAddItem');
  assert.equal(plan.args.item, 'milk');
  assert.deepEqual(plan.targets, ['todo.shopping_list']);
});

test('"as one item" keeps a two-word name in a single call', async () => {
  const result = await decide('add fish and chips as one item to the shopping list');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool', `${result.route.reason} ${JSON.stringify(result.route.gates)}`);
  if (plan.kind !== 'tool') return;
  assert.equal(plan.args.item, 'fish and chips');
});

test('a request without the list intent invents nothing', async () => {
  // Only HassTurnOff is offered, so there is no way to add anything: the sentence is forwarded
  // rather than split into calls Home Assistant would reject.
  const result = await decide('add peanut butter and jam to the shopping list', [TOOLS[1]!]);
  assert.equal(result.route.plan.kind, 'forward', result.route.reason);
});
