/**
 * The rest of the Tools for Assist suite (`llm_intents`): search, places, arithmetic, conversions.
 *
 * Two things are being pinned here. First, that a sentence the proxy understands exactly becomes
 * the tool call Home Assistant already offers, without a model turn. Second, that a tool which
 * answers in prose — a web page, a list of shops — is handed to the model to phrase, instead of
 * the proxy saying "Done with search_web" over the top of it.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { issuedCalls, trace, turnBySession } from '../src/state.js';
import { needsModelWords, readSuiteQuestion, spokenToolResult } from '../src/toolsuite.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Garden Lamp (light.garden_lamp): off',
  'Kitchen Lights (light.kitchen_lights): off',
].join('\n');

/** Home Assistant's own tools, plus the integration's, named the way Home Assistant names them. */
const TOOLS: OpenAITool[] = [
  'HassTurnOn',
  'llm_intents__calculate',
  'llm_intents__unit_convert',
  'llm_intents__search_web',
  'llm_intents__find_places',
].map((name) => ({
  type: 'function' as const,
  function: {
    name,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        data: { type: 'array', items: { type: 'string' } },
        amount: { type: 'string' },
        from_unit: { type: 'string' },
        to_unit: { type: 'string' },
        query: { type: 'string' },
      },
    },
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

/** One request through the proxy, returning the parsed body and the turn's traces. */
async function ask(question: string, active: Config, tools: OpenAITool[] = TOOLS) {
  const response = fakeResponse();
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: question },
      ],
    } as never,
    '{"model":"m"}',
    response.response,
    active,
  );
  return { body: JSON.parse(response.state.body), raw: response.state.body };
}

test('a sum, a conversion, a look-up and a nearby place each name their tool', () => {
  assert.deepEqual(readSuiteQuestion("what's 12 times 8?"), {
    tool: 'calculate',
    args: { operation: 'expression', data: ['12*8'] },
    about: '12*8',
  });
  assert.deepEqual(readSuiteQuestion('how much is 15% of 240?')?.args, {
    operation: 'expression',
    data: ['15*0.01*240'],
  });
  // "how much is" is a sum only when there is arithmetic in it.
  assert.equal(readSuiteQuestion('how much is a pint of milk?'), null);

  assert.deepEqual(readSuiteQuestion('how many grams in 8 ounces?')?.args, {
    amount: '8',
    from_unit: 'ounce',
    to_unit: 'gram',
  });
  assert.deepEqual(readSuiteQuestion('convert 2 cups to ml')?.args, {
    amount: '2',
    from_unit: 'cup',
    to_unit: 'ml',
  });
  assert.deepEqual(readSuiteQuestion('what is 20 celsius in fahrenheit?')?.args, {
    amount: '20',
    from_unit: 'celsius',
    to_unit: 'fahrenheit',
  });

  assert.deepEqual(readSuiteQuestion('search wikipedia for alan turing')?.args, { query: 'alan turing' });
  assert.deepEqual(readSuiteQuestion('look up alan turing on wikipedia')?.args, { query: 'alan turing' });
  assert.deepEqual(readSuiteQuestion('search the web for the fa cup final')?.args, {
    query: 'the fa cup final',
  });
  assert.deepEqual(readSuiteQuestion('find the nearest pharmacy')?.args, { query: 'pharmacy' });
  assert.deepEqual(readSuiteQuestion('find me a petrol station near me')?.args, { query: 'petrol station' });
});

test('the house is never sent to a search engine', () => {
  const homes = ['Garden Lamp', 'Kitchen Lights', 'Kitchen'];
  // A sentence about the house belongs to the catalog, not to Google.
  assert.equal(readSuiteQuestion('is the garden lamp on?', homes), null);
  assert.equal(readSuiteQuestion('turn off the kitchen lights', homes), null);
  assert.equal(readSuiteQuestion('play some jazz', homes), null);
  assert.equal(readSuiteQuestion('how many lights are on?', homes), null);
  assert.equal(readSuiteQuestion('what is the weather like?', homes), null);
  assert.equal(readSuiteQuestion('find the nearest kitchen light', homes), null);
});

test('a sum said in words becomes digits', () => {
  // People say their sums: "two plus two" carries no digit at all.
  assert.deepEqual(readSuiteQuestion("what's two plus two?"), {
    tool: 'calculate',
    args: { operation: 'expression', data: ['2+2'] },
    about: '2+2',
  });
  // A run of number words is one number, not several.
  assert.deepEqual(readSuiteQuestion('what is twenty two times three')?.args, {
    operation: 'expression',
    data: ['22*3'],
  });
  // "and" only joins a scaled number, so this is 105 minus 5.
  assert.deepEqual(readSuiteQuestion('what is one hundred and five minus five')?.args, {
    operation: 'expression',
    data: ['105-5'],
  });
  // Two numbers joined by "and" are not a number, and a sentence without arithmetic is not a sum.
  assert.equal(readSuiteQuestion('what is two and two'), null);
  assert.equal(readSuiteQuestion('what is the best way to cook rice'), null);
});

test('a sum is spoken as its answer, not as the expression', () => {
  const said = spokenToolResult(
    'llm_intents__calculate',
    { operation: 'expression', data: ['12*8'] },
    JSON.stringify({ result: { value: 96 } }),
  );
  assert.equal(said, "That's 96.");

  const converted = spokenToolResult(
    'llm_intents__unit_convert',
    { amount: '8', from_unit: 'ounce', to_unit: 'gram' },
    JSON.stringify({ result: { value: 226.7962 } }),
  );
  assert.equal(converted, '8 ounces is 226.8 grams.');

  // A failed sum says nothing rather than inventing a number.
  assert.equal(
    spokenToolResult('calculate', { operation: 'expression', data: ['1/0'] }, JSON.stringify({ error: 'x' })),
    '',
  );
});

