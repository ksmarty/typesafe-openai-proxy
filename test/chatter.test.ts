import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksLikeChatter, looksLikeQuestion } from '../src/chatter.js';
import type { Catalog } from '../src/types.js';

const catalog: Catalog = {
  areas: [{ id: 'kitchen', name: 'Kitchen' }],
  entities: [
    { id: 'light.kitchen_ceiling', name: 'Kitchen Ceiling', domain: 'light', state: 'off', areaName: 'Kitchen' },
    { id: 'light.desk_lamp', name: 'Desk Lamp', domain: 'light', state: 'on' },
  ],
  domains: ['light'],
  source: 'ha-websocket',
  builtAt: Date.now(),
};

test('a terse correction is conversation, not a command', () => {
  for (const text of ['no you', 'ignore', 'ignore that', 'never mind', 'thanks', 'wait', 'okay']) {
    const reason = looksLikeChatter(text, catalog);
    assert.ok(reason, `"${text}" should be conversation`);
    assert.match(reason!, /conversation, not a command/);
  }
});

test('a sentence with a command verb is never conversation', () => {
  for (const text of ['no turn it off', 'turn on the lights', 'ignore the light and turn it off']) {
    assert.equal(looksLikeChatter(text, catalog), null, `"${text}" is a command`);
  }
});

test('naming a device or a room keeps it for the decision model', () => {
  assert.equal(looksLikeChatter('kitchen off', catalog), null);
  assert.equal(looksLikeChatter('desk lamp', catalog), null);
  assert.equal(looksLikeChatter('is the desk lamp on?', catalog), null);
});

test('a long sentence is left to the model', () => {
  assert.equal(looksLikeChatter('well I was thinking about what you said earlier today', catalog), null);
});

test('an empty sentence says nothing at all', () => {
  assert.equal(looksLikeChatter('', catalog), null);
  assert.equal(looksLikeChatter('   ', catalog), null);
});

test('a plain state question is answered from the catalog without the model', async () => {
  const { directStatePlan } = await import('../src/answer.js');
  const answer = directStatePlan(catalog, 'is the desk lamp on?');
  assert.ok(answer, 'should answer locally');
  assert.equal(answer!.text, "Yes, it's on.");
  assert.equal(directStatePlan(catalog, 'is the kitchen ceiling off?')!.text, "Yes, it's off.");
  // Ambiguous or unreadable questions take the normal path.
  assert.equal(directStatePlan(catalog, 'is it on?'), null);
  assert.equal(directStatePlan(catalog, 'is the light that is not named on?'), null);
  assert.equal(directStatePlan(catalog, 'turn on the desk lamp'), null);
});

test('a question is the decision model\'s to read, not the chatter filter\'s', () => {
  const questions = [
    'what day is it today',
    'what is the date',
    'why is the sky blue',
    'who won the game last night',
    'what is the capital of france',
    'how come the sky is red',
    'is that right?',
    'what?',
    "what's two plus two",
    'tell me a joke',
  ];
  for (const text of questions) {
    assert.equal(looksLikeQuestion(text), true, `"${text}" asks something`);
  }

  // An aside asks nothing, and still costs no model round trip.
  for (const text of ['thanks', 'never mind', 'ignore that', 'no you', 'okay', 'wait']) {
    assert.equal(looksLikeQuestion(text), false, `"${text}" is an aside`);
    assert.ok(looksLikeChatter(text, catalog), `"${text}" is still conversation`);
  }
});
