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
  QuickConnectCode: {
    findOne: models.QuickConnectCode.findOne,
    create: models.QuickConnectCode.create,
    deleteOne: models.QuickConnectCode.deleteOne,
  },
  Session: {
    findOne: models.Session.findOne,
  },
};

function resetStubs() {
  models.QuickConnectCode.findOne = async () => null;
  models.QuickConnectCode.create = async (data) => ({ code: data?.code, secret: data?.secret, authorized: false, payload: null, ...data });
  models.QuickConnectCode.deleteOne = async () => ({ deletedCount: 1 });
  models.Session.findOne = async () => null;
}

test.before(async () => {
  await setupTestDb();
});

test.after(() => {
  Object.assign(models.QuickConnectCode, originalMethods.QuickConnectCode);
  Object.assign(models.Session, originalMethods.Session);
  return close();
});

async function makeApp() {
  resetStubs();
  return buildApp();
}

async function authHeaderFor(app, userId = 'user-a') {
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

test('initiate returns a code and a secret', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let stored = null;
  models.QuickConnectCode.create = async (data) => { stored = data; return { ...data }; };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/quickconnect/initiate',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.match(body.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  assert.equal(body.secret.length, 64);
  assert.ok(new Date(body.expiresAt) > Date.now());
  assert.equal(stored.authorized, false);
  assert.equal(stored.payload, null);
  assert.equal(stored.secret.length, 64);
});

test('authorize code then connect returns payload', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const code = 'ABC-DEF';
  const secret = crypto.randomBytes(32).toString('hex');
  const testPayload = 'session-token-xyz';

  let qcDoc = {
    code,
    secret,
    authorized: false,
    payload: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    save: async function () {},
  };

  models.QuickConnectCode.findOne = async (filter) => {
    if (filter.code === code || filter.secret === secret) return qcDoc;
    return null;
  };

  const auth = await authHeaderFor(app, 'user-a');

  const authorizeResponse = await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: auth },
    payload: { payload: testPayload },
  });

  assert.equal(authorizeResponse.statusCode, 200);
  assert.equal(authorizeResponse.json().authorized, true);
  assert.equal(qcDoc.authorized, true);
  assert.equal(qcDoc.payload, testPayload);

  let deleted = false;
  models.QuickConnectCode.deleteOne = async (filter) => {
    if (filter.secret === secret || filter.code === code) deleted = true;
    return { deletedCount: 1 };
  };

  const connectResponse = await app.inject({
    method: 'GET',
    url: `/auth/quickconnect/connect?secret=${secret}`,
  });

  assert.equal(connectResponse.statusCode, 200);
  const connectBody = connectResponse.json();
  assert.equal(connectBody.authorized, true);
  assert.equal(connectBody.payload, testPayload);
  assert.equal(deleted, true);
});

test('connect without secret returns 400', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/auth/quickconnect/connect',
  });

  assert.equal(response.statusCode, 400);
});

test('connect with unknown secret returns 404', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/auth/quickconnect/connect?secret=unknown',
  });

  assert.equal(response.statusCode, 404);
});

test('connect with expired code returns 404', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const secret = crypto.randomBytes(32).toString('hex');
  models.QuickConnectCode.findOne = async (filter) => {
    if (filter.secret === secret) {
      return { code: 'ABC-DEF', secret, authorized: false, expiresAt: new Date(Date.now() - 1000) };
    }
    return null;
  };

  const response = await app.inject({
    method: 'GET',
    url: `/auth/quickconnect/connect?secret=${secret}`,
  });

  assert.equal(response.statusCode, 404);
});

test('authorizing already-authorized code returns 409', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const code = 'ABC-DEF';
  models.QuickConnectCode.findOne = async () => ({
    code,
    secret: crypto.randomBytes(32).toString('hex'),
    authorized: true,
    payload: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const auth = await authHeaderFor(app, 'user-a');

  const response = await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: auth },
    payload: {},
  });

  assert.equal(response.statusCode, 409);
});
