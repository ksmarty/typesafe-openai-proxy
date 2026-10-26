/**
 * System One client: the typed decision model that replaces the LLM turn.
 *
 * One POST per utterance carries the whole state (utterance + home catalog) and the
 * full question set, and comes back with one typed answer per question. This module
 * owns the wire format, the retry policy and the circuit breaker - nothing else in
 * the proxy talks to the model.
 */

import type { Config } from './config.js';
import type {
  Answer,
  Catalog,
  ChoiceAnswer,
  DecisionResponse,
  DecisionState,
  NoulAnswer,
  QuestionSet,
  ScoreAnswer,
} from './types.js';
import { fetchWithTimeout, round, sleep } from './util.js';

export const SYSTEM_ONE_PATH = '/v1/systemone';
export const MODELS_PATH = '/v1/models';
export const MODELS_CAPABILITY = 'jev';

/**
 * Turn whatever was pasted into the base the contract expects.
 *
 * The wire contract is `{base}/v1/systemone`, so all of these are the same server:
 *   https://openrouter.ai/api
 *   https://openrouter.ai/api/
 *   https://openrouter.ai/api/v1
 *   https://openrouter.ai/api/v1/systemone
 * People paste the endpoint they were given and get a 404 on
 * `/systemone/v1/systemone` otherwise, so the path is stripped here rather than
 * in every caller.
 */
export function decisionBase(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed
    .replace(/\/v1\/systemone$/i, '')
    .replace(/\/systemone$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '');
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [250, 750, 2000];
/** Consecutive failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

const breaker = { failures: 0, openedAt: 0 };

export class DecisionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionUnavailable';
  }
}

export interface DecideInput {
  utterance: string;
  catalog: Catalog;
  questions: QuestionSet;
  spokenFromAreaName?: string;
  language?: string;
  config: Config;
  conversation?: DecisionState['conversation'];
}

/** Build the `state` object the model reads. */
export function buildState(input: DecideInput): DecisionState {
  const { catalog, config } = input;
  const maxEntities = Math.max(1, config.decision.maxEntities);
  const entities = catalog.entities.slice(0, maxEntities);

  const state: DecisionState = {
    request: {
      text: input.utterance,
    },
    home: {
      areas: [],
      entities: [],
    },
  };

  if (input.language) state.request.language = input.language;
  state.request.now = new Date().toISOString();

  const spoken = input.spokenFromAreaName ?? config.catalog.defaultArea;
  if (spoken) {
    const area = catalog.areas.find((candidate) => candidate.name.toLowerCase() === spoken.toLowerCase());
    state.request.spoken_from_area = area ? { id: area.id, name: area.name } : { id: spoken, name: spoken };
  }

  const areaIdsInUse = new Set(entities.map((entity) => entity.areaId).filter(Boolean) as string[]);
  state.home.areas = catalog.areas
    .filter((area) => areaIdsInUse.has(area.id))
    .map((area) => ({ id: area.id, name: area.name, ...(area.floor ? { floor: area.floor } : {}) }));

  state.home.entities = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    domain: entity.domain,
    state: entity.state,
    ...(entity.areaName ? { area: entity.areaName } : {}),
    ...(entity.floor ? { floor: entity.floor } : {}),
    ...(entity.deviceClass ? { device_class: entity.deviceClass } : {}),
  }));

  const historyLimit = Math.max(0, config.decision.historyTurns) * 2;
  if (input.conversation && historyLimit > 0) {
    state.conversation = input.conversation.slice(-historyLimit);
  }

  return state;
}

function normaliseAnswer(raw: unknown): Answer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;

  if (typeof value.noul === 'number') {
    return { type: 'noul', noul: value.noul } satisfies NoulAnswer;
  }

  const probabilities =
    value.probabilities && typeof value.probabilities === 'object'
      ? Object.fromEntries(
          Object.entries(value.probabilities as Record<string, unknown>)
            .filter(([, prob]) => typeof prob === 'number')
            .map(([key, prob]) => [key, prob as number]),
        )
      : {};

  if (typeof value.choice === 'string') {
    const confidence =
      typeof value.confidence === 'number'
        ? value.confidence
        : (probabilities[value.choice] ?? 1);
    return { type: 'choice', choice: value.choice, probabilities, confidence } satisfies ChoiceAnswer;
  }

  if (typeof value.score === 'number') {
    const legend =
      value.legend && typeof value.legend === 'object'
        ? Object.fromEntries(
            Object.entries(value.legend as Record<string, unknown>).filter(
              ([, text]) => typeof text === 'string',
            ) as [string, string][],
          )
        : {};
    return {
      type: 'score',
      score: value.score,
      legend,
      probabilities,
      confidence: typeof value.confidence === 'number' ? value.confidence : 0.5,
    } satisfies ScoreAnswer;
  }

  return undefined;
}

