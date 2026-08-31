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

const { close } = require('../src/db');
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
    emailEncrypted: 'e',
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
