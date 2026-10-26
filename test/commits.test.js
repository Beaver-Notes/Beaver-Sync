'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { close, query } = require('../src/db');
const { setupTestDb } = require('./helpers/db');
const { authHeaderFor } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const r2 = require('../src/services/r2');
const { hashSessionId, createNoteHash } = require('../src/lib/crypto');
const mlkem = require('../src/lib/mlkem');

const originalMethods = {
  CommitMeta: {
    findOne: models.CommitMeta.findOne,
    create: models.CommitMeta.create,
  },
  Subscription: {
    findOne: models.Subscription.findOne,
    updateOne: models.Subscription.updateOne,
  },
  Device: {
    findOne: models.Device.findOne,
    findOneAndUpdate: models.Device.findOneAndUpdate,
    countDocuments: models.Device.countDocuments,
  },
  Session: {
    findOne: models.Session.findOne,
  },
  r2: {
    put: r2.put,
    get: r2.get,
  },
};

function chain(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: () => value,
  };
}

function resetStubs() {
  models.CommitMeta.findOne = () => chain(null);
  models.CommitMeta.create = async () => ({ id: 'meta-id' });
  models.Subscription.findOne = () => chain({
    accountId: '507f1f77bcf86cd799439011',
    plan: 'starter',
    status: 'active',
    storageUsedBytes: 0,
    storageQuotaBytes: 4 * 1024 * 1024 * 1024,
  });
  models.Subscription.updateOne = async () => ({ modifiedCount: 1 });
  models.Device.findOne = () => chain(null);
  models.Device.findOneAndUpdate = async () => ({ id: 'dev-id' });
  models.Device.countDocuments = async () => 0;
  models.Session.findOne = async () => null;
  r2.put = async () => {};
  r2.get = async () => null;
}

test.before(async () => {
  await setupTestDb();
});

test.after(() => {
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);
  return close();
});

async function makeApp() {
  resetStubs();
  return buildApp();
}

test('plaintext payload string is rejected with 400', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const auth = await authHeaderFor();

  const response = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
      'x-device-id': 'device_a',
    },
    payload: JSON.stringify({
      id: '1700000000000-device_a-1',
      deviceId: 'device_a',
      clock: 1,
      ts: 1700000000000,
      payload: 'this is a raw string',
    }),
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error, 'validation_error');
});

test('valid aes256gcm-v1 envelope is accepted', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  let storedPayload = null;
  r2.put = async (key, body) => { storedPayload = body.toString('utf8'); };

  const auth = await authHeaderFor();

  const response = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
      'x-device-id': 'device_a',
    },
    payload: JSON.stringify({
      id: '1700000000000-device_a-1',
      deviceId: 'device_a',
      clock: 1,
      ts: 1700000000000,
      payload: {
        v: 3,
        nonce: 'aaaaaaaaaaaaaaaa',
        cipher: 'encrypteddata',
      },
    }),
  });

  assert.equal(response.statusCode, 201);
  const unwrapped = await mlkem.unwrapBlob(Buffer.from(storedPayload, 'utf8'));
  const stored = JSON.parse(unwrapped.toString('utf8'));
  assert.equal(stored.v, 3);
  assert.equal(stored.cipher, 'encrypteddata');
});

