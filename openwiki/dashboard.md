---
type: "Reference"
title: "Dashboard"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-d9b845a7425932c3767a237e
    resource: repo://src/server.ts
  - id: openwiki-source-e3b29c26fb010414f143b8ae
    resource: repo://web/api.ts
  - id: openwiki-source-73034ab90751057c29fd7bb9
    resource: repo://web/App.tsx
  - id: openwiki-source-e169cd12176c500a0be83f32
    resource: repo://web/fields.tsx
  - id: openwiki-source-a9d14d1b1160357f1466fad5
    resource: repo://web/MonitorView.tsx
  - id: openwiki-source-114b469fda4141636824d74f
    resource: repo://web/SettingsView.tsx
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Dashboard

The dashboard is a React 19 + MUI application under `web/`, bundled by `scripts/build-ui.mjs` into `public/app.js`. It has two views, Monitor and Settings, served from the same origin as the proxy API at `/api`.

Both views are thin: they own no decision logic. They read the status payload, the settings schema and the trace, and they post a draft configuration back. Everything they show comes from a server route described in [Configuration and deployment](configuration-and-deployment.md).

## App shell

`App` at `web/App.tsx:48-200` owns three pieces of state: the current view, the status payload, and whether advanced settings are shown.

- The view is `monitor` or `settings`, with `initialView()` at `web/App.tsx:25-33` reading `window.location.hash`. A hash of `settings/<group>` is a deep link into one settings section, which the settings form picks up itself.
- `refresh()` calls `getStatus()` and polls every 4 s. A failed call sets `failure`, which turns the header dot red and shows a banner rather than blanking the tree.
- The header carries the health dot, the version chip (so a stale image is obvious), backend and catalog chips, and uptime. Tabs switch views.
- Hash writes are wrapped in `try/catch` at `web/App.tsx:84-96` and `web/SettingsView.tsx:169-180`, because a sandboxed or cross-origin iframe throws `SecurityError` on `history.replaceState`. Hash routing is a convenience; the view works without it.

## The API client

`web/api.ts` is the only module that talks HTTP.

- `mountPath()` at `web/api.ts:97-101` resolves calls against the page's own directory, and `endpointAt` joins the two. `call()` retries once at the origin root when a prefixed URL answers 404, so the dashboard works behind a reverse proxy that mounts it under a prefix without proxying that prefix.
- Non-2xx answers become `Error(body.error)`, and an unparsable body becomes `{ error: text.slice(0, 300) }`, so the UI always has a sentence to show.
- The typed helpers are `getStatus`, `getSchema`, `getConfig`, `getTrace`, `getRequests`, `clearTrace`, `resetBreaker`, `refreshCatalog`, `checkExposure`, `probe`, `saveConfig`, `resetConfig`, `testHa`, `testDecision`, `testUpstream`.
- `downloadDebugBundle()` at `web/api.ts:184-199` fetches `/api/debug/bundle` as a blob and clicks a temporary anchor, naming the file `typesafe-proxy-debug-<timestamp>.json`.

## Settings: driven by the schema

The settings page renders whatever `settingsGroups()` in `src/schema.ts` describes; no field is hand-written. `FieldList` in `web/fields.tsx` dispatches on `SettingsField.type` at `web/fields.tsx:608-683`: `slider`, `templates`, `rules`, `checkbox`, `select`, `number`, `password`, and text as the fallback.

`SettingsView` at `web/SettingsView.tsx:90-577` keeps `saved` and `draft` copies of the configuration and compares them with `JSON.stringify` to drive the `unsaved` chip. A save posts the whole draft, and the response replaces both copies — the server may have clamped a number or restored a masked password.

Other behaviour that matters:

- `selectGroup(id)` writes `#settings/<id>` and survives a reload; the section list is a `List` on wide screens and a `select` on narrow ones (`display: { xs: 'block', md: 'none' }`).
- The `advanced` toggle lives in the sidebar on wide screens and in the app bar on small ones; `visibleFields` filters `field.advanced`, and a caption reports how many are hidden.
- `save()` reuses the same call from the catalog buttons: `refreshCatalogNow` and `checkExposureNow` save a dirty draft first, because the server would otherwise read the previous token.
- Resetting is per group by default (`resetConfig(group?.id)`), never the whole file: a token should not vanish because one section looked wrong.
- Environment overrides are listed in an `Alert`, since they beat anything saved here.
- Test-connection buttons exist only for `decision`, `catalog` and `upstream`; `describeTest()` turns the result into one line of entities, models, status and timing.

