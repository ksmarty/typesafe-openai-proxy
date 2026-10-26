import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultConfig, saveConfig, publicConfig } from '../src/config.js';
import { isMaskedValue, maskSecret } from '../src/schema.js';
import { decisionBase } from '../src/systemone.js';

test('decisionBase accepts a root, a /v1 root and the full endpoint', () => {
  for (const input of [
    'https://openrouter.ai/api',
    'https://openrouter.ai/api/',
    'https://openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1/',
    'https://openrouter.ai/api/v1/systemone',
    '  https://openrouter.ai/api/v1/systemone/  ',
  ]) {
    assert.equal(decisionBase(input), 'https://openrouter.ai/api', input);
  }
  assert.equal(decisionBase('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(decisionBase('http://localhost:11434/v1/systemone'), 'http://localhost:11434');
  // A base that legitimately ends in a path keeps it; only the contract suffixes go.
  assert.equal(decisionBase('https://host/prefix'), 'https://host/prefix');
  assert.equal(decisionBase(''), '');
  assert.equal(decisionBase('   '), '');
});

test('a saved secret shows its first characters and nothing else', () => {
  const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  const masked = maskSecret(key);
  assert.equal(masked.slice(0, 12), key.slice(0, 12));
  assert.ok(masked.endsWith('••••••'));
  assert.ok(!masked.includes('0123456789abcdef'), 'the body must not survive the mask');
  // Too short to show a prefix without revealing most of the value.
  assert.equal(maskSecret('short'), '••••••');
  assert.equal(maskSecret(''), '');
});

test('echoing the mask back keeps the stored secret', () => {
  const base = defaultConfig();
  base.decision.apiKey = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  saveConfig(base);

  const shown = publicConfig().decision.apiKey;
  assert.match(shown, /^sk-or-v1-012••••••$/);
  assert.ok(isMaskedValue(shown));

  // The dashboard sends the masked field back untouched when only other fields changed.
  saveConfig({ decision: { apiKey: shown, model: 'typesafe/jev-1.14' } });
  const reloaded = publicConfig();
  assert.equal(reloaded.decision.model, 'typesafe/jev-1.14');
  assert.match(reloaded.decision.apiKey, /^sk-or-v1-012••••••$/);

  // A new key replaces it.
  saveConfig({ decision: { apiKey: 'sk-or-v1-fedcba9876543210fedcba9876543210' } });
  assert.match(publicConfig().decision.apiKey, /^sk-or-v1-fed••••••$/);
});
