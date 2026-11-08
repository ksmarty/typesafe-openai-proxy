import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromPrompt, catalogFromRegistries, clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { mediaTypeFor, musicCall, musicPlan, musicTarget, musicTool, readMusicRequest } from '../src/music.js';
import { runPipeline } from '../src/pipeline.js';
import { ruleFor } from '../src/speech.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Catalog, OpenAITool } from '../src/types.js';

/**
 * The house these tests play in: two rooms, one speaker each, and the device id Home
 * Assistant would send with a request spoken to the kitchen.
 */
function home(): Catalog {
  return {
    areas: [
      { id: 'kitchen', name: 'Kitchen' },
      { id: 'living', name: 'Living Room' },
    ],
    entities: [
      {
        id: 'media_player.kitchen_speaker',
        name: 'Kitchen Speaker',
        domain: 'media_player',
        state: 'idle',
        areaId: 'kitchen',
        areaName: 'Kitchen',
        deviceId: 'dev-kitchen',
      },
      {
        id: 'media_player.living_speaker',
        name: 'Living Room Speaker',
        domain: 'media_player',
        state: 'playing',
        areaId: 'living',
        areaName: 'Living Room',
        deviceId: 'dev-living',
      },
      { id: 'light.kitchen_ceiling', name: 'Kitchen Ceiling', domain: 'light', state: 'on', areaId: 'kitchen' },
    ],
    domains: ['media_player', 'light'],
    source: 'manual',
    builtAt: Date.now(),
  };
}

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required } },
  };
}

/** Music Assistant's play service, as Home Assistant exposes it. */
function musicAssistant(): OpenAITool {
  return tool(
    'music_assistant__play_media',
    {
      media_id: { type: 'string', description: 'Name, URI or id of the media to play.' },
      media_type: {
        type: 'string',
        enum: ['artist', 'album', 'track', 'playlist', 'radio', 'genre'],
      },
      artist: { type: 'string', description: 'Artist name, for telling albums apart.' },
      enqueue: { type: 'string', enum: ['play', 'replace', 'next', 'replace_next', 'add'] },
      entity_id: { type: 'string', description: 'The player to play on.' },
    },
    ['media_id'],
  );
}

/** Home Assistant's own media intent, the fallback when Music Assistant is not installed. */
function assistSearch(): OpenAITool {
  return tool('HassMediaSearchAndPlay', {
    name: { type: 'string' },
    search_query: { type: 'string' },
  });
}

function config(patch: Partial<Config['music']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', autoStart: true, historyTurns: 0 },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    music: { ...base.music, ...patch },
  };
}

const PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Kitchen Speaker (media_player.kitchen_speaker): idle',
].join('\n');

// ---------------------------------------------------------------------------
// Reading the sentence
// ---------------------------------------------------------------------------

test('a bare name is an artist, which every provider plays as their top tracks', () => {
  const request = readMusicRequest('Play Taylor Swift');
  assert.deepEqual(request, { query: 'Taylor Swift', kind: 'artist', bare: true });
});

test('"X by Y" is an album, because that is how people name one', () => {
  const request = readMusicRequest('play Don’t Tap The Glass by Tyler The Creator');
  assert.equal(request?.query, "Don't Tap The Glass");
  assert.equal(request?.artist, 'Tyler The Creator');
  assert.equal(request?.kind, 'album');
  assert.equal(request?.bare, false);
});

test('an explicit media type wins over the shape of the phrase', () => {
  assert.equal(readMusicRequest('play the album Don’t Tap The Glass by Tyler The Creator')?.kind, 'album');
  assert.equal(readMusicRequest('play the song Bad Guy by Billie Eilish')?.kind, 'track');
  assert.equal(readMusicRequest('play the playlist Deep Focus')?.kind, 'playlist');
  assert.equal(readMusicRequest('play radio station BBC Radio 4')?.kind, 'radio');
  assert.equal(readMusicRequest('play some jazz')?.kind, 'genre');
});

