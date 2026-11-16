---
type: "Reference"
title: "Request lifecycle"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-d62dc78a6b92f64549736a16
    resource: repo://src/pipeline.ts
  - id: openwiki-source-837e20237d7b757c491d238f
    resource: repo://src/respond.ts
  - id: openwiki-source-d9b845a7425932c3767a237e
    resource: repo://src/server.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Request lifecycle

One request to `POST /v1/chat/completions` passes through a fixed sequence of gates. Most sentences stop early: at a fast path, at an ignore, or at a refusal. Only the ones that survive reach a decision model, and anything the proxy will not decide is forwarded to the model server behind it, byte for byte.

This page follows a single request end to end. [Decision and gates](decision-and-gates.md) explains how a decision becomes a route; [Fast paths](fast-paths.md) explains the local readers; [State and persistence](state-and-persistence.md) covers what survives a restart.

## Ingress

`createApp` at `src/server.ts:547-653` mounts everything under an optional `/preview/<id>` prefix, stripped at `src/server.ts:553`. A `response.on('finish')` hook at `src/server.ts:558-567` logs every request and calls `rememberRequest({at,method,path,status,ms})` for `/v1/` paths at `src/server.ts:562-564`, which is what the dashboard's request list shows.

Auth sits in the `/v1/` group at `src/server.ts:582`, using `authorised(request, key)` at `src/server.ts:105-110`: an empty configured key allows everyone, otherwise the `Bearer` prefix is stripped and compared. A failure calls `recordRefusal(401, …)` at `src/server.ts:218-230`, which writes a trace row with `route: 'refused'` so a rejected call is still visible, and answers `401` with `{"error":{"message":"invalid api key","type":"invalid_request_error"}}`.

`POST /v1/chat/completions` is registered at `src/server.ts:601-622`:

1. `raw = await body(request)` at `:602` reads the body with an 8 MB cap (`src/server.ts:75-85`).
2. `JSON.parse` at `:604-610`; malformed JSON becomes `recordRefusal(400, …)`.
3. `rememberRequestFields(Object.keys(parsed))` at `:611` keeps the top-level field names for diagnostics.
4. `await handleChatCompletions(parsed, raw, response)` at `:613`.

The catch at `src/server.ts:614-620` records a refusal and sends a `500` only if `!response.headersSent` — once the upstream bytes have started, an error can no longer become an HTTP status.

### Model-name opt-in

The proxy only decides when asked. `src/pipeline.ts:931`:

```ts
wanted = (request.model ?? '').trim() === ROUTER_MODEL || active.decision.autoStart
canDecide = routing.enabled && backend !== 'none' && (backend !== 'systemone' || baseUrl)
```

`ROUTER_MODEL` is the sentinel model name; `src/token.ts:24-30` `generateToken` produces `sk-proxy-` plus 32 random bytes, base64url, browser-safe because it uses `crypto.getRandomValues`.

## handleChatCompletions

`handleChatCompletions` at `src/pipeline.ts:916-1317` is the whole turn.

`active = override ?? loadConfig()` at `:923`. The bypass branch at `:937-992` covers the case where the proxy was not asked to decide:

- `utterance = lastUserMessage(...) ?? ''` at `:937` (helper at `src/pipeline.ts:100-108`).
- The reason string names the cause, for example `pass-through: model "X" is not "typesafe-router" and autoStart is off` at `:939-943`.
- When `listening.enabled && listening.local`, the local addressee gate at `:948-972` may answer with the silence text instead of forwarding.
- Otherwise `stats.requests++` and `stats.bypassed++` at `:974-975`, a forward row is remembered at `:986`, `recordTurn` at `:988` remembers the turn (so a later speech round can nest under it), then `forwardUpstream` at `:989` and `recordForwardedAnswer` at `:990`.

The `options()` closure at `:994-998` carries `{model, stream, id}`; `chatcmpl-` ids come from `src/respond.ts:21-23`. The session key at `src/pipeline.ts:1002` uses `sessionKey` at `:117-122` — `conversation_id` when present, otherwise a sha1 of device, the first 400 characters of the system prompt and the model. Every trace row gets `uid('trace')`.

### Tool and speech rounds

Home Assistant replays its whole conversation log on every call, so only *trailing* `role: 'tool'` messages count as results for this turn (`src/pipeline.ts:1011-1018`). `described` at `:1029-1043` resolves each result through `issuedCalls` by `tool_call_id`, falling back to `descriptorFromAnnouncement` or `parseToolArguments`.

Speech after a tool call is produced by `speechForLastTool` (`src/respond.ts:459-465`) into `speechFor` at `src/respond.ts:388` onward, which reads the calls the proxy itself issued — a result the proxy never issued says nothing. `owner = ownerFromCalls ?? previousTurn?.id` at `src/pipeline.ts:1055-1064` links the spoken answer to the row that caused it; the joined sentence is written as a `route: 'text'` row with `backend: 'speech'` and `said` at `:1162-1173`, then delivered by `respondText(text || silence)` at `:1175`.

Confirmation is handled before all of that, at `:1200-1228`: `pendingConfirmations.get(key)`, `YES` at `src/respond.ts:455` re-emits the pending call with `backend: 'confirmation'` and the reason `confirmed by the speaker (<original>)`, `NO` at `src/respond.ts:456` answers `Okay, cancelled.`

## runPipeline

`runPipeline` at `src/pipeline.ts:274-897` decides what the turn is.

