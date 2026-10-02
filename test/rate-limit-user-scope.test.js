'use strict';

// The rate limiter runs on the plugin default hook (onRequest), which fires before
// authenticate, so `req.userId` was always undefined and the key collapsed to the
// IP. Every account behind one NAT, CGNAT or corporate egress shared one bucket:
// user B got 429'd by user A's spending. Anonymous callers must still be keyed by
// IP (that is the point of a login-attempt limit), so this pins the split.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
// The route, not the global default, owns the budget for GET /account.
process.env.ACCOUNT_READ_RATE_LIMIT_PER_MINUTE = '3';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); });
test.after(async () => { await close(); });

test('two accounts on one IP do not share a rate-limit bucket', async (t) => {
  await cleanTestDb();
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  await seedAccount('rl-user-a', 'pub-a');
  await seedAccount('rl-user-b', 'pub-b');
  const tokenA = await createSession('rl-user-a', { headers: {} });
  const tokenB = await createSession('rl-user-b', { headers: {} });

  const get = (token) => app.inject({
    method: 'GET',
    url: '/account',
    headers: { authorization: `Bearer ${token}` },
  });

  const a = [];
  for (let i = 0; i < 3; i++) a.push((await get(tokenA)).statusCode);
  const b = [];
  for (let i = 0; i < 3; i++) b.push((await get(tokenB)).statusCode);

  assert.deepEqual(a, [200, 200, 200], 'user A gets its full budget');
  assert.deepEqual(
    b, [200, 200, 200],
    `user B must not be limited by user A's spend (both requests come from 127.0.0.1), got ${JSON.stringify(b)}`);
});

test('an unauthenticated caller is still limited per IP', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const anon = () => app.inject({ method: 'GET', url: '/account' });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await anon()).statusCode);

  assert.ok(
    statuses.includes(429) || statuses.includes(401),
    `an anonymous caller must be limited, got ${JSON.stringify(statuses)}`);
  assert.equal(
    statuses.filter((s) => s === 429).length > 0, true,
    `the IP bucket must still apply to anonymous traffic, got ${JSON.stringify(statuses)}`);
});
