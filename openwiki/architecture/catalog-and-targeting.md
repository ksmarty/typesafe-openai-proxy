---
type: "Reference"
title: "Catalog and targeting"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
---

# Catalog and targeting

The proxy only ever acts on entities it knows about. The **catalog** is that list: it is discovered from Home Assistant, narrowed to what is exposed to Assist, and sorted so the most useful devices survive the model's entity cap. **Targeting** is the reverse direction: turning the words of a sentence ("the big light", "upstairs", "the kitchen") into the entity, area or floor the action applies to.

Both jobs live in `src/catalog.ts`; `src/questions.ts` turns the result into the options a decision answers, and `src/router.ts` (see [Decision backend and routing gates](decision-and-gates.md)) consumes the answer.

## Discovery

The catalog has two sources, tried in this order:

1. **Home Assistant's WebSocket API** — `catalogFromHomeAssistant(config)` at `src/catalog.ts:431` sends a single batch with `wsQuery<T>(url, token, messages, timeoutMs = 8000)` at `src/catalog.ts:84`. All registry questions are in flight at once and replies are matched **by message id**, not by arrival order. The comment above the function records why: a sequential version let a large `get_states` starve the exposure reply within the shared deadline.
2. **The system prompt attached to the request** — `catalogFromPrompt(prompt)` at `src/catalog.ts:638` parses entity ids, area headings and aliases out of Home Assistant's own prompt text.

The result carries a `source` of `'ha-websocket' | 'prompt' | 'manual' | 'empty'`.

### The batch

`catalogFromHomeAssistant` asks for, in this order, with a 25 s deadline:

| Message | Why |
| --- | --- |
| `homeassistant/expose_entity/list` (optional) | The authority on exposure; only a few KB, so it is asked first |
| `config/area_registry/list` | Area names |
| `config/device_registry/list` | Areas inherited by devices |
| `config/floor_registry/list` | Floor names for upstairs/downstairs |
| `config/entity_registry/list` | Names, aliases, disabled/hidden flags |
| `get_states` | Current state and level attributes |

When `catalog.exposedOnly` is on, exposure is re-read on its own through `fetchExposureMap(config)` at `src/catalog.ts:382` (10 s, nothing optional) so the dashboard's "Check exposure" result and the catalog agree. `probeExposure(config)` at `src/catalog.ts:392` returns `{ok, command, error?, count?, assistants?, sample?, usable?}` for the settings screen; a refused command surfaces verbatim ("unknown command"), and an unauthorized token is explained as needing an administrator's long-lived token.

### Reading the exposure answer

`exposedToConversation(payload)` at `src/catalog.ts:333` accepts three shapes:

- `{exposed_entities: {conversation: {id: true}}}`
- flat `{exposed_entities: {id: true}}`
- `{id: {conversation: true}}`

An unreadable answer returns `null`, never an empty allow-list. That distinction matters: `null` means "list the whole registry", while an empty map would hide every entity and make the proxy silently useless.

`catalogFromRegistries(input)` at `src/catalog.ts:508` is pure and unit-tested. It drops rows with `disabled_by`, `hidden_by` or `entity_category`, then keeps only `exposed[id] === true` when exposure is known and `exposedOnly` is on.

### Names, areas and levels

- Area: `entity.area_id ?? area of device_id`.
- Name precedence: `attributes.friendly_name` → `entity.name` → `original_name` → object id with underscores removed → entity id.
- Aliases: copied through `strings()` at `src/catalog.ts:227` (trim, dedupe, at most 80 characters).
- State: `state` or `'unknown'`.
- Level: `levelFrom(attributes)` at `src/catalog.ts:251` takes the first finite value of `brightness`, `percentage`, `current_position`, `volume_level`, `temperature`, `humidity`, each mapped to its slot (`brightness → brightness`, `percentage → percentage`, and so on).

### Ordering and pruning

Only domains in `DOMAIN_PRIORITY` survive (`src/catalog.ts:30`): light, switch, cover, lock, fan, climate, media_player, scene, script, vacuum, humidifier, water_heater, button, input_boolean, todo, sensor, binary_sensor, number, select, alarm_control_panel, valve. Anything else — automations, cameras, update entities — is not offered to the model.

`sortEntities` at `src/catalog.ts:54` sorts by domain rank, then area name (missing areas sort last as `'~'`), then name. `domainsOf` at `src/catalog.ts:68` uses the same priority with unknown domains ranked 99, and areas are sorted by name. This order is load-bearing: the decision state is cut at `decision.maxEntities` **after** sorting, so the cap always removes the least useful domains first.

