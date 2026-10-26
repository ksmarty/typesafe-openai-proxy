/**
 * The generated bearer token has to be long, URL-safe, unique per call, and mintable from
 * the browser — the dashboard fills `server.apiKey` with it, and `crypto.randomUUID` throws
 * inside the embedded preview, so the generator deliberately avoids it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsGroups } from '../src/schema.js';
import { generateToken, TOKEN_PREFIX } from '../src/token.js';

test('a generated token carries the recognisable prefix and 32 random characters', () => {
  const token = generateToken();
  assert.ok(token.startsWith(TOKEN_PREFIX), token);
  assert.equal(token.length, TOKEN_PREFIX.length + 32);
  assert.match(token, /^sk-proxy-[A-Za-z0-9_-]{32}$/);
});

test('no two tokens are the same', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(generateToken());
  assert.equal(seen.size, 500);
});

test('the alphabet is URL-safe, so it survives a query string untouched', () => {
  for (let i = 0; i < 50; i += 1) {
    const body = generateToken('').slice(0);
    assert.equal(encodeURIComponent(body), body);
  }
});

test('a caller can supply its own prefix', () => {
  assert.match(generateToken('hass-'), /^hass-[A-Za-z0-9_-]{32}$/);
});

test('the generate button is offered on the proxy bearer token and nowhere else', () => {
  const fields = settingsGroups().flatMap((group) => group.fields);
  const marked = fields.filter((field) => field.generate).map((field) => field.key);
  assert.deepEqual(marked, ['server.apiKey']);
});
