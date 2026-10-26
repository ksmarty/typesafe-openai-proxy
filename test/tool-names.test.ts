import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildToolCall, describeInventory, findTool, hasTool, inventoryFor, shortToolName } from '../src/toolcall.js';
import { INTENTS } from '../src/actions.js';
import type { OpenAITool } from '../src/types.js';

/**
 * Home Assistant 2026.10 exposes its intents under a namespace — `assist__intent__HassTurnOn`,
 * `assist__light__HassLightSet` — and the tool call has to come back with exactly that name.
 * Matching on the short name is what makes "is HassTurnOff offered?" answerable at all.
 */
const namespaced: OpenAITool[] = [
  'assist__intent__HassTurnOn',
  'assist__intent__HassTurnOff',
  'assist__intent__HassNevermind',
  'assist__light__HassLightSet',
  'assist__media_player__HassMediaNext',
  'assist__homeassistant__GetLiveContext',
].map((name) => ({
  type: 'function' as const,
  function: {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' }, brightness_pct: { type: 'number' } },
    },
  },
}));

test('shortToolName strips the namespace', () => {
  assert.equal(shortToolName('assist__intent__HassTurnOn'), 'HassTurnOn');
  assert.equal(shortToolName('assist__media_player__HassMediaNext'), 'HassMediaNext');
  assert.equal(shortToolName('HassTurnOn'), 'HassTurnOn');
});

test('a namespaced inventory still answers hasTool and reports readable names', () => {
  const inventory = inventoryFor(namespaced);
  assert.ok(hasTool(inventory, INTENTS.turnOn));
  assert.ok(hasTool(inventory, INTENTS.turnOff));
  assert.ok(hasTool(inventory, INTENTS.lightSet));
  assert.ok(!hasTool(inventory, INTENTS.getState));
  assert.equal(findTool(inventory, INTENTS.turnOff)?.name, 'assist__intent__HassTurnOff');
  assert.match(describeInventory(inventory), /HassTurnOn/);
  assert.doesNotMatch(describeInventory(inventory), /assist__intent__/, 'the message reads as intent names');
});

test('the call comes back under the name Home Assistant offered', () => {
  const inventory = inventoryFor(namespaced);
  const call = buildToolCall({
    inventory,
    intent: INTENTS.turnOff,
    spec: { intentType: INTENTS.turnOff },
    target: { entity: { id: 'light.office_lights', name: 'Office Overhead', domain: 'light', state: 'on' } },
    action: 'turn_off',
    domain: 'light',
  });
  assert.ok(!('error' in call), 'error' in call ? String(call.error) : '');
  assert.equal((call as { tool: string }).tool, 'assist__intent__HassTurnOff');
  assert.deepEqual((call as { args: Record<string, unknown> }).args, { name: 'light.office_lights' });
});

test('an area call keeps the domain slot and the namespaced name', () => {
  const inventory = inventoryFor(namespaced);
  const call = buildToolCall({
    inventory,
    intent: INTENTS.turnOn,
    spec: { intentType: INTENTS.turnOn },
    target: { areaName: 'Office', domain: 'light' },
    action: 'turn_on',
    domain: 'light',
  });
  assert.ok(!('error' in call), 'error' in call ? String(call.error) : '');
  assert.equal((call as { tool: string }).tool, 'assist__intent__HassTurnOn');
  assert.deepEqual((call as { args: Record<string, unknown> }).args, { area: 'Office', domain: 'light' });
});

test('an intent that is not offered still names itself and lists what is', () => {
  const inventory = inventoryFor(namespaced);
  const call = buildToolCall({
    inventory,
    intent: INTENTS.getState,
    spec: { intentType: INTENTS.getState },
    target: { entity: { id: 'light.office_lights', name: 'Office Overhead', domain: 'light', state: 'on' } },
    action: 'query',
    domain: 'light',
  });
  assert.ok('error' in call);
  assert.match(String(call.error), /HassGetState is not offered by Home Assistant/);
  assert.match(String(call.error), /HassTurnOn/);
});
