import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromRegistries, floorsOf, uniqueFloorMention } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { extract } from '../src/extract.js';
import { actionQuestion, buildQuestions, Q } from '../src/questions.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Answer, OpenAITool } from '../src/types.js';

// The slots Home Assistant's intent tools really offer, `floor` among them: without a floor
// slot there is no way to say "everything upstairs" in one call.
const INTENT_SLOTS = ['name', 'area', 'floor', 'domain', 'device_class'].reduce<Record<string, unknown>>(
  (all, slot) => ({ ...all, [slot]: { type: 'string' } }),
  {},
);

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassTurnOff', 'HassLightSet'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: INTENT_SLOTS, required: [] } },
}));

/** A house with two floors and one light in a room on each. */
function twoFloors() {
  return catalogFromRegistries({
    areas: [
      { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
      { area_id: 'office', name: 'Office', floor_id: 'first' },
    ],
    devices: [],
    floors: [
      { floor_id: 'ground', name: 'Ground Floor', level: 0 },
      { floor_id: 'first', name: 'First Floor', level: 1 },
    ],
    entities: [
      { entity_id: 'light.kitchen_lights', name: 'Kitchen Lights', area_id: 'kitchen' },
      { entity_id: 'light.office_lights', name: 'Office Lights', area_id: 'office' },
    ],
    states: [
      { entity_id: 'light.kitchen_lights', state: 'off', attributes: {} },
      { entity_id: 'light.office_lights', state: 'off', attributes: {} },
    ],
  });
}

const HOME = twoFloors();

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '', defaultArea: 'Kitchen' },
  };
}

function routeFor(utterance: string, answers: Record<string, Answer>, tools = TOOLS) {
  const extraction = extract(utterance, { entityNames: HOME.entities.map((entity) => entity.name) });
  const built = buildQuestions(HOME, extraction, { maxOptions: 40 });
  return route({
    utterance,
    catalog: HOME,
    answers,
    built,
    extraction,
    config: config(),
    inventory: inventoryFor(tools),
  });
}

const command = (scope: string, action = 'turn_off'): Record<string, Answer> => ({
  [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.99 }, confidence: 0.99 },
  [Q.compound]: { type: 'noul', noul: 0.05 },
  [Q.scope]: { type: 'choice', choice: scope, probabilities: { [scope]: 0.92, area: 0.05 }, confidence: 0.92 },
  [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 1 }, confidence: 1 },
  [actionQuestion('light')]: { type: 'choice', choice: action, probabilities: { [action]: 1 }, confidence: 1 },
});

test('the floors come from the rooms that sit on them, in order', () => {
  assert.deepEqual(floorsOf(HOME), [
    { name: 'Ground Floor', level: 0 },
    { name: 'First Floor', level: 1 },
  ]);
});

test('"upstairs" is the highest floor, "downstairs" the lowest', () => {
  assert.equal(uniqueFloorMention(HOME, 'turn on the upstairs lights')?.name, 'First Floor');
  assert.equal(uniqueFloorMention(HOME, 'turn off the lights downstairs')?.name, 'Ground Floor');
  assert.equal(uniqueFloorMention(HOME, 'turn on the bottom floor lights')?.name, 'Ground Floor');
});

test('a floor named outright is that floor', () => {
  assert.equal(uniqueFloorMention(HOME, 'turn off the first floor lights')?.name, 'First Floor');
  assert.equal(uniqueFloorMention(HOME, 'turn on the lights on the ground floor')?.name, 'Ground Floor');
});

test('a room does not name a floor', () => {
  assert.equal(uniqueFloorMention(HOME, 'turn on the kitchen lights'), undefined);
});

test('two floors on the same level is no answer, not a guess', () => {
  const flat = catalogFromRegistries({
    areas: [
      { area_id: 'a', name: 'A', floor_id: 'left' },
      { area_id: 'b', name: 'B', floor_id: 'right' },
    ],
    devices: [],
    floors: [
      { floor_id: 'left', name: 'Left', level: 1 },
      { floor_id: 'right', name: 'Right', level: 1 },
    ],
    entities: [{ entity_id: 'light.a', name: 'A Light', area_id: 'a' }],
    states: [{ entity_id: 'light.a', state: 'off', attributes: {} }],
  });
  assert.equal(uniqueFloorMention(flat, 'turn on the upstairs lights'), undefined);
});

test('"turn off the upstairs lights" is one call on the floor, not on a room', () => {
  const result = routeFor('turn off the upstairs lights', command('floor'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'HassTurnOff');
  const args = result.plan.args as Record<string, unknown>;
  assert.equal(args.floor, 'First Floor');
  assert.equal(args.area, undefined);
  assert.equal(args.name, undefined);
  assert.deepEqual(result.plan.targets, ['First Floor']);
  assert.match(result.reason, /on floor First Floor/);
});

test('a floor named outright reaches Home Assistant by that name', () => {
  const result = routeFor('turn on the ground floor lights', command('floor', 'turn_on'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal((result.plan.args as Record<string, unknown>).floor, 'Ground Floor');
});

test('a model that reads a floor as a room still acts on the floor', () => {
  // "upstairs" is not a room, so the room answer it may give must not win over the floor.
  const answers: Record<string, Answer> = {
    ...command('area'),
    [Q.targetArea]: {
      type: 'choice',
      choice: 'area_office',
      probabilities: { area_office: 0.7, area_kitchen: 0.3 },
      confidence: 0.7,
    },
  };
  const result = routeFor('turn off the lights upstairs', answers);
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  const args = result.plan.args as Record<string, unknown>;
  assert.equal(args.floor, 'First Floor');
  assert.equal(args.area, undefined);
});

test('a floor the intent cannot take is a refusal, not a room-sized guess', () => {
  const noFloor: OpenAITool = {
    type: 'function',
    function: {
      name: 'HassTurnOff',
      description: 'turn off',
      parameters: { type: 'object', properties: { name: { type: 'string' }, area: { type: 'string' } }, required: [] },
    },
  };
  const result = routeFor('turn off the upstairs lights', command('floor'), [noFloor]);
  assert.equal(result.plan.kind, 'forward');
  if (result.plan.kind !== 'forward') return;
  assert.match(result.plan.reason, /no floor slot/);
});

test('a floor request with no floor named asks rather than guessing one', () => {
  const result = routeFor('turn off the lights', command('floor'));
  assert.equal(result.plan.kind, 'forward');
  if (result.plan.kind !== 'forward') return;
  assert.equal(result.plan.reason, 'no floor named');
});

test('"all the lights upstairs" is the floor, not the whole house', () => {
  const result = routeFor('turn off all the lights upstairs', command('whole_house'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  const args = result.plan.args as Record<string, unknown>;
  assert.equal(args.floor, 'First Floor');
  assert.equal(args.domain, 'light');
  assert.equal(args.name, undefined);
});

test('a prompt-only catalog has no floors, so a floor request goes to the model', () => {
  const prompt = ['## Kitchen', '- Kitchen Lights (light.kitchen_lights): off'].join('\n');
  assert.deepEqual(floorsOf(catalogFromRegistries({ areas: [], devices: [], floors: [], entities: [], states: [] })), []);
  assert.equal(uniqueFloorMention(catalogFromRegistries({ areas: [], devices: [], floors: [], entities: [], states: [] }), prompt), undefined);
});

test('a room the model read as a floor still acts on that room', () => {
  const result = routeFor('turn off the office lights', command('floor'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  const args = result.plan.args as Record<string, unknown>;
  assert.equal(args.area, 'Office');
  assert.equal(args.floor, undefined);
  assert.equal(args.domain, 'light');
});
