import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { forwardUpstream } from '../src/respond.js';
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

test('a forwarded request renames the proxy model to the configured upstream model', async () => {
  // A real local server stands in for the inference backend, so what gets
  // asserted is the body the proxy actually sends.
  const seen: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (piece) => { body += piece; });
    request.on('end', () => {
      seen.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const config = defaultConfig();
  config.upstream.baseUrl = `http://127.0.0.1:${port}/v1`;
  config.upstream.model = 'gpt-4o-mini';

  try {
    for (const [requested, expected] of [
      ['typesafe-router', 'gpt-4o-mini'], // the opt-in alias must not reach the server
      ['', 'gpt-4o-mini'], // nothing named: use the configured model
      ['llama3', 'llama3'], // a real model name is passed through untouched
    ] as const) {
      const { response } = fakeResponse();
      const request = { model: requested, messages: [{ role: 'user', content: 'hi' }], stream: false };
      await forwardUpstream(request, JSON.stringify(request), response as never, config);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.model, 'gpt-4o-mini', 'typesafe-router must be rewritten');
  assert.equal(seen[1]?.model, 'gpt-4o-mini', 'an empty model must become the configured one');
  assert.equal(seen[2]?.model, 'llama3', 'a real model name must pass through');
});

test('a tool result from an earlier turn is not mistaken for the current one', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  const callId = 'call_old_1';
  issuedCalls.set(callId, { action: 'turn_off', targets: ['light.kitchen_lights'], domain: 'light', at: Date.now() });

  // Home Assistant replays the whole chat log: an old confirmation, then a brand-new question.
  // The proxy used to answer the new question with the old action's sentence.
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn off the kitchen lights' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'HassTurnOff', arguments: '{"name":"light.kitchen_lights"}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ success: true, result: { speech: { plain: { speech_slots: { action: 'turned off', name: 'Kitchen Lights' } } } } }),
        },
        { role: 'assistant', content: 'Turned off Kitchen Lights.' },
        { role: 'user', content: "What's two plus two?" },
      ],
    },
    '{}',
    response,
    config(),
  );

  assert.doesNotMatch(state.body, /Turned off Kitchen Lights/, 'the previous turn must not answer this one');
  // No upstream is configured here, so the proxy forwards rather than inventing an answer.
  assert.match(state.body, /model server|needs your model|forwarded/i);
});

test('"say nothing" sends the configured pause instead of an empty TTS job', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  const callId = 'call_test_silent';
  issuedCalls.set(callId, { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', at: Date.now() });

  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the desk lamp' },
        { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'HassTurnOn', arguments: '{"name":"light.desk_lamp"}' } }] },
        { role: 'tool', tool_call_id: callId, content: '{"speech":{"plain":{"speech":"Turned on the desk lamp."}}}' },
      ],
    } as never,
    JSON.stringify({}),
    response,
    config({ afterTool: 'empty' }),
  );

  const body = JSON.parse(state.body) as { choices: { message: { content: string } }[] };
  assert.equal(body.choices[0]?.message.content, '[pause:1.5s]');
});

test('the pause is configurable, so a longer silence stays a setting', async () => {
  clearCatalogCache();
  pendingConfirmations.clear();
  issuedCalls.clear();

  const { state, response } = fakeResponse();
  const callId = 'call_test_silent_2';
  issuedCalls.set(callId, { action: 'turn_on', targets: ['light.desk_lamp'], domain: 'light', at: Date.now() });

  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the desk lamp' },
        { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'HassTurnOn', arguments: '{"name":"light.desk_lamp"}' } }] },
        { role: 'tool', tool_call_id: callId, content: '{"speech":{"plain":{"speech":"Turned on the desk lamp."}}}' },
      ],
    } as never,
    JSON.stringify({}),
    response,
    config({ afterTool: 'empty', silence: '[pause:3s]' }),
  );

  const body = JSON.parse(state.body) as { choices: { message: { content: string } }[] };
  assert.equal(body.choices[0]?.message.content, '[pause:3s]');
});
