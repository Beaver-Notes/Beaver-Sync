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
delete process.env.YJS_GC_INTERVAL_MS;

const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { query, getPool } = require('../src/db/postgres');
const Y = require('yjs');
const r2 = require('../src/services/r2');

let origPut, origStat, origGet;

function stubR2() {
  const store = new Map();
  origPut = r2.put;
  origStat = r2.stat;
  origGet = r2.get;
  r2.put = async (key, body) => { store.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)); };
  r2.stat = async (key) => store.has(key) ? { sizeBytes: store.get(key).length } : null;
  r2.get = async (key) => store.has(key) ? store.get(key) : null;
  return store;
}
function restoreR2() {
  if (origPut) r2.put = origPut;
  if (origStat) r2.stat = origStat;
  if (origGet) r2.get = origGet;
}

async function seedWorkspaceWithPlan(wsId, ownerId, plan) {
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `${ownerId}-hmac`, new Date().toISOString(), true]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', ownerId, new Date().toISOString()]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [wsId, ownerId, 'owner', new Date().toISOString()]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`${ownerId}-sub`, ownerId, plan, 'active', 1024*1024*1024, 0, new Date().toISOString()]);
  await query('INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1,$2,$3,$4)', [wsId, 'initialized', 1, new Date().toISOString()]);
}

