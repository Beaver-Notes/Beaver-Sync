'use strict';

// TDD test for Task 2: per-device `note_keys` envelopes + fan-out public keys.
//
// NOTE: The upstream brief assumed a `vitest` runner plus `test/helpers.js`
// and `test/fixtures.js` (seedNoteWithCollaborator/makeEnvelope/OWNER_ID/
// COLLAB_ID/app) which do NOT exist in this repo. This repo uses `node --test`
// (no vitest) with the real harness (`buildApp`, `setupTestDb`, `createSession`)
// and the real `/collaboration` route prefix. Those helpers are built here
// inline using the same pattern as Task 1's device-keys test.
//
// Behavioral assertions preserved from the brief:
//   1. storeRecipients stores per-device envelopes for a user, and getKey
//      returns all of the caller's device envelopes (noteHasKey: true).
//   2. listPublicKeys returns one flat entry per collaborator device
//      ({ userId, deviceId, kemPublicKey }).
// Plus: a fresh note reports { noteHasKey: false } (correction #1).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

// ML-KEM-768 public keys are 1184 bytes => 2368 hex chars.
function randomKem() {
  return crypto.randomBytes(1184).toString('hex');
}

async function makeAccount(tag) {
  const id = `fanout-${tag}-${crypto.randomUUID()}`;
  const emailHmac = `fanout-hmac-${tag}-${crypto.randomUUID()}`;
  await query(
    'INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)',
    [id, emailHmac, new Date().toISOString()]
  );
  return id;
}

async function authHeaders(accountId) {
  const session = await createSession(accountId, { headers: {} });
  return { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
}

// A wrapped key envelope — opaque to the server, so any non-empty string works.
function makeEnvelope(name) {
  return `wk-${name}-${crypto.randomBytes(16).toString('hex')}`;
}

async function seedNoteWithCollaborator(opts = {}) {
  const ownerId = await makeAccount('owner');
  const collabId = await makeAccount('collab');
  const ownerKem = randomKem();
  const collabKem = randomKem();
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [ownerKem, ownerId]);
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [collabKem, collabId]);

  if (opts.devices && opts.devices.length) {
    const deviceKeys = opts.devices.map((d, i) => ({
      deviceId: d,
      publicKey: i === 0 ? collabKem : randomKem(),
    }));
    await query('UPDATE accounts SET device_keys = $1 WHERE id = $2', [JSON.stringify(deviceKeys), collabId]);
  }

  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$2,$3,$4),($1,$5,$2,$3,$4)',
    [noteId, ownerId, 'editor', now, collabId]
  );

  return {
    noteId,
    ownerHeaders: await authHeaders(ownerId),
    collabHeaders: await authHeaders(collabId),
    ownerId,
    collabId,
  };
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

test('storeRecipients stores per-device envelopes and getKey returns all', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const { noteId, ownerHeaders, ownerId } = await seedNoteWithCollaborator();
  const wrappedA = makeEnvelope('kA');
  const wrappedB = makeEnvelope('kB');
  const store = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/recipients`,
    headers: ownerHeaders,
    payload: {
      recipients: [
        { userId: ownerId, deviceId: 'dev-a', wrappedKey: wrappedA },
        { userId: ownerId, deviceId: 'dev-b', wrappedKey: wrappedB },
      ],
    },
  });
  assert.equal(store.statusCode, 200, `store failed: ${store.body}`);
  assert.equal(store.json().stored, 2);

  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.noteHasKey, true);
  assert.equal(body.wrappedKeys.length, 2);
  assert.deepEqual(body.wrappedKeys.map((w) => w.deviceId).sort(), ['dev-a', 'dev-b']);
  const map = new Map(body.wrappedKeys.map((w) => [w.deviceId, w.wrappedKey]));
  assert.equal(map.get('dev-a'), wrappedA);
  assert.equal(map.get('dev-b'), wrappedB);
});

test('getKey reports noteHasKey false for a fresh note', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const { noteId, ownerHeaders } = await seedNoteWithCollaborator();
  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.noteHasKey, false);
  assert.deepEqual(body.wrappedKeys, []);
});

test('listPublicKeys returns all device keys of collaborators (flat shape)', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const { noteId, ownerHeaders, collabId } = await seedNoteWithCollaborator({ devices: ['d1', 'd2'] });
  const res = await app.inject({
    method: 'GET',
    url: `/collaboration/public-keys/${noteId}`,
    headers: ownerHeaders,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(Array.isArray(body.collaborators), 'collaborators must be an array');

  const collabEntries = body.collaborators.filter((c) => c.userId === collabId);
  assert.equal(collabEntries.length, 2, 'collaborator should expose both device keys');
  assert.deepEqual(collabEntries.map((c) => c.deviceId).sort(), ['d1', 'd2']);
  for (const c of collabEntries) {
    assert.ok(typeof c.kemPublicKey === 'string' && c.kemPublicKey.length === 2368, 'kemPublicKey must be valid-length hex');
  }
});
