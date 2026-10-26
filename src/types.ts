/** Shared types for the whole proxy. */

// --- Home Assistant catalog -------------------------------------------------

export interface CatalogArea {
  id: string;
  name: string;
  floor?: string;
  /** Other names Home Assistant answers to for this area. */
  aliases?: string[];
}

export interface CatalogEntity {
  /** `light.kitchen_light` */
  id: string;
  /** Friendly name as Home Assistant shows it. */
  name: string;
  domain: string;
  state: string;
  areaId?: string;
  areaName?: string;
  floor?: string;
  deviceClass?: string;
  /** Other names Home Assistant answers to for this entity (Assist aliases). */
  aliases?: string[];
  /** Attribute name used to render state for this domain (`brightness`, ...). */
  unit?: string;
  /** The current numeric level, when the domain has one (brightness, volume, position). */
  level?: number;
  /** Which attribute `level` came from, so it can be scaled back for a slot. */
  levelIn?: 'brightness' | 'percentage' | 'position' | 'volume_level' | 'temperature' | 'humidity';
}

export interface Catalog {
  areas: CatalogArea[];
  entities: CatalogEntity[];
  /** `light`, `switch`, ... present among the exposed entities. */
  domains: string[];
  source: 'ha-websocket' | 'prompt' | 'manual' | 'empty';
  /** Epoch ms when the catalog was built. */
  builtAt: number;
  /** Human readable note about where it came from (shown in the dashboard). */
  note?: string;
}

// --- The System One (decision model) wire format ----------------------------

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface DecisionResponse {
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Which backend answered: a real System One server, or the built-in heuristic. */
  backend: 'systemone' | 'heuristic' | 'off' | 'confirmation';
  raw?: unknown;
}

export type QuestionType = 'choice' | 'noul' | 'score';

export interface Question {
  type: QuestionType;
  instructions: string;
  criteria: Record<string, string>;
}

export type QuestionSet = Record<string, Question>;

export interface DecisionState {
  request: {
    text: string;
    language?: string;
    spoken_from_area?: { id: string; name: string };
    now?: string;
  };
  home: {
    areas: { id: string; name: string; floor?: string }[];
    entities: {
      id: string;
      name: string;
      domain: string;
      state: string;
      area?: string;
      floor?: string;
      device_class?: string;
    }[];
  };
  conversation?: { text: string; said_by: 'user' | 'assistant' }[];
}

// --- Routing ----------------------------------------------------------------

export type Gate = {
  question: string;
  choice?: string;
  probability?: number;
  confidence?: number;
  margin?: number;
  threshold?: number;
  passed: boolean;
  /** Set when the value did not come from the model — e.g. a room named in the sentence. */
  note?: string;
};

/** One Home Assistant intent call, as it will be sent. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Entity ids or area names the call targets, for the trace and confirmations. */
  targets: string[];
  action: string;
  domain?: string;
}

export interface ToolCallPlan extends ToolCall {
  kind: 'tool';
  /** Spoken confirmation the proxy composed itself, when it could. */
  said?: string;
}

/**
 * Several calls in one turn: either one action across several targets ("the kitchen and
 * the living room lights") or a compound sentence split into one call per clause. Home
 * Assistant runs them in order and sends one tool result each.
 */
export interface MultiCallPlan {
  kind: 'calls';
  calls: ToolCall[];
  action: string;
  domain?: string;
  said?: string;
}

export interface ClarifyPlan {
  kind: 'clarify';
  text: string;
  options?: string[];
}

export interface ConfirmPlan {
  kind: 'confirm';
  text: string;
  pending: ToolCallPlan | MultiCallPlan;
}

export interface ForwardPlan {
  kind: 'forward';
  reason: string;
}

export interface TextPlan {
  kind: 'text';
  text: string;
}

export type Plan = ToolCallPlan | MultiCallPlan | ClarifyPlan | ConfirmPlan | ForwardPlan | TextPlan;

export interface RouteResult {
  plan: Plan;
  gates: Gate[];
  /** Condensed one-line explanation of the decision. */
  reason: string;
  category?: string;
  action?: string;
  target?: string;
  risky?: boolean;
}

// --- OpenAI wire types (only what this proxy touches) -----------------------

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIToolFunction;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

export interface TraceEntry {
  id: string;
  at: number;
  utterance: string;
  language?: string;
  /** `refused` marks a request that never became a turn (wrong key, bad body, a throw). */
  route: Plan['kind'] | 'refused';
  reason: string;
  /** Set when the request was answered with an error instead of a route. */
  httpStatus?: number;
  /** Where the time went, so "it felt slow" has a number beside it. */
  timings?: { catalogMs?: number; questionsMs?: number; decideMs?: number };
  /** Time spent waiting on the model server, when the turn was forwarded to it. */
  upstreamMs?: number;
  tool?: string;
  args?: Record<string, unknown>;
  /** Set when the turn sent several calls at once. */
  calls?: { tool: string; args: Record<string, unknown> }[];
  category?: string;
  action?: string;
  target?: string;
  gates: Gate[];
  decisionMs?: number;
  totalMs?: number;
  inputTokens?: number;
  backend?: string;
  catalogSource?: string;
  entities?: number;
  /** Tool names the request offered, so "not offered" can be read against reality. */
  toolsOffered?: string[];
  model?: string;
  error?: string;
  clarification?: string;
  toolResult?: unknown;
}
