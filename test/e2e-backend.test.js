'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, '.test-data', 'e2e-backend-test.db');
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = dbPath;
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { getDb, close } = require('../src/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { createMlKem768 } = require('mlkem');
const { wrapForRecipient } = require('../src/lib/recipient-wrap');

const now = new Date().toISOString();

function seedAccount(id, kemPublicKey = null) {
  const db = getDb();
  db.prepare(
    'INSERT INTO accounts (id, username, email_hmac, created_at, kem_public_key) VALUES (?, ?, ?, ?, ?)'
  ).run(id, id, `${id}-email`, now, kemPublicKey);
}

function seedWorkspace(id, ownerId) {
  const db = getDb();
  db.prepare('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, 'cipher', ownerId, now);
  db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, 'owner', now);
  db.prepare('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${ownerId}-sub`, ownerId, 'pro', 'active', 1000000, 0, now);
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
  alice = await makeKeypair();
  bob = await makeKeypair();

  seedAccount('alice', alice.pk);
  seedAccount('bob', bob.pk);
  seedAccount('nokey', null);
  seedWorkspace('ws-1', 'alice');

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
  const res = await post(aliceSession, '/collaboration/invite/note-1', { username: 'nokey' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('stores recipient envelopes and returns only the caller\u2019s own', async () => {
  await post(aliceSession, '/collaboration/invite/note-1', { username: 'bob' });

  const secret = Buffer.from('a'.repeat(64), 'hex');
  const aliceEnv = await wrapForRecipient(alice.pk, secret);
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(aliceSession, '/collaboration/keys/note-1/recipients', {
    recipients: [
      { userId: 'alice', wrappedKey: JSON.stringify(aliceEnv) },
      { userId: 'bob', wrappedKey: JSON.stringify(bobEnv) },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stored, 2);
  assert.equal(res.json().noteHasKey, true);
  assert.equal(res.json().existing, false);

  const aliceGet = await get(aliceSession, '/collaboration/keys/note-1');
  assert.equal(aliceGet.statusCode, 200);
  assert.equal(aliceGet.json().noteHasKey, true);
  const parsed = JSON.parse(aliceGet.json().wrappedKey);
  assert.equal(parsed.kemCt, aliceEnv.kemCt);

  const bobGet = await get(bobSession, '/collaboration/keys/note-1');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.equal(JSON.parse(bobGet.json().wrappedKey).kemCt, bobEnv.kemCt);
});

test('GET /keys/:noteId reports noteHasKey for fresh notes and late joiners', async () => {
  // Fresh note: no envelopes yet, but the caller must be a collaborator first.
  let fresh = await get(aliceSession, '/collaboration/keys/note-fresh');
  assert.equal(fresh.statusCode, 403);
  assert.equal(fresh.json().error, 'forbidden');
  await post(aliceSession, '/collaboration/invite/note-fresh', { username: 'alice' }).catch(() => {});

  fresh = await get(aliceSession, '/collaboration/keys/note-fresh');
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.json().noteHasKey, false);
  assert.equal(fresh.json().wrappedKey, null);

  // Seed an envelope for alice only.
  const secret = Buffer.from('b'.repeat(64), 'hex');
  const aliceEnv = await wrapForRecipient(alice.pk, secret);
  originalAliceKemCt = aliceEnv.kemCt;
  const store = await post(aliceSession, '/collaboration/keys/note-fresh/recipients', {
    recipients: [{ userId: 'alice', wrappedKey: JSON.stringify(aliceEnv) }],
  });
  assert.equal(store.statusCode, 200);
  assert.equal(store.json().existing, false);

  // Late joiner with no envelope still learns the note already has a key.
  await post(aliceSession, '/collaboration/invite/note-fresh', { username: 'bob' });
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh');
  assert.equal(bobGet.statusCode, 200);
  assert.equal(bobGet.json().noteHasKey, true);
  assert.equal(bobGet.json().wrappedKey, null);

  // Non-collaborators are still denied.
  const outsider = await makeKeypair();
  seedAccount('outsider2', outsider.pk);
  const outsiderSession = await createSession('outsider2', {});
  const denied = await get(outsiderSession, '/collaboration/keys/note-fresh');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'forbidden');
});

test('storeRecipients is idempotent and refuses to rotate an existing note key', async () => {
  // note-fresh already has an envelope for alice; bob is a collaborator.
  const secret = Buffer.from('c'.repeat(64), 'hex');
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(bobSession, '/collaboration/keys/note-fresh/recipients', {
    recipients: [{ userId: 'bob', wrappedKey: JSON.stringify(bobEnv) }],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().existing, true);
  assert.equal(res.json().stored, 0);
  assert.equal(res.json().noteHasKey, true);

  // Bob's attempted overwrite did not land — still no envelope for bob.
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.equal(bobGet.json().wrappedKey, null);

  // Alice's original envelope is untouched.
  const aliceGet = await get(aliceSession, '/collaboration/keys/note-fresh');
  assert.equal(JSON.parse(aliceGet.json().wrappedKey).kemCt, originalAliceKemCt);
});

test('singular recipient refuses to overwrite an existing note key', async () => {
  // note-fresh already has an envelope for alice (see earlier tests).
  const secret = Buffer.from('d'.repeat(64), 'hex');
  const bobEnv = await wrapForRecipient(bob.pk, secret);
  const res = await post(bobSession, '/collaboration/keys/note-fresh/recipient', {
    recipientUserId: 'bob',
    wrappedKey: JSON.stringify(bobEnv),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().existing, true);
  assert.equal(res.json().stored, false);
  assert.equal(res.json().noteHasKey, true);

  // Bob's attempted overwrite did not land — still no envelope for bob.
  const bobGet = await get(bobSession, '/collaboration/keys/note-fresh');
  assert.equal(bobGet.json().noteHasKey, true);
  assert.equal(bobGet.json().wrappedKey, null);

  // Alice's original envelope is untouched.
  const aliceGet = await get(aliceSession, '/collaboration/keys/note-fresh');
  assert.equal(JSON.parse(aliceGet.json().wrappedKey).kemCt, originalAliceKemCt);
});

test('comments are stored encrypted with mentions filtered to collaborators', async () => {
  const res = await post(aliceSession, '/comments/note-1', {
    contentEncrypted: 'ciphertext',
    contentIv: 'iv',
    mentions: ['bob', 'nokey', 'alice'],
    threadId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(res.statusCode, 201);
  const comment = res.json().comment;
  assert.equal(comment.contentEncrypted, 'ciphertext');
  assert.equal(comment.mentions, '["bob"]');

  const list = await get(bobSession, '/comments/note-1');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().comments[0].contentEncrypted, 'ciphertext');
  assert.ok(!('authorName' in list.json().comments[0]));
});

test('public-keys exposes only keypair\u2019d collaborators and rejects non-collaborators', async () => {
  const db = getDb();
  const ins = db.prepare(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  ins.run('note-pub', 'alice', 'alice', 'editor', now);
  ins.run('note-pub', 'bob', 'alice', 'editor', now);
  ins.run('note-pub', 'nokey', 'alice', 'viewer', now);

  const res = await get(aliceSession, '/collaboration/public-keys/note-pub');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.noteId, 'note-pub');
  const userMap = new Map(body.collaborators.map((c) => [c.userId, c.kemPublicKey]));
  assert.ok(userMap.has('bob'));
  assert.equal(userMap.get('bob'), bob.pk);
  assert.ok(!userMap.has('nokey'));

  const outsider = await makeKeypair();
  seedAccount('outsider', outsider.pk);
  const outsiderSession = await createSession('outsider', {});
  const denied = await get(outsiderSession, '/collaboration/public-keys/note-pub');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'forbidden');
});
