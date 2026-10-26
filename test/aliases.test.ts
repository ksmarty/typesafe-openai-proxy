import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromPrompt, catalogFromRegistries, clearCatalogCache, uniqueAreaMention, uniqueEntityMention } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { describeEntity } from '../src/questions.js';
import type { OpenAITool } from '../src/types.js';

function tool(name: string, properties: Record<string, unknown>): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required: [] } },
  };
}

const TOOLS: OpenAITool[] = [
  tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassTurnOff', { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } }),
];

const ALIAS_PROMPT = [
  '## Kitchen',
  '- Kitchen Ceiling (light.kitchen_ceiling), aliases: Big Light, Ceiling',
  '- Downlight (light.kitchen_downlight)',
  '  - also called: Spot One',
].join('\n');

test('the prompt carries aliases, inline and on the next line', () => {
  const catalog = catalogFromPrompt(ALIAS_PROMPT);
  const ceiling = catalog.entities.find((entity) => entity.id === 'light.kitchen_ceiling');
  const downlight = catalog.entities.find((entity) => entity.id === 'light.kitchen_downlight');
  assert.deepEqual(ceiling?.aliases, ['Big Light', 'Ceiling']);
  assert.deepEqual(downlight?.aliases, ['Spot One']);
  assert.equal(ceiling?.name, 'Kitchen Ceiling');
});

test('the Home Assistant registry carries entity and area aliases', () => {
  const catalog = catalogFromRegistries({
    areas: [{ area_id: 'kitchen', name: 'Kitchen', aliases: ['Cooking Room'] }],
    devices: [],
    floors: [],
    entities: [
      { entity_id: 'light.kitchen_ceiling', name: 'Kitchen Ceiling', area_id: 'kitchen', aliases: ['Big Light'] },
    ],
    states: [{ entity_id: 'light.kitchen_ceiling', state: 'on', attributes: {} }],
  });
  assert.equal(catalog.source, 'ha-websocket');
  assert.deepEqual(catalog.entities[0]?.aliases, ['Big Light']);
  assert.deepEqual(catalog.areas[0]?.aliases, ['Cooking Room']);
});

test('an alias names the device and the room', () => {
  const catalog = catalogFromPrompt(ALIAS_PROMPT);
  assert.equal(uniqueEntityMention(catalog, 'turn on the big light')?.id, 'light.kitchen_ceiling');
  assert.equal(uniqueEntityMention(catalog, 'turn off spot one')?.id, 'light.kitchen_downlight');
  const withAreaAlias = catalogFromRegistries({
    areas: [{ area_id: 'kitchen', name: 'Kitchen', aliases: ['Cooking Room'] }],
    devices: [],
    floors: [],
    entities: [],
    states: [],
  });
  assert.equal(uniqueAreaMention(withAreaAlias, 'turn on the cooking room lights')?.id, 'kitchen');
});

test('aliases travel to the decision model with the option', () => {
  const catalog = catalogFromPrompt(ALIAS_PROMPT);
  const ceiling = catalog.entities.find((entity) => entity.id === 'light.kitchen_ceiling')!;
  assert.match(describeEntity(ceiling), /also called Big Light, Ceiling/);
});

test('an alias resolves to the entity id Home Assistant expects', async () => {
  clearCatalogCache();
  const base = defaultConfig();
  const active = {
    ...base,
    decision: { ...base.decision, backend: 'heuristic' as const, autoStart: true, historyTurns: 0 },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
  };
  const text = 'turn on the big light';
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    ALIAS_PROMPT,
    active,
  );
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassTurnOn');
  assert.equal((plan.args as Record<string, unknown>).name, 'light.kitchen_ceiling');
});
