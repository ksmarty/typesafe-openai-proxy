/**
 * Music, said the way people say it.
 *
 * "Play Taylor Swift" names no speaker, no media type and no provider, and all three have to
 * be worked out: the speaker is where the sentence was heard (or the one it names), the media
 * type follows from the shape of the phrase ("X by Y" is an album, a bare name is an artist),
 * and the provider is whichever music service Home Assistant offers a tool for.
 *
 * Music Assistant's own `play_media` is the right target when it is offered: it takes a media
 * type and resolves the name against every provider the user connected, so "Taylor Swift" as
 * an artist plays that provider's top tracks rather than forty albums. Home Assistant's
 * `HassMediaSearchAndPlay` intent is the fallback — it does the same job from one search
 * string, without a media type or a queue mode.
 *
 * The reader is English, like the weather reader. A sentence it does not understand returns
 * nothing and is forwarded, which is what every other fast path does.
 */

import { INTENTS, specFor } from './actions.js';
import type { Config } from './config.js';
import type { Catalog, CatalogArea, CatalogEntity, OpenAIToolFunction, ToolCallPlan } from './types.js';
import { buildToolCall, shortToolName, type ToolInventory } from './toolcall.js';
import { normalise } from './util.js';

/** What the sentence asked for, in the vocabulary the providers share. */
export type MusicKind = 'artist' | 'album' | 'track' | 'playlist' | 'radio' | 'genre';

export interface MusicRequest {
  /** What to play, without the artist when "by" split one off. */
  query: string;
  kind: MusicKind;
  /** The artist from "… by …", when the sentence gave one. */
  artist?: string;
  /** The words that named a speaker or room ("the kitchen"), when they resolved to one. */
  on?: string;
  /**
   * True when the sentence gave no media type at all, so the artist default applied:
   * "play Taylor Swift" is an artist, and every provider plays an artist as their top tracks.
   */
  bare: boolean;
}

/**
 * Playback verbs, longest first.
 *
 * A bare `start` is left out on purpose: "start the vacuum" is a command about a device, and
 * this reader only ever sees sentences that begin with a verb, so a loose one would turn the
 * rest of the house into search terms.
 */
const VERBS = ['start playing', 'put some', 'put on', 'queue up', 'listen to', 'stream', 'play'];

/** How people begin a request. Stripped before the verb, longest first. */
const LEAD_INS = [
  'go ahead and',
  'do you mind if you',
  'i would like to',
  "i'd like to",
  'i want to hear',
  'i want to',
  'i wanna hear',
  'i wanna',
  'could you',
  'can you',
  'would you',
  'will you',
  "let's hear",
  "let's",
  'lets',
  'please',
  'just',
  'hey',
  'okay',
  'ok',
  'then',
  'and',
  'so',
  'now',
];

/** Words that are a playback command rather than something to search for. */
const NOT_CONTENT = new Set([
  'it',
  'that',
  'this',
  'them',
  'music',
  'some music',
  'any music',
  'the music',
  'song',
  'the song',
  'a song',
  'something',
  'something else',
  'anything',
  'nothing',
  'pause',
  'stop',
  'resume',
  'continue',
  'again',
  'louder',
  'quieter',
  'next',
  'next song',
  'the next song',
  'previous',
  'previous song',
  'the previous song',
  'radio',
  'the radio',
  'playlist',
  'the playlist',
]);

/** Services a sentence may name after "on". We play from whichever provider answers. */
const PROVIDERS = [
  'spotify',
  'tidal',
  'youtube music',
  'youtube',
  'apple music',
  'deezer',
  'qobuz',
  'soundcloud',
  'bandcamp',
  'amazon music',
  'plex',
  'jellyfin',
  'filesystem',
  'radio browser',
];

/** Speaker-shaped words, for reading "… on the kitchen speaker" with no catalog to hand. */
const SPEAKER_WORDS = /\b(speaker|speakers|player|soundbar|stereo|tv|echo|homepod|group|system)\b/i;

const ARTICLE: Record<MusicKind, string> = {
  artist: 'an artist',
  album: 'an album',
  track: 'a track',
  playlist: 'a playlist',
  radio: 'a radio station',
  genre: 'a genre',
};

