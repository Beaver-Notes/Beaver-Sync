'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.NOTE_HMAC_KEY = 'test-note-hmac-key-at-least-32-characters-long';
process.env.ENTERPRISE_MODE = 'false';
delete process.env.PLAN_OVERRIDE;

const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { query } = require('../src/db/postgres');
const r2 = require('../src/services/r2');

let origPresignPut, origStat, origGet, origDel;

function stubR2() {
  const store = new Map(); // key -> {sizeBytes, body}
  origPresignPut = r2.presignPut;
  origStat = r2.stat;
  origGet = r2.get;
  origDel = r2.del;
  r2.presignPut = async (key) => `https://presigned.test/${encodeURIComponent(key)}?sig=test`;
  r2.stat = async (key) => {
    const v = store.get(key);
    return v ? { sizeBytes: v.sizeBytes } : null;
  };
  // helper to inject object as if uploaded via presigned URL
  r2.__store = store;
  r2.__inject = (key, size) => store.set(key, { sizeBytes: size, body: Buffer.alloc(size) });
  return store;
}
function restoreR2() {
  if (origPresignPut) r2.presignPut = origPresignPut;
  if (origStat) r2.stat = origStat;
  if (origGet) r2.get = origGet;
  if (origDel) r2.del = origDel;
}

async function buildApp() {
  const { buildApp: build } = require('../src/server');
  return build();
}

async function createAccountWithQuota(accountId, plan, quotaBytes) {
  const now = new Date().toISOString();
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [accountId, `${accountId}-hmac`, now, true]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`${accountId}-sub`, accountId, plan, 'active', quotaBytes, 0, now]);
}

async function authHeaders(accountId) {
  const { createSession } = require('../src/middleware/auth');
  const raw = await createSession(accountId, { headers: {} });
  return { authorization: `Bearer ${raw}`, 'content-type': 'application/json' };
}

test.before(async () => {
  await setupTestDb();
  stubR2();
});

test.after(async () => {
  restoreR2();
  const { close } = require('../src/db');
  await close();
});

test('presign blocked at limit', async () => {
  await cleanTestDb();
  const acct = `acct-presign-block-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 1000);
  const app = await buildApp();
  const headers = await authHeaders(acct);

  // First presign of 600 should succeed (used 0 + pending 0 + 600 < 1000)
  const res1 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['a1'], sizes: [600] } });
  assert.equal(res1.statusCode, 200, `first presign should succeed got ${res1.statusCode} ${res1.body}`);

  // Second presign of 600 should be blocked (pending 600 + 600 > 1000)
  const res2 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['a2'], sizes: [600] } });
  assert.equal(res2.statusCode, 507, `second presign should be blocked got ${res2.statusCode} ${res2.body}`);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.error, 'storage_quota_exceeded');

  // Smaller request that fits remaining should succeed: 300 (600+300<1000)
  const res3 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['a3'], sizes: [300] } });
  assert.equal(res3.statusCode, 200, `third presign 300 should succeed got ${res3.statusCode} ${res3.body}`);

  await app.close();
});

test('confirm accounts and reap frees reservation', async () => {
  await cleanTestDb();
  const acct = `acct-presign-confirm-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 5000);
  const app = await buildApp();
  const headers = await authHeaders(acct);

  const res = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['file1'], sizes: [1000] } });
  assert.equal(res.statusCode, 200);

  // Simulate R2 upload via presigned URL (inject into stub)
  const key = `${acct}/assets/file1`;
  r2.__inject(key, 1000);

  // Confirm should account storage
  const confirm = await app.inject({ method: 'POST', url: '/assets/confirm-seed', headers, payload: { keys: ['file1'] } });
  assert.equal(confirm.statusCode, 200);
  const cbody = JSON.parse(confirm.body);
  assert.equal(cbody.verified, 1);
  assert.equal(cbody.sizeBytes, 1000);

  const subAfter = (await query('SELECT storage_used_bytes FROM subscriptions WHERE account_id=$1', [acct])).rows[0];
  assert.equal(Number(subAfter.storage_used_bytes), 1000);

  // Reservation should be confirmed, not pending
  const pending = (await query(`SELECT COUNT(*)::int AS c FROM asset_reservations WHERE account_id=$1 AND status='pending'`, [acct])).rows[0].c;
  assert.equal(pending, 0);

  // Second confirm idempotent should not double-count
  const confirm2 = await app.inject({ method: 'POST', url: '/assets/confirm-seed', headers, payload: { keys: ['file1'] } });
  assert.equal(confirm2.statusCode, 200);
  const subAfter2 = (await query('SELECT storage_used_bytes FROM subscriptions WHERE account_id=$1', [acct])).rows[0];
  assert.equal(Number(subAfter2.storage_used_bytes), 1000, 'second confirm should not double-increment');

  await app.close();
});

