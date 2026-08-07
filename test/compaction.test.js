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

const originalMethods = {
  CompactionLock: {
    findOneAndUpdate: models.CompactionLock.findOneAndUpdate,
    deleteOne: models.CompactionLock.deleteOne,
  },
  Subscription: {
    findOne: models.Subscription.findOne,
    updateOne: models.Subscription.updateOne,
  },
  CommitMeta: {
    find: models.CommitMeta.find,
    deleteMany: models.CommitMeta.deleteMany,
  },
  Device: {
    findOneAndUpdate: models.Device.findOneAndUpdate,
    countDocuments: models.Device.countDocuments,
  },
  Session: {
    findOne: models.Session.findOne,
  },
  r2: {
    put: r2.put,
    stat: r2.stat,
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
  models.CompactionLock.findOneAndUpdate = async () => null;
  models.CompactionLock.deleteOne = async () => ({ deletedCount: 1 });
  models.Subscription.findOne = () => chain({
    accountId: '507f1f77bcf86cd799439011',
    plan: 'basic',
    status: 'active',
    storageUsedBytes: 0,
    storageQuotaBytes: 4 * 1024 * 1024 * 1024,
  });
  models.Subscription.updateOne = async () => ({ modifiedCount: 1 });
  models.CommitMeta.find = () => chain([]);
  models.CommitMeta.deleteMany = async () => ({ deletedCount: 0 });
  models.Device.findOneAndUpdate = async () => ({ id: 'dev-id' });
  models.Device.countDocuments = async () => 0;
  models.Session.findOne = async () => null;
  r2.put = async () => {};
  r2.stat = async () => null;
}

test.after(() => {
  Object.assign(models.CompactionLock, originalMethods.CompactionLock);
  Object.assign(models.Subscription, originalMethods.Subscription);
  Object.assign(models.CommitMeta, originalMethods.CommitMeta);
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

test('concurrent compaction requests: first succeeds, second returns 409', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let locked = false;
  models.CompactionLock.findOneAndUpdate = () => {
    if (locked) return null;
    locked = true;
    return { id: '507f1f77bcf86cd799439011', lockedAt: new Date(), expiresAt: new Date(Date.now() + 300_000) };
  };

  const auth = await authHeaderFor(app);

  const first = await app.inject({
    method: 'POST',
    url: '/snapshot',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    payload: JSON.stringify({ snapshot: 'data' }),
  });

  const second = await app.inject({
    method: 'POST',
    url: '/snapshot',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    payload: JSON.stringify({ snapshot: 'data' }),
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'compaction_in_progress');
});

test('lock is released after compaction completes', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let deleted = false;
  models.CompactionLock.findOneAndUpdate = async () => ({
    id: '507f1f77bcf86cd799439011',
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 300_000),
  });
  models.CompactionLock.deleteOne = async () => {
    deleted = true;
    return { deletedCount: 1 };
  };

  const auth = await authHeaderFor(app);

  const response = await app.inject({
    method: 'POST',
    url: '/snapshot',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    payload: JSON.stringify({ snapshot: 'data' }),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(deleted, true);
});
