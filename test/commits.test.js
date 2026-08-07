'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(repoRoot, '.test-data', 'test.db');
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { buildApp } = require('../src/server');
const models = require('../src/models');
const r2 = require('../src/services/r2');
const { hashSessionId } = require('../src/lib/crypto');
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
    plan: 'basic',
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

test.after(() => {
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);
});

async function makeApp() {
  resetStubs();
  return buildApp();
}

async function authHeaderFor(app, userId = '507f1f77bcf86cd799439011') {
  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: userId,
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  return `Bearer ${rawId}`;
}

test('plaintext payload string is rejected with 400', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const auth = await authHeaderFor(app);

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
  t.after(() => app.close());

  let storedPayload = null;
  r2.put = async (key, body) => { storedPayload = body.toString('utf8'); };

  const auth = await authHeaderFor(app);

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

test('envelope missing cipher is rejected with 400', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const auth = await authHeaderFor(app);

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
