import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'trp-debug-'));

const { createApp } = await import('../src/server.js');
const { saveConfig } = await import('../src/config.js');

let server: ReturnType<typeof createServer>;
let base = '';

before(async () => {
  saveConfig({
    upstream: { apiKey: 'sk-or-v1-0123456789abcdef', baseUrl: 'https://openrouter.ai/api/v1' },
    catalog: { haToken: 'ha-token-that-should-not-leak' },
  });
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

describe('debug bundle', () => {
  it('downloads as a JSON attachment', async () => {
    // A request first, so the bundle has a log line to carry.
    await fetch(`${base}/api/status`);
    const response = await fetch(`${base}/api/debug/bundle`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="typesafe-proxy-debug-.*\.json"/);
  });

  it('carries the state you would report a bug with', async () => {
    const bundle = (await (await fetch(`${base}/api/debug/bundle`)).json()) as {
      meta: { product: string; version: string; node: string };
      config: { decision: { apiKey: string }; upstream: { apiKey: string }; catalog: { haToken: string } };
      status: { ok: boolean };
      traces: unknown[];
      logs: string[];
      catalog: unknown;
    };

    assert.equal(bundle.meta.product, 'typesafe-routing-proxy');
    assert.ok(bundle.meta.version.length > 0);
    assert.match(bundle.meta.node, /^v\d+\./);
    assert.equal(bundle.status.ok, true);
    assert.ok(Array.isArray(bundle.traces));
    assert.ok(Array.isArray(bundle.logs));
    assert.ok(bundle.logs.some((line) => line.includes('GET /api/status -> 200')));
  });

  it('masks secrets instead of exporting them', async () => {
    const raw = await (await fetch(`${base}/api/debug/bundle`)).text();
    assert.ok(!raw.includes('0123456789abcdef'), 'the upstream key tail must not be exported');
    assert.ok(!raw.includes('ha-token-that-should-not-leak'), 'the Home Assistant token must not be exported');
    assert.ok(raw.includes('sk-or-v1-012'), 'the key prefix is shown so you can tell keys apart');
  });
});
