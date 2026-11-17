/**
 * Sports, read from the sensors the sports-ticker integration already publishes.
 *
 * A house that follows a team should be able to say "how are the Chiefs doing?" and get the
 * score, not a forwarded question that costs a model call and may or may not find the number.
 * The integration (LiquidFXX/sports-ticker) fetches ESPN itself and publishes the raw feed as
 * sensor attributes, so everything needed is already inside Home Assistant: the scoreboard
 * sensors carry the games, the standings sensors carry the table, the rankings sensor carries
 * the polls, and the next-game sensors carry the schedule. No second service is called from
 * here — one `GET /api/states` against Home Assistant is the whole conversation.
 *
 * The reader is deliberately narrow about what it claims. It answers a question only when a
 * named team, league or favourite actually resolves in the sensors; anything else returns
 * `null` and the turn continues down the normal path to the decision model and the language
 * model. That is what keeps "play the game" a media command and "how are the lights doing" a
 * state question, even though both contain words that look like sport.
 *
 * Spoiler delay is respected. The integration can publish a second, delayed scoreboard so
 * nobody learns a result before they have watched it; when both sensors exist the delayed one
 * is read, because the house has said it wants to hear the score late rather than early.
 *
 * Everything here fails soft. No Home Assistant URL, no token, an HTTP error, a sensor that
 * changed shape: the module answers `null` with a line in the log ring, and the request is
 * forwarded exactly as it was before the feature existed.
 */

import { note } from './log.js';
import type { Config } from './config.js';
import { fetchWithTimeout, normalise } from './util.js';

/** The kinds of question this answers, and therefore the shapes of answer it can give. */
export type SportsKind = 'score' | 'next' | 'standings' | 'rankings' | 'roundup';

/** What was asked, once the sentence has been read. */
export interface SportsQuestion {
  kind: SportsKind;
  /** The league named in the sentence, when one was ("nfl", "epl"). */
  league: string | null;
  /** The sentence, normalised, so team names can be matched against it later. */
  spoken: string;
  /** The sentence says "my team" — follow the favourite rather than a name. */
  mine: boolean;
  /** Upper-case abbreviations in the raw sentence, which is how "KC" is allowed to match. */
  abbreviations: string[];
}

/** One side of a game. */
export interface SportsTeamLine {
  abbr: string;
  name: string;
  displayName: string;
  shortName: string;
  score: number | null;
  winner: boolean;
  homeAway: 'home' | 'away' | null;
  record: string | null;
}

/** One game, from the scoreboard sensor's `events`. */
export interface SportsEvent {
  league: string;
  name: string;
  shortName: string;
  start: string | null;
  state: 'pre' | 'in' | 'post';
  detail: string | null;
  clock: string | null;
  period: number | null;
  teams: SportsTeamLine[];
}

/** One line of a standings table, whichever shape the league's profile publishes. */
export interface SportsStandingRow {
  position: number | null;
  abbr: string | null;
  name: string | null;
  shortName: string | null;
  group: string | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  points: number | null;
  record: string | null;
  gamesBack: string | null;
  streak: string | null;
  favorite: boolean;
}

/** One line of a poll (college football rankings). */
export interface SportsRankRow {
  rank: number | null;
  abbr: string | null;
  name: string | null;
  record: string | null;
}

/** One game from the `next_game` sensor: the favourite team's schedule, soonest first. */
export interface SportsFixture {
  matchup: string | null;
  opponent: string | null;
  opponentName: string | null;
  start: string | null;
  venue: string | null;
  homeAway: string | null;
  detail: string | null;
}

/** Everything the sensors say about one league. */
export interface SportsLeague {
  league: string;
  label: string;
  favoriteTeam: string | null;
  favoriteTeamName: string | null;
  events: SportsEvent[];
  standings: SportsStandingRow[];
  rankings: SportsRankRow[];
  poll: string | null;
  /** The favourite team's schedule as the `next_game` sensor publishes it, soonest first. */
  fixtures: SportsFixture[];
  /** True when the games come from the spoiler-delayed scoreboard. */
  delayed: boolean;
  stale: boolean;
}

/** Everything the sensors say, all leagues at once. */
export interface SportsSnapshot {
  leagues: SportsLeague[];
  at: number;
}

/** A spoken answer, plus the subject it was about (used in the trace's reason). */
export interface SportsAnswer {
  text: string;
  about: string;
}

/**
 * The league codes sports-ticker uses in its entity ids, with the name the house would say.
 *
 * These are the codes from the integration's own `league_data.py`, which is why they are
 * `seriea` and `ligue1` rather than the `serie_a`/`ligue_1` spellings its README uses.
 */
const LEAGUES: Record<string, string> = {
  nfl: 'the NFL',
  cfb: 'college football',
  mlb: 'MLB',
  nba: 'the NBA',
  wnba: 'the WNBA',
  nhl: 'the NHL',
  mls: 'MLS',
  epl: 'the Premier League',
  laliga: 'La Liga',
  bundesliga: 'the Bundesliga',
  seriea: 'Serie A',
  ligue1: 'Ligue 1',
  ucl: 'the Champions League',
  pga: 'the PGA Tour',
  nascar: 'NASCAR',
};

/** The league codes this reader understands, in the order they are preferred in a tie. */
export const SPORTS_LEAGUES = Object.keys(LEAGUES);

/** How a live game's clock is counted, per league, so the words match the sport. */
const PERIOD_WORD: Record<string, 'quarter' | 'period' | 'half' | 'inning'> = {
  nfl: 'quarter',
  cfb: 'quarter',
  nba: 'quarter',
  wnba: 'quarter',
  nhl: 'period',
  mlb: 'inning',
  mls: 'half',
  epl: 'half',
  laliga: 'half',
  bundesliga: 'half',
  seriea: 'half',
  ligue1: 'half',
  ucl: 'half',
};

/** Nicknames people say that the sensors never publish as a team name. */
const NICKNAMES: Record<string, string> = {
  niners: '49ers',
  pats: 'Patriots',
  yanks: 'Yankees',
  dubs: 'Warriors',
  sixers: '76ers',
  raps: 'Raptors',
  bucs: 'Buccaneers',
  bolts: 'Chargers',
  bama: 'Alabama',
  tide: 'Alabama',
  vols: 'Tennessee',
  dawgs: 'Georgia',
  buckeyes: 'Ohio State',
  irish: 'Notre Dame',
  gators: 'Florida',
  spartans: 'Michigan State',
  canes: 'Miami',
  aubie: 'Auburn',
  hoosiers: 'Indiana',
};