The catalog note reads `"N of M entities exposed to Assist, A areas"` or `"N entities, A areas from Home Assistant"`, and `exposure` records `{ok, exposed, registry, used: 'expose_entity_list' | 'prompt' | 'none'}`.

### When exposure cannot be read

If `exposedOnly` is on and `catalog.exposure.ok === false`, the prompt fallback runs: `rememberPromptExposure(ids)` at `src/catalog.ts:269`, then `narrowFromPrompt(catalog, prompt, config)` at `src/catalog.ts:277` / `narrowCatalog(catalog, ids, why)` at `src/catalog.ts:299`. It refuses to guess when the prompt names fewer than 3 ids or nearly everything; otherwise the note becomes `"N of M entities (why)"` and `exposure.used` is `'prompt'`.

### Caching, snapshots and refresh

- Module-level `cache: CacheEntry | null`, deduped through a promise in `buildCatalog` (`src/catalog.ts:804`).
- `getCatalog(config, prompt?, options: {maxAgeMs?})` at `src/catalog.ts:830` uses `min(config.catalog.cacheMs, maxAgeMs ?? cacheMs)`. A cold start serves the snapshot with `at: 0` and rebuilds in the background.
- `getCatalog` **never throws**. On failure it returns `catalogFromPrompt(prompt)` or `emptyCatalog()` at `src/catalog.ts:911` with the note `"(Home Assistant unreachable: <msg>)"`. Home Assistant being down degrades; it does not produce a 5xx from the proxy.
- `SNAPSHOT_PATH` is `<DATA_DIR>/catalog.json`, `SNAPSHOT_MAX_AGE_MS` is 24 h (`src/catalog.ts:778-780`). The documented reason: "a day-old 'off' is worse than a moment of waiting."
- `startCatalogWarmer(readConfig)` at `src/catalog.ts:1181` refreshes on `max(15000, cacheMs / 2)`, `unref()`'d; `stopCatalogWarmer()` at `src/catalog.ts:1197` stops it. `clearCatalogCache()`, `rememberCatalog()`, `cachedCatalog()` and `emptyCatalog()` exist for tests and for the dashboard's refresh button.
- `homeSignature(catalog)` at `src/catalog.ts:928` hashes sorted area ids plus sorted entity ids. Adding a light invalidates the decision cache; rebuilding the catalog without changes does not.
- `homeZoneCoordinates(config)` at `src/catalog.ts:880` reads `zone.home` latitude/longitude once per session.

## Describing entities to the decision model

`buildState(input)` at `src/systemone.ts:76` sends one JSON `state` per utterance: `request.text`, optional `language`, `now`, `spoken_from_area` (resolved from `spokenFromAreaName ?? catalog.defaultArea` by case-insensitive area name), then `home.areas` and `home.entities`.

Entities are compact records, not prose — `{id, name, domain, state, area?, floor?, device_class?}` with absent keys omitted. `home.areas` is narrowed to the areas those entities actually use (`areaIdsInUse`). Conversation history is `decision.historyTurns * 2` messages from the tail. The cap is `Math.max(1, config.decision.maxEntities)` after sorting.

Prose exists in one place only: `describeEntity(entity)` at `src/questions.ts:178`, used for question options — `"<name>, <domain words>, also called <aliases>, <areaName>, <deviceClass words>, is <state>"`. That is how aliases reach the model without bloating the entity list.

## Targeting

Targeting runs after the catalog exists and mostly without a model: lexical matches rescue a weak gate, and the decision supplies scope and confidence for the rest.

- `uniqueEntityMention(catalog, utterance)` — `src/catalog.ts:1158`. Longest name or alias wins; an equal-length rival, or two entities sharing the winning name, returns `undefined`. Ambiguity is never broken by picking.
- `uniqueAreaMention(catalog, utterance)` — `src/catalog.ts:963`, over area names and area aliases.
- `floorsOf(catalog)` `:988`, `uniqueFloorMention(catalog, utterance)` `:1007`. `UPSTAIRS`/`DOWNSTAIRS` (`:1000-1001`) map through `byLevel(floors, 'highest' | 'lowest')` `:1031`; a tie at the same level returns `undefined`.
- `mentionedTargets(catalog, utterance)` — `src/catalog.ts:1084`, `MentionedTarget` at `:1047` with kind `'area' | 'entity'`. `isRoomGroup` (`:1073`) with `GROUP_WORDS` (`:1062`: lights, lamps, fans…) collapses a device named inside the room it names into that one area target.

