/**
 * One description of every setting the proxy has, shared by the API and the dashboard.
 *
 * The dashboard renders itself from this list and the server clamps values with it, so a
 * setting cannot exist in one place and be missing from the other. `test/schema.test.ts`
 * walks the default config and fails if any leaf is not described here.
 */

import { ACTIONS, DOMAIN_LABELS, INTENTS } from './actions.js';
import type { DecisionThresholds, SpeechRule } from './config.js';

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
  /**
   * Suggested values for a free-form field (`rules`): the dashboard offers them as a picker
   * but still accepts anything typed.
   */
  suggestions?: string[];
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
          key: 'speech.rules',
          label: 'Rules',
          type: 'rules',
          suggestions: speechSuggestions(),
        },
        {
          key: 'speech.afterTool',
          label: 'Default when nothing above matches',
          type: 'select',
          options: [
            { value: 'template', label: 'Speak a short sentence (fastest)' },
            { value: 'upstream', label: 'Let the model phrase it' },
            { value: 'empty', label: 'Stay quiet' },
          ],
          help: 'Home Assistant\'s own intent response is used when it carries speech; the templates below are the fallback.',
        },
        {
          key: 'speech.silence',
          label: 'Text sent instead of silence',
          type: 'text',
          help: 'Used whenever nothing should be heard. Assist speaks whatever comes back, so a pause marker such as [pause:1.5s] is how the pipeline stays quiet.',
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
      id: 'music',
      title: 'Music',
      description:
        '“Play Taylor Swift” names no speaker and no media type, and both are worked out here: it plays on the speaker that was spoken to (or the one the sentence names), and a bare name is an artist, which every provider plays as their top tracks. “Play Don’t Tap The Glass by Tyler The Creator” is an album. Music Assistant is asked first when Home Assistant offers its play service, because it resolves a name against every provider you connected; otherwise the player’s own play service takes the same name and media type, and Home Assistant’s media search is the last resort.',
      fields: [
        {
          key: 'music.enabled',
          label: 'Read “play …” here',
          type: 'checkbox',
          help: 'Off leaves every music request to the model server.',
        },
        {
          key: 'music.provider',
          label: 'Which service plays',
          type: 'select',
          options: [
            { value: 'auto', label: 'Whatever Assist offers (recommended)' },
            { value: 'music_assistant', label: 'Music Assistant’s own service only' },
            { value: 'assist', label: 'Home Assistant’s own media search only' },
          ],
          help: 'In order: Music Assistant’s play service, then the player’s own play_media (which Music Assistant also answers), then Home Assistant’s media search. Only the first two can queue or play an artist rather than a search.',
        },
        {
          key: 'music.enqueue',
          label: 'What happens to the queue',
          type: 'select',
          options: [
            { value: 'replace', label: 'Replace the queue and play now' },
            { value: 'play', label: 'Play next' },
            { value: 'next', label: 'Queue it after the current track' },
            { value: 'replace_next', label: 'Clear what is queued after this' },
            { value: 'add', label: 'Add it to the end of the queue' },
          ],
          help: 'Music Assistant only: Home Assistant’s own media search always replaces what is playing.',
        },
        {
          key: 'music.artist',
          label: 'A bare artist name plays',
          type: 'select',
          options: [
            { value: 'artist', label: 'Their top tracks' },
            { value: 'radio', label: 'A radio station built from them' },
          ],
        },
      ],
    },
    {
      id: 'listening',
      title: 'Listening',
      description:
        'A voice assistant hears the whole room, and everything the fast path cannot call is forwarded to your model server, which answers whatever text arrives. These settings decide whether a sentence was addressed to the assistant at all: a remark between two people is answered with the silence text instead of being acted on.',
      fields: [
        {
          key: 'listening.enabled',
          label: 'Only act on sentences addressed to the assistant',
          type: 'checkbox',
          help: 'When off, every request is forwarded regardless of who it was meant for.',
        },
        {
          key: 'listening.confidence',
          label: 'How sure before staying quiet',
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          help: 'Below this confidence the turn is forwarded as normal. 0.75 means the sentence has to be plainly a remark; raising it to 1 turns the judge off in practice.',
        },
        {
          key: 'listening.local',
          label: 'Read it here when no model answered',
          type: 'checkbox',
          help: 'Covers the turns no decision model sees: a pass-through install, the backend switched off, or a model that is unreachable. The built-in reader only silences sentences that are plainly remarks.',
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
      id: 'clock',
      title: 'Clock',
      description:
        'The proxy answers “what time is it?” itself, in the words a person would use — “five twenty two”, and “five o’clock” on the hour — with no model call. It never says a.m. or p.m.: the reply is spoken aloud, and the part of the day is obvious from the moment you hear it.',
      fields: [
        {
          key: 'clock.timezone',
          label: 'Timezone',
          type: 'text',
          placeholder: 'Europe/Amsterdam',
          help: 'An IANA timezone name. Leave it empty to use the time Home Assistant reports in each request’s system prompt — already in your home’s timezone — and fall back to the container clock.',
        },
      ],
    },
    {
      id: 'weather',
      title: 'Weather',
      description:
        'Questions about the weather are answered by the forecast service itself, in the words it wrote — “Light rain on Wednesday, with highs dipping to 6 °C” — in the language you asked in, with no model call. Nothing is fetched until an API key is here, and a question the proxy does not understand (a room, a device, another city) is forwarded to your model exactly as before.',
      fields: [
        {
          key: 'weather.apiKey',
          label: 'Pirate Weather API key',
          type: 'password',
          help: 'From pirateweather.net — the free tier covers 10,000 calls a month, and one forecast is reused for ten minutes.',
        },
        {
          key: 'weather.latitude',
          label: 'Latitude',
          type: 'number',
          step: 0.0001,
          help: 'Leave both coordinates empty to use Home Assistant’s own home zone, which is where the forecast should be for.',
        },
        {
          key: 'weather.longitude',
          label: 'Longitude',
          type: 'number',
          step: 0.0001,
          help: 'Only needed when the coordinates above are set; Home Assistant’s home zone is read otherwise.',
        },
        {
          key: 'weather.haZoneCoordinates',
          label: 'Read the coordinates from Home Assistant',
          type: 'checkbox',
          help: 'Ask Home Assistant for zone.home instead of the coordinates above. On by default and needs the Home Assistant URL and token.',
        },
        {
          key: 'weather.units',
          label: 'Units',
          type: 'select',
          options: [
            { value: 'auto', label: 'Automatic — follow the language Home Assistant sends' },
            { value: 'si', label: 'SI — °C, m/s' },
            { value: 'ca', label: 'Canada — °C, km/h' },
            { value: 'uk', label: 'United Kingdom — °C, mph' },
            { value: 'us', label: 'United States — °F, mph' },
          ],
          help: 'The API writes the units into its own sentences, so this changes the sentence, not just the numbers.',
        },
        {
          key: 'weather.language',
          label: 'Language of the summaries',
          type: 'text',
          placeholder: 'follow the request',
          advanced: true,
          help: 'Empty sends the language of each request, so an English question gets an English summary. The reader that recognises a weather question is English, so pin a language here if you want the summaries in another one.',
        },
        {
          key: 'weather.style',
          label: 'What the answer says',
          type: 'select',
          options: [
            { value: 'current', label: 'The summary, then the temperature' },
            { value: 'summary', label: 'The summary only' },
            { value: 'full', label: 'The summary, the temperature, and the day’s high and low' },
            { value: 'temperature_first', label: 'The temperature first, then the summary' },
            { value: 'natural', label: 'Said the way a person would' },
          ],
          help: 'Only the wording around the summary is written here. The summary is always the forecast service’s own words, so the answer stays right in every language it writes. “Said the way a person would” frames it in a spoken sentence and varies the phrasing between answers; it has wordings for English, Dutch, German, French, Spanish, Italian, Portuguese, Swedish and Danish, and falls back to the summary and the temperature in any other language.',
        },
        {
          key: 'weather.cacheMs',
          label: 'Forecast lifetime',
          type: 'number',
          min: 0,
          step: 60000,
          unit: 'ms',
          advanced: true,
          help: 'How long one forecast is reused. A forecast does not change between two questions, and this is what keeps the calls per month down.',
        },
        {
          key: 'weather.baseUrl',
          label: 'API host',
          type: 'text',
          placeholder: 'https://api.pirateweather.net',
          advanced: true,
          help: 'Only for a self-hosted or mirrored service. It must speak the same forecast API.',
        },
        {
          key: 'weather.timeoutMs',
          label: 'Timeout',
          type: 'number',
          min: 500,
          step: 500,
          unit: 'ms',
          advanced: true,
          help: 'A timeout falls back to forwarding the question to your model rather than failing the turn.',
        },
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
    const out: SpeechRule[] = [];
    for (const item of value.slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const match = typeof row.match === 'string' ? row.match.trim() : '';
      if (!match) continue;
      const mode = row.mode === 'silent' || row.mode === 'custom' ? row.mode : 'speak';
      const say = typeof row.say === 'string' ? row.say.trim().slice(0, 200) : '';
      out.push(
        mode === 'custom'
          ? { match: match.slice(0, 120), mode, say: say || '{action} {entity}.' }
          : { match: match.slice(0, 120), mode },
      );
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

/**
 * What a rule can be written against, offered as suggestions: the intents Home Assistant
 * exposes, each domain, each action, and each domain.action pair. Free text is still allowed,
 * because a Home Assistant install can offer intents this list has never heard of.
 */
function speechSuggestions(): string[] {
  const intents = Object.values(INTENTS);
  const domains = Object.keys(DOMAIN_LABELS);
  const actions = new Set<string>();
  const pairs: string[] = [];
  for (const key of Object.keys(ACTIONS)) {
    const [domain, action] = key.split(':');
    if (!domain || !action) continue;
    actions.add(action);
    pairs.push(`${domain}.${action}`);
  }
  for (const domain of domains) pairs.push(`${domain}.*`);
  return [...new Set([...intents, ...domains, ...actions, ...pairs])].sort((a, b) => a.localeCompare(b));
}
