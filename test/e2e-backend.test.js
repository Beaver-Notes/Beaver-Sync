'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { createMlKem768 } = require('mlkem');
const { wrapForRecipient } = require('../src/lib/recipient-wrap');

const now = new Date().toISOString();

async function seedAccount(id, kemPublicKey = null) {
  await query(
    'INSERT INTO accounts (id, username, email_hmac, created_at, kem_public_key) VALUES ($1, $2, $3, $4, $5)',
    [id, id, `${id}-email`, now, kemPublicKey]
  );
}

async function seedWorkspace(id, ownerId) {
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', [id, 'cipher', ownerId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', [id, ownerId, 'owner', now]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [`${ownerId}-sub`, ownerId, 'pro', 'active', 1000000, 0, now]);
}

async function makeKeypair() {
  const k = await createMlKem768();
  const [pk, sk] = k.generateKeyPair();
  return { pk: Buffer.from(pk).toString('hex'), sk: Buffer.from(sk).toString('hex') };
}

let app;
let alice, bob;
let aliceSession, bobSession;
let originalAliceKemCt;

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();

  alice = await makeKeypair();
  bob = await makeKeypair();

  await seedAccount('alice', alice.pk);
  await seedAccount('bob', bob.pk);
  await seedAccount('nokey', null);
  await seedWorkspace('ws-1', 'alice');

  app = await buildApp();
  await app.ready();
  aliceSession = await createSession('alice', {});
  bobSession = await createSession('bob', {});
});

test.after(async () => {
  await app.close();
  close();
});

