import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { startServer } from '../src/server.js';
import { trace } from '../src/state.js';

/**
 * A request that never becomes a turn still has to be visible.
 *
 * The deployment that prompted this answered 401 on every attempt because the API key
 * did not match, and the dashboard showed nothing at all — which reads as "the proxy
 * never saw my request" when it saw every one of them.
 */
describe('refused requests are traced', () => {
  let server: Server;
  let base = '';
  const dataDir = mkdtempSync(join(tmpdir(), 'trp-refuse-'));

  before(async () => {
    process.env.DATA_DIR = dataDir;
    process.env.PROXY_API_KEY = 'the-right-key';
    process.env.DECISION_BACKEND = 'none';
    server = startServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once('listening', () => resolve());
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    trace.length = 0;
  });

  after(() => {
    server.close();
    delete process.env.PROXY_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records a 401 with the reason, so the dashboard shows it', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: 'typesafe-router', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 401);
    await response.json();

    const traceResponse = await fetch(`${base}/api/trace?limit=10`);
    const body = (await traceResponse.json()) as { items: { route: string; httpStatus?: number; reason: string }[] };
    const refused = body.items.find((item) => item.route === 'refused');
    assert.ok(refused, 'a refused entry should be in the trace');
    assert.equal(refused.httpStatus, 401);
    assert.match(refused.reason, /bearer token/);
  });

  it('records a 400 for a body that is not JSON', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer the-right-key' },
      body: '{ not json',
    });
    assert.equal(response.status, 400);
    await response.json();

    const body = (await fetch(`${base}/api/trace?limit=10`).then((r) => r.json())) as {
      items: { route: string; httpStatus?: number }[];
    };
    assert.ok(body.items.some((item) => item.route === 'refused' && item.httpStatus === 400));
  });

  it('names the build it is, so a stale container is obvious', async () => {
    const body = (await fetch(`${base}/api/status`).then((r) => r.json())) as { version?: string };
    assert.match(String(body.version), /^\d+\.\d+\.\d+/);
  });

  it('does not refuse a correct key', async () => {
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer the-right-key' } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: { id: string }[] };
    assert.ok(body.data.some((model) => model.id === 'typesafe-router'));
  });
});