test('the media type word is taken out of the name', () => {
  assert.equal(readMusicRequest('play the album Don’t Tap The Glass')?.query, "Don't Tap The Glass");
  assert.equal(readMusicRequest('play the song Bad Guy')?.query, 'Bad Guy');
  assert.equal(readMusicRequest('play the playlist Deep Focus')?.query, 'Deep Focus');
});

test('"their greatest hits" is still the artist', () => {
  assert.deepEqual(readMusicRequest("play Taylor Swift's greatest hits"), {
    query: 'Taylor Swift',
    kind: 'artist',
    bare: false,
  });
  assert.equal(readMusicRequest('play the top hits of Queen')?.query, 'Queen');
  assert.equal(readMusicRequest('play music by Queen')?.query, 'Queen');
});

test('a speaker at the end of the sentence is a target, not part of the name', () => {
  const request = readMusicRequest('play Taylor Swift on the kitchen speaker', home());
  assert.equal(request?.query, 'Taylor Swift');
  assert.equal(request?.on, 'kitchen speaker');
});

test('a room at the end of the sentence is a target too', () => {
  assert.equal(readMusicRequest('put on Taylor Swift in the living room', home())?.on, 'living room');
});

test('a provider at the end is dropped without becoming a target', () => {
  const request = readMusicRequest('play Taylor Swift on Spotify', home());
  assert.equal(request?.query, 'Taylor Swift');
  assert.equal(request?.on, undefined);
});

test('a phrase that is a playback command is not something to search for', () => {
  assert.equal(readMusicRequest('play music'), null);
  assert.equal(readMusicRequest('play something'), null);
  assert.equal(readMusicRequest('put some music on'), null);
  assert.equal(readMusicRequest('play the next song'), null);
  assert.equal(readMusicRequest('pause the music'), null);
});

test('a question about what is playing is not a request', () => {
  assert.equal(readMusicRequest('what is playing?'), null);
  assert.equal(readMusicRequest('which song is this?'), null);
});

test('a sentence with no playback verb is left alone', () => {
  assert.equal(readMusicRequest('turn on the kitchen light'), null);
  assert.equal(readMusicRequest('set the volume to 20 percent'), null);
});

test('lead-ins and a polite "can you" are stripped before the verb', () => {
  assert.equal(readMusicRequest('Hey, can you play Taylor Swift please')?.query, 'Taylor Swift');
  assert.equal(readMusicRequest("I'd like to listen to Taylor Swift")?.query, 'Taylor Swift');
});

// ---------------------------------------------------------------------------
// Choosing the speaker
// ---------------------------------------------------------------------------

test('the sentence plays on the device that was spoken to', () => {
  const target = musicTarget(home(), { deviceId: 'dev-kitchen' });
  assert.equal('player' in target && target.player.id, 'media_player.kitchen_speaker');
});

test('a speaker named in the sentence wins over the spoken-to device', () => {
  const target = musicTarget(home(), { on: 'living room speaker', deviceId: 'dev-kitchen' });
  assert.equal('player' in target && target.player.id, 'media_player.living_speaker');
});

test('a room named in the sentence wins over the spoken-to device', () => {
  const target = musicTarget(home(), { on: 'the living room', deviceId: 'dev-kitchen' });
  assert.equal('player' in target && target.player.id, 'media_player.living_speaker');
});

test('a house with two speakers and no device id is ambiguous, not a guess', () => {
  const target = musicTarget(home());
  assert.equal('error' in target, true);
});

test('the only speaker in the house is the speaker', () => {
  const catalog = home();
  catalog.entities = catalog.entities.filter((entity) => entity.id !== 'media_player.living_speaker');
  const target = musicTarget(catalog);
  assert.equal('player' in target && target.player.id, 'media_player.kitchen_speaker');
});

// ---------------------------------------------------------------------------
// Building the call
// ---------------------------------------------------------------------------

