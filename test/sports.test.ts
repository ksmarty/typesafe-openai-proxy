/**
 * The sports, read from the sensors the house already has.
 *
 * Three things are pinned here and nothing else: what the reader understands of the
 * sports-ticker attributes (a live game, a final, a table, a poll, a fixture), which sentences
 * count as a sports question at all — "play the game" has to stay a media command and "what is
 * the score on the kitchen tv" has to stay a house question — and the wiring, through a stub
 * Home Assistant that serves one `GET /api/states` the way the real one does.
 *
 * The stub matters: the reader talks to Home Assistant's state machine rather than to the
 * integration, so the fixture is exactly the attribute shape the sensors publish.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { defaultConfig, type Config } from '../src/config.js';
import type { OpenAITool } from '../src/types.js';
import { clearCatalogCache } from '../src/catalog.js';
import { runPipeline } from '../src/pipeline.js';
import {
  clearSportsCache,
  readSportsQuestion,
  sportsAnswer,
  sportsFor,
  sportsFromStates,
  type SportsQuestion,
} from '../src/sports.js';

/** One competitor, in ESPN's own field names, which is what the integration republishes. */
function competitor(team: {
  abbr: string;
  name: string;
  short: string;
  score?: string;
  winner?: boolean;
  homeAway: 'home' | 'away';
}): Record<string, unknown> {
  return {
    homeAway: team.homeAway,
    winner: team.winner ?? false,
    score: team.score ?? '0',
    records: [{ summary: '10-4' }],
    team: {
      abbreviation: team.abbr,
      displayName: `${team.name} ${team.short}`,
      shortDisplayName: team.short,
      name: team.name,
    },
  };
}

/** One event, shaped like `sensor.espn_nfl_scoreboard_raw`'s `events[0]`. */
function event(options: {
  name: string;
  start: string;
  state: 'pre' | 'in' | 'post';
  detail: string;
  clock?: string;
  period?: number;
  home: { abbr: string; name: string; short: string; score?: string; winner?: boolean };
  away: { abbr: string; name: string; short: string; score?: string; winner?: boolean };
}): Record<string, unknown> {
  return {
    id: '401547417',
    name: options.name,
    shortName: options.name,
    date: options.start,
    competitions: [
      {
        date: options.start,
        status: {
          displayClock: options.clock ?? '0:00',
          period: options.period ?? 4,
          type: { state: options.state, completed: options.state === 'post', shortDetail: options.detail },
        },
        competitors: [
          competitor({ ...options.away, homeAway: 'away' }),
          competitor({ ...options.home, homeAway: 'home' }),
        ],
      },
    ],
  };
}

const LIVE = event({
  name: 'Buffalo Bills at Kansas City Chiefs',
  start: '2026-11-16T01:20:00Z',
  state: 'in',
  detail: '6:32 - 3rd',
  clock: '6:32',
  period: 3,
  away: { abbr: 'BUF', name: 'Buffalo', short: 'Bills', score: '24' },
  home: { abbr: 'KC', name: 'Kansas City', short: 'Chiefs', score: '21' },
});

const FINAL = event({
  name: 'Miami Dolphins at Buffalo Bills',
  start: '2026-11-09T18:00:00Z',
  state: 'post',
  detail: 'Final',
  away: { abbr: 'MIA', name: 'Miami', short: 'Dolphins', score: '17' },
  home: { abbr: 'BUF', name: 'Buffalo', short: 'Bills', score: '31', winner: true },
});

