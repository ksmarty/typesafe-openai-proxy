import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleChatCompletions } from '../src/pipeline.js';
import { defaultConfig, type Config } from '../src/config.js';
import { clearCatalogCache } from '../src/catalog.js';
import { resetBreaker } from '../src/systemone.js';
import { trace } from '../src/state.js';
import { assistTools } from '../src/toolcall.js';

/**
 * When the decision model cannot be reached, a sentence the local heuristic reads
 * without doubt should not cost a 30-second turn on the model server.
 */
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

const PROMPT = [
  '# Available Devices',
  '- Office Overhead: light.office_lights (area: Office)',
  '- Office Lamp: light.evedal (area: Office)',
].join('\n');

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    // Port 9 (discard) refuses instantly, so the attempts fail fast.
    decision: { ...base.decision, backend: 'systemone', baseUrl: 'http://127.0.0.1:9', model: 'jev-test', autoStart: true, timeoutMs: 300 },
    catalog: { ...base.catalog, haUrl: '', haToken: '', defaultArea: '' },
    upstream: { ...base.upstream, baseUrl: '' },
    speech: { ...base.speech, afterTool: 'template' },
  };
}

describe('a decision outage falls back to the local heuristic', () => {
  before(() => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'trp-outage-'));
    clearCatalogCache();
    resetBreaker();
    trace.length = 0;
  });

  it('answers with a Home Assistant call instead of forwarding', async () => {
    const { state, response } = fakeResponse();
    const request = {
      model: 'typesafe-router',
      stream: false,
      tools: assistTools(),
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'Turn on the office lights.' },
      ],
    };

    await handleChatCompletions(request, JSON.stringify(request), response, config());

    assert.equal(state.status, 200);
    const body = JSON.parse(state.body) as {
      choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
    const call = body.choices[0]?.message.tool_calls?.[0];
    assert.ok(call, `expected a tool call, got ${state.body.slice(0, 200)}`);
    assert.equal(call.function.name, 'HassTurnOn');
    assert.deepEqual(JSON.parse(call.function.arguments), { area: 'Office', domain: 'light' });

    const entry = trace[0];
    assert.ok(entry, 'the turn should be traced');
    assert.match(entry.reason, /read locally instead|decision unavailable/i);
    assert.equal(entry.httpStatus, undefined);
  });

  it('still forwards when the phrase is not clear enough to read locally', async () => {
    const { state, response } = fakeResponse();
    const request = {
      model: 'typesafe-router',
      stream: false,
      tools: assistTools(),
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'what did I say about the thing' },
      ],
    };

    await handleChatCompletions(request, JSON.stringify(request), response, config());

    // No upstream is configured, so a forward explains itself rather than hanging.
    assert.equal(state.status, 200);
    const body = JSON.parse(state.body) as { choices: { message: { content?: string } }[] };
    assert.match(String(body.choices[0]?.message.content ?? ''), /model server|fallback/i);
  });
});
