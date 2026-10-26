import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { catalogFromHomeAssistant } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';
import { maskSecret, secretOrStored } from '../src/schema.js';

/**
 * A token that Home Assistant rejects is what the dashboard reported after the
 * key preview changed from a bare mask to `prefix + mask`: the connection test
 * compared the submitted value against the mask string, decided `abc123••••••`
 * was a real token, and sent it. This exercises the real websocket path against
 * a stand-in Home Assistant so the regression cannot come back silently.
 */
const GOOD_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long-lived-token-value';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** Read complete client frames (masked, as browsers send them) out of a buffer. */
function readFrames(buffer: Buffer): { messages: string[]; rest: Buffer; close: boolean } {
  const messages: string[] = [];
  let rest = buffer;
  let close = false;
  for (;;) {
    if (rest.length < 2) break;
    const opcode = rest[0]! & 0x0f;
    const masked = (rest[1]! & 0x80) !== 0;
    let length = rest[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      offset = 4;
    }
    const maskKey = masked ? rest.subarray(offset, offset + 4) : Buffer.alloc(0);
    if (masked) offset += 4;
    if (rest.length < offset + length) break;
    const payload = Buffer.from(rest.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ maskKey[i % 4]!;
    }
    // 0x1 is a text frame; a close frame arrives when the client gives up on bad auth.
    if (opcode === 0x8) close = true;
    else if (opcode === 0x1) messages.push(payload.toString('utf8'));
    rest = rest.subarray(offset + length);
  }
  return { messages, rest, close };
}

const REPLIES: Record<string, unknown> = {
  'config/area_registry/list': [{ area_id: 'kitchen', name: 'Kitchen' }],
  'config/floor_registry/list': [{ floor_id: 'ground', name: 'Ground floor' }],
  'config/device_registry/list': [],
  'config/entity_registry/list': [
    { entity_id: 'light.kitchen_ceiling', name: 'Ceiling', area_id: 'kitchen', device_class: null },
  ],
  get_states: [
    { entity_id: 'light.kitchen_ceiling', state: 'on', attributes: { friendly_name: 'Kitchen ceiling' } },
  ],
};

/** Home Assistant's websocket handshake, auth and the five queries the catalog asks. */
async function fakeHomeAssistant(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
    );
    socket.write(frame(JSON.stringify({ type: 'auth_required', ha_version: '2026.5.0' })));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      const parsed = readFrames(Buffer.concat([buffer, chunk]));
      buffer = parsed.rest;
      if (parsed.close) {
        socket.end();
        return;
      }
      for (const message of parsed.messages) {
        const incoming = JSON.parse(message) as { id?: number; type: string; access_token?: string };
        if (incoming.type === 'auth') {
          socket.write(
            frame(
              JSON.stringify(
                incoming.access_token === GOOD_TOKEN
                  ? { type: 'auth_ok', ha_version: '2026.5.0' }
                  : { type: 'auth_invalid', message: 'Invalid access token or password' },
              ),
            ),
          );
          continue;
        }
        const reply = REPLIES[incoming.type];
        socket.write(
          frame(
            JSON.stringify(
              reply === undefined
                ? { id: incoming.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'unknown' } }
                : { id: incoming.id, type: 'result', success: true, result: reply },
            ),
          ),
        );
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, server };
}

test('the stored Home Assistant token survives the masked preview', async () => {
  const { url, server } = await fakeHomeAssistant();
  try {
    const base = defaultConfig();
    const preview = maskSecret(GOOD_TOKEN);
    assert.notEqual(preview, GOOD_TOKEN, 'the dashboard only ever sees a preview');
    assert.ok(preview.endsWith('••••••'));

    // What the connection test used to send: the preview string itself.
    const broken = { ...base, catalog: { ...base.catalog, haUrl: url, haToken: preview } };
    await assert.rejects(
      () => catalogFromHomeAssistant(broken),
      /rejected the token|auth_invalid/i,
      'a preview sent as a token must fail — this is the bug that was reported',
    );

    // What it sends now: the preview resolves to the stored secret.
    const fixed = {
      ...base,
      catalog: { ...base.catalog, haUrl: url, haToken: secretOrStored(preview, GOOD_TOKEN) },
    };
    const catalog = await catalogFromHomeAssistant(fixed);
    assert.equal(catalog.entities.length, 1);
    assert.equal(catalog.entities[0]?.id, 'light.kitchen_ceiling');
    assert.equal(catalog.areas[0]?.name, 'Kitchen');
    assert.equal(catalog.source, 'ha-websocket');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('secretOrStored keeps, replaces and ignores secrets the way a form needs', () => {
  const stored = 'eyJhbGciOiJIUzI1NiIs.secret';
  assert.equal(secretOrStored(undefined, stored), stored, 'absent field');
  assert.equal(secretOrStored('', stored), stored, 'empty box means unchanged');
  assert.equal(secretOrStored(maskSecret(stored), stored), stored, 'masked preview');
  assert.equal(secretOrStored('••••••', stored), stored, 'bare mask from an old cache');
  assert.equal(secretOrStored('sk-or-v1-new-key-0123456789', stored), 'sk-or-v1-new-key-0123456789', 'new secret');
});
