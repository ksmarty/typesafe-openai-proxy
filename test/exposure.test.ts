import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogFromRegistries, exposedToConversation } from '../src/catalog.js';

/**
 * Home Assistant says 18 entities are exposed to Assist; the proxy listed 356. The catalog
 * only filtered on disabled/hidden/category and never asked what was exposed, so the decision
 * model saw the whole registry. These tests pin the exposure filter.
 */
const registries = {
  areas: [{ area_id: 'office', name: 'Office' }],
  floors: [],
  devices: [],
  entities: [
    { entity_id: 'light.office_lights', name: 'Office Lights', area_id: 'office' },
    { entity_id: 'switch.desk', name: 'Desk', area_id: 'office' },
    { entity_id: 'sensor.iphone_battery', name: 'iPhone Battery', area_id: 'office' },
    { entity_id: 'sensor.bambu_tray', name: 'Bambu Tray', area_id: 'office' },
    { entity_id: 'light.hidden_one', name: 'Hidden', hidden_by: 'user' },
  ],
  states: [
    { entity_id: 'light.office_lights', state: 'on', attributes: {} },
    { entity_id: 'switch.desk', state: 'off', attributes: {} },
    { entity_id: 'sensor.iphone_battery', state: '82', attributes: { unit_of_measurement: '%' } },
    { entity_id: 'sensor.bambu_tray', state: '0', attributes: {} },
    { entity_id: 'light.hidden_one', state: 'on', attributes: {} },
  ],
};

test('the per-assistant map is read, the other assistants ignored', () => {
  const map = exposedToConversation({
    exposed_entities: {
      conversation: { 'light.office_lights': true, 'switch.desk': false },
      'cloud.alexa': { 'sensor.iphone_battery': true },
    },
  });
  assert.deepEqual(map, { 'light.office_lights': true, 'switch.desk': false });
});

test('a flat boolean map and a per-entity object both read', () => {
  assert.deepEqual(exposedToConversation({ exposed_entities: { 'light.a': true, 'light.b': false } }), {
    'light.a': true,
    'light.b': false,
  });
  assert.deepEqual(exposedToConversation({ 'light.a': { conversation: false }, 'light.b': { conversation: true } }), {
    'light.a': false,
    'light.b': true,
  });
});

test('an answer that cannot be read returns null, never an empty allow-list', () => {
  assert.equal(exposedToConversation(null), null);
  assert.equal(exposedToConversation({ nope: true }), null);
  assert.equal(exposedToConversation({ exposed_entities: {} }), null);
});

test('only exposed entities reach the catalog, and the note says so', () => {
  const catalog = catalogFromRegistries({
    ...registries,
    exposed: { 'light.office_lights': true, 'switch.desk': true, 'sensor.iphone_battery': false, 'sensor.bambu_tray': false },
  });
  assert.deepEqual(
    catalog.entities.map((entity) => entity.id),
    ['light.office_lights', 'switch.desk'],
  );
  // 4 registry rows survive disabled/hidden filtering (the hidden light is dropped first).
  assert.equal(catalog.note, '2 of 4 entities exposed to Assist, 1 areas');
});

test('without an exposure answer the registry is used, as before', () => {
  const catalog = catalogFromRegistries({ ...registries, exposed: null });
  assert.equal(catalog.entities.length, 4);
  assert.match(catalog.note ?? '', /4 entities, 1 areas/);
});

test('the switch turns the filter off for people who want the whole registry', () => {
  const catalog = catalogFromRegistries({
    ...registries,
    exposed: { 'light.office_lights': true },
    exposedOnly: false,
  });
  assert.equal(catalog.entities.length, 4);
});
