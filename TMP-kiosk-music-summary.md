# Kiosk Satellite music vs. ours — comparison and what changed

Temporary file, written 2026-11-12. Delete when read.

Shipped: **typesafe-openai-proxy v0.1.75**, commit `5f3657a` — "feat(music): a kiosk music script is the music tool, and needs no exposed player". Verified: typecheck (app + web), build, 350 tests, secrets scan.

---

## The three things being compared

| | What it is | Talks to Music Assistant how |
|---|---|---|
| **Kiosk blueprint** (`script.kiosk_satellite_music`) | HA script from `jxlarrea/kiosk-satellite`; fields `action`, `query`, `kind`, `artist`, `mode`, `speaker`, `level`, `kiosk` | fires a `kiosk_satellite_music` event and waits ≤15 s for the kiosk tablet to answer; **the kiosk** does the search + play |
| **Our script** (`script.play_music_now`, "Play Music New") | hand-written, fire-and-forget; fields `media_id`, `media_type`, `artist`, `album`, `shuffle`, `area`, `action` | does `music_assistant.search` (475 ms) then `music_assistant.play_media` with the returned URI (17.5 s on the Echo Show, 2.4 s on AirPlay) |
| **Our proxy** (`typesafe-openai-proxy`) | decides the tool call from the sentence, no model call | was unaware of the blueprint's shape; now knows it |

## Where the blueprint is better

- **It knows where it plays.** No room arithmetic: empty `speaker` means "the speaker this kiosk follows". Our script had to compute players from `area` via `area_entities` + `integration_entities('music_assistant')`, which is exactly the chain that went wrong twice (wrong room, music on the TV).
- **One tool for everything.** play, queue, show the library, say what's playing, pause/resume/skip, volume, read/clear the queue, list speakers — 13 actions in one entity.
- **It answers.** `{ok, error, other_matches}` comes back, so the assistant can say what happened and offer alternatives. Our script returns nothing to speak.
- **`mode: radio`** keeps playing similar music after the request — our script only had artist-radio via config.
- **Search and play in one hop** on the kiosk side, instead of two HA service calls we had to hide behind `script.turn_on`.
- **`other_matches`** handles "two artists called …" instead of a silent first-hit guess.

## Where ours was better

- **The Essentials trick**: for an artist, look for Apple Music's "Essentials" playlist (`media_type: playlist`, filter `essentials` + artist name) and play that — a fixed ~25-track list instead of MA building an artist queue. This is what cut a 24 s artist start down; worth re-adding to the kiosk flow if artist starts get slow again.
- **`shuffle` sent as a real boolean** (and always sent), which sidesteps HA's template-global trap (`CollectionExtension.shuffle`) that crashed the old script.
- **Stop** (`media_player.media_stop`) — the blueprint has no stop action.
- Explicit `enqueue` handling (`replace` / `add`) rather than a mode enum.

## What the proxy now does (v0.1.75)

Recognises the blueprint **by shape, not by name**: an `action` slot whose enum offers `play`, plus a `query` slot and a `kind` slot. `script.run_routine` (action + query, no kind) is *not* mistaken for music.

- Ranking changed: **kiosk script 0**, Music Assistant 1, house play script 2, player's own `play_media` 3. So an exposed blueprint now wins over Music Assistant's own service — which is what the blueprint's description asks for.
- Music needs **no exposed player at all**: the plan carries `targets: []` because the kiosk picks the speaker.

What a sentence becomes, with the kiosk script exposed:

| Sentence | Args |
|---|---|
| "play Taylor Swift" (spoken in the Office) | `{action: play, query: "Taylor Swift", kind: artist, speaker: "Office", mode: replace}` |
| "play Punisher by Phoebe Bridgers in the kitchen" | `{action: play, query: "Punisher", kind: album, artist: "Phoebe Bridgers", speaker: "Kitchen", mode: replace}` |
| "play some jazz" | `{action: play, query: "jazz", speaker: "Office", mode: replace}` — **no** `kind`, because a genre is not one of the blueprint's kinds |
| "play Tyler the Creator" with *a bare artist name plays a radio station* | same, plus `mode: radio` |
| "pause" | `{action: pause, speaker: "Office"}` |
| "next song" / "go back" / "volume up" / "turn it down" | `{action: next \| previous \| volume_up \| volume_down, speaker: "Office"}` |
| "stop the music" | **not** the kiosk script — it has no stop, so it stays `HassTurnOff` on a player (or goes to the model if no player is exposed) |

## What to expose now

1. **Expose the kiosk script** (Settings → Voice assistants → the conversation agent → *Expose* the script). Remove the blueprint's `kiosk`/`level` fields from the agent's view if you like — the proxy never sends them.
2. **Unexpose, and ideally delete, `script.play_music_now`.** It is redundant now and, being the same shape as an old-style house script, it would sit at rank 2 and confuse the picture. Its two good ideas (Essentials playlist, explicit shuffle) can move into the kiosk flow later.
3. **No media players need to be exposed for music.** Leave the sendspin / MA players exposed only if you want to ask what is playing (see the gap below) — the proxy no longer needs one to play.
4. Music Assistant's own voice script: the blueprint says to unexpose it. With v0.1.75 you do not have to — the kiosk script outranks it — but unexposing keeps the model-side list tidy.

## Gaps, if you want them closed next

- `show` (open the library), `now_playing`, `queue`, `clear_queue`, `speakers` — the proxy answers "what's playing?" from the catalog instead, and does not send these actions yet. `speakers` would let "where can I play this?" be answered by the kiosk itself.
- `podcast` / `audiobook` kinds — the reader has no vocabulary for them, so those sentences still go to the model.
- `level` (absolute volume, "set it to 40") — only relative steps are read today.
- Reading the kiosk's `{ok, error, other_matches}` answer and speaking it: the proxy currently keeps HA's own speech for the call.
- The Essentials-playlist trick for a bare artist (see above) — port it into the kiosk path if artist starts are slow again.
