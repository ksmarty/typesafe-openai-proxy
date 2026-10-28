import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version of the code that is answering right now.
 *
 * This deliberately re-stats `package.json` instead of capturing it once at boot: the release
 * workflow bumps the manifest and pushes, and a long-running server (or a dev server watching
 * only its own imports) would otherwise keep claiming the version it started with — which reads
 * as "the fix is not deployed" when the fix is right there. A stat per call costs microseconds;
 * the file is parsed again only when its mtime or size changes.
 */

let cache: { key: string; version: string } | null = null;

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/version.js or src/version.ts -> the manifest one level up.
  return [resolve(here, '..', 'package.json'), resolve(process.cwd(), 'package.json')];
}

/** Synchronous on purpose: callers are request handlers that render it directly. */
export function appVersion(): string {
  for (const path of candidates()) {
    try {
      const info = statSync(path);
      const key = `${path}:${info.mtimeMs}:${info.size}`;
      if (cache && cache.key === key) return cache.version;
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? 'unknown';
      cache = { key, version };
      return version;
    } catch {
      // Try the next candidate: a runtime image may not sit next to a manifest.
    }
  }
  return cache?.version ?? 'unknown';
}

/** Forget the cached read. Tests use it; nothing in the server needs to. */
export function resetVersionCache(): void {
  cache = null;
}
