---
type: "Reference"
title: "Decision backend and routing gates"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
---

# Decision backend and routing gates

Every request the proxy considers for the fast path goes through two layers. A **decision backend** answers a fixed set of questions about the sentence ("is it a command, what kind of device, how wide is the scope?"), and the **router** turns probabilistic answers into a plan — call a tool, ask a clarifying question, ask for confirmation, or forward the sentence untouched. The router is deliberately conservative: a gate that is not clearly passed means the request goes upstream.

See [Request lifecycle](request-lifecycle.md) for where this sits in a turn, and [State and persistence](state-and-persistence.md) for the cache files.

## Choosing a backend

`config.decision.backend` is `'none' | 'systemone' | 'heuristic'` (`src/config.ts:7`), settable through `DECISION_BACKEND` and the dashboard.

`decisionReady` in `src/pipeline.ts:250-270` is the gate:

- `'none'` → not ready, reason `no decision backend configured`.
- `'systemone'` without `baseUrl` (`:256`) or without `model` (`:259`) → not ready.
- `'heuristic'` → ready.

A turn is only decided when it asks for the fast path: either `decision.autoStart` or the request names `ROUTER_MODEL` (`typesafe-router`), and the backend is not `'none'` (and, for systemone, a base URL exists). Otherwise the request is passed through with the reason `pass-through: no decision backend configured`.

## The System One call

`POST ${decisionBase(baseUrl)}/v1/systemone`, with `SYSTEM_ONE_PATH = '/v1/systemone'` at `src/systemone.ts:24`. There is no such route on the proxy itself — it is an outbound call to the decision model. `decisionBase` at `src/systemone.ts:40` strips a pasted `/v1/systemone`, `/systemone`, `/v1` or trailing slashes, so any of those forms works in the setting.

Request body:

- `model: config.decision.model`
- `state: buildState(input)` (see [Catalog and targeting](catalog-and-targeting.md))
- `questions` from `buildQuestions`
- `authorization: Bearer <apiKey>` only when a key is configured.

`normaliseAnswer` at `src/systemone.ts:123` accepts three response shapes — `noul`, `choice` + `probabilities` + `confidence`, or `score` + `legend` — so a provider that returns logits and one that returns a chosen label both work.

### Retries, timeout and breaker

`decide` at `src/systemone.ts:170`:

- `MAX_RETRIES = 3`, `BACKOFF_MS = [250, 750, 2000]` (`:50-51`), per-attempt timeout `decision.timeoutMs` (default 8000).
- A status below 500 other than 408 or 429 is **not** retried: it increments the breaker and throws `DecisionUnavailable` immediately (`:206-216`). A 404 message adds a hint that the base URL should be the root serving `/v1/systemone`.
- 5xx, 408 and 429 are retried; exhaustion throws `DecisionUnavailable('decision model unreachable: …')` (`:257-262`).
- `BREAKER_THRESHOLD = 3`, `BREAKER_COOLDOWN_MS = 30_000` (`:53-54`). While open, `decide` throws `decision model circuit breaker is open` (`:176`) without a request. A success resets the failure count. `breakerState()` (`:251`) and `resetBreaker()` (`:258`) expose it.
- `warmDecision` (`:271`) and `listModels` (`:282`) pre-warm DNS/TLS and detect a Jev-style endpoint.

### When the decision model fails

`DecisionUnavailable` is caught in `src/pipeline.ts:1235`. The proxy `stats.errors += 1`, then re-runs the same turn with `decision: { ...active.decision, backend: 'heuristic' }`. The local result is kept only if its plan kind is `tool`, `calls`, `clarify`, `confirm` or `ignore`, and the trace reason reads `decision unavailable (…) — read locally instead`.

Otherwise it stores a `TraceEntry {route:'forward', reason:'decision unavailable: …', gates:[]}` and forwards the sentence upstream. A missing base URL takes the same route (`DecisionUnavailable('no decision base URL configured')` at `:174`).

## The heuristic backend

`heuristicDecide(input)` at `src/heuristic.ts:185` emits the same answer types, so the router and gates run identically. It is a keyword matcher, not a calibrated model:

- Scores pass through `softmax` with `TEMPERATURE = 3.5` (`:25-27`) and `choose()` at `:36`; `noul()` clamps to 0..1 at `:48`.
- It answers only questions present in `input.questions` (`questionHas` at `:392`) and ignores conversation history entirely.
- It reads category from weighted `COMMAND_WORDS`/`QUERY_WORDS`/`INFORMATION_WORDS`/`CANCEL_WORDS` (`:150-162`, `:207-218`), compound from verb count and conjunctions (`:221`), scope from "all/every", floor words, area matches and named entities (`:249-264`), here-relative (`:267`), target area/entity/domain (`:272`, `:283`, `:291` via `scoreEntity` at `:164`), query kind (`:301`), risky patterns (`:314`), change direction and magnitude (`:320-344`), per-domain actions only where criteria exist (`:347-364`), value picks (`:367`), and free-text `listItem`/`mediaQuery` at confidence 1 (`:384-388`).
- It returns `{model:'heuristic', inputTokens:0, outputTokens:0, latencyMs, backend:'heuristic'}` with no raw answer.

