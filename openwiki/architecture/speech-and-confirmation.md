---
type: "Reference"
title: "Speech, turns and confirmation"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-16T15:09:02.577Z
sources:
  - id: openwiki-source-d62dc78a6b92f64549736a16
    resource: repo://src/pipeline.ts
  - id: openwiki-source-837e20237d7b757c491d238f
    resource: repo://src/respond.ts
  - id: openwiki-source-9da6594296f4b30b9cdfad4c
    resource: repo://src/router.ts
  - id: openwiki-source-4a0ab1b9faefdf9ad63329cc
    resource: repo://src/speech.ts
  - id: openwiki-source-47ceacd9486dc381d1b4a4e6
    resource: repo://src/state.ts
generated: { by: "v1", at: "2026-11-16T15:09:02.577Z" }
---

# Speech, turns and confirmation

Home Assistant sends tool results back as messages, not as spoken words. Something has to turn "the call succeeded" into a sentence, and the proxy has strong opinions about who that is: it speaks only about calls it made itself, prefers Home Assistant's own wording, and stays quiet when a rule says so.

<!-- openwiki: broken internal link [dashboard.md] file "dashboard.md" does not exist. Fix the href or restore the target, then delete this comment. -->
This page covers what is said after a tool call, how rounds are nested into turns, and how a risky action waits for a yes. See [State and persistence](state-and-persistence.md) for the maps behind it and [Dashboard](dashboard.md) for how rounds are grouped on screen.

## Speech configuration

`SpeechRule { match: string; mode: 'speak' | 'silent' | 'custom'; say?: string }` is declared in `src/config.ts` and imported at `src/speech.ts:15`. Defaults at `src/config.ts:411-430`:

- `afterTool: 'template'`
- `confirmSeconds: 90`
- `silence: '[pause:1.5s]'`
- rules that silence `light`, `switch`, `fan`, `cover`, `climate`, `media_player` and Music Assistant's play service.

`speechTemplates(config, language)` at `src/config.ts:348` is `templates[language.split('-')[0]] ?? templates.en ?? DEFAULT_TEMPLATES.en`. `DEFAULT_TEMPLATES` at `src/config.ts:333` ships English only, with done, clarify, confirm, yes, no, state and unknown. The router keeps a private copy at `src/router.ts:106-109`.

### Precedence

Resolved per call at `src/pipeline.ts:1091-1110`:

| Rule | Result |
| --- | --- |
| `silent` | `''` |
| `custom` | `interpolateSpeech(rule.say, {entity, action, item})` |
| `speak` | `null`, deferring to Home Assistant or the template |
| no rule | `owedAnswer ? null : afterTool === 'empty' ? '' : null` |

A rule always outranks the `afterTool` default. Only `afterTool: 'upstream'` can hand the whole round to the model, and only when no rule matched — `ruleTookOver` at `src/pipeline.ts:1048` and `:1065`.

### What `src/speech.ts` provides

The module is deliberately small (204 lines) and holds no language logic and no state:

- `descriptorsOf(call)` at `:24` returns `[tool, "domain.action", domain, action]`, most specific first.
- `ruleMode` at `:37` and `ruleFor` at `:52` match lowercased candidates: a `todo.*` match is a prefix (via `match.slice(0, -1)` then `startsWith`), everything else is exact equality, first rule wins, `null` when none match.
- `humanTarget(targets)` at `:67` strips `domain.`, turns underscores into spaces and title-cases.
- `PREPOSITION` at `:84`, `ITEM_IN_PHRASE` at `:91` and `actionPhrase(action, template, item)` at `:94` handle phrasing like add_item → "Added Milk to".
- `interpolateSpeech` at `:111` fills only `{entity}`, `{item}` and `{action}`.
- `isSilentCall` at `:124`, `samplePairFor` at `:155` and `previewForRule` at `:194` support the settings preview.