// --- reading the sensors ----------------------------------------------------

/** `sensor.espn_<league>_scoreboard_raw` and the optional `..._scoreboard_delayed`. */
const SCOREBOARD = /^sensor\.espn_([a-z0-9]+)_scoreboard_(raw|delayed)$/;
/** `sensor.espn_<league>_standings_raw`. */
const STANDINGS = /^sensor\.espn_([a-z0-9]+)_standings_raw$/;
/** `sensor.espn_<league>_next_game`. */
const NEXT_GAME = /^sensor\.espn_([a-z0-9]+)_next_game$/;
/** `sensor.espn_college_football_rankings` — the one entity whose id is not a league code. */
const RANKINGS = /^sensor\.espn_(college_football|cfb)_rankings$/;

interface MutableLeague {
  league: string;
  favoriteTeam: string | null;
  favoriteTeamName: string | null;
  rawEvents: SportsEvent[];
  delayedEvents: SportsEvent[];
  delayed: boolean;
  standings: SportsStandingRow[];
  rankings: SportsRankRow[];
  poll: string | null;
  fixtures: SportsFixture[];
  stale: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed) && value.trim() !== '') return parsed;
  }
  return null;
}

function flag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

/** The first value that is present among a row's possible key names. */
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function leagueLabel(league: string): string {
  return LEAGUES[league] ?? league.toUpperCase();
}

/** One competitor, whichever of ESPN's several field names carries each fact. */
function readTeamLine(raw: unknown): SportsTeamLine | null {
  const competitor = record(raw);
  if (!competitor) return null;
  const team = record(competitor.team) ?? competitor;
  const abbr = (text(team.abbreviation) ?? text(pick(team, ['abbr', 'shortName'])) ?? '').toUpperCase();
  const displayName = text(team.displayName) ?? text(team.name) ?? text(team.shortDisplayName) ?? abbr;
  const shortName = text(team.shortDisplayName) ?? text(team.name) ?? displayName;
  const name = text(team.name) ?? text(team.nickname) ?? shortName;
  if (!abbr && !displayName) return null;
  const records = Array.isArray(competitor.records) ? competitor.records : [];
  let recordSummary: string | null = null;
  for (const entry of records) {
    const line = record(entry);
    recordSummary = text(line?.summary) ?? text(line?.displayValue) ?? recordSummary;
    if (recordSummary) break;
  }
  const homeAway = text(competitor.homeAway);
  return {
    abbr,
    name,
    displayName,
    shortName,
    score: count(competitor.score),
    winner: flag(competitor.winner),
    homeAway: homeAway === 'home' || homeAway === 'away' ? homeAway : null,
    record: recordSummary ?? text(competitor.record),
  };
}

/** One game out of the scoreboard's `events`, tolerating a missing competition or status. */
function readEvents(league: string, raw: unknown): SportsEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: SportsEvent[] = [];
  for (const item of raw) {
    const event = record(item);
    if (!event) continue;
    const competitions = Array.isArray(event.competitions) ? event.competitions : [];
    const competition = record(competitions[0]) ?? {};
    const status = record(competition.status) ?? record(event.status) ?? {};
    const type = record(status.type) ?? {};
    const stateWord = text(type.state);
    const state: SportsEvent['state'] =
      stateWord === 'in' || stateWord === 'post' ? stateWord : flag(type.completed) ? 'post' : 'pre';
    const competitors = Array.isArray(competition.competitors)
      ? competition.competitors
      : Array.isArray(event.competitors)
        ? event.competitors
        : [];
    const teams = competitors
      .map((entry) => readTeamLine(entry))
      .filter((entry): entry is SportsTeamLine => entry !== null);
    if (!teams.length) continue;
    events.push({
      league,
      name: text(event.name) ?? text(event.shortName) ?? teams.map((team) => team.displayName).join(' at '),
      shortName: text(event.shortName) ?? '',
      start: text(competition.date) ?? text(event.date),
      state,
      detail: text(type.shortDetail) ?? text(type.detail),
      clock: text(status.displayClock),
      period: count(status.period),
      teams,
    });
  }
  return events;
}

/** Every array of team rows inside a standings payload, whichever profile wrote it. */
function standingsRowObjects(attributes: Record<string, unknown>): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const pushArray = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      const row = record(entry);
      if (row) rows.push(row);
    }
  };
  const pushGroups = (value: unknown, deep: boolean): void => {
    const groups = record(value);
    if (!groups) return;
    for (const group of Object.values(groups)) {
      pushArray(group);
      const box = record(group);
      if (box) {
        pushArray(box.teams);
        if (deep) pushArray(box.entries);
      }
    }
  };
  pushArray(attributes.teams);
  pushArray(attributes.table);
  pushGroups(attributes.conferences, true);
  pushGroups(attributes.divisions, true);
  pushGroups(attributes.leagues, true);
  return rows;
}

function readStandingRow(row: Record<string, unknown>): SportsStandingRow | null {
  const abbr = (text(pick(row, ['abbreviation', 'team_abbr', 'abbr', 'team_abbreviation'])) ?? '').toUpperCase() || null;
  const name = text(pick(row, ['display_name', 'displayName', 'team_name', 'name', 'short_name', 'shortName']));
  if (!abbr && !name) return null;
  return {
    position: count(pick(row, ['position', 'rank', 'group_rank', 'conference_rank', 'league_rank', 'seed'])),
    abbr,
    name,
    shortName: text(pick(row, ['short_name', 'shortName', 'nickname'])),
    group: text(pick(row, ['group', 'conference', 'league_group', 'division', 'group_name', 'groupName'])),
    wins: count(pick(row, ['wins'])),
    losses: count(pick(row, ['losses'])),
    ties: count(pick(row, ['ties', 'draws'])),
    points: count(pick(row, ['points'])),
    record: text(pick(row, ['record', 'overall_record', 'overallRecord'])),
    gamesBack: text(pick(row, ['games_back', 'gamesBack', 'games_behind'])),
    streak: text(pick(row, ['streak'])),
    favorite: flag(pick(row, ['favorite', 'is_favorite', 'isFavorite'])),
  };
}

