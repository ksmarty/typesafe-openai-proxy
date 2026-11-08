/**
 * The call a light actually receives.
 *
 * "Set the bedroom lights to 50 percent" produced a perfectly-shaped call —
 * `HassLightSet {"area": "Bedroom", "domain": "light", "brightness": 127}` — and nothing
 * happened. Home Assistant's light intent declares that slot as
 * `probatio.All(probatio.Coerce(int), probatio.Range(0, 100))` and maps it to `brightness_pct`,
 * so 127 is out of range, the intent raises `InvalidSlotInfo`, and a silent rule means nobody
 * hears about it.
 *
 * The slot name cannot tell you the unit, because the same name means two things: on
 * `HassLightSet` it is a percentage, on a raw service call it is the 0-255 attribute. The
 * schema Home Assistant generates from the intent's own validator can, so the conversion
 * reads the declared bounds instead of guessing from the name.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INTENTS } from '../src/actions.js';
import { buildToolCall, inventoryFor, levelForSlot } from '../src/toolcall.js';
import type { OpenAITool } from '../src/types.js';

test('a percentage slot keeps the percentage', () => {
  const declared = { type: 'integer', minimum: 0, maximum: 100 };
  assert.equal(levelForSlot(50, 'brightness', declared), 50);
  assert.equal(levelForSlot(50, 'brightness_pct', declared), 50);
  assert.equal(levelForSlot(50, 'percentage', declared), 50);
  assert.equal(levelForSlot(50, 'volume_level', declared), 50);
  assert.equal(levelForSlot(50, 'position', declared), 50);
});

test('a slot with no declared bounds is still a percentage', () => {
  assert.equal(levelForSlot(50, 'brightness', undefined), 50);
  assert.equal(levelForSlot(50, 'humidity', { type: 'integer' }), 50);
});

test('a raw 0-255 slot is scaled into it instead of overflowing', () => {
  const raw = { type: 'integer', minimum: 0, maximum: 255 };
  assert.equal(levelForSlot(50, 'brightness', raw), 128);
  assert.equal(levelForSlot(100, 'brightness', raw), 255);
  assert.equal(levelForSlot(0, 'brightness', raw), 0);
});

test('a 0-1 fraction slot takes a fraction', () => {
  assert.equal(levelForSlot(50, 'volume_level', { type: 'number', minimum: 0, maximum: 1 }), 0.5);
});

test('a value is clamped to what the slot accepts, never sent out of range', () => {
  const declared = { type: 'integer', minimum: 0, maximum: 100 };
  assert.equal(levelForSlot(150, 'brightness', declared), 100);
  assert.equal(levelForSlot(-20, 'brightness', declared), 0);
  // Out of range in the sentence must not become out of range on the wire, which is what
  // "set it to 200 percent" would otherwise do.
  assert.equal(levelForSlot(200, 'percentage', { type: 'integer', minimum: 0, maximum: 100 }), 100);
});

/**
 * The schema Home Assistant really generates for `HassLightSet`: probatio turns the intent's
 * `Range(0, 100)` into `minimum`/`maximum`, and the slot keeps the intent's own name
 * (`brightness`), while the service argument it maps to is `brightness_pct`.
 */
const lightSet: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'assist__light__HassLightSet',
      description: 'Sets the brightness percentage or color of a light',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          area: { type: 'string' },
          floor: { type: 'string' },
          domain: { type: 'string', enum: ['light'] },
          brightness: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: 'The brightness percentage of the light between 0 and 100, where 0 is off and 100 is fully lit',
          },
          color: { type: 'string' },
        },
      },
    },
  },
];

test('"set the bedroom lights to 50 percent" sends 50, not 127', () => {
  const call = buildToolCall({
    inventory: inventoryFor(lightSet),
    intent: INTENTS.lightSet,
    spec: { intentType: INTENTS.lightSet, valueSlot: 'brightness', valueKind: 'percent' },
    target: { areaName: 'Bedroom', domain: 'light' },
    action: 'set_brightness',
    value: 50,
  });
  assert.ok(!('error' in call), 'error' in call ? String(call.error) : '');
  const args = (call as { args: Record<string, unknown> }).args;
  assert.equal(args.brightness, 50);
  assert.equal(args.area, 'Bedroom');
  assert.equal(args.domain, 'light');
  // The whole failure: a value outside the slot's own range means the intent never runs.
  assert.ok(
    typeof args.brightness === 'number' && args.brightness >= 0 && args.brightness <= 100,
    `brightness ${String(args.brightness)} is outside the slot's declared 0-100`,
  );
});

test('a light whose schema declares 0-255 is still sent a legal value', () => {
  const raw: OpenAITool[] = [
    {
      type: 'function',
      function: {
        name: 'assist__light__HassLightSet',
        description: 'Sets the brightness of a light',
        parameters: {
          type: 'object',
          properties: {
            area: { type: 'string' },
            brightness: { type: 'integer', minimum: 0, maximum: 255 },
          },
        },
      },
    },
  ];
  const call = buildToolCall({
    inventory: inventoryFor(raw),
    intent: INTENTS.lightSet,
    spec: { intentType: INTENTS.lightSet, valueSlot: 'brightness', valueKind: 'percent' },
    target: { areaName: 'Bedroom', domain: 'light' },
    action: 'set_brightness',
    value: 50,
  });
  assert.ok(!('error' in call), 'error' in call ? String(call.error) : '');
  assert.equal((call as { args: Record<string, unknown> }).args.brightness, 128);
});
