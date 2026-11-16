---
type: "Reference"
title: "Fast paths"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-c28b716c91b31ea74e600c17
    resource: repo://src/answer.ts
  - id: openwiki-source-6c5d6eabe9ccde96b2f07317
    resource: repo://src/media.ts
  - id: openwiki-source-7449e12ebddc40090d1c1689
    resource: repo://src/music.ts
  - id: openwiki-source-d62dc78a6b92f64549736a16
    resource: repo://src/pipeline.ts
  - id: openwiki-source-1ed905ee4568fe97ae7c9f39
    resource: repo://src/reminders.ts
  - id: openwiki-source-9da6594296f4b30b9cdfad4c
    resource: repo://src/router.ts
  - id: openwiki-source-39940bc5a8d865123adea2e5
    resource: repo://src/timers.ts
  - id: openwiki-source-f1e35494a847fb6dc74782ce
    resource: repo://src/toolcall.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Fast paths

Most of what a household says to the assistant is not ambiguous: "turn on the kitchen lights", "pause the music", "what time is it?", "set a timer for ten minutes". The proxy answers those itself, in one pass, with no decision model and no model call at all. These readers are the **fast paths**.

They share one rule: a reader may only act if Home Assistant actually offered the intent in the request's `tools`. A missing intent is not worked around — the reader declines, and the turn falls through to the next reader or upstream.

See [Request lifecycle](request-lifecycle.md) for the order of the whole turn and [Speech, turns and confirmation](speech-and-confirmation.md) for what is said afterwards.

## The offered-tools rule

`ToolInventory = Map<string, OpenAIToolFunction>` (`src/toolcall.ts:13`) is built by `inventoryFor(tools)` (`src/toolcall.ts:60`). Home Assistant namespaces tool names (`assist__light__HassLightSet`), so `shortToolName(name)` at `src/toolcall.ts:74` takes the text after the last `__`. `findTool(inventory, intent)` at `src/toolcall.ts:80` tries an exact key, then an equal short name, then a short name that ends with the intent. No match returns `undefined`.

`buildToolCall(input)` at `src/toolcall.ts:309` is the only place calls are made. It refuses with `` `${intent} is not offered by Home Assistant (${describeInventory(inventory)})` `` when the tool is absent; `describeInventory` at `src/toolcall.ts:302` says "it offered a, b … (+N more)" or "the request carried no tools at all". Slot values pass through `SLOT_ALIASES` (`:227`) and `levelForSlot` (`:200`), which clamps and scales 0-255 or 0-1 according to the schema's `maximum`. `targetArgs` at `src/toolcall.ts:249` sends `args.name = entity.id` (Home Assistant intent filters match an entity id passed as `name`), plus `area` or `floor`, and errors rather than guessing when a slot is missing.

`offeredName(inventory, intent)` at `src/router.ts:212` returns `findTool(...)?.name ?? intent`. Each reader declines differently when an intent is missing: `findTool` returns null in `src/reminders.ts:467` and `src/timers.ts:590`; `specFor` returns `{error}` in `src/media.ts:352`; the router forwards with `` `${INTENTS.getState} is not offered …` `` at `src/router.ts:312`.

`INTENTS` at `src/actions.ts:27-63` maps about 37 names to Home Assistant intents (`lightSet: 'HassLightSet'`, `timerStart: 'HassStartTimer'`, …). `ACTIONS` is `${domain}:${action}` → `ActionSpec` (`src/actions.ts:193`), reachable only through `specFor(domain, action)` at `:195`. The comment is the policy: "Anything missing is not something we execute."

`assistTools()` at `src/toolcall.ts:22` builds a permissive dry-run superset from `Object.values(INTENTS)` for tests and probes.

## Order of the readers

`runPipeline` at `src/pipeline.ts:277` tries them in this order, and each returns `null` ("not my sentence") or `{error}` (a trace note only), so the next reader still sees the sentence:

1. time question (`isTimeQuestion`)
2. weather (when `routing.enabled` and `weather.apiKey` are set)
3. `directStatePlan`
4. `reminderPlan`
5. `musicPlan`
6. `mediaPlan`
7. `timerPlan`
8. chatter / addressee

`fastPathStatus` at `src/pipeline.ts:251` explains readiness — "built-in heuristic (no model needed)". If `inventory.size === 0` the request is passed through.