## Monitor: one row per turn

The monitor view at `web/MonitorView.tsx:558-805` has a probe card, a stats card, and the trace list.

The probe card posts a sentence to `/api/probe`, which runs the decision path without executing anything. `ProbeResult` shows the plan, gates and trace entry; `SAMPLES` are one-click examples. `CallPanel` names the forwarding case explicitly — "No call — forwarded to your model server" — so an empty result is not mistaken for a failure.

The stats card renders `status.stats` as `StatTile`s: requests, tool calls, forwarded, passed through, not addressed, clarified, confirmed, errors, and average decision time. A circuit-breaker alert appears when the breaker is open, with a reset button calling `/api/breaker/reset`.

`loadTrace()` polls `getTrace(50)` and `getRequests(20)` every 2.5 s while `live` is on.

### Nesting speech back under its turn

Home Assistant makes two requests for a command that gets spoken back: the decision, then a follow-up carrying the tool result. `turns` at `web/MonitorView.tsx:608-627` groups the second under the first.

It builds an id map of the entries, collects every entry with an `answersTurn` pointing at a live turn, sorts each group oldest-first, and returns only the top-level turns with their replies attached. An `answersTurn` pointing at an entry no longer in the trace is left visible rather than hidden, so a trimmed history cannot swallow a row.

### What a row shows

`TraceRow` at `web/MonitorView.tsx:278-553` is an `Accordion`. The summary holds the route chip, the HTTP chip, call counts, the decision time and the age — and deliberately not the sentence.

The body, in order: the full utterance, the reason, a chip row for category/action/target/backend/model/status/timings/tokens/exposure/total, the tool or calls as `CodeBlock`s, the offered tools, the forwarded answer, clarification and error alerts, nested speech rounds, gates, and the tool result.

Three of those are recent additions and worth naming:

- **The forwarded answer.** `entry.upstreamReply` is shown under "What the model server answered", and `entry.upstreamCalls` under "Tool the model used" or "Tools the model used (N)". Both come from the stream that `forwardUpstream` tees while it passes the bytes through, so the card documents what the outside model actually said and did.
- **The offered tools.** `entry.toolsOffered` could be forty names. Instead of one horizontal line, the page renders wrapping `Chip`s, twelve at a time (`TOOL_PREVIEW`), with a `Show N more` / `Show fewer` toggle. A long tool name stays readable because each chip wraps its own label.
- **The nested round.** A speech round shows a chip naming who spoke — `spoken by the model` when the reply was itself forwarded — its round-trip time when known, and its own `upstreamCalls` when the model used tools to answer.

## Mobile layout decisions

The narrow layout is not a scaled-down desktop; three specific problems were fixed on it.

1. **The sentence moved into the body.** It used to be the accordion header, ellipsised to a few words on a phone, which told the reader nothing. The header now carries only chips, and the sentence wraps in the body with `overflowWrap: 'anywhere'`.
2. **The summary still cannot overflow.** `AccordionSummary` content keeps `minWidth: 0` and `overflow: 'hidden'`, because MUI's flex item defaults to `min-width: auto` and a long child would otherwise widen the card.
3. **Chips wrap, and counts drop.** Chips in the detail rows use `useFlexGap` with `flexWrap: 'wrap'`; call counts and timings hide below `sm`, and the age hides below `md`.

## The debug bundle

`downloadDebugBundle()` produces the file a bug report needs. The server route at `src/server.ts:261-313` assembles `meta`, `environment()`, the masked `publicConfig()`, the config path, `statusPayload()`, a catalog summary, the recent trace and request log, and a notes array. It is served with `content-disposition: attachment` and `cache-control: no-store`.

`environment()` shows variable names always, replaces secret values with "set (value withheld)", and shows base URLs as they are — the distinction between "not set" and "set to something wrong" is usually the whole question.

The route itself is omitted from the request log at `src/server.ts:565`, so downloading the bundle does not make the log it contains longer.

## Where to look next

- [State and persistence](architecture/state-and-persistence.md) — where the trace and stats in these views are kept.
- [Configuration and deployment](configuration-and-deployment.md) — the endpoints this page calls and the file it edits.
- [Speech and confirmation](architecture/speech-and-confirmation.md) — why a turn has a second round to nest.
