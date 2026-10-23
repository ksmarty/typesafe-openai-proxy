import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { issuedCalls, pendingConfirmations } from '../src/state.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Desk Lamp (light.desk_lamp): off',
  'Front Door (lock.front_door): locked',
].join('\n');

function tool(name: string, properties: Record<string, unknown>): OpenAITool {
  return { type: 'function', function: { name, parameters: { type: 'object', properties } } };
}

const TOOLS: OpenAITool[] = [
  tool('HassTurnOn', { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassTurnOff', { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } }),
  tool('HassGetState', { name: { type: 'string' }, domain: { type: 'string' }, state: { type: 'string' } }),
];

/** Enough of a ServerResponse to read the answer back. */
function fakeResponse() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' };
  const response = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = headers;
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

function config(overrides: Partial<Config['speech']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    speech: { ...base.speech, afterTool: 'template', ...overrides },
  };
}

test('a statement after a tool result is spoken locally from Home Assistant speech', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  const callId = 'call_test_1';
  issuedCalls.set(callId, { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', at: Date.now() });

  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the desk lamp' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name: 'HassTurnOn', arguments: '{"name":"light.desk_lamp"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ success: true, result: { speech: { plain: { speech_slots: { action: 'turned on', name: 'Desk Lamp' } } } } }),
        },
      ],
    },
    '{}',
    response,
    config(),
  );

  assert.equal(state.status, 200);
  const payload = JSON.parse(state.body);
  assert.equal(payload.choices[0].message.content, 'Turned on Desk Lamp.');
});

test('an armed confirmation runs when the next utterance is yes', async () => {
  clearCatalogCache();
  issuedCalls.clear();
  pendingConfirmations.clear();

  const active = config();
  const first = fakeResponse();
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: 'unlock the front door' }],
    },
    '{}',
    first.response,
    active,
  );
  const asked = JSON.parse(first.state.body).choices[0].message.content as string;
  assert.match(asked, /unlock/i);
  assert.equal(pendingConfirmations.size, 1, 'the question should be armed');

  const second = fakeResponse();
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'unlock the front door' },
        { role: 'assistant', content: asked },
        { role: 'user', content: 'yes' },
      ],
    },
    '{}',
    second.response,
    active,
  );
  const payload = JSON.parse(second.state.body);
  const calls = payload.choices[0].message.tool_calls;
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(calls[0].function.name, 'HassTurnOff');
  assert.equal(JSON.parse(calls[0].function.arguments).name, 'lock.front_door');
  assert.equal(pendingConfirmations.size, 0);
});

test('a request that does not name the router model is passed through untouched', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  // Heuristic backend on, but autoStart off and a foreign model: nothing is decided.
  const active = config();
  active.decision = { ...active.decision, autoStart: false };

  await handleChatCompletions(
    {
      model: 'llama3',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the desk lamp' },
      ],
    },
    '{}',
    response,
    active,
  );

  // No upstream is configured, so the pass-through answer is the setup hint, not a tool call.
  const payload = JSON.parse(state.body);
  assert.ok(!payload.choices[0].message.tool_calls, 'nothing is decided for a foreign model');
  assert.match(String(payload.choices[0].message.content ?? ''), /not configured yet|inference server/i);
});

test('naming the router model opts this request into the fast path', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  const active = config();
  active.decision = { ...active.decision, autoStart: false };

  await handleChatCompletions(
    {
      model: 'typesafe-router',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the desk lamp' },
      ],
    },
    '{}',
    response,
    active,
  );

  const payload = JSON.parse(state.body);
  const calls = payload.choices[0].message.tool_calls;
  assert.equal(calls?.[0]?.function.name, 'HassTurnOn');
  assert.equal(JSON.parse(calls[0].function.arguments).name, 'light.desk_lamp');
});