test('Music Assistant gets the name, the type, the queue and the player', () => {
  const inventory = inventoryFor([musicAssistant(), assistSearch()]);
  const call = musicCall({
    request: readMusicRequest('play Taylor Swift')!,
    player: home().entities[0]!,
    inventory,
    config: config(),
  });
  assert.equal('error' in call, false);
  if ('error' in call) return;
  assert.equal(call.provider, 'music_assistant');
  assert.equal(call.tool, 'music_assistant__play_media');
  assert.equal(call.args.media_id, 'Taylor Swift');
  assert.equal(call.args.media_type, 'artist');
  assert.equal(call.args.enqueue, 'replace');
  assert.equal(call.args.entity_id, 'media_player.kitchen_speaker');
});

test('an album carries its artist, so two albums of one name cannot be confused', () => {
  const inventory = inventoryFor([musicAssistant()]);
  const call = musicCall({
    request: readMusicRequest('play Don’t Tap The Glass by Tyler The Creator')!,
    player: home().entities[0]!,
    inventory,
    config: config(),
  });
  if ('error' in call) throw new Error(call.error);
  assert.equal(call.args.media_id, "Don't Tap The Glass");
  assert.equal(call.args.media_type, 'album');
  assert.equal(call.args.artist, 'Tyler The Creator');
});

test('a media type the service does not declare is not sent', () => {
  const narrow = tool('music_assistant__play_media', {
    media_id: { type: 'string' },
    media_type: { type: 'string', enum: ['track', 'album'] },
    entity_id: { type: 'string' },
  });
  const call = musicCall({
    request: readMusicRequest('play Taylor Swift')!,
    player: home().entities[0]!,
    inventory: inventoryFor([narrow]),
    config: config(),
  });
  if ('error' in call) throw new Error(call.error);
  assert.equal('media_type' in call.args, false);
});

test('without Music Assistant the Home Assistant intent takes one search string', () => {
  const call = musicCall({
    request: readMusicRequest('play Don’t Tap The Glass by Tyler The Creator')!,
    player: home().entities[0]!,
    inventory: inventoryFor([assistSearch()]),
    config: config({ provider: 'assist' }),
  });
  if ('error' in call) throw new Error(call.error);
  assert.equal(call.provider, 'assist');
  assert.equal(call.tool, 'HassMediaSearchAndPlay');
  assert.equal(call.args.search_query, "Don't Tap The Glass by Tyler The Creator");
  assert.equal(call.args.name, 'media_player.kitchen_speaker');
});

test('the provider setting decides whether Music Assistant is used', () => {
  const inventory = inventoryFor([musicAssistant(), assistSearch()]);
  assert.equal(musicTool(inventory, 'assist'), undefined);
  assert.equal(musicTool(inventory, 'auto')?.provider, 'music_assistant');
  assert.equal(musicTool(inventoryFor([assistSearch()]), 'music_assistant'), undefined);
});

test('an artist can be asked for as a radio station instead of top tracks', () => {
  assert.equal(mediaTypeFor('artist', 'artist'), 'artist');
  assert.equal(mediaTypeFor('artist', 'radio'), 'radio');
  assert.equal(mediaTypeFor('album', 'radio'), 'album');
});

