import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { speechFor, speechForToolRound } from '../src/respond.js';
import { issuedCalls } from '../src/state.js';

/**
 * What gets said after a call, taken from the shape Home Assistant really sends.
 *
 * Captured from a live Assist run: the tool message content is the intent's response
 * data, its `speech` is an empty object, and the entities it acted on are listed under
 * `data.success`. The proxy used to ignore that and answer "Done." — which is exactly
 * what the user heard.
 */
const realToolResult = JSON.stringify({
  speech: {},
  response_type: 'action_done',
  data: {
    success: [
      { name: 'Office', type: 'area', id: 'office' },
      { name: 'Office Overhead', type: 'entity', id: 'light.office_lights' },
      { name: 'Office Lamp', type: 'entity', id: 'light.evedal' },
    ],
    failed: [],
  },
});

describe('speech from a real Assist tool result', () => {
  before(() => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'trp-speech-'));
    issuedCalls.set('call_1', { action: 'turn_on', targets: ['office'], at: Date.now() });
    issuedCalls.set('call_2', { action: 'turn_off', targets: ['light.evedal'], at: Date.now() });
    issuedCalls.set('call_3', { action: 'turn_on', targets: ['x'], at: Date.now() });
  });

  it('names the entities that changed instead of saying "Done."', () => {
    assert.equal(speechFor('call_1', realToolResult, null, 'en'), 'Turned on Office Overhead and Office Lamp.');
  });

  it('uses the verb of the action that was sent', () => {
    assert.equal(speechFor('call_2', realToolResult, null, 'en'), 'Turned off Office Overhead and Office Lamp.');
  });

  it('falls back to the area when only an area is reported', () => {
    const areaOnly = JSON.stringify({
      speech: {},
      response_type: 'action_done',
      data: { success: [{ name: 'Office', type: 'area', id: 'office' }], failed: [] },
    });
    assert.equal(speechFor('call_1', areaOnly, null, 'en'), 'Turned on Office.');
  });

  it('says what failed when nothing succeeded', () => {
    const failed = JSON.stringify({
      speech: {},
      response_type: 'action_done',
      data: {
        success: [],
        failed: [
          { name: 'Office Overhead', type: 'entity', id: 'light.office_lights' },
          { name: 'Office Lamp', type: 'entity', id: 'light.evedal' },
        ],
      },
    });
    assert.equal(speechFor('call_1', failed, null, 'en'), 'I could not reach Office Overhead and Office Lamp.');
  });

  it('joins several calls without repeating itself', () => {
    const said = speechForToolRound(
      [
        { callId: 'call_1', content: realToolResult },
        { callId: 'call_2', content: realToolResult },
      ],
      'en',
    );
    assert.equal(said, 'Turned on Office Overhead and Office Lamp. Turned off Office Overhead and Office Lamp.');
  });

  it('ignores a call it did not issue', () => {
    assert.equal(speechFor('unknown-call', realToolResult, null, 'en'), '');
  });
});
