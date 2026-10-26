/**
 * A small ring buffer of recent server output.
 *
 * The proxy is deployed as a container, where the only way to see a problem is
 * `docker logs`. The debug bundle needs the same lines from inside the running
 * process, so stdout/stderr are tee'd into memory — the streams themselves are
 * untouched, so `docker logs` still works exactly as before.
 */

const MAX_LINES = 400;
const lines: string[] = [];
let installed = false;

function record(chunk: unknown): void {
  let text = '';
  if (typeof chunk === 'string') text = chunk;
  else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString('utf8');
  if (!text) return;
  const stamp = new Date().toISOString();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines.push(`${stamp} ${line}`);
  }
  while (lines.length > MAX_LINES) lines.shift();
}

/** Start capturing. Safe to call more than once. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      try {
        record(chunk);
      } catch {
        // Capturing logs must never be the reason a log line fails.
      }
      return original(chunk, ...rest);
    }) as typeof stream.write;
  }
}

/** The most recent captured lines, oldest first. */
export function recentLogs(limit = MAX_LINES): string[] {
  return lines.slice(-limit);
}

/** A line written directly into the buffer, for events worth explaining later. */
export function note(message: string): void {
  record(`${message}\n`);
}