/** The whole state machine, as Home Assistant replies to `GET /api/states`. */
function states(): Record<string, unknown>[] {
  return [
    {
      entity_id: 'sensor.espn_nfl_scoreboard_raw',
      state: '2 games',
      attributes: {
        league: 'nfl',
        league_name: 'NFL',
        favorite_team: 'BUF',
        favorite_team_name: 'Buffalo Bills',
        stale: false,
        events: [LIVE, FINAL],
      },
    },
    {
      entity_id: 'sensor.espn_nfl_next_game',
      state: 'Mon 8:15 PM',
      attributes: {
        has_upcoming_game: true,
        favorite_team: 'BUF',
        favorite_team_name: 'Buffalo Bills',
        date: '2026-11-23T01:15:00Z',
        matchup: 'BUF @ NE',
        opponent: 'NE',
        opponent_name: 'New England Patriots',
        venue: 'Gillette Stadium',
        home_away: 'away',
        status_detail: 'Mon 8:15 PM',
      },
    },
    {
      entity_id: 'sensor.espn_nba_standings_raw',
      state: '15 teams',
      attributes: {
        league: 'nba',
        profile: 'nba',
        favorite_team: null,
        teams: [
          {
            position: 1,
            abbreviation: 'BOS',
            display_name: 'Boston Celtics',
            short_name: 'Celtics',
            conference: 'East',
            wins: 14,
            losses: 3,
            record: '14-3',
          },
          {
            position: 2,
            abbreviation: 'NYK',
            display_name: 'New York Knicks',
            short_name: 'Knicks',
            conference: 'East',
            wins: 12,
            losses: 6,
            record: '12-6',
          },
        ],
      },
    },
    {
      entity_id: 'sensor.espn_college_football_rankings',
      state: '25 teams',
      attributes: {
        primary_poll: 'ap_top_25',
        ap_top_25: [
          { rank: 1, abbreviation: 'UGA', display_name: 'Georgia Bulldogs', record: '10-1' },
          { rank: 2, abbreviation: 'OSU', display_name: 'Ohio State Buckeyes', record: '10-1' },
        ],
      },
    },
    // Not sports: the reader must ignore everything that is not a sports-ticker sensor.
    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
  ];
}

function settings(overrides: Partial<Config['sports']> = {}): Config['sports'] {
  return { ...defaultConfig().sports, ...overrides };
}

/** Ask the reader the way the pipeline does, and answer from the same snapshot. */
function ask(sentence: string, config = settings()): { question: SportsQuestion; text: string } | null {
  const question = readSportsQuestion(sentence);
  const snapshot = sportsFromStates(states(), config);
  if (!question || !snapshot) return null;
  const answer = sportsAnswer(snapshot, question, { timezone: 'America/New_York' });
  return answer ? { question, text: answer.text } : null;
}

test('a live game is read from the scoreboard attributes, and said from the named side', () => {
  const answer = ask('what is the score of the Bills game');
  assert.ok(answer);
  assert.equal(answer.question.kind, 'score');
  assert.match(answer.text, /^Bills are winning 24 to 21 against the Chiefs/);
  assert.match(answer.text, /6:32 left in the third quarter/);
  // Spoken scores, never typed ones: a hyphen is read as minus by some voices.
  assert.ok(!answer.text.includes('24-21'));
});

test('a finished game is said as a win or a loss, not as a scoreline', () => {
  const answer = ask('how did the Dolphins do');
  assert.ok(answer);
  assert.match(answer.text, /^Dolphins lost to the Bills 31 to 17\.$/);
});

test('the table, the poll and the next fixture all answer without a model', () => {
  const standings = ask('where do the Knicks sit in the NBA standings');
  assert.ok(standings);
  assert.match(standings.text, /Knicks/);
  assert.match(standings.text, /second/);
  assert.match(standings.text, /12 and 6/);

  const rankings = ask('who is number one in college football');
  assert.ok(rankings);
  assert.match(rankings.text, /Georgia Bulldogs/);
  assert.match(rankings.text, /number one in AP poll/);

  const next = ask('when do the Bills play next');
  assert.ok(next);
  assert.equal(next.question.kind, 'next');
  assert.match(next.text, /New England Patriots/);
});

test('a roundup names the games on the slate, not one team', () => {
  const answer = ask('what games are on in the NFL');
  assert.ok(answer);
  assert.equal(answer.question.kind, 'roundup');
  assert.match(answer.text, /Bills/);
  assert.match(answer.text, /Chiefs/);
});

