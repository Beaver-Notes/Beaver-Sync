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
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { hashSessionId } = require('../src/lib/crypto');

const originalMethods = {
  Session: {
    findOne: models.Session.findOne,
    create: models.Session.create,
    updateOne: models.Session.updateOne,
    updateMany: models.Session.updateMany,
    find: models.Session.find,
  },
  Account: {
    findOne: models.Account.findOne,
    findById: models.Account.findById,
  },
};

function resetStubs() {
  models.Session.findOne = async () => null;
  models.Session.create = async (data) => ({ id: 'sess-id', ...data });
  models.Session.updateOne = async () => ({ modifiedCount: 1 });
  models.Session.updateMany = async () => ({ modifiedCount: 0 });
  models.Session.find = () => ({ sort: () => ({ lean: () => ([]) }) });
  models.Account.findOne = async () => null;
  models.Account.findById = () => ({ lean: () => null });
}

test.before(async () => {
  await setupTestDb();
});

test.after(() => {
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(models.Account, originalMethods.Account);
  return close();
});

async function makeApp() {
  resetStubs();
  return buildApp();
}

test('createSession generates a raw session ID and stores a hashed version', async (t) => {
  let created = null;
  models.Session.create = async (data) => {
    created = data;
    return { id: 'sess-id', ...data };
  };

  const rawId = await require('../src/middleware/auth').createSession('user-a', { headers: {}, ip: '192.168.1.1' });

  assert.ok(rawId);
  assert.equal(rawId.length, 43);
  assert.equal(created.accountId, 'user-a');
  assert.equal(created.idHash, hashSessionId(rawId));
  assert.equal(created.revoked, false);
});

test('validateSession returns userId for valid non-revoked non-expired session', async (t) => {
  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  const result = await require('../src/middleware/auth').validateSession(rawId);
  assert.ok(result);
  assert.equal(result.userId, 'user-a');
});

test('validateSession returns null for revoked session', async (t) => {
  const rawId = crypto.randomBytes(32).toString('base64url');

  models.Session.findOne = async () => ({
    idHash: 'revoked-hash',
    accountId: 'user-a',
    revoked: true,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    save: async () => {},
  });

  const result = await require('../src/middleware/auth').validateSession(rawId);
  assert.equal(result, null);
});

test('validateSession returns null for expired session', async (t) => {
  const rawId = crypto.randomBytes(32).toString('base64url');

  models.Session.findOne = async () => ({
    idHash: 'expired-hash',
    accountId: 'user-a',
    revoked: false,
    expiresAt: new Date(Date.now() - 3600_000),
    createdAt: new Date(),
    save: async () => {},
  });

  const result = await require('../src/middleware/auth').validateSession(rawId);
  assert.equal(result, null);
});

test('validateSession returns null for idle session (lastSeenAt older than IDLE_TIMEOUT_HOURS)', async (t) => {
  const rawId = crypto.randomBytes(32).toString('base64url');

  models.Session.findOne = async () => ({
    idHash: 'idle-hash',
    accountId: 'user-a',
    revoked: false,
    expiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    createdAt: new Date(),
    save: async () => {},
  });

  const result = await require('../src/middleware/auth').validateSession(rawId);
  assert.equal(result, null);
});

test('GET /auth/sessions returns only the authenticated users sessions', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);

  models.Session.find = () => ({
    sort: () => ({
      lean: () => [
        { idHash: sessionIdHash, accountId: 'user-a', deviceLabel: 'Mac', ipSubnet: '192.168.1', lastSeenAt: new Date(), createdAt: new Date(), revoked: false },
      ],
    }),
  });

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  const response = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${rawId}` },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, sessionIdHash);
});

test('DELETE /auth/sessions/:id revokes the correct session', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  let saved = false;

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        createdAt: new Date(),
        save: async function () { saved = true; },
      };
    }
    return null;
  };

  models.Session.find = () => ({
    sort: () => ({
      lean: () => [],
    }),
  });

  const response = await app.inject({
    method: 'DELETE',
    url: `/auth/sessions/${sessionIdHash}`,
    headers: { authorization: `Bearer ${rawId}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(saved, true);
});

test('DELETE /auth/sessions/:id returns 403 for another users session', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    if (h === 'other-hash') {
      return {
        idHash: 'other-hash',
        accountId: 'user-b',
        revoked: false,
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  const response = await app.inject({
    method: 'DELETE',
    url: '/auth/sessions/other-hash',
    headers: { authorization: `Bearer ${rawId}` },
  });

  assert.equal(response.statusCode, 403);
});

test('POST /auth/logout invalidates the session', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  let revoked = false;

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  models.Session.updateOne = async (filter, update) => {
    if (filter.idHash === sessionIdHash && (update.revoked === true || update.$set?.revoked === true)) {
      revoked = true;
    }
    return { modifiedCount: 1 };
  };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { authorization: `Bearer ${rawId}` },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(revoked, true);

  models.Session.findOne = async () => null;

  const afterLogout = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${rawId}` },
  });

  assert.equal(afterLogout.statusCode, 401);
});

test('POST /auth/sessions/revoke-all revokes every session except the current one', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  let updateFilter = null;
  let updateData = null;
  models.Session.updateMany = async (filter, update) => {
    updateFilter = filter;
    updateData = update;
    return { modifiedCount: 4 };
  };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/sessions/revoke-all',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rawId}`,
    },
    payload: JSON.stringify({ keepCurrent: true }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.revoked, 4);
  assert.equal(body.keepCurrent, true);
  assert.equal(updateFilter.accountId, 'user-a');
  assert.equal(updateFilter.revoked, false);
  assert.deepEqual(updateFilter.idHash, { $ne: sessionIdHash });
  assert.equal(updateData.$set.revoked, true);
});

test('POST /auth/sessions/revoke-all without keepCurrent revokes every session', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const rawId = crypto.randomBytes(32).toString('base64url');

  models.Session.findOne = async ({ idHash: h }) => {
    if (h === hashSessionId(rawId)) {
      return {
        idHash: h,
        accountId: 'user-a',
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };

  let updateFilter = null;
  models.Session.updateMany = async (filter) => {
    updateFilter = filter;
    return { modifiedCount: 5 };
  };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/sessions/revoke-all',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${rawId}`,
    },
    payload: JSON.stringify({ keepCurrent: false }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.revoked, 5);
  assert.equal(body.keepCurrent, false);
  assert.equal(updateFilter.accountId, 'user-a');
  assert.equal(updateFilter.idHash, undefined);
});

test('POST /auth/sessions/revoke-all rejects unauthenticated requests', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const response = await app.inject({
    method: 'POST',
    url: '/auth/sessions/revoke-all',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({}),
  });

  assert.equal(response.statusCode, 401);
});
