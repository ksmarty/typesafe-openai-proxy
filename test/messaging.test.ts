/**
 * Messages, through ha-bluebubbles.
 *
 * "Text Sarah that I'm running late" is the one request this proxy *does* rather than routes:
 * the integration registers a service (`bluebubbles.send_message`) and no assistant tool, so
 * Home Assistant never offers the model anything to call. The name is resolved from the
 * contacts in settings and the call is made here, which is also why the README says the
 * contacts live in the proxy: it is the thing doing the resolving.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig, type Config, type Contact } from '../src/config.js';
import {
  matchContact,
  messagingPlan,
  readMessagingSentence,
  sendServiceData,
  spokenConfirm,
  spokenFailure,
  spokenSend,
} from '../src/messaging.js';
import { handleChatCompletions } from '../src/pipeline.js';
import { pendingConfirmations, trace } from '../src/state.js';
import type { OpenAITool } from '../src/types.js';

const PROMPT = [
  'Available Devices:',
  'Garden Lamp (light.garden_lamp): off',
].join('\n');

const CONTACTS: Contact[] = [
  { name: 'Sarah', address: '+15551234567' },
  { name: 'Sarah Bell', address: 'sarah@example.com' },
  { name: 'Mum', address: '+15559876543' },
];

const TOOLS: OpenAITool[] = ['HassTurnOn'].map((name) => ({
  type: 'function' as const,
  function: {
    name,
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
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

function config(patch: (base: Config) => Config = (base) => base): Config {
  const base = defaultConfig();
  return patch({
    ...base,
    decision: { ...base.decision, backend: 'heuristic', baseUrl: '', historyTurns: 0, autoStart: true },
    catalog: { ...base.catalog, haUrl: '', haToken: '' },
    upstream: { ...base.upstream, baseUrl: '', apiKey: '', model: 'test-model' },
    messaging: { ...base.messaging, confirm: false, contacts: CONTACTS },
  });
}

function aliased(): Config {
  return config((base) => ({ ...base, messaging: { ...base.messaging, contacts: WITH_ALIASES } }));
}

async function say(utterance: string, active: Config) {
  const response = fakeResponse();
  await handleChatCompletions(
    {
      model: 'm',
      stream: false,
      tools: TOOLS,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: 'turn on the garden lamp' },
        { role: 'assistant', content: 'Turned on the garden lamp.' },
        { role: 'user', content: utterance },
      ],
    } as never,
    '{"model":"m"}',
    response.response,
    active,
  );
  return response.state.body;
}

function said(body: string): string {
  const parsed = JSON.parse(body) as {
    choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
  };
  return parsed.choices?.[0]?.message?.content ?? '';
}

test('a message sentence names who and what, and nothing else', () => {
  assert.deepEqual(readMessagingSentence('text Sarah that I am running late', []), {
    recipients: ['Sarah'],
    message: 'I am running late',
  });
  assert.deepEqual(readMessagingSentence('Send a text to Mum saying the door is open', []), {
    recipients: ['Mum'],
    message: 'the door is open',
  });
  assert.deepEqual(readMessagingSentence('Text Sarah: on my way', []), {
    recipients: ['Sarah'],
    message: 'on my way',
  });
  // Said outright, without a contact: the number and the address are the recipient.
  assert.deepEqual(readMessagingSentence('text +1 555 123 4567 that the cat is out', []), {
    recipients: ['+1 555 123 4567'],
    message: 'the cat is out',
  });
  assert.deepEqual(readMessagingSentence('message sarah@example.com I will be late', []), {
    recipients: ['sarah@example.com'],
    message: 'I will be late',
  });
  // Two people, one message.
  assert.deepEqual(readMessagingSentence('text Sarah and Mum that dinner is ready', []), {
    recipients: ['Sarah', 'Mum'],
    message: 'dinner is ready',
  });
});

test('a sentence that is not a message is left to the model', () => {
  assert.equal(readMessagingSentence('turn on the kitchen lights', []), null);
  assert.equal(readMessagingSentence('what did Sarah say about the invoice', []), null);
  assert.equal(readMessagingSentence('text', []), null);
  assert.equal(readMessagingSentence('', []), null);
});

test('a spoken name resolves by whole name, then by first word', () => {
  assert.deepEqual(matchContact(CONTACTS, 'mum'), { kind: 'contact', contact: CONTACTS[2] });
  // The whole name wins over the first word of a longer one.
  assert.deepEqual(matchContact(CONTACTS, 'sarah bell'), { kind: 'contact', contact: CONTACTS[1] });
  assert.deepEqual(matchContact(CONTACTS, 'sarah'), { kind: 'contact', contact: CONTACTS[0] });
  // Two first names shared is a question, never a guess.
  const twins: Contact[] = [
    { name: 'Sarah Bell', address: 'sarah@example.com' },
    { name: 'Sarah Jones', address: 'jones@example.com' },
  ];
  const ambiguous = matchContact(twins, 'sarah');
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.deepEqual(ambiguous.kind === 'ambiguous' ? ambiguous.options : [], ['Sarah Bell', 'Sarah Jones']);
  assert.equal(matchContact(CONTACTS, 'dave').kind, 'unknown');
  // A number or an address said outright needs no contact at all.
  assert.deepEqual(matchContact(CONTACTS, '+447700900123'), {
    kind: 'address',
    address: '+447700900123',
  });
  assert.deepEqual(matchContact(CONTACTS, 'dave@example.com'), {
    kind: 'address',
    address: 'dave@example.com',
  });
});

test('a message plan carries the address, the body and the service', () => {
  const read = messagingPlan({ utterance: 'text Mum that I am on my way', config: config() });
  assert.ok(read && read.kind === 'send');
  assert.equal(read.plan.service, 'bluebubbles.send_message');
  assert.deepEqual(read.plan.addresses, ['+15559876543']);
  assert.equal(read.plan.contact, 'Mum');
  assert.equal(read.plan.message, 'I am on my way');
  assert.deepEqual(sendServiceData(read.plan), {
    addresses: '+15559876543',
    message: 'I am on my way',
  });
  // Said back in one sentence, and never as a claim before the call returns.
  assert.equal(spokenSend(read.plan), 'Sent it to Mum.');
  assert.equal(spokenConfirm(read.plan), 'Should I text Mum “I am on my way”?');
  assert.equal(spokenFailure(read.plan, 'service not found'), "I couldn't send that to Mum: service not found.");
});

test('an unknown name is a question, and a bad service is an error', () => {
  const unknown = messagingPlan({ utterance: 'text Dave that the car is ready', config: config() });
  assert.ok(unknown && unknown.kind === 'ask');
  assert.match(unknown.text, /don't have a contact called dave/i);
  assert.match(unknown.text, /Settings, Messages/);

  const noAddress = messagingPlan({
    utterance: 'text Sarah that hello',
    config: config((base) => ({
      ...base,
      messaging: { ...base.messaging, contacts: [{ name: 'Sarah', address: '' }] },
    })),
  });
  assert.ok(noAddress && noAddress.kind === 'ask');
  assert.match(noAddress.text, /don't have an address/i);

  const badService = messagingPlan({
    utterance: 'text Mum that hello',
    config: config((base) => ({ ...base, messaging: { ...base.messaging, service: 'bluebubbles' } })),
  });
  assert.ok(badService && badService.kind === 'error');
});

test('the turn sends the message itself and says what happened', async () => {
  trace.length = 0;
  // No Home Assistant is reachable here, so the call fails — and the failure is spoken,
  // because a message that did not go out must never sound like one that did.
  const body = await say('text Mum that I am on my way', config());
  assert.equal(said(body), "I couldn't send that to Mum: Home Assistant URL and token are not configured.");

  const entry = trace.find((row) => row.route === 'send');
  assert.ok(entry, 'the turn is traced as a send');
  assert.equal(entry?.tool, 'bluebubbles.send_message');
  assert.deepEqual(entry?.args, { addresses: '+15559876543', message: 'I am on my way' });
  assert.equal(entry?.target, 'Mum');
  assert.equal(entry?.backend, 'off', 'no model was consulted');
  assert.match(entry?.error ?? '', /not configured/);
});

test('asking first arms the question, and yes sends it', async () => {
  pendingConfirmations.clear();
  trace.length = 0;
  const active = config((base) => ({
    ...base,
    messaging: { ...base.messaging, confirm: true },
  }));

  const asked = await say('text Mum that I am on my way', active);
  assert.equal(said(asked), 'Should I text Mum “I am on my way”?');
  assert.equal(pendingConfirmations.size, 1, 'the question is armed, not sent');

  const confirmed = await say('yes', active);
  assert.equal(
    said(confirmed),
    "I couldn't send that to Mum: Home Assistant URL and token are not configured.",
  );
  assert.equal(pendingConfirmations.size, 0);
  const entry = trace.find((row) => row.route === 'send' && row.backend === 'confirmation');
  assert.ok(entry, 'the confirmed send carries its own trace');
});

test('saying no leaves the message unsent', async () => {
  pendingConfirmations.clear();
  const active = config((base) => ({ ...base, messaging: { ...base.messaging, confirm: true } }));
  await say('text Mum that I am on my way', active);
  const cancelled = await say('no', active);
  assert.equal(said(cancelled), 'Okay, cancelled.');
  assert.equal(pendingConfirmations.size, 0);
});

test('no contacts leaves a message sentence alone, and an unreadable name is never sent anywhere', async () => {
  // A house that never sends a message behaves exactly as it did before this reader existed:
  // there is nothing to resolve a name against, so the sentence stays the model's business.
  const empty = await say('text Mum that I am on my way', config((base) => ({
    ...base,
    messaging: { ...base.messaging, contacts: [] },
  })));
  assert.doesNotMatch(said(empty), /Sent it to|don't have a contact/i);

  // Switching the reader off still means off, contacts or not.
  const off = await say('text Mum that I am on my way', config((base) => ({
    ...base,
    messaging: { ...base.messaging, enabled: false },
  })));
  assert.doesNotMatch(said(off), /Sent it to/);

  // An unknown name asks instead of falling through to a model that might invent one.
  const unknown = await say('text Dave that the car is ready', config());
  assert.match(said(unknown), /don't have a contact called dave/i);
});

test('“tell Sarah …” and “let Sarah know …” read the same way', () => {
  assert.deepEqual(readMessagingSentence('tell Sarah that I am running late', CONTACTS), {
    recipients: ['Sarah'],
    message: 'I am running late',
  });
  // No boundary word at all: the configured name is what separates who from what.
  assert.deepEqual(readMessagingSentence("tell Sarah I'm running late", CONTACTS), {
    recipients: ['Sarah'],
    message: "I'm running late",
  });
  assert.deepEqual(readMessagingSentence('let Mum know the door is open', CONTACTS), {
    recipients: ['Mum'],
    message: 'the door is open',
  });
  assert.deepEqual(readMessagingSentence('tell Sarah Bell about the party', CONTACTS), {
    recipients: ['Sarah Bell'],
    message: 'about the party',
  });
  // A bare "tell" with a real number still works, the way "text" does.
  assert.deepEqual(readMessagingSentence('tell +15551234567 the car is outside', []), {
    recipients: ['+15551234567'],
    message: 'the car is outside',
  });
});

const WITH_ALIASES: Contact[] = [
  { name: 'Sarah Bell', address: '+15551234567', aliases: ['Mom'] },
  { name: 'Bob Bell', address: '+15559876543', aliases: ['Dad'] },
];

test('an alias reaches a contact whose name is something else', () => {
  // After a spoken separator the word is carried as said; the plan resolves it to the contact.
  assert.deepEqual(readMessagingSentence('text mom that I am on my way', WITH_ALIASES), {
    recipients: ['mom'],
    message: 'I am on my way',
  });
  // With no separator only the contacts can say where the name ends, so the alias is resolved
  // here and the reply names who was messaged.
  assert.deepEqual(readMessagingSentence('text Mom I am on my way', WITH_ALIASES), {
    recipients: ['Sarah Bell'],
    message: 'I am on my way',
  });
  const plan = messagingPlan({ utterance: 'tell dad I will be late', config: aliased() });
  assert.equal(plan?.kind, 'send');
  assert.deepEqual(plan && 'plan' in plan ? plan.plan.addresses : [], ['+15559876543']);
  assert.deepEqual(plan && 'plan' in plan ? plan.plan.contact : '', 'Bob Bell');
});

test('a real name beats an alias, and two people sharing one is a question', () => {
  // Someone actually called "Mom" outranks an alias on someone else.
  const named = matchContact(
    [
      { name: 'Sarah Bell', address: '+15551234567', aliases: ['Mom'] },
      { name: 'Mom', address: '+15550001111' },
    ],
    'mom',
  );
  assert.deepEqual(named, { kind: 'contact', contact: { name: 'Mom', address: '+15550001111' } });

  const shared = matchContact(
    [
      { name: 'Sarah Bell', address: '+15551234567', aliases: ['Mom'] },
      { name: 'Bob Bell', address: '+15559876543', aliases: ['Mom'] },
    ],
    'mom',
  );
  assert.equal(shared.kind, 'ambiguous');
});

test('“tell me a joke” is never a message', () => {
  // The pronoun guard: "tell" is a verb this house uses for the model too.
  for (const utterance of [
    'tell me a joke',
    'tell us the time',
    'tell him the news',
    'tell them about the party',
    'let me know when the washing is done',
    'tell everyone the party is cancelled',
    'tell nobody',
  ]) {
    assert.equal(readMessagingSentence(utterance, CONTACTS), null, utterance);
    assert.equal(messagingPlan({ utterance, config: config() }), null, utterance);
  }
});

test('a “tell” sentence reaches the same plan as “text”', () => {
  const read = messagingPlan({ utterance: 'tell Sarah that I am running late', config: config() });
  assert.deepEqual(read, {
    kind: 'send',
    reason: read && 'reason' in read ? read.reason : '',
    plan: {
      kind: 'send',
      service: 'bluebubbles.send_message',
      addresses: ['+15551234567'],
      contact: 'Sarah',
      message: 'I am running late',
    },
  });
});
