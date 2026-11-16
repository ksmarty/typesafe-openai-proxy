/**
 * The dashboard's history outlives the process.
 *
 * An image update used to wipe every row: the calls the proxy made, what Home Assistant
 * said back, the request log. The fix writes the same arrays to `history.json` in the data
 * directory and reads them back on boot, so an upgrade keeps the rows you were looking at.
 *
 * These tests cover the file itself: an atomic round trip, a corrupt or foreign file being
 * ignored rather than breaking boot, and `restoreHistory` only copying counts it knows.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureHistory, historyPath, readHistory, saveHistoryNow, type HistorySnapshot } from '../src/history.js';
import { historySnapshot, requestLog, restoreHistory, stats, trace } from '../src/state.js';
import type { TraceEntry } from '../src/types.js';

function entry(id: string, utterance: string): TraceEntry {
  return {
    id,
    at: 1_700_000_000_000,
    utterance,
    route: 'tool',
    reason: 'matched the action table',
    gates: [],
    tool: 'HassTurnOn',
    calls: [{ tool: 'HassTurnOn', args: { name: 'light.kitchen' } }],
    said: 'Kitchen light on.',
    upstreamReply: 'The kitchen light is on.',
    upstreamCalls: [{ tool: 'HassLightSet', args: { brightness: 40 } }],
  };
}

function snapshot(): HistorySnapshot {
  return {
    version: 1,
    trace: [entry('t1', 'turn on the kitchen light'), entry('t2', 'set the lamp to 40')],
    requests: [
      { at: 1_700_000_000_000, method: 'POST', path: '/v1/chat/completions', status: 200, ms: 42 },
      { at: 1_700_000_001_000, method: 'GET', path: '/api/trace', status: 200, ms: 3 },
    ],
    stats: { requests: 12, toolCalls: 9, forwarded: 3 },
  };
}

test('a saved history reads back with its calls and what was said', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-'));
  configureHistory({ directory });
  assert.equal(readHistory(), null, 'nothing is remembered before the first write');

  saveHistoryNow(() => snapshot());

  const loaded = readHistory();
  assert.ok(loaded, 'the file is readable');
  assert.equal(loaded?.trace.length, 2);
  assert.equal(loaded?.trace[0].utterance, 'turn on the kitchen light');
  assert.deepEqual(loaded?.trace[0].calls, [{ tool: 'HassTurnOn', args: { name: 'light.kitchen' } }]);
  assert.equal(loaded?.trace[0].upstreamReply, 'The kitchen light is on.', 'the forwarded answer persists');
  assert.deepEqual(loaded?.trace[1].upstreamCalls, [{ tool: 'HassLightSet', args: { brightness: 40 } }]);
  assert.equal(loaded?.requests.length, 2);
  assert.deepEqual(loaded?.stats, { requests: 12, toolCalls: 9, forwarded: 3 });
  assert.equal(existsSync(`${historyPath()}.tmp`), false, 'the temporary file is renamed, not left behind');
});

test('a corrupt file is ignored, not fatal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-'));
  configureHistory({ directory });
  writeFileSync(historyPath(), '{ this is not json', 'utf8');
  assert.equal(readHistory(), null);
});

test('a file from another version is ignored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-'));
  configureHistory({ directory });
  writeFileSync(historyPath(), JSON.stringify({ ...snapshot(), version: 99 }), 'utf8');
  assert.equal(readHistory(), null);
});

test('restoring puts the rows back and copies only counts it already tracks', () => {
  trace.length = 0;
  requestLog.length = 0;
  stats.requests = 0;

  const restored = restoreHistory({
    ...snapshot(),
    stats: { requests: 7, toolCalls: 4, madeUpCounter: 99 },
  });

  assert.equal(restored, 2, 'it reports how many rows came back');
  assert.deepEqual(
    trace.map((row) => row.id),
    ['t1', 't2'],
  );
  assert.equal(trace[0].said, 'Kitchen light on.');
  assert.equal(requestLog.length, 2);
  assert.equal(stats.requests, 7);
  assert.equal(stats.toolCalls, 4);
  assert.equal('madeUpCounter' in stats, false, 'an unknown key is not grafted onto the live counters');
});

test('a snapshot of the live state carries every row', () => {
  trace.length = 0;
  trace.push(entry('t3', 'turn off the kettle'));
  const live = historySnapshot();
  assert.equal(live.version, 1);
  assert.equal(live.trace[0].id, 't3');
  assert.deepEqual(live.requests, requestLog, 'the request log comes along');
});
