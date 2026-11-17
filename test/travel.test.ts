/**
 * Travel time, through the Tools for Assist integration (`llm_intents`).
 *
 * "How long to get to the airport?" is a `get_route` call. The integration asks Google for the
 * route when it is called, traffic-aware, and caches only the Places lookup — so the number is
 * live every time and the proxy must not stand between the two. What the proxy does do is ask
 * for the tool before spending a model turn on it, and speak the answer locally afterwards.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { issuedCalls, trace, turnBySession } from '../src/state.js';
import { descriptorsOf, ruleFor, ruleMode } from '../src/speech.js';
import { readTravelQuestion, speakRoute, spokenToolResult, travelArgs } from '../src/toolsuite.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Garden Lamp (light.garden_lamp): off',
  'Kitchen Lights (light.kitchen_lights): off',
].join('\n');

/** The tools this installation offers: Home Assistant's own, plus the integration's. */
const TOOLS: OpenAITool[] = ['HassTurnOn', 'llm_intents__get_route', 'llm_intents__search_web'].map((name) => ({
  type: 'function' as const,
  function: {
    name,
    parameters: {
      type: 'object',
      properties: { destination: { type: 'string' }, expression: { type: 'string' } },
    },
  },
}));

const ROUTE = {
  result: {
    origin: '1 Mill Road',
    destination: 'London Stansted Airport',
    travel_mode: 'DRIVE',
    distance: '14.2 mi',
    duration: '24 min',
    duration_without_traffic: '19 min',
  },
};

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

test('a travel question names the destination and the journey', () => {
  assert.deepEqual(readTravelQuestion('How long to get to the airport?'), { destination: 'the airport' });
  assert.deepEqual(readTravelQuestion('How long does it take to drive to Tesco?'), {
    destination: 'tesco',
    mode: 'DRIVE',
  });
  assert.deepEqual(readTravelQuestion('How long to walk to the shops please?'), {
    destination: 'the shops',
    mode: 'WALK',
  });
  assert.deepEqual(readTravelQuestion('How far is it to the station?'), { destination: 'the station' });
});

test('a sentence about the house is not a journey', () => {
  // The catalog's own names win: a route to a room is not something Google can answer.
  assert.equal(readTravelQuestion('how long to get to the kitchen', ['Kitchen']), null);
  assert.equal(readTravelQuestion('How long has the hall light been on?'), null);
  assert.equal(readTravelQuestion('turn on the kitchen lights'), null);
  assert.equal(readTravelQuestion('how long to get to'), null);
  assert.equal(readTravelQuestion('what is the weather like?'), null);
});

test('the arguments ask for the journey the sentence named', () => {
  assert.deepEqual(travelArgs({ destination: 'the airport' }, 'auto'), { destination: 'the airport' });
  assert.deepEqual(travelArgs({ destination: 'the airport' }, 'WALK'), {
    destination: 'the airport',
    mode: 'WALK',
  });
  // What was said outranks what was configured.
  assert.deepEqual(travelArgs({ destination: 'the shops', mode: 'BICYCLE' }, 'DRIVE'), {
    destination: 'the shops',
    mode: 'BICYCLE',
  });
  // departure_time is left out: omitted means "now", and now is the only journey read here.
  assert.equal('departure_time' in travelArgs({ destination: 'the airport' }, 'auto'), false);
});

test('a route is spoken in one sentence, with the live duration', () => {
  assert.equal(speakRoute(ROUTE), "It's 24 min to London Stansted Airport, 14.2 miles.");
  // A failed route says nothing rather than inventing a journey.
  assert.equal(speakRoute({ error: 'No route found' }), '');
  // A single mile is not "1 miles".
  assert.equal(
    speakRoute({ result: { duration: '4 min', distance: '1 mi', destination: 'the postbox' } }),
    "It's 4 min to the postbox, 1 mile.",
  );
});

test('the suite is recognised under the name Home Assistant offers it by', () => {
  const said = spokenToolResult('llm_intents__get_route', { destination: 'the airport' }, JSON.stringify(ROUTE));
  assert.equal(said, "It's 24 min to London Stansted Airport, 14.2 miles.");
  // A language this module does not write is left to the model.
  assert.equal(spokenToolResult('get_route', { destination: 'the airport' }, JSON.stringify(ROUTE), 'de'), '');
  // Long text results are not attempted: reading a web page aloud is the model's job.
  assert.equal(spokenToolResult('search_web', {}, JSON.stringify({ results: ['a page'] })), '');
});