test('a request with no speaker to play on is an error, not a call', () => {
  const plan = musicPlan({
    utterance: 'play Taylor Swift',
    catalog: home(),
    inventory: inventoryFor([musicAssistant()]),
    config: config(),
  });
  assert.equal(plan !== null && 'error' in plan, true);
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

async function decide(text: string, active: Config, tools: OpenAITool[]) {
  clearCatalogCache();
  return runPipeline({ model: 'test', messages: [{ role: 'user', content: text }], tools }, text, PROMPT, active);
}

test('"play Taylor Swift" becomes one Music Assistant call, with no model call', async () => {
  const result = await decide('play Taylor Swift', config(), [musicAssistant(), assistSearch()]);
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'music_assistant__play_media');
  assert.equal(plan.args.media_id, 'Taylor Swift');
  assert.equal(plan.args.media_type, 'artist');
  assert.equal(plan.args.entity_id, 'media_player.kitchen_speaker');
  assert.equal(result.entry.backend, 'off');
  assert.match(result.entry.reason, /Music Assistant/);
});

test('the album example plays the album on the speaker spoken to', async () => {
  const result = await decide('play Don’t Tap The Glass by Tyler The Creator', config(), [musicAssistant()]);
  const plan = result.route.plan;
  if (plan.kind !== 'tool') throw new Error(`expected a tool plan, got ${plan.kind}`);
  assert.equal(plan.args.media_id, "Don't Tap The Glass");
  assert.equal(plan.args.media_type, 'album');
  assert.equal(plan.args.artist, 'Tyler The Creator');
  assert.deepEqual(plan.targets, ['media_player.kitchen_speaker']);
});

test('switching the feature off leaves the sentence to the model server', async () => {
  const result = await decide('play Taylor Swift', config({ enabled: false }), [musicAssistant()]);
  assert.notEqual(result.route.plan.kind, 'tool');
});

test('a sentence that is not about music is untouched', async () => {
  const turnOn = tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' } });
  const result = await decide('turn on the kitchen ceiling', config(), [musicAssistant(), turnOn]);
  assert.equal(result.route.plan.kind, 'tool');
  if (result.route.plan.kind !== 'tool') return;
  assert.equal(result.route.plan.tool, 'HassTurnOn');
});

test('nothing is said after the music starts, by default', () => {
  const rules = defaultConfig().speech.rules;
  const rule = ruleFor(rules, {
    tool: 'music_assistant__play_media',
    domain: 'music_assistant',
    action: 'search_and_play',
  });
  assert.equal(rule?.mode, 'silent');
});

test('the catalog from a prompt still finds the only speaker in the house', () => {
  const catalog = catalogFromPrompt(PROMPT);
  const target = musicTarget(catalog);
  assert.equal('player' in target && target.player.id, 'media_player.kitchen_speaker');
});

// ---------------------------------------------------------------------------
// The shape a real house has: Home Assistant's own play service, televisions in the room
// ---------------------------------------------------------------------------

/** Home Assistant's generic play service, as service tools are named: domain__service. */
function playerPlayService(): OpenAITool {
  return tool(
    'media_player__play_media',
    {
      entity_id: { type: 'string', description: 'The player to play on.' },
      media_content_id: { type: 'string', description: 'Name or URI of the media.' },
      media_content_type: { type: 'string', description: 'artist, album, track, playlist, radio.' },
      enqueue: { type: 'string', enum: ['play', 'replace', 'next', 'replace_next', 'add'] },
    },
    ['media_content_id'],
  );
}

/** A living room with two televisions and the Music Assistant speaker, as in the user's house. */
function tvRoom(): Catalog {
  return {
    areas: [{ id: 'living', name: 'Living Room' }],
    entities: [
      {
        id: 'media_player.apple_tv',
        name: 'Apple TV',
        domain: 'media_player',
        state: 'off',
        areaId: 'living',
        areaName: 'Living Room',
        deviceClass: 'tv',
      },
      {
        id: 'media_player.living_room',
        name: 'Living Room TV',
        domain: 'media_player',
        state: 'playing',
        areaId: 'living',
        areaName: 'Living Room',
        deviceClass: 'tv',
      },
      {
        id: 'media_player.voice_assistant_1_media_player_2',
        name: '(MA) Voice Assistant 1',
        domain: 'media_player',
        state: 'idle',
        areaId: 'living',
        areaName: 'Living Room',
        deviceId: 'dev-satellite',
      },
    ],
    domains: ['media_player'],
    source: 'manual',
    builtAt: Date.now(),
  };
}

test('the player service Home Assistant really offers is found, and takes content id and type', () => {
  const inventory = inventoryFor([playerPlayService()]);
  assert.equal(musicTool(inventory)?.provider, 'media_player');
  const call = musicCall({
    request: readMusicRequest('play Taylor Swift')!,
    player: tvRoom().entities[2]!,
    inventory,
    config: config(),
  });
  if ('error' in call) throw new Error(call.error);
  assert.equal(call.provider, 'media_player');
  assert.equal(call.args.media_content_id, 'Taylor Swift');
  assert.equal(call.args.media_content_type, 'artist');
  assert.equal(call.args.enqueue, 'replace');
  assert.equal(call.args.entity_id, 'media_player.voice_assistant_1_media_player_2');
});

test("Music Assistant's own service is preferred over the player's play service", () => {
  const inventory = inventoryFor([playerPlayService(), musicAssistant()]);
  assert.equal(musicTool(inventory)?.provider, 'music_assistant');
  assert.equal(musicTool(inventory, 'music_assistant')?.name, 'music_assistant__play_media');
});

test('a room in the sentence is a room, not the television named after it', () => {
  const target = musicTarget(tvRoom(), { on: 'living room' });
  if ('error' in target) throw new Error(target.error);
  assert.equal(target.player.id, 'media_player.voice_assistant_1_media_player_2');
});

test('a television is passed over for a speaker in the same room', () => {
  const target = musicTarget(tvRoom(), { deviceId: 'dev-satellite' });
  if ('error' in target) throw new Error(target.error);
  assert.equal(target.player.id, 'media_player.voice_assistant_1_media_player_2');
});

test('the player on the device spoken to wins over the room it stands in', () => {
  const target = musicTarget(tvRoom(), { on: 'living room', deviceId: 'dev-satellite' });
  if ('error' in target) throw new Error(target.error);
  assert.equal(target.player.deviceId, 'dev-satellite');
});

test('"play Taylor Swift in the living room" becomes one player-service call', async () => {
  const result = await decide(
    'play Taylor Swift in the living room',
    config(),
    [playerPlayService(), musicAssistant()].slice(0, 1),
  );
  // The fast path reads the sentence with the catalog it built from the prompt, which has one
  // speaker; the room in the sentence is not in it, so the only speaker plays.
  const plan = result.route.plan;
  assert.equal(plan.kind, 'tool');
  if (plan.kind !== 'tool') return;
  assert.equal(plan.tool, 'media_player__play_media');
  assert.equal(plan.args.media_content_type, 'artist');
  assert.equal(result.entry.backend, 'off');
});

/** The user's house, as Home Assistant describes it in the system prompt. */
const TV_ROOM_PROMPT = [
  'Available Devices:',
  '## Living Room',
  'Apple TV (media_player.apple_tv): off',
  'Living Room TV (media_player.living_room): playing',
  '(MA) Voice Assistant 1 (media_player.voice_assistant_1_media_player_2): idle',
  'Living Room Lamp (light.living_room_lamp): on',
].join('\n');

test('in a room with two televisions, "play Taylor Swift" starts on the speaker', async () => {
  clearCatalogCache();
  const active = config();
  const withArea: Config = { ...active, catalog: { ...active.catalog, defaultArea: 'Living Room' } };
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'Play Taylor Swift.' }], tools: [playerPlayService()] },
    'Play Taylor Swift.',
    TV_ROOM_PROMPT,
    withArea,
  );
  const plan = result.route.plan;
  if (plan.kind !== 'tool') throw new Error(`expected a tool plan, got ${plan.kind} (${result.entry.reason})`);
  assert.equal(plan.tool, 'media_player__play_media');
  assert.deepEqual(plan.targets, ['media_player.voice_assistant_1_media_player_2']);
  assert.equal(plan.args.media_content_id, 'Taylor Swift');
  assert.equal(plan.args.media_content_type, 'artist');
  assert.equal(result.entry.backend, 'off');
});

