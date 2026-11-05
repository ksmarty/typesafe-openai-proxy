/**
 * A forwarded request is answered by the model, which may call a tool of its own.
 *
 * This is the shape the debug bundle showed: "Is the door locked?" does not resolve in the
 * fast path (the house exposes no lock entity and no `HassGetState`), so it goes to the model
 * server; the model asks Home Assistant for the state; Home Assistant runs it and replays the
 * whole round back. The follow-up round's calls were never issued by this proxy, so
 * `issuedCalls` had no descriptor for it — no speech rule could match, the round fell to the
 * `speech.afterTool` default (an empty string, "stay quiet"), and a plain question was
 * answered with silence. The same missing link left the two rows unconnected in the monitor.
 *
 * Two things have to hold: the round is identified from the announcement Home Assistant
 * replays, and it is nested under the turn that caused it.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { descriptorFromAnnouncement } from '../src/toolcall.js';
import { issuedCalls, trace, turnBySession } from '../src/state.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Kitchen Lights (light.kitchen_lights): off',
  'Deadbolt Detector Deadbolt Detector Lock State (sensor.deadbolt_detector_lock_state): locked',
  'Door Sensor (binary_sensor.door_sensor): off',
].join('\n');

/** The tools this installation actually offers: no `HassGetState` among them. */
const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassTurnOff', 'HassLightSet'].map((name) => ({
  type: 'function' as const,
  function: {
    name,
    parameters: { type: 'object', properties: { name: { type: 'string' }, domain: { type: 'string' } } },
  },
}));

function fakeResponse() {
  const state = { status: 0, body: '' };
  const response = {
    headersSent: false,
    writeHead(status: number) {
      state.status = status;
      (response as { headersSent: boolean }).headersSent = true;
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

/** Accepts whatever is forwarded and answers it with one sentence. */
async function upstreamSaying(sentence: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: sentence } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function config(upstreamUrl: string): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    upstream: { ...base.upstream, baseUrl: upstreamUrl, apiKey: '', model: 'test-model' },
    speech: { ...base.speech, rules: [], afterTool: 'empty', silence: '[pause:1.5s]' },
  };
}

test('an announcement identifies a call this proxy never issued', () => {
  const descriptor = descriptorFromAnnouncement('assist__intent__HassGetState', '{"name":"sensor.deadbolt_detector_lock_state"}');
  assert.equal(descriptor.tool, 'HassGetState');
  assert.equal(descriptor.domain, 'sensor', 'the named entity carries the domain');
  assert.deepEqual(descriptor.targets, ['sensor.deadbolt_detector_lock_state']);
  // A state question is not one of the action table's entries, so it claims no action —
  // everything a rule can be written against is still there: the intent name and the domain.
  assert.equal(descriptor.action, undefined);

  const area = descriptorFromAnnouncement('assist__intent__HassTurnOn', { area: 'Kitchen', domain: 'light' });
  assert.equal(area.domain, 'light');
  assert.equal(area.action, 'turn_on', 'the action is read back from the intent table');
  assert.deepEqual(area.targets, ['Kitchen']);
});

test('a question the model answered with a tool call is answered, not silenced', async () => {
  const upstream = await upstreamSaying('Yes, the deadbolt is locked.');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    // 1. The question. It cannot be resolved from the catalog, so it is forwarded.
    const first = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'Is the door locked?' },
        ],
      } as never,
      '{"model":"m"}',
      first.response,
      active,
    );
    const asked = trace.find((entry) => entry.utterance === 'Is the door locked?');
    assert.ok(asked, 'the question is traced');
    assert.equal(asked?.route, 'forward', `expected a forward, got ${asked?.route}: ${asked?.reason}`);
    assert.equal(asked?.category, 'query', 'it is a question');

    // 2. Home Assistant replays the round: the model called HassGetState, and the answer.
    const second = fakeResponse();
    trace.length = 0;
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'Is the door locked?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_model_made',
                type: 'function',
                function: {
                  name: 'assist__intent__HassGetState',
                  arguments: '{"name":"sensor.deadbolt_detector_lock_state"}',
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_model_made',
            content: JSON.stringify({ response_type: 'action_done', data: { success: [] } }),
          },
        ],
      } as never,
      '{"model":"m"}',
      second.response,
      active,
    );

    const round = trace.find((entry) => entry.backend === 'speech');
    assert.ok(round, 'the follow-up round is traced');
    assert.equal(round?.route, 'forward', 'the model speaks the answer it already has');
    assert.doesNotMatch(round?.reason ?? '', /silent by rule \(,/, 'the descriptor is no longer empty');
    assert.match(round?.reason ?? '', /HassGetState/, 'the round names the call it is answering');
    assert.equal(round?.answersTurn, asked?.id, 'it nests under the question that caused it');
    assert.match(second.state.body, /deadbolt is locked/, 'the answer reaches the conversation');
  } finally {
    await upstream.close();
  }
});

test('a command the fast path issued is still silent when its rule says so', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);
    // The default the user runs with: a lamp is not narrated.
    active.speech.rules = [{ match: 'light', mode: 'silent' }];
    active.speech.afterTool = 'empty';

    const first = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'turn on the kitchen lights' },
        ],
      } as never,
      '{"model":"m"}',
      first.response,
      active,
    );
    const call = JSON.parse(first.state.body).choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${first.state.body.slice(0, 200)}`);
    const decided = trace.find((entry) => entry.route === 'tool');
    assert.ok(decided);

    const second = fakeResponse();
    trace.length = 0;
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'turn on the kitchen lights' },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: true }) },
        ],
      } as never,
      '{"model":"m"}',
      second.response,
      active,
    );

    const round = trace.find((entry) => entry.backend === 'speech');
    assert.ok(round, 'the round is traced');
    assert.equal(round?.said, undefined, 'a lamp stays quiet');
    assert.match(round?.reason ?? '', /silent by rule/, round?.reason);
    assert.match(round?.reason ?? '', /HassTurnOn/, 'the descriptor names the call the rule matched');
    assert.equal(round?.answersTurn, decided?.id, 'it still nests under the command');
    assert.equal(second.state.body.includes('[pause:1.5s]'), true, 'silence is what is sent');
  } finally {
    await upstream.close();
  }
});
