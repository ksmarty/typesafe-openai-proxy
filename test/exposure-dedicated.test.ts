import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { catalogFromHomeAssistant } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';

/**
 * The exposure list must not depend on the six-command batch.
 *
 * It once shared one socket and one deadline with areas, devices, floors, entities and a large
 * get_states; when its answer was lost or refused the catalog silently kept the whole registry.
 * This fake refuses exposure on the first socket (the batch) and answers it on the next (the
 * dedicated question the Check exposure button also asks), which is what a busy core looks like.
 */
const TOKEN = 'dedicated-exposure-token';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const EXPOSED = {
  exposed_entities: {
    'light.kitchen_lights': { conversation: true },
    'switch.projector_power': { conversation: true },
  },
};

const ANSWERS: Record<string, unknown> = {
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

async function busyHomeAssistant(): Promise<{ url: string; stop: () => void }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(400);
    response.end();
  });
  const sockets: import('node:stream').Duplex[] = [];
  let connection = 0;

  server.on('upgrade', (request, socket) => {
    sockets.push(socket);
    connection += 1;
    const refusing = connection === 1;
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
      for (const message of parsed.messages) {
        const incoming = JSON.parse(message) as { id?: number; type: string };
        if (incoming.type === 'auth') {
          socket.write(frame(JSON.stringify({ type: 'auth_ok', ha_version: '2026.10.0' })));
          continue;
        }
        const exposure = incoming.type === 'homeassistant/expose_entity/list';
        if (exposure && refusing) {
          socket.write(
            frame(
              JSON.stringify({
                id: incoming.id,
                type: 'result',
                success: false,
                error: { code: 'unknown_command', message: 'Unknown command.' },
              }),
            ),
          );
          continue;
        }
        const result = exposure ? EXPOSED : ANSWERS[incoming.type];
        if (result === undefined) {
          socket.write(
            frame(
              JSON.stringify({
                id: incoming.id,
                type: 'result',
                success: false,
                error: { code: 'unknown_command', message: 'Unknown command.' },
              }),
            ),
          );
          continue;
        }
        socket.write(frame(JSON.stringify({ id: incoming.id, type: 'result', success: true, result })));
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test('exposure is read on its own, so a refused batch answer cannot restore the whole registry', async () => {
  const { url, stop } = await busyHomeAssistant();
  try {
    const base = defaultConfig();
    const catalog = await catalogFromHomeAssistant({
      ...base,
      catalog: { ...base.catalog, haUrl: url, haToken: TOKEN, exposedOnly: true },
    });

    assert.deepEqual(
      catalog.entities.map((entity) => entity.id).sort(),
      ['light.kitchen_lights', 'switch.projector_power'],
    );
    assert.equal(catalog.exposure?.ok, true);
    assert.equal(catalog.exposure?.used, 'expose_entity_list');
    assert.equal(catalog.exposure?.exposed, 2);
    assert.equal(catalog.exposure?.registry, 3);
  } finally {
    stop();
  }
});