function readStandings(attributes: Record<string, unknown>): SportsStandingRow[] {
  const seen = new Set<string>();
  const rows: SportsStandingRow[] = [];
  for (const raw of standingsRowObjects(attributes)) {
    const row = readStandingRow(raw);
    if (!row) continue;
    const key = `${row.abbr ?? ''}|${normalise(row.name ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** The polls, as one ranked list plus the poll's name. AP is preferred, then the CFP, then coaches. */
function readRankings(attributes: Record<string, unknown>): { rows: SportsRankRow[]; poll: string | null } {
  const polls = record(attributes.polls) ?? {};
  const candidates: { poll: string; raw: unknown }[] = [
    { poll: 'AP poll', raw: attributes.ap_top_25 ?? record(polls.ap_top_25)?.ranks },
    { poll: 'CFP rankings', raw: attributes.cfp ?? record(polls.cfp)?.ranks },
    { poll: 'coaches poll', raw: attributes.coaches_poll ?? record(polls.coaches_poll)?.ranks },
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate.raw) || !candidate.raw.length) continue;
    const rows: SportsRankRow[] = [];
    for (const entry of candidate.raw) {
      const row = record(entry);
      if (!row) continue;
      const rank = count(pick(row, ['rank', 'current']));
      const name = text(pick(row, ['display_name', 'displayName', 'name', 'short_display_name', 'location']));
      if (rank === null || !name) continue;
      rows.push({
        rank,
        abbr: (text(pick(row, ['abbreviation', 'abbr'])) ?? '').toUpperCase() || null,
        name,
        record: text(row.record),
      });
    }
    if (rows.length) return { rows, poll: candidate.poll };
  }
  return { rows: [], poll: null };
}

function readFixture(attributes: Record<string, unknown>): SportsFixture | null {
  if (!flag(attributes.has_upcoming_game)) return null;
  const event = record(attributes.event);
  const start = text(attributes.date) ?? text(event?.date);
  const matchup = text(attributes.matchup) ?? text(event?.shortName);
  if (!start && !matchup) return null;
  return {
    matchup,
    opponent: text(attributes.opponent),
    opponentName: text(attributes.opponent_name),
    start,
    venue: text(attributes.venue),
    homeAway: text(attributes.home_away),
    detail: text(attributes.status_detail),
  };
}

/**
 * One row of the `next_game` sensor's `upcoming_games` list.
 *
 * The rows are flatter than the single event the same sensor repeats at the top level, and they are
 * the only way to answer "when do they play next" for a game after the one on today's board.
 */
function readFixtureRow(row: Record<string, unknown>): SportsFixture | null {
  const start = text(row.date);
  const matchup = text(row.matchup);
  if (!start && !matchup) return null;
  return {
    matchup,
    opponent: text(row.opponent),
    opponentName: text(row.opponent_name),
    start,
    venue: text(row.venue),
    homeAway: text(row.home_away),
    detail: text(row.status_detail),
  };
}

/**
 * The favourite team's upcoming games, soonest first.
 *
 * `upcoming_games` is the list to read; `next_five` is the same array under its other name, so it is
 * only consulted when the first is missing — reading both would double every fixture. When neither
 * is there, the single event the sensor publishes at the top level is still one answer.
 */
function readFixtures(attributes: Record<string, unknown>): SportsFixture[] {
  for (const list of [attributes.upcoming_games, attributes.next_five]) {
    if (!Array.isArray(list)) continue;
    const fixtures: SportsFixture[] = [];
    for (const item of list) {
      const row = record(item);
      if (!row) continue;
      const fixture = readFixtureRow(row);
      if (fixture) fixtures.push(fixture);
    }
    if (fixtures.length) return fixtures;
  }
  const single = readFixture(attributes);
  return single ? [single] : [];
}

/** The league code an entity id belongs to, or null for anything this reader does not know. */
function leagueOf(group: string): string | null {
  const league = group === 'college_football' ? 'cfb' : group;
  return LEAGUES[league] ? league : null;
}

/**
 * The snapshot the sensors already hold, built from a `GET /api/states` reply.
 *
 * Pure on purpose: the tests hand it a fixture and read the snapshot back, so what the reader
 * believes about the integration's attributes is pinned down without a Home Assistant to ask.
 */
export function sportsFromStates(states: unknown, settings: Config['sports']): SportsSnapshot | null {
  if (!Array.isArray(states)) return null;
  const only = new Set(
    (settings?.leagues ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const respectDelay = (settings?.spoilerDelay ?? 'respect') !== 'ignore';
  const wanted = (league: string): boolean => !only.size || only.has(league);

  const box = new Map<string, MutableLeague>();
  const of = (league: string): MutableLeague => {
    const existing = box.get(league);
    if (existing) return existing;
    const fresh: MutableLeague = {
      league,
      favoriteTeam: null,
      favoriteTeamName: null,
      rawEvents: [],
      delayedEvents: [],
      delayed: false,
      standings: [],
      rankings: [],
      poll: null,
      fixtures: [],
      stale: false,
    };
    box.set(league, fresh);
    return fresh;
  };

  for (const item of states) {
    const state = record(item);
    if (!state) continue;
    const entityId = text(state.entity_id) ?? '';
    if (!entityId.startsWith('sensor.espn_')) continue;
    const attributes = record(state.attributes) ?? {};

    const rankingsMatch = RANKINGS.exec(entityId);
    if (rankingsMatch) {
      const league = leagueOf(rankingsMatch[1] ?? '');
      if (!league || !wanted(league)) continue;
      const target = of(league);
      const { rows, poll } = readRankings(attributes);
      if (rows.length) {
        target.rankings = rows;
        target.poll = poll;
      }
      continue;
    }

    const scoreboard = SCOREBOARD.exec(entityId);
    if (scoreboard) {
      const league = leagueOf(scoreboard[1] ?? '');
      if (!league || !wanted(league)) continue;
      const target = of(league);
      const events = readEvents(league, attributes.events);
      if (scoreboard[2] === 'delayed') {
        target.delayedEvents = events;
        target.delayed = true;
      } else {
        target.rawEvents = events;
      }
      target.favoriteTeam = text(attributes.favorite_team) ?? target.favoriteTeam;
      target.favoriteTeamName = text(attributes.favorite_team_name) ?? target.favoriteTeamName;
      target.stale = target.stale || flag(attributes.stale);
      continue;
    }

    const standings = STANDINGS.exec(entityId);
    if (standings) {
      const league = leagueOf(standings[1] ?? '');
      if (!league || !wanted(league)) continue;
      const target = of(league);
      target.standings = readStandings(attributes);
      target.favoriteTeam = text(attributes.favorite_team) ?? target.favoriteTeam;
      target.favoriteTeamName = text(attributes.favorite_team_name) ?? target.favoriteTeamName;
      target.stale = target.stale || flag(attributes.stale);
      continue;
    }

    const next = NEXT_GAME.exec(entityId);
    if (next) {
      const league = leagueOf(next[1] ?? '');
      if (!league || !wanted(league)) continue;
      const target = of(league);
      target.fixtures = readFixtures(attributes);
      target.favoriteTeam = text(attributes.favorite_team) ?? target.favoriteTeam;
      target.favoriteTeamName = text(attributes.favorite_team_name) ?? target.favoriteTeamName;
      continue;
    }
  }

  const leagues: SportsLeague[] = [];
  for (const target of box.values()) {
    // A delayed scoreboard is the same games, minutes late. When the house asked for the delay
    // it is the only scoreboard this reader is allowed to speak from.
    const delayed = respectDelay ? target.delayedEvents : [];
    const events = delayed.length ? delayed : target.rawEvents;
    leagues.push({
      league: target.league,
      label: leagueLabel(target.league),
      favoriteTeam: target.favoriteTeam,
      favoriteTeamName: target.favoriteTeamName,
      events,
      standings: target.standings,
      rankings: target.rankings,
      poll: target.poll,
      fixtures: target.fixtures,
      delayed: Boolean(delayed.length),
      stale: target.stale,
    });
  }
  if (!leagues.length) return null;
  return { leagues, at: Date.now() };
}

// --- asking Home Assistant --------------------------------------------------

const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;

interface CachedSnapshot {
  key: string;
  at: number;
  snapshot: SportsSnapshot;
}

let cached: CachedSnapshot | null = null;
let inflight: { key: string; request: Promise<SportsSnapshot | null> } | null = null;

export function clearSportsCache(): void {
  cached = null;
  inflight = null;
}

/**
 * Every sports-ticker sensor in the house, cached for half a minute.
 *
 * One `GET /api/states` is shared by every question in that window, which matters because a
 * scoreboard changes on the scale of a minute and a household may ask twice in ten seconds.
 * Failures never throw: a missing URL or token, a 401, a timeout or unreadable JSON all answer
 * `null`, so the turn is forwarded as it would have been without this module.
 */
export async function sportsFor(config: Config): Promise<SportsSnapshot | null> {
  const settings = config.sports;
  if (!settings?.enabled) return null;
  const base = (config.catalog?.haUrl ?? '').trim().replace(/\/+$/, '');
  const token = (config.catalog?.haToken ?? '').trim();
  if (!base || !token) return null;

  const cacheMs = Number.isFinite(settings.cacheMs) && settings.cacheMs > 0 ? settings.cacheMs : DEFAULT_CACHE_MS;
  const key = `${base}|${settings.leagues ?? ''}|${settings.spoilerDelay ?? 'respect'}`;
  if (cached && cached.key === key && Date.now() - cached.at < cacheMs) return cached.snapshot;
  if (inflight && inflight.key === key) return inflight.request;

  const timeoutMs =
    Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
  const request = (async (): Promise<SportsSnapshot | null> => {
    try {
      const response = await fetchWithTimeout(
        `${base}/api/states`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
        timeoutMs,
      );
      if (!response.ok) {
        note(`sports: Home Assistant answered HTTP ${response.status} for the states — forwarding sports questions`);
        return null;
      }
      const payload: unknown = await response.json();
      const snapshot = sportsFromStates(payload, settings);
      if (!snapshot) {
        note('sports: no sports-ticker sensor carries a game right now — forwarding sports questions');
        return null;
      }
      cached = { key, at: Date.now(), snapshot };
      return snapshot;
    } catch (error: unknown) {
      note(`sports: Home Assistant could not be reached (${error instanceof Error ? error.message : String(error)})`);
      return null;
    } finally {
      if (inflight?.key === key) inflight = null;
    }
  })();

  inflight = { key, request };
  return request;
}

// --- reading the question ---------------------------------------------------

/** A sentence that asks something, so it can be a question about sport without naming a league. */
const ASKING =
  /^(what|whats|when|whens|where|who|whos|how|is|are|was|were|do|does|did|will|would|can|could|any|should|which|tell me|give me)\b/;

/**
 * A sentence that names a sport, said the ways people say it.
 *
 * "Play" and "pause" are absent on purpose: those start commands, and a command is not a
 * question about a score.
 */
const SPORTS_WORD =
  /\b(score|scores|scored|scoring|win|wins|winning|won|lose|loses|losing|lost|beat|beats|beating|beaten|game|games|match|matches|playoff|playoffs|postseason|standings|standing|rank|ranked|ranking|rankings|poll|polls|record|kickoff|tip off|tipoff|face|faces|facing|versus|vs|overtime|touchdown|home run|goal|goals|inning|quarter|halftime|shutout|final|season|seed|seeds|undefeated|streak|rivalry|play next|next game|next match|playing|play (the|against|at|on|in|next|tonight|tomorrow|today)|how did|how are)\b/;

/** A command: "play the game", "set a timer for the match" are not questions about sport. */
const COMMAND =
  /^(set|start|stop|turn|switch|open|close|lock|unlock|add|remind|play|pause|resume|skip|make|put|dim|brighten|increase|decrease|raise|lower|record|mute|unmute)\b/;

/** Something in the house. A sentence naming one is about that thing, not about the game. */
const HOUSE_WORD =
  /\b(light|lights|lamp|lamps|thermostat|heating|radiator|boiler|fan|window|windows|door|doors|blind|blinds|curtain|curtains|plug|switch|switches|shower|tap|vacuum|tv|television|speaker|speakers|music|volume|timer|alarm|reminder|reminders|calendar|weather|forecast|traffic|news)\b/;

/** The league, when the sentence names one. Read before the teams, so "NBA" is never a team. */
const LEAGUE_WORDS: { league: string; pattern: RegExp }[] = [
  { league: 'wnba', pattern: /\bwnba\b/ },
  { league: 'nfl', pattern: /\b(nfl|pro football|professional football|american football|super bowl)\b/ },
  { league: 'cfb', pattern: /\b(college football|ncaa football|cfb|ap poll|top 25|heisman|bowl game|college game)\b/ },
  { league: 'nba', pattern: /\b(nba|basketball|nba finals)\b/ },
  { league: 'nhl', pattern: /\b(nhl|hockey|stanley cup)\b/ },
  { league: 'mlb', pattern: /\b(mlb|baseball|world series)\b/ },
  { league: 'epl', pattern: /\b(premier league|epl|english premier)\b/ },
  { league: 'ucl', pattern: /\b(champions league|ucl)\b/ },
  { league: 'laliga', pattern: /\b(la liga|laliga|spanish league)\b/ },
  { league: 'bundesliga', pattern: /\b(bundesliga|german league)\b/ },
  { league: 'seriea', pattern: /\b(serie a|italian league)\b/ },
  { league: 'ligue1', pattern: /\b(ligue 1|ligue1|french league)\b/ },
  { league: 'mls', pattern: /\b(mls|major league soccer)\b/ },
];

/**
 * What kind of sports question this is, in the order the patterns are tried.
 *
 * A roundup comes first because "what games are on" is about the slate rather than one team,
 * and an answer that names a team when none was named reads as a mistake.
 */
const KIND_PATTERNS: { kind: SportsKind; pattern: RegExp }[] = [
  {
    kind: 'roundup',
    pattern:
      /\b(any (games?|matches?)|what games?|which games?|who s playing|whos playing|whose playing|who is playing|games? (today|tonight|on|this)|matches? (today|tonight|on)|what s on|anything on)\b/,
  },
  { kind: 'rankings', pattern: /\b(ranked|ranking|rankings|poll|polls|top 25|number one|no 1|who s number|best team in the country)\b/ },
  {
    kind: 'standings',
    pattern:
      /\b(standings?|table|first place|last place|top of the|bottom of the|playoff (spot|race|picture|chance|chances)|seed|seeds|division (title|race|lead)|conference (title|race|lead)|how are .* doing in the)\b/,
  },
  {
    kind: 'next',
    pattern:
      // "the next game", "the next raptors game", "the next home game": the team may sit in the middle.
      /\b(next (\w+ ){0,3}(game|match|opponent|one)|when (do|does|are|is) .* (play|plays|playing|next)|what time (do|does|is|are|will) .* (play|start|game|match)|who (do|does|are|will) .* play|upcoming|schedule|fixture|fixtures|who s next)\b/,
  },
  { kind: 'score', pattern: /\b(score|scores|win|won|lose|lost|beat|beating|result|results|final|playing|game|match|doing|how did|how d)\b/ },
];

/**
 * Is this a sports question, and which one?
 *
 * Deliberately narrow, and it never decides an answer: it decides whether asking Home Assistant
 * is worth a request. The team name is not matched here — the snapshot is not in hand yet — so
 * a sentence with no resolvable team still gets this far and is then answered `null`, which
 * hands the turn back to the normal path.
 */
export function readSportsQuestion(text: string, houseNames: string[] = []): SportsQuestion | null {
  const raw = text.trim();
  if (!raw) return null;
  // People say "the raptor's" meaning the plural, and normalise turns that apostrophe into a space
  // ("raptor s"), which no team alias matches. Both forms are kept, side by side, so the spaced one
  // still holds "who's next" together and the joined one recovers "raptors".
  const spaced = normalise(raw);
  if (!spaced) return null;
  const joined = normalise(raw.replace(/['’]s\b/gi, 's'));
  const spoken = joined && joined !== spaced ? `${spaced} ${joined}` : spaced;
  if (COMMAND.test(spoken)) return null;
  if (HOUSE_WORD.test(spoken)) return null;
  for (const name of houseNames) {
    const value = normalise(name);
    if (value.length > 2 && spoken.includes(value)) return null;
  }

  const league = LEAGUE_WORDS.find((entry) => entry.pattern.test(spoken))?.league ?? null;
  const named = /\b(the|my|our)\s+[a-z]/.test(spoken) || /\bmy (team|teams|side|club)\b/.test(spoken);
  if (!SPORTS_WORD.test(spoken) && !league) return null;
  // A sentence only reaches the answerer when it asks something: "is there a raptors game tonight"
  // is a question without a "the" in it, and "let us watch a game" is not a question at all.
  if (!league && !named && !ASKING.test(spoken)) return null;

  const kind = KIND_PATTERNS.find((entry) => entry.pattern.test(spoken))?.kind ?? 'score';
  const abbreviations = (raw.match(/\b[A-Z]{2,4}\b/g) ?? []).map((value) => value.toUpperCase());
  return {
    kind,
    league,
    spoken,
    mine: /\bmy (team|teams|side|club)\b/.test(spoken),
    abbreviations,
  };
}

// --- writing the answer -----------------------------------------------------

/** `1` -> `first`, `2` -> `second`, `13` -> `13th`. Read aloud, never a bare digit below ten. */
function ordinal(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  const whole = Math.floor(value);
  if (whole >= 1 && whole <= words.length) return words[whole - 1] ?? null;
  const suffix = whole % 100 >= 11 && whole % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][whole % 10] ?? 'th';
  return `${whole}${suffix}`;
}

/** The wall clock in this house, so a kickoff is said in the listener's own time. */
function whenWords(start: string | null, timezone: string | undefined): string | null {
  if (!start) return null;
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: (timezone ?? '').trim() || undefined,
    }).formatToParts(at);
    const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
    const hour = part('hour');
    const minute = part('minute');
    const period = part('dayPeriod').toUpperCase();
    if (!hour) return null;
    return `on ${part('weekday')} at ${hour}:${minute} ${period}`.trim();
  } catch {
    return null;
  }
}

interface TeamMatch {
  league: SportsLeague;
  /** What the sentence called the team, in the sensors' own casing. */
  alias: string;
  /** The league-scoped abbreviation, when one is known. */
  abbr: string | null;
  favorite: boolean;
  score: number;
}

/** A team the sensors know about, with one of the names the house may use for it. */
interface TeamEntry {
  key: string;
  alias: string;
  abbr: string | null;
  league: SportsLeague;
}

/** A name a team goes by, normalised for matching and kept as written for speaking. */
/**
 * Last words that do not name a team, so a nickname is not invented from them: "Manchester City",
 * "Tampa Bay", "New York City".
 */
const PLACE_WORD = new Set(['city', 'town', 'county', 'state', 'park', 'field', 'bay', 'area']);

function aliasesOf(values: (string | null | undefined)[], abbr: string | null): { key: string; alias: string }[] {
  const out: { key: string; alias: string }[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = normalise(value);
    if (key.length < 3) continue;
    // "Toronto Raptors" is said as "the Raptors", so the nickname is a name of its own. The last
    // word is used rather than the first because that is the part that names the team ("New York
    // Knicks" → "Knicks"), and the place word the other way round ("New York") names two of them.
    const nick = normalise(value.trim().split(/\s+/).at(-1) ?? '');
    const keys = nick && nick !== key && nick.length >= 4 && !PLACE_WORD.has(nick) ? [key, nick] : [key];
    for (const one of keys) {
      if (seen.has(one)) continue;
      seen.add(one);
      out.push({ key: one, alias: one === key ? value : value.trim().split(/\s+/).at(-1)! });
    }
  }
  if (abbr && abbr.length >= 2) {
    const key = normalise(abbr);
    if (!seen.has(key)) out.push({ key, alias: abbr });
  }
  return out;
}

/** Every team the sensors publish, longest name first so "Kansas City" is tried before "City". */
function teamCatalogue(snapshot: SportsSnapshot): TeamEntry[] {
  const entries: TeamEntry[] = [];
  const seen = new Set<string>();
  const push = (league: SportsLeague, alias: { key: string; alias: string }, abbr: string | null): void => {
    const id = `${league.league}|${alias.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ key: alias.key, alias: alias.alias, abbr, league });
  };
  for (const league of snapshot.leagues) {
    for (const event of league.events) {
      for (const team of event.teams) {
        for (const alias of aliasesOf([team.displayName, team.name, team.shortName], team.abbr)) {
          push(league, alias, team.abbr);
        }
      }
    }
    for (const row of league.standings) {
      for (const alias of aliasesOf([row.name, row.shortName, row.abbr], row.abbr)) push(league, alias, row.abbr);
    }
    for (const row of league.rankings) {
      for (const alias of aliasesOf([row.name, row.abbr], row.abbr)) push(league, alias, row.abbr);
    }
    for (const fixture of league.fixtures) {
      for (const alias of aliasesOf([fixture.opponentName, fixture.opponent], fixture.opponent)) {
        push(league, alias, fixture.opponent);
      }
    }
    if (league.favoriteTeamName || league.favoriteTeam) {
      for (const alias of aliasesOf([league.favoriteTeamName, league.favoriteTeam], league.favoriteTeam)) {
        push(league, alias, league.favoriteTeam);
      }
    }
  }
  return entries.sort((a, b) => b.key.length - a.key.length);
}

