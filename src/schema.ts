/**
 * One description of every setting the proxy has, shared by the API and the dashboard.
 *
 * The dashboard renders itself from this list and the server clamps values with it, so a
 * setting cannot exist in one place and be missing from the other. `test/schema.test.ts`
 * walks the default config and fails if any leaf is not described here.
 */

import type { DecisionThresholds } from './config.js';

export type FieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'slider'
  | 'checkbox'
  | 'select'
  | 'templates'
  | 'rules';

export interface SettingsField {
  /** Dotted path into the config object, e.g. `routing.thresholds.entity`. */
  key: string;
  label: string;
  help?: string;
  type: FieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  unit?: string;
  placeholder?: string;
  /** Shown only when the reader asks for the advanced view. */
  advanced?: boolean;
  /**
   * Offer a "Generate" button that fills the field with a fresh random token.
   *
   * Only for fields whose value the proxy itself accepts (its own bearer token), never for
   * a key a provider issues.
   */
  generate?: boolean;
}

export interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  fields: SettingsField[];
}

const THRESHOLD_HELP: Record<keyof DecisionThresholds, { label: string; help: string }> = {
  minMargin: {
    label: 'Minimum margin',
    help: 'How far the top answer must beat the runner-up before any gate is trusted.',
  },
  actTerse: {
    label: 'Command, no target named',
    help: 'A bare command like "lights on" has to be this sure before the proxy takes it over.',
  },
  actExplicit: {
    label: 'Command, target named',
    help: 'A command that names a device, room or kind of device needs at least this much.',
  },
  clarifyFloor: {
    label: 'Clarify floor',
    help: 'Below this the proxy does not even ask — it forwards to your model.',
  },
  categoryQuery: { label: 'Category: question', help: 'Confidence that the request is a question.' },
  categoryInformation: {
    label: 'Category: information',
    help: 'Confidence that the request wants prose rather than an action.',
  },
  categoryCancel: { label: 'Category: cancel', help: 'Confidence that the request cancels the last one.' },
  categoryUnclear: { label: 'Category: unclear', help: 'Confidence that the request is not readable.' },
  queryKind: { label: 'Question kind', help: 'Confidence in which kind of question is being asked.' },
  domain: { label: 'Kind of device', help: 'Confidence in the domain (light, cover, lock…).' },
  entity: { label: 'Single device', help: 'Confidence that one specific entity is meant.' },
  area: { label: 'Room', help: 'Confidence in the room.' },
  scope: { label: 'Target width', help: 'Confidence in how wide the request reaches (one, a room, the house).' },
  scopeWholeHouse: { label: 'Target width: whole house', help: 'A stricter bar for "turn everything off".' },
  actionProbability: { label: 'Action', help: 'Confidence in what should happen to the target.' },
  noulRisky: { label: 'Risky (model said so)', help: 'How strongly the model must call a request risky.' },
  noulCompound: { label: 'Compound (model said so)', help: 'How strongly the model must call a request compound.' },
  noulHereRelative: { label: 'Here-relative (model said so)', help: 'How strongly "here" must be meant.' },
  riskyAction: { label: 'Risky action', help: 'Confirmation threshold for unlock, open and disarm.' },
  riskyTarget: { label: 'Risky target', help: 'Confirmation threshold for locks, covers, garages, gates, doors and windows.' },
};

function thresholdFields(advanced: boolean): SettingsField[] {
  return (Object.keys(THRESHOLD_HELP) as (keyof DecisionThresholds)[]).map((key) => ({
    key: `routing.thresholds.${key}`,
    label: THRESHOLD_HELP[key].label,
    help: THRESHOLD_HELP[key].help,
    type: 'slider' as const,
    min: 0,
    max: 1,
    step: 0.01,
    advanced,
  }));
}