`localCall` around `src/pipeline.ts:516` records route, action, tool and args, and increments `stats.toolCalls`.

### Compound sentences

`splitClauses(utterance)` splits a sentence and each clause is re-decided. Every clause must win (`calls.length === clauses.length`); otherwise the result is `compound request: at least one clause is not something the fast path can call`. Acting on half a sentence is worse than forwarding it.

## Actions

`POWER_DOMAINS` at `src/actions.ts:68-77`: light, switch, fan, climate, media_player, humidifier, water_heater and input_boolean get `turn_on`/`turn_off`; toggle exists only for light, switch and input_boolean.

Slots by domain:

| Domain | Action | Slot |
| --- | --- | --- |
| light | `light:set_brightness` | `brightness` or percent; `brighter`/`dimmer` relative |
| cover | `cover:set_position` | `position` |
| fan | `fan:set_speed` | `percentage`; `faster`/`slower` relative |
| climate | `climate:set_temperature`, `warmer`, `cooler` | `temperature` with `singleTarget: true` |
| media_player | `media_player:set_volume` | `volume_level`; `louder`/`quieter` as `volume_step` |

`INCREASING_ACTIONS`, `RISKY_ACTIONS`, `RISKY_DOMAINS` and `RISKY_DEVICE_CLASSES` (`src/actions.ts:337` onward) gate relative moves and unlock/open actions.

`relativeTarget` at `src/toolcall.ts:344` normalises brightness (level / 255), volume (× 100) and temperature (one decimal). `magnitudeStep` at `:374` turns slight/moderate/large/maximum into .1/.25/.5/1, halves it for volume and applies a floor of 5.

## Music

`readMusicRequest` at `src/music.ts:361` decides the kind from verbs and "not content" phrases.

`musicTarget` at `src/music.ts:529` picks the player by precedence: room named in the sentence → player named → the device the request came from → the spoken-to or default area → the only player in the house → error `no room to play in: …`.

`spokenAreaId` at `:440` reads `catalog.devices` because satellites expose no entity. Television handling is deliberate: `isTelevision` at `:463` and `speakersIn` (which returns TVs only when nothing else exists) feed the rule that a TV is never chosen just because it is the only player in the named room, with the reason "the only speaker in the house, as <area> has none".

`musicTool` at `src/music.ts:758` ranks providers: kiosk script (0), Music Assistant (1), a house script (2), `play_media` (3). Provider `assist` means no service — search instead.

The kiosk path is narrow on purpose. `kioskProfile` at `:722` needs an action slot offering `play` plus query and kind slots. `kioskArgs` sends `shuffle` only when the sentence asked for it, because Home Assistant's template globals otherwise supply a `shuffle` value the script never received, and sends `kind` only when the script lists it. `serviceArgs` at `:832` requires a media-id slot, sends an entity when there is one and an area otherwise, and always sends shuffle on a boolean slot — `false` included.

`musicPlan` at `src/music.ts:1075` falls back to an area-only call through `areaPlayService`, then to `HassMediaSearchAndPlay` (`musicCall` at `:981`).

## Media

Media transport is deliberately separate from music. `readPower` at `src/media.ts:163` handles TV power and requires the word "TV". `readTransport` at `:139` declines play, queue and listen so music wins those; it handles stop, pause, resume, next, previous, volume and mute.

`transportTarget` at `src/media.ts:213` selects the player: named player → named room → the device the request came from → spoken area → single awake player → the Music-Assistant-owned player → error `${awake.length} players are playing`.

The kiosk branch gates on `kiosk.profile.actions.includes(kioskAction)` (`KIOSK_ACTION` at `:62`). `needsPlaying` excludes volume and mute, so a bare "stop" with nothing playing returns `null` rather than an error — the sentence keeps whatever route it had. Actions come from the `ACTION` map at `:38`; magnitude uses the same `magnitudeStep`; the trace reason reads `media: <phrase> on <player>, no model call`.

## Clock

`clockNow` at `src/clock.ts:165` prefers the configured IANA zone, then a clock parsed from the prompt (`clockFromPrompt` at `:111`), then the process clock. `spokenTime` at `:92` says "seven oh five", "seven thirty-five", "seven o'clock" — never a.m. or p.m. `isTimeQuestion` at `:204` rejects dates and "time in Paris", so those forward.

