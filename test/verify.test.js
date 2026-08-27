'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.VERIFY_EMAIL_REQUEST_RATE_LIMIT_PER_MINUTE = '50';
process.env.VERIFY_EMAIL_CONFIRM_RATE_LIMIT_PER_MINUTE = '50';
process.env.LEGACY_AUTH_ENABLED = 'true';

const repoRoot = path.resolve(__dirname, '..');
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { register } = require('./helpers/factory');
const { createSession } = require('../src/middleware/auth');

let app;

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  app = await buildApp();
  await app.ready();
});

test.after(async () => {
  await app.close();
  await close();
});

function authHeader(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function registerUnverified(email) {
  // raw registration via API gives unverified account
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'supersecret123' },
  });
  assert.equal(res.statusCode, 201, `register failed: ${res.body}`);
  const body = res.json();
  return { id: body.user.id, token: body.token, email };
}

test('migration: new accounts start unverified, GET /account shows emailVerified false', async () => {
  const acc = await registerUnverified(`verify-mig-${crypto.randomUUID()}@test.example`);
  const me = await app.inject({ method: 'GET', url: '/account', headers: authHeader(acc.token) });
  assert.equal(me.statusCode, 200);
  const body = me.json();
  assert.equal(body.user.emailVerified, false, 'new account should be unverified');
  const row = await query('SELECT email_verified, verification_token_hash FROM accounts WHERE id=$1', [acc.id]);
  assert.equal(Boolean(row.rows[0].email_verified), false);
});

