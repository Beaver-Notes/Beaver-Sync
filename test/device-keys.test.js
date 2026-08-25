'use strict';

// TDD test for Task 1: account-level deviceKeys[] with append-only keypair.
//
// NOTE: The upstream brief assumed a `vitest` runner plus `test/helpers.js`
// and `test/fixtures.js` (makeAccount/authHeaders/randomKem) and a
// `GET /account` shape of `{ profile: {...} }`. This repo does NOT use vitest
// (its runner is `node --test`) and has no such helpers, and `GET /account`
// returns `{ user: {...} }`. This test uses the real harness (`buildApp`,
// `setupTestDb`, `createSession`) and the real response shape, while
// preserving every behavioral assertion from the brief:
//   1. POST /keypair appends a device key instead of clobbering others,
//   2. deviceKeys length === 2 for two distinct deviceIds,
//   3. kemPublicKey (legacy primary / first key) is preserved (=== k1).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

// ML-KEM-768 public keys are 1184 bytes => 2368 hex chars (validatePublicKey
// enforces the exact length), so a randomKem must match.
function randomKem() {
  return crypto.randomBytes(1184).toString('hex');
}

async function makeAccount(tag) {
  const id = `devkey-${tag}-${crypto.randomUUID()}`;
  const emailHmac = `devkey-hmac-${tag}-${crypto.randomUUID()}`;
  await query(
    'INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)',
    [id, emailHmac, new Date().toISOString()]
  );
  return id;
}

async function authHeaders(accountId) {
  const session = await createSession(accountId, { headers: {} });
  return { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

test('POST /keypair appends a device key without overwriting others', async (t) => {
  const app = await buildApp();
  t.after(async () => await app.close());

  const acct = await makeAccount('devuser');
  const h1 = await authHeaders(acct);
  const k1 = randomKem();
  const first = await app.inject({
    method: 'POST', url: '/auth/keypair', headers: h1,
    payload: { kemPublicKey: k1, deviceId: 'dev-a' },
  });
  assert.equal(first.statusCode, 200, `first keypair failed: ${first.body}`);
  assert.equal(first.json().ok, true);
  assert.equal(first.json().deviceId, 'dev-a');
  assert.equal(first.json().deviceCount, 1);

  const h2 = await authHeaders(acct); // same account, different device
  const k2 = randomKem();
  const res = await app.inject({
    method: 'POST', url: '/auth/keypair', headers: h2,
    payload: { kemPublicKey: k2, deviceId: 'dev-b' },
  });
  assert.equal(res.statusCode, 200, `second keypair failed: ${res.body}`);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().deviceCount, 2);

  const profile = await app.inject({ method: 'GET', url: '/account', headers: h1 });
  assert.equal(profile.statusCode, 200, profile.body);
  const user = profile.json().user;
  assert.ok(Array.isArray(user.deviceKeys), 'deviceKeys should be an array');
  assert.equal(user.deviceKeys.length, 2, 'two device keys should be present');
  assert.deepEqual(
    user.deviceKeys.map((d) => d.publicKey).sort(),
    [k1, k2].sort(),
    'both device public keys should be present'
  );
  // kemPublicKey legacy primary is preserved (first key)
  assert.equal(user.kemPublicKey, k1, 'legacy kemPublicKey must remain the first key');
});

test('POST /keypair replaces only the same deviceId entry (append-only per device)', async (t) => {
  const app = await buildApp();
  t.after(async () => await app.close());

  const acct = await makeAccount('repro');
  const h = await authHeaders(acct);
  const k1 = randomKem();
  await app.inject({ method: 'POST', url: '/auth/keypair', headers: h, payload: { kemPublicKey: k1, deviceId: 'dev-a' } });

  // Re-register dev-a with a new key; the array must not grow or lose others.
  const k1b = randomKem();
  const res = await app.inject({ method: 'POST', url: '/auth/keypair', headers: h, payload: { kemPublicKey: k1b, deviceId: 'dev-a' } });
  assert.equal(res.json().deviceCount, 1);

  const profile = await app.inject({ method: 'GET', url: '/account', headers: h });
  const user = profile.json().user;
  assert.equal(user.deviceKeys.length, 1);
  assert.equal(user.deviceKeys[0].publicKey, k1b);
  assert.equal(user.deviceKeys[0].deviceId, 'dev-a');
});
