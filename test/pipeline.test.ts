import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromPrompt, clearCatalogCache } from '../src/catalog.js';
import { extract, extractListItem, extractMediaQuery } from '../src/extract.js';
import { fastPathStatus, runPipeline } from '../src/pipeline.js';
import { defaultConfig, type Config } from '../src/config.js';
import { NO_AREA, NO_SINGLE_ENTITY, Q, actionQuestion, buildQuestions } from '../src/questions.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Answer, OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Living Room Lamp (light.living_room_lamp): off',
  'Desk Lamp (light.desk_lamp): off',
  'Front Door (lock.front_door): locked',
  'Bedroom Thermostat (climate.bedroom_thermostat): heat, 19',
  'Kitchen Speaker (media_player.kitchen_speaker): playing',
].join('\n');

const AREA_PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on, area: Kitchen',
  'Kitchen Downlight (light.kitchen_downlight): off, area: Kitchen',
  'Living Room Lamp (light.living_room_lamp): off, area: Living Room',
  'Desk Lamp (light.desk_lamp): off, area: Office',
].join('\n');

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): OpenAITool {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties, required },
    },
  };
}

const TOOLS: OpenAITool[] = [
  tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' }, floor: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassTurnOff', { name: { type: 'string' }, area: { type: 'string' }, floor: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassToggle', { name: { type: 'string' } }),
  tool('HassGetState', { name: { type: 'string' }, domain: { type: 'string' }, state: { type: 'string' }, area: { type: 'string' } }),
  tool('HassLightSet', { name: { type: 'string' }, brightness_pct: { type: 'integer' }, color_name: { type: 'string' } }),
  tool('HassClimateSetTemperature', { name: { type: 'string' }, temperature: { type: 'number' } }),
  tool('HassClimateGetTemperature', { name: { type: 'string' } }),
  tool('HassGetCurrentTime', {}),
  tool('HassGetCurrentDate', {}),
  tool('HassNevermind', {}),
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

async function decide(text: string) {
  clearCatalogCache();
  const active = config();
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    PROMPT,
    active,
  );
}

test('extract reads percentages, colours and magnitudes', () => {
  assert.equal(extract('set the lamp to 20 percent').percent, 20);
  assert.equal(extract('dim it to 5%').percent, 5);
  assert.equal(extract('make the lights blue').color, 'blue');
  assert.equal(extract('a bit brighter').magnitude, 'slight');
  assert.equal(extract('a lot louder').magnitude, 'large');
  assert.equal(extract('set the thermostat to 21.5 degrees').number, 21.5);
});

test('extract reads list items and media queries', () => {
  assert.equal(extractListItem('add milk and eggs to the shopping list'), 'milk and eggs');
  assert.equal(extractMediaQuery('play the beatles on the kitchen speaker', ['kitchen speaker']), 'beatles');
});

test('prompt parsing recovers the entity catalog', () => {
  const catalog = catalogFromPrompt(PROMPT);
  assert.equal(catalog.source, 'prompt');
  assert.equal(catalog.entities.length, 6);
  const lamp = catalog.entities.find((entity) => entity.id === 'light.desk_lamp');
  assert.ok(lamp);
  assert.equal(lamp.name, 'Desk Lamp');
  assert.equal(lamp.state, 'off');
  const lock = catalog.entities.find((entity) => entity.id === 'lock.front_door');
  assert.equal(lock?.state, 'locked');
});

test('a single clear command becomes a tool call with the entity id in the name slot', async () => {
  const result = await decide('turn on the kitchen ceiling');
  assert.equal(result.route.plan.kind, 'tool', JSON.stringify(result.route.gates));
  const plan = result.route.plan;
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassTurnOn');
  assert.equal(plan.args.name, 'light.kitchen_ceiling');
});

test('a state question becomes a HassGetState call', async () => {
  const result = await decide('is the desk lamp on');
  assert.equal(result.route.plan.kind, 'tool', JSON.stringify(result.route.gates));
  const plan = result.route.plan;
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassGetState');
  assert.equal(plan.args.name, 'light.desk_lamp');
});

test('unlocking is confirmed before it is sent', async () => {
  const result = await decide('unlock the front door');
  assert.equal(result.route.plan.kind, 'confirm', JSON.stringify(result.route.gates));
  const plan = result.route.plan;
  if (plan.kind !== 'confirm') return;
  assert.equal(plan.pending.tool, 'HassTurnOff');
  assert.equal(plan.pending.args.name, 'lock.front_door');
  assert.match(plan.text, /unlock/i);
});

test('prose is forwarded rather than guessed at', async () => {
  const result = await decide('write me a poem about the sea');
  assert.equal(result.route.plan.kind, 'forward');
  assert.ok(result.route.gates.length >= 1);
});

test('a large value is converted into the slot Home Assistant expects', async () => {
  const result = await decide('set the desk lamp to 40 percent');
  assert.equal(result.route.plan.kind, 'tool', JSON.stringify(result.route.gates));
  const plan = result.route.plan;
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassLightSet');
  assert.equal(plan.args.brightness_pct, 40);
});

test('extract finds the free text a slot needs', () => {
  assert.equal(extract('add milk to the shopping list').item, 'milk');
  assert.equal(
    extract('play the beatles on the kitchen speaker', { entityNames: ['kitchen speaker'] }).mediaQuery,
    'beatles',
  );
});

test('the fast path reports why it is off', () => {
  const base = defaultConfig();
  const off = { ...base, decision: { ...base.decision, backend: 'none' as const } };
  assert.deepEqual(fastPathStatus(off), { ready: false, reason: 'no decision backend configured' });
  const systemoneNoUrl = { ...base, decision: { ...base.decision, backend: 'systemone' as const, baseUrl: '', model: 'x' } };
  assert.equal(fastPathStatus(systemoneNoUrl).ready, false);
  const systemoneNoModel = { ...base, decision: { ...base.decision, backend: 'systemone' as const, baseUrl: 'http://x', model: '' } };
  assert.equal(fastPathStatus(systemoneNoModel).ready, false);
  const heuristic = { ...base, decision: { ...base.decision, backend: 'heuristic' as const } };
  assert.equal(fastPathStatus(heuristic).ready, true);
  const noRouting = { ...heuristic, routing: { ...heuristic.routing, enabled: false } };
  assert.equal(fastPathStatus(noRouting).ready, false);
});

test('backend none forwards every request without deciding', async () => {
  clearCatalogCache();
  const active = config();
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'turn on the kitchen ceiling' }], tools: TOOLS },
    'turn on the kitchen ceiling',
    PROMPT,
    { ...active, decision: { ...active.decision, backend: 'none' } },
  );
  assert.equal(result.entry.backend, 'off');
  assert.match(result.entry.reason ?? '', /pass-through/);
});

