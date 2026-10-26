import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromPrompt, mentionedTargets } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { extract } from '../src/extract.js';
import { actionQuestion, buildQuestions, NO_AREA, Q } from '../src/questions.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Answer, OpenAITool } from '../src/types.js';

const SLOTS = ['name', 'area', 'floor', 'domain', 'device_class'].reduce<Record<string, unknown>>(
  (all, slot) => ({ ...all, [slot]: { type: 'string' } }),
  {},
);

// The slots Home Assistant actually offers: without `domain` there is no whole-house call.
const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassTurnOff', 'HassGetState'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: SLOTS, required: [] } },
}));

const HOME = catalogFromPrompt(
  [
    '## Kitchen',
    '- Kitchen Lights (light.kitchen_lights): off',
    '- Kitchen Ceiling (light.kitchen_ceiling): off',
    '## Living Room',
    '- Living Room Lights (light.living_room_lights): off',
    '- Living Room TV (media_player.living_room): off',
  ].join('\n'),
);

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, autoStart: true },
    // "Here" resolves through the area the device reports, exactly as configured.
    catalog: { ...base.catalog, haUrl: '', haToken: '', defaultArea: 'Living Room' },
  };
}

function routeFor(utterance: string, answers: Record<string, Answer>) {
  const extraction = extract(utterance, { entityNames: HOME.entities.map((entity) => entity.name) });
  const built = buildQuestions(HOME, extraction, { maxOptions: 40 });
  return route({
    utterance,
    catalog: HOME,
    answers,
    built,
    extraction,
    config: config(),
    inventory: inventoryFor(TOOLS),
  });
}

test('a device inside the room it names is one target, not two', () => {
  const targets = mentionedTargets(HOME, 'turn on the kitchen lights');
  assert.deepEqual(targets.map((entry) => entry.kind), ['area']);
  assert.equal(targets[0]?.name, 'Kitchen');
});

test('two rooms in one sentence are two targets', () => {
  const targets = mentionedTargets(HOME, 'turn on the kitchen and living room lights');
  assert.deepEqual(targets.map((entry) => entry.name).sort(), ['Kitchen', 'Living Room']);
});

test('a request for two rooms is forwarded whole rather than half done', () => {
  const result = routeFor('turn on the kitchen and living room lights', {
    [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.99 }, confidence: 0.99 },
    [Q.compound]: { type: 'noul', noul: 0.2 },
    [Q.scope]: { type: 'choice', choice: 'area', probabilities: { area: 0.92, single: 0.06 }, confidence: 0.92 },
    [Q.targetArea]: { type: 'choice', choice: 'area_kitchen', probabilities: { area_kitchen: 0.6, area_living_room: 0.4 }, confidence: 0.6 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 1 }, confidence: 1 },
    [actionQuestion('light')]: { type: 'choice', choice: 'turn_on', probabilities: { turn_on: 1 }, confidence: 1 },
  });
  assert.equal(result.plan.kind, 'forward');
  assert.match(result.reason, /more than one target \(Kitchen, Living Room\)/);
});

test('"all the lights" is not pulled back into the room the device sits in', () => {
  const result = routeFor('turn on all the lights', {
    [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.99 }, confidence: 0.99 },
    [Q.compound]: { type: 'noul', noul: 0.05 },
    [Q.scope]: { type: 'choice', choice: 'whole_house', probabilities: { whole_house: 0.9, area: 0.05 }, confidence: 0.9 },
    [Q.hereRelative]: { type: 'noul', noul: 0.95 },
    [Q.targetArea]: { type: 'choice', choice: 'area_living_room', probabilities: { area_living_room: 0.7 }, confidence: 0.7 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 1 }, confidence: 1 },
    [actionQuestion('light')]: { type: 'choice', choice: 'turn_on', probabilities: { turn_on: 1 }, confidence: 1 },
  });
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'HassTurnOn');
  assert.equal((result.plan.args as Record<string, unknown>).area, undefined);
  assert.equal((result.plan.args as Record<string, unknown>).domain, 'light');
});

test('a plain room request still acts on the room', () => {
  const result = routeFor('turn on the kitchen ceiling', {
    [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.99 }, confidence: 0.99 },
    [Q.compound]: { type: 'noul', noul: 0.03 },
    [Q.scope]: { type: 'choice', choice: 'single', probabilities: { single: 0.9 }, confidence: 0.9 },
    [Q.targetEntity]: { type: 'choice', choice: 'e_kitchen_ceiling', probabilities: { e_kitchen_ceiling: 0.9 }, confidence: 0.9 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 1 }, confidence: 1 },
    [actionQuestion('light')]: { type: 'choice', choice: 'turn_on', probabilities: { turn_on: 1 }, confidence: 1 },
  });
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal((result.plan.args as Record<string, unknown>).name, 'light.kitchen_ceiling');
});

test('"the lights" spoken in a room still means that room', () => {
  const result = routeFor('turn on the lights', {
    [Q.category]: { type: 'choice', choice: 'command', probabilities: { command: 0.99 }, confidence: 0.99 },
    [Q.compound]: { type: 'noul', noul: 0.07 },
    [Q.scope]: { type: 'choice', choice: 'whole_house', probabilities: { whole_house: 0.62, area: 0.37 }, confidence: 0.62 },
    [Q.hereRelative]: { type: 'noul', noul: 0.95 },
    [Q.targetArea]: { type: 'choice', choice: 'area_living_room', probabilities: { area_living_room: 0.58 }, confidence: 0.58 },
    [Q.targetDomain]: { type: 'choice', choice: 'light', probabilities: { light: 1 }, confidence: 1 },
    [actionQuestion('light')]: { type: 'choice', choice: 'turn_on', probabilities: { turn_on: 1 }, confidence: 1 },
  });
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal((result.plan.args as Record<string, unknown>).area, 'Living Room');
});
