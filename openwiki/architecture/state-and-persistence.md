---
type: "Reference"
title: "State and persistence"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-32df914360d92c28e9283cc8
    resource: repo://src/decidecache.ts
  - id: openwiki-source-8c630d0655d2170e7b1bb86c
    resource: repo://src/history.ts
  - id: openwiki-source-d9b845a7425932c3767a237e
    resource: repo://src/server.ts
  - id: openwiki-source-47ceacd9486dc381d1b4a4e6
    resource: repo://src/state.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# State and persistence

A turn needs memory: which calls this proxy made, what it said, which sentence came before, whether a risky action is waiting for a yes. All of that lives in process memory. What used to vanish with the process — the trace, the request log and the counters — now survives an image update in the data directory.

<!-- openwiki: broken internal link [dashboard.md] file "dashboard.md" does not exist. Fix the href or restore the target, then delete this comment. -->
This page describes both layers: the in-process structures in `src/state.ts`, and the two files that outlive them, `history.json` and `decision-cache.json`. See [Request lifecycle](request-lifecycle.md) for where each is written and [Dashboard](dashboard.md) for how the trace is read.

## What lives in memory

`src/state.ts` holds four kinds of state, deliberately separate because they have different lifetimes.

### Trace

`trace: TraceEntry[]` is the dashboard's record, newest first. `rememberTrace(entry)` at `src/state.ts:184-191` prunes, unshifts, then trims to `Math.max(10, loadConfig().routing.traceLimit)`. The floor of ten matters: a configured limit of zero must not leave you with no rows at all.

`updateTrace(id, patch)` at `src/state.ts:193-198` folds a late measurement into an existing row — the upstream round trip is only known after the stream ends — and does nothing if the row has already been trimmed away.

### Request log

`requestLog: SeenRequest[]` at `src/state.ts:162` is one row per request that reached `/v1`, whether or not it became a turn. The interface at `:155-161` is `{at, method, path, status, ms}`. `rememberRequest` at `:165-169` unshifts and caps at 50.

`lastRequestFields` at `:180-182` keeps only the top-level field names of the last body. The comment explains why names are enough and why they are safe: the question "why did it not know which room it was in" turns on whether Home Assistant sends `device_id` at all.

### Turns

`turnBySession` is a `Map<session, Map<utterance, {id, at, category?}>>` (`src/state.ts:71`). `rememberTurn` at `:77-91` deletes the same sentence first, then evicts the oldest past `TURNS_PER_SESSION = 12` (`:74`). `lastTurnFor` at `:99-112` refuses a turn older than `TURN_TTL_MS = 120_000` (`:57`). This is what links a speech round back to the sentence that caused it; [Speech, turns and confirmation](speech-and-confirmation.md) covers the nesting.

### Issued calls and confirmations

`issuedCalls: Map<string, {action, targets, domain?, tool?, args?, turnId?, at}>` records every call the proxy sent, keyed by the `tool_call_id` it invented. It is how a tool result becomes a descriptor later, and the only reason the proxy can speak about a call at all.

`pendingConfirmations: Map<string, PendingConfirmation>` (`src/state.ts:27`) holds an armed risky action against the session key, with `expiresAt`.

Both are swept by `pruneState()` at `src/state.ts:120-152`: expired confirmations, calls older than `ISSUED_TTL_MS = 10 * 60 * 1000` (`:117`), stale turns, and a hard cap of `MAP_CAP = 200` (`:115`) on each map.

## What survives a restart

The data directory (default `data/`, or `DATA_DIR`) already held `config.json` and `decision-cache.json`. History joins them.

### history.json

`src/history.ts` is small on purpose and has no runtime import from `src/state.ts` — it only takes a `TraceEntry` type — so there is no import cycle.

Files and limits:

| Constant | Value | Why |
| --- | --- | --- |
| `HISTORY_FILE` | `history.json` | next to the other data files |
| `VERSION` | `1` | a newer build can refuse an older shape |
| `SAVE_DELAY_MS` | 1500 | several trace updates in one turn become one write |
| `MAX_PERSISTED_TRACE` | 1000 | more than the dashboard asks for, small enough to stay cheap |
| `MAX_PERSISTED_REQUESTS` | 50 | the request log is capped at 50 anyway |

