/**
 * One key, two servers.
 *
 * Both endpoints are often the same provider (OpenRouter serving the decision model and
 * the fallback model), and the dashboard only ever shows twelve characters of a saved
 * key — so "reuse the decision key" has to be a setting rather than a copy-paste.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig, loadConfig, saveConfig, SECRET_MASK, upstreamApiKey } from '../src/config.js';

function withConfig(patch: (config: ReturnType<typeof defaultConfig>) => void) {
  const config = defaultConfig();
  patch(config);
  return config;
}

test('a key typed for the upstream server always wins', () => {
  const config = withConfig((c) => {
    c.decision.apiKey = 'decision-key';
    c.upstream.apiKey = 'own-key';
    c.upstream.apiKeyFromDecision = true;
  });
  assert.equal(upstreamApiKey(config), 'own-key');
});

test('the decision key is reused when the upstream key is empty and the flag is on', () => {
  const config = withConfig((c) => {
    c.decision.apiKey = 'decision-key';
    c.upstream.apiKey = '';
    c.upstream.apiKeyFromDecision = true;
  });
  assert.equal(upstreamApiKey(config), 'decision-key');
});

test('the flag off leaves a forwarded request without a token', () => {
  const config = withConfig((c) => {
    c.decision.apiKey = 'decision-key';
    c.upstream.apiKey = '';
    c.upstream.apiKeyFromDecision = false;
  });
  assert.equal(upstreamApiKey(config), '');
});

test('the flag on with no decision key still sends nothing', () => {
  const config = withConfig((c) => {
    c.decision.apiKey = '';
    c.upstream.apiKeyFromDecision = true;
  });
  assert.equal(upstreamApiKey(config), '');
});

test('surrounding space in a pasted key does not leak into the header', () => {
  const config = withConfig((c) => {
    c.decision.apiKey = '  decision-key\n';
    c.upstream.apiKeyFromDecision = true;
  });
  assert.equal(upstreamApiKey(config), 'decision-key');
});

test('the setting is off by default, so an existing install is unchanged', () => {
  assert.equal(defaultConfig().upstream.apiKeyFromDecision, false);
});

test('the setting survives a save round trip and is not treated as a secret', () => {
  const saved = saveConfig({ upstream: { apiKeyFromDecision: true } });
  assert.equal(saved.config.upstream.apiKeyFromDecision, true);
  const reloaded = loadConfig(true);
  assert.equal(reloaded.upstream.apiKeyFromDecision, true);
  assert.notEqual(reloaded.upstream.apiKey, SECRET_MASK);
  // Leave the file as it was.
  saveConfig({ upstream: { apiKeyFromDecision: false } });
});
