import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { catalogFromHomeAssistant } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';

/**
 * The exposure query is optional: a core that does not implement it must still produce a
 * catalog, and a core that does must trim the catalog to what Assist can actually see.
 * Both paths are exercised over a real websocket, because that is where they differ.
 */
const TOKEN = 'exposure-test-token';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

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
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ maskKey[i % 4]!;
    if (opcode === 0x8) close = true;
    else if (opcode === 0x1) messages.push(payload.toString('utf8'));
    rest = rest.subarray(offset + length);
  }
  return { messages, rest, close };
}

const REGISTRY: Record<string, unknown> = {
  'config/area_registry/list': [{ area_id: 'office', name: 'Office' }],
  'config/floor_registry/list': [],
  'config/device_registry/list': [],
  'config/entity_registry/list': [
    { entity_id: 'light.office_lights', name: 'Office Lights', area_id: 'office' },
    { entity_id: 'sensor.iphone_battery', name: 'iPhone Battery', area_id: 'office' },
  ],
  get_states: [
    { entity_id: 'light.office_lights', state: 'on', attributes: {} },
    { entity_id: 'sensor.iphone_battery', state: '88', attributes: { unit_of_measurement: '%' } },
  ],
};

async function fakeHomeAssistant(exposure: unknown | 'refuse'): Promise<{ url: string; server: Server }> {
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
    socket.write(frame(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' })));

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
          socket.write(frame(JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.0' })));
          continue;
        }
        const reply =
          incoming.type === 'homeassistant/expose_entity/list'
            ? exposure === 'refuse'
              ? undefined
              : exposure
            : REGISTRY[incoming.type];
        socket.write(
          frame(
            JSON.stringify(
              reply === undefined
                ? { id: incoming.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'unknown command' } }
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

async function catalogFrom(url: string) {
  const base = defaultConfig();
  return catalogFromHomeAssistant({
    ...base,
    catalog: { ...base.catalog, haUrl: url, haToken: TOKEN, exposedOnly: true },
  });
}

test('the catalog is trimmed to what Assist exposes', async () => {
  const { url, server } = await fakeHomeAssistant({
    exposed_entities: { conversation: { 'light.office_lights': true, 'sensor.iphone_battery': false }, 'cloud.alexa': {} },
  });
  try {
    const catalog = await catalogFrom(url);
    assert.deepEqual(catalog.entities.map((entity) => entity.id), ['light.office_lights']);
    assert.equal(catalog.note, '1 of 2 entities exposed to Assist, 1 areas');
  } finally {
    server.close();
  }
});

test('a core without the exposure command still produces a catalog', async () => {
  const { url, server } = await fakeHomeAssistant('refuse');
  try {
    const catalog = await catalogFrom(url);
    assert.equal(catalog.entities.length, 2, 'the optional command must not break the catalog');
    assert.match(catalog.note ?? '', /2 entities, 1 areas/);
  } finally {
    server.close();
  }
});