Limits that matter in practice: no history, no numeric reasoning beyond the extraction, and uncalibrated confidence. An unclear sentence lands near-uniform and fails the same gates a real model would, so it is forwarded — which is the point of using it as a fallback rather than as a decision maker.

## Gates

`DecisionThresholds` is defined at `src/config.ts:45-64`, defaults in `DEFAULT_THRESHOLDS` at `src/config.ts:353-374`, help text in `THRESHOLD_HELP` at `src/schema.ts:57-93`, and the sliders are `routing.thresholds.<key>` from 0 to 1 in steps of 0.01 (`src/schema.ts:95`).

| key | default | meaning |
| --- | --- | --- |
| `minMargin` | 0.15 | the top answer must beat the runner-up by this much, for every choice gate |
| `actTerse` | 0.75 | a bare command ("lights on") |
| `actExplicit` | 0.5 | a command that names a device, room or domain |
| `clarifyFloor` | 0.3 | below this, do not even ask — forward |
| `categoryQuery` | 0.45 | it is a question |
| `categoryInformation` | 0.55 | it wants prose |
| `categoryCancel` | 0.6 | it cancels the last action |
| `categoryUnclear` | 0.55 | it is not readable |
| `queryKind` | 0.5 | which kind of question |
| `domain` | 0.5 | kind of device |
| `entity` | 0.6 | one specific entity |
| `area` | 0.55 | room |
| `scope` | 0.55 | how wide (one / room / house) |
| `scopeWholeHouse` | 0.6 | stricter bar for "turn everything off" |
| `actionProbability` | 0.55 | what should happen to the target |
| `noulRisky` | 0.5 | how strongly risky |
| `noulCompound` | 0.7 | how strongly compound (out of scope) |
| `noulHereRelative` | 0.6 | how strongly "here" |
| `riskyAction` | 0.85 | declared and described, but no gate reads it |
| `riskyTarget` | 0.75 | same: documented only |

`gateChoice(gates, question, answer, threshold, minMargin)` at `src/router.ts:71` returns `{passed:false}` with no answer; otherwise `probability = answer.probabilities[answer.choice] ?? answer.confidence` and `passed = probability >= threshold && margin >= minMargin`, recording all four values. `marginOf` at `src/systemone.ts:325` is the rounded difference between the top two sorted probabilities — 1 for a single-option answered question, 0 for none. `gateNoul` at `src/router.ts:96` tests `value >= threshold` and is used for `Q.compound` and `Q.hereRelative`.

Two mechanisms soften a gate without ignoring it:

- **Explicit naming changes the threshold, not the gate.** `explicit` at `src/router.ts:156-166` is true when a named entity, area or domain clears its own gate; it then swaps `actTerse` (0.75) for `actExplicit` (0.5) at `:168-180`.
- **Lexical rescue overrides a failed scope gate.** At `src/router.ts:523-548`, if the scope gate fails but `uniqueEntityMention`, `uniqueAreaMention` or `uniqueFloorMention` finds exactly one name, scope is forced to `single`, `area` or `floor` and the gate note becomes `device|room|floor "<name>" named in the sentence`. The comment gives the rationale: "Turn on the kitchen lights" is the commonest phrasing, and a model unsure of width must not veto a named room.

Softer fallbacks follow after the gates: entity fallback at `:636-650`, room fallback at `:665-690`, and `entityFrom` at `:898`, which re-checks `probability >= thresholds.entity && marginOf >= thresholds.minMargin` at `:909`.

## From answers to a plan

`route(ctx)` at `src/router.ts:143` checks in this order:

1. No category answer → forward `the decision model did not answer the category question` (`:149`).
2. `Q.compound >= noulCompound` → forward `compound request` (`:152`).
3. Explicit naming selects the command threshold (`:156-180`).
4. `gateChoice(Q.category …)` fails → forward `category "…" is not confident enough` (`:182`).
5. `information` → forward `informational request` (`:188`); `unclear` → forward `unclear request` (`:191`).
6. `cancel` → a tool plan for `INTENTS.nevermind` when that intent is offered (`:212`), otherwise a silent text plan (`:194-204`).
7. `query` → `planQuery` (`:218`); otherwise `planCommand` (`:511`).

`planQuery` gates `Q.queryKind` at `:222`, then:

- `time_or_date` → `getCurrentDate`, or a local text plan `spokenTime(clockNow(...))` (`:247`);
- `needs_prose` / `not_a_query` → forward `question needs prose (…)` (`:268`);
- `temperature` → `climateGetTemperature`, else forward;
- `count` → `getState`, or a local `answerCount(...)` text plan (`:304`);
- device state → `entityFrom` plus the target entity gate (`:346`), then `getState` or a local `answerStateQuestion(...)` text plan (`:352`).