test('the album example reaches the player service with the album type', async () => {
  clearCatalogCache();
  const active = config();
  const withArea: Config = { ...active, catalog: { ...active.catalog, defaultArea: 'Living Room' } };
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: 'x' }], tools: [playerPlayService()] },
    'play Don’t Tap The Glass by Tyler The Creator',
    TV_ROOM_PROMPT,
    withArea,
  );
  const plan = result.route.plan;
  if (plan.kind !== 'tool') throw new Error(`expected a tool plan, got ${plan.kind} (${result.entry.reason})`);
  assert.equal(plan.args.media_content_id, "Don't Tap The Glass");
  assert.equal(plan.args.media_content_type, 'album');
});

/** The house as the diagnostic bundle showed it: registry rows, device classes, a satellite device. */
function realHouse(): Catalog {
  return catalogFromRegistries({
    areas: [{ area_id: 'living', name: 'Living Room' }],
    floors: [],
    devices: [
      { device_id: 'dev-satellite', name: 'Voice Assistant 1', area_id: 'living' },
      { device_id: 'dev-apple', name: 'Apple TV', area_id: 'living' },
      { device_id: 'dev-tv', name: 'Living Room TV', area_id: 'living' },
    ],
    entities: [
      { entity_id: 'media_player.apple_tv', name: 'Apple TV', device_id: 'dev-apple' },
      { entity_id: 'media_player.living_room', name: 'Living Room TV', device_id: 'dev-tv' },
      {
        entity_id: 'media_player.voice_assistant_1_media_player_2',
        name: '(MA) Voice Assistant 1',
        device_id: 'dev-satellite',
      },
      { entity_id: 'light.living_room_lamp', name: 'Living Room Lamp', area_id: 'living' },
    ],
    states: [
      { entity_id: 'media_player.apple_tv', state: 'off', attributes: { device_class: 'tv' } },
      { entity_id: 'media_player.living_room', state: 'playing', attributes: { device_class: 'tv' } },
      { entity_id: 'media_player.voice_assistant_1_media_player_2', state: 'idle', attributes: {} },
      { entity_id: 'light.living_room_lamp', state: 'on', attributes: {} },
    ],
  });
}

