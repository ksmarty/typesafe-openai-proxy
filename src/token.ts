/**
 * Bearer tokens the proxy can hand out for itself.
 *
 * The dashboard needs to mint one for `server.apiKey`, so this runs in the browser as well
 * as in Node. It uses `crypto.getRandomValues`, which — unlike `crypto.randomUUID` and
 * `crypto.subtle` — works in an insecure context, so it keeps working inside the embedded
 * preview iframe that throws on `randomUUID`.
 */

/** URL-safe and unambiguous when read aloud: no `+/=`, no look-alike pairs to worry about. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 32 bytes, so 32 characters of base64url-alphabet randomness — about 190 bits. */
const TOKEN_BYTES = 32;

export const TOKEN_PREFIX = 'sk-proxy-';

/**
 * A fresh token, prefixed so it is recognisable in a log or a Home Assistant config.
 *
 * Two calls never return the same string; each character is one masked random byte, so
 * every position is uniform over the 64-character alphabet.
 */
export function generateToken(prefix: string = TOKEN_PREFIX): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let body = '';
  for (const byte of bytes) body += ALPHABET[byte & 63];
  return `${prefix}${body}`;
}
