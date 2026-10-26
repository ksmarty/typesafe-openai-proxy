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

## Who actually does what

Worth being explicit, because it is the usual question: the proxy does **not** replace the
integration, and it never talks to Home Assistant.

| job | owner | unchanged? |
| --- | --- | --- |
| expose Assist to Home Assistant, stream, RAG, AI Task, parallel tool calls | `hass_local_openai_llm` | yes |
| build the Assist tool schemas and send them as the request's `tools[]` | Home Assistant, via that integration | yes |
| execute the intent (actually turn the light on) and return the result | Home Assistant's intent engine | yes |
| write prose when the request is not a command | your model server, reached through the proxy | yes |
| decide whether a request is a command worth answering in ~200 ms | the proxy, using the decision model | new |

The proxy's only new power is choosing *which of the two* answers a given request: a `tool_call`
it builds from the tools the request offered, or a verbatim forward to the model server. It never
executes anything itself — Home Assistant still does, from the tool call in the response.


## Quick start

```bash
npm install
npm run dev          # http://localhost:8080 — dashboard, /v1 endpoint
```

Docker instead — the whole file is four lines of real content:

```bash
mkdir -p /opt/typesafe-proxy      # or your own path, e.g. /mnt/user/appdata/typesafe-proxy
docker compose up -d              # image: ghcr.io/ksmarty/typesafe-openai-proxy:latest
```

`docker-compose.yml` maps that host directory to `/app/data`; `config.json` lives there, so
settings survive every update. Everything else is configured in the dashboard and saved into it.

To use a different drive, copy `.env.example` to `.env` and set `TYPESAFE_DATA_PATH` — compose
substitutes it into the volume, so no edit to the YAML is needed:

```bash
cp .env.example .env
echo 'TYPESAFE_DATA_PATH=/mnt/user/appdata/typesafe-proxy' >> .env   # your real path
docker compose up -d
```

Or without compose:

```bash
docker run -d --name typesafe-proxy -p 8080:8080 \
  -v /opt/typesafe-proxy:/app/data \
  ghcr.io/ksmarty/typesafe-openai-proxy:latest
```

### Behind Traefik, with Authentik in front

`docker-compose.traefik.yml` is a ready version of the above for a Traefik host that runs an
Authentik forward-auth middleware as `authentik@file`:

```bash
cp docker-compose.traefik.yml docker-compose.yml
mkdir -p "$USERDIR/data/typesafe-proxy" && sudo chown 1000:1000 "$USERDIR/data/typesafe-proxy"
# .env
#   USERDIR=/mnt/user
#   PROXY_HOST=proxy.example.com      # the hostname Traefik serves
#   TYPESAFE_PROXY_KEY=<random>        # what Home Assistant sends as the API key
docker compose up -d
```

It defines **two routers on one service**, and the split is the important part:

| router | rule | middleware |
| --- | --- | --- |
| `typesafe-ui` | `Host(...) && !PathPrefix(/v1)` | `authentik@file` |
| `typesafe-api` | `Host(...) && PathPrefix(/v1)` | none — `PROXY_API_KEY` instead |

The machine API must not sit behind Authentik: an unauthenticated `POST /v1/chat/completions` would
be answered with a 302 to the Authentik flow, and `hass_local_openai_llm` would get an HTML login
page where it expects JSON (or a stream of `data:` frames). It is guarded by the proxy's own bearer
token instead, which is the *API key* field in the integration options. The dashboard and its
`/api/*` endpoints stay behind Authentik, which is where the browser session already is.

Two things worth knowing about this image in a Traefik setup:

- It ignores `PUID`/`PGID` — it is not a LinuxServer image. It runs as `node`, uid/gid **1000**, so
  the bind-mounted data directory has to be owned by 1000 (`chown 1000:1000`).
- No published port is needed: Traefik reaches the container over the shared network
  (`traefik.docker.network=traefik`, container port 8080). Publish `127.0.0.1:8080:8080` only if you
  want to reach it without going through Traefik.

`PROXY_API_KEY` guards `/v1` only. `/api/*` (which can rewrite the configuration) is protected by
whatever sits in front of the container — never expose the dashboard without an auth middleware.

