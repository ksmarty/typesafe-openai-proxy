/**
 * Google Contacts, read-only.
 *
 * The contacts map is what turns "Sarah" into a phone number, and typing a household's worth of
 * names and numbers by hand is the kind of setup nobody finishes. This module lets the dashboard
 * pull the list out of the Google account the household already keeps it in, so the only work
 * left is ticking the names that should be reachable by voice.
 *
 * Three deliberate choices:
 *
 *  1. **Read-only, one scope.** `contacts.readonly` is the only thing asked for, so a mistake
 *     here can leak a list at worst — never write to, or delete from, the account.
 *  2. **No dependencies and no server state.** OAuth here is two `fetch` calls and a signed-in
 *     refresh token kept in `data/config.json` beside the other secrets. The library that would
 *     do it for us is bigger than this whole file.
 *  3. **The token never travels back to the browser.** `/api/google/status` answers whether a
 *     token exists, never what it is; the settings API masks it like every other secret.
 *
 * The consent screen needs an OAuth client of the user's own, because the proxy cannot ship
 * someone else's client secret: `google.clientId` and `google.clientSecret` are settings, and the
 * redirect URI has to be registered on that client.
 */

import { randomBytes } from 'node:crypto';

import type { Config, Contact } from './config.js';
import { fetchWithTimeout } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me/connections';

/** Contacts only. Nothing here may write to the account. */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

/** Path the consent screen comes back to, on whatever host the proxy is reached over. */
export const CALLBACK_PATH = '/api/google/callback';

/** How long a started consent flow may take before its state stops being accepted. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** What the dashboard may know about the connection. */
export interface GoogleStatus {
  /** A client id and secret are saved, so a connection can be started. */
  configured: boolean;
  /** A refresh token is saved, so the list can be read. */
  connected: boolean;
  /** The address Google will come back to, which has to be on the OAuth client. */
  redirectUri: string;
}

/**
 * One in-flight consent flow, keyed by its state.
 *
 * The redirect URI is kept with it rather than recomputed on the way back: Google checks that
 * the two match exactly, and a proxy reached over a different host name in between would
 * otherwise fail the exchange with a message that says nothing useful.
 */
const states = new Map<string, { redirect: string; at: number }>();

function pruneStates(now: number): void {
  for (const [state, entry] of states) {
    if (now - entry.at > STATE_TTL_MS) states.delete(state);
  }
}

/** Begin a flow: the random `state` to send, and the redirect it will come back to. */
export function beginAuth(redirect: string, now = Date.now()): string {
  pruneStates(now);
  const state = randomBytes(16).toString('hex');
  states.set(state, { redirect, at: now });
  return state;
}

/** Finish one: the redirect URI that flow started with, or null if the state is not ours. */
export function finishAuth(state: string, now = Date.now()): string | null {
  pruneStates(now);
  const entry = states.get(state);
  if (!entry) return null;
  states.delete(state);
  return entry.redirect;
}

export function googleConfigured(config: Config): boolean {
  return Boolean(config.google.clientId.trim() && config.google.clientSecret.trim());
}

export function googleConnected(config: Config): boolean {
  // A stored token with no client to refresh it against is not a connection: it will fail on
  // the first read, so saying "connected" would only hide where the problem is.
  return googleConfigured(config) && Boolean(config.google.refreshToken.trim());
}

/**
 * The redirect URI to use.
 *
 * An explicit setting wins, because a proxy behind Home Assistant ingress or a reverse proxy is
 * reached over a name this process cannot see. Falling back to the address the dashboard was
 * opened from keeps the loopback case — the one Google registers without a verification review —
 * working with nothing filled in.
 */
