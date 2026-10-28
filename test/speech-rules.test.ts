import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { descriptorsOf, humanTarget, interpolateSpeech, ruleFor, ruleMode } from '../src/speech.js';
import { issuedCalls, pendingConfirmations } from '../src/state.js';
import type { OpenAITool } from '../src/types.js';

/**
 * Speech is per call, not per house.
 *
 * Turning a lamp on wants no reply; adding milk to a shopping list does. These tests pin the
 * matching rules and the round behaviour, including what happens when only part of a round is
 * meant to be spoken.
 */

const PROMPT = [
  'Available Devices:',
  'Desk Lamp (light.desk_lamp): off',
  'Shopping list (todo.shopping_list): 2 items',
].join('\n');

function tool(name: string, properties: Record<string, unknown>): OpenAITool {
  return { type: 'function', function: { name, parameters: { type: 'object', properties } } };
}

const TOOLS: OpenAITool[] = [
  tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassListAddItem', { name: { type: 'string' }, item: { type: 'string' } }),
];

function fakeResponse() {
  const state = { status: 0, body: '' };
  const response = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status;
      response.headersSent = true;
      return response;
    },
    write(chunk: string) {
      state.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) state.body += chunk;
      return response;
    },
  };
  return { state, response: response as never };
}

type Rule = { match: string; mode: 'speak' | 'silent' | 'custom'; say?: string };

function config(rules: Rule[], overrides: Partial<Config['speech']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    speech: { ...base.speech, afterTool: 'template', rules, ...overrides },
  };
}

function round(callId: string, results: { callId: string; name: string; content: unknown }[]) {
  const messages: unknown[] = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: 'do the thing' },
    {
      role: 'assistant',
      content: null,
      tool_calls: results.map((entry) => ({
        id: entry.callId,
        type: 'function',
        function: { name: entry.name, arguments: '{}' },
      })),
    },
    ...results.map((entry) => ({ role: 'tool', tool_call_id: entry.callId, content: JSON.stringify(entry.content) })),
  ];
  return messages;
}

async function speak(active: Config, messages: unknown[]): Promise<string> {
  clearCatalogCache();
  pendingConfirmations.clear();
  const { state, response } = fakeResponse();
  await handleChatCompletions(
    { model: 'm', stream: false, tools: TOOLS, messages } as never,
    '{}',
    response,
    active,
  );
  assert.equal(state.status, 200);
  return JSON.parse(state.body).choices[0].message.content as string;
}

const TURNED_ON = { success: true, result: { speech: { plain: { speech_slots: { action: 'turned on', name: 'Desk Lamp' } } } } };
const ADDED = { success: true, result: { speech: { plain: { speech_slots: { action: 'added', name: 'Milk' } } } } };

test('the shipped defaults silence the on/off domains and nothing else', () => {
  const rules = defaultConfig().speech.rules;
  for (const domain of ['light', 'switch', 'fan', 'cover', 'climate', 'media_player']) {
    assert.equal(ruleMode(rules, { domain, action: 'turn_on' }), 'silent', `${domain} is silent by default`);
  }
  for (const domain of ['todo', 'scene', 'vacuum']) {
    assert.equal(ruleMode(rules, { domain, action: 'add' }), null, `${domain} still answers`);
  }
});

test('a rule matches intent, domain.action, domain or action', () => {
  const rules = [{ match: 'HassListAddItem', mode: 'speak' as const }];
  assert.equal(ruleMode(rules, { tool: 'HassListAddItem' }), 'speak');
  assert.equal(ruleMode(rules, { tool: 'HassTurnOn' }), null);
  assert.equal(ruleMode([{ match: 'todo.add', mode: 'speak' }], { domain: 'todo', action: 'add' }), 'speak');
  assert.equal(ruleMode([{ match: 'light', mode: 'silent' }], { domain: 'light', action: 'turn_on' }), 'silent');
  assert.equal(ruleMode([{ match: 'turn_on', mode: 'silent' }], { domain: 'fan', action: 'turn_on' }), 'silent');
  assert.equal(ruleMode([{ match: 'LIGHT', mode: 'silent' }], { domain: 'light', action: 'turn_on' }), 'silent');
  assert.equal(ruleMode([{ match: 'todo.*', mode: 'speak' }], { domain: 'todo', action: 'complete' }), 'speak');
  // First match wins, so the specific rule must come first.
  assert.equal(
    ruleMode([{ match: 'HassTurnOn', mode: 'speak' }, { match: 'light', mode: 'silent' }], { tool: 'HassTurnOn', domain: 'light', action: 'turn_on' }),
    'speak',
  );
  assert.deepEqual(descriptorsOf({ tool: 'HassTurnOn', domain: 'light', action: 'turn_on' }), [
    'HassTurnOn',
    'light.turn_on',
    'light',
    'turn_on',
  ]);
});