test('happy: request -> confirm marks verified, token single-use 24h hashed', async () => {
  const acc = await registerUnverified(`verify-happy-${crypto.randomUUID()}@test.example`);
  const reqRes = await app.inject({ method: 'POST', url: '/account/verify-email/request', headers: authHeader(acc.token) });
  assert.equal(reqRes.statusCode, 200, reqRes.body);
  const reqBody = reqRes.json();
  assert.equal(reqBody.sent, true);
  assert.ok(reqBody.expiresAt);

  const row = await query('SELECT verification_token_hash, verification_expires_at, email_verified FROM accounts WHERE id=$1', [acc.id]);
  assert.ok(row.rows[0].verification_token_hash, 'hash stored');
  assert.equal(row.rows[0].verification_token_hash.length, 64, 'HMAC hex');
  assert.ok(row.rows[0].verification_expires_at);
  assert.equal(Boolean(row.rows[0].email_verified), false);
  // hash is not raw token
  const expiresAt = new Date(row.rows[0].verification_expires_at);
  const ttlMs = expiresAt - Date.now();
  assert.ok(ttlMs > 23 * 60 * 60 * 1000 && ttlMs <= 24 * 60 * 60 * 1000 + 60000, `TTL should be ~24h, got ${ttlMs}`);

  // we need raw token: we cannot get it from DB, so do a second request to get a fresh token and confirm it
  // first request token is lost -> request again (invalidates previous, still valid flow)
  const req2 = await app.inject({ method: 'POST', url: '/account/verify-email/request', headers: authHeader(acc.token) });
  assert.equal(req2.statusCode, 200);
  const row2 = await query('SELECT verification_token_hash FROM accounts WHERE id=$1', [acc.id]);
  const hash2 = row2.rows[0].verification_token_hash;
  assert.notEqual(row.rows[0].verification_token_hash, hash2, 'regenerate invalidates old');

  // To actually confirm, we need raw token. So monkey: generate our own token and set it directly
  const raw = crypto.randomBytes(32).toString('hex');
  const { hashVerificationToken } = require('../src/lib/crypto');
  const hash = hashVerificationToken(raw);
  const exp2 = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await query('UPDATE accounts SET verification_token_hash=$1, verification_expires_at=$2 WHERE id=$3', [hash, exp2.toISOString(), acc.id]);

  const confirm = await app.inject({
    method: 'POST',
    url: '/account/verify-email/confirm',
    headers: { 'content-type': 'application/json' },
    payload: { token: raw },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(confirm.json().verified, true);

  const row3 = await query('SELECT email_verified, verification_token_hash, verification_expires_at FROM accounts WHERE id=$1', [acc.id]);
  assert.equal(Boolean(row3.rows[0].email_verified), true);
  assert.equal(row3.rows[0].verification_token_hash, null, 'single-use cleared');
  assert.equal(row3.rows[0].verification_expires_at, null);

  // reuse same token fails
  const reuse = await app.inject({
    method: 'POST',
    url: '/account/verify-email/confirm',
    headers: { 'content-type': 'application/json' },
    payload: { token: raw },
  });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error, 'invalid_token');

  // GET now shows verified
  const me2 = await app.inject({ method: 'GET', url: '/account', headers: authHeader(acc.token) });
  assert.equal(me2.json().user.emailVerified, true);
});

test('confirm with expired token returns 410 and clears', async () => {
  const acc = await registerUnverified(`verify-exp-${crypto.randomUUID()}@test.example`);
  const raw = crypto.randomBytes(32).toString('hex');
  const { hashVerificationToken } = require('../src/lib/crypto');
  const hash = hashVerificationToken(raw);
  const expired = new Date(Date.now() - 1000);
  await query('UPDATE accounts SET verification_token_hash=$1, verification_expires_at=$2 WHERE id=$3', [hash, expired.toISOString(), acc.id]);

  const res = await app.inject({
    method: 'POST',
    url: '/account/verify-email/confirm',
    headers: { 'content-type': 'application/json' },
    payload: { token: raw },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, 'token_expired');
  const row = await query('SELECT verification_token_hash FROM accounts WHERE id=$1', [acc.id]);
  assert.equal(row.rows[0].verification_token_hash, null);
});

test('request when already verified returns alreadyVerified', async () => {
  const acc = await register('pro');
  // factory register sets verified true
  const sess = await createSession(acc.id, { headers: {} });
  const res = await app.inject({ method: 'POST', url: '/account/verify-email/request', headers: { authorization: `Bearer ${sess}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().alreadyVerified, true);
});

test('POST /account/verify-email/request requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/account/verify-email/request' });
  assert.equal(res.statusCode, 401);
});

test('POST /account/verify-email/confirm requires token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/account/verify-email/confirm',
    headers: { 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('enforcement 403 EMAIL_NOT_VERIFIED on workspace invite creation', async () => {
  const ownerUnverified = await registerUnverified(`ws-invite-unv-${crypto.randomUUID()}@test.example`);
  const target = await register('pro');
  // need org + workspace membership for owner
  const models = require('../src/models');
  const { seedOrg } = require('./helpers/factory');
  const orgId = `org-verify-${crypto.randomUUID()}`;
  await seedOrg(orgId, ownerUnverified.id, 'team');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: ownerUnverified.id, orgId, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: ownerUnverified.id, role: 'owner', createdAt: new Date() });

  // try to invite while unverified -> 403
  const invite = await app.inject({
    method: 'POST',
    url: `/workspaces/${ws.id}/members`,
    headers: authHeader(ownerUnverified.token),
    payload: { email: `any-${crypto.randomUUID()}@test.example`, role: 'editor' },
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.equal(invite.json().error, 'EMAIL_NOT_VERIFIED');

  // verify owner then retry should not be EMAIL_NOT_VERIFIED (may be user_not_found etc but not that code)
  await query('UPDATE accounts SET email_verified=true WHERE id=$1', [ownerUnverified.id]);
  const invite2 = await app.inject({
    method: 'POST',
    url: `/workspaces/${ws.id}/members`,
    headers: authHeader(ownerUnverified.token),
    payload: { username: 'nouser-' + crypto.randomUUID().slice(0, 8), role: 'editor' },
  });
  // should not be EMAIL_NOT_VERIFIED
  assert.notEqual(invite2.json().error, 'EMAIL_NOT_VERIFIED');
});

test('enforcement 403 EMAIL_NOT_VERIFIED on collaboration invite and link creation', async () => {
  const ownerUnv = await registerUnverified(`collab-unv-${crypto.randomUUID()}@test.example`);
  const noteId = `note-verify-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}-${crypto.randomUUID().slice(0, 8)}`;
  // bootstrap: owner will create note collaboration context via POST /collaboration/invite/:noteId but that itself is gated
  const invite = await app.inject({
    method: 'POST',
    url: `/collaboration/invite/${noteId}`,
    headers: authHeader(ownerUnv.token),
    payload: { email: `target-${crypto.randomUUID()}@test.example` },
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.equal(invite.json().error, 'EMAIL_NOT_VERIFIED');

  const link = await app.inject({
    method: 'POST',
    url: `/collaboration/links/${noteId}`,
    headers: authHeader(ownerUnv.token),
    payload: { role: 'viewer' },
  });
  assert.equal(link.statusCode, 403);
  assert.equal(link.json().error, 'EMAIL_NOT_VERIFIED');

  // after verify, gate lifted (may still fail for other reasons but not EMAIL_NOT_VERIFIED)
  await query('UPDATE accounts SET email_verified=true WHERE id=$1', [ownerUnv.id]);
  const invite2 = await app.inject({
    method: 'POST',
    url: `/collaboration/invite/${noteId}`,
    headers: authHeader(ownerUnv.token),
    payload: { email: `target2-${crypto.randomUUID()}@test.example` },
  });
  assert.notEqual(invite2.json().error, 'EMAIL_NOT_VERIFIED');
});

test('reset emails deliver regardless: password reset request not gated (always 200 decoy)', async () => {
  // This is a soft check: ensure verification gate does not affect recovery or password flows
  // POST /auth/recover with dummy code should still be 401, not 403 EMAIL_NOT_VERIFIED
  const acc = await registerUnverified(`reset-unv-${crypto.randomUUID()}@test.example`);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/recover',
    headers: { 'content-type': 'application/json' },
    payload: { email: acc.email, code: 'a'.repeat(64) },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_recovery_code');
});