function yUpdateFor(doc, text) {
  doc.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

test.before(async () => {
  await setupTestDb();
});

test.after(async () => {
  restoreR2();
  const { close } = require('../src/db');
  await close();
});

test('getIntervalMs respects env 0=off', async () => {
  const { getIntervalMs } = require('../src/jobs/yjs-gc');
  delete process.env.YJS_GC_INTERVAL_MS;
  assert.equal(getIntervalMs(), 0);
  process.env.YJS_GC_INTERVAL_MS = '0';
  assert.equal(getIntervalMs(), 0);
  process.env.YJS_GC_INTERVAL_MS = '60000';
  assert.equal(getIntervalMs(), 60000);
  delete process.env.YJS_GC_INTERVAL_MS;
});

test('compaction correctness: doc reconstructs identically pre/post', async () => {
  await cleanTestDb();
  const r2Store = stubR2();
  const wsId = 'ws-gc-correct-' + crypto.randomUUID().slice(0,6);
  const owner = 'acct-gc-correct-' + crypto.randomUUID().slice(0,6);
  await seedWorkspaceWithPlan(wsId, owner, 'free'); // free => cutoff now => all aged => will be compacted

  // Create 3 Yjs updates via Yjs
  const noteId = 'note-compact';
  for (let i = 0; i < 3; i++) {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, `hello-${i}-`);
    const upd = Y.encodeStateAsUpdate(doc);
    // Use old created_at so GC treats as aged (free tier cutoff = now)
    const oldCreated = new Date(Date.now() - 100_000).toISOString();
    const ts = 1000 + i;
    await query('INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [`id-correct-${i}-${crypto.randomUUID()}`, wsId, noteId, upd, 0, 'dev-a', i+1, ts, oldCreated]);
  }

  // capture pre-GC reconstruction
  const preRows = (await query('SELECT update_data FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2 ORDER BY ts ASC', [wsId, noteId])).rows;
  const preDoc = new Y.Doc();
  for (const r of preRows) Y.applyUpdate(preDoc, r.update_data);
  const preText = preDoc.getText('t').toString();

  const { runGc } = require('../src/jobs/yjs-gc');
  const res = await runGc({ now: Date.now() });
  assert.ok(res.docsCompacted >= 1, `expected compacted >=1 got ${res.docsCompacted}`);
  assert.ok(res.bytesReclaimed !== 0 || res.docsCompacted>0);

  // After GC, reconstruct via snapshot + tail
  const snapRow = (await query('SELECT snapshot_key FROM sync_document_state WHERE workspace_id=$1 AND note_id=$2', [wsId, noteId])).rows[0];
  assert.ok(snapRow?.snapshot_key, 'snapshot_key should exist');
  const snapData = r2Store.get(snapRow.snapshot_key);
  assert.ok(snapData, 'snapshot should be in r2 store');
  const tailRows = (await query('SELECT update_data FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2 ORDER BY ts ASC', [wsId, noteId])).rows;
  const postDoc = new Y.Doc();
  // snapshot is Yjs encoded state
  try { Y.applyUpdate(postDoc, snapData); } catch { for (const b of [snapData]) Y.applyUpdate(postDoc, b); }
  for (const r of tailRows) Y.applyUpdate(postDoc, r.update_data);
  const postText = postDoc.getText('t').toString();
  assert.equal(postText, preText, 'doc should reconstruct identically pre/post');

  restoreR2();
});

test('tier cutoff respected: free deletes aged, enterprise retains', async () => {
  await cleanTestDb();
  const r2Store = stubR2();

  // Free workspace: aged rows should be pruned
  const wsFree = 'ws-gc-free-' + crypto.randomUUID().slice(0,6);
  const ownerFree = 'acct-free-' + crypto.randomUUID().slice(0,6);
  await seedWorkspaceWithPlan(wsFree, ownerFree, 'free');
  const noteFree = 'note-free';
  const oldTs = Date.now() - 100_000;
  for (let i=0;i<2;i++) {
    await query('INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [`free-${i}-${crypto.randomUUID()}`, wsFree, noteFree, yUpdateFor(new Y.Doc(), `free-${i}`), 0, 'dev-a', i+1, oldTs+i, new Date(oldTs+i).toISOString()]);
  }
  // Enterprise workspace: same aged rows should NOT be pruned (cutoff 0)
  const wsEnt = 'ws-gc-ent-' + crypto.randomUUID().slice(0,6);
  const ownerEnt = 'acct-ent-' + crypto.randomUUID().slice(0,6);
  await seedWorkspaceWithPlan(wsEnt, ownerEnt, 'enterprise');
  const noteEnt = 'note-ent';
  for (let i=0;i<2;i++) {
    await query('INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [`ent-${i}-${crypto.randomUUID()}`, wsEnt, noteEnt, yUpdateFor(new Y.Doc(), `ent-${i}`), 0, 'dev-a', i+1, oldTs+i, new Date(oldTs+i).toISOString()]);
  }

  const { runGc } = require('../src/jobs/yjs-gc');
  await runGc({ now: Date.now() });

  const freeCount = (await query('SELECT COUNT(*)::int AS c FROM yjs_doc_updates WHERE workspace_id=$1', [wsFree])).rows[0].c;
  const entCount = (await query('SELECT COUNT(*)::int AS c FROM yjs_doc_updates WHERE workspace_id=$1', [wsEnt])).rows[0].c;
  assert.equal(freeCount, 0, 'free tier aged rows should be pruned (snapshot holds them)');
  assert.equal(entCount, 2, 'enterprise should retain all (cutoff 0)');

  restoreR2();
});

test('advisory lock prevents concurrent double-compaction (global lock)', async () => {
  await cleanTestDb();
  stubR2();
  const wsId = 'ws-gc-lock-' + crypto.randomUUID().slice(0,6);
  const owner = 'acct-lock-' + crypto.randomUUID().slice(0,6);
  await seedWorkspaceWithPlan(wsId, owner, 'free');
  await query('INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [`lock-${crypto.randomUUID()}`, wsId, 'note-lock', yUpdateFor(new Y.Doc(), 'lock'), 0, 'dev-a', 1, 1000, new Date(Date.now()-100000).toISOString()]);

  const { runGc, GC_ADVISORY_KEY } = require('../src/jobs/yjs-gc');
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [GC_ADVISORY_KEY]);
    const res = await runGc({ now: Date.now() });
    assert.equal(res.skipped, true, 'second run should be skipped while lock held');
    // ensure no compaction happened while locked
    const cnt = (await query('SELECT COUNT(*)::int AS c FROM yjs_doc_updates WHERE workspace_id=$1', [wsId])).rows[0].c;
    assert.equal(cnt, 1, 'should not have compacted while locked');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [GC_ADVISORY_KEY]);
    client.release();
  }
  // Now run again should succeed
  const res2 = await runGc({ now: Date.now() });
  assert.ok(!res2.skipped, 'should run after lock released');
  const cnt2 = (await query('SELECT COUNT(*)::int AS c FROM yjs_doc_updates WHERE workspace_id=$1', [wsId])).rows[0].c;
  assert.equal(cnt2, 0);

  restoreR2();
});

test('sweep orphaned relay artifacts deletes yjs_documents', async () => {
  await cleanTestDb();
  stubR2();
  await query(`INSERT INTO yjs_documents (doc_name, blob, updated_at) VALUES ($1,$2,$3)`, ['workspace:ws-orphan:note:n1', Buffer.from('blob'), new Date().toISOString()]);
  const before = (await query('SELECT COUNT(*)::int AS c FROM yjs_documents')).rows[0].c;
  assert.equal(before, 1);
  const { runGc } = require('../src/jobs/yjs-gc');
  await runGc({ now: Date.now() });
  const after = (await query('SELECT COUNT(*)::int AS c FROM yjs_documents')).rows[0].c;
  assert.equal(after, 0, 'orphaned yjs_documents should be swept');

  restoreR2();
});

test('scheduler registration respects YJS_GC_INTERVAL_MS', async () => {
  const { buildApp } = require('../src/server');
  process.env.YJS_GC_INTERVAL_MS = '0';
  const app0 = await buildApp();
  assert.ok(app0, 'buildApp with 0 should succeed');
  await app0.close();

  process.env.YJS_GC_INTERVAL_MS = '60000';
  const app1 = await buildApp();
  assert.ok(app1);
  await app1.close();
  delete process.env.YJS_GC_INTERVAL_MS;
});

test('GC never deletes an encrypted note nor publishes a snapshot it cannot build', async () => {
  await cleanTestDb();
  // An earlier test calls buildApp(), which dotenv-loads the dev .env PLAN_OVERRIDE.
  // With a paid override historyCutoffTs() is 0, nothing ages, and this test would
  // pass for the wrong reason. Mirrors test/presign-quota.test.js:222.
  delete process.env.PLAN_OVERRIDE;
  const r2Store = stubR2();
  const wsId = 'ws-gc-enc-' + crypto.randomUUID().slice(0,6);
  const owner = 'acct-gc-enc-' + crypto.randomUUID().slice(0,6);
  await seedWorkspaceWithPlan(wsId, owner, 'free'); // free => cutoff now => every row ages
  const noteId = 'note-enc';
  const oldTs = Date.now() - 100_000;
  // Real envelopes are sealed ciphertext, so they are never valid Yjs updates.
  const sealed = [Buffer.from('aabbcc11','hex'), Buffer.from('ddeeff22','hex')];
  for (let i = 0; i < sealed.length; i++) {
    await query('INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [`enc-${i}-${crypto.randomUUID()}`, wsId, noteId, sealed[i], 1, 'dev-a', i+1, oldTs+i, new Date(oldTs+i).toISOString()]);
  }

  const { runGc } = require('../src/jobs/yjs-gc');
  await runGc({ now: Date.now() });

  const kept = (await query('SELECT COUNT(*)::int AS c FROM yjs_doc_updates WHERE workspace_id=$1 AND note_id=$2', [wsId, noteId])).rows[0].c;
  assert.equal(kept, 2, 'encrypted journal rows must survive: the server cannot fold them into a snapshot');
  const state = (await query('SELECT snapshot_key FROM sync_document_state WHERE workspace_id=$1 AND note_id=$2', [wsId, noteId])).rows[0];
  assert.equal(state?.snapshot_key ?? null, null, 'GC must not publish a snapshot it failed to build');
  assert.deepEqual([...r2Store.keys()].filter((k) => k.startsWith('yjs/')), [], 'no snapshot object may be written');

  restoreR2();
});