| Step | Where |
| --- | --- |
| `startedAt` | `src/pipeline.ts:280` |
| `fastPathStatus` | `:283`, defined at `:251-271` |
| `inventoryFor(request.tools)` | `:284` |
| device id and `entry.device` | `:289-293` |
| no-tools pass-through | `:297-335` |
| `getCatalog` (2 s max age for question shapes) | `:336-346` |
| time question → text plan | `:350-375` |
| weather | `:381-420` |
| `directStatePlan` | `:423-449` |
| `reminderPlan` | `:457-500` |
| `musicPlan` | `:566-579` |
| `mediaPlan` | `:586-596` |
| `timerPlan` | `:603-615` |
| `looksLikeChatter` | `:622-666` |
| `decideFor` | `:674-732` |
| first decision | `:734` |
| compound clauses | `:744-781` |
| addressee verdict for unresolved plans | `:793-826` |
| entry build | `:828-855` |
| not ready → `backend: 'off'` | `:857-860` |
| stats switch | `:872-892` |
| `noteTrace` and `recordTurn` | `:893-894` |

`localCall` at `:519-563` is the shared helper the local readers use to record a call. `decideFor` at `:674-732` builds the decision cache key at `:684-695` and calls `decide` when `backend === 'systemone'` with a base URL, otherwise `heuristicDecide`. Compound sentences are split by `splitClauses` at `:744-781` and only executed when every clause wins; see [Fast paths](fast-paths.md).

A plan that survives becomes a route in the switch at `src/pipeline.ts:1277-1316`:

- `tool` and `calls` → `emitToolCall` at `:1281`, defined at `:1325-1347`. Each call gets `uid('call')` and an `issuedCalls` entry `{action,targets,domain,tool,args,turnId,at}`; `respondToolCalls` at `src/respond.ts:86-124` writes either a JSON `tool_calls` response or SSE deltas.
- `clarify` and `text` → `respondText(plan.text)`; `ignore` → `respondText(plan.silence)`.
- `confirm` → arms `pendingConfirmations` with `expiresAt = Date.now() + speech.confirmSeconds * 1000` at `:1292-1296`.
- `forward` and the default → `forwardUpstream` inside `try/finally` at `:1303-1313`, which always updates `upstreamMs` and `totalMs` and then records the answer.

## Forwarding

`forwardUpstream` at `src/respond.ts:166-259` is the only path out to the model server.

- No `upstream.baseUrl` → `stats.errors++` and a spoken hint that the server needs configuring (`:180-189`).
- The URL is `${baseUrl}/chat/completions` at `:191`.
- The body is the client's own body via `bodyForUpstream` at `src/respond.ts:132-143`, forwarded verbatim unless `model === ROUTER_MODEL`, which is swapped for `upstream.model`.
- Headers at `:199-203`: the original content type, `accept: text/event-stream` when streaming, and `authorization: Bearer <key>` when a key exists. The fetch is wrapped by `fetchWithTimeout` at `src/util.ts:41-53`.
- A non-OK answer at `:209-225` speaks `The inference server returned <status>. …` and returns `{status, error}`.
- On success, `response.writeHead(upstream.status, {'content-type': contentType, 'cache-control': 'no-store'})` at `:230-233`, then the reader loop at `:237-247` writes each chunk to the client immediately *and* copies it into `captured` while `capturedBytes < CAPTURE_LIMIT` (512 KB, `:163`). This tee is why a forwarded answer can be shown in the dashboard without delaying the client by a byte.
- `response.end()` at `:248`, then parsing at `:251` with `parseSseAnswer` (`:287`) or `parseJsonAnswer` (`:262`), clipped to `REPLY_LIMIT` 4000 (`:161`). The return value is a `ForwardedAnswer {text, calls, status, model, error}` (`:152-158`).
- A listener failure at `:253-258` speaks `The inference server is unreachable: …`.

`recordForwardedAnswer` at `src/pipeline.ts:906-914` patches `upstreamReply`, `upstreamCalls`, `upstreamStatus` and `error` onto the trace row that started the forward.

### Forwarded speech

When `speech.afterTool === 'upstream'` and no rule took over at `src/pipeline.ts:1065-1083`, the proxy writes a synthetic `route: 'forward'` row with `answersTurn: owner` and then forwards — the round would otherwise have no row for the answer to land on. When there is nothing speakable but a question is still owed, the branch at `:1130-1154` creates a `backend: 'speech'` forward row for the same reason.

## Failure paths

`DecisionUnavailable` (`src/systemone.ts:58`) is caught at `src/pipeline.ts:1234-1275`. The proxy increments `stats.errors`, retries with `backend: 'heuristic'`, and accepts only `tool`, `calls`, `clarify`, `confirm` or `ignore` at `:1245-1251`. A usable local read gets the reason `decision unavailable (<msg>) — read locally instead` at `:1252-1255`; otherwise the turn becomes `route: 'forward'` at `:1256-1270`.

Any other error increments `stats.errors` and rethrows, so the route's `500` handler answers — provided no headers have gone out yet.

## Invariants

- The response is written exactly once per request: every branch ends in `respondText`, `respondToolCalls` or `forwardUpstream`, then returns.
- Error text is delivered as a spoken completion, not an HTTP error, once headers are out.
- `stats` counts each turn once, on the path it took.
- Trace rows are append-only through `rememberTrace`; later corrections go through `updateTrace`.
- A tool round and its speech round stay linked by `issuedCalls.turnId` → `answersTurn`.
- Nothing is decided unless the request opted in at `src/pipeline.ts:931`.