One real mismatch to know about: the help text at `src/schema.ts:344` advertises `{entity}`, `{action}`, `{state}` and `{options}`, but `{state}` and `{options}` are filled by the router's own `fill()` at `src/router.ts:111`, never by a custom `say`.

`src/speech.ts` reads nothing from `issuedCalls`; it only receives a `CallDescriptor {tool, domain, action}` at `:17-21`.

## What gets said

`speechFor(callId, toolContent, catalog, language)` at `src/respond.ts:388-453` returns `''` when:

- `issuedCalls` has no entry for the id (`:397`) — the proxy never speaks a call it cannot describe;
- the content does not parse (`:402`);
- the language has no template (`:442-443`).

Otherwise it tries, in order: Home Assistant's `plain.speech`, then `result.speech`, then `slots.action` plus `slots.name`, then an Assist `response_type` with `data.success`/`data.failed` via `ACTION_VERBS[info.action]` (`namesOf` and `joinNames` at `:374` and `:383`), then the `template.done` with `{action}` as a verb and `{entity}` as the catalog name or a de-prefixed id, and `'that'` as the last resort.

`speechForLastTool(callId, content, language)` at `:459-465` is the same call against `cachedCatalog()`. `speechForToolRound` at `:474-483` joins unique non-empty lines with a space; the pipeline does not use it — it maps each message at `src/pipeline.ts:1111-1124` and dedups with `[...new Set(parts)].join(' ').trim()` at `:1125`, so the same sentence is spoken once.

## The trailing-tool rule

`src/pipeline.ts:1011-1016` scans from the end while `role === 'tool'` and stops at the first other role. Replayed history is excluded on purpose: the comment at `:1005-1010` records that including it once made "What's two plus two?" answer "Turned off Kitchen Lights."

Each result is resolved at `:1029-1043`:

1. `issuedCalls.get(tool_call_id)` when the proxy made the call.
2. Otherwise `announcedCalls(messages).get(id)` at `:142-156`, read from `assistant.tool_calls`.
3. The descriptor is the issued `{tool, domain, action, targets}`, or `descriptorFromAnnouncement(name, args)` at `src/toolcall.ts:145-165` — domain from the entity-name prefix, then the `domain` slot, then `domainForIntent`; action via `actionForIntent`; targets from `name`, else `area`.
4. `args` is `issued?.args ?? parseToolArguments(announced.arguments)` (`src/toolcall.ts:115-124`).

The spoken row is written at `src/pipeline.ts:1162-1173` as `route: 'text'`, `backend: 'speech'`, with `answersTurn: owner` when there is an owner, `said: text` when there is text, and `tool: toolMessage.tool_call_id`. When the text is empty the reason becomes `silent by rule (<tools>, sent "<silence>")` at `:1155-1156`, and the body is still `text || silence` at `:1175` — an empty body would start a TTS job.

## Turns and nesting

A "turn" is one sentence and everything it caused. `recordTurn` at `src/pipeline.ts:137-140` returns early when the entry has no utterance; callers are at `:327`, `:488`, `:551`, `:657`, `:894` and `:988` (the forwarded row at `:976-990` is recorded so its follow-up attaches).

`rememberTurn` at `src/state.ts:77-91` keeps `turnBySession` (`:71`), a `Map<session, Map<utterance, {id, at, category?}>>`: it deletes the same sentence first, then evicts the oldest past `TURNS_PER_SESSION = 12` at `:74`. `lastTurnFor` at `:99-112` drops a turn older than `TURN_TTL_MS = 120_000` (`:57`). The session key at `src/pipeline.ts:117-122` is `conversation_id`, else a sha1 of device, the first 400 characters of the system prompt, and the model.

Linking a speech round to its cause:

- `ownerFromCalls` at `src/pipeline.ts:1055-1059` takes the first `issuedCalls.get(tool_call_id)?.turnId`.
- `previousTurn = lastTurnFor(key, lastUserMessage(messages))` at `:1063`.
- `owner = ownerFromCalls ?? previousTurn?.id` at `:1064`, stamped as `answersTurn` at `:1076`, `:1141` and `:1170`.