test('the spoiler delay is respected by default and can be ignored', () => {
  // An earlier scoreboard: the raw sensor still says 14, the delayed one has caught up to 24.
  const behind = event({
    name: 'Buffalo Bills at Kansas City Chiefs',
    start: '2026-11-16T01:20:00Z',
    state: 'in',
    detail: '6:32 - 3rd',
    clock: '6:32',
    period: 3,
    away: { abbr: 'BUF', name: 'Buffalo', short: 'Bills', score: '14' },
    home: { abbr: 'KC', name: 'Kansas City', short: 'Chiefs', score: '21' },
  });
  const withDelayed = states()
    .map((state) =>
      state.entity_id === 'sensor.espn_nfl_scoreboard_raw'
        ? {
            ...state,
            attributes: { ...(state.attributes as Record<string, unknown>), events: [behind] },
          }
        : state,
    )
    .concat({
    entity_id: 'sensor.espn_nfl_scoreboard_delayed',
    state: '1 games',
    attributes: { spoiler_delay_seconds: 90, events: [LIVE] },
  });

  const respecting = sportsFromStates(withDelayed, settings());
  const nfl = respecting?.leagues.find((league) => league.league === 'nfl');
  assert.ok(nfl);
  assert.equal(nfl.delayed, true);
  // The delayed scoreboard is the only one this reader may speak from.
  const score = nfl.events.find((entry) => entry.state === 'in');
  assert.equal(score?.teams.find((team) => team.abbr === 'BUF')?.score, 24);

  const ignoring = sportsFromStates(withDelayed, settings({ spoilerDelay: 'ignore' }));
  const raw = ignoring?.leagues.find((league) => league.league === 'nfl');
  // Ignoring the delay means the flag is off: the raw board is what was read.
  assert.equal(raw?.delayed, false);
  assert.equal(raw?.events.find((entry) => entry.state === 'in')?.teams.find((team) => team.abbr === 'BUF')?.score, 14);
});

test('the reader only understands sports questions', () => {
  // A media command stays a media command: "play" is never a sports word on its own.
  assert.equal(readSportsQuestion('play the game'), null);
  assert.equal(readSportsQuestion('play some music'), null);
  // A house question stays a house question.
  assert.equal(readSportsQuestion('what is the score on the kitchen tv'), null);
  assert.equal(readSportsQuestion('turn on the lights'), null);
  assert.equal(readSportsQuestion('remind me to watch the game at eight'), null);
  // A named entity from the catalogue wins over any sports reading.
  assert.equal(readSportsQuestion('what is the score of the bills game', ['bills game']), null);
  // ... and a real question is read.
  assert.equal(readSportsQuestion('what is the score of the Bills game')?.kind, 'score');
  assert.equal(readSportsQuestion("what's the NFL score")?.league, 'nfl');
});

test('a league or team the sensors do not carry answers nothing, so the turn is forwarded', () => {
  const snapshot = sportsFromStates(states(), settings());
  assert.ok(snapshot);
  const question = readSportsQuestion('how are the Vancouver Canucks doing');
  assert.ok(question);
  assert.equal(sportsAnswer(snapshot, question), null);
});

test('unreadable or unrelated states answer nothing rather than throwing', () => {
  assert.equal(sportsFromStates(null, settings()), null);
  assert.equal(sportsFromStates({ states: [] }, settings()), null);
  assert.equal(sportsFromStates([{ entity_id: 'light.kitchen', state: 'on' }], settings()), null);
});

test('one league filter narrows what is read', () => {
  const only = sportsFromStates(states(), settings({ leagues: 'nba' }));
  assert.ok(only);
  assert.deepEqual(
    only.leagues.map((league) => league.league),
    ['nba'],
  );
});

// --- the schedule: "when do they play next" ----------------------------------

