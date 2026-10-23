import { createHash, randomUUID } from 'node:crypto';

export function uid(prefix = 'call'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}


export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Case- and punctuation-insensitive comparison used for name matching. */
export function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Faithful `fetch` with a hard timeout that aborts the underlying request. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