export function settingsGroups(): SettingsGroup[] {
  return [
    {
      id: 'decision',
      title: 'Decision model',
      description:
        'The typed, calibrated model that decides each request. Nothing is decided until one is configured — with the backend off, every request is forwarded and installing the proxy changes no behaviour.',
      fields: [
        {
          key: 'decision.backend',
          label: 'Backend',
          type: 'select',
          options: [
            { value: 'none', label: 'Off — forward everything' },
            { value: 'systemone', label: 'System One (typed decision model)' },
            { value: 'heuristic', label: 'Heuristic (built-in matcher, no model)' },
          ],
          help: 'Switching to System One with no base URL set leaves the proxy forwarding until one is filled in.',
        },
        {
          key: 'decision.baseUrl',
          label: 'Base URL',
          type: 'text',
          placeholder: 'https://openrouter.ai/api',
          help:
            'The server root that answers /v1/systemone, e.g. https://openrouter.ai/api or ' +
            'http://localhost:11434. Pasting the full /v1/systemone URL works too — the path is stripped.',
        },
        {
          key: 'decision.model',
          label: 'Model',
          type: 'text',
          placeholder: 'the model name your server serves',
        },
        {
          key: 'decision.apiKey',
          label: 'API key',
          type: 'password',
          placeholder: 'optional',
          help: 'Sent as a bearer token. After saving, only the first 12 characters stay visible; type a new key to replace it.',
        },
        {
          key: 'decision.autoStart',
          label: 'Start deciding on its own',
          type: 'checkbox',
          help: 'Off by default. Until you switch it on, the fast path only runs when a request opts in with the model name "typesafe-router".',
        },
        {
          key: 'decision.timeoutMs',
          label: 'Timeout',
          type: 'number',
          min: 500,
          max: 600000,
          step: 100,
          unit: 'ms',
          help: 'How long to wait for a decision before forwarding instead.',
        },
        {
          key: 'decision.cache',
          label: 'Reuse a decision for the same sentence',
          type: 'checkbox',
          help: 'An identical command against the same set of exposed entities is answered from the last decision, with no model call. Nothing expires on a clock: adding, removing or re-exposing an entity invalidates it, and entity state never does. Questions are never cached.',
          advanced: true,
        },
        {
          key: 'decision.persistCache',
          label: 'Keep that cache across restarts',
          type: 'checkbox',
          help: 'Writes it to decision-cache.json in the data directory, so a container update does not pay for the same decisions again.',
          advanced: true,
        },
        {
          key: 'decision.historyTurns',
          label: 'Conversation turns in context',
          type: 'number',
          min: 0,
          max: 10,
          step: 1,
          help: 'Turns of history sent with the decision request. 0 is the fastest.',
        },
        {
          key: 'decision.alwaysConfirmRisky',
          label: 'Ask before risky actions',
          type: 'checkbox',
          help: 'Unlocking, opening a garage or gate, and disarming are always confirmed.',
        },
        {
          key: 'decision.maxOptions',
          label: 'Options per question',
          type: 'number',
          min: 2,
          max: 4096,
          step: 1,
          advanced: true,
          help: 'Ollama caps choice questions at 26; raise this for other backends.',
        },
        {
          key: 'decision.maxEntities',
          label: 'Entities in the state',
          type: 'number',
          min: 1,
          max: 5000,
          step: 10,
          advanced: true,
        },
        {
          key: 'decision.inlineEntityDescriptions',
          label: 'Inline entity descriptions',
          type: 'checkbox',
          advanced: true,
          help: 'Spend more tokens per request to describe each entity to the decision model.',
        },
      ],
    },
    {
      id: 'catalog',
      title: 'Home Assistant catalog',
      description:
        'Where the entity list comes from. With a URL and token the proxy reads the registries and live states over the websocket; without one it parses the entity list out of the prompt Home Assistant sends.',
      fields: [
        {
          key: 'catalog.haUrl',
          label: 'Home Assistant URL',
          type: 'text',
          placeholder: 'http://homeassistant.local:8123',
        },
        {
          key: 'catalog.haToken',
          label: 'Long-lived token',
          type: 'password',
          placeholder: 'only used to read the catalog',
        },
        {
          key: 'catalog.defaultArea',
          label: 'Spoken-from area',
          type: 'text',
          placeholder: 'Kitchen',
          help: 'What "turn on the lights here" means when no area is named.',
        },
        {
          key: 'catalog.exposedOnly',
          label: 'Only what Assist can see',
          type: 'checkbox',
          help: 'List the entities exposed to Assist instead of the whole registry. Turn this off to let the decision model see every entity.',
        },
        {
          key: 'catalog.cacheMs',
          label: 'Cache lifetime',
          type: 'number',
          min: 0,
          max: 3600000,
          step: 1000,
          unit: 'ms',
        },
      ],
    },
    {
      id: 'upstream',
      title: 'Fallback inference server',
      description:
        'Anything the proxy will not decide is forwarded here untouched — this is the server hass_local_openai_llm used before the proxy existed.',
      fields: [
        { key: 'upstream.baseUrl', label: 'Base URL', type: 'text', placeholder: 'http://llama:8081/v1' },
        {
          key: 'upstream.apiKey',
          label: 'API key',
          type: 'password',
          placeholder: 'optional',
          help: 'Sent as a bearer token. After saving, only the first 12 characters stay visible; type a new key to replace it.',
        },
        {
          key: 'upstream.apiKeyFromDecision',
          label: "Use the decision model's API key",
          type: 'checkbox',
          help:
            'Both servers are often the same provider — OpenRouter for the decision model and the fallback. ' +
            'Turn this on to send the decision key here too, without copying it out of a masked field. ' +
            'A key typed above still wins.',
        },
        {
          key: 'upstream.model',
          label: 'Model for forwarded requests',
          type: 'text',
          placeholder: 'e.g. gpt-4o-mini',
          help:
            'Used when a request names the proxy model (typesafe-router) or names none. ' +
            'Without it, a forwarded request asks the server for "typesafe-router", which it does not have.',
        },
        {
          key: 'upstream.timeoutMs',
          label: 'Timeout',
          type: 'number',
          min: 1000,
          max: 600000,
          step: 1000,
          unit: 'ms',
        },
      ],
    },
    {
      id: 'speech',
      title: 'Speech',
      description: 'What Home Assistant says after a tool call has run.',
      fields: [
        {
          key: 'speech.afterTool',
          label: 'After a tool runs',
          type: 'select',
          options: [
            { value: 'template', label: 'Speak it locally (fastest)' },
            { value: 'upstream', label: 'Let the model phrase it' },
            { value: 'empty', label: 'Say nothing' },
          ],
          help: 'Home Assistant\'s own intent response is preferred when it carries speech; these templates are the fallback.',
        },
        {
          key: 'speech.silence',
          label: 'Silence for "Say nothing"',
          type: 'text',
          help: 'Text sent when no speech should be heard. Assist speaks whatever comes back, so a pause marker such as [pause:1.5s] is how the pipeline stays quiet.',
        },
        {
          key: 'speech.rules',
          label: 'Speak or stay quiet per intent',
          type: 'rules',
          help: 'First match wins, against the intent name (HassTurnOn), domain.action (todo.add), a domain (light) or an action (turn_on); todo.* matches a whole domain. Anything unmatched follows the setting above.',
        },
        {
          key: 'speech.confirmSeconds',
          label: 'Confirmation stays armed for',
          type: 'number',
          min: 5,
          max: 3600,
          step: 5,
          unit: 's',
        },
        {
          key: 'speech.templates',
          label: 'Templates',
          type: 'templates',
          help: 'Per language: {entity} and {action} are substituted.',
        },
      ],
    },
    {
      id: 'routing',
      title: 'Routing gates',
      description:
        'A gate passes only when the answer clears its own threshold and the top answer beats the runner-up by the minimum margin. Everything that fails a gate is forwarded, so raising a threshold only makes the proxy quieter.',
      fields: [
        { key: 'routing.enabled', label: 'Fast path enabled', type: 'checkbox' },
        {
          key: 'routing.traceLimit',
          label: 'Decisions kept in the trace',
          type: 'number',
          min: 10,
          max: 1000,
          step: 10,
        },
        ...thresholdFields(false),
      ],
    },
    {
      id: 'server',
      title: 'Server',
      description: 'The endpoint hass_local_openai_llm points at.',
      fields: [
        { key: 'server.host', label: 'Bind address', type: 'text', placeholder: '0.0.0.0' },
        { key: 'server.port', label: 'Port', type: 'number', min: 1, max: 65535, step: 1 },
        {
          key: 'server.apiKey',
          label: 'Bearer token',
          type: 'password',
          placeholder: 'empty accepts any caller',
          help:
            'Set this and the same value must be the API key in hass_local_openai_llm. ' +
            'Generate makes one here — copy it before saving, because afterwards only the first 12 characters stay visible.',
          generate: true,
        },
      ],
    },
  ];
}