// ---------------------------------------------------------------------------
// Reading the sentence
// ---------------------------------------------------------------------------

/** Straighten quotes and drop the punctuation a spoken sentence trails with. */
function tidy(value: string): string {
  return value
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'«»]+/, '')
    .replace(/[\s"'«».!]+$/, '')
    .trim();
}

function stripLeadIns(text: string): string {
  const leads = [...LEAD_INS].sort((a, b) => b.length - a.length);
  let out = text;
  for (let guard = 0; guard < 5; guard += 1) {
    const lower = out.toLowerCase();
    const found = leads.find((lead) => lower === lead || lower.startsWith(`${lead} `) || lower.startsWith(`${lead},`));
    if (!found) break;
    out = out.slice(found.length).replace(/^[,\s]+/, '');
  }
  return out;
}

/** Everything after the playback verb, or nothing when the sentence has no verb in front. */
function afterVerb(text: string): string | undefined {
  const lower = text.toLowerCase();
  const verbs = [...VERBS].sort((a, b) => b.length - a.length);
  for (const verb of verbs) {
    if (lower === verb) return undefined;
    if (!lower.startsWith(`${verb} `)) continue;
    let rest = text.slice(verb.length).trim();
    // "play me …", "play us …" — the listener is already known.
    rest = rest.replace(/^(?:me|us|it)\s+/i, '');
    return rest || undefined;
  }
  return undefined;
}

interface Aside {
  /** The sentence without the speaker it named. */
  content: string;
  /** The words that named a speaker or room, when they resolved to one. */
  target?: string;
}

/**
 * Split "… on the kitchen speaker" off the end of the content.
 *
 * The words are dropped from what is searched for in every case — a sentence that names a
 * room is not searching for that room — but they only become a target when they actually name
 * a speaker or an area. "on Spotify" is a provider we do not route by, and "on repeat" is a
 * mode, so neither is treated as a place.
 */
function splitAside(rest: string, catalog?: Catalog): Aside | undefined {
  const match = /^(.*\S)\s+(?:on|in|at)\s+((?:the|my|our|a)\s+)?([^,]+)$/i.exec(rest);
  if (!match) return undefined;
  const content = match[1]!.trim();
  const phrase = `${match[2] ?? ''}${match[3] ?? ''}`.trim();
  if (!content || !phrase) return undefined;
  const determiner = Boolean(match[2]);
  const target = namesSpeaker(phrase, catalog);
  if (target) return { content, target: (match[3] ?? '').trim() };
  const provider = PROVIDERS.some((name) => normalise(phrase).includes(name));
  if (provider || determiner) return { content };
  return undefined;
}

/** Does this phrase name a speaker or a room the catalog knows? */
function namesSpeaker(phrase: string, catalog?: Catalog): boolean {
  const text = ` ${normalise(phrase)} `;
  if (catalog) {
    const player = catalog.entities
      .filter((entity) => entity.domain === 'media_player')
      .some((entity) =>
        [entity.name, ...(entity.aliases ?? [])].some((name) => text.includes(` ${normalise(name)} `)),
      );
    if (player) return true;
    return catalog.areas.some((area) =>
      [area.name, ...(area.aliases ?? [])].some((name) => {
        const value = normalise(name);
        return value.length > 1 && text.includes(` ${value} `);
      }),
    );
  }
  return SPEAKER_WORDS.test(phrase);
}

/**
 * Media type words that can lead a name with no article: "play radio station BBC Radio 4".
 * "song", "track", "single" and "band" are left out — "single ladies" and "band on the run"
 * are titles, and eating their first word would search for the wrong thing.
 */
const prefixWords = new Set(['album', 'record', 'playlist', 'radio station', 'radio', 'station']);

/** The media type the words themselves name, and the words without that marker. */
function readKind(text: string): { kind?: MusicKind; text: string } {
  let out = text;
  let kind: MusicKind | undefined;

  // "the top hits of Queen", "Queen's greatest hits": the artist, in their hits. Every
  // provider has that shelf under its own name, so this is only a way of saying "the artist".
  const hitsPrefix = /^(?:the\s+)?(?:top\s+hits|greatest\s+hits|top\s+tracks|top\s+songs|best\s+of|hits)\s+(?:of|by|from)\s+/i;
  const hitsSuffix = /\s*['’]?s?\s*(?:top\s+hits|greatest\s+hits|top\s+tracks|top\s+songs)\b.*$/i;
  if (hitsPrefix.test(out)) {
    out = out.replace(hitsPrefix, '');
    kind = 'artist';
  } else if (hitsSuffix.test(out)) {
    out = out.replace(hitsSuffix, '');
    kind = 'artist';
  }

  // "play music by Taylor Swift" — the artist, said the long way round.
  const byMusic = /^(?:music|songs|tunes|anything|something)\s+by\s+/i;
  if (!kind && byMusic.test(out)) {
    out = out.replace(byMusic, '');
    kind = 'artist';
  }

  const markers: { kind: MusicKind; words: string[] }[] = [
    { kind: 'album', words: ['album', 'record', 'lp'] },
    { kind: 'track', words: ['song', 'track', 'tune', 'single'] },
    { kind: 'playlist', words: ['playlist'] },
    { kind: 'radio', words: ['radio station', 'radio', 'station'] },
    { kind: 'artist', words: ['artist', 'band', 'singer'] },
  ];
  for (const marker of markers) {
    if (kind) break;
    for (const word of marker.words) {
      const patterns = [
        new RegExp(`^(?:the|a|an)\\s+${word}\\s+`, 'i'),
        new RegExp(`^${word}\\s+(?:called|named)\\s+`, 'i'),
        new RegExp(`\\s+${word}$`, 'i'),
      ];
      // "play radio station BBC Radio 4", "play album Rumours": the type word leads the name
      // with no article in front of it. Only the words that cannot also be part of a title
      // are read this way — "single" and "band" would eat the first word of the song.
      if (prefixWords.has(word)) patterns.push(new RegExp(`^${word}\\s+`, 'i'));
      const hit = patterns.find((pattern) => pattern.test(out));
      if (!hit) continue;
      out = out.replace(hit, '');
      kind = marker.kind;
      break;
    }
  }

  // "play some jazz": a genre, which every provider keeps as a shelf of its own.
  if (!kind) {
    const some = /^(?:some|any|a bit of|a little)\s+/i;
    if (some.test(out)) {
      out = out.replace(some, '');
      kind = 'genre';
    }
  }

  return { kind, text: out };
}

function splitArtist(text: string): { title: string; artist?: string } {
  const match = /\s+by\s+(.+)$/i.exec(text);
  if (!match) return { title: text };
  const title = text.slice(0, match.index).trim();
  const artist = (match[1] ?? '').trim();
  if (!title || !artist) return { title: text };
  return { title, artist };
}

function tidySong(value: string): string {
  return value
    .replace(/\s+(?:for me|please|now)$/i, '')
    .replace(/\s+(?:on|in|at)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'«»]+/, '')
    .replace(/[\s"'«».,!?]+$/, '')
    .trim();
}

/**
 * Read "play Taylor Swift" into what to ask a provider for.
 *
 * Returns nothing when the sentence is not a music request this reader understands — a
 * playback command with nothing to search for, a question about what is playing, or anything
 * that does not begin with a playback verb.
 */
export function readMusicRequest(utterance: string, catalog?: Catalog): MusicRequest | null {
  const text = tidy(utterance);
  if (!text || text.length > 200) return null;
  // "what's playing?", "which song is this?" — a state question, not a request.
  if (/\b(what|which|who)\b[^?]*\b(playing|listening to|song is this|track is this)\b/i.test(text)) return null;

  const rest = afterVerb(stripLeadIns(text));
  if (!rest) return null;

  const aside = splitAside(rest, catalog);
  const content = aside ? aside.content : rest;
  if (!content.trim()) return null;
  if (NOT_CONTENT.has(normalise(content))) return null;

  const reading = readKind(content);
  const split = splitArtist(reading.text);
  const query = tidySong(split.title);
  if (query.length < 2) return null;
  if (NOT_CONTENT.has(normalise(query))) return null;

  // "X by Y" names an album: a track is "the song X by Y", and a bare name is an artist.
  const kind: MusicKind = reading.kind ?? (split.artist ? 'album' : 'artist');
  return {
    query,
    kind,
    ...(split.artist ? { artist: split.artist } : {}),
    ...(aside?.target ? { on: aside.target } : {}),
    bare: reading.kind === undefined && !split.artist,
  };
}

// ---------------------------------------------------------------------------
// Choosing the speaker
// ---------------------------------------------------------------------------

export interface MusicTarget {
  player: CatalogEntity;
  /** Why this speaker, in the words the trace shows. */
  reason: string;
}

export type MusicTargetResult = MusicTarget | { error: string };

const OFF_STATES = /^(off|standby|unavailable|unknown|idle)$/i;

function areaOfName(catalog: Catalog, phrase: string | undefined): CatalogArea | undefined {
  if (!phrase) return undefined;
  const text = ` ${normalise(phrase)} `;
  const hits = catalog.areas
    .flatMap((area) => [area.name, ...(area.aliases ?? [])].map((name) => ({ area, name: normalise(name) })))
    .filter(({ name }) => name.length > 1 && text.includes(` ${name} `))
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0]?.area;
}

function playersNamed(players: CatalogEntity[], phrase: string): CatalogEntity[] {
  const text = ` ${normalise(phrase)} `;
  const hits = players
    .flatMap((player) => [player.name, ...(player.aliases ?? [])].map((name) => ({ player, name: normalise(name) })))
    .filter(({ name }) => name.length > 2 && text.includes(` ${name} `))
    .sort((a, b) => b.name.length - a.name.length);
  if (!hits.length) return [];
  const best = hits[0]!;
  // Two different speakers sharing the winning name are genuinely ambiguous.
  return [...new Set(hits.filter((hit) => hit.name === best.name).map((hit) => hit.player.id))].map(
    (id) => players.find((player) => player.id === id)!,
  );
}

/** The room the spoken-to device stands in, read off any of its entities. */
function spokenAreaId(catalog: Catalog, deviceId?: string): string | undefined {
  if (!deviceId) return undefined;
  return catalog.entities.find((entity) => entity.deviceId === deviceId && entity.areaId)?.areaId;
}

/**
 * Speakers only: a television is not where music starts when the room also has a speaker, and
 * every room with a TV in it has one, so a TV only wins when it is all there is.
 */
/** A name that ends in "TV" is a television even when the catalog carries no device class. */
const TV_NAME = /(?:^|\s)(?:tv|television)$/i;

function isTelevision(player: CatalogEntity): boolean {
  if ((player.deviceClass ?? '').toLowerCase() === 'tv') return true;
  return TV_NAME.test(player.name.trim());
}

function speakersIn(players: CatalogEntity[]): CatalogEntity[] {
  const withoutTv = players.filter((player) => !isTelevision(player));
  return withoutTv.length ? withoutTv : players;
}

function inAreaOf(catalog: Catalog, area: CatalogArea): CatalogEntity[] {
  return catalog.entities.filter(
    (entity) =>
      entity.domain === 'media_player' && (entity.areaId === area.id || entity.areaName === area.name),
  );
}

/**
 * The one speaker in a room.
 *
 * A room with a television and a speaker answers with the speaker, because a television is not
 * where music belongs. Two speakers with nothing to choose between them is an error rather than
 * a guess: playing in the wrong room is worse than handing the sentence on.
 */
export function roomSpeaker(catalog: Catalog, area: CatalogArea, on?: string): MusicTargetResult {
  const players = inAreaOf(catalog, area);
  if (!players.length) return { error: `no speaker in ${area.name}` };
  const speakers = speakersIn(players);
  if (speakers.length === 1) return { player: speakers[0]!, reason: `the only speaker in ${area.name}` };
  // A room with several speakers: "the kitchen speaker" still names one of them.
  const named = on ? playersNamed(speakers, on) : [];
  if (named.length === 1) return { player: named[0]!, reason: `the speaker the sentence named in ${area.name}` };
  // Otherwise the one already awake is what "play it here" means.
  const awake = speakers.filter((player) => !OFF_STATES.test(player.state));
  if (awake.length === 1) return { player: awake[0]!, reason: `the speaker already on in ${area.name}` };
  return { error: `${speakers.length} speakers in ${area.name}` };
}

/**
 * Which speaker should play.
 *
 * A room in the sentence wins over a name, because "the living room" is a room even when a
 * television in it is called "Living Room TV". Then a speaker named outright, then the very
 * device that was spoken to, then a speaker in the room the sentence was heard in, then the
 * only speaker in the house. Anything still ambiguous is an error rather than a guess: playing
 * in the wrong room is worse than handing the sentence on.
 */
export function musicTarget(
  catalog: Catalog,
  options: { on?: string; deviceId?: string; defaultArea?: string } = {},
): MusicTargetResult {
  const players = catalog.entities.filter((entity) => entity.domain === 'media_player');
  if (!players.length) return { error: 'no media player is exposed to Assist' };

  const namedArea = areaOfName(catalog, options.on);
  if (namedArea && inAreaOf(catalog, namedArea).length) return roomSpeaker(catalog, namedArea, options.on);

  const named = options.on ? playersNamed(players, options.on) : [];
  if (named.length === 1) return { player: named[0]!, reason: 'the speaker the sentence named' };
  if (named.length > 1) return { error: `${named.length} speakers match "${options.on}"` };

  // The device a satellite runs on owns the media player in the same room, so this is the
  // exact answer to "play it here" and it comes before any room-wide guess.
  if (options.deviceId) {
    const onDevice = players.filter((player) => player.deviceId === options.deviceId);
    if (onDevice.length === 1) return { player: onDevice[0]!, reason: 'the device that was spoken to' };
  }

  const spoken = spokenAreaId(catalog, options.deviceId);
  // The room the sentence was heard in: the room of the device that sent it, or the room the
  // dashboard says this assistant is in when the request does not name a device.
  const area =
    (spoken ? catalog.areas.find((row) => row.id === spoken) : undefined) ??
    areaOfName(catalog, options.defaultArea);

  if (area && inAreaOf(catalog, area).length) {
    const room = roomSpeaker(catalog, area, options.on);
    return 'error' in room ? room : { player: room.player, reason: `${room.reason}, where it was asked` };
  }

  if (players.length === 1) return { player: players[0]!, reason: 'the only speaker in the house' };
  return { error: 'no speaker to play on' };
}

// ---------------------------------------------------------------------------
// Building the call
// ---------------------------------------------------------------------------

/**
 * Slots a play service uses for the thing to play, in the order we prefer them.
 *
 * Music Assistant's own service asks for `media_id`; Home Assistant's generic
 * `media_player.play_media` asks for `media_content_id` and a `media_content_type` to go with
 * it, which is the pair every Music Assistant player also answers.
 */
const MEDIA_ID_SLOTS = ['media_id', 'media_ids', 'media_content_id', 'media', 'uri', 'content_id'];

const MEDIA_TYPE_SLOTS = ['media_type', 'media_content_type'];
const ARTIST_SLOTS = ['artist'];
const ENQUEUE_SLOTS = ['enqueue'];
// A service tool may name its target `entity_id`, `entity`, `target`, or — the way the Assist
// intent tools do — `name`, which takes an entity id just the same.
const ENTITY_SLOTS = ['entity_id', 'entity', 'target', 'name'];
const AREA_SLOTS = ['area', 'area_id'];

export interface MusicToolMatch {
  name: string;
  fn: OpenAIToolFunction;
  provider: 'music_assistant' | 'media_player';
}

function propertiesOf(fn: OpenAIToolFunction): Record<string, unknown> {
  return (fn.parameters?.properties ?? {}) as Record<string, unknown>;
}

function slotName(properties: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(properties);
  for (const candidate of candidates) {
    const hit = keys.find((key) => key.toLowerCase() === candidate);
    if (hit) return hit;
  }
  return undefined;
}

/** Does the slot accept this value? A slot with no enum accepts anything. */
function allows(schema: unknown, value: string): boolean {
  const list = (schema as { enum?: unknown[] } | undefined)?.enum;
  if (!Array.isArray(list) || !list.length) return true;
  return list.some((item) => String(item).toLowerCase() === value.toLowerCase());
}

function looksLikePlayMedia(name: string): boolean {
  const short = shortToolName(name);
  return /(^|[_.-])play_media$/i.test(short) || /play_media$/i.test(name);
}

/**
 * The play service Home Assistant offers, when it offers one.
 *
 * Matched on the shape of the tool rather than a fixed name: Home Assistant names service
 * tools after the domain and the service, so `music_assistant__play_media`,
 * `media_player__play_media`, `music_assistant.play_media` and
 * `assist__music_assistant__play_media` are all the same thing. A tool that cannot take a
 * media id is not this service, whatever it is called.
 *
 * Music Assistant's own service is preferred, because it takes a media type and an artist and
 * so resolves a bare name to the artist's top tracks. Falling back to the media player's own
 * `play_media` keeps working on a house where Music Assistant is reached through its players,
 * which is how Home Assistant exposed it before the integration had a service of its own.
 */
export function musicTool(
  inventory: ToolInventory,
  provider: Config['music']['provider'] = 'auto',
): MusicToolMatch | undefined {
  if (provider === 'assist') return undefined;
  const candidates: { name: string; fn: OpenAIToolFunction; preferred: boolean }[] = [];
  for (const [name, fn] of inventory) {
    if (!looksLikePlayMedia(name)) continue;
    const preferred = /music[_-]?assistant|(^|[_.])mass([_.]|$)/i.test(name);
    if (provider === 'music_assistant' && !preferred) continue;
    if (!slotName(propertiesOf(fn), MEDIA_ID_SLOTS)) continue;
    candidates.push({ name, fn, preferred });
  }
  const best = candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred))[0];
  return best
    ? {
        name: best.name,
        fn: best.fn,
        provider: best.preferred ? 'music_assistant' : 'media_player',
      }
    : undefined;
}

/** The media type a kind asks the provider for. */
export function mediaTypeFor(kind: MusicKind, artist: Config['music']['artist'] = 'artist'): string {
  if (kind === 'artist') return artist === 'radio' ? 'radio' : 'artist';
  return kind;
}

/** What Home Assistant's own media search should be handed: the words a person would say. */
function searchText(request: MusicRequest): string {
  return request.artist ? `${request.query} by ${request.artist}` : request.query;
}

export interface MusicCall {
  tool: string;
  args: Record<string, unknown>;
  /** Which service took the request; the trace says so. */
  provider: 'music_assistant' | 'media_player' | 'assist';
}

/**
 * The arguments a play service wants, from a name and where it should go.
 *
 * Returns nothing when the service has no slot for a media id, because there is then nothing to
 * tell it what to play.
 */
function serviceArgs(input: {
  service: MusicToolMatch;
  player: CatalogEntity;
  config: Config;
  mediaId: string;
  mediaType?: string;
  artist?: string;
}): Record<string, unknown> | undefined {
  const { service, player, config } = input;
  const properties = propertiesOf(service.fn);
  const idSlot = slotName(properties, MEDIA_ID_SLOTS);
  if (!idSlot) return undefined;

  const args: Record<string, unknown> = { [idSlot]: input.mediaId };
  const entitySlot = slotName(properties, ENTITY_SLOTS);
  if (entitySlot) {
    args[entitySlot] = player.id;
  } else {
    // With no slot for one entity, the room is the narrowest thing the service takes.
    const areaSlot = slotName(properties, AREA_SLOTS);
    if (areaSlot && player.areaName) args[areaSlot] = player.areaName;
  }

  const typeSlot = slotName(properties, MEDIA_TYPE_SLOTS);
  // Only send a media type the service declares: an unknown one is a failed call.
  // Home Assistant's generic play service accepts any content type, so a name and the Music
  // Assistant media type go to it unchanged — that is what makes "play Taylor Swift" the
  // artist's top tracks rather than a search for a song called Taylor Swift.
  if (typeSlot) {
    const declared = input.mediaType && allows(properties[typeSlot], input.mediaType) ? input.mediaType : undefined;
    // A service that insists on a content type still gets one when the sentence was vague.
    const required = (service.fn.parameters?.required ?? []).includes(typeSlot);
    const fallback = required && allows(properties[typeSlot], 'music') ? 'music' : undefined;
    const content = declared ?? fallback;
    if (content) args[typeSlot] = content;
  }

  // The album title goes alone unless the service has a slot for the artist, so a provider can
  // still tell two albums with one name apart.
  const artistSlot = slotName(properties, ARTIST_SLOTS);
  if (artistSlot && input.artist) args[artistSlot] = input.artist;

  const enqueueSlot = slotName(properties, ENQUEUE_SLOTS);
  if (enqueueSlot && allows(properties[enqueueSlot], config.music.enqueue)) {
    args[enqueueSlot] = config.music.enqueue;
  }
  return args;
}

/**
 * A media search the router decided, played the same way as one this module read itself.
 *
 * The pipeline's fast path reads the sentence, but a phrasing it misses arrives at the router as
 * `search_and_play` with a free-text query. Sending that through the play service means a room
 * still plays on the speaker in it — and an install with no Music Assistant still works through
 * Home Assistant's own search intent.
 */
export function mediaSearchCall(input: {
  text: string;
  player: CatalogEntity;
  inventory: ToolInventory;
  config: Config;
}): MusicCall | { error: string } {
  const text = input.text.trim();
  const split = /\s+by\s+(.+)$/i.exec(text);
  const title = split ? text.slice(0, split.index).trim() : text;
  const request: MusicRequest = split
    ? { query: title, kind: 'album', artist: split[1]!.trim(), bare: false }
    : { query: title, kind: 'artist', bare: false };
  return musicCall({ request, player: input.player, inventory: input.inventory, config: input.config });
}

export function musicCall(input: {
  request: MusicRequest;
  player: CatalogEntity;
  inventory: ToolInventory;
  config: Config;
}): MusicCall | { error: string } {
  const { request, player, inventory, config } = input;
  const service = musicTool(inventory, config.music.provider);
  if (service) {
    const args = serviceArgs({
      service,
      player,
      config,
      mediaId: request.query,
      ...(request.kind ? { mediaType: mediaTypeFor(request.kind, config.music.artist) } : {}),
      ...(request.artist ? { artist: request.artist } : {}),
    });
    if (args) return { tool: service.name, args, provider: service.provider };
  }

  // Home Assistant's own search intent: one string, no media type, no queue control.
  const spec = specFor('media_player', 'search_and_play');
  if (!spec) return { error: 'no media search action is known' };
  const built = buildToolCall({
    intent: INTENTS.mediaSearchAndPlay,
    spec,
    inventory,
    target: { entity: player },
    action: 'search_and_play',
    text: searchText(request),
  });
  if ('error' in built) return { error: built.error };
  return { tool: built.tool, args: built.args, provider: 'assist' };
}

export interface MusicPlan {
  plan: ToolCallPlan;
  reason: string;
}

/**
 * The whole feature, from one sentence to one tool call.
 *
 * Returns nothing when the sentence is not a music request (so the rest of the pipeline runs
 * exactly as before), and an error when it is one but cannot be placed or addressed — the
 * caller forwards in that case rather than guessing.
 */
export function musicPlan(input: {
  utterance: string;
  catalog: Catalog;
  inventory: ToolInventory;
  config: Config;
  deviceId?: string;
}): MusicPlan | { error: string } | null {
  const request = readMusicRequest(input.utterance, input.catalog);
  if (!request) return null;

  const target = musicTarget(input.catalog, {
    ...(request.on ? { on: request.on } : {}),
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    defaultArea: input.config.catalog.defaultArea,
  });
  if ('error' in target) return { error: target.error };

  const call = musicCall({ request, player: target.player, inventory: input.inventory, config: input.config });
  if ('error' in call) return { error: call.error };

  const service =
    call.provider === 'music_assistant'
      ? 'Music Assistant'
      : call.provider === 'media_player'
        ? "the player's own play service"
        : "Home Assistant's media search";
  const what = request.artist ? `${request.query} by ${request.artist}` : request.query;
  return {
    plan: {
      kind: 'tool',
      tool: call.tool,
      args: call.args,
      targets: [target.player.id],
      action: 'search_and_play',
      domain: call.provider === 'assist' ? 'media_player' : call.provider,
    },
    reason: `music: "${what}" as ${ARTICLE[request.kind]} on ${target.player.name} (${target.reason}) via ${service}, no model call`,
  };
}