test('real POST /commits inserts commit metadata and serves it through list + history (no mocks)', async (t) => {
  // Reinstall the real model/r2 methods (the other tests in this file stub
  // them): this test exercises the actual commits table insert end-to-end.
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);

  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY)
      .update(`it-${crypto.randomBytes(6).toString('hex')}@test.example`).digest('hex'),
    emailSealed: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
  await models.Subscription.create({
    accountId: account.id, plan: 'pro', status: 'active',
    storageQuotaBytes: 50 * 1024 ** 3, storageUsedBytes: 0, createdAt: new Date(),
  });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  await models.Session.create({
    idHash: sessionIdHash, accountId: account.id, deviceLabel: 'it',
    deviceId: 'device_it', ipSubnet: '127.0.0.1',
    expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date(),
    revoked: false, createdAt: new Date(),
  });

  let storedKey = null;
  r2.put = async (key) => { storedKey = key; };

  const noteId = `integration-note-${crypto.randomBytes(4).toString('hex')}`;
  const noteIdHash = createNoteHash(noteId);
  const ts = Date.now();
  const commitId = `${ts}-device_it-1`;

  const post = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rawId}`,
      'x-device-id': 'device_it',
      'x-note-id': noteId,
    },
    payload: JSON.stringify({
      id: commitId,
      deviceId: 'device_it',
      clock: 1,
      ts,
      payload: { v: 3, nonce: 'aaaaaaaaaaaaaaaa', cipher: 'encrypteddata' },
    }),
  });
  assert.equal(post.statusCode, 201);
  assert.ok(storedKey, 'payload should be written to object storage');

  const meta = await models.CommitMeta.findOne({ commitId, accountId: account.id }).lean();
  assert.ok(meta, 'commit metadata row should exist');
  assert.equal(meta.commitId, commitId);
  assert.equal(meta.noteIdHash, noteIdHash);

  const historyRes = await app.inject({
    method: 'GET',
    url: `/commits/history?noteId=${encodeURIComponent(noteId)}`,
    headers: { authorization: `Bearer ${rawId}` },
  });
  assert.equal(historyRes.statusCode, 200);
  const history = historyRes.json().commits;
  assert.equal(history.length, 1);
  assert.equal(history[0].commitid, commitId);

  const listRes = await app.inject({
    method: 'GET',
    url: '/commits',
    headers: { authorization: `Bearer ${rawId}` },
  });
  assert.equal(listRes.statusCode, 200);
  const list = listRes.json().commits;
  assert.equal(list.length, 1);
  assert.equal(list[0].commitId, commitId);

  await models.Device.deleteOne({ accountId: account.id });
  await models.CommitMeta.deleteMany({ accountId: account.id });
  await models.AuditLog.deleteMany({ accountIdHash: hashSessionId(account.id) });
  await models.Subscription.deleteOne({ accountId: account.id });
  await models.Session.deleteMany({ accountId: account.id });
  await models.Account.deleteOne({ _id: account.id });
});

test('envelope missing cipher is rejected with 400', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const auth = await authHeaderFor();

  const response = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
      'x-device-id': 'device_a',
    },
    payload: JSON.stringify({
      id: '1700000000000-device_a-1',
      deviceId: 'device_a',
      clock: 1,
      ts: 1700000000000,
      payload: {
        v: 3,
        nonce: 'aaaaaaaaaaaa',
      },
    }),
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error, 'validation_error');
});

test('v5 envelope string with dashed UUID deviceId is accepted', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  let storedPayload = null;
  r2.put = async (key, body) => { storedPayload = body.toString('utf8'); };

  const auth = await authHeaderFor();
  const deviceId = '123e4567-e89b-12d3-a456-426614174000';
  const ts = 1700000000000;
  const clock = 7;
  const commitId = `${ts}-${deviceId}-${clock}`;
  const envelope = JSON.stringify({
    v: 5,
    meta: { noteId: 'note-1', clock: 1 },
    iv: 'aXYivbase64',
    enc: 'cipherbase64',
  });

  const response = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
      'x-device-id': deviceId,
    },
    payload: JSON.stringify({ id: commitId, deviceId, clock, ts, payload: envelope }),
  });

  assert.equal(response.statusCode, 201);
  const unwrapped = await mlkem.unwrapBlob(Buffer.from(storedPayload, 'utf8'));
  assert.equal(unwrapped.toString('utf8'), envelope);
});

test('GET /:id returns a stored v5 envelope string as-is', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const deviceId = '123e4567-e89b-12d3-a456-426614174000';
  const commitId = `1700000000000-${deviceId}-7`;
  const envelope = JSON.stringify({ v: 5, meta: {}, iv: 'x', enc: 'y' });
  const blob = await mlkem.wrapBlob(Buffer.from(envelope, 'utf8'));

  models.CommitMeta.findOne = () => chain({ commitId, accountId: '507f1f77bcf86cd799439011' });
  r2.get = async () => blob;

  const auth = await authHeaderFor();
  const response = await app.inject({
    method: 'GET',
    url: `/commits/${commitId}`,
    headers: { authorization: auth },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json(), envelope);
});

test('shared note history is visible to every workspace member, and hidden from non-members', async (t) => {
  // Real model/r2 methods: this test exercises the actual membership query.
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);

  const { register, authHeaders } = require('./helpers/factory');

  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const workspaceId = `ws-${crypto.randomUUID()}`;
  const noteId = `shared-note-${crypto.randomBytes(4).toString('hex')}`;

  const owner = await register('pro');
  const member = await register('pro');
  const outsider = await register('pro');
  // The commit body plus envelope must fit the storage quota.
  await query('UPDATE subscriptions SET storage_quota_bytes = 50000000000 WHERE account_id = $1', [owner.id]);

  await models.Workspace.create({ id: workspaceId, nameEncrypted: 'n', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId, accountId: owner.id, role: 'owner', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId, accountId: member.id, role: 'editor', createdAt: new Date() });
  // The note is "owned" by the workspace through its journal row.
  await query(
    `INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
    [crypto.randomUUID(), workspaceId, noteId, Buffer.from('x'), 'device_owner', 1, Date.now(), new Date().toISOString()]
  );

  const ownerHeaders = await authHeaders(owner.id);
  const memberHeaders = await authHeaders(member.id);
  const outsiderHeaders = await authHeaders(outsider.id);

  let storedKey = null;
  r2.put = async (key) => { storedKey = key; };

  const ts = Date.now();
  const commitId = `${ts}-device_owner-1`;
  const post = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: { ...ownerHeaders, 'x-device-id': 'device_owner', 'x-note-id': noteId },
    payload: JSON.stringify({
      id: commitId,
      deviceId: 'device_owner',
      clock: 1,
      ts,
      payload: { v: 3, nonce: 'aaaaaaaaaaaaaaaa', cipher: 'encrypteddata' },
    }),
  });
  assert.equal(post.statusCode, 201);
  assert.equal(storedKey, r2.commitKey(owner.id, commitId));

  // A workspace member sees the owner's commit, not only their own.
  const memberHistory = await app.inject({
    method: 'GET',
    url: `/commits/history?noteId=${encodeURIComponent(noteId)}`,
    headers: memberHeaders,
  });
  assert.equal(memberHistory.statusCode, 200);
  const memberCommits = memberHistory.json().commits;
  assert.equal(memberCommits.length, 1);
  assert.equal(memberCommits[0].commitid, commitId);

  // ...and can fetch the owner's blob (stored under the owner's prefix).
  const envelope = JSON.stringify({ v: 5, meta: {}, iv: 'x', enc: 'y' });
  const blob = await mlkem.wrapBlob(Buffer.from(envelope, 'utf8'));
  let requestedKey = null;
  r2.get = async (key) => { requestedKey = key; return blob; };

  const memberGet = await app.inject({
    method: 'GET',
    url: `/commits/${commitId}`,
    headers: { ...memberHeaders, 'x-note-id': noteId },
  });
  assert.equal(memberGet.statusCode, 200);
  assert.equal(requestedKey, r2.commitKey(owner.id, commitId));
  // GET /commits/:id returns the envelope as a JSON string (see the client's
  // getCommitSnapshot), not as a parsed object.
  assert.equal(memberGet.json(), envelope);

  // A non-member sees no history and cannot fetch the blob.
  const outsiderHistory = await app.inject({
    method: 'GET',
    url: `/commits/history?noteId=${encodeURIComponent(noteId)}`,
    headers: outsiderHeaders,
  });
  assert.equal(outsiderHistory.statusCode, 200);
  assert.equal(outsiderHistory.json().commits.length, 0);

  const outsiderGet = await app.inject({
    method: 'GET',
    url: `/commits/${commitId}`,
    headers: { ...outsiderHeaders, 'x-note-id': noteId },
  });
  assert.equal(outsiderGet.statusCode, 404);
});