test('a tool that answers in prose is left to the model', () => {
  assert.equal(needsModelWords('llm_intents__search_web'), true);
  assert.equal(needsModelWords('llm_intents__find_places'), true);
  assert.equal(needsModelWords('llm_intents__calculate'), false);
  assert.equal(needsModelWords('llm_intents__get_route'), false);
  assert.equal(
    spokenToolResult('llm_intents__search_web', { query: 'x' }, JSON.stringify({ results: [{ title: 'a' }] })),
    '',
  );
});

test('a sum becomes a calculate call, with no model turn', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    const { body } = await ask("what's 12 times 8?", active);
    const call = body.choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(call.function.name, 'llm_intents__calculate', 'the offered name is the one emitted');
    assert.deepEqual(JSON.parse(call.function.arguments), { operation: 'expression', data: ['12*8'] });

    const entry = trace.find((row) => row.route === 'tool');
    assert.ok(entry, 'the turn is traced as a tool call');
    assert.equal(entry?.action, 'calculate');
    assert.equal(entry?.backend, 'off', 'no model was consulted');
    assert.match(entry?.reason ?? '', /no model call/);
  } finally {
    await upstream.close();
  }
});

test('the answer to a spoken sum is said out loud, not forwarded', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    const asked = await ask("what's two plus two?", active);
    const call = asked.body.choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${asked.raw.slice(0, 200)}`);
    assert.deepEqual(JSON.parse(call.function.arguments), { operation: 'expression', data: ['2+2'] });

    // Home Assistant runs the call and replays it: this is the round that owes the answer.
    const { state, response } = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: "what's two plus two?" },
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ result: { value: 4 } }) },
        ],
      } as never,
      '{"model":"m"}',
      response,
      active,
    );
    // "Quiet after a tool call" is written for commands; a question still gets its answer.
    const answer = JSON.parse(state.body).choices[0].message.content as string;
    assert.equal(answer, "That's 4.");
  } finally {
    await upstream.close();
  }
});

test('a sentence that ends in a full stop is still read as a sum', async () => {
  // Speech-to-text ends a sentence with a full stop, not a question mark: the satellite sent
  // "What's two plus two." and the trailing period made "two." a word the readers could not
  // translate, so the turn fell through to conversation and was forwarded.
  assert.deepEqual(readSuiteQuestion("What's two plus two.")?.args, {
    operation: 'expression',
    data: ['2+2'],
  });
  // A period inside a decimal still means a decimal.
  assert.deepEqual(readSuiteQuestion('what is 2.5 plus 2.5.')?.args, {
    operation: 'expression',
    data: ['2.5+2.5'],
  });
  assert.deepEqual(readSuiteQuestion('how many grams in 8 ounces.')?.args, {
    amount: '8',
    from_unit: 'ounce',
    to_unit: 'gram',
  });

  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);
    const asked = await ask("What's two plus two.", active);
    const call = asked.body.choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${asked.raw.slice(0, 200)}`);
    assert.equal(trace[0]?.route, 'tool');
    assert.equal(trace[0]?.action, 'calculate');
    assert.equal(trace[0]?.backend, 'off');

    // Home Assistant offers the integration's tools under their bare names as well
    // (`calculate`, not `llm_intents__calculate`), and both spellings have to be found.
    const bare = TOOLS.map((tool) => ({
      ...tool,
      function: { ...tool.function, name: tool.function.name.replace('llm_intents__', '') },
    }));
    const bareAsked = await ask("What's two plus two.", active, bare);
    assert.equal(bareAsked.body.choices[0].message.tool_calls?.[0]?.function.name, 'calculate');
  } finally {
    await upstream.close();
  }
});

test('a nearby place becomes a find_places call', async () => {
  const upstream = await upstreamSaying('unused');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    const { body } = await ask('find the nearest pharmacy', active);
    const call = body.choices[0].message.tool_calls?.[0];
    assert.ok(call, `expected a call, got ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(call.function.name, 'llm_intents__find_places');
    assert.deepEqual(JSON.parse(call.function.arguments), { query: 'pharmacy' });
  } finally {
    await upstream.close();
  }
});

test('with the group off, the question goes to the model instead', async () => {
  const upstream = await upstreamSaying('Ninety-six.');
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const off = config(upstream.url);
    off.suite.enabled = false;

    const { body } = await ask("what's 12 times 8?", off);
    assert.equal(body.choices[0].message.tool_calls, undefined, 'no call was invented');
    assert.equal(body.choices[0].message.content, 'Ninety-six.');
  } finally {
    await upstream.close();
  }
});

test('a web result is phrased by the model, not announced as Done', async () => {
  const upstream = await upstreamSaying('Turing worked at Bletchley Park.');
  const response = fakeResponse();
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;
    const active = config(upstream.url);

    // The model itself asked for search_web, so the proxy has no descriptor of its own for the call.
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools: TOOLS,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: 'tell me about alan turing' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_model_made',
                type: 'function',
                function: { name: 'llm_intents__search_web', arguments: '{"query":"alan turing"}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_model_made',
            content: JSON.stringify({ results: [{ title: 'Alan Turing', content: 'Bletchley Park.' }] }),
          },
        ],
      } as never,
      '{"model":"m"}',
      response.response,
      active,
    );

    const body = JSON.parse(response.state.body);
    assert.equal(body.choices[0].message.content, 'Turing worked at Bletchley Park.');
    const forwarded = trace.find((row) => row.route === 'forward');
    assert.ok(forwarded, 'the round was forwarded so the model could phrase it');
    assert.match(forwarded?.reason ?? '', /prose/);
  } finally {
    await upstream.close();
  }
});
