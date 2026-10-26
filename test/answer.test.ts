import assert from 'node:assert/strict';
import test from 'node:test';

import { answerCount, answerDeviceState } from '../src/answer.js';
import { catalogFromPrompt, catalogFromRegistries } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { extract } from '../src/extract.js';
import { NO_AREA, Q, buildQuestions } from '../src/questions.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Answer, CatalogEntity, OpenAITool } from '../src/types.js';

/**
 * Home Assistant does not always offer `HassGetState` — an installation whose Assist API has
 * no state intent had every "is the office light on?" forwarded to a language model. The
 * catalog already holds the answer, so these pin that the proxy says it itself.
 */
const SLOTS = ['name', 'area', 'floor', 'domain', 'device_class', 'state'].reduce<Record<string, unknown>>(
  (all, slot) => ({ ...all, [slot]: { type: 'string' } }),
  {},
);

const tools = (names: string[]): OpenAITool[] =>
  names.map((name) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object', properties: SLOTS, required: [] } },
  }));

// No HassGetState: exactly the situation that was reported.
const WITHOUT_STATE = tools(['HassTurnOn', 'HassTurnOff']);

const HOME = catalogFromRegistries({
  areas: [{ area_id: 'office', name: 'Office' }],
  floors: [],
  devices: [],
  entities: [
    { entity_id: 'light.office_lights', name: 'Office Lights', area_id: 'office' },
    { entity_id: 'light.desk_lamp', name: 'Desk Lamp', area_id: 'office' },
    { entity_id: 'cover.office_blind', name: 'Office Blind', area_id: 'office' },
    { entity_id: 'sensor.office_temperature', name: 'Office Temperature', area_id: 'office' },
  ],
  states: [
    { entity_id: 'light.office_lights', state: 'on', attributes: {} },
    { entity_id: 'light.desk_lamp', state: 'off', attributes: {} },
    { entity_id: 'cover.office_blind', state: 'open', attributes: {} },
    {
      entity_id: 'sensor.office_temperature',
      state: '21.5',
      attributes: { unit_of_measurement: '°C' },
    },
  ],
});

function entity(id: string): CatalogEntity {
  const found = HOME.entities.find((candidate) => candidate.id === id);
  assert.ok(found, `fixture is missing ${id}`);
  return found;
}

test('a device answer reads like a sentence and carries the unit', () => {
  assert.equal(answerDeviceState(entity('light.office_lights')), 'The Office Lights is on.');
  assert.equal(answerDeviceState(entity('cover.office_blind')), 'The Office Blind is open.');
  assert.equal(answerDeviceState(entity('sensor.office_temperature')), 'The Office Temperature is 21.5 °C.');
});

test('a device that is not reporting says so instead of guessing', () => {
  const silent: CatalogEntity = { ...entity('light.desk_lamp'), state: 'unavailable' };
  assert.match(answerDeviceState(silent), /can't read the state/);
});

test('counts name what is on', () => {
  assert.equal(answerCount(HOME, 'light'), '1 of the 2 lights is on: Office Lights.');
  assert.equal(answerCount(HOME, 'cover', 'open'), 'The Office Blind is open.');
  assert.equal(answerCount(HOME, 'light', 'off'), '1 of the 2 lights is off: Desk Lamp.');
});

test('nothing on is a plain sentence', () => {
  assert.equal(answerCount(HOME, 'vacuum'), null, 'no vacuums means forward, not invent');
});

function routeFor(utterance: string, answers: Record<string, Answer>, inventory = inventoryFor(WITHOUT_STATE)) {
  const extraction = extract(utterance, { entityNames: HOME.entities.map((entry) => entry.name) });
  const built = buildQuestions(HOME, extraction, { maxOptions: 40 });
  const base: Config = defaultConfig();
  return route({
    utterance,
    catalog: HOME,
    answers,
    built,
    extraction,
    config: { ...base, decision: { ...base.decision, autoStart: true } },
    inventory,
  });
}

test('a state question is answered from the catalog when HA offers no state intent', () => {
  const result = routeFor('is the desk lamp on?', {
    [Q.category]: { type: 'choice', choice: 'query', probabilities: { query: 0.97 }, confidence: 0.97 },
    [Q.queryKind]: { type: 'choice', choice: 'device_state', probabilities: { device_state: 0.95 }, confidence: 0.95 },
    [Q.targetEntity]: {
      type: 'choice',
      choice: 'e_desk_lamp',
      probabilities: { e_desk_lamp: 0.93, e_office_lights: 0.03 },
      confidence: 0.93,
    },
  });
  assert.equal(result.plan.kind, 'text');
  if (result.plan.kind !== 'text') return;
  assert.equal(result.plan.text, 'The Desk Lamp is off.');
  assert.match(result.reason, /answered from the catalog/);
});

test('a count question is answered from the catalog too', () => {
  const result = routeFor('how many lights are on?', {
    [Q.category]: { type: 'choice', choice: 'query', probabilities: { query: 0.96 }, confidence: 0.96 },
    [Q.queryKind]: { type: 'choice', choice: 'count', probabilities: { count: 0.9 }, confidence: 0.9 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 0.95 }, confidence: 0.95 },
  });
  assert.equal(result.plan.kind, 'text');
  if (result.plan.kind !== 'text') return;
  assert.match(result.plan.text, /1 of the 2 lights is on/);
});

test('when Home Assistant does offer the intent, the call is still used', () => {
  const result = routeFor(
    'is the desk lamp on?',
    {
      [Q.category]: { type: 'choice', choice: 'query', probabilities: { query: 0.97 }, confidence: 0.97 },
      [Q.queryKind]: { type: 'choice', choice: 'device_state', probabilities: { device_state: 0.95 }, confidence: 0.95 },
      [Q.targetEntity]: {
        type: 'choice',
        choice: 'e_desk_lamp',
        probabilities: { e_desk_lamp: 0.93 },
        confidence: 0.93,
      },
    },
    inventoryFor(tools(['HassTurnOn', 'HassGetState'])),
  );
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'HassGetState');
});

test('an unconfident target still forwards rather than answering the wrong thing', () => {
  const result = routeFor('is it on?', {
    [Q.category]: { type: 'choice', choice: 'query', probabilities: { query: 0.9 }, confidence: 0.9 },
    [Q.queryKind]: { type: 'choice', choice: 'device_state', probabilities: { device_state: 0.8 }, confidence: 0.8 },
    [Q.targetEntity]: { type: 'choice', choice: NO_AREA, probabilities: { [NO_AREA]: 0.4 }, confidence: 0.4 },
  });
  assert.equal(result.plan.kind, 'forward');
});
