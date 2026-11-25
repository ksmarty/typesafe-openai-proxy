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
| overheard remark, not aimed at it | proxy answers with the configured silence and forwards nothing | one decision call |
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
- **Several items on one list** — "add peanut butter and jam to the shopping list" is two things to
  buy, not one thing called "peanut butter and jam", so it becomes two `HassListAddItem` calls, one
  per item, in the order they were said. Commas, semicolons, `and`, `&`, `plus`, `along with` and
  `as well as` are the seams, and the shopping list itself is still named once. Two words that
  really are one thing keep a way out: "add fish and chips as one item to the shopping list" (or
  "… together") goes on the list whole. The same splitting applies to "mark milk and eggs off the
  list" and "remove milk and eggs from the list".

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

A **floor** is one target of its own. "Turn off the upstairs lights" becomes a single
`HassTurnOff` with `{"floor": "First Floor", "domain": "light"}`, because Home Assistant's
intent filters take a floor the same way they take a room; picking one room on the floor
would be a guess wearing a room's name. Floors come from the websocket catalog, where the
floor registry gives each floor a name and a level: "upstairs" is the highest level,
"downstairs" the lowest, and a floor named outright ("the first floor lights") needs no
level. Two floors sharing the highest level is a question, and an intent with no `floor`
slot is a refusal, not a room-sized action.

The system prompt catalog carries no floors, so floor-wide phrasing there goes to the model
rather than being guessed at.

## Catalog

Two sources, used automatically:

- **Home Assistant websocket** (needs `HA_URL` + `HA_TOKEN`): area, device, floor and entity
  registries plus live states. Authoritative, includes floors and device classes.
- **The system prompt** Home Assistant sends with each request: tolerant parsing of the entity
  listing, including the room each line names ("…: off, in Kitchen", "area: Garage") and the room
  whose heading the line sits under (`## Kitchen`, then `- Ceiling Light (light.kitchen_ceiling)`),
  because an area-scoped request cannot resolve without them. Version-dependent by nature, so it
  is the fallback, not the preference.

### Saying "never mind"

"Nevermind.", "cancel that", "forget it", "no thanks", "stop", "that's all" end the turn. Home
Assistant has an intent for exactly this (`HassNevermind`), and its answer is silence, so the proxy
reads the sentence before anything else looks at it and calls that intent directly — no decision
call, no model round trip. A user who says it to cut an answer short waits for the sentence to be
transcribed and nothing more.

The reader only fires on the whole sentence: a cancel word is not a cancel if the sentence names
something ("never mind the lights", "cancel the pasta timer", "no thanks turn it off") — those still
reach the decision model, which is the only thing that knows what was meant. The readers above it
keep "stop" when a timer or a speaker could be meant, and `HassNevermind` has to be offered by the
conversation agent; when it is not, the sentence falls through to the normal path.

That covers the sentence. Cutting off an answer that is already being spoken is the satellite's job,
not the proxy's: enable **Stop word interruption** in Kiosk Satellite and "stop" is classified
on-device, with no STT and no pipeline. A wake word will not do it — the satellite ignores one while
a turn is in flight.

### The catalog read aloud

A microphone hears the speaker as well as the room, and the worst thing it can hear is the
assistant's own list of names:

> Office, Living Room, Kitchen, Bedroom, Front Hall, Main Floor, Upstairs, Bedroom Lamp, Bedroom
> lights, Evedal, …, Door.

That is one real satellite's transcript. Nothing in it asks for anything, but it is far past the
length a remark is allowed to be, so it used to take the whole slow path: a decision call, then the
model server, which answered by naming things back — and the microphone heard that too.

A sentence that is only names, joined by commas or "and", with no verb of its own, is now answered
with the configured silence instead: no decision call, no model round trip, nothing spoken. "No verb
of its own" is doing the work — a part of the sentence that opens with a verb ("…, turn on", or
"… Door turn on the office lamp" with the comma missing) keeps the whole sentence for the decision
model. Devices named with those words are fine: a media player called "Play Music" does not
disqualify the list it appears in.

