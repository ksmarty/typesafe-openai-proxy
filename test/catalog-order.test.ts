import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { catalogFromHomeAssistant } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';

/**
 * Answers may arrive in any order.
 *
 * Home Assistant multiplexes commands on one socket and is free to reply out of order, so the
 * batch must match answers by id. A sequential batch also shares one deadline, which is how a
 * large get_states used to starve the exposure list and leave 356 entities in a house with 18
 * exposed. This fake replies in reverse and checks the catalog still says 2.
 */
const TOKEN = 'order-test-token';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const ANSWERS: Record<string, unknown> = {
  'homeassistant/expose_entity/list': {
    exposed_entities: {
      'light.kitchen_lights': { conversation: true },
      'switch.projector_power': { conversation: true },
      'sensor.iphone_battery': { 'cloud.alexa': true },
    },
  },
  'config/area_registry/list': [{ area_id: 'kitchen', name: 'Kitchen' }],
  'config/device_registry/list': [],
  'config/floor_registry/list': [],
  'config/entity_registry/list': [
    { entity_id: 'light.kitchen_lights', name: 'Kitchen Lights', area_id: 'kitchen' },
    { entity_id: 'switch.projector_power', name: 'Projector Power', area_id: 'kitchen' },
    { entity_id: 'sensor.iphone_battery', name: 'iPhone Battery', area_id: 'kitchen' },
  ],
  get_states: [
    { entity_id: 'light.kitchen_lights', state: 'on', attributes: {} },
    { entity_id: 'switch.projector_power', state: 'off', attributes: {} },
    { entity_id: 'sensor.iphone_battery', state: '88', attributes: {} },
  ],
};

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

function readFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let rest = buffer;
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
    if (opcode === 0x1) messages.push(payload.toString('utf8'));
    rest = rest.subarray(offset + length);
  }
  return { messages, rest };
}

/** Replies to every command at once, in reverse order, as Home Assistant may. */
async function reverseAnsweringHomeAssistant(): Promise<{ url: string; server: Server; stop: () => void }> {
  const server = createServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });
  const sockets: import('node:stream').Duplex[] = [];
  server.on('upgrade', (request, socket) => {
    sockets.push(socket);
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
    const pending: { id?: number; type: string }[] = [];
    let flushed = false;

    socket.on('data', (chunk: Buffer) => {
      const parsed = readFrames(Buffer.concat([buffer, chunk]));
      buffer = parsed.rest;
      for (const message of parsed.messages) {
        const incoming = JSON.parse(message) as { id?: number; type: string };
        if (incoming.type === 'auth') {
          socket.write(frame(JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.0' })));
          continue;
        }
        pending.push(incoming);
      }
      if (flushed || pending.length < 6) return;
      flushed = true;
      for (const incoming of [...pending].reverse()) {
        const result = ANSWERS[incoming.type];
        socket.write(
          frame(
            JSON.stringify(
              result === undefined
                ? { id: incoming.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'unknown command' } }
                : { id: incoming.id, type: 'result', success: true, result },
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
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test('answers are matched by id, not by arrival order', async () => {
  const { url, stop } = await reverseAnsweringHomeAssistant();
  try {
    const base = defaultConfig();
    const catalog = await catalogFromHomeAssistant({
      ...base,
      catalog: { ...base.catalog, haUrl: url, haToken: TOKEN, exposedOnly: true },
    });

    // Exposure decides, whatever order the answers came back in.
    assert.deepEqual(
      catalog.entities.map((entity) => entity.id).sort(),
      ['light.kitchen_lights', 'switch.projector_power'],
    );
    assert.equal(catalog.exposure?.ok, true);
    assert.equal(catalog.exposure?.exposed, 2);
    assert.equal(catalog.exposure?.registry, 3);
    assert.match(catalog.note ?? '', /2 of 3 entities exposed to Assist/);
    // Areas came back in their own slot, not shuffled by the reverse reply.
    assert.deepEqual(
      catalog.areas.map((area) => area.name),
      ['Kitchen'],
    );
  } finally {
    stop();
  }
});