test('a travel question becomes a get_route call, with no model turn', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    const response = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
        ],
      } as never,
      '{"model":"m"}',
      response.response,
      active,
    );

    const body = JSON.parse(response.state.body);
    const call = body.choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${response.state.body.slice(0, 200)}`);
    assert.equal(call.function.name, 'llm_intents__get_route', 'the offered name is the one emitted');
    assert.deepEqual(JSON.parse(call.function.arguments), { destination: 'the airport' });

    const entry = trace.find((row) => row.route === 'tool');
    assert.ok(entry, 'the turn is traced as a tool call');
    assert.equal(entry?.action, 'get_route');
    assert.match(entry?.reason ?? '', /no model call/);
    assert.equal(entry?.backend, 'off', 'no model was consulted');
  } finally {
    await upstream.close();
  }
});

test('without the tool offered, a travel question is forwarded untouched', async () => {
  const upstream = await upstreamSaying('About twenty minutes.');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    const response = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: [TOOLS[0] as OpenAITool],
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
        ],
      } as never,
      '{"model":"m"}',
      response.response,
      active,
    );

    assert.match(response.state.body, /twenty minutes/, 'the model answered it');
    assert.equal(trace.find((row) => row.route === 'tool'), undefined, 'no call was invented');
  } finally {
    await upstream.close();
  }
});

/**
 * The bug this file exists for: the model asked for `get_route` itself, the proxy never issued
 * that call, so no local sentence could be built — and a rule set to "Speak it" answered with
 * the silence marker instead. The tool result is in the request, so the round is either spoken
 * from it or handed to the model, never silenced.
 */
test('a rule that says "Speak it" speaks a route the model asked for', async () => {
  const upstream = await upstreamSaying('It is about half an hour.');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);
    // The fast path is off, which is how the reported installation behaved: the model asked.
    active.travel.enabled = false;
    active.speech.rules = [{ match: 'get_route', mode: 'speak' }];

    const first = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
        ],
      } as never,
      '{"model":"m"}',
      first.response,
      active,
    );
    const asked = trace.find((row) => row.utterance === 'How long to get to the airport?');
    assert.ok(asked, 'the question is traced');

    const second = fakeResponse();
    trace.length = 0;
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_model_made',
                type: 'function',
                function: {
                  name: 'llm_intents__get_route',
                  arguments: '{"destination":"the airport"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_model_made', content: JSON.stringify(ROUTE) },
        ],
      } as never,
      '{"model":"m"}',
      second.response,
      active,
    );

    const round = trace.find((row) => row.backend === 'speech');
    assert.ok(round, 'the follow-up round is traced');
    assert.equal(round?.route, 'text', 'the route is spoken locally');
    assert.doesNotMatch(round?.reason ?? '', /silent by rule/, 'a "Speak it" rule is never silenced');
    assert.match(round?.said ?? '', /24 min to London Stansted Airport/);
    assert.match(second.state.body, /24 min to London Stansted Airport/);
  } finally {
    await upstream.close();
  }
});

test('a "Speak it" rule on a tool nobody can read aloud is handed to the model', async () => {
  const upstream = await upstreamSaying('The first result is a page about airports.');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);
    active.speech.rules = [{ match: 'search_web', mode: 'speak' }];

    const first = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'search the web for airport parking' },
        ],
      } as never,
      '{"model":"m"}',
      first.response,
      active,
    );

    const second = fakeResponse();
    trace.length = 0;
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'search the web for airport parking' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_model_made',
                type: 'function',
                function: { name: 'llm_intents__search_web', arguments: '{"query":"airport parking"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_model_made', content: JSON.stringify({ results: ['a page'] }) },
        ],
      } as never,
      '{"model":"m"}',
      second.response,
      active,
    );

    const round = trace.find((row) => row.backend === 'speech');
    assert.ok(round);
    assert.equal(round?.route, 'forward', 'the model holds the result, so it says it');
    assert.match(round?.reason ?? '', /asked for speech/);
    assert.match(second.state.body, /first result/, 'the answer reaches the conversation');
  } finally {
    await upstream.close();
  }
});

test('a rule written for the tool matches the namespaced name Home Assistant offers', () => {
  const call = { tool: 'llm_intents__get_route' };
  assert.deepEqual(descriptorsOf(call), ['llm_intents__get_route', 'get_route']);
  assert.equal(ruleFor([{ match: 'get_route', mode: 'silent' }], call)?.mode, 'silent');
  assert.equal(ruleMode([{ match: 'get_route', mode: 'speak' }], call), 'speak');
  assert.equal(ruleFor([{ match: 'llm_intents__get_route', mode: 'speak' }], call)?.mode, 'speak');
  assert.equal(ruleFor([{ match: 'get_route', mode: 'silent' }], { tool: 'HassTurnOn' }), null);
});

test('a silent rule named for the tool silences the call the proxy issued', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);
    active.speech.rules = [{ match: 'get_route', mode: 'silent' }];

    const first = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
        ],
      } as never,
      '{"model":"m"}',
      first.response,
      active,
    );
    const call = JSON.parse(first.state.body).choices[0].message.tool_calls?.[0];
    assert.ok(call, 'the fast path issues the call');

    const second = fakeResponse();
    trace.length = 0;
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'How long to get to the airport?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: call.function.arguments },
              },
            ],
          },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify(ROUTE) },
        ],
      } as never,
      '{"model":"m"}',
      second.response,
      active,
    );

    const round = trace.find((row) => row.backend === 'speech');
    assert.ok(round);
    assert.match(round?.reason ?? '', /silent by rule/);
    assert.equal(round?.said, undefined);
    assert.match(second.state.body, /\[pause:1\.5s\]/);
  } finally {
    await upstream.close();
  }
});
