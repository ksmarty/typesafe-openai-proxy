/**
 * Google Contacts: the parts that can be held still.
 *
 * The network lives behind `exchangeCode` and `listContacts`, so what is tested here is the
 * shape of the mistake a user actually makes — a redirect URI that does not match the client,
 * a consent link replayed twice, a contact with three phone numbers, a person with a name and
 * no address. Those are the things that decide whether "import my contacts" fills the list or
 * quietly fills it wrong.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig, type Config } from '../src/config.js';
import {
  beginAuth,
  CALLBACK_PATH,
  finishAuth,
  googleConfigured,
  googleConnected,
  forgetContactsCache,
  listContacts,
  parseConnections,
  parsePeople,
  redirectUriFor,
  statusFor,
} from '../src/google.js';

function config(patch: (base: Config) => Config = (base) => base): Config {
  const base = defaultConfig();
  return patch({
    ...base,
    google: { ...base.google, clientId: 'id.apps.googleusercontent.com', clientSecret: 'shh' },
  });
}

const CONNECTIONS = {
  connections: [
    {
      names: [{ displayName: 'Sarah Bell', metadata: { primary: true } }],
      phoneNumbers: [
        { value: '(555) 123-4567', canonicalForm: '+15551234567' },
        { value: '+15559998888' },
      ],
      emailAddresses: [{ value: 'sarah@example.com' }, { value: 'Sarah@Example.com' }],
    },
    {
      names: [{ givenName: 'Mum', familyName: 'Bell' }],
      phoneNumbers: [{ value: '+15559876543' }],
    },
    { names: [{ displayName: 'Nobody' }] },
    {},
  ],
};

const WITH_ALIASES = {
  connections: [
    {
      names: [{ displayName: 'Sarah Bell', metadata: { primary: true } }],
      nicknames: [{ value: 'Mom' }, { value: 'Sarah Bell' }],
      relations: [{ person: 'Sarah Bell', type: 'mother' }],
      phoneNumbers: [{ value: '+15551234567' }],
    },
    {
      names: [{ displayName: 'Bob Bell' }],
      relations: [{ person: 'Bob Bell', type: 'father' }],
      phoneNumbers: [{ value: '+15550001111' }, { value: '+15550002222' }],
    },
  ],
};

test('a nickname or a relationship becomes an alias on every row of that person', () => {
  assert.deepEqual(parseConnections(WITH_ALIASES), [
    { name: 'Bob Bell', address: '+15550001111', aliases: ['father'] },
    { name: 'Bob Bell', address: '+15550002222', aliases: ['father'] },
    { name: 'Sarah Bell', address: '+15551234567', aliases: ['Mom', 'mother'] },
  ]);
});

test('a person with no nickname or relation has no aliases field at all', () => {
  for (const row of parseConnections(CONNECTIONS)) {
    assert.equal('aliases' in row, false);
  }
});

test('a connection becomes one row per address, with the canonical phone form', () => {
  assert.deepEqual(parseConnections(CONNECTIONS), [
    { name: 'Mum Bell', address: '+15559876543' },
    { name: 'Sarah Bell', address: '+15551234567' },
    { name: 'Sarah Bell', address: '+15559998888' },
    { name: 'Sarah Bell', address: 'sarah@example.com' },
  ]);
});

test('a person with no address or no name is dropped, and reads are forgiving', () => {
  assert.deepEqual(parseConnections({}), []);
  assert.deepEqual(parseConnections({ connections: [] }), []);
  assert.deepEqual(parseConnections({ connections: [{ phoneNumbers: [{ value: '+15550000000' }] }] }), [
    // A number with no name is still reachable; an empty name is what the importer shows.
    { name: '', address: '+15550000000' },
  ]);
  assert.deepEqual(parseConnections(null), []);
  assert.deepEqual(parseConnections({ connections: [{ names: [{ displayName: 'No address' }] }] }), []);
});

test('configured and connected are two different questions', () => {
  assert.equal(googleConfigured(defaultConfig()), false);
  assert.equal(googleConfigured(config()), true);
  assert.equal(googleConnected(config()), false);
  assert.equal(
    googleConnected(config((base) => ({ ...base, google: { ...base.google, refreshToken: 't' } }))),
    true,
  );
  // A token with no client cannot be refreshed, so it is not a connection either.
  assert.equal(
    googleConnected(
      config((base) => ({
        ...base,
        google: { ...base.google, clientId: '', clientSecret: '', refreshToken: 't' },
      })),
    ),
    false,
  );
});

test('the redirect URI is the one the user registered, or this dashboard', () => {
  const origin = 'http://192.168.1.128:8080';
  assert.equal(redirectUriFor(config(), origin), `${origin}${CALLBACK_PATH}`);
  const registered = 'https://proxy.example.com/api/google/callback';
  const active = config((base) => ({ ...base, google: { ...base.google, redirectUri: registered } }));
  assert.equal(redirectUriFor(active, origin), registered);
  assert.equal(statusFor(active, origin).redirectUri, registered);
  assert.deepEqual(statusFor(active, origin), {
    configured: true,
    connected: false,
    redirectUri: registered,
  });
});

test('a consent link is single use and expires, so a replay is not a second connection', () => {
  const state = beginAuth('http://here/api/google/callback');
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.equal(finishAuth(state), 'http://here/api/google/callback');
  assert.equal(finishAuth(state), null, 'the same state must not connect twice');
  assert.equal(finishAuth('never issued'), null);

  const stale = beginAuth('http://here/api/google/callback');
  assert.equal(finishAuth(stale, Date.now() + 11 * 60 * 1000), null);
});

test('a person is one entry with their numbers and addresses inside it', () => {
  const [sarah, bob] = parsePeople(WITH_ALIASES);
  assert.equal(sarah.name, 'Bob Bell');
  assert.deepEqual(sarah.addresses, [
    { value: '+15550001111', kind: 'phone' },
    { value: '+15550002222', kind: 'phone' },
  ]);
  assert.equal(bob.name, 'Sarah Bell');
  assert.deepEqual(bob.aliases, ['Mom', 'mother']);
  assert.deepEqual(bob.addresses, [{ value: '+15551234567', kind: 'phone' }]);
  // The email is the same person, not a second one.
  assert.deepEqual(parsePeople(CONNECTIONS).map((person) => person.name), ['Mum Bell', 'Sarah Bell']);
  assert.deepEqual(
    parsePeople(CONNECTIONS)[1].addresses.map((one) => one.kind),
    ['phone', 'phone', 'email'],
  );
});

test('the list is kept, handed back instantly, and re-read when asked or aged out', async () => {
  forgetContactsCache();
  const active = config((base) => ({ ...base, google: { ...base.google, refreshToken: 't' } }));
  const people = [{ name: 'Sarah', aliases: [], addresses: [{ value: '+15551234567', kind: 'phone' as const }] }];
  let reads = 0;
  const read = async () => {
    reads += 1;
    return people;
  };

  const first = await listContacts(active, { read, now: 1000 });
  assert.equal(first.cached, false);
  assert.deepEqual(first.people, people);

  // Second look is instant and does not touch the network.
  const second = await listContacts(active, { read, now: 2000 });
  assert.equal(second.cached, true);
  assert.equal(reads, 1);
  assert.equal(second.fetchedAt, first.fetchedAt);

  // A background pass always reads, and hands back what it found.
  const refreshed = await listContacts(active, { read, now: 3000, refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(reads, 2);

  // Past the window the next look reads again.
  await listContacts(active, { read, now: 3000 + 5 * 60 * 1000 });
  assert.equal(reads, 3);

  // A different account never sees the previous one's contacts.
  const other = config((base) => ({ ...base, google: { ...base.google, refreshToken: 'other' } }));
  await listContacts(other, { read, now: 3000 + 5 * 60 * 1000 + 1 });
  assert.equal(reads, 4);

  forgetContactsCache();
  await listContacts(active, { read, now: 3000 + 5 * 60 * 1000 + 2 });
  assert.equal(reads, 5);
});

test('a failed read is an error, never a cached empty list', async () => {
  forgetContactsCache();
  const active = config((base) => ({ ...base, google: { ...base.google, refreshToken: 't' } }));
  const failed = await listContacts(active, {
    now: 1,
    read: async () => {
      throw new Error('google is down');
    },
  });
  assert.match(failed.error ?? '', /google is down/);
  assert.equal(failed.people, undefined);

  // Nothing was stored, so the next attempt still reads.
  let reads = 0;
  const good = await listContacts(active, {
    now: 2,
    read: async () => {
      reads += 1;
      return [{ name: 'Sarah', aliases: [], addresses: [{ value: '+15551234567', kind: 'phone' as const }] }];
    },
  });
  assert.equal(reads, 1);
  assert.equal(good.cached, false);
  forgetContactsCache();
});