test('a light is silent by rule while a shopping list answers', async () => {
  issuedCalls.clear();
  const active = config([{ match: 'light', mode: 'silent' }]);
  issuedCalls.set('call_lamp', { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', tool: 'HassTurnOn', at: Date.now() });
  const silence = await speak(active, round('call_lamp', [{ callId: 'call_lamp', name: 'HassTurnOn', content: TURNED_ON }]));
  assert.equal(silence, active.speech.silence);

  issuedCalls.set('call_list', { action: 'add', targets: ['todo.shopping_list'], domain: 'todo', tool: 'HassListAddItem', at: Date.now() });
  const spoken = await speak(active, round('call_list', [{ callId: 'call_list', name: 'HassListAddItem', content: ADDED }]));
  assert.match(spoken, /Added/);
  assert.notEqual(spoken, active.speech.silence);
});

test('a mixed round speaks only the calls that were not silenced', async () => {
  issuedCalls.clear();
  const active = config([{ match: 'light', mode: 'silent' }]);
  issuedCalls.set('call_lamp', { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', tool: 'HassTurnOn', at: Date.now() });
  issuedCalls.set('call_list', { action: 'add', targets: ['todo.shopping_list'], domain: 'todo', tool: 'HassListAddItem', at: Date.now() });
  const spoken = await speak(
    active,
    round('call_list', [
      { callId: 'call_lamp', name: 'HassTurnOn', content: TURNED_ON },
      { callId: 'call_list', name: 'HassListAddItem', content: ADDED },
    ]),
  );
  assert.match(spoken, /Added/);
  assert.doesNotMatch(spoken, /Desk Lamp/);
});

test('a rule that says speak beats the "say nothing" default', async () => {
  issuedCalls.clear();
  const active = config([{ match: 'todo', mode: 'speak' }], { afterTool: 'empty' });
  issuedCalls.set('call_list', { action: 'add', targets: ['todo.shopping_list'], domain: 'todo', tool: 'HassListAddItem', at: Date.now() });
  const spoken = await speak(active, round('call_list', [{ callId: 'call_list', name: 'HassListAddItem', content: ADDED }]));
  assert.match(spoken, /Added/);
});

test('"let the model phrase it" still forwards when nothing in the round was silenced', async () => {
  issuedCalls.clear();
  const active = config([], { afterTool: 'upstream' });
  active.upstream = { ...active.upstream, baseUrl: 'http://127.0.0.1:9/v1' };
  issuedCalls.set('call_lamp', { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', tool: 'HassTurnOn', at: Date.now() });
  const { state, response } = fakeResponse();
  await handleChatCompletions(
    { model: 'm', stream: false, tools: TOOLS, messages: round('call_lamp', [{ callId: 'call_lamp', name: 'HassTurnOn', content: TURNED_ON }]) } as never,
    '{}',
    response,
    active,
  );
  // A dead upstream still answers, but with the proxy's own explanation rather than the
  // template — proof the request was forwarded, not handled locally.
  assert.equal(state.status, 200);
  const content = JSON.parse(state.body).choices[0].message.content as string;
  assert.doesNotMatch(content, /Turned on Desk Lamp/);
  assert.match(content, /model server|reached|connect|reach/i);
});

test('a custom rule says exactly what it was told, with the call filled in', async () => {
  issuedCalls.clear();
  const active = config([{ match: 'light', mode: 'custom', say: '{action} the {entity}, sir.' }]);
  issuedCalls.set('call_lamp', { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', tool: 'HassTurnOn', at: Date.now() });
  const spoken = await speak(active, round('call_lamp', [{ callId: 'call_lamp', name: 'HassTurnOn', content: TURNED_ON }]));
  assert.equal(spoken, 'Turned on the Desk Lamp, sir.');
  assert.notEqual(spoken, 'Turned on Desk Lamp.');
});

test('a custom rule wins over the model phrasing the answer', async () => {
  issuedCalls.clear();
  const active = config([{ match: 'todo', mode: 'custom', say: 'On the list.' }], { afterTool: 'upstream' });
  active.upstream = { ...active.upstream, baseUrl: 'http://127.0.0.1:9/v1' };
  issuedCalls.set('call_list', { action: 'add', targets: ['todo.shopping_list'], domain: 'todo', tool: 'HassListAddItem', at: Date.now() });
  const spoken = await speak(active, round('call_list', [{ callId: 'call_list', name: 'HassListAddItem', content: ADDED }]));
  assert.equal(spoken, 'On the list.');
});

test('a custom sentence tolerates a missing entity or action', () => {
  assert.equal(interpolateSpeech('{action} {entity}.', {}), '.');
  assert.equal(interpolateSpeech('  {action}   {entity}  ', { action: 'Done' }), 'Done');
  assert.equal(humanTarget(['light.desk_lamp']), 'Desk Lamp');
  assert.equal(humanTarget(['Kitchen']), 'Kitchen');
  assert.equal(humanTarget(undefined), '');
});

test('ruleFor returns the whole rule, so a custom sentence survives the lookup', () => {
  const rule = ruleFor([{ match: 'todo.*', mode: 'custom', say: 'Noted.' }], { domain: 'todo', action: 'add' });
  assert.equal(rule?.say, 'Noted.');
  assert.equal(ruleFor([{ match: 'light', mode: 'silent' }], { domain: 'todo', action: 'add' }), null);
});