`planCommand` runs the scope gate (`scopeWholeHouse` when the answer is `whole_house`, `:518`), lexical rescue (`:523`), `planMulti` when `mentionedTargets` finds at least two targets (`:530`), a `not_a_target` forward (`:550`), floor corrections (`:553-566`), then the `single` path: entity gate, clarify with up to three candidates when confidence is at least `clarifyFloor` (`:592-611`) or from `tiedNameCandidates` (`:858`, `:620-634`), area gate or `defaultArea` (`:665`), domain gate (`:693`), action gate (`:705`), spec checks (`:722`), value resolution (`:740-785`), `buildToolCall`, and finally the risky-action confirmation (`:824-840`).

`planMulti` at `src/router.ts:388` emits `MultiCallPlan {kind:'calls'}` at `:481`.

The overall ordering is therefore: **forward** on any gate miss or out-of-scope answer → **ignore** only from the addressee/chatter judge (`src/pipeline.ts:309,635,819`) → **text** for a local answer or silence → **clarify** → **confirm** → **tool** or **calls**.

### Refusing versus forwarding

Every `'error' in call` from `buildToolCall` becomes `forward(call.error)` at `src/router.ts:806`: a routing problem is never answered locally, it is handed upstream. Genuine HTTP refusals are traced separately — 401 for a wrong API key and 400 for a non-JSON body (`test/refusal.test.ts:44,61`).

### Risky actions

`isRisky(action, domain, target, riskyAnswer, thresholds)` at `src/router.ts:130-141` is true when the action is in `RISKY_ACTIONS`, the domain is in `RISKY_DOMAINS` and the target is open or unlocked, the device class is risky, or `Q.risky >= noulRisky`.

With `config.decision.alwaysConfirmRisky`, the plan becomes `{kind:'confirm', pending: plan}` reusing `CONFIRM_INFINITIVES` (`:119`). `pendingConfirmations` holds it for `speech.confirmSeconds` (default 90 s; `src/pipeline.ts:1291-1297`, `src/state.ts:27-34`). One yes/no is armed per conversation, and a yes replays the pending plan.

Note the discrepancy worth knowing before tuning: `riskyAction` and `riskyTarget` appear in the settings schema and help text but no gate reads them. Confirmation rests on `noulRisky` and the fixed action/domain/device-class sets.

## Decision cache

`decisionKey` at `src/decidecache.ts:108` hashes:

```
sha1(JSON.stringify([model, baseUrl, utterance.trim().toLowerCase(), language ?? '',
  spokenFromArea ?? '', homeSignature,
  Object.entries(questions).map(([k, q]) => [k, q.type, q.instructions, q.criteria])]))
```

`homeSignature` is the hash of sorted area ids and sorted entity ids from `src/catalog.ts:928` — **no state**. Adding, removing or unexposing an entity misses the cache; a catalog refresh or a lamp changing brightness hits it.

Questions are never cached: `isQuestion` at `src/decidecache.ts:104` skips them at the call site (`src/pipeline.ts:685-693`). There is no TTL. `MAX_ENTRIES = 500` (`:32`) with LRU eviction in `rememberDecision` (`:135`). Persistence is `decision-cache.json` (`:24`) under the data directory, atomic `.tmp` + `renameSync` (`:90`), debounced 2 s (`:81`), `version: 1` (`loadDecisionCache` at `:63`), read at boot by `configureDecisionCache` (`:54`). Settings: `decision.cache` and `decision.persistCache` (`src/config.ts:75-108`); use site `src/pipeline.ts:696,719`.

## Conversation history

`decision.historyTurns` (default 2, slider 0..10) is assembled by `historyOf(messages, turns)` at `src/pipeline.ts:158`: user and assistant messages with non-empty text, assistant messages carrying `tool_calls` skipped, then `.slice(-turns * 2)` — one turn is one user line plus one assistant line. `buildState` trims again to `historyTurns * 2` (`src/systemone.ts:113-117`) and sends it as `conversation`.

Do not confuse this with the dashboard history. `src/history.ts` persists the trace to `history.json` (1000 entries, 50 requests); `src/state.ts` keeps `turnBySession` (keyed by sentence, 12 per session, 120 s TTL) and `issuedCalls` in memory. Those feed the UI and follow-up speech, not the model.

## What pins this behaviour

- `test/decision.test.ts` — `decisionBase` collapses root, `/v1`, full endpoint and padded forms; `maskSecret` keeps 12 characters; a masked echo keeps the stored key while a new key replaces it.
- `test/decision-state.test.ts` — a stub `/v1/systemone` decides array-shaped content and its utterance; the decision state never contains the system prompt; a request with nothing to read is reported rather than silently forwarded.
- `test/floor.test.ts` — floor ordering, upstairs/downstairs, a floor named outright versus a room, ambiguous levels, a floor the intent cannot take being a refusal rather than a room guess, and "all the lights upstairs" not becoming the whole house.
- `test/refusal.test.ts` — 401 and 400 are traced with reasons and the build named; a correct key is not refused.
- `test/decidecache.test.ts` — the same sentence makes one model call; a question is never cached; a different sentence misses; the cache survives a restart from the data directory; a changed house changes the key; persistence off writes nothing.
- `test/schema.test.ts` — every config leaf described and every schema field present, thresholds are 0..1 sliders clamped on save, masked/empty secrets, type coercion, save/load round trip, template normalisation, and dashboard helpers matching the server.
