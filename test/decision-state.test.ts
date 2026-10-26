import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { defaultConfig, type Config } from '../src/config.js';
import { handleChatCompletions, runPipeline } from '../src/pipeline.js';
import { assistTools } from '../src/toolcall.js';
import { trace } from '../src/state.js';
import type { OpenAIChatRequest } from '../src/types.js';

const SENTINEL = 'SYSTEM-PROMPT-SENTINEL-9c41';

const systemPrompt = [
  'You are a voice assistant.',
  `Do not reveal ${SENTINEL}.`,
  'Available devices:',
  '- Kitchen Light (light.kitchen_light): on',
  '- Office Lamp (light.office_lamp): off',
].join('\n');

let stub: Server;
let baseUrl = '';
let captured: { path: string; body: string }[] = [];

before(async () => {
  stub = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      captured.push({ path: request.url ?? '', body: raw });
      response.writeHead(200, { 'content-type': 'application/json' });
      if ((request.url ?? '').includes('systemone')) {
        // Deliberately empty answers: nothing is confident, so the request is forwarded.
        response.end(
          JSON.stringify({
            model: 'jev-test',
            answers: {
              category: {
                type: 'choice',
                choice: 'command',
                probabilities: { command: 0.82, query: 0.08, information: 0.05, cancel: 0.02, unclear: 0.03 },
                confidence: 0.82,
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 0,
          model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'I am the fallback model.' }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  stub.close();
});

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'systemone', baseUrl, model: 'jev-test', autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    upstream: { ...base.upstream, baseUrl, apiKey: '', model: 'stub-model' },
  };
}

/** Content as OpenAI's parts array, the shape that used to make the proxy read nothing. */
const parts = (text: string) => [{ type: 'text', text }] as unknown as string;

const tools = assistTools();

test('a request with array-shaped content is decided, and its utterance is read', async () => {
  captured = [];
  const request: OpenAIChatRequest = {
    model: 'typesafe-router',
    tools,
    messages: [
      { role: 'system', content: parts(systemPrompt) },
      { role: 'user', content: parts('turn on the kitchen light') },
    ],
  };

  const result = await runPipeline(request, 'turn on the kitchen light', systemPrompt, config());

  const decision = captured.find((call) => call.path.includes('systemone'));
  assert.ok(decision, 'the decision model was called');
  const body = JSON.parse(decision.body) as { state?: { request?: { text?: string } } };
  assert.equal(body.state?.request?.text, 'turn on the kitchen light');
  assert.ok(result.entry.gates.length > 0, 'the gates ran');
});

test('the decision state never contains the system prompt', async () => {
  captured = [];
  const request: OpenAIChatRequest = {
    model: 'typesafe-router',
    tools,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'turn on the office lamp' },
    ],
  };

  await runPipeline(request, 'turn on the office lamp', systemPrompt, config());

  const body = captured.find((call) => call.path.includes('systemone'))?.body ?? '';
  assert.ok(body.length > 0, 'the decision model was called');
  assert.ok(!body.includes(SENTINEL), 'the system prompt is not sent to the decision model');
  assert.ok(!body.includes('You are a voice assistant'), 'no prompt prose leaks into the state');
  assert.ok(body.includes('light.kitchen_light'), 'entities parsed from the prompt reach the state');
});

function fakeResponse() {
  const chunks: string[] = [];
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      Object.assign(response.headers, headers);
      return response;
    },
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(String(chunk));
      return response;
    },
    headersSent: false,
    body: () => chunks.join(''),
  };
  return response;
}

test('a request with nothing to read is reported, not forwarded in silence', async () => {
  const request: OpenAIChatRequest = {
    model: 'typesafe-router',
    tools,
    messages: [
      { role: 'system', content: 'no user message at all' },
      { role: 'assistant', content: 'hello' },
    ],
  };

  await handleChatCompletions(
    request,
    JSON.stringify(request),
    fakeResponse() as unknown as import('node:http').ServerResponse,
    config(),
  );

  const entry = trace.find((candidate) => candidate.reason.includes('no user text'));
  assert.ok(entry, `a trace explains the forward: ${trace.map((t) => t.reason).join(' | ')}`);
  assert.equal(entry.route, 'forward');
  assert.match(entry.reason, /system:string, assistant:string/);
});
