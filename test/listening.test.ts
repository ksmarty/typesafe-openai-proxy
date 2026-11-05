import assert from 'node:assert/strict';
import test from 'node:test';

import { judgeAddressee } from '../src/addressee.js';
import { catalogFromPrompt, clearCatalogCache } from '../src/catalog.js';
import { ROUTER_MODEL, defaultConfig, type Config } from '../src/config.js';
import { addresseeVerdict, runPipeline } from '../src/pipeline.js';
import { Q } from '../src/questions.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { stats, trace } from '../src/state.js';
import type { Answer, OpenAITool } from '../src/types.js';

// The tolerant parser reads `- Name: domain.object_id (area: X)` as well as
// `- Name (domain.object_id): state`, so use the shape hass_local_openai_llm actually sends.
const PROMPT = [
  '# Available Devices',
  '- Kitchen Ceiling: light.kitchen_ceiling (area: Kitchen)',
  '- Living Room Lamp: light.living_room_lamp (area: Living Room)',
  '- Front Door: lock.front_door (area: Hall)',
].join('\n');

const HOME = catalogFromPrompt(PROMPT);

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassTurnOff', 'HassGetState'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } },
}));

function config(): Config {
  const base = defaultConfig();
  return {
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
  };
}

async function decide(text: string, override: Partial<Config> = {}) {
  clearCatalogCache();
  const active = { ...config(), ...override } as Config;
  return runPipeline(
    { model: 'test', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    PROMPT,
    active,
  );
}

// --- the local reader ------------------------------------------------------

test('a remark between people is not addressed to the assistant', () => {
  for (const text of [
    'did you see the game last night',
    'my wife says the door is still open',
    'I should probably fix that door at some point',
    'we need to get the boiler serviced',
    'it is getting late',
    'the neighbours are being loud again',
  ]) {
    const verdict = judgeAddressee(text, HOME);
    assert.equal(verdict.addressed, false, `"${text}" should read as a remark`);
  }
});

test('a request in any of its usual shapes is addressed', () => {
  for (const text of [
    'turn on the kitchen ceiling',
    'is the front door locked',
    'what is the temperature',
    'make it brighter',
    'thank you',
    'yes',
    'ignore that',
    'kitchen off',
  ]) {
    const verdict = judgeAddressee(text, HOME);
    assert.notEqual(verdict.addressed, false, `"${text}" must not be silenced`);
  }
});

test('a command with a verb is addressed even when it is short and names nothing', () => {
  assert.equal(judgeAddressee('close it', HOME).addressed, true);
  assert.equal(judgeAddressee('turn it off', HOME).addressed, true);
});

test('an unreadable sentence is left alone rather than silenced', () => {
  // The reader only says "no" when the sentence is plainly a remark; everything else is
  // "unknown", which means the request is forwarded exactly as before.
  const verdict = judgeAddressee('the thing about tuesdays', HOME);
  assert.equal(verdict.addressed, null);
});

// --- the verdict -----------------------------------------------------------

test('the decision model outranks the local reader', () => {
  const active = config();
  const answers: Record<string, Answer> = { [Q.addressed]: { type: 'noul', noul: 0.1 } };
  const verdict = addresseeVerdict(active, 'turn on the kitchen ceiling', HOME, answers);
  assert.equal(verdict.silent, true, 'a model answer of 0.1 addressed means "a remark"');

  const addressed: Record<string, Answer> = { [Q.addressed]: { type: 'noul', noul: 0.95 } };
  assert.equal(addresseeVerdict(active, 'we should fix that door', HOME, addressed).silent, false);
  assert.equal(addresseeVerdict(active, 'let us watch the game', HOME, addressed).silent, false);
});

test('switching listening off disables the judgement entirely', () => {
  const active = config();
  active.listening = { ...active.listening, enabled: false };
  const answers: Record<string, Answer> = { [Q.addressed]: { type: 'noul', noul: 0 } };
  assert.equal(addresseeVerdict(active, 'did you see the game', HOME, answers).silent, false);
});

test('the local reader can be switched off while the feature stays on', () => {
  const active = config();
  active.listening = { ...active.listening, local: false };
  assert.equal(addresseeVerdict(active, 'did you see the game last night', HOME).silent, false);
});

// --- the turn --------------------------------------------------------------

test('an overheard remark is answered with silence, not forwarded', async () => {
  const before = stats.ignored;
  const result = await decide('did you see the game last night');
  assert.equal(result.route.plan.kind, 'ignore', JSON.stringify(result.route.plan));
  assert.equal(result.route.plan.kind === 'ignore' ? result.route.plan.silence : '', '[pause:1.5s]');
  assert.match(result.entry.reason, /not addressed/);
  assert.equal(result.entry.route, 'ignore');
  assert.equal(stats.ignored, before + 1);
});

test('a command is still a command', async () => {
  const result = await decide('turn on the kitchen ceiling');
  assert.equal(result.route.plan.kind, 'tool', JSON.stringify(result.route.plan));
});

test('a request the fast path cannot read is still forwarded when it was addressed', async () => {
  const result = await decide('write me a poem about the sea');
  assert.equal(result.route.plan.kind, 'forward', JSON.stringify(result.route.plan));
});

test('a pass-through install still silences a remark it overheard', async () => {
  clearCatalogCache();
  const active = config();
  // No decision backend at all, and the request named the router model: no model is asked on
  // this path, so the local reader is the only thing between an overheard sentence and the
  // model server.
  active.decision = { ...active.decision, backend: 'none' };
  const session = (content: string) => ({
    model: ROUTER_MODEL,
    messages: [{ role: 'user' as const, content }],
    tools: TOOLS,
  });
  const overheard = await runPipeline(session('did you see the game last night'), 'did you see the game last night', PROMPT, active);
  assert.equal(overheard.route.plan.kind, 'ignore', JSON.stringify(overheard.route.plan));

  const forwarded = await runPipeline(session('put the kettle on'), 'put the kettle on', PROMPT, active);
  assert.equal(forwarded.route.plan.kind, 'forward', JSON.stringify(forwarded.route.plan));
});

test('a turn that carries no tool schemas is still judged', async () => {
  clearCatalogCache();
  const session = (content: string) => ({
    model: 'gpt-4o',
    messages: [{ role: 'user' as const, content }],
    tools: [],
  });
  // Nothing can be called without tool schemas, so the request is forwarded as-is — but an
  // overheard remark still is not.
  const overheard = await runPipeline(
    session('my wife says the door is still open'),
    'my wife says the door is still open',
    PROMPT,
    config(),
  );
  assert.equal(overheard.route.plan.kind, 'ignore', JSON.stringify(overheard.route.plan));

  const forwarded = await runPipeline(session('write me a poem about the sea'), 'write me a poem about the sea', PROMPT, config());
  assert.equal(forwarded.route.plan.kind, 'forward', JSON.stringify(forwarded.route.plan));
});

// --- the response ----------------------------------------------------------

test('the silence text is what actually comes back over the wire', async () => {
  clearCatalogCache();
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
  const active = config();
  active.decision = { ...active.decision, backend: 'none' };
  const body = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'did you see the game last night' }],
    tools: TOOLS,
  };
  await handleChatCompletions(body as never, JSON.stringify(body), response as never, active);
  assert.equal(state.status, 200);
  assert.match(state.body, /\[pause:1\.5s\]/, `expected the pause marker, got: ${state.body.slice(0, 300)}`);
  assert.match(state.body, /chat\.completion/);
  const entry = trace[trace.length - 1];
  assert.equal(entry?.route, 'ignore');
  assert.equal(entry?.utterance, 'did you see the game last night');
});