test('the prompt parser keeps the room a device is listed in', () => {
  const catalog = catalogFromPrompt(
    [
      'Available Devices:',
      '- Kitchen Ceiling (light.kitchen_ceiling): off, in Kitchen',
      '- Desk Lamp (light.desk_lamp): on, in the Office',
      '- Garage Door (cover.garage_door): closed, area: Garage',
    ].join('\n'),
  );
  assert.deepEqual(
    catalog.areas.map((area) => area.name).sort(),
    ['Garage', 'Kitchen', 'Office'],
  );
  assert.equal(catalog.entities.find((entity) => entity.id === 'light.kitchen_ceiling')?.areaName, 'Kitchen');
  assert.equal(catalog.entities.find((entity) => entity.id === 'cover.garage_door')?.areaName, 'Garage');
});

test('a target several devices fit equally well asks instead of forwarding', () => {
  const catalog = catalogFromPrompt(
    ['Available Devices:', '- Bedroom Lamp (light.bedroom_lamp): off, in Bedroom', '- Living Room Lamp (light.living_room_lamp): off, in Living Room'].join('\n'),
  );
  const utterance = 'turn on the lamp';
  const extraction = extract(utterance, { entityNames: catalog.entities.map((entity) => entity.name) });
  const built = buildQuestions(catalog, extraction, { maxOptions: 40 });
  const answers: Record<string, Answer> = {
    [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.97, query: 0.01 }, confidence: 0.97 },
    [Q.compound]: { type: 'noul', noul: 0.02 },
    [Q.scope]: { type: 'choice', choice: 'single', probabilities: { single: 0.7 }, confidence: 0.7 },
    [Q.targetEntity]: { type: 'choice', choice: NO_SINGLE_ENTITY, probabilities: { [NO_SINGLE_ENTITY]: 0.8 }, confidence: 0.8 },
    [Q.targetArea]: { type: 'choice', choice: NO_AREA, probabilities: { [NO_AREA]: 0.9 }, confidence: 0.9 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 0.95 }, confidence: 0.95 },
    [actionQuestion('light')]: { type: 'choice', choice: 'turn_on', probabilities: { turn_on: 0.95 }, confidence: 0.95 },
  };
  const result = route({
    utterance,
    catalog,
    answers,
    built,
    extraction,
    config: config(),
    inventory: inventoryFor(TOOLS),
  });
  assert.equal(result.plan.kind, 'clarify');
  assert.deepEqual(result.plan.kind === 'clarify' ? result.plan.options : [], ['Bedroom Lamp', 'Living Room Lamp']);
});