/** The favourite's schedule, in the flat rows `sensor.espn_nba_next_game` publishes. */
const NBA_SCHEDULE = {
  entity_id: 'sensor.espn_nba_next_game',
  state: 'Fri 7:30 PM',
  attributes: {
    league: 'nba',
    has_upcoming_game: true,
    favorite_team: 'TOR',
    favorite_team_name: 'Toronto Raptors',
    date: '2026-11-21T00:30:00Z',
    matchup: 'TOR @ BOS',
    opponent: 'BOS',
    opponent_name: 'Boston Celtics',
    venue: 'TD Garden',
    home_away: 'away',
    status_detail: 'Fri 7:30 PM',
    upcoming_games: [
      {
        event_id: '401810100',
        date: '2026-11-21T00:30:00Z',
        home_away: 'away',
        matchup: 'TOR @ BOS',
        opponent: 'BOS',
        opponent_name: 'Boston Celtics',
        venue: 'TD Garden',
        status: 'pre',
        status_detail: 'Fri 7:30 PM',
      },
      {
        event_id: '401810112',
        date: '2026-11-22T01:00:00Z',
        home_away: 'home',
        matchup: 'NYK vs TOR',
        opponent: 'NYK',
        opponent_name: 'New York Knicks',
        venue: 'Scotiabank Arena',
        status: 'pre',
        status_detail: 'Sat 8:00 PM',
      },
    ],
  },
};

/** A Raptors game on the scoreboard that has not started, for a house with no schedule sensor. */
const NBA_PRE = event({
  name: 'Toronto Raptors at Boston Celtics',
  start: '2026-11-21T00:30:00Z',
  state: 'pre',
  detail: 'Fri 7:30 PM',
  away: { abbr: 'TOR', name: 'Toronto', short: 'Raptors' },
  home: { abbr: 'BOS', name: 'Boston', short: 'Celtics' },
});

/** The Raptors game in progress, which "when are they playing" means while it is on. */
const NBA_LIVE = event({
  name: 'New York Knicks at Toronto Raptors',
  start: '2026-11-19T00:30:00Z',
  state: 'in',
  detail: '4:10 - 4th',
  clock: '4:10',
  period: 4,
  away: { abbr: 'NYK', name: 'New York', short: 'Knicks', score: '98' },
  home: { abbr: 'TOR', name: 'Toronto', short: 'Raptors', score: '104' },
});

/** The same house, with the Raptors followed and, unless asked not to, a schedule published. */
function scheduleStates(options: { schedule?: boolean; scoreboard?: Record<string, unknown>[] } = {}): Record<string, unknown>[] {
  const out = [...states()];
  if (options.schedule !== false) out.push(NBA_SCHEDULE);
  if (options.scoreboard) {
    out.push({
      entity_id: 'sensor.espn_nba_scoreboard_raw',
      state: `${options.scoreboard.length} games`,
      attributes: { league: 'nba', favorite_team: 'TOR', favorite_team_name: 'Toronto Raptors', events: options.scoreboard },
    });
  }
  return out;
}

function scheduleAsk(
  sentence: string,
  options: { schedule?: boolean; scoreboard?: Record<string, unknown>[] } = {},
): { question: SportsQuestion; text: string } | null {
  const question = readSportsQuestion(sentence);
  const snapshot = sportsFromStates(scheduleStates(options), settings());
  if (!question || !snapshot) return null;
  const answer = sportsAnswer(snapshot, question, { timezone: 'America/New_York' });
  return answer ? { question, text: answer.text } : null;
}

test('the schedule sensor answers when the next game is', () => {
  for (const sentence of [
    "when's the next raptors game",
    'when are the raptors playing',
    'when do the raptors play next',
    'what time do the raptors play on friday',
    'is there a raptors game tonight',
  ]) {
    const answer = scheduleAsk(sentence);
    assert.ok(answer, sentence);
    // "is there a raptors game tonight" reads as a slate question, but a named team makes the
    // branch irrelevant: the answer is that team's fixture either way.
    assert.ok(['next', 'roundup'].includes(answer.question.kind), `${sentence} → ${answer.question.kind}`);
    assert.equal(answer.text, 'Raptors visit the Boston Celtics on Friday at 7:30 PM at TD Garden.', sentence);
  }
  // A sentence that only mentions a game is not a question about one.
  assert.equal(readSportsQuestion('lets watch a game tonight'), null);
});

