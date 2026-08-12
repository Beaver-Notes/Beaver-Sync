'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcrypt');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db");
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '2';
process.env.ASSET_URL_TTL_SECONDS = '300';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { buildApp } = require('../src/server');
const { signToken } = require('../src/middleware/auth');
const models = require('../src/models');
const r2 = require('../src/services/r2');

const originalMethods = {
  Account: {
    findOne: models.Account.findOne,
    findById: models.Account.findById,
    create: models.Account.create,
    updateOne: models.Account.updateOne,
    deleteOne: models.Account.deleteOne,
  },
  Subscription: {
    findOne: models.Subscription.findOne,
    updateOne: models.Subscription.updateOne,
    findOneAndUpdate: models.Subscription.findOneAndUpdate,
    deleteOne: models.Subscription.deleteOne,
  },
  CommitMeta: {
    find: models.CommitMeta.find,
    findOne: models.CommitMeta.findOne,
    create: models.CommitMeta.create,
    deleteMany: models.CommitMeta.deleteMany,
  },
  Device: {
    find: models.Device.find,
    findOne: models.Device.findOne,
    findOneAndUpdate: models.Device.findOneAndUpdate,
    countDocuments: models.Device.countDocuments,
    deleteOne: models.Device.deleteOne,
    deleteMany: models.Device.deleteMany,
  },
  Session: {
    findOne: models.Session.findOne,
    create: models.Session.create,
    updateOne: models.Session.updateOne,
    find: models.Session.find,
  },
  r2: {
    put: r2.put,
    get: r2.get,
    del: r2.del,
    stat: r2.stat,
    presignGet: r2.presignGet,
    presignPut: r2.presignPut,
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
  models.Account.findOne = async () => null;
  models.Account.findById = () => chain(null);
  models.Account.create = async () => ({ id: 'created-user', emailHmac: 'created-hash', kdfSalt: 'salt' });
  models.Account.updateOne = async () => ({ modifiedCount: 1 });
  models.Account.deleteOne = async () => ({ deletedCount: 1 });

  models.Subscription.findOne = () => chain({
    accountId: 'user-a',
    plan: 'basic',
    status: 'active',
    storageUsedBytes: 0,
    storageQuotaBytes: 4 * 1024 * 1024 * 1024,
  });
  models.Subscription.updateOne = async () => ({ modifiedCount: 1 });
  models.Subscription.findOneAndUpdate = async () => ({ id: 'sub-id', accountId: 'user-a', plan: 'basic', status: 'active' });
  models.Subscription.deleteOne = async () => ({ deletedCount: 1 });

  models.CommitMeta.find = () => chain([]);
  models.CommitMeta.findOne = () => chain(null);
  models.CommitMeta.create = async () => ({ id: 'meta-id' });
  models.CommitMeta.deleteMany = async () => ({ deletedCount: 0 });

  models.Device.find = () => chain([]);
  models.Device.findOne = () => chain(null);
  models.Device.findOneAndUpdate = async () => ({ id: 'dev-id' });
  models.Device.countDocuments = async () => 0;
  models.Device.deleteOne = async () => ({ deletedCount: 1 });
  models.Device.deleteMany = async () => ({ deletedCount: 0 });

  models.Session.findOne = async () => null;
  models.Session.create = async () => ({ id: 'session-id' });
  models.Session.updateOne = async () => ({ modifiedCount: 1 });
  models.Session.find = () => chain([]);

  r2.put = async () => {};
  r2.get = async () => null;
  r2.del = async () => {};
  r2.stat = async () => null;
  r2.presignGet = async () => 'https://signed.example/download';
  r2.presignPut = async () => 'https://signed.example/upload';
}

async function makeApp() {
  resetStubs();
  const app = await buildApp();
  return app;
}

test.after(() => {
  Object.assign(models.Account, originalMethods.Account);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
  Object.assign(models.Device, originalMethods.Device);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(r2, originalMethods.r2);
});

test('unauthorized access to private account route is rejected', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/account',
  });

  assert.equal(response.statusCode, 401);
  assert.match(response.body, /unauthorized/i);
});

test('cross-tenant commit access is rejected with object-level authorization', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let lastCommitQuery = null;
  models.CommitMeta.findOne = (query) => {
    lastCommitQuery = query;
    return chain(query.accountId === 'user-a' && query.commitId === '1700000000000-device-a-1'
      ? { commitId: query.commitId, accountId: query.accountId }
      : null);
  };
  r2.get = async () => Buffer.from('{"enc":"aes256gcm-v1","iv":"aaaaaaaaaaaa","ct":"abc","tag":"bbbbbbbbbbbbbbbbbbbbbbbb"}');

  const response = await app.inject({
    method: 'GET',
    url: '/commits/1700000000000-device-a-1',
    headers: {
      authorization: `Bearer ${signToken('user-b')}`,
    },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(lastCommitQuery.accountId, 'user-b');
});

test('auth endpoint rate limiting throttles repeated login attempts', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const passwordHash = await bcrypt.hash('correct horse battery staple', 4);
  models.Account.findOne = async ({ emailHmac }) => {
    if (!emailHmac) return null;
    return {
      id: 'user-a',
      emailHmac,
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
  };

  const request = {
    method: 'POST',
    url: '/auth/token',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    payload: {
      email: 'user@example.com',
      password: 'correct horse battery staple',
    },
  };

  const first = await app.inject(request);
  const second = await app.inject(request);
  const third = await app.inject(request);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
});

test('oversized asset uploads are rejected before storage work', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let storageTouched = false;
  r2.stat = async () => {
    storageTouched = true;
    return null;
  };

  const response = await app.inject({
    method: 'PUT',
    url: '/assets/file-1',
    headers: {
      authorization: `Bearer ${signToken('user-a')}`,
      'content-type': 'application/octet-stream',
      'content-length': String(101 * 1024 * 1024),
    },
    payload: Buffer.from('tiny'),
  });

  assert.equal(response.statusCode, 413);
  assert.equal(storageTouched, false);
});

test('malformed auth payloads with the wrong content type are rejected early', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: {
      'content-type': 'text/plain',
    },
    payload: 'email=user@example.com&password=test',
  });

  assert.equal(response.statusCode, 415);
});

test('signed download URLs stay tenant-scoped and use short-lived expiry', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let presignArgs = null;
  r2.stat = async (key) => (key === 'user-a/assets/file-1'
    ? { sizeBytes: 123 }
    : null);
  r2.presignGet = async (key, expiresInSeconds) => {
    presignArgs = { key, expiresInSeconds };
    return 'https://signed.example/download';
  };

  const allowed = await app.inject({
    method: 'GET',
    url: '/assets/file-1',
    headers: {
      authorization: `Bearer ${signToken('user-a')}`,
    },
  });

  const denied = await app.inject({
    method: 'GET',
    url: '/assets/file-1',
    headers: {
      authorization: `Bearer ${signToken('user-b')}`,
    },
  });

  assert.equal(allowed.statusCode, 200);
  assert.equal(denied.statusCode, 404);

  const body = allowed.json();
  assert.equal(body.expiresInSeconds, 300);
  assert.equal(presignArgs.key, 'user-a/assets/file-1');
  assert.equal(presignArgs.expiresInSeconds, 300);
});
