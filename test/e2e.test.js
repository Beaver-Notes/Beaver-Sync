'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-e2e';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long-e2e';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { QuickConnectCode, Account, WebAuthnChallenge, Credential } = require('../src/models');
const { createEmailHash } = require('../src/lib/crypto');

// Mock @simplewebauthn/server so passkey routes work without a browser
let credCounter = 0;
const swaMock = {
  generateRegistrationOptions: async () => ({ challenge: 'test-challenge-1' }),
  verifyRegistrationResponse: async () => {
    credCounter++;
    return {
      verified: true,
      registrationInfo: {
        credential: { id: `cred-${credCounter}`, publicKey: Buffer.from('public-key-bytes'), counter: 0 },
      },
    };
  },
  generateAuthenticationOptions: async (opts) => ({
    challenge: 'test-challenge-2',
    allowCredentials: opts?.allowCredentials || [],
  }),
  verifyAuthenticationResponse: async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  }),
};
const swaPath = require.resolve('@simplewebauthn/server');
require.cache[swaPath] = { id: swaPath, filename: swaPath, loaded: true, exports: swaMock };

const { buildApp } = require('../src/server');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  close();
});

test('POST /auth/register creates a new account and returns a session token', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'super-secure-password-123' },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.token, 'should return a session token');
  assert.ok(body.user.id, 'should return a user id');
  assert.equal(body.user.emailHash.length, 64, 'emailHash should be a SHA-256 HMAC hex string');
});

test('POST /auth/register rejects duplicate email', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'another-password-123' },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'registration_failed');
});

test('POST /auth/register validates email and password requirements', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const noEmail = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'not-an-email', password: 'password12345678' },
  });
  assert.equal(noEmail.statusCode, 400);

  const shortPw = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'bob@example.com', password: 'short' },
  });
  assert.equal(shortPw.statusCode, 400);
});

test('POST /auth/token logs in with correct credentials', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'super-secure-password-123' },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.token, 'should return a session token');
  assert.ok(body.user.id, 'should return user info');
});

test('POST /auth/token rejects wrong password', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'wrong-password-here' },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_credentials');
});

test('POST /auth/token rejects unknown email', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'nonexistent@example.com', password: 'some-password-123' },
  });

  assert.equal(res.statusCode, 401);
});

test('GET /auth/sessions returns sessions for authenticated user', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'super-secure-password-123' },
  });
  const token = login.json().token;

  const res = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  const sessions = res.json();
  assert.ok(Array.isArray(sessions));
  assert.ok(sessions.length >= 1);
});

test('POST /auth/logout revokes session', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/auth/token',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'alice@example.com', password: 'super-secure-password-123' },
  });
  const token = login.json().token;

  const logout = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(logout.statusCode, 200);

  const after = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(after.statusCode, 401);
});

test('GET /health returns ok with db connected', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'connected');
});

// ---------------------------------------------------------------------------
// QuickConnect e2e tests (real SQLite)
// ---------------------------------------------------------------------------

test('quickconnect: initiate stores code and secret in SQLite', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/auth/quickconnect/initiate',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  assert.equal(body.secret.length, 64);
  assert.ok(new Date(body.expiresAt) > Date.now());

  const stored = await QuickConnectCode.findOne({ code: body.code });
  assert.ok(stored);
  assert.equal(stored.authorized, 0);
  assert.equal(stored.payload, null);
  assert.equal(stored.secret.length, 64);
});

