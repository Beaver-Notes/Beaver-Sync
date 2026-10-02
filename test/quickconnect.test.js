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

test('initiate returns a code and a secret', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

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
  assert.notEqual(stored.secret, body.secret, 'the row must hold the HMAC, not the redeemable secret');
  assert.equal(stored.secret, hashSessionId(`quickconnect:${body.secret}`));
});

test('authorize code then connect returns payload', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const code = 'ABC-DEF';
  const secret = crypto.randomBytes(32).toString('hex');
  const testPayload = 'session-token-xyz';

  const secretHash = hashSessionId(`quickconnect:${secret}`);
  let qcDoc = {
    code,
    secret: secretHash,
    authorized: false,
    payload: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    save: async function () {},
  };

  models.QuickConnectCode.findOne = async (filter) => {
    if (filter.code === code || filter.secret === secretHash) return qcDoc;
    return null;
  };

  const auth = await authHeaderFor('user-a');

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
    if (filter.secret === secretHash || filter.code === code) deleted = true;
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
  t.after(async () => { await app.close(); });

  const response = await app.inject({
    method: 'GET',
    url: '/auth/quickconnect/connect',
  });

  assert.equal(response.statusCode, 400);
});

test('connect with unknown secret returns 404', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  const response = await app.inject({
    method: 'GET',
    url: '/auth/quickconnect/connect?secret=unknown',
  });

  assert.equal(response.statusCode, 404);
});

test('connect with expired code returns 404', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

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
  t.after(async () => { await app.close(); });

  const code = 'ABC-DEF';
  models.QuickConnectCode.findOne = async () => ({
    code,
    secret: crypto.randomBytes(32).toString('hex'),
    authorized: true,
    payload: null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const auth = await authHeaderFor('user-a');

  const response = await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: auth },
    payload: {},
  });

  assert.equal(response.statusCode, 409);
});

test('the redeemable pairing secret is never stored in the clear', async (t) => {
  const app = await makeApp();
  t.after(async () => { await app.close(); });

  let stored = null;
  let lookup = null;
  models.QuickConnectCode.create = async (data) => { stored = data; return { ...data }; };
  models.QuickConnectCode.findOne = async (q) => {
    lookup = q;
    return { code: 'ABC-DEF', secret: q.secret, authorized: false, payload: null, expiresAt: new Date(Date.now() + 600000) };
  };

  const init = await app.inject({
    method: 'POST',
    url: '/auth/quickconnect/initiate',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(init.statusCode, 201);
  const { secret } = init.json();

  assert.notEqual(
    stored.secret, secret,
    'the quick_connect_codes row must not hold the redeemable secret: a database read must never hand over a live pairing secret, and the column is UNIQUE-indexed in the clear');
  assert.equal(
    stored.secret, hashSessionId(`quickconnect:${secret}`),
    'the stored value must be the HMAC that the connect path looks up, or the secret stops working');

  const poll = await app.inject({ method: 'GET', url: `/auth/quickconnect/connect?secret=${secret}` });
  assert.equal(poll.statusCode, 200, 'polling with the plaintext secret must still resolve');
  assert.deepEqual(lookup, { secret: hashSessionId(`quickconnect:${secret}`) }, 'connect must find the row by hash');
});
