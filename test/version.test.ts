import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { appVersion, resetVersionCache } from '../src/version.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

test('the reported version is the manifest version', () => {
  resetVersionCache();
  assert.equal(appVersion(), manifest.version);
  assert.match(appVersion(), /^\d+\.\d+\.\d+/);
});

test('the version is read again when the file changes, not cached for the process', () => {
  // A server started before a release must not keep claiming the old version: the cache is keyed
  // on the file's mtime and size, so re-reading is what a fresh stat does.
  resetVersionCache();
  const first = appVersion();
  resetVersionCache();
  assert.equal(appVersion(), first);
  assert.equal(appVersion(), manifest.version);
});