test("a possessive plural is still the team's name", () => {
  const answer = scheduleAsk("when are the raptor's playing?");
  assert.ok(answer);
  assert.match(answer.text, /^Raptors visit the Boston Celtics/);
});

test('a home game names no venue, and the opponent asked about picks the game', () => {
  const answer = scheduleAsk('when do the raptors play the knicks');
  assert.ok(answer);
  assert.equal(answer.text, 'Raptors host the New York Knicks on Saturday at 8:00 PM.');
});

test("another team never gets the favourite's schedule", () => {
  // The Knicks are in the standings, so they are named — but the schedule sensor follows the Raptors.
  assert.equal(scheduleAsk('when do the knicks play next'), null);
  // No schedule sensor: a game on the scoreboard that has not started is still an answer.
  const board = scheduleAsk('when do the raptors play next', { schedule: false, scoreboard: [NBA_PRE] });
  assert.ok(board);
  assert.match(board.text, /^Raptors play the Celtics/);
  assert.match(board.text, /Friday at 7:30 PM/);
});

test('a game on now answers "when are they playing", and next still means next', () => {
  const now = scheduleAsk('when are the raptors playing', { scoreboard: [NBA_LIVE] });
  assert.ok(now);
  assert.match(now.text, /^Raptors are winning 104 to 98 against the Knicks/);
  const next = scheduleAsk("when's the next raptors game", { scoreboard: [NBA_LIVE] });
  assert.ok(next);
  assert.match(next.text, /^Raptors visit the Boston Celtics/);
});

// --- through the pipeline, against a stub Home Assistant ---------------------

let server: Server | null = null;
let base = '';

before(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/states')) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(states()));
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  clearSportsCache();
  clearCatalogCache();
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = null;
});

const TOOLS: OpenAITool[] = ['HassTurnOn', 'HassGetCurrentTime'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } },
}));

function pipelineConfig(): Config {
  const config = defaultConfig();
  config.catalog.haUrl = base;
  config.catalog.haToken = 'test-token';
  config.catalog.exposedOnly = false;
  config.sports = settings();
  return config;
}

test('a sports question is answered in the pipeline, with no model call', async () => {
  clearSportsCache();
  clearCatalogCache();
  const text = 'what is the score of the Bills game';
  const result = await runPipeline(
    { model: 'typesafe-router', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    '',
    pipelineConfig(),
  );
  assert.ok(result.route.plan);
  const plan = result.route.plan;
  assert.equal(plan.kind, 'text');
  assert.match(plan.text ?? '', /Bills are winning 24 to 21/);
  assert.equal(result.entry?.backend, 'off');
  assert.match(result.entry?.reason ?? '', /sports-ticker/);
  assert.equal(result.entry?.utterance, 'what is the score of the Bills game');
});

test('with sports off, the same sentence is forwarded', async () => {
  clearSportsCache();
  clearCatalogCache();
  const config = pipelineConfig();
  config.sports.enabled = false;
  const text = 'what is the score of the Bills game';
  const result = await runPipeline(
    { model: 'typesafe-router', messages: [{ role: 'user', content: text }], tools: TOOLS },
    text,
    '',
    config,
  );
  // Nothing local answered, so the turn goes upstream exactly as it would without this module.
  assert.equal(result.route.plan.kind, 'forward');
});

test('a Home Assistant that refuses the read forwards the turn rather than failing it', async () => {
  clearSportsCache();
  clearCatalogCache();
  const config = pipelineConfig();
  config.catalog.haToken = 'wrong-token';
  const snapshot = await sportsFor(config);
  assert.equal(snapshot, null);
});
