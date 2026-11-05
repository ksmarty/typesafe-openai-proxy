import assert from 'node:assert/strict';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { issuedCalls, trace } from '../src/state.js';
import type { OpenAITool } from '../src/types.js';

/**
 * A turn that gets spoken back is two HTTP requests, and the monitor used to show them as
 * two unrelated rows: "turn on the kitchen ceiling" and an empty-utterance text row. One
 * sentence should read as one row, with the calls and what was said back under it.
 *
 * The link is the call id: the decision that emitted the call remembers its own trace id on
 * the `issuedCalls` entry, and the speech round that answers the call reads it back.
 */

const PROMPT = [
  'Available Devices:',
  'Kitchen Ceiling (light.kitchen_ceiling): on',
  'Desk Lamp (light.desk_lamp): off',
].join('\n');

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassGetState'].map((name) => ({
  type: 'function' as const,
  function: { name, parameters: { type: 'object', properties: { name: { type: 'string' } } } },
}));

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

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    // The default rules silence lights, which would make this a silent round; the point
    // here is a round that does speak, so the rules are cleared.
    speech: { ...base.speech, rules: [], afterTool: 'template' },
  };
}

test('the speech round names the turn whose calls it answers', async () => {
  clearCatalogCache();
  issuedCalls.clear();
  trace.length = 0;
  const active = config();

  // 1. The command: the fast path emits a tool call.
  const first = fakeResponse();
  const request = {
    model: 'm',
    stream: false,
    tools: TOOLS,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: 'turn on the kitchen ceiling' },
    ],
  };
  await handleChatCompletions(request as never, '{}', first.response, active);
  const call = JSON.parse(first.state.body).choices[0].message.tool_calls?.[0];
  assert.ok(call, `expected a tool call, got ${first.state.body.slice(0, 200)}`);
  const decided = trace.find((entry) => entry.route === 'tool');
  assert.ok(decided, 'the decision is traced');
  assert.equal(issuedCalls.get(call.id)?.turnId, decided?.id, 'the call remembers its turn');

  // 2. Home Assistant runs it and sends the result back as a new request.
  const second = fakeResponse();
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the kitchen ceiling' },
        { role: 'assistant', content: null, tool_calls: [call] },
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            success: true,
            result: { speech: { plain: { speech_slots: { action: 'turned on', name: 'Kitchen Ceiling' } } } },
          }),
        },
      ],
    } as never,
    '{}',
    second.response,
    active,
  );

  const speech = trace.find((entry) => entry.backend === 'speech');
  assert.ok(speech, 'the speech round is traced');
  assert.equal(speech?.answersTurn, decided?.id, 'it points at the decision that caused it');
  assert.ok(speech?.said, 'the reply that was sent is recorded, so a row can show it');
  assert.doesNotMatch(speech?.said ?? '', /^\[pause/);

  // 3. A round whose call this proxy never issued has no owner and stays its own row.
  const orphan = fakeResponse();
  trace.length = 0;
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the kitchen ceiling' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'someone_elses_call', type: 'function', function: { name: 'HassTurnOn', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'someone_elses_call', content: JSON.stringify({ success: true }) },
      ],
    } as never,
    '{}',
    orphan.response,
    active,
  );
  const lonely = trace.find((entry) => entry.backend === 'speech');
  assert.ok(lonely, 'the round is still traced');
  assert.equal(lonely?.answersTurn, undefined, 'with no owner it is not nested anywhere');
});