test('a concurrent duplicate commit retry returns already_exists, not a 500', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  // Simulate losing the check-then-insert race: the pre-check sees nothing and
  // the insert hits the primary key.
  const pkConflict = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  models.CommitMeta.create = async () => { throw pkConflict; };

  const auth = await authHeaderFor();
  const response = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: { 'content-type': 'application/json', authorization: auth, 'x-device-id': 'device_a' },
    payload: JSON.stringify({
      id: '1700000000000-device_a-1',
      deviceId: 'device_a',
      clock: 1,
      ts: 1700000000000,
      payload: { v: 3, nonce: 'aaaaaaaaaaaaaaaa', cipher: 'encrypteddata' },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { commitId: '1700000000000-device_a-1', status: 'already_exists' });
});

test('a foreign-account commit-id collision is a conflict, not a silent already_exists', async (t) => {
  // Real model/r2 methods: this test exercises the actual primary-key collision.
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);

  const { register, authHeaders } = require('./helpers/factory');
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await register('pro');
  const squatter = await register('pro');
  await query('UPDATE subscriptions SET storage_quota_bytes = 50000000000 WHERE account_id = $1', [owner.id]);
  await query('UPDATE subscriptions SET storage_quota_bytes = 50000000000 WHERE account_id = $1', [squatter.id]);

  const ownerHeaders = await authHeaders(owner.id);
  const squatterHeaders = await authHeaders(squatter.id);
  r2.put = async () => {};

  const ts = Date.now();
  const commitId = `${ts}-device_owner-1`;
  const payload = JSON.stringify({
    id: commitId,
    deviceId: 'device_owner',
    clock: 1,
    ts,
    payload: { v: 3, nonce: 'aaaaaaaaaaaaaaaa', cipher: 'encrypteddata' },
  });

  const first = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: { ...ownerHeaders, 'x-device-id': 'device_owner' },
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);

  // The squatter reuses the owner's globally-unique commit id. It must NOT be
  // told "already_exists": no row was written for the squatter, and a false
  // success would silently drop their commit.
  const collision = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: { ...squatterHeaders, 'x-device-id': 'device_owner' },
    payload,
  });
  assert.equal(collision.statusCode, 409, collision.body);
  assert.notEqual(collision.json().status, 'already_exists');

  // The owner's commit row is untouched and still theirs.
  const { rows } = await query('SELECT account_id FROM commits WHERE commit_id = $1', [commitId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, owner.id);

  // The owner's genuine idempotent retry stays a success.
  const retry = await app.inject({
    method: 'POST',
    url: '/commits',
    headers: { ...ownerHeaders, 'x-device-id': 'device_owner' },
    payload,
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().status, 'already_exists');
});
