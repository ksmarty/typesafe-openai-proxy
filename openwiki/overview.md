---
type: "Explanation"
title: "Typesafe routing proxy"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-d62dc78a6b92f64549736a16
    resource: repo://src/pipeline.ts
  - id: openwiki-source-9da6594296f4b30b9cdfad4c
    resource: repo://src/router.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Typesafe routing proxy

This repository is a small OpenAI-compatible server that sits between `hass_local_openai_llm` and your inference server. It gives Home Assistant one calibrated decision per request instead of a full model turn, and forwards everything it is not confident about untouched.

The proxy never talks to Home Assistant and never executes anything. `hass_local_openai_llm` remains the conversation agent, Home Assistant still builds the Assist tool schemas, and its intent engine still runs the chosen intent. The proxy only chooses *which* answer a request gets.

## The shape

```
Home Assistant ──► hass_local_openai_llm ──► typesafe routing proxy ──► your model server
   (Assist)          (conversation agent)     (decides or forwards)
```

Two paths leave `runPipeline` at `src/pipeline.ts:274`:

1. **The fast path** answers locally: a `tool_call` built from the tools the request offered, a state answer, a clarification, a confirmation question, or the configured silence. It costs one decision call or none at all.
2. **The forward path** passes the request verbatim to the configured upstream and streams its answer back. It behaves exactly as if the proxy were not there — that is the safety story, not a fallback.

The gate between them is `route()` in `src/router.ts:143`. An answer becomes an action only when it clears its own confidence threshold *and* the margin over the runner-up is wide enough; everything else falls through. A typed answer that cannot be gated is never turned into a guess.

## What the fast path can do

The readers run before the decision model, in this order: time, weather, state question, reminders, music, media, timers, chatter. A sentence one of them recognises needs no model call at all. The rest reach the decision backend — `systemone`, `heuristic`, or `none` — and are routed as tool, calls, clarify, confirm, ignore, text or forward.

Requests that bring no tool schemas are forwarded without deciding, because every answer would otherwise be "that intent is not offered", which reads as a proxy fault when it is really the caller sending nothing.

## Reading map

Start here, then follow the path a request takes.

- **[Quickstart](quickstart.md)** — run it, point Home Assistant at it, make one decision.
- **[Request lifecycle](architecture/request-lifecycle.md)** — from `POST /v1/chat/completions` to a written response, including pass-through and speech rounds.
- **[Fast paths](architecture/fast-paths.md)** — the readers that answer without a model call.
- **[Decision and gates](architecture/decision-and-gates.md)** — backends, confidence thresholds, margin, cache, confirmation.
- **[Catalog and targeting](architecture/catalog-and-targeting.md)** — where entities come from and how a sentence is matched to one.
- **[Speech and confirmation](architecture/speech-and-confirmation.md)** — what is said after a tool call, and the yes/no round for risky actions.
- **[State and persistence](architecture/state-and-persistence.md)** — the trace, the request log, and what survives a restart.
- **[Dashboard](dashboard.md)** — the Monitor and Settings views.
- **[Configuration and deployment](configuration-and-deployment.md)** — precedence, endpoints, container and workflows.

## Design commitments

These are decisions, not accidents, and they explain most of the code:

- **Forwarding is never worse than absence.** A failed gate, an unreachable decision model, an unknown sentence and an empty tool list all end in a verbatim forward.
- **No executor.** The proxy builds a call and returns it; Home Assistant's intent engine runs it. The proxy cannot turn on a light by itself.
- **One decision, not a conversation.** History is a small slice of recent turns used for context ("make it brighter"), never a growing transcript.
- **Secrets stay out of state.** Configuration is masked on read and on export, and persisted history holds decisions, not credentials.
- **The dashboard is a report, not a requirement.** Every endpoint it uses is optional; the proxy works headless.

## Where the time goes

A fast-path decision is dominated by the decision call, typically a few hundred milliseconds; a forwarded request costs whatever the upstream costs. The trace records `decisionMs`, `upstreamMs` and `totalMs` per row, and the Monitor's average tile is computed from the same entries, so the dashboard shows the split rather than an impression of it.

## Where to look next

- [Quickstart](quickstart.md) — the shortest path to a working request.
- [Request lifecycle](architecture/request-lifecycle.md) — the one page to read if you are changing behaviour.
