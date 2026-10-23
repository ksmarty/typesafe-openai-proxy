/**
 * The settings schema is what the dashboard renders and what the server clamps with, so a
 * setting that exists in the config but not here would be invisible and unvalidated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TEMPLATES, defaultConfig, loadConfig, resetConfig, saveConfig } from '../src/config.js';
import { allFields, clampSettings, fieldFor, getPath, maskSecrets, setPath } from '../src/schema.js';

function leaves(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

test('every config leaf is described by the schema', () => {
  const described = new Set(allFields().map((field) => field.key));
  // Templates are edited as a whole block, not leaf by leaf.
  const missing = leaves(defaultConfig()).filter(
    (key) => !described.has(key) && !key.startsWith('speech.templates.'),
  );
  assert.deepEqual(missing, [], `undescribed settings: ${missing.join(', ')}`);
});

test('every schema field exists in the default config', () => {
  const config = defaultConfig() as unknown as Record<string, unknown>;
  const unknown = allFields()
    .map((field) => field.key)
    .filter((key) => getPath(config, key) === undefined);
  assert.deepEqual(unknown, [], `schema fields with no config value: ${unknown.join(', ')}`);
});

test('thresholds are sliders bounded to 0..1 and stay in range on save', () => {
  const fields = allFields().filter((field) => field.key.startsWith('routing.thresholds.'));
  assert.ok(fields.length >= 20, 'expected the calibrated thresholds to be exposed');
  for (const field of fields) {
    assert.equal(field.type, 'slider');
    assert.equal(field.min, 0);
    assert.equal(field.max, 1);
  }

  const { config, adjusted } = saveConfig({
    routing: { thresholds: { entity: 4, minMargin: -1, actTerse: 0.5 } },
  });
  assert.equal(config.routing.thresholds.entity, 1);
  assert.equal(config.routing.thresholds.minMargin, 0);
  assert.equal(config.routing.thresholds.actTerse, 0.5);
  const keys = adjusted.map((item) => item.key);
  assert.ok(keys.includes('routing.thresholds.entity'));
  assert.ok(keys.includes('routing.thresholds.minMargin'));
  assert.ok(!keys.includes('routing.thresholds.actTerse'), 'a legal value is not reported as adjusted');
  resetConfig();
});

test('a masked secret is left alone and an empty one clears it', () => {
  saveConfig({ decision: { apiKey: 'real-key' } });
  const masked = saveConfig({ decision: { apiKey: '••••••' } });
  assert.equal(masked.config.decision.apiKey, 'real-key', 'the form echoing the mask must not overwrite the key');
  const cleared = saveConfig({ decision: { apiKey: '' } });
  assert.equal(cleared.config.decision.apiKey, '');
  resetConfig();
});

test('numbers, selects and booleans are coerced to their declared type', () => {
  const { config } = saveConfig({
    server: { port: '8080' },
    decision: { alwaysConfirmRisky: 'yes' },
    speech: { afterTool: 'nonsense' },
  });
  assert.equal(config.server.port, 8080);
  assert.equal(config.decision.alwaysConfirmRisky, true);
  assert.equal(config.speech.afterTool, 'template', 'an unknown option falls back to the current value');
  resetConfig();
});

test('saveConfig writes the file and loadConfig reads it back', () => {
  saveConfig({ catalog: { defaultArea: 'Kitchen' } });
  assert.equal(loadConfig(true).catalog.defaultArea, 'Kitchen');
  resetConfig();
  assert.equal(loadConfig(true).catalog.defaultArea, '');
});

test('templates survive a save and are normalised to the three known slots', () => {
  const { config } = saveConfig({
    speech: { templates: { en: { done: 'ok {entity}', clarify: '', confirm: 'sure?' }, de: { done: 'gut' } } },
  });
  assert.deepEqual(config.speech.templates.de, { done: 'gut', clarify: '', confirm: '' });
  assert.equal(config.speech.templates.en.done, 'ok {entity}');
  resetConfig();
  assert.deepEqual(loadConfig(true).speech.templates, DEFAULT_TEMPLATES);
});

test('helpers used by the dashboard match the server copy', () => {
  assert.equal(getPath({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
  const target: Record<string, unknown> = {};
  setPath(target, 'a.b.c', 1);
  assert.deepEqual(target, { a: { b: { c: 1 } } });
  assert.equal(fieldFor('routing.thresholds.minMargin')?.type, 'slider');
  assert.equal(fieldFor('nope')?.type, undefined);
});

test('maskSecrets hides every password field and nothing else', () => {
  const config = defaultConfig() as unknown as Record<string, unknown>;
  setPath(config, 'catalog.haToken', 'tok');
  setPath(config, 'upstream.baseUrl', 'http://x/v1');
  maskSecrets(config);
  assert.equal(getPath(config, 'catalog.haToken'), '••••••');
  assert.equal(getPath(config, 'upstream.baseUrl'), 'http://x/v1');
});

test('clampSettings leaves an untouched config alone', () => {
  assert.deepEqual(clampSettings(defaultConfig() as unknown as Record<string, unknown>), []);
});