/** `POST /v1/systemone` and normalise whatever comes back. */
export async function decide(input: DecideInput): Promise<DecisionResponse> {
  const { config } = input;
  const started = Date.now();
  const baseUrl = decisionBase(config.decision.baseUrl);
  if (!baseUrl) throw new DecisionUnavailable('no decision base URL configured');

  if (breaker.failures >= BREAKER_THRESHOLD && Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS) {
    throw new DecisionUnavailable('decision model circuit breaker is open');
  }

  const body = {
    model: config.decision.model,
    state: buildState(input),
    questions: input.questions,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}${SYSTEM_ONE_PATH}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.decision.apiKey ? { authorization: `Bearer ${config.decision.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        },
        config.decision.timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const detail = `${baseUrl}${SYSTEM_ONE_PATH} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
        // 4xx other than 408/429 will not get better by retrying - but a server
        // that keeps answering 404 is still failing, so it counts toward the breaker.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          breaker.failures += 1;
          breaker.openedAt = Date.now();
          throw new DecisionUnavailable(
            response.status === 404 ? `${detail} — the base URL should be the root that serves /v1/systemone, e.g. https://openrouter.ai/api` : detail,
          );
        }
        throw new Error(detail);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const answers: Record<string, Answer> = {};
      const rawAnswers = (payload.answers ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawAnswers)) {
        const answer = normaliseAnswer(value);
        if (answer) answers[key] = answer;
      }
      if (Object.keys(answers).length === 0) throw new Error('decision model returned no usable answers');

      breaker.failures = 0;
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      return {
        model: typeof payload.model === 'string' ? payload.model : config.decision.model,
        answers,
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        latencyMs: Date.now() - started,
        backend: 'systemone',
        raw: payload,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof DecisionUnavailable) throw error;
      if (attempt < MAX_RETRIES - 1) await sleep(BACKOFF_MS[attempt] ?? 2000);
    }
  }

  breaker.failures += 1;
  breaker.openedAt = Date.now();
  throw new DecisionUnavailable(
    `decision model unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function breakerState(): { failures: number; open: boolean } {
  return {
    failures: breaker.failures,
    open: breaker.failures >= BREAKER_THRESHOLD && Date.now() - breaker.openedAt < BREAKER_COOLDOWN_MS,
  };
}

export function resetBreaker(): void {
  breaker.failures = 0;
  breaker.openedAt = 0;
}

/** Which models does the configured decision server offer? */
export async function listModels(config: Config): Promise<{ id: string; jev: boolean }[]> {
  const baseUrl = decisionBase(config.decision.baseUrl);
  if (!baseUrl) return [];
  const headers: Record<string, string> = config.decision.apiKey
    ? { authorization: `Bearer ${config.decision.apiKey}` }
    : {};
  const timeout = Math.min(config.decision.timeoutMs, 5000);

  // `/v1/models` is the contract; a root that only publishes `/models` is tolerated
  // so a base URL one level off still tells you what it has.
  const candidates = [`${baseUrl}${MODELS_PATH}`, `${baseUrl}/models`];
  let lastStatus = 0;
  let lastUrl = candidates[0] ?? '';
  for (const url of candidates) {
    const response = await fetchWithTimeout(url, { headers }, timeout);
    if (response.ok) {
      const payload = (await response.json()) as {
        data?: { id?: string; capabilities?: string[]; details?: { family?: string } }[];
      };
      return (payload.data ?? [])
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({
          id: entry.id as string,
          jev: Boolean(
            entry.capabilities?.includes(MODELS_CAPABILITY) ||
              entry.details?.family?.toLowerCase().includes('jev') ||
              entry.id!.toLowerCase().includes('jev'),
          ),
        }));
    }
    lastStatus = response.status;
    lastUrl = url;
    if (response.status !== 404) break;
  }

  const hint =
    lastStatus === 404
      ? ` — that path does not exist on ${baseUrl}. Use the server root (e.g. https://openrouter.ai/api), not the /v1/systemone endpoint.`
      : '';
  throw new Error(`models endpoint returned ${lastStatus} for ${lastUrl}${hint}`);
}

/** Top-two margin, used by every confidence gate. */
export function marginOf(answer: ChoiceAnswer | undefined): number {
  if (!answer) return 0;
  const sorted = Object.values(answer.probabilities).sort((a, b) => b - a);
  if (sorted.length < 2) return answer.choice ? 1 : 0;
  return round((sorted[0] ?? 0) - (sorted[1] ?? 0), 3);
}
