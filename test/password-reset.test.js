'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.PASSWORD_RESET_REQUEST_RATE_LIMIT_PER_MINUTE = '50';
process.env.PASSWORD_RESET_COMPLETE_RATE_LIMIT_PER_MINUTE = '50';
process.env.PASSWORD_CHANGE_RATE_LIMIT_PER_MINUTE = '50';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { hashPasswordResetToken } = require('../src/lib/crypto');

let app;

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  app = await buildApp();
  await app.ready();
});
test.after(async () => { await app.close(); await close(); });

async function register(email) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', headers: { 'content-type': 'application/json' }, payload: { email, password: 'supersecret123' } });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { id: body.user.id, token: body.token, email };
}

function auth(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

test('POST /auth/password/reset-request always 200 decoy even unknown email', async () => {
  const res = await app.inject({ method: 'POST', url: '/auth/password/reset-request', headers: { 'content-type': 'application/json' }, payload: { email: `unknown-${crypto.randomUUID()}@test.example` } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().message.includes('If an account exists'));
  // known also 200 same shape
  const acc = await register(`reset-decoy-${crypto.randomUUID()}@test.example`);
  const res2 = await app.inject({ method: 'POST', url: '/auth/password/reset-request', headers: { 'content-type': 'application/json' }, payload: { email: acc.email } });
  assert.equal(res2.statusCode, 200);
  assert.equal(res.json().message, res2.json().message, 'decoy message identical');
  // token stored hashed
  const row = await query('SELECT password_reset_token_hash, password_reset_expires_at FROM accounts WHERE id=$1', [acc.id]);
  assert.ok(row.rows[0].password_reset_token_hash);
  assert.equal(row.rows[0].password_reset_token_hash.length, 64);
  const exp = new Date(row.rows[0].password_reset_expires_at);
  const ttl = exp - Date.now();
  assert.ok(ttl > 50 * 60 * 1000 && ttl <= 62 * 60 * 1000, `TTL ~1h got ${ttl}`);
});

test('reset-complete validates, revokes all sessions, clears lockout', async () => {
  const acc = await register(`reset-complete-${crypto.randomUUID()}@test.example`);
  // create second session
  const sess2 = await createSession(acc.id, { headers: {} });
  // trigger reset request to get token
  await app.inject({ method: 'POST', url: '/auth/password/reset-request', headers: { 'content-type': 'application/json' }, payload: { email: acc.email } });
  let row = await query('SELECT password_reset_token_hash FROM accounts WHERE id=$1', [acc.id]);
  const hash = row.rows[0].password_reset_token_hash;
  // we need raw token: inject our own
  const raw = crypto.randomBytes(32).toString('hex');
  const rawHash = hashPasswordResetToken(raw);
  const exp = new Date(Date.now() + 60 * 60 * 1000);
  await query('UPDATE accounts SET password_reset_token_hash=$1, password_reset_expires_at=$2, failed_login_attempts=5, locked_until=$3 WHERE id=$4', [rawHash, exp.toISOString(), new Date(Date.now() + 10 * 60 * 1000).toISOString(), acc.id]);
  // lockout should be cleared on reset
  const res = await app.inject({ method: 'POST', url: '/auth/password/reset-complete', headers: { 'content-type': 'application/json' }, payload: { token: raw, newPassword: 'newpassword123' } });
  assert.equal(res.statusCode, 200, res.body);
  const row2 = await query('SELECT password_hash, password_reset_token_hash, failed_login_attempts, locked_until FROM accounts WHERE id=$1', [acc.id]);
  assert.equal(row2.rows[0].password_reset_token_hash, null);
  assert.equal(row2.rows[0].failed_login_attempts, 0);
  assert.equal(row2.rows[0].locked_until, null);
  // sessions revoked
  const sessRows = await query('SELECT revoked FROM sessions WHERE account_id=$1', [acc.id]);
  assert.ok(sessRows.rows.length >= 2);
  assert.ok(sessRows.rows.every(r => r.revoked === 1 || r.revoked === true || r.revoked === '1'));
  // old password no longer works, new does
  const loginOld = await app.inject({ method: 'POST', url: '/auth/token', headers: { 'content-type': 'application/json' }, payload: { email: acc.email, password: 'supersecret123' } });
  assert.equal(loginOld.statusCode, 401);
  const loginNew = await app.inject({ method: 'POST', url: '/auth/token', headers: { 'content-type': 'application/json' }, payload: { email: acc.email, password: 'newpassword123' } });
  assert.equal(loginNew.statusCode, 200);
  // reuse token fails
  const reuse = await app.inject({ method: 'POST', url: '/auth/password/reset-complete', headers: { 'content-type': 'application/json' }, payload: { token: raw, newPassword: 'anotherpass123' } });
  assert.equal(reuse.statusCode, 400);
});

test('reset-complete expired token returns 410 and clears', async () => {
  const acc = await register(`reset-exp-${crypto.randomUUID()}@test.example`);
  const raw = crypto.randomBytes(32).toString('hex');
  const h = hashPasswordResetToken(raw);
  const expired = new Date(Date.now() - 1000);
  await query('UPDATE accounts SET password_reset_token_hash=$1, password_reset_expires_at=$2 WHERE id=$3', [h, expired.toISOString(), acc.id]);
  const res = await app.inject({ method: 'POST', url: '/auth/password/reset-complete', headers: { 'content-type': 'application/json' }, payload: { token: raw, newPassword: 'newpassword123' } });
  assert.equal(res.statusCode, 410);
  const row = await query('SELECT password_reset_token_hash FROM accounts WHERE id=$1', [acc.id]);
  assert.equal(row.rows[0].password_reset_token_hash, null);
});

test('PATCH /account/password verifies current, rotates, revokes others, 401 on wrong current', async () => {
  const acc = await register(`change-pw-${crypto.randomUUID()}@test.example`);
  const sessOther = await createSession(acc.id, { headers: {} });
  // wrong current
  const bad = await app.inject({ method: 'PATCH', url: '/account/password', headers: auth(acc.token), payload: { currentPassword: 'wrongpass12345', newPassword: 'newpassword123' } });
  assert.equal(bad.statusCode, 401);
  // correct
  const ok = await app.inject({ method: 'PATCH', url: '/account/password', headers: auth(acc.token), payload: { currentPassword: 'supersecret123', newPassword: 'newpassword123' } });
  assert.equal(ok.statusCode, 200, ok.body);
  // other session revoked, current still valid
  const otherCheck = await app.inject({ method: 'GET', url: '/account', headers: auth(sessOther) });
  assert.equal(otherCheck.statusCode, 401);
  const still = await app.inject({ method: 'GET', url: '/account', headers: auth(acc.token) });
  assert.equal(still.statusCode, 200);
  // login with new pw works
  const login = await app.inject({ method: 'POST', url: '/auth/token', headers: { 'content-type': 'application/json' }, payload: { email: acc.email, password: 'newpassword123' } });
  assert.equal(login.statusCode, 200);
});

test('410 gating when LEGACY_AUTH_ENABLED false', async () => {
  const acc = await register(`gating-${crypto.randomUUID()}@test.example`);
  const prev = process.env.LEGACY_AUTH_ENABLED;
  process.env.LEGACY_AUTH_ENABLED = 'false';
  const r1 = await app.inject({ method: 'POST', url: '/auth/password/reset-request', headers: { 'content-type': 'application/json' }, payload: { email: 'a@test.example' } });
  assert.equal(r1.statusCode, 410);
  const r2 = await app.inject({ method: 'POST', url: '/auth/password/reset-complete', headers: { 'content-type': 'application/json' }, payload: { token: 'a'.repeat(64), newPassword: 'newpassword123' } });
  assert.equal(r2.statusCode, 410);
  const r3 = await app.inject({ method: 'PATCH', url: '/account/password', headers: auth(acc.token), payload: { currentPassword: 'supersecret123', newPassword: 'newpassword12345' } });
  assert.equal(r3.statusCode, 410);
  process.env.LEGACY_AUTH_ENABLED = prev;
});