function post(session, url, payload) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, payload });
}
function get(session, url) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${session}` } });
}

test('invite requires target to have a keypair', async () => {
  const res = await post(aliceSession, '/collaboration/invite/note-e2e-keys-note-01', { username: 'nokey' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('stores recipient envelopes and returns only the caller\u2019s own', async () => {
  await post(aliceSession, '/collaboration/invite/note-e2e-keys-note-01', { username: 'bob' });

  const secret = Buffer.from('a'.repeat(64), 'hex');
  const aliceEnv = await wrapForRecipient(alice.pk, secret);
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(aliceSession, '/collaboration/keys/note-e2e-keys-note-01/recipients', {
    recipients: [
      { userId: 'alice', wrappedKey: JSON.stringify(aliceEnv) },
      { userId: 'bob', wrappedKey: JSON.stringify(bobEnv) },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stored, 2);
  assert.equal(res.json().noteHasKey, true);
  assert.equal(res.json().existing, false);

  const aliceGet = await get(aliceSession, '/collaboration/keys/note-e2e-keys-note-01');
  assert.equal(aliceGet.statusCode, 200);
  assert.equal(aliceGet.json().noteHasKey, true);
  const parsed = JSON.parse(aliceGet.json().wrappedKeys[0].wrappedKey);
  assert.equal(parsed.kemCt, aliceEnv.kemCt);

  const bobGet = await get(bobSession, '/collaboration/keys/note-e2e-keys-note-01');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.equal(JSON.parse(bobGet.json().wrappedKeys[0].wrappedKey).kemCt, bobEnv.kemCt);
});

test('GET /keys/:noteId reports noteHasKey for fresh notes and late joiners', async () => {
  // Fresh note: no envelopes yet, but the caller must be a collaborator first.
  let fresh = await get(aliceSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(fresh.statusCode, 403);
  assert.equal(fresh.json().error, 'forbidden');
  await post(aliceSession, '/collaboration/invite/note-fresh-key-store', { username: 'alice' }).catch(() => {});

  fresh = await get(aliceSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.json().noteHasKey, false);
  assert.deepEqual(fresh.json().wrappedKeys, []);

  // Seed an envelope for alice only.
  const secret = Buffer.from('b'.repeat(64), 'hex');
  const aliceEnv = await wrapForRecipient(alice.pk, secret);
  originalAliceKemCt = aliceEnv.kemCt;
  const store = await post(aliceSession, '/collaboration/keys/note-fresh-key-store/recipients', {
    recipients: [{ userId: 'alice', wrappedKey: JSON.stringify(aliceEnv) }],
  });
  assert.equal(store.statusCode, 200);
  assert.equal(store.json().existing, false);

  // Late joiner with no envelope still learns the note already has a key.
  await post(aliceSession, '/collaboration/invite/note-fresh-key-store', { username: 'bob' });
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(bobGet.statusCode, 200);
  assert.equal(bobGet.json().noteHasKey, true);
  assert.deepEqual(bobGet.json().wrappedKeys, []);

  // Non-collaborators are still denied.
  const outsider = await makeKeypair();
  await seedAccount('outsider2', outsider.pk);
  const outsiderSession = await createSession('outsider2', {});
  const denied = await get(outsiderSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'forbidden');
});

test('storeRecipients is idempotent and refuses to rotate an existing note key', async () => {
  // note-fresh-key-store already has an envelope for alice; bob is a collaborator.
  const secret = Buffer.from('c'.repeat(64), 'hex');
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(bobSession, '/collaboration/keys/note-fresh-key-store/recipients', {
    recipients: [{ userId: 'bob', wrappedKey: JSON.stringify(bobEnv) }],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().existing, true);
  assert.equal(res.json().stored, 0);
  assert.equal(res.json().noteHasKey, true);

  // Bob's attempted overwrite did not land — still no envelope for bob.
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.deepEqual(bobGet.json().wrappedKeys, []);

  // Alice's original envelope is untouched.
  const aliceGet = await get(aliceSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(JSON.parse(aliceGet.json().wrappedKeys[0].wrappedKey).kemCt, originalAliceKemCt);
});

test('singular recipient refuses to overwrite an existing note key', async () => {
  // note-fresh-key-store already has an envelope for alice (see earlier tests).
  const secret = Buffer.from('d'.repeat(64), 'hex');
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(bobSession, '/collaboration/keys/note-fresh-key-store/recipient', {
    recipientUserId: 'bob',
    wrappedKey: JSON.stringify(bobEnv),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().existing, true);
  assert.equal(res.json().stored, false);
  assert.equal(res.json().noteHasKey, true);

  // Bob's attempted overwrite did not land — still no envelope for bob.
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.deepEqual(bobGet.json().wrappedKeys, []);

  // Alice's original envelope is untouched.
  const aliceGet = await get(aliceSession, '/collaboration/keys/note-fresh-key-store');
  assert.equal(JSON.parse(aliceGet.json().wrappedKeys[0].wrappedKey).kemCt, originalAliceKemCt);
});

test('comments are stored encrypted with mentions filtered to collaborators', async () => {
  const res = await post(aliceSession, '/comments/note-e2e-keys-note-01', {
    contentEncrypted: 'ciphertext',
    contentIv: 'iv',
    mentions: ['bob', 'nokey', 'alice'],
    threadId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(res.statusCode, 201);
  const comment = res.json().comment;
  assert.equal(comment.contentEncrypted, 'ciphertext');
  assert.equal(comment.mentions, '["bob"]');

  const list = await get(bobSession, '/comments/note-e2e-keys-note-01');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().comments[0].contentEncrypted, 'ciphertext');
  assert.ok(!('authorName' in list.json().comments[0]));
});

test('public-keys exposes only keypair\u2019d collaborators and rejects non-collaborators', async () => {
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['note-public-keys', 'alice', 'alice', 'editor', now]
  );
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['note-public-keys', 'bob', 'alice', 'editor', now]
  );
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['note-public-keys', 'nokey', 'alice', 'viewer', now]
  );

  const res = await get(aliceSession, '/collaboration/public-keys/note-public-keys');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.noteId, 'note-public-keys');
  const userMap = new Map(body.collaborators.map((c) => [c.userId, c.kemPublicKey]));
  assert.ok(userMap.has('bob'));
  assert.equal(userMap.get('bob'), bob.pk);
  assert.ok(!userMap.has('nokey'));

  const outsider = await makeKeypair();
  await seedAccount('outsider', outsider.pk);
  const outsiderSession = await createSession('outsider', {});
  const denied = await get(outsiderSession, '/collaboration/public-keys/note-public-keys');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'forbidden');
});