The answer is a local text plan: no model call and no tool.

## Weather

`readWeatherQuestion` at `src/weather.ts:640` needs an asking phrase plus a weather word, or a temperature word with `OUTSIDE`. It rejects commands, house names, devices and other places, so "turn on the heating" and "what's the weather in Paris" do not match.

`weatherAnswer` at `:509` tries the natural templates first (`NATURAL_TEMPLATES` at `:152`, with rotating leads), then a style: `summary`, `current`, `full` or `temperature_first`. `TEMPERATURE_TEMPLATE` at `:121` is per language, so a language without one gets no temperature sentence. `summaryLanguage` and `requestedSummaryLanguage` are at `:99` and `:110`.

`weatherFor` around `:700` caches `${base}|${lat},${lon}|${units}|${language}` and never throws: a failed lookup logs `weather: Pirate Weather answered HTTP <status> — forwarding weather questions instead`.

## Reminders

`reminderPlan` at `src/reminders.ts:493` produces `ReminderCreate`, `List`, `Complete`, `Snooze` or `Delete` on domain `ha_reminders` (`:57`).

It converts what the integration would reject, rather than passing text through:

- `parseDuration` at `:190` caps at 1..10080 minutes and reads words ("half an hour").
- `parseClockText` at `:252` returns padded `HH:MM`, handling noon, midnight and "quarter to".
- `parseIndex` at `:299` reads "the second one".
- Titles keep their case (`speechOf` at `:149`), so "email Dr. Chen about the invoice" stays as said.

A reminder with no time and no place is forwarded, so the model can ask the follow-up question the integration expects.

## Timers

`timerPlan` at `src/timers.ts:618` requires the word "timer" — a bare "pause" stays with media.

- `splitOf` at `:299` canonicalises exactly one split per duration, because Home Assistant's `_find_timer` compares slots with `==`.
- A ledger `STARTED` (`:99`, capped at 32) replays that split for "add two minutes to the pasta timer".
- Controls map to `HassCancelTimer`, `HassCancelAll`, `HassIncreaseTimer`, `HassDecreaseTimer`, `HassPauseTimer` and `HassUnpauseTimer` (`:50-58`) on domain `timer` (`:63`).
- `allowed(declared(...))` drops slots the offered tool does not declare.
- Two timers that cannot be told apart produce a `clarify` plan with `labelsOf(...).join(' or ')`.

Two deliberate gaps: `HassTimerStatus` is never called (it returns slots, not a sentence), and "how long is left" questions are left to the model.

## Answering a state question

`directStatePlan` at `src/answer.ts:262` uses `STATE_LEAD` (`:238`) and `STATE_TAIL` (`:241`): a longest single-name match wins, and a bare subject is accepted only if unique and `holds()` is decisive. It then answers polarity with `answerPolarity` at `:163` (a `{actual}` slot) or device state with `answerDeviceState` at `:151`.

If Home Assistant does offer `HassGetState`, the call is made instead, and only a count question stays local (`src/router.ts:299-306`, `answerCount` at `src/answer.ts:199`).

It forwards when two entity ids are equally long, the entity is unknown or unavailable, the state word cannot apply to the entity, or the sentence has no lead at all.

## What pins this behaviour

- `test/timers.test.ts` (20 tests) — canonical split, named and paired timers, replay, clarify, and `HassTimerStatus` left to the model.
- `test/reminders.test.ts` (17) — duration, clock and place parsing, index versus title, no-time forwarded.
- `test/music.test.ts` (70) — phrase reading, targeting, Music Assistant slots, shuffle, scripts, the kiosk blueprint.
- `test/music-rooms.test.ts` (5) — room versus TV versus the spoken-to device.
- `test/media.test.ts` — transport phrases, player selection, TV power, magnitude, the kiosk `actions` gate.
- `test/clock.test.ts` — wording, prompt clock, zone precedence, question rejection.
- `test/weather.test.ts` (32) — subjects, styles, language templates, cache, forwarding.
- `test/answer.test.ts` (13) — device, count and polarity answers, plus forwarding.
- `test/level-slots.test.ts` (7) — percent versus 0-255 versus fraction.
