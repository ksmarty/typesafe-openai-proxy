import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import {
  cachedDecision,
  clearDecisionCache,
  configureDecisionCache,
  decisionCachePath,
  decisionCacheSize,
  decisionKey,
  isQuestion,
  loadDecisionCache,
  rememberDecision,
  saveDecisionCache,
} from '../src/decidecache.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearCatalogCache } from '../src/catalog.js';
import { defaultConfig } from '../src/config.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { trace } from '../src/state.js';

/**
 * A repeated command against an unchanged house costs one model call, not two.
 *
 * The stub counts requests; the second identical utterance must not reach it, a question must
 * always reach it (its answer depends on live state), and a sentence decided against a
 * different house must reach it again.
 */
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'HassTurnOn',
      description: 'Turn something on',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'HassGetState',
      description: 'Read a state',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, area: { type: 'string' }, domain: { type: 'string' } },
      },
    },
  },
];

/** Answers every question with one confident choice, so a full route comes out. */
function answersFor(questions: Record<string, { type: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (key === 'target_entity') {
      out[key] = { type: 'choice', choice: 'e_kitchen_lights', confidence: 0.95, probabilities: { e_kitchen_lights: 0.95 } };
      continue;
    }
    if (key === 'target_area') {
      out[key] = { type: 'choice', choice: 'area_kitchen', confidence: 0.95, probabilities: { area_kitchen: 0.95 } };
      continue;
    }
    if (key === 'target_domain') {
      out[key] = { type: 'choice', choice: 'light', confidence: 0.95, probabilities: { light: 0.95 } };
      continue;
    }
    if (key.startsWith('action_')) {
      out[key] = { type: 'choice', choice: 'turn_on', confidence: 0.95, probabilities: { turn_on: 0.95 } };
      continue;
    }
    if (key === 'query_kind') {
      out[key] = { type: 'choice', choice: 'device_state', confidence: 0.95, probabilities: { device_state: 0.95 } };
      continue;
    }
    if (key === 'scope') {
      out[key] = { type: 'choice', choice: 'single', confidence: 0.95, probabilities: { single: 0.95 } };
      continue;
    }
    if (question.type === 'noul') {
      out[key] = { type: 'noul', noul: 0.02 };
      continue;
    }
    out[key] = { type: 'choice', choice: 'command', confidence: 0.97, probabilities: { command: 0.97 } };
  }
  return out;
}

async function startStub(): Promise<{ url: string; calls: () => number; server: Server; stop: () => void }> {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      calls += 1;
      const parsed = JSON.parse(body) as { questions: Record<string, { type: string }> };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'stub',
          answers: answersFor(parsed.questions),
          usage: { input_tokens: 1000, output_tokens: 40 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    server,
    stop: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function fakeResponse(): {
  statusCode: number;
  body: string;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  setHeader: (name: string, value: string) => void;
  flushHeaders: () => void;
  get headersSent(): boolean;
} {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
    setHeader() {
      /* not needed */
    },
    flushHeaders() {
      /* not needed */
    },
    get headersSent() {
      return false;
    },
  };
}

const PROMPT = [
  "# Kitchen",
  "light.kitchen_lights: off",
  "light.hall_lamp: on",
].join('\n');

async function ask(baseUrl: string, text: string): Promise<string> {
  const config = defaultConfig();
  const active = {
    ...config,
    catalog: { ...config.catalog, haUrl: '', haToken: '' },
    decision: { ...config.decision, backend: 'systemone' as const, baseUrl, model: 'jev-test', cache: true, persistCache: false },
  };
  clearCatalogCache();
  const body = {
    model: 'typesafe-router',
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: text },
    ],
    tools: TOOLS,
    stream: false,
  };
  const response = fakeResponse();
  await handleChatCompletions(body as never, JSON.stringify(body), response as never, active);
  return response.body;
}

test('the same sentence twice costs one model call', async () => {
  clearDecisionCache();
  trace.length = 0;
  const stub = await startStub();
  try {
    const first = await ask(stub.url, 'turn on the kitchen lights');
    const second = await ask(stub.url, 'turn on the kitchen lights');

    assert.equal(stub.calls(), 1, 'the second decision came from the cache');
    assert.match(first, /HassTurnOn/);
    assert.match(second, /HassTurnOn/);
    assert.equal(decisionCacheSize(), 1);
  } finally {
    stub.stop();
  }
});

test('a question is never cached', async () => {
  clearDecisionCache();
  trace.length = 0;
  const stub = await startStub();
  try {
    await ask(stub.url, 'is the kitchen light on?');
    await ask(stub.url, 'is the kitchen light on?');
    assert.equal(stub.calls(), 2, 'state questions always ask');
    assert.equal(decisionCacheSize(), 0);
    assert.equal(isQuestion('is the light on?'), true);
    assert.equal(isQuestion('turn on the light'), false);
  } finally {
    stub.stop();
  }
});

test('a different sentence is a different decision', async () => {
  clearDecisionCache();
  trace.length = 0;
  const stub = await startStub();
  try {
    await ask(stub.url, 'turn on the kitchen lights');
    await ask(stub.url, 'turn off the kitchen lights');
    assert.equal(stub.calls(), 2);
    assert.equal(decisionCacheSize(), 2);
  } finally {
    stub.stop();
  }
});

test('the cache survives a restart, because it lives in the data directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trp-cache-'));
  configureDecisionCache({ persist: true, directory: dir });
  clearDecisionCache();
  const key = 'key-for-a-sentence';
  const value = { model: 'jev-test', answers: {}, inputTokens: 1, outputTokens: 1, latencyMs: 1, backend: 'systemone' as const };
  rememberDecision(key, value);
  saveDecisionCache();

  // What a fresh process does: read the file back, keep nothing in memory that was not there.
  const loaded = loadDecisionCache();
  assert.equal(loaded, 1);
  assert.deepEqual(cachedDecision(key)?.model, 'jev-test');
  assert.equal(decisionCachePath().startsWith(dir), true);
});

test('a changed house is a different key, so nothing stale is served', () => {
  const base = {
    utterance: 'turn on the kitchen lights',
    model: 'jev-test',
    baseUrl: 'https://example.test/api',
    questions: {} as never,
  };
  const before = decisionKey({ ...base, homeSignature: 'areas:a|entities:light.kitchen' });
  const after = decisionKey({ ...base, homeSignature: 'areas:a|entities:light.kitchen,light.hall' });
  const sameSentence = decisionKey({ ...base, homeSignature: 'areas:a|entities:light.kitchen' });
  assert.notEqual(before, after, 'an added entity invalidates the entry');
  assert.equal(before, sameSentence, 'the same house keeps the entry forever');
});

test('persistence can be turned off, and then nothing is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trp-nocache-'));
  configureDecisionCache({ persist: false, directory: dir });
  clearDecisionCache();
  rememberDecision('another-key', { model: 'x', answers: {}, inputTokens: 0, outputTokens: 0, latencyMs: 0, backend: 'systemone' });
  saveDecisionCache();
  assert.equal(existsSync(decisionCachePath()), false);
});