export function redirectUriFor(config: Config, origin: string): string {
  const configured = config.google.redirectUri.trim();
  if (configured) return configured;
  return `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

export function statusFor(config: Config, origin: string): GoogleStatus {
  return {
    configured: googleConfigured(config),
    connected: googleConnected(config),
    redirectUri: redirectUriFor(config, origin),
  };
}

/** The consent screen: offline access, so the answer includes a refresh token. */
export function authorizeUrl(config: Config, state: string, redirect: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', config.google.clientId.trim());
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  // Without this Google only returns a refresh token the first time a client is consented to.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(config: Config, form: URLSearchParams): Promise<TokenBody> {
  const response = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    15000,
  );
  const text = await response.text();
  try {
    return JSON.parse(text) as TokenBody;
  } catch {
    return { error: `google answered ${response.status}`, error_description: text.slice(0, 200) };
  }
}

/** Trade the code from the callback for the refresh token that gets stored. */
export async function exchangeCode(
  config: Config,
  code: string,
  redirect: string,
): Promise<{ refreshToken?: string; error?: string }> {
  const body = await tokenRequest(
    config,
    new URLSearchParams({
      code,
      client_id: config.google.clientId.trim(),
      client_secret: config.google.clientSecret.trim(),
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  );
  if (body.error || !body.refresh_token) {
    const detail = body.error_description ?? body.error ?? 'no refresh token came back';
    return { error: detail };
  }
  return { refreshToken: body.refresh_token };
}

async function accessToken(config: Config): Promise<{ token?: string; error?: string }> {
  const body = await tokenRequest(
    config,
    new URLSearchParams({
      client_id: config.google.clientId.trim(),
      client_secret: config.google.clientSecret.trim(),
      refresh_token: config.google.refreshToken.trim(),
      grant_type: 'refresh_token',
    }),
  );
  if (body.error || !body.access_token) {
    const detail = body.error_description ?? body.error ?? 'google refused the refresh token';
    return { error: detail };
  }
  return { token: body.access_token };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One way to reach a person, and what kind of address it is. */
export interface GoogleAddress {
  value: string;
  kind: 'phone' | 'email';
}

/** A person from the Google account, with every address the picker can offer for them. */
export interface GooglePerson {
  name: string;
  aliases: string[];
  addresses: GoogleAddress[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** A person's name as they would be said: the display name, else the parts joined up. */
function nameOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const entries = value.map(recordOf).filter((entry): entry is Record<string, unknown> => entry !== null);
  const primary = entries.find((entry) => entry.metadata && recordOf(entry.metadata)?.primary === true);
  for (const entry of [primary, ...entries]) {
    if (!entry) continue;
    const display = textOf(entry.displayName);
    if (display) return display;
    const joined = [textOf(entry.givenName), textOf(entry.familyName)].filter(Boolean).join(' ');
    if (joined) return joined;
  }
  return '';
}

/**
 * The other things this person answers to.
 *
 * Two fields carry them, and both are worth having: `nicknames` is what the account calls them
 * ("Mom", "Dad"), and `relations` is how they are related to the account holder ("mother",
 * "spouse") — which is exactly the word a household says out loud. "Text mom" works for a
 * contact whose name is something else entirely.
 */
function aliasesOf(value: { nicknames?: unknown; relations?: unknown }, name: string): string[] {
  const said = new Set<string>([name.toLowerCase()]);
  const out: string[] = [];
  const add = (alias: string): void => {
    const trimmed = alias.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || said.has(key)) return;
    said.add(key);
    out.push(trimmed);
  };
  if (Array.isArray(value.nicknames)) {
    for (const entry of value.nicknames) {
      const record = recordOf(entry);
      if (record) add(textOf(record.value));
    }
  }
  if (Array.isArray(value.relations)) {
    for (const entry of value.relations) {
      const record = recordOf(entry);
      if (!record) continue;
      add(textOf(record.type) || textOf(record.formattedType));
    }
  }
  return out;
}

/** Numbers as E.164 where Google knows it, because that is what BlueBubbles wants. */
function phonesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    if (!record) continue;
    const number = textOf(record.canonicalForm) || textOf(record.value);
    if (number) out.push(number);
  }
  return out;
}

function emailsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const address = textOf(recordOf(entry)?.value);
    if (address) out.push(address);
  }
  return out;
}

/**
 * Turn a `people/me/connections` page into people, each with the addresses it can be reached at.
 *
 * The importer asks two questions — who, then which number — so a person is kept whole instead of
 * being flattened into a row per address. Addresses are deduplicated on the value itself (a number
 * shared by two people is one number), and people are sorted by name so the list reads like an
 * address book.
 */
export function parsePeople(payload: unknown, seen = new Set<string>()): GooglePerson[] {
  const raw = recordOf(payload)?.connections;
  if (!Array.isArray(raw)) return [];
  const out: GooglePerson[] = [];
  for (const person of raw) {
    const record = recordOf(person);
    if (!record) continue;
    const name = nameOf(record.names);
    const addresses: GoogleAddress[] = [];
    for (const value of phonesOf(record.phoneNumbers)) addresses.push({ value, kind: 'phone' });
    for (const value of emailsOf(record.emailAddresses)) addresses.push({ value, kind: 'email' });
    const kept = addresses.filter((address) => {
      const key = address.value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (kept.length === 0) continue;
    out.push({ name, aliases: aliasesOf(record, name), addresses: kept });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

/** The flat shape, one row per address, for the callers that want a single list. */
export function parseConnections(payload: unknown): Contact[] {
  const rows: Contact[] = [];
  for (const person of parsePeople(payload, new Set<string>())) {
    for (const address of person.addresses) {
      rows.push(
        person.aliases.length > 0
          ? { name: person.name, address: address.value, aliases: person.aliases }
          : { name: person.name, address: address.value },
      );
    }
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/** Most pages this will walk before giving up, so a huge account cannot stall the request. */
const MAX_PAGES = 10;

/** How long a read is served from memory before the next look goes and asks Google again. */
const CONTACTS_TTL_MS = 5 * 60 * 1000;

interface ContactsCache {
  key: string;
  people: GooglePerson[];
  fetchedAt: number;
}

let contactsCache: ContactsCache | null = null;

/** Which account a cached read belongs to: another client or token is another list. */
function cacheKey(config: Config): string {
  return `${config.google.clientId}\u0000${config.google.refreshToken}`;
}

/** Forget the read held in memory, so a disconnect or a saved token is not answered from it. */
export function forgetContactsCache(): void {
  contactsCache = null;
}

/**
 * Read the account's contacts, grouped by person.
 *
 * An address book is big and slow to fetch, and the picker is opened more than once, so a read is
 * kept for a few minutes: opening the picker again is instant, and `refresh` asks Google anyway
 * from the background. The cache is keyed by the account, so a different client or token never
 * answers with the previous account's contacts.
 */
/**
 * Every connection, page by page.
 *
 * Kept separate from `listContacts` so the cache around it can be reasoned about — and tested —
 * without a network: nobody's test suite should be waiting on Google to answer.
 */
async function readPeople(config: Config): Promise<{ people?: GooglePerson[]; error?: string }> {
  const auth = await accessToken(config);
  if (auth.error || !auth.token) return { error: auth.error ?? 'no access token' };
  const people: GooglePerson[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(PEOPLE_URL);
    url.searchParams.set('personFields', 'names,nicknames,relations,phoneNumbers,emailAddresses');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let payload: unknown = null;
    try {
      const response = await fetchWithTimeout(
        url.toString(),
        { headers: { authorization: `Bearer ${auth.token}`, accept: 'application/json' } },
        20000,
      );
      const text = await response.text();
      payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const detail = recordOf(recordOf(payload)?.error)?.message;
        return { error: typeof detail === 'string' ? detail : `google answered ${response.status}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    people.push(...parsePeople(payload, seen));
    const next = textOf(recordOf(payload)?.nextPageToken);
    if (!next || next === pageToken) break;
    pageToken = next;
  }
  return { people };
}