If your Traefik uses different names, adjust the two `entrypoints` (`websecure`) and
`tls.certresolver` (`letsencrypt`) labels; if your Traefik already sets a default entrypoint and
resolver, drop those labels entirely.

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
answers back. Through OpenRouter the base URL is `https://openrouter.ai/api` and the model is
`typesafe/jev-router` (whichever typed model the endpoint advertises is listed by
`GET /api/models`, and the Settings page's **Test** button reports it).

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

Ambiguous targets never reach the model. When the typed answer says no single device is named and
the words fit several devices equally well, the reply is a question listing them ("Which one did you
mean: Bedroom Lamp, Living Room Lamp?"), and when the speaker names a room instead ("the kitchen
light", two lights in the kitchen) the tool call goes out with `{"area": "Kitchen", "domain": "light"}`.
Risky actions produce a confirmation and arm a yes/no for 90 s; "yes" then emits the held tool call.

### More than one thing at once

One utterance can legitimately need several calls, and the proxy sends them in one response rather
than answering half of it:

- **One action over several targets** — "turn on the kitchen and living room lights" becomes two
  calls, `{"area": "Kitchen", "domain": "light"}` then `{"area": "Living Room", "domain": "light"}`.
  A room whose name is also the name of a device group ("Kitchen Lights") is counted once, and
  "the kitchen ceiling" is a device, not the room it sits in.
- **Two actions in one sentence** — "turn off the kitchen lights and lock the door" is split into its
  clauses, each decided on its own against the same catalog, and the calls are sent in order. If any
  clause is not something the fast path can call (a request for prose, a device kind this request
  offers no intent for), the whole sentence is forwarded instead: a half-done compound request is
  the one outcome worth avoiding.

Home Assistant executes the calls in order and the follow-up round carries one tool result per call,
so the spoken reply is assembled from every result.

## Resetting settings

**Reset this page** in the settings footer restores only the section you are looking at (`POST
/api/config/reset` with `{"group": "catalog"}`); every other section keeps its values, including the
Home Assistant token and the decision API key. `POST /api/config/reset` without a group is still a
full reset to defaults.

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
  listing, including the room each line names ("…: off, in Kitchen", "area: Garage") and the room
  whose heading the line sits under (`## Kitchen`, then `- Ceiling Light (light.kitchen_ceiling)`),
  because an area-scoped request cannot resolve without them. Version-dependent by nature, so it
  is the fallback, not the preference.

### When everything is forwarded

Every forwarded turn records its reason in the dashboard's decision list. The reasons that say the
most about a setup:

| reason | what it means | fix |
| --- | --- | --- |
| `pass-through: the request carried no tools` | Home Assistant sent no intent schemas with this request, so no intent could be called at all | in the integration, choose the **Assist** LLM API for the agent (tool calling); AI Task and "prefer speech" paths send nothing callable |
| `HassTurnOn is not offered by Home Assistant (it offered …)` | the request carried tools, but not that one — the message lists what it did offer | usually the same cause as above, on a request that offered only a few tools |
| `no rooms in the catalog — …` | the catalog has entities but no areas | set a Home Assistant token in *Settings → Home Assistant catalog* (the wake-word side of a sentence needs real areas) |
| `no confident reading of how wide the request is` | the model could not say whether one device, a room or the whole house is meant, and no room or device was named outright | say the room or device plainly ("the kitchen ceiling light") |
| `no confident room` | the model was unsure which room, and the sentence named none | name the room, or lower *target area* in *Routing gates* |

A room or device named outright now rescues an unsure scope instead of forwarding: "turn on the
kitchen lights" resolves to `HassTurnOn {"area": "Kitchen", "domain": "light"}` even when the model
cannot pick a scope, and "turn off the living room lamp" resolves to that exact entity. Nothing is
guessed when two devices or rooms fit equally well — the proxy asks instead.

### Refreshing the catalog

The catalog is cached for `catalog.cacheMs` (30 s by default) so a command does not wait on
Home Assistant every time. Settings → Home Assistant catalog has a **Refresh catalog** button
that drops the cache and re-reads entities, areas and aliases immediately — if the form has
unsaved edits it saves them first, so a token typed a second ago is the token that gets used.
The same action is on the Monitor page, and `POST /api/catalog/refresh` does it from a script.

### Aliases

Home Assistant's aliases are read and used, on both sides of a decision:

- **The catalog** keeps the `aliases` of every exposed entity and area (websocket registry) and
  parses `aliases: Big Light, Ceiling` or a following `- also called: …` line out of the prompt.
- **The decision model** sees them, because each entity is described to it as
  `Kitchen Ceiling, light, Kitchen, is on, also called Big Light, Ceiling` — so "turn on the big
  light" resolves to the right option.
- **The matching** treats them as names: a device or room named outright in the sentence (by name
  *or* alias) rescues an unsure scope, and two devices that both match still produce a question
  rather than a guess.
- **The call** is unaffected, because the proxy sends the **entity id** in the `name` slot, which
  Home Assistant matches exactly before it tries any alias. Aliases make the proxy understand the
  request; the id is what makes the action land.

Aliases come from the registry, so they need `HA_URL` + `HA_TOKEN` to be authoritative. The prompt
parser picks up aliases when Home Assistant renders them, which not every version does.

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
| `GET /api/debug/bundle` | one JSON file for a bug report: config (secrets masked), state, traces, recent log lines |

## Dashboard

`http://<host>:8080/` is a Material UI app (React 19, built with esbuild into `public/app.js`) with two views.

**Monitor** — status pills, counters, the circuit breaker, a *try a request* box that runs the
decision path without executing anything, and the live trace: each turn shows its route, the tool
call and arguments, and every gate as a bar with its threshold marked.

A decision test answers the question you actually have — *what would Home Assistant be asked to
do?* The result panel names the intent and its slots (`HassTurnOn {"name": "light.kitchen_ceiling"}`),
or says plainly why there is no call: `no call yet — it asks which one`, `no call — forwarded to your
model server`, `Home Assistant call — after you confirm`. Long values — option ids like
`e_kitchen_ceiling_light_secondary`, argument JSON — live in their own bordered box that scrolls
sideways, so a long entity id never spills across the card.

*Export debug logs* on the Monitor view downloads everything worth attaching to an issue as a single
JSON file: version and runtime, the effective config with every secret masked to its first 12
characters, the catalog summary, the recent decisions with their gates, the request log (method,
path, status, duration) and anything written to stdout/stderr since the process started. The same
file is available without a browser at `GET /api/debug/bundle`. It contains the utterances Assist
sent, so skim it before sharing it publicly.

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
- **Generate** next to the proxy's own bearer token mints a 41-character token (`sk-proxy-` plus 32
  random characters), shows it once and selects it, so it can be copied before saving — afterwards
  only the first 12 characters come back;
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

### One key for both servers

The decision model and the fallback server are often the same provider — OpenRouter serving
`typesafe/jev-router` for decisions and `openai/gpt-4o-mini` for prose. Turn on **Settings →
Fallback inference server → Use the decision model's API key** (or set
`UPSTREAM_API_KEY_FROM_DECISION=1`) and a forwarded request carries the decision key, so the key
never has to be copied out of a field the dashboard only shows twelve characters of.

