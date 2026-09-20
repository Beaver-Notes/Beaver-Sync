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

test('proxy upload fails closed on the ledger quota (workspace and unresolvable)', async () => {
  await cleanTestDb();
  const { signAssetUpload } = require('../src/lib/asset-sign');
  const origPut = r2.put;
  r2.put = async () => {};
  const app = await buildApp();
  // buildApp() loads .env (which sets PLAN_OVERRIDE): this test is about the
  // real per-ledger quota, so drop the dev/test escape hatch.
  delete process.env.PLAN_OVERRIDE;
  try {
    // (a) A workspace over quota must refuse the signed proxy upload, even
    // though the caller's personal subscription has plenty of room.
    const acct = `acct-proxy-ws-${crypto.randomUUID().slice(0, 6)}`;
    await createAccountWithQuota(acct, 'pro', 100_000_000);
    const now = new Date().toISOString();
    const orgId = `org-proxy-${crypto.randomUUID().slice(0, 6)}`;
    const ws = `ws-proxy-${crypto.randomUUID().slice(0, 6)}`;
    await query('INSERT INTO organizations (id, name_encrypted, slug, created_at) VALUES ($1,$2,$3,$4)', [orgId, 'e', `slug-${orgId}`, now]);
    await query('INSERT INTO org_members (org_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [orgId, acct, 'member', now]);
    await query(
      'INSERT INTO org_subscriptions (id, org_id, plan, status, seats, storage_quota_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [`sub-${orgId}`, orgId, 'team', 'active', 1, 100, now]
    );
    await query(
      'INSERT INTO workspaces (id, name_encrypted, owner_id, org_id, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [ws, 'e', acct, orgId, 200, now]
    );
    // The reservation is the authoritative record of which ledger the upload credits.
    const assetKey = `assets--${ws}--note-1--over.png`;
    await query(
      `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7)`,
      [crypto.randomUUID(), acct, ws, assetKey, 200, now, now]
    );
    const { url } = signAssetUpload(assetKey, acct, 3600);
    const q = new URL(url).searchParams;
    const uploadUrl = `/assets/upload?key=${encodeURIComponent(assetKey)}&userId=${acct}&expires=${q.get('expires')}&sig=${q.get('sig')}`;
    const over = await app.inject({
      method: 'PUT',
      url: uploadUrl,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(500),
    });
    assert.equal(over.statusCode, 507, `workspace-over-quota proxy upload must be refused, got ${over.statusCode}: ${over.body}`);
    const wsRow = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
    assert.equal(Number(wsRow.storage_used_bytes), 200, 'refused upload must not touch the ledger');

    // (b) An account whose quota cannot be resolved (no subscription) must not
    // skip the gate: a falsy quota fails closed.
    const noSub = `acct-proxy-nosub-${crypto.randomUUID().slice(0, 6)}`;
    await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [noSub, `${noSub}-hmac`, now, true]);
    const noSubKey = 'proxy-nosub';
    const noSubUrl = signAssetUpload(noSubKey, noSub, 3600).url;
    const q2 = new URL(noSubUrl).searchParams;
    const closed = await app.inject({
      method: 'PUT',
      url: `/assets/upload?key=${noSubKey}&userId=${noSub}&expires=${q2.get('expires')}&sig=${q2.get('sig')}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(500),
    });
    assert.equal(closed.statusCode, 507, `unresolvable quota must fail closed, got ${closed.statusCode}: ${closed.body}`);
  } finally {
    r2.put = origPut;
    await app.close();
  }
});

test('batch-uploaded workspace assets debit the workspace ledger on delete', async () => {
  await cleanTestDb();
  const acct = `acct-batch-ledger-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 100_000_000);
  const now = new Date().toISOString();
  const orgId = `org-batch-${crypto.randomUUID().slice(0, 6)}`;
  const ws = `ws-batch-${crypto.randomUUID().slice(0, 6)}`;
  await query('INSERT INTO organizations (id, name_encrypted, slug, created_at) VALUES ($1,$2,$3,$4)', [orgId, 'e', `slug-${orgId}`, now]);
  await query('INSERT INTO org_members (org_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [orgId, acct, 'owner', now]);
  await query(
    'INSERT INTO org_subscriptions (id, org_id, plan, status, seats, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [`sub-${orgId}`, orgId, 'team', 'active', 1, now]
  );
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, org_id, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [ws, 'e', acct, orgId, 0, now]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [ws, acct, 'owner', now]
  );

  const app = await buildApp();
  delete process.env.PLAN_OVERRIDE;
  const origPut = r2.put;
  const origDel = r2.del;
  r2.put = async (key, body) => { r2.__inject(key, body.length); };
  r2.del = async () => {};
  try {
    const headers = await authHeaders(acct);
    const assetKey = `assets--${ws}--note-1--batch.png`;
    const upload = await app.inject({
      method: 'POST',
      url: '/assets/batch',
      headers,
      payload: { workspaceId: ws, assets: [{ key: assetKey, data: Buffer.alloc(100).toString('base64') }] },
    });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.equal(upload.json().uploaded, 1);
    const wsAfterUpload = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
    assert.equal(Number(wsAfterUpload.storage_used_bytes), 100, 'batch workspace upload must credit the workspace ledger');

    const del = await app.inject({ method: 'DELETE', url: `/assets/${encodeURIComponent(assetKey)}`, headers });
    assert.equal(del.statusCode, 200, del.body);
    const wsAfterDel = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
    const subAfterDel = (await query('SELECT storage_used_bytes FROM subscriptions WHERE account_id=$1', [acct])).rows[0];
    assert.equal(Number(wsAfterDel.storage_used_bytes), 0, 'delete must debit the workspace ledger the upload credited');
    assert.equal(Number(subAfterDel.storage_used_bytes), 0, 'the account ledger must not be debited');
  } finally {
    r2.put = origPut;
    r2.del = origDel;
    await app.close();
  }
});

test('asset key validation accepts client filenames and rejects traversal', () => {
  const { isValidAssetKey } = require('../src/routes/assets-shared');

  // Percent-encoded unicode/space/paren/plus and their raw legacy forms.
  assert.equal(isValidAssetKey('assets--note-1--R%C3%A9sum%C3%A9%20(final)%2Bv2.pdf'), true);
  assert.equal(isValidAssetKey('Résumé (final)+v2.pdf'), true);
  assert.equal(isValidAssetKey("O'Brien's file!~*.txt"), true);
  assert.equal(isValidAssetKey('report..final.pdf'), true);

  // Opaque asset keys: `assets--<base64url token>` (encrypted structure).
  // base64url is `A-Za-z0-9-_`, all inside the allowed set.
  assert.equal(
    isValidAssetKey('assets--' + crypto.randomBytes(120).toString('base64url')),
    true
  );

  // Path traversal / unsafe keys stay rejected.
  assert.equal(isValidAssetKey(''), false);
  assert.equal(isValidAssetKey('a/b'), false);
  assert.equal(isValidAssetKey('a\\b'), false);
  assert.equal(isValidAssetKey('..'), false);
  assert.equal(isValidAssetKey('.hidden'), false);
  assert.equal(isValidAssetKey('a%2Fb'), false);
  assert.equal(isValidAssetKey('bad%zz'), false);
});

test('asset listing is account-global; workspaceId no longer filters', async () => {
  await cleanTestDb();
  const acct = `acct-asset-list-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 100_000);
  const app = await buildApp();
  const headers = await authHeaders(acct);
  const opaque = 'assets--' + crypto.randomBytes(80).toString('base64url');
  const legacy = 'assets--ws-1--n1--a.png';
  const origList = r2.listKeys;
  r2.listKeys = async () => [`${acct}/assets/${opaque}`, `${acct}/assets/${legacy}`];
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/assets?workspaceId=ws-1',
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    // Opaque keys cannot be scoped server-side, so the account-global list is
    // returned; the client decrypts and filters. The legacy key is also present.
    assert.deepEqual(
      JSON.parse(res.body).keys.sort(),
      [opaque, legacy].sort(),
      'workspaceId must not silently drop opaque keys'
    );
  } finally {
    r2.listKeys = origList;
    await app.close();
  }
});

test('asset delete debits the same workspace ledger the upload credited', async () => {
  await cleanTestDb();
  const acct = `acct-asset-ledger-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(acct, 'pro', 100_000_000);
  const now = new Date().toISOString();
  const ws = `ws-asset-ledger-${crypto.randomUUID().slice(0, 6)}`;
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [ws, 'e', acct, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [ws, acct, 'owner', now]);
  await query('UPDATE workspaces SET storage_used_bytes = 100 WHERE id=$1', [ws]);
  await query(
    `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7)`,
    [crypto.randomUUID(), acct, ws, 'ledger-asset', 100, now, now]
  );
  r2.__inject(`${acct}/assets/ledger-asset`, 100);
  const del = r2.del;
  r2.del = async () => {};

  const app = await buildApp();
  const headers = await authHeaders(acct);
  try {
    const res = await app.inject({ method: 'DELETE', url: '/assets/ledger-asset', headers });
    assert.equal(res.statusCode, 200, res.body);

    const wsRow = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
    const subRow = (await query('SELECT storage_used_bytes FROM subscriptions WHERE account_id=$1', [acct])).rows[0];
    assert.equal(Number(wsRow.storage_used_bytes), 0, 'workspace ledger must be debited');
    assert.equal(Number(subRow.storage_used_bytes), 0, 'subscription ledger must be untouched');
  } finally {
    r2.del = del;
    await app.close();
  }
});

test('a non-member cannot credit or reserve against another workspace ledger', async () => {
  await cleanTestDb();
  const attacker = `acct-xws-attacker-${crypto.randomUUID().slice(0, 6)}`;
  const victim = `acct-xws-victim-${crypto.randomUUID().slice(0, 6)}`;
  await createAccountWithQuota(attacker, 'pro', 100_000_000);
  await createAccountWithQuota(victim, 'pro', 100_000_000);

  const now = new Date().toISOString();
  const ws = `ws-xws-victim-${crypto.randomUUID().slice(0, 6)}`;
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [ws, 'e', victim, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [ws, victim, 'owner', now]);
  await query('UPDATE workspaces SET storage_used_bytes = 500 WHERE id=$1', [ws]);

  const app = await buildApp();
  const attackerHeaders = await authHeaders(attacker);

  // Attacker's own asset exists in their own storage path, but they pass the
  // victim workspace id for accounting.
  r2.__inject(`${attacker}/assets/evil`, 1000);
  const confirm = await app.inject({
    method: 'POST', url: '/assets/confirm-seed', headers: attackerHeaders,
    payload: { keys: ['evil'], workspaceId: ws },
  });
  assert.equal(confirm.statusCode, 403, `confirm-seed must reject a non-member, got ${confirm.statusCode}: ${confirm.body}`);
  const afterConfirm = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
  assert.equal(Number(afterConfirm.storage_used_bytes), 500, 'victim ledger must be unchanged by a non-member');

  const presign = await app.inject({
    method: 'POST', url: '/assets/presign-batch', headers: attackerHeaders,
    payload: { keys: ['evil2'], sizes: [1000], workspaceId: ws },
  });
  assert.equal(presign.statusCode, 403, `presign-batch must reject a non-member, got ${presign.statusCode}: ${presign.body}`);
  const reservations = (await query('SELECT COUNT(*)::int AS c FROM asset_reservations WHERE workspace_id=$1', [ws])).rows[0].c;
  assert.equal(reservations, 0, 'no reservation may be created against a foreign workspace');

  // The legitimate member path still credits the workspace ledger.
  const victimHeaders = await authHeaders(victim);
  r2.__inject(`${victim}/assets/good`, 700);
  const ok = await app.inject({
    method: 'POST', url: '/assets/confirm-seed', headers: victimHeaders,
    payload: { keys: ['good'], workspaceId: ws },
  });
  assert.equal(ok.statusCode, 200, `legitimate member confirm must succeed, got ${ok.statusCode}: ${ok.body}`);
  const afterMember = (await query('SELECT storage_used_bytes FROM workspaces WHERE id=$1', [ws])).rows[0];
  assert.equal(Number(afterMember.storage_used_bytes), 1200, 'member credit must be applied to the workspace ledger');

  await app.close();
});