The dashboard builds a map of the 50 trace rows by id, pushes every row whose `answersTurn` resolves into that entry's replies, sorts replies by `at`, and treats rows with no `answersTurn` (or a stale one) as top-level rows. That is what makes a tool call and the sentence after it read as one exchange.

## Clarification

`ClarifyPlan {kind: 'clarify', text, options?}` shares the `respondText(plan.text)` branch with text plans at `src/pipeline.ts:1283-1286`. The timer reader builds its clarify text from `speechTemplates(config, language).clarify` at `src/timers.ts:704`, so it is localised like everything else.

`speech.afterTool` accepts exactly `'template'`, `'upstream'` and `'empty'` (`src/schema.ts:316-323`). There is no `'rules'` value: rules sit above the default in all three modes and only veto the upstream handoff.

## Confirmation

`isRisky` at `src/router.ts:129-141` treats a call as risky when any of these hold:

- the action is in `RISKY_ACTIONS` — `unlock`, `open`, `disarm`;
- the domain is in `RISKY_DOMAINS` — `lock`, `cover` with `open` or `unlock`;
- the device class is in `RISKY_DEVICE_CLASSES` — `garage`, `gate`, `door`, `window` (`src/actions.ts:202-204`);
- `noulRisky >= thresholds.noulRisky`, which defaults to 0.5.

The gates at `src/router.ts:483-499` (multi-call) and `:824-841` (single call) both also require `config.decision.alwaysConfirmRisky`, default `true` (`src/config.ts:388`). The question text is `fill(said.confirm, {action, entity})`, with the verb from `CONFIRM_INFINITIVES` at `src/router.ts:119-127`.

The pending plan is armed at `src/pipeline.ts:1291-1298`:

```ts
pendingConfirmations.set(sessionKey, {
  plan: plan.pending, utterance, expiresAt: Date.now() + speech.confirmSeconds * 1000
})
```

`confirmSeconds` defaults to 90 and is bounded 5..3600 in steps of 5 (`src/schema.ts:333-340`).

`YES` and `NO` are matched at `src/respond.ts:455-456`:

- Yes: `yes`, `yeah`, `yep`, `yup`, `ok`, `okay`, `sure`, `do it`, `go ahead`, `confirm`, `please do`, `affirmative`.
- No: `no`, `nope`, `nah`, `cancel`, `don't`, `stop`, `negative`, `forget it`.

A yes re-emits the pending call through `emitToolCall` and writes a row with `route: 'tool'`, `backend: 'confirmation'` and the reason `confirmed by the speaker (<utterance>)` at `src/pipeline.ts:1204-1220`. A no answers `Okay, cancelled.` at `:1223` and writes no row. Anything else — or an expired arm — is deleted and falls through to normal deciding at `:1202-1203` and `:1225-1227`.

`pruneState` at `src/state.ts:120-152` sweeps expired arms, `issuedCalls` older than ten minutes and stale turns, and caps both maps at `MAP_CAP = 200`.

## Deliberate limits

- A failed tool call is silent: `speechFor` returns `''` for `success: false` rather than explaining what went wrong.
- The proxy never speaks about a call it cannot describe, which is why an unknown `callId` yields nothing.
- Only trailing tool messages count as a speech round.
- The "no" branch is neither localised nor traced.
- `speech.silence` is a pause marker, not an empty body.
- Repeated identical sentences inside one round are spoken once.
- Under `afterTool: 'upstream'` the round gets its own `route: 'forward'` row (`src/pipeline.ts:1068-1082`), because the proxy writes nothing there and the model's answer needs somewhere to land.
- `owedAnswer` at `src/pipeline.ts:1088` only rescues questions the proxy did not issue, so existing behaviour for commands is untouched.
