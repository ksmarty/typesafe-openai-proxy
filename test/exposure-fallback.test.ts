/**
 * When Home Assistant will not report exposure, the catalog must still narrow.
 *
 * The endpoint requires an administrator token, so a perfectly configured proxy can get
 * `unauthorized` there while every other registry query succeeds — and then every entity in
 * the house reaches the decision model. These tests pin the two guards: narrow to what the
 * request's system prompt named, and never narrow on a guess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { narrowCatalog, narrowFromPrompt } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';
import type { Catalog, CatalogEntity } from '../src/types.js';

function entity(id: string, areaId = 'kitchen'): CatalogEntity {
  return {
    id,
    name: id.split('.')[1] ?? id,
    domain: id.split('.')[0] ?? 'light',
    state: 'off',
    areaId,
    areaName: areaId === 'kitchen' ? 'Kitchen' : 'Office',
  };
}

function catalog(entityCount: number): Catalog {
  const entities = Array.from({ length: entityCount }, (_, index) => entity(`light.lamp_${index}`));
  entities.push(entity('sensor.phone_battery'));
  return {
    areas: [
      { id: 'kitchen', name: 'Kitchen' },
      { id: 'office', name: 'Office' },
    ],
    entities,
    domains: ['light', 'sensor'],
    source: 'ha-websocket',
    builtAt: Date.now(),
    note: `${entities.length} entities, 2 areas from Home Assistant`,
    exposure: { ok: false, reason: 'unauthorized', registry: entities.length, used: 'none' },
  };
}

const prompt = [
  'Current time is 9:41 AM.',
  '## Kitchen',
  '- Kitchen Ceiling: light.lamp_0',
  '- Desk Lamp: light.lamp_1',
  '## Office',
  '- Office Lamp: light.lamp_2',
].join('\n');

test('a catalog narrows to the entity ids it is given', () => {
  const before = catalog(6);
  const after = narrowCatalog(before, new Set(['light.lamp_1', 'light.lamp_2']), 'why');

  assert.deepEqual(
    after.entities.map((one) => one.id),
    ['light.lamp_1', 'light.lamp_2'],
  );
  assert.match(after.note ?? '', /2 of 7 entities \(why\)/);
  assert.equal(after.exposure?.used, 'prompt');
  assert.equal(after.exposure?.exposed, 2);
  // Areas follow the surviving entities: both live in the kitchen, so the office drops out.
  assert.deepEqual(
    after.areas.map((area) => area.name),
    ['Kitchen'],
  );
  const withOffice = narrowCatalog(before, new Set(['light.lamp_1', 'sensor.phone_battery']), 'why');
  assert.equal(withOffice.entities.length, 2);
});

test('the system prompt supplies the ids when exposure is refused', () => {
  const config = defaultConfig();
  config.catalog.exposedOnly = true;
  const after = narrowFromPrompt(catalog(6), prompt, config);

  assert.deepEqual(after.entities.map((one) => one.id).sort(), [
    'light.lamp_0',
    'light.lamp_1',
    'light.lamp_2',
  ]);
  assert.match(after.note ?? '', /Home Assistant did not report exposure/);
});

test('nothing narrows when exposure was readable', () => {
  const config = defaultConfig();
  const before = catalog(6);
  const readable: Catalog = { ...before, exposure: { ok: true, exposed: 3, registry: 7, used: 'expose_entity_list' } };
  assert.equal(narrowFromPrompt(readable, prompt, config), readable);
});

test('nothing narrows when the setting is off', () => {
  const config = defaultConfig();
  config.catalog.exposedOnly = false;
  const before = catalog(6);
  assert.equal(narrowFromPrompt(before, prompt, config), before);
});

test('nothing narrows on a prompt that names almost everything', () => {
  const config = defaultConfig();
  const before = catalog(2);
  const after = narrowFromPrompt(before, prompt, config);
  // Two of the three named ids are in the catalog, which is not a meaningful narrowing.
  assert.equal(after, before);
});

test('nothing narrows on a prompt it cannot read', () => {
  const config = defaultConfig();
  const before = catalog(6);
  assert.equal(narrowFromPrompt(before, 'no devices are listed here', config), before);
  assert.equal(narrowFromPrompt(before, undefined, config), before);
});
