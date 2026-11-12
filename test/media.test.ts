import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromRegistries, clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { mediaPlan, readPower, readTransport } from '../src/media.js';
import { runPipeline } from '../src/pipeline.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Catalog, OpenAITool } from '../src/types.js';

/**
 * The house these tests listen in: Music Assistant's player on the satellite that was spoken
 * to, a kitchen speaker, and a television that is off until a test switches it on.
 */
function house(): Catalog {
  return catalogFromRegistries({
    areas: [
      { area_id: 'living', name: 'Living Room' },
      { area_id: 'kitchen', name: 'Kitchen' },
    ],
    floors: [],
    devices: [
      { device_id: 'dev-satellite', name: 'Voice Assistant 1', area_id: 'living' },
      { device_id: 'dev-tv', name: 'Living Room TV', area_id: 'living' },
      { device_id: 'dev-kitchen', name: 'Kitchen Speaker', area_id: 'kitchen' },
    ],
    entities: [
      {
        entity_id: 'media_player.voice_assistant_1_media_player_2',
        name: '(MA) Voice Assistant 1',
        device_id: 'dev-satellite',
        area_id: 'living',
      },
      { entity_id: 'media_player.living_room', name: 'Living Room TV', device_id: 'dev-tv', area_id: 'living' },
      { entity_id: 'media_player.kitchen_speaker', name: 'Kitchen Speaker', device_id: 'dev-kitchen', area_id: 'kitchen' },
      { entity_id: 'light.kitchen_ceiling', name: 'Kitchen Ceiling', area_id: 'kitchen' },
    ],
    states: [
      { entity_id: 'media_player.voice_assistant_1_media_player_2', state: 'playing', attributes: {} },
      { entity_id: 'media_player.living_room', state: 'off', attributes: { device_class: 'tv' } },
      { entity_id: 'media_player.kitchen_speaker', state: 'idle', attributes: {} },
      { entity_id: 'light.kitchen_ceiling', state: 'on', attributes: {} },
    ],
  });
}

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required } },
  };
}

const NAME = { name: { type: 'string', description: 'Name of the device to control.' } };

/** The media intents Home Assistant offers an Assist agent, as the debug export lists them. */
function mediaTools(): OpenAITool[] {
  return [
    tool('HassMediaPause', NAME),
    tool('HassMediaUnpause', NAME),
    tool('HassMediaNext', NAME),
    tool('HassMediaPrevious', NAME),
    tool('HassSetVolumeRelative', {
      name: { type: 'string' },
      volume_step: { type: 'integer', description: 'Percentage to change the volume by.' },
    }),
    tool('HassMediaPlayerMute', NAME),
    tool('HassMediaPlayerUnmute', NAME),
    tool('HassTurnOff', NAME),
    tool('HassTurnOn', NAME),
  ];
}

function config(patch: Partial<Config['media']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', autoStart: true, historyTurns: 0 },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    media: { ...base.media, ...patch },
  };
}

const PROMPT = [
  'Available Devices:',
  '(MA) Voice Assistant 1 (media_player.voice_assistant_1_media_player_2): playing',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Kitchen Speaker (media_player.kitchen_speaker): idle',
  'Living Room TV (media_player.living_room): off',
].join('\n');

// ---------------------------------------------------------------------------
// Reading the sentence
// ---------------------------------------------------------------------------

test('"pause", "stop the music", "volume up" and "next song" are all commands', () => {
  assert.deepEqual(readTransport('pause'), { kind: 'pause', bare: true });
  assert.deepEqual(readTransport('Stop the music.'), { kind: 'stop', bare: false });
  assert.deepEqual(readTransport('volume up'), { kind: 'louder', bare: false });
  assert.deepEqual(readTransport('next song'), { kind: 'next', bare: false });
  assert.deepEqual(readTransport('skip this one'), { kind: 'next', bare: false });
  assert.deepEqual(readTransport('go back'), { kind: 'previous', bare: true });
  assert.deepEqual(readTransport('mute'), { kind: 'mute', bare: true });
});

test('"a lot" and "a little" say how far the volume moves', () => {
  assert.equal(readTransport('turn it up a lot')?.magnitude, 'large');
  assert.equal(readTransport('volume down a little')?.magnitude, 'slight');
  assert.equal(readTransport('turn it up')?.magnitude, undefined);
});

test('a command aimed at something that is not the music stays with the model', () => {
  assert.equal(readTransport('pause the vacuum'), null);
  assert.equal(readTransport('turn up the heat'), null);
  assert.equal(readTransport('stop the timer'), null);
  assert.equal(readTransport('what is playing'), null);
});

test('"play Taylor Swift" is the music reader\'s sentence, not a transport command', () => {
  assert.equal(readTransport('play Taylor Swift'), null);
  assert.equal(readTransport('put on some jazz'), null);
});

