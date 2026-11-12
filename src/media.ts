/**
 * Media control, read from the sentence instead of decided by a model.
 *
 * "Pause", "stop the music", "volume up", "next song", "turn the TV off" are the commands a
 * person repeats all day, and none of them needs a reader model: the player is the one already
 * playing (or the one in the room the sentence names), and Home Assistant's own media intents
 * take it from there. That matters doubly for Music Assistant, which registers a media player
 * per speaker: the entity that is playing *is* Music Assistant, so pausing it is pausing Music
 * Assistant, and the volume of it is the volume of the music.
 *
 * A sentence this reader cannot place is forwarded, exactly as with music: the model can ask.
 */

import { specFor } from './actions.js';
import type { Config } from './config.js';
import { areaOfName, inAreaOf, isTelevision, kioskTool, playersNamed, spokenArea, spokenAreaId } from './music.js';
import { buildToolCall, magnitudeStep } from './toolcall.js';
import type { ToolInventory } from './toolcall.js';
import type { Catalog, CatalogArea, CatalogEntity, ToolCallPlan } from './types.js';
import { normalise } from './util.js';

export type Transport = 'pause' | 'resume' | 'stop' | 'next' | 'previous' | 'louder' | 'quieter' | 'mute' | 'unmute';

/** How a command reads in a trace reason. */
const PHRASE: Record<Transport, string> = {
  pause: 'pause',
  resume: 'resume',
  stop: 'stop',
  next: 'next track',
  previous: 'previous track',
  louder: 'volume up',
  quieter: 'volume down',
  mute: 'mute',
  unmute: 'unmute',
};

/** The action each command is sent as, in src/actions.ts terms. */
const ACTION: Record<Transport, string> = {
  pause: 'pause',
  resume: 'play',
  stop: 'turn_off',
  next: 'next',
  previous: 'previous',
  louder: 'louder',
  quieter: 'quieter',
  mute: 'mute',
  unmute: 'unmute',
};

/** A player that is doing something now, so "pause" has an object. */
const AWAKE = /^(playing|buffering|paused|on)$/i;

/**
 * The action a kiosk music script takes for a command.
 *
 * The blueprint steers playback itself — `pause`, `resume`, `next`, `previous`, `volume_up`,
 * `volume_down` — and it knows which speaker the kiosk it was spoken to follows, so a paused
 * kiosk pauses the right thing. `stop` is sent only to a script whose `action` slot lists it,
 * because the blueprint does not; a mute or a television has no action there either, so those
 * keep going to the player itself.
 */
const KIOSK_ACTION: Partial<Record<Transport, string>> = {
  pause: 'pause',
  resume: 'resume',
  next: 'next',
  previous: 'previous',
  stop: 'stop',
  louder: 'volume_up',
  quieter: 'volume_down',
};

/** A media player that is switched off. */
const ASLEEP = /^(off|standby|unavailable|unknown)$/i;

const LEAD_IN =
  /^(?:(?:hey|hi|ok|okay|please|just|now|so|and|then|can you|could you|would you|will you|i want you to|i want to|go ahead and|do you mind if you)\s+)+/;

/** A word that only makes sense about something playing. */
const MEDIA_REFERENCE = /\b(music|song|songs|track|tracks|album|playlist|volume|sound|audio|speaker|speakers|tv|television|screen|playback|media|it|that|this)\b/;

/**
 * Words that make a sentence about something other than media.
 *
 * "Turn up the heat", "pause the vacuum", "stop the fan": a pronoun in one of those ("turn it
 * up") is not a media reference, and the media intents would act on the wrong thing.
 */
const ELSEWHERE =
  /\b(lights?|lamp|lamps|fan|fans|heater|heat|heating|thermostat|temperature|blinds?|curtains?|cover|covers|lock|locked|door|garage|vacuum|robo|humidifier|irrigation|sprinkler|scene|boiler)\b/;

/** Commands, in the order that decides "unpause" before "pause" and "next" before "previous". */
const COMMANDS: { kind: Transport; words: RegExp }[] = [
  { kind: 'unmute', words: /\bunmute\b|\bunsilence\b/ },
  { kind: 'mute', words: /\bmute\b|\bsilence (?:it|that|the (?:sound|audio))\b/ },
  { kind: 'resume', words: /\bunpause\b|\bresume\b|\bcontinue\b|\bkeep playing\b|\bcarry on\b|\bgo on\b/ },
  { kind: 'pause', words: /\bpause\b|\bhold on\b|\bhold it\b|\bhold that\b/ },
  { kind: 'stop', words: /\bstop\b|\bhalt\b|\bkill (?:it|the music)\b|\bshut (?:it|the music) (?:off|up)\b/ },
  { kind: 'next', words: /\bnext\b|\bskip\b/ },
  { kind: 'previous', words: /\bprevious\b|\bgo back\b|\blast (?:song|track)\b|\bback (?:one|a track)\b/ },
  {
    kind: 'louder',
    words: /\blouder\b|\bvolume up\b|\bturn (?:it|that|this|the volume|the music|the sound) up\b|\bturn up the (?:volume|music|sound)\b|\bcrank (?:it )?up\b|\bbump (?:it )?up\b/,
  },
  {
    kind: 'quieter',
    words: /\bquieter\b|\bvolume down\b|\bturn (?:it|that|this|the volume|the music|the sound) down\b|\bturn down the (?:volume|music|sound)\b|\blower (?:it|the volume|the music)\b|\btone (?:it )?down\b/,
  },
];

