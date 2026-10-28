/** Dotted-path helpers over the config object the API hands back. */

export type Config = Record<string, unknown>;

export function readPath(source: Config, path: string): unknown {
  let cursor: unknown = source;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function writePath(source: Config, path: string, value: unknown): Config {
  const parts = path.split('.');
  const clone = structuredClone(source);
  let cursor: Record<string, unknown> = clone;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index] as string;
    const next = cursor[key];
    if (next === null || typeof next !== 'object') cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
  return clone;
}

/** Secrets come back masked; echoing the mask back means "leave it alone". */
export const SECRET_MASK = '••••••';

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function asTemplates(value: unknown): Record<string, { done?: string; clarify?: string; confirm?: string }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, { done?: string; clarify?: string; confirm?: string }> = {};
  for (const [language, slots] of Object.entries(value as Record<string, unknown>)) {
    if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const entry = slots as Record<string, unknown>;
    result[language] = {
      done: asString(entry.done),
      clarify: asString(entry.clarify),
      confirm: asString(entry.confirm),
    };
  }
  return result;
}

export interface SpeechRule {
  match: string;
  mode: 'speak' | 'silent' | 'custom';
  say?: string;
}

/** A rule list is free-form, so anything unreadable is dropped rather than crashing a field. */
export function asRules(value: unknown): SpeechRule[] {
  if (!Array.isArray(value)) return [];
  const out: SpeechRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const match = asString(row.match);
    if (!match.trim()) continue;
    const mode = row.mode === 'silent' || row.mode === 'custom' ? row.mode : 'speak';
    out.push(
      mode === 'custom'
        ? { match, mode, say: asString(row.say) }
        : { match, mode },
    );
  }
  return out;
}