`route(ctx)` at `src/router.ts:143` combines that with the decision's probabilities. Every gate needs both a probability above its threshold and a margin over the runner-up (`gateChoice` at `src/router.ts:71`, `marginOf` in `src/systemone.ts:325`). Naming an entity, area or domain explicitly raises the threshold from `actTerse` to `actExplicit` instead of accepting a terse command's lower bar.

When the scope gate fails, the lexical matches are the rescue: named entity → `single`, named room → `area`, named floor → `floor`, and the gate records a note such as `room "Kitchen" named in the sentence`. A named floor overrides `area` or `whole_house` when no room is named; a `floor` scope with no floor named degrades to the named room.

Two further reads decide the rest:

- `"all/every/everything/whole/entire"` (`saysEverything`) beats the here-relative reading of `whole_house`; otherwise `hereRelative >= t.noulHereRelative` means `catalog.defaultArea`.
- `mentionedTargets.length >= 2` → `planMulti` at `src/router.ts:388`: one call per target, forwarding the whole sentence if any call cannot be built. Relative steps and single-value texts are refused across targets; a media search resolves a room to the one speaker through `roomSpeaker`.

### Ambiguity

With confidence at or above `t.clarifyFloor` and non-empty runners-up, the router asks a question naming up to three options. When two devices are equally named, `tiedNameCandidates(utterance, options, limit = 3)` at `src/router.ts:858` selects entities whose shared significant words equal the best score — "Kitchen Ceiling" and "Kitchen Overhead" tie, so the speaker is asked instead of one being guessed.

`entityFrom(answers, built, thresholds)` at `src/router.ts:898` maps a chosen option id back to its entity; `absoluteValue(ctx, slot, kind)` at `src/router.ts:913` turns a value pick, an extracted percentage or a number into the slot value (`temperature → number`).

## Questions

`src/questions.ts` builds the **single batched question set** answered by one model call. `Q` at `src/questions.ts:14` lists the questions: `addressed`, `category`, `compound`, `scope`, `here_relative`, `query_kind`, `risky`, `change_direction`, `magnitude`, `target_area`, `target_entity`, `target_domain`, `value_pick`, plus one `action_<domain>` per actionable domain (`actionQuestion` at `:37`). Sentinels are `no_area`, `no_single_entity`, `none` and `not_targeted` (`:39-42`); criterion text lives in `STATIC_QUESTIONS` (`:44`); `MAGNITUDE_STEPS` (`:142`) is slight .1, moderate .25, large .5, maximum 1.

`buildQuestions(catalog, extraction, options)` at `src/questions.ts:189` emits:

- area options (at most `maxOptions - 1`, ids `area_<slug>`),
- entity options (ids `e_<slug(name)>`, deduped by name and area, each described by `describeEntity`),
- one domain question from `DOMAIN_LABELS`,
- one `action_<domain>` question per actionable domain,
- a `value_pick` question over the extraction candidates.

It returns `{questions, entityOptions, areaOptions, actionDomains, entityOrder}` so a chosen id maps straight back to an entity without a second lookup. No tool or intent name appears here — intents appear when an answer becomes a call (`src/actions.ts` `INTENTS`/`specFor`, `src/toolcall.ts` `buildToolCall`).

Questions about state go the other way: if the intent is not offered, the proxy answers from the catalog itself with `answerStateQuestion(entity, utterance, templates)` at `src/answer.ts:185`, `answerCount(catalog, domain, stateWord)` at `:199`, `answerDeviceState` at `:151` and `answerPolarity` at `:163`. Otherwise it sends `getState`. See [Fast paths](fast-paths.md).

## What pins this behaviour

- `test/catalog-order.test.ts` — a server answering the batch in reverse order still matches by id.
- `test/exposure.test.ts` — per-assistant maps, flat booleans and per-entity objects parse; an unreadable answer is `null`, never an empty allow-list; notes read `"2 of 4 entities exposed to Assist, 1 areas"`; `exposedOnly: false` keeps everything.
- `test/exposure-dedicated.test.ts` — the dedicated exposure read survives a busy core, so a refused batched answer cannot restore the whole registry.
- `test/exposure-fallback.test.ts` — prompt narrowing keeps only the named ids and drops unreferenced areas, but refuses to guess when exposure was readable, the setting is off, or the prompt names nearly everything.
- `test/exposure-socket.test.ts` — real socket paths, including a core without the optional command and a probe reporting assistants and samples.
- `test/targets.test.ts` — a device inside its room is one area target; two rooms become two calls; "all the lights" stays whole-house; "the lights" in a room resolves to one entity.
- `test/aliases.test.ts` — aliases parse from prompt and registry, name both device and room, reach the model through `describeEntity`, and produce a call end to end.
