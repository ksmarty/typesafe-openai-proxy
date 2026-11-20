/**
 * A list of names is not a command.
 *
 * A live install transcribed a satellite's microphone as the whole catalog — "Office, Living
 * Room, Kitchen, Bedroom, …, Door." — and the proxy had no reader for it: long enough to skip the
 * chatter filter, no intent in it for the decision model, so the turn ended with forty device
 * names forwarded to the model server, eleven seconds of waiting, and an answer that listed
 * things back. Answering a name list with silence is what breaks that loop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { runPipeline } from '../src/pipeline.js';
import { looksLikeRollCall } from '../src/rollcall.js';
import type { Catalog, CatalogEntity, OpenAITool } from '../src/types.js';

/** The names exactly as the satellite's beat heard them, in one sentence. */
const HEARD =
  'Office, Living Room, Kitchen, Bedroom, Front Hall, Main Floor, Upstairs, Bedroom Lamp, ' +
  'Bedroom lights, Evedal, Evedal Lamp, Office Lamp, Kitchen Lights, Bed Lights, Office Overhead, ' +
  'Varmblixt, Varmblixt Lamp, Living Room TV, Shopping list, Home Assistant Voice Assist satellite, ' +
  'Door Sensor, Door Closed, Projector Remote Projector Off, Projector Off, Projector Remote ' +
  'Projector On, Projector On, Very Good Friends Very Good Friends, Very Good Friends Calendar, ' +
  'Amanda, Kyle, Download Movie, Play Music, Deadbolt Detector Deadbolt Detector Lock State, Door.';

const AREAS = ['Office', 'Living Room', 'Kitchen', 'Bedroom', 'Front Hall', 'Main Floor', 'Upstairs'];

const ENTITIES = [
  'Bedroom Lamp',
  'Bedroom Lights',
  'Evedal',
  'Evedal Lamp',
  'Office Lamp',
  'Kitchen Lights',
  'Bed Lights',
  'Office Overhead',
  'Varmblixt',
  'Varmblixt Lamp',
  'Living Room TV',
  'Shopping list',
  'Home Assistant Voice Assist satellite',
  'Door Sensor',
  'Door Closed',
  'Projector Remote Projector Off',
  'Projector Off',
  'Projector Remote Projector On',
  'Projector On',
  'Very Good Friends',
  'Very Good Friends Calendar',
  'Amanda',
  'Kyle',
  'Download Movie',
  'Play Music',
  'Deadbolt Detector',
  'Door',
];

function catalogOf(names: string[], areas: string[]): Catalog {
  const entities: CatalogEntity[] = names.map((name, index) => ({
    id: `sensor.item_${index}`,
    name,
    domain: 'sensor',
    state: 'on',
  }));
  return {
    areas: areas.map((name, index) => ({ id: `area_${index}`, name })),
    entities,
    domains: ['sensor'],
    source: 'prompt',
    builtAt: Date.now(),
  };
}

const CATALOG = catalogOf(ENTITIES, AREAS);

/** The real catalog of the install that produced HEARD: 15 exposed names of the 34 read aloud. */
const NARROW_CATALOG: Catalog = catalogOf(
  [
    'Bed Lights',
    'Bedroom Lamp',
    'Evedal',
    'Kitchen Lights',
    'Varmblixt',
    'Office Lamp',
    'Office Overhead',
    'Living Room TV',
    'Download Movie',
    'Play Music',
    'Projector Remote Projector Off',
    'Projector Remote Projector On',
    'Shopping list',
    'Deadbolt Detector Deadbolt Detector Lock State',
    'Door Sensor',
  ],
  ['Bedroom', 'Front Hall', 'Living Room', 'Office'],
);


function tool(name: string, properties: Record<string, unknown> = {}): OpenAITool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties, required: [] } },
  };
}

const TOOLS: OpenAITool[] = [tool('HassTurnOn', { name: { type: 'string' } }), tool('HassNevermind')];

/** The catalog the pipeline builds from a Home Assistant prompt, holding the same names. */
const PROMPT = [
  'Available Devices:',
  ...AREAS.map((area) => `## ${area}`),
  ...ENTITIES.map((name, index) => `${name} (sensor.item_${index}): on`),
].join('\n');

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    routing: { ...base.routing, enabled: true },
  };
}

test('the catalog read aloud is not a command', () => {
  const reason = looksLikeRollCall(HEARD, CATALOG);
  assert.ok(reason, 'the whole catalog in one sentence is a roll call');
  assert.match(reason!, /roll call, not a command/);
  assert.match(reason!, /device names in a row and no action/);
});

test('a list of room names alone is a roll call too', () => {
  assert.ok(looksLikeRollCall('Office, Living Room, Kitchen, Bedroom.', CATALOG));
});

test('a short sentence of names mostly unknown to the catalog is left to the model', () => {
  // Six parts is a sentence somebody spoke, so the share stays strict here.
  assert.equal(looksLikeRollCall('Office, Living Room, Kitchen, Bedroom, garage, shed', CATALOG), null);
  assert.equal(looksLikeRollCall('Office, Living Room, Kitchen, Bedroom, gimme, pony', CATALOG), null);
});

test('a catalog read aloud is a roll call even when the catalog holds few of the names', () => {
  // The live install this reader was written for exposes fifteen names and reads out thirty-four:
  // a four-in-five share declined the very sentence the reader exists for.
  const reason = looksLikeRollCall(HEARD, NARROW_CATALOG);
  assert.ok(reason, 'a long list is read aloud, not spoken');
  assert.match(reason!, /roll call, not a command/);

  // Lower case and a straggling full stop are the same sentence.
  assert.ok(looksLikeRollCall(HEARD.toLowerCase(), NARROW_CATALOG));
});

test('a long list that still holds an instruction is left to the model', () => {
  assert.equal(looksLikeRollCall(`${HEARD} turn on the office lamp`, NARROW_CATALOG), null);
});

test('an instruction is never a roll call, however many names it holds', () => {
  for (const text of [
    'Kitchen Lights, Bed Lights, turn on',
    'turn on Kitchen Lights, Bed Lights, Office Lamp, Evedal',
    'Office, Living Room, Kitchen, Bedroom?',
  ]) {
    assert.equal(looksLikeRollCall(text, CATALOG), null, `"${text}" is not a roll call`);
  }
});

test('a name somebody added a word to is left for the decision model', () => {
  // "Kitchen Lights off" is a name plus an instruction; matching on the whole segment keeps it.
  assert.equal(looksLikeRollCall('Kitchen Lights off, Bed Lights off, Office Lamp on, Evedal on', CATALOG), null);
});

test('two names are a short phrase, not a roll call', () => {
  assert.equal(looksLikeRollCall('Office, Kitchen', CATALOG), null);
  assert.equal(looksLikeRollCall('', CATALOG), null);
  assert.equal(looksLikeRollCall('Office, Living Room, Kitchen, Bedroom', { ...CATALOG, areas: [], entities: [] }), null);
});

test('the turn ends with silence: no decision call and no model round trip', async () => {
  clearCatalogCache();
  const result = await runPipeline(
    { model: 'test', messages: [{ role: 'user', content: HEARD }], tools: TOOLS },
    HEARD,
    PROMPT,
    config(),
  );
  assert.equal(result.route.plan.kind, 'ignore', JSON.stringify(result.route));
  const plan = result.route.plan;
  if (plan.kind !== 'ignore') throw new Error('unreachable');
  assert.equal(plan.silence, defaultConfig().speech.silence);
  assert.match(plan.reason, /roll call/);
  assert.equal(result.entry.route, 'ignore');
  assert.equal(result.entry.backend, 'off');
});
