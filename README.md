# Typesafe routing proxy

A small OpenAI-compatible server that sits in front of
[`hass_local_openai_llm`](https://github.com/skye-harris/hass_local_openai_llm) and gives it the
thing [`typesafe-conversation-agent`](https://github.com/the-sof/home-assistant-typesafe-conversation-agent)
is good at: **one calibrated decision per request instead of a full model turn.**

`hass_local_openai_llm` keeps doing what it does — it is still your Home Assistant conversation
agent, still holds the Assist tools, still streams. The proxy simply becomes the server URL it
points at. Each request is decided locally first:

| outcome | what happens | cost |
| --- | --- | --- |
| clear single command | proxy returns a `tool_call` for Home Assistant's own intent | one decision call, ~10–250 ms |
| clear state question | proxy returns `HassGetState` / `HassClimateGetTemperature` | one decision call |
| ambiguous target | proxy asks which device you meant, in the tool-call-free reply | one decision call |
| risky action (`unlock`, `open`, `disarm`) | proxy asks "do you want me to…" and waits | one decision call |
| anything else | request is forwarded **verbatim** to your inference server | unchanged from today |

That last row is the whole safety story: the fast path only ever takes a request it is confident
about. Everything else behaves exactly as if the proxy were not there.

## Why this shape

The reference project is a Home Assistant *custom component*, so it replaces the conversation
agent. You are using `hass_local_openai_llm` as your agent and do not want a second integration
maintaining the same job. Because that integration talks to any OpenAI-compatible server, the
useful place to insert the fast path is *behind* it, as a server:

```
Home Assistant  ──►  hass_local_openai_llm  ──►  typesafe routing proxy  ──►  your model server
   (Assist)            (conversation agent)      (decides or forwards)
```

Nothing to install in Home Assistant, no custom component, no HACS entry, no second agent
competing for the `conversation` platform. One container, one URL change.

## Quick start

```bash
npm install
npm run dev          # http://localhost:8080 — dashboard, /v1 endpoint
```

Docker instead:

```bash
mkdir -p data
docker compose up -d --build
```

Or pull the published image:

```bash
docker run -d --name typesafe-proxy -p 8080:8080 \
  -v /path/to/data:/app/data \
  -e UPSTREAM_BASE_URL=http://host.docker.internal:8081/v1 \
  ghcr.io/ksmarty/typesafe-openai-proxy:latest
```

Then:

1. Open `http://<host>:8080/` and fill in **Settings**. The only field the proxy needs to be useful
   as a pass-through is *Inference server to fall back to* — **the URL `hass_local_openai_llm` uses
   today**. Add a decision model (below) when you want the fast path:
   - *Decision backend* — `Off` until you have a decision server; then `System One`. `Heuristic` is
     there for trying the routing out without a model.
   - *Decision base URL / model* — your decision model endpoint (see below).
   - *Home Assistant URL + long-lived token* — optional, and the best catalog source.
   - *Spoken-from area* — enables "turn on the lights here".
   - *Start deciding on its own* — off by default; see **Nothing happens until you ask**.
2. In the `hass_local_openai_llm` integration options, change **Server URL** to
   `http://<proxy-host>:8080/v1`. Keep the model name and the API key (if you set `PROXY_API_KEY`,
   that key is what the integration should send).
3. Keep **tool calling / Assist tools** enabled in the integration. The proxy reads the tool names
   and their argument slots from the request Home Assistant sends; if a tool is not offered, the
   proxy forwards instead of inventing a call.
4. Talk to Assist. The dashboard shows every decision, its gates, and why it was forwarded.

## Nothing happens until you ask

There is **no default decision backend**. With the backend off — or a System One backend with no URL
yet — the proxy is a pass-through: it reads the request, records it in the dashboard trace, and
forwards it to your inference server untouched. Installing it in front of a working
`hass_local_openai_llm` therefore cannot change what Assist does.

Two ways to turn the fast path on:

- **Set `decision.autoStart`** (Settings → Decision model → *Start deciding on its own*), and every
  request is decided once the backend is configured.
- **Or name the model.** A request whose `model` is `typesafe-router` is always decided, whatever
  `autoStart` says. That is how to try it out safely: point a second `hass_local_openai_llm` entry
  (or the Assist "prefer handling commands locally" agent) at the proxy with that model name, and
  leave your working entry alone.

The Monitor view shows which mode you are in — the header pill reads `deciding` or `pass-through`,
and the counters separate *forwarded* (decided, then handed on) from *passed through* (never decided).

## The decision backend

No backend is configured out of the box. Two implementations share the same answer shape, plus off.

**System One** — the typed, calibrated model the reference project uses. Serve it locally with
Ollama ≥ 0.35 (`jev` models) or use the hosted endpoint, then set the base URL and the model name.
The proxy posts `{model, state, questions}` to `POST {baseUrl}/v1/systemone` and reads proportional
answers back.

**Heuristic** — the offline fallback, for trying the routing without a model. It scores the same
questions with rules and a softmax, so it needs nothing installed. It is noticeably more
conservative; more requests fall through to your LLM. Use it to try the integration, not as the
long-term answer.

**Off** (default) — decide nothing, forward everything.

If the decision backend errors or trips its circuit breaker (3 failures, 30 s), the request is
forwarded — never dropped.

## How a decision is made

Every request is reduced to the same typed questions, each with an answer, a probability and a
margin over the runner-up:

`category` → `compound` → `query_kind` → `scope` → `target_domain` → `target_entity` /
`target_area` → `action_<domain>` → `risky` → `value_pick` / `change_direction` / `magnitude`

A gate passes only when the answer clears its own threshold **and** the top-two margin is wide
enough to mean the model chose rather than hedged. Thresholds live in `src/config.ts`
(`DEFAULT_THRESHOLDS`) and mirror the reference values fitted to `jev-1.13.0`:

| threshold | value | meaning |
| --- | --- | --- |
| `minMargin` | 0.15 | top answer must beat the runner-up by this much |
| `actTerse` | 0.75 | a bare command ("lights on") without a named target |
| `actExplicit` | 0.50 | a command that names a device, area or domain |
| `entity` | 0.60 | confident choice of one entity |
| `area` | 0.55 | confident choice of a room |
| `domain` | 0.50 | confident choice of a kind of device |
| `actionProbability` | 0.55 | confident choice of what to do |
| `clarifyFloor` | 0.30 | below this, do not even ask — forward |
| `riskyAction` | 0.85 | unlock/open/disarm |
| `riskyTarget` | 0.75 | a lock, cover, garage, gate, door or window |

Ambiguous targets produce a question listing the runners-up ("Which one did you mean: Kitchen
Ceiling, Desk Lamp, Living Room Lamp?"). Risky actions produce a confirmation and arm a yes/no for
90 s; "yes" then emits the held tool call.

## Targeting, precisely

Home Assistant's intent filters accept an **entity id in the `name` slot** and match it exactly
before trying aliases, so the proxy sends `{"name": "light.kitchen_ceiling"}` rather than hoping a
friendly name resolves. Values are converted to the slot's own unit — `brightness_pct` is 0–100,
`brightness` is 0–255. Relative requests ("brighter", "a bit louder") are computed against the
entity's current level from the catalog, so the proxy never guesses a position.

## Catalog

Two sources, used automatically:

- **Home Assistant websocket** (needs `HA_URL` + `HA_TOKEN`): area, device, floor and entity
  registries plus live states. Authoritative, includes floors and device classes.
- **The system prompt** Home Assistant sends with each request: tolerant parsing of the entity
  listing. Version-dependent by nature, so it is the fallback, not the preference.

## Endpoints

| path | purpose |
| --- | --- |
| `POST /v1/chat/completions` | what `hass_local_openai_llm` calls; JSON or SSE |
| `GET /v1/models` | model list, for integrations that probe it |
| `GET /health` | liveness plus routing/backend/catalog summary |
| `GET /api/status` | dashboard: config, counters, breaker, catalog stats |
| `GET /api/trace` · `DELETE /api/trace` | recent decisions with their gates |
| `POST /api/probe` | decide on a sentence without executing it |
| `GET /api/schema` | every setting, its type, bounds and default — the dashboard renders from this |
| `GET/POST /api/config` | read and patch settings (`data/config.json`) |
| `POST /api/config/reset` | restore every setting to its built-in default |
| `POST /api/test/ha` · `/api/test/decision` · `/api/test/upstream` | connection tests for the three servers |
| `POST /api/catalog/refresh` · `GET /api/catalog` | rebuild and inspect the entity catalog |
| `POST /api/breaker/reset` | clear the decision circuit breaker |
| `GET /api/models` | models the decision server advertises, with the `jev` capability flagged |

## Dashboard

`http://<host>:8080/` has two views.

**Monitor** — status pills, counters, the circuit breaker, a *try a request* box that runs the
decision path without executing anything, and the live trace: each turn shows its route, the tool
call and arguments, and every gate as a bar with its threshold marked.

**Settings** — the whole configuration, grouped into decision model / catalog / fallback server /
speech / routing gates / server. Fields are rendered from `GET /api/schema`, so nothing exists in
the config that the dashboard cannot edit, and the server validates with the same description:

- confidence thresholds are sliders paired with a number box, so they can be dialled or typed;
- every value is clamped to its declared range on save, and the response names the keys the server
  had to adjust (`adjusted`) instead of silently editing them;
- a value the schema cannot read (a typo in a select, a non-numeric number) is ignored and the
  previous value kept;
- a masked API key is left untouched — clearing the field is what removes it;
- *Test* buttons for the decision server, Home Assistant and the fallback server, reporting what
  they found rather than just pass/fail;
- per-language speech templates, an advanced toggle for the rarely-touched knobs, *Show JSON* for
  the exact document on disk, and a two-click *Reset everything*.

Environment variables still win over saved settings; the dashboard lists which ones are set, since
a value that is overridden would otherwise look like it did nothing.

## Configuration

`data/config.json`, written by the dashboard, with environment variables overriding it. See
`.env.example` for the full list.

The backend-related variables are worth naming, because there is no default decision model:

| variable | default | meaning |
| --- | --- | --- |
| `DECISION_BACKEND` | `none` | `none` forwards everything, `systemone` uses a decision model, `heuristic` uses the built-in matcher |
| `SYSTEMONE_BASE_URL` | *(empty)* | the decision server; `systemone` with an empty URL is still a pass-through |
| `SYSTEMONE_MODEL` | *(empty)* | the model name that server serves — there is no assumed default |
| `AUTO_START` | *(unset)* | `1` decides every request; otherwise only requests naming the `typesafe-router` model are decided |

## What this deliberately does not do (yet)

- **Compound requests** ("turn off the kitchen lights and lock the door") — detected and forwarded.
- **Floor-wide commands** — detected and forwarded.
- **Script/template field filling**, `set_mode`, and MQTT-specific actions — forwarded.
- **Media search grammar** beyond a simple "play X on Y" query slot.
- Anything where a gate fails. That is the point.

## Development

```bash
npm run typecheck
npm test          # node:test through tsx; drives the real pipeline with the heuristic backend
npm run build && npm start
```

Layout: `src/questions.ts` builds the typed question set, `src/systemone.ts` and
`src/heuristic.ts` answer it, `src/router.ts` turns answers into a plan under the gates,
`src/toolcall.ts` maps the plan onto the tool schemas Home Assistant actually offered,
`src/schema.ts` describes every setting for both the API and the dashboard, `src/pipeline.ts` ties
a chat request to a response, `src/server.ts` is the HTTP surface, `public/` is the dashboard.

`test/schema.test.ts` walks the default config and fails if a setting is not described in
`src/schema.ts`, so a new knob cannot be added without becoming editable.

## Releases

Push to `main` and `auto-increment.yml` bumps the patch version in `package.json`, tags it, and
dispatches the image build and the release. A `v*.*.*` tag pushed by hand publishes the same tags
directly. `docker-publish.yml` pushes `linux/amd64` to GHCR:

```
ghcr.io/ksmarty/typesafe-openai-proxy:latest
ghcr.io/ksmarty/typesafe-openai-proxy:<version>
ghcr.io/ksmarty/typesafe-openai-proxy:<major>.<minor>
```

To publish for ARM as well, add `linux/arm64` to the `platforms` list in `docker-publish.yml` and
re-add `docker/setup-qemu-action` above the build step.

MIT.