test('quickconnect: full flow initiate → authorize → connect', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `qc-flow-${suffix}@example.com`;
  const password = 'test-password-12345678';

  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
  assert.equal(reg.statusCode, 201);
  const token = reg.json().token;

  const init = await app.inject({
    method: 'POST',
    url: '/auth/quickconnect/initiate',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(init.statusCode, 201);
  const { code, secret } = init.json();

  const testPayload = 'session-token-from-app';

  const authorize = await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: { payload: testPayload },
  });
  assert.equal(authorize.statusCode, 200);
  assert.equal(authorize.json().authorized, true);

  const stored = await QuickConnectCode.findOne({ code });
  assert.ok(stored);
  assert.equal(stored.authorized, 1);
  assert.equal(stored.payload, testPayload);

  const connect = await app.inject({
    method: 'GET',
    url: `/auth/quickconnect/connect?secret=${secret}`,
  });
  assert.equal(connect.statusCode, 200);
  const connectBody = connect.json();
  assert.equal(connectBody.authorized, true);
  assert.equal(connectBody.payload, testPayload);

  const connect2 = await app.inject({
    method: 'GET',
    url: `/auth/quickconnect/connect?secret=${secret}`,
  });
  assert.equal(connect2.statusCode, 404);
});

test('quickconnect: authorize already-authorized code returns 409', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `qc-conflict-${suffix}@example.com`;
  const password = 'test-password-12345678';

  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password },
  });
  const token = reg.json().token;

  const init = await app.inject({
    method: 'POST',
    url: '/auth/quickconnect/initiate',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  const code = init.json().code;

  await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {},
  });

  const res = await app.inject({
    method: 'POST',
    url: `/auth/quickconnect/authorize/${code}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {},
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'already_authorized');
});

test('quickconnect: connect with unknown secret returns 404', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'GET',
    url: '/auth/quickconnect/connect?secret=unknown',
  });
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Passkey e2e tests (real SQLite, mocked WebAuthn)
// ---------------------------------------------------------------------------

test('passkey: register begin stores challenge in SQLite', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const emailHash = createEmailHash(email);

  const res = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email, deviceLabel: 'MacBook' },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.challenge);

  const stored = await WebAuthnChallenge.findOne({ emailHmac: emailHash });
  assert.ok(stored);
  assert.equal(stored.challenge, body.challenge);
  assert.ok(new Date(stored.expiresAt) > Date.now());
});

test('passkey: register complete creates credential and returns session', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const emailHash = createEmailHash(email);

  const begin = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email, deviceLabel: 'iPhone' },
  });
  assert.equal(begin.statusCode, 200);

  const res = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: { email, registrationResponse: { id: 'test' } },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.sessionToken);
  assert.equal(body.user.emailHash, emailHash);
  assert.ok(body.user.kdfSalt);
  assert.ok(body.user.id);

  const user = await Account.findOne({ emailHmac: emailHash });
  assert.ok(user);

  const credentials = await Credential.find({ accountId: user.id });
  assert.ok(credentials.length >= 1);
  assert.ok(credentials[0].credentialId.startsWith('cred-'));
});

test('passkey: register complete with missing challenge returns 400', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const res = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: { email, registrationResponse: { id: 'test' } },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'challenge_expired');
});

test('passkey: login begin returns options for existing credentials', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const begin = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email, deviceLabel: 'Desktop' },
  });
  assert.equal(begin.statusCode, 200);

  const complete = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: { email, registrationResponse: {} },
  });
  assert.equal(complete.statusCode, 201);

  const res = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.challenge);
  assert.ok(Array.isArray(body.allowCredentials));
  assert.equal(body.allowCredentials.length, 1);
  assert.ok(body.allowCredentials[0].id);
});

test('passkey: login complete verifies and issues session', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const emailHash = createEmailHash(email);

  const regBegin = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email, deviceLabel: 'Desktop' },
  });
  assert.equal(regBegin.statusCode, 200);

  const regComplete = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: { email, registrationResponse: {} },
  });
  assert.equal(regComplete.statusCode, 201);

  const user = await Account.findOne({ emailHmac: emailHash });
  const creds = await Credential.find({ accountId: user.id });
  const credentialId = creds[0].credentialId;

  const begin = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/begin',
    headers: { 'content-type': 'application/json' },
    payload: { email },
  });
  assert.equal(begin.statusCode, 200);

  const res = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/complete',
    headers: { 'content-type': 'application/json' },
    payload: { email, authenticationResponse: { id: credentialId } },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.sessionToken);
  assert.equal(body.user.emailHash, emailHash);
  assert.ok(body.user.id);
});