/** How a volume step was asked for, so "a lot louder" moves further than "louder". */
function magnitudeOf(text: string): string | undefined {
  if (/\b(a lot|lots|a bunch|much|way)\b/.test(text)) return 'large';
  if (/\b(a little|a bit|slightly|a touch|a tad)\b/.test(text)) return 'slight';
  return undefined;
}

/** The sentence without its politeness, normalised the way name matching wants it. */
function clean(utterance: string): string {
  return normalise(utterance)
    .replace(LEAD_IN, '')
    .replace(/\b(?:please|thanks|thank you)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TransportRequest {
  kind: Transport;
  /** The sentence said the command and nothing else: "pause", "volume up", "stop". */
  bare: boolean;
  /** How far a volume step moves, when the sentence said so. */
  magnitude?: string;
}

/**
 * Read a media command out of a sentence.
 *
 * Returns nothing when the sentence is not one — which is most sentences — so the rest of the
 * pipeline runs exactly as before.
 */
export function readTransport(utterance: string): TransportRequest | null {
  const text = clean(utterance);
  if (!text) return null;

  // Asking for something to play belongs to the music reader, which runs first and knows how
  // to name a player, a media type and a provider.
  if (/^(?:play|put on|queue (?:up )?|stream|listen to|start playing)\b/.test(text)) return null;

  const hit = COMMANDS.find((command) => command.words.test(text));
  if (!hit) return null;

  if (ELSEWHERE.test(text)) return null;

  const bare = !MEDIA_REFERENCE.test(text);
  // "pause in the kitchen" is still bare: the room is where, not what. Anything longer than a
  // command and a place is about something this reader has not been told about.
  const subject = text.replace(/\b(?:in|on|at|from)\s+the\b.*$/, '').trim();
  if (bare && subject.split(' ').filter(Boolean).length > 2) return null;

  const magnitude = magnitudeOf(text);
  return { kind: hit.kind, bare, ...(magnitude ? { magnitude } : {}) };
}

export interface PowerRequest {
  on: boolean;
}

/** The word that makes a power sentence about a television rather than about "it". */
const TELEVISION_WORD = /\b(tv|television|telly|screen)\b/;

/** "turn the TV off", "switch off the television in the bedroom", "turn the tv back on". */
export function readPower(utterance: string): PowerRequest | null {  const text = clean(utterance);
  if (!text) return null;
  // "turn down the volume" is a quieter, not a power cut, and the transport reader owns it.
  if (/\b(volume|music|song|track|playlist|playback)\b/.test(text)) return null;
  if (!/\b(?:turn|switch|power|shut|cut)\b/.test(text)) return null;

  // A television has to be named. "Turn it off" is about whatever "it" is, and only the model
  // knows that; a sentence that names a television by its own name is caught by the caller.
  if (!TELEVISION_WORD.test(text)) return null;

  const off = /\b(?:off|down)\b/.test(text);
  const on = /\b(?:on|back on)\b/.test(text);
  if (!off && !on) return null;
  return { on: !off };
}

export interface MediaPlan {
  plan: ToolCallPlan;
  reason: string;
}

function playersIn(catalog: Catalog): CatalogEntity[] {
  return catalog.entities.filter((entity) => entity.domain === 'media_player');
}

/** The one player a room's call should land on, or why it cannot be chosen. */
function inRoom(
  catalog: Catalog,
  area: CatalogArea,
  utterance: string,
): { player: CatalogEntity; reason: string } | { error: string } {
  const players = inAreaOf(catalog, area);
  if (!players.length) return { error: `no media player in ${area.name}` };

  const named = playersNamed(players, utterance);
  if (named.length === 1) return { player: named[0]!, reason: `the player the sentence named in ${area.name}` };

  const awake = players.filter((player) => AWAKE.test(player.state));
  if (awake.length === 1) return { player: awake[0]!, reason: `what is playing in ${area.name}` };

  // A television is not where music happens, but it is where a pause happens when it is what
  // is on: a room with one television and one idle speaker still means the television.
  const candidates = awake.length ? awake : players;
  const speakers = candidates.filter((player) => !isTelevision(player));
  const pool = speakers.length ? speakers : candidates;
  if (pool.length === 1) return { player: pool[0]!, reason: `the one player in ${area.name}` };

  return { error: `${pool.length} players in ${area.name}` };
}

/**
 * Which player a command acts on.
 *
 * A player named outright wins, then a room named, then the device the sentence was spoken to,
 * then the room it was spoken in, then whatever is playing. A command with nothing playing is
 * not ours at all (the caller forwards it), and two equally plausible players is an error
 * rather than a guess.
 */
function transportTarget(
  catalog: Catalog,
  utterance: string,
  options: { deviceId?: string; defaultArea?: string },
): { player: CatalogEntity; reason: string; anchored: boolean } | { error: string } {
  const players = playersIn(catalog);
  if (!players.length) return { error: 'no media player is exposed to Assist' };

  const named = playersNamed(players, utterance);
  if (named.length === 1) return { player: named[0]!, reason: 'the player the sentence named', anchored: true };
  if (named.length > 1) return { error: `${named.length} players match what the sentence named` };

  const room = areaOfName(catalog, utterance);
  if (room) {
    const picked = inRoom(catalog, room, utterance);
    return 'error' in picked ? picked : { ...picked, anchored: true };
  }

  const deviceId = options.deviceId;
  if (deviceId) {
    const onDevice = players.filter((player) => player.deviceId === deviceId);
    if (onDevice.length === 1) return { player: onDevice[0]!, reason: 'the device that was spoken to', anchored: false };
  }

  const spokenId = spokenAreaId(catalog, deviceId);
  const spoken = spokenId ? catalog.areas.find((area) => area.id === spokenId) : undefined;
  const fallback = spoken ?? areaOfName(catalog, options.defaultArea);
  if (fallback && inAreaOf(catalog, fallback).length) {
    const picked = inRoom(catalog, fallback, utterance);
    if (!('error' in picked)) return { ...picked, anchored: false };
  }

  const awake = players.filter((player) => AWAKE.test(player.state));
  if (awake.length === 1) return { player: awake[0]!, reason: 'what is playing', anchored: false };
  if (awake.length > 1) {
    // Two things playing: Music Assistant's own player is the one that plays music, and its
    // name says so.
    const musicAssistant = awake.filter((player) => /\bma\b|music assistant/i.test(player.name));
    if (musicAssistant.length === 1) {
      return { player: musicAssistant[0]!, reason: 'the player Music Assistant owns', anchored: false };
    }
    return { error: `${awake.length} players are playing (${awake.map((player) => player.name).join(', ')})` };
  }
  if (players.length === 1) return { player: players[0]!, reason: 'the only player in the house', anchored: false };

  return {
    error: `nothing is playing, and none of the ${players.length} media players exposed to Assist (${players
      .map((player) => player.name)
      .join(', ')}) is in the room the sentence came from`,
  };
}

/** The television a power command is about, or why there is no single one. */
function televisionTarget(
  catalog: Catalog,
  utterance: string,
  on: boolean,
  options: { deviceId?: string; defaultArea?: string },
): { player: CatalogEntity; reason: string } | { error: string } {
  const televisions = playersIn(catalog).filter(isTelevision);
  if (!televisions.length) return { error: 'no television is exposed to Assist' };

  const named = playersNamed(televisions, utterance);
  if (named.length === 1) return { player: named[0]!, reason: 'the television the sentence named' };

  const pick = (candidates: CatalogEntity[], where: string): { player: CatalogEntity; reason: string } | { error: string } => {
    if (!candidates.length) return { error: `no television in ${where}` };
    const only = candidates.filter((tv) => (on ? ASLEEP.test(tv.state) : !ASLEEP.test(tv.state)));
    if (only.length === 1) return { player: only[0]!, reason: `the television in ${where}` };
    if (candidates.length === 1) return { player: candidates[0]!, reason: `the television in ${where}` };
    return { error: `${candidates.length} televisions in ${where}` };
  };

  const room = areaOfName(catalog, utterance);
  if (room) return pick(inAreaOf(catalog, room).filter(isTelevision), room.name);

  const spokenId = spokenAreaId(catalog, options.deviceId);
  const spoken = spokenId ? catalog.areas.find((area) => area.id === spokenId) : undefined;
  const fallback = spoken ?? areaOfName(catalog, options.defaultArea);
  if (fallback) {
    const inFallback = inAreaOf(catalog, fallback).filter(isTelevision);
    if (inFallback.length) return pick(inFallback, fallback.name);
  }

  if (televisions.length === 1) return { player: televisions[0]!, reason: 'the only television in the house' };
  return pick(televisions, 'the house');
}

/**
 * The whole feature, from one sentence to one tool call.
 *
 * Returns nothing when the sentence is not a media command, and an error when it is one this
 * reader cannot place — the caller forwards in that case rather than guessing.
 */
export function mediaPlan(input: {
  utterance: string;
  catalog: Catalog;
  inventory: ToolInventory;
  config: Config;
  deviceId?: string;
}): MediaPlan | { error: string } | null {
  const text = clean(input.utterance);
  const options: { deviceId?: string; defaultArea?: string } = {
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.config.catalog.defaultArea ? { defaultArea: input.config.catalog.defaultArea } : {}),
  };

  // A television is the one media player people switch on and off, and it is the only power
  // sentence this reader takes: "turn off the lights" belongs to the model, which knows how
  // many there are.
  const power = readPower(input.utterance);
  if (power) {
    const target = televisionTarget(input.catalog, text, power.on, options);
    if ('error' in target) return { error: target.error };
    const spec = specFor('media_player', power.on ? 'turn_on' : 'turn_off');
    if (!spec) return { error: 'media_player:turn_on/off has no Home Assistant intent' };
    const built = buildToolCall({
      intent: spec.intentType,
      spec,
      inventory: input.inventory,
      target: { entity: target.player },
      action: power.on ? 'turn_on' : 'turn_off',
    });
    if ('error' in built) return { error: built.error };
    return {
      plan: {
        kind: 'tool',
        tool: built.tool,
        args: built.args,
        targets: [target.player.id],
        action: power.on ? 'turn_on' : 'turn_off',
        domain: 'media_player',
      },
      reason: `media: ${target.player.name} ${power.on ? 'on' : 'off'} (${target.reason}), no model call`,
    };
  }

  const request = readTransport(input.utterance);
  if (!request) return null;

  // A kiosk music script steers what plays itself, and it knows the speaker the kiosk it was
  // spoken to follows — so "pause" and "a little louder" land where the music is, without
  // picking a player at all. Its `action` slot has the last word: a script that does not list
  // the action keeps going to the player, and so does a television.
  const kioskAction = KIOSK_ACTION[request.kind];
  const kiosk = kioskAction ? kioskTool(input.inventory) : undefined;
  if (kiosk && kioskAction && kiosk.profile.actions.includes(kioskAction)) {
    const room = areaOfName(input.catalog, text) ?? spokenArea(input.catalog, input.deviceId);
    const args: Record<string, unknown> = { [kiosk.profile.action]: kioskAction };
    // An empty speaker means "where this kiosk plays", so only a room that was named is sent.
    if (kiosk.profile.speaker && room) args[kiosk.profile.speaker] = room.name;
    return {
      plan: {
        kind: 'tool',
        tool: kiosk.name,
        args,
        targets: [],
        action: request.kind,
        domain: 'media_player',
      },
      reason: `media: ${PHRASE[request.kind]}${room ? ` in ${room.name}` : ''} via the kiosk music script, no model call`,
    };
  }

  const target = transportTarget(input.catalog, text, options);
  if ('error' in target) {
    // A bare "stop" or "pause" with nothing playing is not a media command at all, so it keeps
    // its old route instead of becoming an error on the trace.
    if (request.bare) return null;
    return { error: target.error };
  }
  // The same rule once the player is known: a bare "pause" needs something playing. Volume and
  // mute do not: setting the level before the music starts is a normal thing to ask for.
  const needsPlaying = request.kind !== 'louder' && request.kind !== 'quieter' && request.kind !== 'mute' && request.kind !== 'unmute';
  if (!target.anchored && needsPlaying && request.bare && !AWAKE.test(target.player.state)) return null;

  const action = ACTION[request.kind];
  const spec = specFor('media_player', action);
  if (!spec) return { error: `media_player:${action} has no Home Assistant intent` };

  let value: number | undefined;
  if (spec.relative) {
    const step = magnitudeStep(spec.valueKind, request.magnitude);
    value = (request.kind === 'louder' ? 1 : -1) * step;
  }

  const built = buildToolCall({
    intent: spec.intentType,
    spec,
    inventory: input.inventory,
    target: { entity: target.player },
    action,
    ...(value !== undefined ? { value } : {}),
  });
  if ('error' in built) return { error: built.error };

  return {
    plan: {
      kind: 'tool',
      tool: built.tool,
      args: built.args,
      targets: [target.player.id],
      action: request.kind,
      // A media call reads like the player it went to, so the speech rules that speak for
      // `media_player` speak for this one too.
      domain: 'media_player',
    },
    reason: `media: ${PHRASE[request.kind]} on ${target.player.name} (${target.reason}), no model call`,
  };
}