A key typed into the upstream **API key** field always wins, so the setting can stay on while a
different provider is used for prose. Nothing changes when the flag is off.

## What this deliberately does not do (yet)

- **Compound requests** are split when each clause names its own target ("turn off the kitchen
  lights and lock the door"); a clause that needs a slot the fast path cannot fill is forwarded whole.
- **Floor-wide commands** — detected and forwarded.
- **Script/template field filling**, `set_mode`, and MQTT-specific actions — forwarded.
- **Media search grammar** beyond a simple "play X on Y" query slot.
- Anything where a gate fails. That is the point.

## Development

```bash
npm ci
npm run typecheck   # server (tsc) and dashboard (tsc -p tsconfig.web.json)
npm test            # node:test through tsx; drives the real pipeline with the heuristic backend
npm run dev         # bundle the UI and serve http://localhost:8080
npm run dev:ui      # the same, rebuilding the UI on every change
npm run build && npm start
```

React and Material UI are dev dependencies on purpose: the browser loads the pre-built
`public/app.js`, so the runtime image needs no `node_modules` at all.

Layout: `src/questions.ts` builds the typed question set, `src/systemone.ts` and
`src/heuristic.ts` answer it, `src/router.ts` turns answers into a plan under the gates,
`src/toolcall.ts` maps the plan onto the tool schemas Home Assistant actually offered,
`src/schema.ts` describes every setting for both the API and the dashboard, `src/pipeline.ts` ties
a chat request to a response, `src/server.ts` is the HTTP surface. The dashboard lives in `web/`
(React + Material UI) and is bundled by `scripts/build-ui.mjs` into `public/app.js`; `public/index.html`
is the shell.

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