/** Which team the sentence named, if any. Longest name wins, then the league it was asked about. */
function namedTeam(snapshot: SportsSnapshot, question: SportsQuestion): TeamMatch | null {
  const wanted = question.league;
  let best: TeamMatch | null = null;
  for (const entry of teamCatalogue(snapshot)) {
    if (wanted && entry.league.league !== wanted) continue;
    let hit = entry.abbr !== null && question.abbreviations.includes(entry.abbr.toUpperCase());
    if (!hit && (entry.key.includes(' ') || entry.key.length >= 4)) {
      hit = new RegExp(`\\b${entry.key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(question.spoken);
    }
    if (!hit) continue;
    const favorite = Boolean(
      entry.league.favoriteTeam &&
        (entry.abbr === entry.league.favoriteTeam ||
          normalise(entry.league.favoriteTeamName ?? '') === entry.key ||
          normalise(entry.league.favoriteTeam) === entry.key),
    );
    const score = entry.key.length + (entry.league.league === wanted ? 100 : 0) + (favorite ? 20 : 0);
    if (best && score <= best.score) continue;
    best = { league: entry.league, alias: entry.alias, abbr: entry.abbr, favorite, score };
  }
  return best;
}

/** The favourite team's name in a league, as the house would say it. */
function favoriteOf(league: SportsLeague): { alias: string; abbr: string | null } | null {
  if (!league.favoriteTeam && !league.favoriteTeamName) return null;
  return {
    alias: league.favoriteTeamName ?? league.favoriteTeam ?? '',
    abbr: league.favoriteTeam ?? null,
  };
}

/** The name a person would say for one side of a game. */
function spokenName(team: SportsTeamLine): string {
  // ESPN's short name is what people say: "Bills", not "Buffalo"; "Georgia", not "Georgia Bulldogs"
  // is too short, so the nickname carries it.
  return team.shortName || team.name || team.displayName || team.abbr;
}

function sameTeam(team: SportsTeamLine, match: { alias: string; abbr: string | null }): boolean {
  if (match.abbr && team.abbr && match.abbr.toUpperCase() === team.abbr.toUpperCase()) return true;
  const wanted = normalise(match.alias);
  if (!wanted) return false;
  return [team.name, team.shortName, team.displayName].some((value) => {
    const key = normalise(value ?? '');
    return key.length >= 3 && (key === wanted || key.includes(wanted) || wanted.includes(key));
  });
}

/** The same test, for a standings row rather than a live competitor. */
function sameRow(row: SportsStandingRow, match: { alias: string; abbr: string | null }): boolean {
  if (match.abbr && row.abbr && match.abbr.toUpperCase() === row.abbr.toUpperCase()) return true;
  const wanted = normalise(match.alias);
  if (!wanted) return false;
  return [row.name, row.shortName].some((value) => {
    const key = normalise(value ?? '');
    return key.length >= 3 && (key === wanted || key.includes(wanted) || wanted.includes(key));
  });
}

/** The score, said as a score rather than typed as one. */
function scoreWords(value: number | null): string {
  return value === null ? '' : String(Math.round(value * 100) / 100).replace(/\.0$/, '');
}

/** How far through a live game we are, in the sport's own words. */
function progressWords(event: SportsEvent): string {
  const sport = PERIOD_WORD[event.league] ?? 'quarter';
  const period = event.period;
  if (sport === 'inning') return event.detail ? `, ${event.detail.toLowerCase()}` : '';
  if (sport === 'half') {
    if (period === 2) return ', in the second half';
    if (period === 1) return ', in the first half';
    return '';
  }
  if (!period) return '';
  const run = ordinal(period);
  const left = event.clock ? `${event.clock} left` : 'still going';
  return `, ${left} in the ${run} ${sport}`;
}

/** One game, from the named team's point of view. */
function eventAnswer(event: SportsEvent, match: { alias: string; abbr: string | null }, timezone: string | undefined): string | null {
  if (event.teams.length < 2) return null;
  const mine = event.teams.find((team) => sameTeam(team, match)) ?? null;
  const other = event.teams.find((team) => team !== mine) ?? null;
  if (!mine || !other) {
    // No favourite in this one: say the game, in the order it is played.
    const away = event.teams[0];
    const home = event.teams[1];
    if (!away || !home) return null;
    const line = (team: SportsTeamLine): string =>
      `${spokenName(team)} ${scoreWords(team.score) || '0'}`.trim();
    if (event.state === 'pre') return `${line(away)} at ${line(home)}, ${whenWords(event.start, timezone) ?? 'time to be confirmed'}.`;
    return `${line(away)} at ${line(home)}, ${event.state === 'post' ? 'final' : event.detail ?? 'in progress'}.`;
  }

  const ourScore = mine.score ?? 0;
  const theirScore = other.score ?? 0;
  const opponent = spokenName(other);
  // "the Bills" reads better than "Bills" in a sentence like "against the Bills".
  const against = theOpponent(opponent);

  if (event.state === 'in') {
    const verb = ourScore === theirScore ? 'are tied' : ourScore > theirScore ? 'are winning' : 'are losing';
    return `${match.alias} ${verb} ${scoreWords(ourScore)} to ${scoreWords(theirScore)} against ${against}${progressWords(event)}.`;
  }
  if (event.state === 'post') {
    if (ourScore === theirScore) return `${match.alias} drew ${scoreWords(ourScore)} to ${scoreWords(theirScore)} with ${against}.`;
    const won = mine.winner || ourScore > theirScore;
    return won
      ? `${match.alias} beat ${against} ${scoreWords(ourScore)} to ${scoreWords(theirScore)}.`
      : `${match.alias} lost to ${against} ${scoreWords(theirScore)} to ${scoreWords(ourScore)}.`;
  }
  const when = whenWords(event.start, timezone);
  return `${match.alias} play ${against}${when ? ` ${when}` : ''}.`;
}

/** Live games across the house's leagues, for "what games are on". */
function roundupAnswer(snapshot: SportsSnapshot, timezone: string | undefined): SportsAnswer | null {
  const parts: string[] = [];
  const live: string[] = [];
  const upcoming: string[] = [];
  for (const league of snapshot.leagues) {
    for (const event of league.events) {
      const away = event.teams[0];
      const home = event.teams[1];
      if (!away || !home) continue;
      if (event.state === 'in') {
        live.push(
          `${spokenName(away)} ${scoreWords(away.score) || '0'}, ${spokenName(home)} ${scoreWords(home.score) || '0'}`,
        );
      } else if (event.state === 'pre') {
        const when = whenWords(event.start, timezone);
        upcoming.push(`${spokenName(away)} at ${spokenName(home)}${when ? ` ${when}` : ''}`);
      }
    }
  }
  if (live.length) {
    parts.push(`On now: ${live.slice(0, 3).join('; ')}.`);
  }
  if (upcoming.length) {
    parts.push(`Coming up: ${upcoming.slice(0, 3).join('; ')}.`);
  }
  if (!parts.length) return null;
  return { text: parts.join(' '), about: 'the games on now' };
}

/** A standings line for one team, or the leader when no team was named. */
function standingsAnswer(league: SportsLeague, match: { alias: string; abbr: string | null } | null, asked: boolean): SportsAnswer | null {
  const rows = league.standings;
  if (!rows.length) return null;
  const row = match
    ? rows.find((entry) => sameRow(entry, match))
    : asked
      ? rows.find((entry) => entry.position === 1) ?? rows[0]
      : null;
  if (!row) return null;
  const name = match?.alias ?? row.name ?? row.abbr ?? 'They';
  const place = ordinal(row.position);
  const group = row.group && normalise(row.group) !== normalise(league.label.replace(/^the /, '')) ? ` in ${row.group}` : '';
  const record =
    row.wins !== null && row.losses !== null
      ? `a ${row.wins} and ${row.losses}${row.ties ? ` and ${row.ties}` : ''} record`
      : null;
  const details: string[] = [];
  if (record) details.push(`with ${record}`);
  if (row.points !== null && record === null) details.push(`with ${row.points} points`);
  if (!place && !record && row.points === null) return null;
  const head = place ? `${name} are ${place}${group}` : `${name} are${group}`;
  const tail = details.length ? ` ${details.join(', ')}` : '';
  return { text: `${head}${tail}.`, about: `${league.label} standings` };
}

/** A rankings line for one team, or whoever is number one. */
function rankingsAnswer(league: SportsLeague, match: { alias: string; abbr: string | null } | null): SportsAnswer | null {
  if (!league.rankings.length) return null;
  const row = match
    ? league.rankings.find(
        (entry) =>
          (match.abbr && entry.abbr && entry.abbr.toUpperCase() === match.abbr.toUpperCase()) ||
          (entry.name ? normalise(entry.name) === normalise(match.alias) : false) ||
          (entry.name ? normalise(entry.name).includes(normalise(match.alias)) : false),
      )
    : league.rankings.find((entry) => entry.rank === 1) ?? league.rankings[0];
  if (!row) return null;
  const poll = league.poll ?? 'the poll';
  const place = ordinal(row.rank);
  const name = row.name ?? match?.alias ?? 'They';
  const record = row.record ? ` with a ${row.record} record` : '';
  if (place === 'first') return { text: `${name} ${row.record ? 'are' : 'is'} number one in ${poll}${record}.`, about: `college football rankings` };
  return { text: `${name} ${row.record ? 'are' : 'is'} ${place} in ${poll}${record}.`, about: 'college football rankings' };
}

/** The other side of a game, said with its article: "the Celtics". */
function theOpponent(value: string): string {
  return /^(the|a|an)\b/i.test(value) ? value : `the ${value}`;
}

/**
 * Are these fixtures the named team's?
 *
 * The `next_game` sensor follows one team per league — whichever sports-ticker was told is the
 * favourite — so its schedule belongs to that team alone. A question about the Knicks in a league
 * favourited to the Raptors has to go unanswered rather than be answered with somebody else's game.
 */
function followsTeam(league: SportsLeague, match: { alias: string; abbr: string | null } | null): boolean {
  if (!match) return true;
  const favourite = league.favoriteTeam?.toUpperCase() ?? null;
  if (favourite && match.abbr && favourite === match.abbr.toUpperCase()) return true;
  const name = league.favoriteTeamName ? normalise(league.favoriteTeamName) : '';
  if (!name) return false;
  const wanted = normalise(match.alias);
  return Boolean(wanted) && (name === wanted || name.includes(wanted) || wanted.includes(name));
}

/** The game the sentence asked about, when it named an opponent: "when do the Raptors play the Celtics". */
function askedOpponent(fixtures: SportsFixture[], spoken: string): SportsFixture | null {
  if (!spoken) return null;
  for (const fixture of fixtures) {
    // The nickname counts: "the raptors play the knicks" names "New York Knicks", not "Knicks".
    const nickname = normalise((fixture.opponentName ?? fixture.opponent ?? '').trim().split(/\s+/).at(-1) ?? '');
    for (const value of [fixture.opponentName, fixture.opponent, nickname]) {
      if (!value) continue;
      const key = normalise(value);
      if (key.length < 3) continue;
      if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(spoken)) return fixture;
    }
  }
  return null;
}

/**
 * The next game the integration publishes for the favourite team.
 *
 * Which team was asked about decides whether this answers at all, and which of the upcoming games it
 * reads: the opponent the sentence named when it named one, otherwise the soonest.
 */
function fixtureAnswer(
  league: SportsLeague,
  target: { alias: string; abbr: string | null } | null,
  timezone: string | undefined,
  spoken: string,
): SportsAnswer | null {
  if (!league.fixtures.length || !followsTeam(league, target)) return null;
  const fixture = askedOpponent(league.fixtures, spoken) ?? league.fixtures[0] ?? null;
  if (!fixture) return null;
  const name = target?.alias ?? league.favoriteTeamName ?? favoriteOf(league)?.alias ?? null;
  if (!name) return null;
  const opponent = fixture.opponentName ?? fixture.opponent ?? null;
  const when = whenWords(fixture.start, timezone);
  // A home game is played in their own building, so naming it adds nothing; an away one is news.
  const where = fixture.venue && fixture.homeAway !== 'home' ? ` at ${fixture.venue}` : '';
  const verb =
    opponent === null
      ? 'are next up'
      : fixture.homeAway === 'home'
        ? `host ${theOpponent(opponent)}`
        : fixture.homeAway === 'away'
          ? `visit ${theOpponent(opponent)}`
          : `play ${theOpponent(opponent)}`;
  return {
    text: `${name} ${verb}${when ? ` ${when}` : ''}${where}.`,
    about: `${league.label} schedule`,
  };
}

/**
 * The answer to a sports question, from the sensors the house already has.
 *
 * Returns `null` when nothing in the snapshot answers it — no matching team, no standings for
 * that league, a question about a sport the integration does not follow — and the caller then
 * forwards the turn as if this module did not exist.
 */
export function sportsAnswer(
  snapshot: SportsSnapshot,
  question: SportsQuestion,
  options: { timezone?: string } = {},
): SportsAnswer | null {
  const leagues = question.league
    ? snapshot.leagues.filter((league) => league.league === question.league)
    : snapshot.leagues;
  const pool = leagues.length ? leagues : snapshot.leagues;
  const match = namedTeam(snapshot, question);
  const league = match?.league ?? pool[0] ?? null;

  if (!match && !question.league && question.kind === 'roundup') {
    return roundupAnswer(snapshot, options.timezone);
  }

  // "What's the score?" with no team and no league is a question about the slate, so a roundup is
  // the honest answer. "How are the Canucks doing?" is not: nothing in the house carries hockey, and
  // a list of NFL scores read out instead would be a wrong answer rather than a missing one, so that
  // sentence is left to the model.
  if (!match && !question.league && question.kind === 'score') {
    const aboutTheSlate =
      /\b(games?|matches?|scores?|results?|slate)\b/.test(question.spoken) &&
      !/\bhow (are|is|did|s|was|were|about)\b/.test(question.spoken);
    return aboutTheSlate ? roundupAnswer(snapshot, options.timezone) : null;
  }

  // "my team" with nothing named: the favourite, when the integration knows one.
  const target =
    match ??
    (question.mine && league
      ? (() => {
          const favorite = favoriteOf(league);
          return favorite ? { league, alias: favorite.alias, abbr: favorite.abbr } : null;
        })()
      : null);

  if (question.kind === 'rankings') {
    const board = pool.find((entry) => entry.rankings.length) ?? league;
    return board ? rankingsAnswer(board, target) : null;
  }

  if (question.kind === 'standings') {
    const boards = pool.filter((entry) => entry.standings.length);
    const board = target ? boards.find((entry) => entry === target.league) ?? boards[0] : boards[0];
    return board ? standingsAnswer(board, target, true) : null;
  }

  if (question.kind === 'next') {
    const boards = target ? [target.league] : pool;
    const mine = target;
    // "When are they playing?" during a game is a question about the game on now; "when do they play
    // next" is not, so only a sentence that says next, upcoming or schedule jumps the live game.
    const theOneAfterThis = /\b(next|upcoming|schedule|fixtures?)\b/.test(question.spoken);
    for (const board of boards) {
      const live = mine
        ? board.events.find((event) => event.state === 'in' && event.teams.some((team) => sameTeam(team, mine)))
        : undefined;
      if (live && mine && !theOneAfterThis) {
        const text = eventAnswer(live, mine, options.timezone);
        if (text) return { text, about: `${board.label} game` };
      }
      const answer = fixtureAnswer(board, mine, options.timezone, question.spoken);
      if (answer) return answer;
      if (live && mine) {
        const text = eventAnswer(live, mine, options.timezone);
        if (text) return { text, about: `${board.label} game` };
      }
    }
    // No schedule sensor: fall back to a game that has not started yet.
    for (const board of boards) {
      const upcoming = board.events.find(
        (event) => event.state === 'pre' && (!mine || event.teams.some((team) => sameTeam(team, mine))),
      );
      if (upcoming && mine) {
        const text = eventAnswer(upcoming, mine, options.timezone);
        if (text) return { text, about: `${board.label} schedule` };
      }
    }
    return null;
  }

  if (question.kind === 'roundup') {
    if (!target) return roundupAnswer(snapshot, options.timezone);
  }

  // A score: the named team's game, in the order live, then final, then upcoming.
  const owner = target ?? (question.mine ? null : (league ? favoriteOf(league) : null)) ?? null;
  if (!owner) return roundupAnswer(snapshot, options.timezone);
  const boards = target ? [target.league] : pool;
  const order: SportsEvent['state'][] = ['in', 'post', 'pre'];
  for (const state of order) {
    for (const board of boards) {
      const event = board.events.find(
        (entry) => entry.state === state && entry.teams.some((team) => sameTeam(team, owner)),
      );
      if (!event) continue;
      const text = eventAnswer(event, owner, options.timezone);
      if (text) return { text, about: `${owner.alias} score` };
    }
  }
  // Nothing on the scoreboard for them: if the sentence asks about a game rather than a result,
  // the schedule the integration publishes is the answer — "is there a raptors game tonight".
  if (/\b(game|games|match|matches|tonight|today|tomorrow|playing|play|next|upcoming)\b/.test(question.spoken)) {
    for (const board of boards) {
      const answer = fixtureAnswer(board, owner, options.timezone, question.spoken);
      if (answer) return answer;
    }
  }
  // Nothing on the scoreboard for that team: the table still knows its record.
  for (const board of boards) {
    const answer = standingsAnswer(board, owner, false);
    if (answer) return answer;
  }
  return null;
}
