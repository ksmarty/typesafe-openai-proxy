/**
 * A forwarded answer is kept, not just streamed.
 *
 * `forwardUpstream` hands the upstream bytes to Home Assistant untouched. The monitor also
 * has to show what came back — and any tool the model asked for — so the same bytes are
 * parsed on the way past: plain JSON answers and streamed (SSE) ones alike.
 */

import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { forwardUpstream } from '../src/respond.js';
import { issuedCalls, trace, turnBySession } from '../src/state.js';
import type { OpenAIChatRequest, OpenAITool } from '../src/types.js';

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

async function serving(
  contentType: string,
  write: (response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType });
    write(response);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function activeWith(url: string): Config {
  const base = defaultConfig();
  return { ...base, upstream: { ...base.upstream, baseUrl: url, apiKey: '', model: 'test-model' } };
}

const REQUEST = {
  model: 'm',
  stream: false,
  messages: [{ role: 'user', content: 'Is the door locked?' }],
} as OpenAIChatRequest;

test('a plain JSON answer yields its text and the tool calls the model asked for', async () => {
  const upstream = await serving('application/json', (response) => {
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The deadbolt is locked.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'HassGetState', arguments: '{"name":"sensor.deadbolt"}' },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  try {
    const client = fakeResponse();
    const answer = await forwardUpstream(REQUEST, '{"model":"m"}', client.response, activeWith(upstream.url));

    assert.equal(answer?.text, 'The deadbolt is locked.');
    assert.equal(answer?.status, 200);
    assert.deepEqual(answer?.calls, [{ tool: 'HassGetState', args: { name: 'sensor.deadbolt' } }]);
    assert.match(client.state.body, /deadbolt is locked/, 'the client still receives the answer');
  } finally {
    await upstream.close();
  }
});

test('a streamed answer is assembled from its deltas while the client sees it live', async () => {
  const upstream = await serving('text/event-stream; charset=utf-8', (response) => {
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ choices: [{ delta: { content: 'The kitchen light ' } }] });
    send({ choices: [{ delta: { content: 'is on.' } }] });
    send({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: 'HassLightSet', arguments: '{"brightness":' } }] } },
      ],
    });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '40}' } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    response.write('data: [DONE]\n\n');
  });
  try {
    const client = fakeResponse();
    const answer = await forwardUpstream(
      { ...REQUEST, stream: true },
      '{"model":"m","stream":true}',
      client.response,
      activeWith(upstream.url),
    );

    assert.equal(answer?.text, 'The kitchen light is on.', 'the deltas are joined');
    assert.deepEqual(answer?.calls, [{ tool: 'HassLightSet', args: { brightness: 40 } }], 'split arguments are parsed');
    assert.match(client.state.body, /data: /, 'the client still gets the raw stream');
  } finally {
    await upstream.close();
  }
});

test('a refused upstream answer is reported, not stored as a reply', async () => {
  const server: Server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model is overloaded' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const client = fakeResponse();
    const answer = await forwardUpstream(REQUEST, '{"model":"m"}', client.response, activeWith(`http://127.0.0.1:${port}/v1`));
    assert.equal(answer?.status, 503);
    assert.match(answer?.error ?? '', /overloaded/);
    assert.equal(answer?.text, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The forwarded turn itself has to carry the answer, or the monitor has nothing to show. */
test('a question answered by the model server is traced with its reply', async () => {
  const upstream = await serving('application/json', (response) => {
    response.end(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Yes, the deadbolt is locked.' } }] }),
    );
  });
  try {
    clearCatalogCache();
    issuedCalls.clear();
    turnBySession.clear();
    trace.length = 0;

    const base = defaultConfig();
    const active: Config = {
      ...base,
      decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
      catalog: { ...base.catalog, haUrl: '', haToken: '' },
      upstream: { ...base.upstream, baseUrl: upstream.url, apiKey: '', model: 'test-model' },
      speech: { ...base.speech, rules: [], afterTool: 'empty', silence: '[pause:1.5s]' },
    };
    const tools: OpenAITool[] = ['HassTurnOn', 'HassTurnOff'].map((name) => ({
      type: 'function' as const,
      function: { name, parameters: { type: 'object', properties: { name: { type: 'string' } } } },
    }));

    const client = fakeResponse();
    await handleChatCompletions(
      {
        model: 'm',
        stream: false,
        tools,
        messages: [
          {
            role: 'system',
            content: ['Available Devices:', 'Kitchen Lights (light.kitchen_lights): off'].join('\n'),
          },
          { role: 'user', content: 'Is the door locked?' },
        ],
      } as never,
      '{"model":"m"}',
      client.response,
      active,
    );

    const asked = trace.find((row) => row.utterance === 'Is the door locked?');
    assert.ok(asked, 'the question is traced');
    assert.equal(asked?.route, 'forward', `expected a forward, got ${asked?.route}: ${asked?.reason}`);
    assert.equal(asked?.upstreamReply, 'Yes, the deadbolt is locked.', 'the answer is kept on the row');
    assert.match(client.state.body, /deadbolt is locked/);
  } finally {
    await upstream.close();
  }
});