test('reap frees expired reservation', async () => {
  await cleanTestDb();
  const acct = `acct-presign-reap-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 1000);
  const app = await buildApp();
  const headers = await authHeaders(acct);

  // Create a reservation that will be expired manually
  const res = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['orphan1'], sizes: [800] } });
  assert.equal(res.statusCode, 200);

  // Expire it
  await query(`UPDATE asset_reservations SET expires_at = NOW() - INTERVAL '2 hours' WHERE account_id=$1`, [acct]);
  const { reapExpiredReservations } = require('../src/db/asset-reservations');
  const reaped = await reapExpiredReservations();
  assert.ok(reaped >= 1, `should reap at least 1 got ${reaped}`);

  // Now same size should succeed again (pending cleared)
  const res2 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['orphan2'], sizes: [800] } });
  assert.equal(res2.statusCode, 200, `after reap presign should succeed got ${res2.statusCode} ${res2.body}`);

  // Piggyback via yjs-gc runGc should also reap
  await query(`UPDATE asset_reservations SET expires_at = NOW() - INTERVAL '2 hours' WHERE account_id=$1`, [acct]);
  const { runGc } = require('../src/jobs/yjs-gc');
  const gcRes = await runGc({ now: Date.now() });
  assert.ok(gcRes.reapedReservations >= 1 || gcRes.swept !== undefined);

  // After GC reap, presign should again succeed
  const res3 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['orphan3'], sizes: [800] } });
  assert.equal(res3.statusCode, 200);

  await app.close();
});

test('parallel presigns respect combined cap', async () => {
  await cleanTestDb();
  const acct = `acct-presign-parallel-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 1500);
  const app = await buildApp();
  const headers = await authHeaders(acct);

  // Two concurrent presigns each 800 (total 1600 > 1500). With advisory lock, exactly one should succeed.
  const p1 = app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['p1'], sizes: [800] } });
  const p2 = app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['p2'], sizes: [800] } });
  const [r1, r2] = await Promise.all([p1, p2]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(statuses, [200, 507], `parallel presigns should be 200+507 got ${r1.statusCode},${r2.statusCode}`);

  // Verify pending sum is 800, not 1600
  const pending = (await query(`SELECT COALESCE(SUM(size_bytes),0)::int AS total FROM asset_reservations WHERE account_id=$1 AND status='pending'`, [acct])).rows[0].total;
  assert.equal(pending, 800);

  await app.close();
});

test('sizes capped and missing sizes default to 0', async () => {
  await cleanTestDb();
  const acct = `acct-presign-cap-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 200_000_000);
  const app = await buildApp();
  const headers = await authHeaders(acct);

  // Oversized declared size should be capped at MAX (100MB) and still succeed if quota allows
  const huge = 500 * 1024 * 1024;
  const res = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['big1'], sizes: [huge] } });
  assert.equal(res.statusCode, 200);
  const row = (await query(`SELECT size_bytes FROM asset_reservations WHERE account_id=$1 AND asset_key=$2`, [acct, 'big1'])).rows[0];
  const { MAX_ASSET_SIZE_BYTES } = require('../src/routes/assets-shared');
  assert.equal(Number(row.size_bytes), MAX_ASSET_SIZE_BYTES, 'size should be capped at MAX');

  // Missing sizes -> 0 reservation (legacy)
  const res2 = await app.inject({ method: 'POST', url: '/assets/presign-batch', headers, payload: { keys: ['nosize1'] } });
  assert.equal(res2.statusCode, 200);

  await app.close();
});