export function allFields(): SettingsField[] {
  return settingsGroups().flatMap((group) => group.fields);
}

export function fieldFor(key: string): SettingsField | undefined {
  return allFields().find((field) => field.key === key);
}

export function getPath(source: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[part];
  }, source);
}

export function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  const last = parts.pop();
  if (!last) return;
  let cursor = target;
  for (const part of parts) {
    const next = cursor[part];
    if (next === null || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[last] = value;
}

function decimalsOf(step: number | undefined): number {
  if (!step || Number.isInteger(step)) return 0;
  const text = String(step);
  return text.includes('.') ? text.split('.')[1]!.length : 0;
}

function coerce(field: SettingsField, value: unknown): unknown {
  if (field.type === 'checkbox') return Boolean(value);
  if (field.type === 'select') {
    const allowed = field.options?.map((option) => option.value) ?? [];
    return allowed.includes(String(value)) ? String(value) : undefined;
  }
  if (field.type === 'number' || field.type === 'slider') {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return undefined;
    const decimals = decimalsOf(field.step);
    const rounded = decimals === 0 ? Math.round(num) : Number(num.toFixed(decimals));
    const min = field.min ?? Number.NEGATIVE_INFINITY;
    const max = field.max ?? Number.POSITIVE_INFINITY;
    return Math.min(max, Math.max(min, rounded));
  }
  if (field.type === 'rules') {
    if (!Array.isArray(value)) return undefined;
    const out: { match: string; mode: 'speak' | 'silent' }[] = [];
    for (const item of value.slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const match = typeof row.match === 'string' ? row.match.trim() : '';
      if (!match) continue;
      out.push({ match: match.slice(0, 120), mode: row.mode === 'silent' ? 'silent' : 'speak' });
    }
    return out;
  }
  if (field.type === 'templates') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, { done: string; clarify: string; confirm: string }> = {};
    for (const [language, template] of Object.entries(value as Record<string, unknown>)) {
      if (!template || typeof template !== 'object') continue;
      const candidate = template as Record<string, unknown>;
      out[language] = {
        done: typeof candidate.done === 'string' ? candidate.done : '',
        clarify: typeof candidate.clarify === 'string' ? candidate.clarify : '',
        confirm: typeof candidate.confirm === 'string' ? candidate.confirm : '',
      };
    }
    return out;
  }
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/**
 * Drop incoming values that are not valid for their field, so the stored value is kept
 * instead of an unknown string reaching the pipeline. Returns what was ignored.
 */
export function pruneInvalid(patch: Record<string, unknown>): { key: string; value: unknown }[] {
  const dropped: { key: string; value: unknown }[] = [];
  for (const field of allFields()) {
    const value = getPath(patch, field.key);
    if (value === undefined) continue;
    if (coerce(field, value) !== undefined) continue;
    dropPath(patch, field.key);
    dropped.push({ key: field.key, value });
  }
  return dropped;
}

function dropPath(target: Record<string, unknown>, key: string): void {
  const parts = key.split('.');
  const last = parts.pop();
  if (!last) return;
  let cursor: Record<string, unknown> = target;
  for (const part of parts) {
    const next = cursor[part];
    if (next === null || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[last];
}

/**
 * Force every described setting into range and type. Returns the list of keys that were
 * changed, so the API can tell the reader what it did rather than silently editing them.
 */
export function clampSettings(config: Record<string, unknown>): { key: string; value: unknown }[] {
  const adjusted: { key: string; value: unknown }[] = [];
  for (const field of allFields()) {
    const current = getPath(config, field.key);
    if (current === undefined) continue;
    const next = coerce(field, current);
    if (next === undefined) {
      adjusted.push({ key: field.key, value: current });
      continue;
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      setPath(config, field.key, next);
      adjusted.push({ key: field.key, value: next });
    }
  }
  return adjusted;
}

/** Characters of a stored secret that stay readable in the dashboard. */
export const SECRET_PREFIX = 12;

/**
 * A stored secret is never sent to the browser in full, but showing nothing at all
 * makes it impossible to tell which key is in use. Keep the first few characters
 * (enough to tell `sk-or-v1-…` keys apart without revealing any of the secret body)
 * and mask the rest.
 */
export function maskSecret(value: string, mask = '••••••'): string {
  if (!value) return '';
  // A short value would be almost entirely revealed by its prefix; mask it whole.
  if (value.length <= SECRET_PREFIX + 4) return mask;
  return `${value.slice(0, SECRET_PREFIX)}${mask}`;
}

/** True when a submitted value is the dashboard echoing a mask back rather than a new secret. */
export function isMaskedValue(value: unknown, mask = '••••••'): boolean {
  return typeof value === 'string' && value.includes(mask);
}

/**
 * What a password field means when a form submits it: an empty box means "use the
 * stored value" (a test button has nothing new to say), the masked preview means
 * the same, and anything else is a new secret.
 *
 * This exists because a masked preview is now `prefix + mask`, so comparing a
 * submitted value to the mask string alone silently sent `sk-or-v1-abc••••••` as a
 * real key.
 */
export function secretOrStored(submitted: unknown, stored: string): string {
  if (typeof submitted !== 'string' || !submitted) return stored;
  return isMaskedValue(submitted) ? stored : submitted;
}

/** Mask the secrets in a config object, in place. */
export function maskSecrets(config: Record<string, unknown>, mask = '••••••'): void {
  for (const field of allFields()) {
    if (field.type !== 'password') continue;
    const current = getPath(config, field.key);
    if (typeof current === 'string' && current) setPath(config, field.key, maskSecret(current, mask));
  }
}
