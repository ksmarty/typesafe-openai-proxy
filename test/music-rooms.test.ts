import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogFromPrompt } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { extract } from '../src/extract.js';
import { actionQuestion, buildQuestions, Q } from '../src/questions.js';
import { route } from '../src/router.js';
import { inventoryFor } from '../src/toolcall.js';
import type { Answer, Catalog, OpenAITool } from '../src/types.js';

/**
 * Playing something that was named for a room.
 *
 * Home Assistant offers one `media_player.play_media` service and a room is a perfectly good way
 * to say where the music goes, so a sentence like "play Taylor Swift in the living room" has to
 * end in one call on the speaker that stands in that room. The room decides, the television is
 * passed over, and two speakers with nothing to choose between them is still handed on.
 */

const SLOTS = {
  entity_id: { type: 'string' },
  media_content_id: { type: 'string' },
  media_content_type: { type: 'string' },
  enqueue: { type: 'string', enum: ['play', 'replace', 'next', 'replace_next', 'add'] },
};

const PLAY_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'media_player__play_media',
    description: 'Play media',
    parameters: { type: 'object', properties: SLOTS, required: ['media_content_id'] },
  },
};

const HOME: Catalog = catalogFromPrompt(
  [
    '## Kitchen',
    '- Kitchen Speaker (media_player.kitchen_speaker): idle',
    '## Living Room',
    '- Apple TV (media_player.apple_tv): off',
    '- Living Room TV (media_player.living_room): playing',
    '- (MA) Voice Assistant 1 (media_player.voice_assistant_1_media_player_2): idle',
    '- Living Room Lamp (light.living_room_lamp): on',
    '## Office',
    '- Desk Speaker (media_player.desk_speaker): idle',
    '- Office Speaker (media_player.office_speaker): idle',
  ].join('\n'),
);

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '', defaultArea: 'Living Room' },
  };
}

function routeFor(
  utterance: string,
  answers: Record<string, Answer>,
  catalog: Catalog = HOME,
  tools: OpenAITool[] = [PLAY_TOOL],
) {
  const extraction = extract(utterance, { entityNames: catalog.entities.map((entity) => entity.name) });
  const built = buildQuestions(catalog, extraction, { maxOptions: 40, defaultArea: 'Living Room' });
  return route({
    utterance,
    catalog,
    answers,
    built,
    extraction,
    config: config(),
    inventory: inventoryFor(tools),
  });
}

/** Home Assistant's own media search, offered when Music Assistant has no play service of its own. */
const ASSIST_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'HassMediaSearchAndPlay',
    description: 'Play media by search',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, search_query: { type: 'string' } },
      required: ['search_query'],
    },
  },
};

/** A play service that insists on a content type and only knows the generic one. */
const STRICT_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'media_player__play_media',
    description: 'Play media',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        media_content_id: { type: 'string' },
        media_content_type: { type: 'string', enum: ['music'] },
      },
      required: ['media_content_id', 'media_content_type'],
    },
  },
};

function choice(choice: string, probabilities: Record<string, number>): Answer {
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] ?? 0.9 };
}

function playInArea(area: string): Record<string, Answer> {
  return {
    [Q.category]: choice('command', { command: 0.99 }),
    [Q.scope]: choice('area', { area: 0.92, single: 0.05 }),
    [Q.targetArea]: choice(`area_${area}`, { [`area_${area}`]: 0.96 }),
    [Q.targetDomain]: choice('media_player', { media_player: 0.94 }),
    [actionQuestion('media_player')]: choice('search_and_play', { search_and_play: 1 }),
  };
}

test('a room named for music plays on the speaker in that room, not on the TV', () => {
  const result = routeFor('play Taylor Swift in the living room', playInArea('living_room'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'media_player__play_media');
  assert.equal(result.plan.args.entity_id, 'media_player.voice_assistant_1_media_player_2');
  assert.equal(result.plan.args.media_content_id, 'Taylor Swift');
  assert.equal(result.plan.args.media_content_type, 'artist');
  assert.deepEqual(result.plan.targets, ['media_player.voice_assistant_1_media_player_2']);
});

test('a room with one speaker needs no guess at all', () => {
  const result = routeFor('play Taylor Swift in the kitchen', playInArea('kitchen'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.args.entity_id, 'media_player.kitchen_speaker');
});

test('the album example works the same way, artist included in the search', () => {
  const result = routeFor("play Don't Tap The Glass by Tyler The Creator in the kitchen", playInArea('kitchen'));
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.args.entity_id, 'media_player.kitchen_speaker');
  assert.match(String(result.plan.args.media_content_id), /Don'?t Tap The Glass/);
});

test('two speakers in the room stay a question rather than a guess', () => {
  const result = routeFor('play Taylor Swift in the office', playInArea('office'));
  assert.equal(result.plan.kind, 'forward');
  if (result.plan.kind !== 'forward') return;
  assert.match(result.plan.reason, /2 speakers in Office/);
});

test('music for two rooms is one call per room, each on that room\'s speaker', () => {
  const result = routeFor('play Taylor Swift in the kitchen and the living room', {
    [Q.category]: choice('command', { command: 0.99 }),
    [Q.scope]: choice('area', { area: 0.9 }),
    [Q.targetDomain]: choice('media_player', { media_player: 0.95 }),
    [actionQuestion('media_player')]: choice('search_and_play', { search_and_play: 1 }),
  });
  assert.equal(result.plan.kind, 'calls');
  if (result.plan.kind !== 'calls') return;
  const ids = result.plan.calls.map((call) => call.args.entity_id).sort();
  assert.deepEqual(ids, ['media_player.kitchen_speaker', 'media_player.voice_assistant_1_media_player_2']);
  for (const call of result.plan.calls) assert.equal(call.args.media_content_id, 'Taylor Swift');
});

test('a house with no play service still plays a room through Home Assistant\'s search', () => {
  const result = routeFor('play Taylor Swift in the kitchen', playInArea('kitchen'), HOME, [ASSIST_TOOL]);
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.tool, 'HassMediaSearchAndPlay');
  assert.equal(result.plan.args.name, 'media_player.kitchen_speaker');
  assert.equal(result.plan.args.search_query, 'Taylor Swift');
});

test('a play service that insists on a content type still gets one', () => {
  const result = routeFor('play Taylor Swift in the kitchen', playInArea('kitchen'), HOME, [STRICT_TOOL]);
  assert.equal(result.plan.kind, 'tool');
  if (result.plan.kind !== 'tool') return;
  assert.equal(result.plan.args.media_content_id, 'Taylor Swift');
  assert.equal(result.plan.args.media_content_type, 'music');
});