test('a television has to be named before a power sentence is read here', () => {
  assert.deepEqual(readPower('turn the TV off'), { on: false });
  assert.deepEqual(readPower('switch the television back on'), { on: true });
  assert.deepEqual(readPower('turn the living room TV off'), { on: false });
  // "it" could be anything, and "turn off the lights" is a light command.
  assert.equal(readPower('turn it off'), null);
  assert.equal(readPower('turn off the lights'), null);
  assert.equal(readPower('turn down the volume'), null);
});

// ---------------------------------------------------------------------------
// Choosing the player and making the call
// ---------------------------------------------------------------------------

function planFor(text: string, active: Config = config(), deviceId?: string) {
  return mediaPlan({
    utterance: text,
    catalog: house(),
    inventory: inventoryFor(mediaTools()),
    config: active,
    ...(deviceId ? { deviceId } : {}),
  });
}

test('"pause" pauses the player on the device that was spoken to', () => {
  const plan = planFor('pause', config(), 'dev-satellite');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'HassMediaPause');
  assert.deepEqual(plan.plan.args, { name: 'media_player.voice_assistant_1_media_player_2' });
  assert.deepEqual(plan.plan.targets, ['media_player.voice_assistant_1_media_player_2']);
  assert.equal(plan.plan.action, 'pause');
  assert.equal(plan.plan.domain, 'media_player');
  assert.match(plan.reason, /^media: pause on \(MA\) Voice Assistant 1/);
  assert.match(plan.reason, /no model call/);
});

test('"pause in the kitchen" pauses the speaker in the kitchen', () => {
  const plan = planFor('pause in the kitchen');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.deepEqual(plan.plan.args, { name: 'media_player.kitchen_speaker' });
  assert.match(plan.reason, /the one player in Kitchen/);
});

test('"stop the music" cuts the playback rather than leaving it paused', () => {
  const plan = planFor('stop the music', config(), 'dev-satellite');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'HassTurnOff');
  assert.deepEqual(plan.plan.args, { name: 'media_player.voice_assistant_1_media_player_2' });
});

test('volume moves by a relative step, not to a level', () => {
  const up = planFor('volume up', config(), 'dev-satellite');
  if (!up || 'error' in up) throw new Error(up ? up.error : 'no plan');
  assert.equal(up.plan.tool, 'HassSetVolumeRelative');
  assert.equal(up.plan.args.volume_step, 13);

  const loud = planFor('turn it up a lot', config(), 'dev-satellite');
  if (!loud || 'error' in loud) throw new Error(loud ? loud.error : 'no plan');
  assert.equal(loud.plan.args.volume_step, 25);

  const down = planFor('volume down', config(), 'dev-satellite');
  if (!down || 'error' in down) throw new Error(down ? down.error : 'no plan');
  assert.equal(down.plan.args.volume_step, -13);
});

test('"next song" skips, and "go back" goes back', () => {
  const next = planFor('next song', config(), 'dev-satellite');
  if (!next || 'error' in next) throw new Error(next ? next.error : 'no plan');
  assert.equal(next.plan.tool, 'HassMediaNext');

  const back = planFor('go back', config(), 'dev-satellite');
  if (!back || 'error' in back) throw new Error(back ? back.error : 'no plan');
  assert.equal(back.plan.tool, 'HassMediaPrevious');
});

test('two players playing at once is an error, not a guess', () => {
  const catalog = house();
  // The television is playing too, and neither of the two is Music Assistant's own player:
  // there is nothing here to prefer one by.
  const both = {
    ...catalog,
    entities: catalog.entities.map((entity) =>
      entity.id === 'media_player.voice_assistant_1_media_player_2'
        ? { ...entity, state: 'idle' }
        : entity.id === 'media_player.living_room' || entity.id === 'media_player.kitchen_speaker'
          ? { ...entity, state: 'playing' }
          : entity,
    ),
  };
  const plan = mediaPlan({
    utterance: 'pause the music',
    catalog: both,
    inventory: inventoryFor(mediaTools()),
    config: config(),
  });
  assert.equal(plan !== null && 'error' in plan, true);
  if (!plan || !('error' in plan)) return;
  assert.match(plan.error, /2 players are playing/);
});

// ---------------------------------------------------------------------------
// Televisions
// ---------------------------------------------------------------------------

test('"turn the TV on" switches on the television, and off switches it off', () => {
  const on = planFor('turn the TV on');
  if (!on || 'error' in on) throw new Error(on ? on.error : 'no plan');
  assert.equal(on.plan.tool, 'HassTurnOn');
  assert.deepEqual(on.plan.args, { name: 'media_player.living_room' });
  assert.equal(on.plan.action, 'turn_on');
  assert.match(on.reason, /Living Room TV on/);

  const off = planFor('turn the TV off');
  if (!off || 'error' in off) throw new Error(off ? off.error : 'no plan');
  assert.equal(off.plan.tool, 'HassTurnOff');
  assert.deepEqual(off.plan.args, { name: 'media_player.living_room' });
  assert.equal(off.plan.action, 'turn_off');
});

