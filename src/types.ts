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

export interface ToolCallPlan {
  kind: 'tool';
  tool: string;
  args: Record<string, unknown>;
  /** Entity ids or area names the call targets, for the trace and confirmations. */
  targets: string[];
  action: string;
  domain?: string;
  /** Spoken confirmation the proxy composed itself, when it could. */
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
  pending: ToolCallPlan;
}

export interface ForwardPlan {
  kind: 'forward';
  reason: string;
}

export interface TextPlan {
  kind: 'text';
  text: string;
}

export type Plan = ToolCallPlan | ClarifyPlan | ConfirmPlan | ForwardPlan | TextPlan;

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
  route: Plan['kind'];
  reason: string;
  tool?: string;
  args?: Record<string, unknown>;
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
