'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-lr';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.JWT_PRIVATE_KEY_PATH = path.join(__dirname, '..', 'keys', 'private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(__dirname, '..', 'keys', 'public.pem');

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { Account, Subscription } = require('../src/models');
const { createEmailHash } = require('../src/lib/crypto');
const mlkem = require('../src/lib/mlkem');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await mlkem.init();
});

test.after(async () => {
  await close();
});

async function makeAccount(email) {
  const account = await Account.create({ emailHmac: createEmailHash(email), passwordHash: null });
  await Subscription.create({
    accountId: account.id,
    plan: 'free',
    status: 'active',
    storageQuotaBytes: 0,
    createdAt: new Date(),
  });
  return account;
}

function legacyToken(userId) {
  return jwt.sign(
    { sub: userId },
    fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH, 'utf8'),
    { algorithm: 'RS256', expiresIn: '30d', issuer: 'beaver-sync' }
  );
}

test('legacy JWT works until revoked, then 401s; sessions still work after revoke', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const suffix = crypto.randomBytes(4).toString('hex');
  const account = await makeAccount(`revoke-${suffix}@example.com`);

  // A session issued before revocation keeps working (sessions have their own revocation).
  const { Session } = require('../src/models');
  const { hashSessionId } = require('../src/lib/crypto');
  const rawSession = crypto.randomBytes(32).toString('base64url');
  await Session.create({
    idHash: hashSessionId(rawSession),
    accountId: account.id,
    deviceLabel: 'S',
    ipSubnet: '127.0.0',
    expiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    revoked: false,
  });

  const token = legacyToken(account.id);
  const auth = { authorization: `Bearer ${token}` };

  const before = await app.inject({ method: 'GET', url: '/auth/sessions', headers: auth });
  assert.equal(before.statusCode, 200);

  const revoke = await app.inject({
    method: 'POST',
    url: '/auth/revoke-legacy',
    headers: auth,
  });
  assert.equal(revoke.statusCode, 200);

  const after = await app.inject({ method: 'GET', url: '/auth/sessions', headers: auth });
  assert.equal(after.statusCode, 401);
  assert.equal(after.json().error, 'token_expired');

  // Token minted AFTER revocation is honored again (iat is second-granular).
  await new Promise((r) => setTimeout(r, 1100));
  const fresh = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${legacyToken(account.id)}` },
  });
  assert.equal(fresh.statusCode, 200);

  // Session-based auth unaffected by legacy revoke.
  const viaSession = await app.inject({
    method: 'GET',
    url: '/auth/sessions',
    headers: { authorization: `Bearer ${rawSession}` },
  });
  assert.equal(viaSession.statusCode, 200);
});