test('a television named outright is the one that is switched', () => {
  const plan = planFor('switch off the Living Room TV');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.deepEqual(plan.plan.args, { name: 'media_player.living_room' });
});

test('a power sentence about a speaker is not a television sentence', () => {
  // Only a television is switched by this reader: a speaker is switched by its own commands.
  assert.equal(readPower('turn off the kitchen speaker'), null);
  assert.equal(readPower('turn on the projector'), null);
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

async function decide(text: string, active: Config, tools: OpenAITool[] = mediaTools(), deviceId?: string) {
  clearCatalogCache();
  return runPipeline(
    {
      model: 'test',
      messages: [{ role: 'user', content: text }],
      tools,
      ...(deviceId ? { device_id: deviceId } : {}),
    },
    text,
    PROMPT,
    active,
  );
}

test('"pause" is one tool call and no model call', async () => {
  const result = await decide('pause', config(), mediaTools(), 'dev-satellite');
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'HassMediaPause');
  assert.equal(result.entry.backend, 'off');
  assert.match(result.entry.reason, /media: pause/);
});

test('switching the feature off leaves the sentence to the model server', async () => {
  const result = await decide('pause', config({ enabled: false }), mediaTools(), 'dev-satellite');
  assert.notEqual(result.route.plan.kind, 'tool');
});

test('a command this reader cannot place is forwarded, and the trace says why', async () => {
  // Two players playing at once is the case that must not be guessed: the sentence goes to the
  // model, and the trace says why this reader would not choose between them.
  const twoPlaying = [
    'Available Devices:',
    'Kitchen Speaker (media_player.kitchen_speaker): playing',
    'Desk Speaker (media_player.desk_speaker): playing',
  ].join('\n');
  clearCatalogCache();
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'pause the music' }], tools: mediaTools() },
    'pause the music',
    twoPlaying,
    config(),
  );
  assert.equal(result.route.plan.kind, 'forward');
  assert.match(result.entry.reason, /\(media: 2 players are playing/);
});

// ---------------------------------------------------------------------------
// A kiosk music script steers what plays, on the speaker its kiosk follows
// ---------------------------------------------------------------------------

/** The Kiosk Satellite music blueprint, as an exposed script looks in the request's tools. */
function kioskScript(): OpenAITool {
  return tool(
    'script__kiosk_satellite_music',
    {
      action: {
        type: 'string',
        enum: [
          'play',
          'show',
          'now_playing',
          'pause',
          'resume',
          'next',
          'previous',
          'volume',
          'volume_up',
          'volume_down',
          'queue',
          'clear_queue',
          'speakers',
        ],
      },
      query: { type: 'string' },
      kind: { type: 'string', enum: ['track', 'album', 'artist', 'playlist', 'radio', 'podcast', 'audiobook'] },
      artist: { type: 'string' },
      mode: { type: 'string', enum: ['replace', 'next', 'add', 'radio'] },
      speaker: { type: 'string' },
      level: { type: 'number' },
      kiosk: { type: 'string' },
    },
    ['action'],
  );
}

function kioskPlanFor(text: string, deviceId?: string) {
  return mediaPlan({
    utterance: text,
    catalog: house(),
    inventory: inventoryFor([kioskScript(), ...mediaTools()]),
    config: config(),
    ...(deviceId ? { deviceId } : {}),
  });
}

test('"pause" is sent to the kiosk music script as its own action', () => {
  const plan = kioskPlanFor('pause', 'dev-satellite');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'script__kiosk_satellite_music');
  assert.deepEqual(plan.plan.args, { action: 'pause', speaker: 'Living Room' });
  assert.deepEqual(plan.plan.targets, []);
  assert.match(plan.reason, /^media: pause in Living Room via the kiosk music script, no model call/);
});

test('a volume step and a skip are the kiosk script\'s actions too', () => {
  const up = kioskPlanFor('volume up', 'dev-satellite');
  if (!up || 'error' in up) throw new Error(up ? up.error : 'no plan');
  assert.deepEqual(up.plan.args, { action: 'volume_up', speaker: 'Living Room' });

  const next = kioskPlanFor('next song', 'dev-satellite');
  if (!next || 'error' in next) throw new Error(next ? next.error : 'no plan');
  assert.equal(next.plan.args.action, 'next');
});

test('a room named in the sentence goes to the kiosk script as the speaker', () => {
  const plan = kioskPlanFor('pause in the kitchen', 'dev-satellite');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.deepEqual(plan.plan.args, { action: 'pause', speaker: 'Kitchen' });
});

test('stop keeps going to the player, because the kiosk script has no stop', () => {
  const plan = kioskPlanFor('stop the music', 'dev-satellite');
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'HassTurnOff');
  assert.deepEqual(plan.plan.args, { name: 'media_player.voice_assistant_1_media_player_2' });
});