test('the user\'s own house plays "Taylor Swift" on the speaker in the room it was asked', () => {
  const catalog = realHouse();
  const plan = musicPlan({
    utterance: 'Play Taylor Swift.',
    catalog,
    inventory: inventoryFor([playerPlayService()]),
    config: config(),
    deviceId: 'dev-satellite',
  });
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'media_player__play_media');
  assert.deepEqual(plan.plan.targets, ['media_player.voice_assistant_1_media_player_2']);
  assert.equal(plan.plan.args.media_content_id, 'Taylor Swift');
  assert.equal(plan.plan.args.media_content_type, 'artist');
  assert.match(plan.reason, /the player's own play service/);
});

test('the same house plays the album on Music Assistant when its service is exposed', () => {
  const catalog = realHouse();
  const plan = musicPlan({
    utterance: 'play Don’t Tap The Glass by Tyler The Creator',
    catalog,
    inventory: inventoryFor([musicAssistant(), playerPlayService()]),
    config: config(),
    deviceId: 'dev-satellite',
  });
  if (!plan || 'error' in plan) throw new Error(plan ? plan.error : 'no plan');
  assert.equal(plan.plan.tool, 'music_assistant__play_media');
  assert.equal(plan.plan.args.media_id, "Don't Tap The Glass");
  assert.equal(plan.plan.args.media_type, 'album');
  assert.equal(plan.plan.args.artist, 'Tyler The Creator');
  assert.equal(plan.plan.args.entity_id, 'media_player.voice_assistant_1_media_player_2');
});

test('a play service that targets by name, the way Assist intents do, still gets the speaker', () => {
  const byName = tool(
    'media_player__play_media',
    {
      name: { type: 'string', description: 'The player to play on.' },
      media_content_id: { type: 'string' },
      media_content_type: { type: 'string' },
    },
    ['media_content_id'],
  );
  const call = musicCall({
    request: readMusicRequest('play Taylor Swift')!,
    player: tvRoom().entities[2]!,
    inventory: inventoryFor([byName]),
    config: config(),
  });
  if ('error' in call) throw new Error(call.error);
  assert.equal(call.args.name, 'media_player.voice_assistant_1_media_player_2');
});