How much of the sentence has to be names depends on how long it is. A short one ("Office, Living
Room, Kitchen, Bedroom, garage") is somebody talking, and most of it has to be names the catalog
holds. A long one is read aloud rather than spoken, and the catalog usually knows only part of it:
the transcript above is thirty-four names of which that install exposes fifteen, so from eight parts
on a third is enough. The alternative was a rule that declined the very sentence it was written
for.

This is the reader that closes the loop on a satellite that answers its own voice.

### Conversation that is not a command

"No you", "ignore that", "thanks", "wait" are about the conversation, not about the house. The
proxy recognises a short sentence that names no device or room and contains no command verb, and
sends it straight to your model server — no decision call, no chance of nudging a device. Anything
it is unsure about still goes through the decision model, and a sentence that names a device or a
room always does. The one exception is the sentence that means "end the turn" (see above): that
reader runs first, so "nevermind" never reaches your model server at all.

### When it was not addressed to the assistant

A microphone hears the whole room. "Did you see the game last night", "my wife says the door is
still open", "we should get that boiler serviced" are not requests, and a model server that is
handed one still answers it — usually by doing something to the house. The proxy judges every
sentence it is about to forward, or to ask a clarifying question about, and answers the ones that
were not meant for it with the configured silence instead.

Two readers, in order of authority:

- **The decision model.** `addressed` is one of the questions in the set it already answers, so the
  judgement costs nothing extra. Its answer decides whenever it was asked.
- **The local pattern reader.** A pass-through install, a backend that is switched off, a model
  that is unreachable: no model was asked at all, so a small pattern reader on the proxy reads the
  sentence instead. It only ever calls a sentence a remark when it is structurally one — a
  question aimed at another person, a report about a third party, a plan between people, narration
  about the room. Anything else is "cannot tell", which forwards as before.

Silencing a real request is worse than answering an overheard remark, so the judgement is
deliberately one-sided: a command verb anywhere in the sentence, a question, or a device or room
named outright means "addressed", whatever else the sentence looks like. A turn the fast path
already resolved into a tool call is never revisited — only a turn that was heading for the model
server or asking a clarification aloud is.

*Settings → Listening* holds the switch, the confidence the judgement has to reach (0.75 by
default), and the local reader. Turning it off restores the old behaviour exactly: every sentence
is forwarded.
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
| `not addressed to the assistant` | the sentence was judged to be a remark between people rather than a request | expected for overheard conversation; turn off *Settings → Listening* to forward everything again |

A room or device named outright now rescues an unsure scope instead of forwarding: "turn on the
kitchen lights" resolves to `HassTurnOn {"area": "Kitchen", "domain": "light"}` even when the model
cannot pick a scope, and "turn off the living room lamp" resolves to that exact entity. Nothing is
guessed when two devices or rooms fit equally well — the proxy asks instead.

### Is anything reaching the proxy?

Monitor → **Requests received** lists every call that landed on `/v1`, with its status and how long
the proxy took. It is kept whether or not the request became a turn, so a rejected bearer token
(`401`), a pass-through and a forwarded request all appear. Nothing in that list means Home
Assistant is talking to something else: check that the **Server URL** in `hass_local_openai_llm`
is this proxy's root plus `/v1`, and that its API key matches `server.apiKey` here.

The same rows are in the debug bundle (`requests`), next to the per-stage timings each turn
records under `stages`.

Two version markers exist so "am I even running the new build?" is never a guess:

- the **`v…` chip** in the dashboard header, from `GET /api/status`;
- the **`org.opencontainers.image.version`** label inside the image, set from the release tag at
  build time — `docker inspect ghcr.io/ksmarty/typesafe-openai-proxy:0.1.30 --format '{{json .Config.Labels}}'`.

### Refreshing the catalog

The catalog is cached for `catalog.cacheMs` (30 s by default) so a command does not wait on
Home Assistant every time. Settings → Home Assistant catalog has a **Refresh catalog** button
that drops the cache and re-reads entities, areas and aliases immediately — if the form has
unsaved edits it saves them first, so a token typed a second ago is the token that gets used.
The same action is on the Monitor page, and `POST /api/catalog/refresh` does it from a script.

### State questions without `HassGetState`

Home Assistant only offers `HassGetState` when its Assist API registers a state intent, and some
installations do not — every "is the office light on?" then went to the language model, seconds of
latency for one boolean. The proxy answers those itself: the catalog already holds the state of
every exposed entity, so a device question comes back as text ("The Desk Lamp is off.") and a count
question as a summary ("1 of the 2 lights is on: Office Lights."). The reply is ordinary assistant
text, so the conversation agent speaks it like any other answer.

The catalog is refreshed before a question is answered when it is older than two seconds, so
"is the front door locked?" is not answered from a 30-second-old snapshot. When Home Assistant *does*
offer `HassGetState`, the intent call is still used — its answer includes attributes the catalog
does not carry. An unconfident target still forwards rather than guessing.

A question the proxy forwards may still come back as a tool call — your model server asks for a
state by calling one of the intents the request offered, which is the only route to an answer when
the installation has no `HassGetState` and no lock to read. Such a round is **spoken**, not
silenced: the proxy looks at the tool call it never issued itself, describes it, and if the turn
being answered was a question it lets your model's own answer through instead of applying the
quiet default. In the Monitor it appears nested under the question it answers, tagged *spoken by the
model*, with the round trip shown.

### The time, in words

"what time is it?" is answered by the proxy itself, and spoken the way a person says it:
**"five twenty-two"**, **"five o'clock"** on the hour, "nine oh five" below ten past. The
minutes are hyphenated on purpose: a voice reads "five twenty two" as three numbers, and
"five twenty-two" as one time. Never a.m. or p.m. — the reply is heard, not read, and which
half of the day it is is obvious from the moment it is heard. The reply is the bare time,
with no "It is" in front of it.

Home Assistant can answer this itself with `HassGetCurrentTime`, but what comes back is
either digits read out one by one or a sentence the conversation agent phrased ("The current
time is 5:22 PM"), and neither is what a clock in a room should say. So the wording is owned
here, which also means no model call and no intent round trip: the answer takes about as long
as the catalog lookup.

The clock it reads, in order:

1. `clock.timezone` (Settings → Clock, or `CLOCK_TIMEZONE`) — an IANA zone such as
   `Europe/Amsterdam`, when you want to name one;
2. otherwise the time Home Assistant already put in this request's system prompt
   ("Current time is 9:41 AM."), which is in the home's own timezone and costs no request;
3. otherwise the process clock, i.e. the container's `TZ`.

A question about the date ("what's the date?") is not answered this way — only Home Assistant
knows the home's date, locale and calendar, so `HassGetCurrentDate` is still called. Neither
is "what time is it in Tokyo", which is forwarded, or a command that merely contains the word
("set a timer for five minutes"), which takes the normal path.

### The weather

"what's the weather like?" is answered by the forecast service itself, in the sentence it
wrote: *"Light rain on Wednesday and Thursday, with highs dipping to 6 °C"*. The wording is
the reason for the service — [Pirate Weather](https://pirateweather.net/) is Dark Sky–compatible
and returns written summaries for every timescale — because a sentence assembled here from
condition codes would read worse than the one the forecast service already wrote.

Which summary is spoken depends on what was asked:

| Asked | Spoken |
| --- | --- |
| "what's the weather like?", "is it raining?" | the current conditions plus the temperature |
| "is it going to rain?" | the next hour, since the question is about rain that has not started |
| "what's the forecast today" | today's summary with its high and low |
| "will it snow tonight" | today's summary (the overnight part is in it) |
| "what's the forecast for tomorrow" | tomorrow's own summary with its range |
| "what about the rest of the day" | the rest of the day |
| "what's the weather this week" | the week ahead |

The summaries come back in the language the question was asked in (Pirate Weather writes them
in fifty-odd languages), and the temperature sentence follows the same rule — a language with
no phrase here gets the summary alone rather than a sentence in the wrong language. Units come
from the locale Home Assistant sends, or from the pinned choice in Settings → Weather.

**What the answer says** is yours to choose in Settings → Weather → *What the answer says*, and
it only ever changes the temperature sentence, never the summary:

| Style | "what's the weather like?" |
| --- | --- |
| *the summary, then the temperature* (default) | "Light Rain. Currently 7°, feeling like 4°." |
| *the summary only* | "Light Rain." |
| *the summary, the temperature, and the day's high and low* | "Light Rain. Currently 7°, feeling like 4°. A high of 9° and a low of 5°." |
| *the temperature first, then the summary* | "Currently 7°, feeling like 4°. Light Rain." |
| *said the way a person would* | "Right now it's light rain, and it's 7° out — though it feels more like 4°." |

*Said the way a person would* keeps the same forecast and turns it into speech: the summary
becomes part of a sentence instead of being quoted after one, and the phrasing varies from one
answer to the next, so asking twice does not read like a machine:

| Asked | One of the answers |
| --- | --- |
| "what's the weather like?" | "Light Rain at the moment. 7° outside, feeling closer to 4°." |
| "what's the forecast today" | "Today it's possible light rain until night and foggy overnight, with a high of 9° and a low of 5°." |
| "what's the forecast for tomorrow" | "For tomorrow: Misty until afternoon, returning overnight. High of 9°, low of 3°." |
| "what's the weather this week" | "Looking ahead: Light rain on Wednesday and Thursday, with highs dipping to 6°C on Tuesday." |

Keeping the summary untouched is the point: it is correct in every language the service writes,
so no style can produce a sentence that mixes two languages. That holds for *said the way a
person would* too — it has wordings for English, Dutch, German, French, Spanish, Italian,
Portuguese, Swedish and Danish, and any other language falls back to the summary with the
temperature rather than a half-translated sentence. Set `WEATHER_STYLE` to
`current`, `summary`, `full`, `temperature_first` or `natural` instead of using the form.

The reader that recognises a weather question is English, so a non-English question is
forwarded to your model unless **Settings → Weather → Language of the summaries** pins one, in
which case every summary (and the sentence after it) comes back in that language.

Set it up in **Settings → Weather**: paste the API key from
[pirateweather.net](https://pirateweather.net/) (the free tier is 10,000 calls a month) and
leave the coordinates empty — Home Assistant's own `zone.home` is used, so the forecast is for
the right house without anyone typing a latitude. One forecast is reused for ten minutes, so
two questions in a row cost one call. Or set `WEATHER_API_KEY` and skip the form.

What it deliberately does not do: **a question about another city** ("what's the weather in
Amsterdam?"), **a question about a room or a device** ("is the bedroom warm?" — that is your
thermostat), and **anything phrased as a command** ("set the thermostat to 21"). Those are
forwarded to your model exactly as before. Neither is anything fetched without a key. A failure
of any kind — a bad key, an unreachable service, a timeout — answers nothing and forwards the
question, so weather can never be the reason a turn breaks.

### Sports

"how are the Bills doing?" is answered from the sensors
[sports-ticker](https://github.com/LiquidFXX/sports-ticker) already writes. ESPN's scoreboards,
standings, rankings and each favourite team's next fixture arrive as attributes on that
integration's `sensor.espn_*` entities, so a sports question is a lookup in state that is
already there — no model call, no search, and the score comes back in the time the round trip
takes.

| Said | Spoken |
| --- | --- |
| "how are the Bills doing", "what's the score of the Bills game" | "Bills are winning 24 to 21 against the Chiefs, 6:32 left in the third quarter." |
| "how did the Dolphins do" | "Dolphins lost to the Bills 31 to 17." |
| "when do the Bills play next", "when are the Raptors playing" | "Raptors visit the Boston Celtics on Friday at 7:30 PM at TD Garden." |
| "when's the next Raptors game", "when are the raptor's playing?" | the same fixture, read from the schedule sensor |
| "where are the Knicks in the standings" | "Knicks are second in the Atlantic with a 12 and 6 record." |
| "who's number one in college football" | "Georgia Bulldogs are number one in AP poll with a 10-1 record." |
| "any games on?", "what's the score?" | "On now: Bills 24, Chiefs 21." — and anything starting soon after it |

Scores are spoken as **"24 to 21"**, never "24-21", and a record as **"a 12 and 6 record"**,
because a hyphen read aloud comes out as "twenty four dash twenty one". A final is a win or a
loss rather than a scoreline — "beat the Dolphins 31 to 17" — since that is what was asked.

A kickoff is said in the day it actually falls on, not read off a calendar: a game later the
same day is **"tonight at 7:30 PM"**, one tomorrow is **"tomorrow at 7:30 PM"**, and only past
that does the weekday come back — **"on Friday at 7:30 PM"**. A midday game today is "today at
12:00 PM" rather than "tonight". The day is decided in the house's own zone, from
**Settings → Clock → Timezone** (the container's zone when that is unset).

Which game is meant is worked out, not assumed. The team in the sentence is matched against
every team the sensors carry — full name, short name, nickname, ESPN abbreviation — with the
league named in the sentence weighted first and sports-ticker's own favourite team after it, so
"the Bills" resolves from the scoreboard, "the Knicks" from the standings and "Georgia" from the
poll. A question that names no team and no league is answered with the games on now and the
games coming up, which is what "any games on?" is asking.

**Nothing has to be exposed to Assist for this to work.** The reader calls the same Home
Assistant REST API the catalogue uses (`GET /api/states`, cached for 30 seconds) with the token
already in Settings → Home Assistant, and reads the sensors directly — the Assist exposure list
never enters into it, so there is no entity to tick and no intent for Home Assistant to route.
What it reads, for every league enabled in sports-ticker:

| Entity | What it contributes |
| --- | --- |
| `sensor.espn_<league>_scoreboard_raw` | today's games: the `events` attribute |
| `sensor.espn_<league>_scoreboard_delayed` | the same, held back by the spoiler delay |
| `sensor.espn_<league>_standings_raw` | the table — the generic profiles (nba, wnba, nhl, mls, epl, laliga, bundesliga, seriea, ligue1, ucl) and the NFL's own |
| `sensor.espn_<league>_next_game` | the favourite team's next fixtures, and the ones after it |
| `sensor.espn_college_football_rankings` | the AP, coaches and CFP polls |

`<league>` is the code in the entity id: `nfl`, `cfb`, `mlb`, `nba`, `wnba`, `nhl`, `mls`, `epl`,
`laliga`, `bundesliga`, `seriea`, `ligue1`, `ucl` — `seriea` and `ligue1` without an underscore,
which is what the integration actually names them. A sensor whose league is not enabled in
sports-ticker simply is not there, and questions about it are forwarded as before.

**A "when do they play next" question needs the schedule sensor**, and that sensor follows one
team per league: the *Favorite Team* set for that league in sports-ticker. It exists for every
team league (nfl, cfb, mlb, nba, wnba, nhl, mls, epl, laliga, bundesliga, seriea, ligue1, ucl),
so a house that follows the Raptors reads `sensor.espn_nba_next_game`, with the fixture, the
opponent, the venue and the games after it as attributes. Two consequences worth knowing: a
question about a team that is not the league's favourite is forwarded rather than answered with
somebody else's fixture, and the answer says the venue only for an away game — a home game is
played in their own building, so naming it adds nothing. When no schedule sensor answers, a game
on today's scoreboard that has not started yet still does.

The answer separates "playing now" from "next": "when are they playing" during a game is the
live score, while "when's the next game" still means the fixture after it.

The spoiler delay is honoured by default: when sports-ticker is holding a game back, the
delayed scoreboard is read in preference to the raw one, so asking out loud cannot give away a
game that is being watched on a delay. **Settings → Sports → *Spoiler delay*** turns that off
for a house that would rather have the live score.

Set it up in **Settings → Sports**, and it is already on: *Answer sports questions locally* is
the switch, *Leagues* narrows the reader to the leagues you care about when a house carries
many, and the cache and timeout fields decide how often the sensors are re-read and how long a
slow Home Assistant may take. Or set `SPORTS=0`, `SPORTS_LEAGUES=nfl,epl` and
`SPORTS_SPOILER_DELAY=ignore` and skip the form.

What it deliberately does not do: **box scores and player stats** (they are not on the
sensors, so they are forwarded), **a schedule for a team that is not a league's favourite** (the
next-game sensor follows one team per league, and nobody else's fixture is substituted),
**a sport nothing is enabled for**, and **a team the sensors do not carry** — an unreadable or
missing sensor answers nothing and the question goes to your model, so sports can never be the
reason a turn breaks.

### Travel time

"How long to get to the airport?" is a `get_route` call, not something to reason about. The
[Tools for Assist](https://github.com/skye-harris/llm_intents) integration registers that tool
with Home Assistant's LLM API, so the proxy reads the sentence as the call it is and sends
`get_route` itself — destination, the journey the sentence named, and `departure_time` left out
so Google answers for right now. No model turn is spent on working that out.

| Said | Asked of Home Assistant | Spoken |
| --- | --- | --- |
| "how long to get to the airport?" | `get_route {destination: "the airport"}` | "It's 24 min to London Stansted Airport, 14.2 miles." |
| "how long does it take to drive to Tesco?" | the same, with `mode: "DRIVE"` | the driving time, with traffic |
| "how long to walk to the shops?" | the same, with `mode: "WALK"` | "It's 18 min to the shops, 0.9 miles." |
| "how far is it to the station?" | the same | the distance, since the route carries it |

**Nothing about a journey is cached, here or there.** The integration caches the Places lookup —
which address "the airport" means — and its YouTube searches; the route itself is fetched from
Google Routes on every call with `routingPreference: TRAFFIC_AWARE`, so for driving and two
wheels the duration already includes live traffic, and a future `departure_time` would return
predicted traffic. The proxy adds no layer on top: there is no travel cache to configure,
anything that reads as a question is refused by the decision cache (`src/decidecache.ts`) so it
can never be replayed from a previous turn, and every response leaves with `cache-control:
no-store`. Two identical questions a minute apart are two Google calls and two honest answers.

A destination is the words that came after "to": a name, not a paragraph, and never something in
the house — a sentence naming an entity or an area ("how long has the hall light been on?") is
left to the model, because a route to a lamp is not a route. When Google has nothing, the round
says nothing rather than inventing a journey.

`Settings → Travel time → Answer travel questions locally` turns the fast path off, and **Default
journey** picks the mode for a question that does not name one — a question that does say
"walking" or "by bus" always wins. A journey that needs a departure time ("… tomorrow at eight")
is forwarded, so the model can fill `departure_time` in itself. Or set `TRAVEL=0` and
`TRAVEL_MODE=WALK` and skip the form.

#### The rest of the suite

Tools for Assist also registers `search_web`, `find_places`, `get_weather_forecast`,
`search_wikipedia`, `search_youtube`, `play_video`, `calculate`, `unit_convert`,
`get_device_history_context` and `calendar_day_info`, plus a Home Control clone of the Assist API.
Home Assistant runs all of them, so nothing here needs to know they exist: the calls arrive as
ordinary tool calls, the results are live answers, and nothing is cached.

Five of them can also be asked for by name, before a model turn is spent on the question:
`calculate`, `unit_convert`, `search_wikipedia`, `search_web` and `find_places`. Settings →
**Search, sums and conversions** turns that on and off (or `SUITE=0`).

| Said | Asked of Home Assistant | Spoken |
| --- | --- | --- |
| "what's 12 times 8?" | `calculate` with `12*8` | "That's 96." |
| "what is 15% of 240?" | `calculate` with `15*0.01*240` | "That's 36." |
| "how many grams in 8 ounces?" | `unit_convert`, ounce → gram | "8 ounces is 226.8 grams." |
| "convert 2 cups to ml" | `unit_convert`, cup → ml | "2 cups is 473.2 ml." |
| "search wikipedia for Alan Turing" | `search_wikipedia` | the model, from the summary |
| "search the web for the FA Cup final" | `search_web` | the model, from the results |
| "find the nearest pharmacy" | `find_places` | the model, from the places |

The last three answer in prose — a paragraph, a list of shops — so the round that carries the
result is handed to the model rather than announced as "Done with search_web". Only a result the
proxy can say in one true sentence is said locally.

An arithmetic sentence has to *be* arithmetic to be read here: the whole expression has to reduce
to digits, `+ - * / % **` and brackets, because that is all the integration's calculator accepts.
"how much is a pint of milk?" is not a sum and is forwarded. A sentence that names a device in the
catalog is never sent to a search engine, and a place is only looked for when the sentence asks for
one nearby. The other tools — `get_weather_forecast`, `search_youtube`, `play_video`,
`get_device_history_context`, `calendar_day_info` — take arguments only the model can put together
(a date range, a video URL from a previous search), so they stay with the model.

The Home Control clone is a second way to turn a lamp on; it is not required, and the proxy makes
no use of it. With both installed, Home Assistant offers the same intents twice and the fast path
uses whichever copy it finds first.

### Music

"play Taylor Swift" is a request with the speaker missing, the media type missing and the
provider missing — and all three are worked out rather than asked about. The speaker is the one
that was spoken to, the media type follows from the shape of the sentence, and
[Music Assistant](https://music-assistant.io/) resolves the name against every provider you
connected to it. No model call is involved, so the music starts in the time the round trip
takes.

| Said | Played |
| --- | --- |
| "play Taylor Swift" | the artist, which every provider plays as their top tracks |
| "play Taylor Swift's greatest hits" | the same — the shelf has a different name per provider, the artist is the same |
| "play Don't Tap The Glass by Tyler The Creator" | the album, with the artist sent alongside it so two albums of one name cannot be confused |
| "play the album Don't Tap The Glass" | the album, because the sentence says so |
| "play the song Bad Guy by Billie Eilish" | the track |
| "play the playlist Deep Focus" | the playlist |
| "play radio station BBC Radio 4" | the station |
| "play some jazz" | the genre, which every provider keeps as a shelf |

**The words around the request.** A satellite keeps listening after the request, so the sentence
arrives with the nod that follows it: "play Taylor Swift. Yeah." is one request and one
confirmation. The confirmation, the thanks and the hesitation are cut off the end before the name
is searched for — otherwise the provider is asked for a band called "Taylor Swift. Yeah" and finds
nothing at all. Only trailing words go, and never the last word left standing, so a song actually
called "Yeah" is still played. This is a rule and not a model call, which keeps music free of
latency; a request that is messy in some other way is still better forwarded, and that is what
happens when the reader cannot make a clean name out of it.

**Which speaker.** The device the sentence was spoken to — Home Assistant names it in the
request — is found in the catalog through the speaker that belongs to it, so "play Taylor Swift"
in the kitchen plays in the kitchen. A speaker or a room named in the sentence wins over that
("play Taylor Swift on the living room speaker"), and a house with exactly one speaker needs no
device id at all. In a room with a television in it, the television is passed over for a
speaker: music does not start on the TV because the TV happened to be exposed. A room named in
the sentence is a room, not a television that happens to carry its name — "play Taylor Swift in
the living room" plays on the speaker in the living room even when the TV there is called "Living
Room TV". A room whose *only* players are televisions is not a question either: the television
already on plays, and that is the same call your model would have made. Two speakers in that room
with nothing to choose between them stay a question instead of a guess, and music for two rooms
becomes one call per room. When the house has several speakers and the request names neither a
speaker nor a room, the sentence is left to your model rather than played in a room nobody asked
for — and the trace says so, with the music error in its reason. The words that named the room
are dropped from what is searched for — a sentence that says "in the kitchen" is not looking for
a band called "in the kitchen".

**Where "here" is.** A voice satellite usually has no exposed entity of its own, so the
catalog's entities cannot say which room it hears you from. The device registry can, and it is
read for exactly that: the request names the device that took the sentence, that device's area
is the room, and the room's speaker is where the music goes. A device with no area falls back to
*Default area* in Settings → Home Assistant catalog. Nothing has to be exposed for this — but the
satellite and its player do need their area set in Home Assistant, and the catalog needs
reloading (Settings → Home Assistant catalog → *Refresh*, or a restart) after they are.

If no device is named — or the named device has no area — the default area is used, and it is
used only if it holds a real speaker: an area whose only players are televisions does not put
music on the TV while the house has one speaker somewhere else, because a default area is a
fallback and not an instruction. The reason on the trace says which of the two decided. The
debug export carries what a wrong room needs: `requestFields` is the list of fields Home
Assistant actually sent (whether `device_id` is among them is the whole question), each trace
entry carries the `device` it named, and `catalog.devices` is the device registry the room came
from.

**Shuffle.** "shuffle Tyler the Creator", "play Taylor Swift on shuffle", "put some jazz on
random": the word says how to play, not what to play, so it is taken out of the sentence and
sent as a boolean, alongside `media_id`, `media_type` and the room. `shuffle` is sent whether or
not you asked for it, `false` included: a script that reads its own `shuffle` variable gets Home
Assistant's *template helper* of the same name when nothing is passed, and then fails the whole
run with `invalid boolean value <bound method …shuffle…>` after the music has already started.
A plain "shuffle" with nothing to play is not a request — that one still goes to your model,
which can turn shuffle on for whatever is playing.

**A kiosk music script.** A script built from the Kiosk Satellite music blueprint is recognised
by its shape rather than its name — an `action` slot that offers `play`, a `query` slot and a `kind`
slot — and it is asked first, ahead of Music Assistant, because it knows where its own tablet
plays. It is sent `action: play`, the words as `query`, the kind only when the sentence said one
(`kind: album` from "play the album Punisher"; a genre is not one of the blueprint's kinds, so a
genre is left out), the artist when one was named beside the title, and `speaker` when a room was
named or the device that heard the sentence is set to one. An empty `speaker` means "where this
kiosk plays", so nothing has to be exposed in that room and no player is chosen here at all.
`mode` follows Settings → Music — `replace`, `next` or `add`, and `radio` for a bare artist when a
bare artist plays a radio station. "Pause", "skip", "go back", "volume up" and "volume down" are
its `pause`, `next`, `previous`, `volume_up` and `volume_down` actions, sent with `speaker` the same
way. "Shuffle Taylor Swift" is `action: play` plus `shuffle: true`, sent only to a script that has
a `shuffle` slot, and only when you asked — a script reading a slot it was never given gets Home
Assistant's template helper of that name and fails on it. "Stop" is sent as `action: stop` only to a
script whose `action` slot lists `stop`: the blueprint does not, so stopping the music still goes to
a player, or to your model when no player is exposed — a script you wrote yourself that lists
`stop` gets it. The script alone is enough for music: with it exposed, no media player has to be.

**Which service.** Four, in this order, after a kiosk music script (which is asked first whenever
the request offers one). Music Assistant's own `play_media` service first,
because it searches every provider at once and knows the difference between an artist, an album
and a track. Then a script of yours that plays music — Home Assistant offers exposed scripts as
tools, and `script__play_music` is what people write when the generic service will not start
music on their speakers; a script is recognised by taking a media id *and* a media type, and it
is sent `media_id`, `media_type`, `artist` and the room, plus `action: play`. Then the player's
own play service (`media_player.play_media`), which every Music Assistant player answers as well
— this is what a house where Music Assistant is reached only through its players offers, and it
takes the same name and media type. Last, Home Assistant's own media search
(`HassMediaSearchAndPlay`), which takes the name and the artist as one search string.
Settings → Music → *Which service plays* pins one of the four.

A service that takes the room rather than a player — the script, or Music Assistant asked by
area — needs no exposed speaker to play in a room: "play Taylor Swift in the bedroom" plays in a
bedroom where nothing but lights are exposed, because the service finds the players itself. The
room has to exist in Home Assistant, though, and a room that exists but has nothing exposed in
it is only playable through such a service.

**What to expose.** Music only starts if Home Assistant gives the conversation agent something
that plays. In Settings → Voice assistants → *Expose* tab (or by entity), expose:

- the speakers you say "play" to — including the Music Assistant player of your voice satellite,
  which is where "play it here" lands; a player with no area cannot be found by room, so give the
  speaker an area in its device settings;
- the media players you would accept music on, as entities of the `media_player` domain. A
  television that is exposed but is not the target is passed over, not chosen;
- the `play_media` service among the tools Home Assistant offers the agent — a media player's
  own `media_player__play_media`, `music_assistant__play_media` when Music Assistant is
  installed, or a script of your own that takes a media id and a type (`script__play_music`).
  These are the names in the debug export's `toolsOffered`; without one of them every music
  sentence is forwarded. Music Assistant's service is preferred when several are offered, a
  script comes next, and Home Assistant's own media search is the last resort — it only searches,
  so it is never used as the play path.

Nothing else needs exposing: the proxy reads the sentence, so no music entity has to be in the
prompt. If the debug export's `toolsOffered` has no play service at all, every music sentence goes
to the model — that is the one exposure a "play" request cannot work without.

**What happens to the queue** is a setting too: replace and play (the default), play next, queue
after the current track, clear what is queued after this, or add to the end. An artist can be
asked for as a radio station instead of their top tracks. Set `MUSIC=0` to hand every music
request back to your model, or `MUSIC_PROVIDER`, `MUSIC_ENQUEUE` and `MUSIC_ARTIST` instead of
using the form.

What it deliberately does not do: **"play" with nothing to play** ("play some music", "play the
next song") is a playback command, not a search, and goes to your model; and a request with no
speaker to play on — several speakers, no device id — is forwarded rather than guessed at.
Nothing is said after the call either: the music starting is the answer, so `music_assistant`
sits in the default silent speech rules next to `media_player`. Settings → Speech → *Rules*
changes that if you would rather hear what is playing.

### Pause, skip and the television

Once something is playing, "pause", "stop", "next song", "volume up" are commands with no names
in them: the player is the one already playing, or the one in the room the sentence mentions,
and the sentence is turned into Home Assistant's own media intent with no model call.

| you say | what happens |
| --- | --- |
| pause | `HassMediaPause` on the player that is playing |
| stop the music | `HassTurnOff` on that player — a pause that stays paused is not a stop |
| next song / go back | `HassMediaNext` / `HassMediaPrevious` |
| volume up / turn it up a lot | `HassSetVolumeRelative` with a step of 13, or 25 for "a lot" |
| mute / unmute | `HassMediaPlayerMute` / `HassMediaPlayerUnmute` |
| turn the TV on / off | `HassTurnOn` / `HassTurnOff` on the television |

Music Assistant registers a media player for every speaker it plays on, so pausing that entity is
pausing Music Assistant — there is nothing Music Assistant-specific to configure. Which player a
bare "pause" means is decided the same way music is: the player the sentence names, or the room it
names, then the player on the device that was spoken to, then the room it was spoken in, then
whatever is playing. Two players playing at once, neither of them Music Assistant's, is forwarded
to the model rather than guessed at, and the trace says so.

Volume is always relative: "volume up" is louder than it was, not a level, because a level nobody
asked for is a worse guess than a step. A bare "pause" with nothing playing is not a media command
at all and keeps its old route — but volume and mute are allowed, because setting the level before
the music starts is a normal thing to ask for.

The television needs the word in the sentence: "turn the TV off" is ours, "turn it off" is not,
because only your model knows what "it" is. "Turn off the lights" belongs to the lights. A named
television wins ("switch off the Living Room TV"), then the one in the room that was mentioned,
then the only television in the house.

**What to expose:** nothing new. These are the `Hass*` intents Home Assistant offers every Assist
agent — `HassMediaPause`, `HassMediaUnpause`, `HassMediaNext`, `HassMediaPrevious`,
`HassSetVolumeRelative`, `HassMediaPlayerMute`, `HassMediaPlayerUnmute`, `HassTurnOn` and
`HassTurnOff` — and every one of them is already in the debug export's `toolsOffered`. What
matters is the catalog: the Music Assistant player has to be exposed to Assist and has to know its
room, because the choice between two players is made from state and area. A television you want
switched has to be exposed as a `media_player` too. Set `MEDIA=0` to hand all of it back to your
model.

### Reminders

[ha-reminders](https://github.com/ksmarty/ha-reminders) teaches Home Assistant to remember
things, and it offers the conversation agent five tools: create, list, complete, snooze and
delete. "remind me to take out the trash in 30 minutes" needs none of your model to answer —
the sentence names a title and a time, so the proxy fills the slots itself and calls the tool
in the time the round trip takes. The same is true of a time of day, a place, and the four
sentences that manage an existing list.

| Said | Called |
| --- | --- |
| "remind me to take out the trash in 30 minutes" | create, `title` and `minutes` |
| "remind me to water the plants at 7 am" | create, `title` and `time` — a daily reminder |
| "remind me when I get home to unpack the shopping" | create, `title`, `direction: enter`, `zone` |
| "remind me to unpack the shopping when I leave work" | create, `title`, `direction: leave`, `zone` |
| "list my reminders" | list, nothing to fill |
| "complete reminder unpack the shopping" | complete, `title` |
| "snooze reminder unpack the shopping for 10 minutes" | snooze, `title` and `minutes` |
| "delete reminder number 2" | delete, `number` |

**What is converted rather than passed through.** The integration reads a time as `8 pm` or
`20:00` and a number as a digit or a word, so a phrase it would refuse is turned into one it
accepts: "half an hour" becomes `30`, "an hour" becomes `60`, "twenty minutes" becomes `20`,
"noon" becomes `12:00`, "quarter to 9 pm" becomes `20:45`, and a bare "at 8" becomes the next
eight o'clock on the clock the proxy already keeps for time questions. The split is at the last
" in " or " at ", so a title keeps its own words: "check in at the hotel at 9 pm" reminds about
"check in at the hotel", and "email Dr. Chen about the invoice" keeps its capital letters,
because a title is spoken back in a notification.

**When it is left alone.** A reminder with no time and no place — "remind me to call the
plumber" — is forwarded, because the integration needs a trigger and your model can ask which
one was meant. Nothing at all changes when Home Assistant does not offer the tools, and
Settings → Reminders → *Read reminder sentences here* turns it off for a house that would rather
the model read them.

**What is said afterwards** is the integration's own sentence — "Got it. I will remind you to
take out the trash in 30 minutes." — because it is the handler that knows whether it created the
reminder or updated one that was already on the list. A house that would rather hear nothing can
add a silent rule for `ha_reminders.*`; the default rules are about devices and leave it speaking.

### Timers

Home Assistant keeps the timers itself. Its conversation integration registers
`HassStartTimer`, `HassCancelTimer`, `HassCancelAllTimers`, `HassIncreaseTimer`,
`HassDecreaseTimer`, `HassPauseTimer`, `HassUnpauseTimer` and `HassTimerStatus`, and whatever
conversation agent it hands those to can start one per tool call. No blueprint and no
integration are needed for that, and nothing here speaks to a timer entity: a timer belongs to
the device that was spoken to, not to the house.

That is also what makes it work with [kiosk-satellite](https://github.com/jxlarrea/kiosk-satellite):
its built-in Voice Satellite registers as a timer device with Home Assistant, so the timers this
proxy starts ring on the kiosk that asked, appear in its own **VS Timers** list, and are the same
timers its on-screen pause/resume controls act on. Its spoken timer sentences are the ones below.

| Said | Called |
| --- | --- |
| "set a timer for 10 minutes" | `HassStartTimer`, `minutes: 10` |
| "set a pasta timer for 8 minutes" | `HassStartTimer`, `minutes: 8`, `name: "pasta"` |
| "set a timer for an hour and a half" | `HassStartTimer`, `hours: 1`, `minutes: 30` |
| "set two timers for 5 and 10 minutes" | two `HassStartTimer` calls in one reply |
| "set three timers for 4 minutes" | three calls, the same length each |
| "pause the pasta timer" / "resume the pasta timer" | `HassPauseTimer` / `HassUnpauseTimer` |
| "add 2 minutes to the pasta timer" | `HassIncreaseTimer`, `minutes: 2` |
| "take 30 seconds off the pasta timer" | `HassDecreaseTimer`, `seconds: 30` |
| "cancel the pasta timer" | `HassCancelTimer` |
| "cancel all timers" | `HassCancelAllTimers` |

**The split is the identity.** Home Assistant stores only the slots a start call carried — a
"10 minutes" timer is `start_minutes: 10` with no hours and no seconds — and it finds a timer
later by matching that exact triple. So a control call has to replay the same split, which is
why "add 2 minutes to the 10 minute timer" sends `start_minutes: 10` and not `minutes: 10`. The
proxy keeps the timers it started, per device, for the life of the process, so a split that was
spoken differently is replayed the way it was created; when the sentence names no timer at all
and only one is known to be running, that one is meant. A restart empties that memory and the
call goes out with no slots, which is exactly what kiosk-satellite does: Home Assistant then
falls back to the only timer of the device.

**Several at once** is one reply with several calls, because Home Assistant executes every call
in an answer, in order. Two timers in one sentence of different lengths, a count of the same
length, or two names with two lengths ("set a pasta timer for 8 minutes and a rice timer for 12
minutes") all become one turn. Two timers of this kiosk's running and neither named is a
question rather than a guess — which one, listed the way they were started.

**When it is left alone.** "What timers are running", "how long is left on the pasta timer" and
anything else that asks for state is forwarded: only Home Assistant's `TimerManager` knows, and
its answer is slots rather than a sentence. A bare "pause" with no timer anywhere in the
sentence stays the media reader's, so pausing the music still works. Nothing changes when Home
Assistant does not offer the timer tools, and Settings → Timers → *Read timer sentences here*
(or `TIMERS=0`) turns the whole reader off for a house that would rather the model read it.

**What is said afterwards.** Home Assistant speaks for itself when it cancels every timer and
when it reports status; the other six intents return no sentence at all, so the proxy composes
one from the call — "Set pasta timer.", "Paused pasta timer.", "Extended 10 minutes timer." A
house that would rather hear nothing can add a silent rule for `timer.*`; the default rules are
about devices and leave the timers speaking.

### Messages

"Text Sarah that I'm running late." [ha-bluebubbles](https://github.com/helv-io/ha-bluebubbles)
sends iMessage, RCS and SMS through a BlueBubbles server, and it registers exactly one service:
`bluebubbles.send_message`, with `addresses` (one or more numbers or addresses, comma-separated)
and `message`. It registers **no assistant tool** — there is no `llm.py` in the integration — so
Home Assistant never offers the model anything to call, and a proxy that only builds tool calls
could only watch. This reader therefore *does* the thing instead of routing it: it reads the
sentence, resolves the name against a contact list kept in this proxy's own settings, calls the
service over the Home Assistant WebSocket with the `HA_URL` and `HA_TOKEN` the catalog already
uses, and answers the turn with a sentence.

| Said | Sent |
| --- | --- |
| "text Sarah that I'm running late" | `addresses: "+15551234567"`, `message: "I'm running late"` |
| "send a text to Mum saying the door is open" | the same shape, to Mum's number |
| "text Sarah and Mum that dinner is ready" | one message, both addresses |
| "message sarah@example.com I'll be late" | the address as said, no contact needed |
| "imessage +1 555 123 4567 that the cat is out" | the number as said |

**Contacts live here, not in Home Assistant.** The name is what has to be resolved and this is
what resolves it, so the list belongs in Settings → **Messages** — a row per person, a name and
the number or address it sends to. A helper entity in Home Assistant would need an automation to
stay in step with itself, and the service still takes addresses rather than entity ids. A name
resolves by the **whole name first**, then by its first word: "Sarah Bell" and "Sarah" can both
exist, and "Sarah" alone reaches Sarah. Two contacts whose first word is the same ("Sarah Bell"
and "Sarah Jones") make the house ask *"Who do you mean — Sarah Bell or Sarah Jones?"* rather
than pick one, and a name it does not know is answered with where to add it — never forwarded to
a model that might invent an address.

**Ask first** is on by default: the turn says *"Should I text Sarah “I'm running late”?"* and
sends on "yes", using the same armed question and time window as every other confirmation
(`SPEECH_CONFIRM_SECONDS`, 90 s). Turn it off for one-step sending. **What is said afterwards is
what happened**: "Sent it to Sarah." only once the service returned; a refusal or a timeout is
spoken as *"I couldn't send that to Sarah: <the reason>"*, because a message that did not go out
must never sound like one that did.

**When it is left alone.** The reader is off by default (`MESSAGING=1`, or Settings → Messages →
*Read message sentences here*) so a house that never sends anything is untouched. A sentence it
cannot finish — an unknown name, two Sarahs, a service setting that is not `domain.service`, a
contact with no address — is answered or forwarded rather than half-sent. Nothing about a message
is cached: the body is taken from the sentence as said and the call goes out on the turn.


The catalog asks Home Assistant which entities are exposed to the conversation agent
(`homeassistant/expose_entity/list`) and lists only those, because that is the same list the
voice assistant works from — the decision model then sees what can actually be acted on instead
of every sensor in the registry. The refresh result says exactly what happened:
`12 of 348 entities exposed to Assist, 5 areas`.

If a core does not answer that command, the whole registry is listed instead and the note says so.
Settings → Home Assistant catalog → **Only what Assist can see** turns the filter off when you want
the decision model to know about everything (useful for read-only questions about sensors).

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

## Speech after a tool call

`Settings → Speech → After a tool runs` decides what Assist says once Home Assistant has run the
intent:

- **Speak it locally (fastest)** — template sentences, no second model call.
- **Let the model phrase it** — the tool result goes back to your model server for prose.
- **Say nothing** — no second model call and no speech. Assist speaks whatever text comes back, so
  this sends `speech.silence` instead of an empty string; the default is `[pause:1.5s]`, which the
  speech pipeline renders as silence. Change it if you want a longer or shorter pause.

### Per-intent speech

One setting for every intent is too blunt: turning a lamp on does not need narrating, adding milk to
a shopping list does. `Settings → Speech → Who gets a reply` is a table of rules, top to bottom,
first match wins, and each rule matches one of:

| Written as | Matches |
| --- | --- |
| `HassTurnOn` | that intent, whatever domain it acts on |
| `todo.add` | one domain and action pair |
| `light` | every action on that domain |
| `turn_on` | that action on every domain |
| `todo.*` | every action on that domain (a trailing `.*` is a prefix) |
| `get_route`, `llm_intents__get_route` | a tool from the Tools for Assist integration, by its own name or by the name Home Assistant offers it under |

Matching is case-insensitive and applies to the call the proxy issued, not to the sentence. Each rule
then does one of three things:

| Then | What Assist says |
| --- | --- |
| **Speak it** | Home Assistant's own response, or the template — the default behaviour, forced for this call |
| **Stay quiet** | nothing; `speech.silence` is sent so no TTS job starts |
| **Say this…** | your sentence, with `{action}`, `{entity}` and `{item}` filled in — e.g. `{action} the {entity}.` becomes "Turned on the Desk Lamp.", and `{action} {entity}.` for `todo.add_item` becomes "Added Milk to Shopping List." |

**Speak it** and a custom sentence both override *Stay quiet* as the default, which is how you keep a
shopping list audible in an otherwise silent house. Anything with no matching rule follows
`Default when nothing above matches`.

Order matters, so each rule carries its own controls: the arrows move it up or down the list, and the
bin removes it after asking — a rule list is a small, hand-made thing and losing one by mis-tapping a
phone should not be possible.

The shipped default silences the on/off domains — `light`, `switch`, `fan`, `cover`, `climate`,
`media_player` — and leaves everything else speaking, so a fresh install is quiet about the house
and talkative about lists, scenes and the vacuum. A trace reads `silent by rule (…, sent
"[pause:1.5s]")` when a rule fired, and `1 of them silent by rule` when only part of a round was
silenced.

**Speak it** is honoured even when the call was the model's, not the proxy's. A forwarded request
replays the whole round — the assistant's tool call and Home Assistant's result — and that round
used to be identified from an announcement the proxy had no descriptor for, so a rule set to
*Speak it* fell through to the quiet default and answered with the silence marker. Now the round
is read from the announcement, the rule matches, and the sentence is built from the tool result:
a route is spoken locally, and a tool whose result nobody here can phrase (a web page, a
forecast) is handed to the model instead of being silenced. A rule that asks for speech never
produces `[pause:1.5s]`.

## Answering a state question

"Is the desk lamp on?" never reaches a model: the catalog holds the state, so the proxy answers it
itself in about two milliseconds. A question with a yes in it gets a yes, because that is how a
person answers:

| You say | Assist says |
| --- | --- |
| is the front door locked? | Yes, it's locked. |
| is the back door locked? | No, it's not locked. |
| is the office blind open? | Yes, it's open. |
| what is the office temperature? | The Office Temperature is 21.5 °C. |

The four sentences come from `Settings → Speech → Templates`, per language, next to the three that
surround an action:

| Slot | Default | Filled with |
| --- | --- | --- |
| `yes` | `Yes, it's {state}.` | `{state}` is the word that was asked, `{entity}` the name, `{actual}` the state itself |
| `no` | `No, it's not {state}.` | the same three placeholders |
| `state` | `The {entity} is {state}.` | the plain answer when the question was not polar |
| `unknown` | `I can't read the state of the {entity} right now.` | an entity that is not reporting |

So `No — {entity} is {actual}, not {state}.` becomes "No — Back Door is unlocked, not locked.", and
a language you add starts from the English wording so nothing is ever blank. A yes is only spoken
when the state really contradicts or confirms the word asked: `on`/`off`, `open`/`closed`,
`locked`/`unlocked`, `playing`/`paused`, `home`/`away` and `running`/`stopped` are the pairs. Ask
"is the deadbolt open?" of a lock that reports `jammed` and you get the plain sentence instead of a
guess, and an entity that is `unavailable` is never a yes.

The subject of the question may be looser than the entity's name: "is the door locked?" finds a lock
called *Front Door* (and an entity aliased `door`) because it is the only one that can answer
"locked", while a *Door Sensor* reading `off` is left alone. Two candidates that both fit is still a
forward — the proxy does not pick the nearer lock.

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

A turn that gets spoken back is two calls to the proxy — the decision, then the follow-up carrying
the tool result — so the trace shows them as one row: the reply is nested under the turn it answers,
under **What was said back**, tagged with where the words came from (*spoken by the model* for a
round the proxy forwarded) and how long that round trip took.

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

## Where the time goes

A spoken command costs, in order: the catalog (cached), the question set (a few milliseconds), the
decision call, and — only if the proxy declines — your model server. Three things keep the first
three small:

- **The catalog is built in the background.** A timer refreshes it every half cache-window, so a
  request finds it warm instead of paying the Home Assistant round trip (40–100 ms) before it can
  start deciding. The last good catalog is also written to `data/catalog.json`, so the first
  command after a restart is answered from it while a fresh one is built behind that request.
- **Nothing is decided that does not need deciding.** A plain state question ("is the desk lamp
  on?") is answered from the catalog in about two milliseconds, "nevermind" ends the turn with
  `HassNevermind` without either call, and a conversational aside ("no you", "ignore that") goes
  straight to your model server instead of costing a decision call.
- **The catalog is narrowed to what Assist can see.** Exposure is read from Home Assistant, so 19
  exposed entities reach the model instead of 356 — roughly 33 000 input tokens become a couple of
  thousand, which is the single largest latency lever on a hosted decision model.
- **A repeated sentence is not decided twice.** With `decision.cache` on (the default) the answer for
  an identical command is reused with no model call: a repeat costs single-digit milliseconds instead
  of the 300–900 ms round trip. Nothing expires on a clock — the key carries a signature of the
  exposed entities (their ids and rooms, never their state), so turning a light on cannot invalidate a
  decision, while adding, removing or re-exposing an entity does. Questions are never cached, because
  their answer *does* depend on live state. The cache is written to `data/decision-cache.json`
  (`decision.persistCache`), so a container restart or update does not pay for the same decisions
  again. A trace shows `cached decision` when a hit happened.

What remains is the model you chose. If a turn still feels slow, look at the trace: `catalogMs`
should be 0, `questionsMs` single digits, and `decideMs` is your provider. Lower `decision.historyTurns`
to 0 to drop the conversation history from the state, and narrow what Home Assistant exposes to
Assist — every entity removed is tokens off every request.

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
| `LISTENING` | `1` | `0` stops judging whether a sentence was addressed to the assistant, so every turn is forwarded again |
| `LISTENING_LOCAL` | `1` | `0` keeps the decision model's judgement but drops the local pattern reader for turns no model saw |
| `LISTENING_CONFIDENCE` | `0.75` | how sure the judgement has to be before a turn is answered with silence |
| `CLOCK_TIMEZONE` | *(empty)* | the IANA zone "what time is it?" is answered in; empty uses Home Assistant's own prompt clock, then the container's |
| `WEATHER_API_KEY` | *(empty)* | a Pirate Weather key; empty switches the weather feature off entirely |
| `WEATHER_LATITUDE` / `WEATHER_LONGITUDE` | *(empty)* | where the forecast is for; empty reads Home Assistant's `zone.home` |
| `WEATHER_UNITS` | *(auto)* | `si`, `ca`, `uk` or `us`; `auto` follows the locale of each request |
| `WEATHER_LANGUAGE` | *(empty)* | pin the language of the summaries; empty follows each request |
| `WEATHER_STYLE` | `current` | what the answer says: `summary`, `current`, `full`, `temperature_first` or `natural` |
| `WEATHER_BASE_URL` | *(empty)* | only for a self-hosted or mirrored service |
| `SPORTS` | `1` | `0` hands sports questions back to your model |
| `SPORTS_LEAGUES` | *(empty)* | league codes to read (`nfl,epl`); empty reads every league the sports-ticker sensors carry |
| `SPORTS_SPOILER_DELAY` | `respect` | `respect` reads the delayed scoreboard when sports-ticker is holding a game back; `ignore` always reads the raw one |
| `TRAVEL` | `1` | `0` hands travel questions back to your model |
| `TRAVEL_MODE` | `auto` | `auto` keeps whatever mode Home Assistant is set to; or `DRIVE`, `WALK`, `BICYCLE`, `TRANSIT`, `TWO_WHEELER` |
| `SUITE` | `1` | `0` hands sums, conversions, web and Wikipedia searches and nearby places back to your model |
| `MESSAGING` | `0` | `1` reads "text Sarah that I'm running late" and sends it through ha-bluebubbles itself |
| `MESSAGING_CONFIRM` | `1` | `0` sends without asking first |
| `MESSAGING_SERVICE` | `bluebubbles.send_message` | the `domain.service` a message is sent with |
| `MESSAGING_CONTACTS` | *(empty)* | contacts as `Name=+15551234567`, separated by `;` or newlines — afterwards editable in Settings → Messages |

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
- **Media search grammar** beyond a simple "play X on Y" query slot.
- **A reminder with no time or place** — "remind me to call the plumber" needs a trigger the
  proxy will not invent, so it is forwarded.
- **Timer status** — "what timers are running" and "how long is left" are forwarded, because only
  Home Assistant's timer manager knows and its answer is slots rather than a sentence.
- **Script/template field filling**, `set_mode`, and MQTT-specific actions — forwarded.
- **The time in another timezone** — "what time is it in Tokyo" is forwarded, since the proxy
  only knows the time in this house.
- **A sports question the sensors cannot answer** — a box score, a player's stats, or a team no
  enabled league carries is forwarded, because sports-ticker publishes games, not play-by-play.
- **A journey that needs a departure time or a waypoint** — "how long to get to Leeds tomorrow at
  eight" and "… via Sheffield" are forwarded, because `get_route` takes one destination and the
  proxy will not guess the rest.
- **A message with an attachment, a group chat, or a reply into an existing thread** —
  `bluebubbles.send_message` also takes `attachment`, `media_url` and `chat_guid`, and the reader
  fills only `addresses` and `message`, so those are forwarded.
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
`src/heuristic.ts` answer it, `src/addressee.ts` reads whether a sentence was meant for the
assistant at all, `src/router.ts` turns answers into a plan under the gates,
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