`historyPath()` at `src/history.ts:48-50` resolves inside the configured directory. `configureHistory(options?)` at `:59-64` moves the directory and, on the first call in a process, reads what an earlier run saved. Later calls return null — the `loaded` flag makes boot-time restore happen exactly once.

`readHistory()` at `:66-89` is defensive at every step:

- a missing or unparsable file returns null rather than failing boot;
- `parsed.version !== VERSION` returns null;
- trace rows go through `isTraceEntry` at `:124-134`, which requires a string `id`, a number `at`, a string `route` and an array `gates`;
- requests go through `isStoredRequest` at `:136-147`;
- stats keep only finite numbers.

Writing is debounced and atomic. One pending timer only (`scheduleHistorySave` at `:91-99`, with `saveTimer.unref()` so it never holds the process open). `saveHistoryNow` at `:101-122` clears the timer, serialises `{version, savedAt, trace, requests, stats}`, creates the directory with `mkdirSync(..., {recursive: true})`, writes `${target}.tmp`, then `renameSync`s it into place. The whole body is wrapped in `try/catch` with one comment: "A read-only data directory must not break a decision."

### When it is called

`state.ts` schedules a save after every mutation that matters:

- `rememberRequest` at `src/state.ts:165-169`
- `rememberTrace` at `:184-191`
- `updateTrace` at `:193-198`

`restoreHistory(saved)` at `src/state.ts:206-224` puts it back. Two behaviours are worth knowing:

- the trace and request log are replaced only when the file actually had rows, so an empty file cannot wipe a running process;
- stats are copied only for keys that already exist on `stats` and are finite — a hand-edited file cannot invent a counter the code never increments.

`historySnapshot()` at `src/state.ts:226-228` produces the shape on demand, copying the trace, the request log and the stats.

Server-side wiring:

- boot, after the decision cache is configured: `const savedHistory = configureHistory(); if (savedHistory) restoreHistory(savedHistory);` at `src/server.ts:709-710`;
- `DELETE /trace` at `src/server.ts:322-327` clears the array and then calls `saveHistoryNow(historySnapshot)` — without that flush the rows would reappear on the next restart;
- `shutdown()` at `src/server.ts:714-723` flushes before closing, because a debounced save would never fire after exit;
- `process.once('exit', () => saveHistoryNow(historySnapshot))` at `src/server.ts:725` catches the paths that never reach `shutdown()`.

### decision-cache.json

The decision cache is a separate file with the same discipline, in `src/decidecache.ts`:

- `CACHE_FILE = 'decision-cache.json'`, `SAVE_DELAY_MS = 2000`, `MAX_ENTRIES = 500` (`:25-33`).
- `configureDecisionCache({persist, directory})` at `:54-61` loads once; the settings page calls it again on save so toggling persistence takes effect without a restart.
- `loadDecisionCache()` at `:63-84` returns 0 on any problem and says nothing.
- `scheduleSave` and `saveDecisionCache` at `:86-102` use the same temporary-file rename, and `persist: false` writes nothing.

The cache is safe to keep because its key carries `homeSignature`, a signature of the exposed entity ids and rooms and never their state. A rebuilt catalog still hits; an added, removed or re-exposed entity misses. Questions are never cached, because their answer depends on live state. Nothing expires on a clock: "turn on the kitchen lights" is the same decision tomorrow. The reasoning is documented at the top of `src/decidecache.ts`.

## What is deliberately not persisted

- `issuedCalls` and `pendingConfirmations` — a confirmation is a spoken exchange minutes long, not something to resume after an update. Restarting forgets them, and an expired arm is swept on the next turn.
- `turnBySession` — the link between a sentence and its round only matters within a conversation.
- `lastRequestFields` — diagnostics for the current process.

This is the same trade the decision cache rejects in the other direction: durable facts about the house are worth a file, in-flight conversational state is not.

## Failure behaviour

Everything in `src/history.ts` and `src/decidecache.ts` fails closed:

- a corrupt file is treated as absent;
- a version mismatch is treated as absent;
- an unwritable directory is ignored;
- nothing throws into a request path.

The cost of losing history is an empty dashboard; the cost of throwing would be a broken turn. The code chooses the empty dashboard every time.