export async function listContacts(
  config: Config,
  options: { refresh?: boolean; now?: number; read?: (config: Config) => Promise<GooglePerson[]> } = {},
): Promise<{ people?: GooglePerson[]; fetchedAt?: number; cached?: boolean; error?: string }> {
  if (!googleConfigured(config)) return { error: 'no OAuth client is saved' };
  if (!googleConnected(config)) return { error: 'not connected to Google' };

  const key = cacheKey(config);
  const now = options.now ?? Date.now();
  if (
    !options.refresh &&
    contactsCache !== null &&
    contactsCache.key === key &&
    now - contactsCache.fetchedAt < CONTACTS_TTL_MS
  ) {
    return { people: contactsCache.people, fetchedAt: contactsCache.fetchedAt, cached: true };
  }

  let listed: GooglePerson[];
  if (options.read) {
    try {
      listed = await options.read(config);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    const read = await readPeople(config);
    if (read.error || !read.people) return { error: read.error ?? 'no contacts came back' };
    listed = read.people;
  }
  const people = new Map<string, GooglePerson>();
  for (const person of listed) {
    const existing = people.get(person.name.toLowerCase());
    if (!existing) {
      people.set(person.name.toLowerCase(), { ...person, addresses: [...person.addresses] });
      continue;
    }
    existing.addresses.push(...person.addresses);
    for (const alias of person.aliases) {
      if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
  }
  const list = [...people.values()].sort((left, right) => left.name.localeCompare(right.name));
  contactsCache = { key, people: list, fetchedAt: now };
  return { people: list, fetchedAt: contactsCache.fetchedAt, cached: false };
}