test('a request that carries no tools is passed through and says why', async () => {
  clearCatalogCache();
  const text = 'turn on the kitchen lights';
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: [] },
    text,
    PROMPT,
    config(),
  );
  assert.equal(result.route.plan.kind, 'forward');
  assert.match(result.entry.reason, /carried no tools/);
  assert.deepEqual(result.entry.toolsOffered, []);
});

test('a missing intent names the tools the request did offer', async () => {
  clearCatalogCache();
  const text = 'turn on the kitchen lights';
  const thin = TOOLS.filter((entry) => entry.function.name !== 'HassTurnOn');
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: thin },
    text,
    AREA_PROMPT,
    config(),
  );
  assert.equal(result.route.plan.kind, 'forward');
  assert.match(result.entry.reason, /HassTurnOn is not offered by Home Assistant \(it offered/);
  assert.ok(result.entry.toolsOffered?.includes('HassGetState'));
});

test('a working request records the tools that were offered', async () => {
  const result = await decide('turn on the kitchen ceiling light');
  assert.equal(result.route.plan.kind, 'tool');
  assert.ok(result.entry.toolsOffered?.includes('HassTurnOn'));
});

test('prompt parsing follows area headings', () => {
  const prompt = [
    '# Available Devices',
    '## Kitchen',
    '- Ceiling Light (light.kitchen_ceiling)',
    '- Downlight (light.kitchen_downlight)',
    '## Living Room',
    '- Floor Lamp (light.living_room_lamp)',
    '## Tools',
    '- HassTurnOn',
  ].join('\n');
  const catalog = catalogFromPrompt(prompt);
  assert.equal(catalog.entities.length, 3);
  assert.deepEqual(
    catalog.entities.map((entity) => entity.areaName).sort(),
    ['Kitchen', 'Kitchen', 'Living Room'],
  );
  assert.deepEqual(catalog.areas.map((area) => area.name).sort(), ['Kitchen', 'Living Room']);
});

test('a room named in the sentence rescues an unsure scope', async () => {
  const prompt = [
    'Available Devices:',
    'Kitchen Ceiling (light.kitchen_ceiling): on, area: Kitchen',
    'Kitchen Downlight (light.kitchen_downlight): off, area: Kitchen',
    'Desk Lamp (light.desk_lamp): off, area: Office',
  ].join('\n');
  clearCatalogCache();
  const text = 'turn on the kitchen lights';
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    prompt,
    config(),
  );
  assert.equal(result.route.plan.kind, 'tool');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassTurnOn');
  assert.equal((plan.args as Record<string, unknown>).area, 'Kitchen');
});

test('a device named in the sentence beats an unsure scope', async () => {
  const prompt = [
    'Available Devices:',
    'Kitchen Ceiling (light.kitchen_ceiling): on, area: Kitchen',
    'Kitchen Downlight (light.kitchen_downlight): off, area: Kitchen',
  ].join('\n');
  clearCatalogCache();
  const text = 'turn on the kitchen ceiling light';
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    prompt,
    config(),
  );
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassTurnOn');
  assert.equal((plan.args as Record<string, unknown>).name, 'light.kitchen_ceiling');
});
