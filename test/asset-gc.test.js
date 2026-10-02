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

const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { query } = require('../src/db/postgres');
const r2 = require('../src/services/r2');
const { decodeAssetKey, isFilenameHash } = require('../src/routes/assets-shared');
const { createNoteHash } = require('../src/lib/crypto');
const {
  getAssetGcIntervalMs,
  getGraceMs,
  splitAssetObject,
  selectOrphanAssets,
  runAssetGc,
} = require('../src/jobs/asset-gc');

const DAY_MS = 24 * 60 * 60 * 1000;

let origListObjects, origDelMany;
function stubR2(objects, deleted) {
  origListObjects = r2.listObjects;
  origDelMany = r2.delMany;
  r2.listObjects = async () => objects.map((o) => ({ size: 0, ...o }));
  r2.delMany = async (keys) => {
    for (const k of keys) deleted.push(k);
    return { deleted: keys.length, failed: 0 };
  };
}
function restoreR2() {
  if (origListObjects) r2.listObjects = origListObjects;
  if (origDelMany) r2.delMany = origDelMany;
  origListObjects = undefined;
  origDelMany = undefined;
}

test.before(async () => {
  await setupTestDb();
});

test.after(async () => {
  restoreR2();
  delete process.env.ASSET_GC_INTERVAL_MS;
  delete process.env.ASSET_GC_GRACE_DAYS;
  delete process.env.ASSET_GC_DRY_RUN;
  const { close } = require('../src/db');
  await close();
});

test('getAssetGcIntervalMs respects env 0=off', () => {
  delete process.env.ASSET_GC_INTERVAL_MS;
  assert.equal(getAssetGcIntervalMs(), 0);
  process.env.ASSET_GC_INTERVAL_MS = '0';
  assert.equal(getAssetGcIntervalMs(), 0);
  process.env.ASSET_GC_INTERVAL_MS = '60000';
  assert.equal(getAssetGcIntervalMs(), 60000);
  process.env.ASSET_GC_INTERVAL_MS = 'nonsense';
  assert.equal(getAssetGcIntervalMs(), 0);
});

test('getGraceMs defaults to 30 days and honors override', () => {
  delete process.env.ASSET_GC_GRACE_DAYS;
  assert.equal(getGraceMs(), 30 * DAY_MS);
  process.env.ASSET_GC_GRACE_DAYS = '7';
  assert.equal(getGraceMs(), 7 * DAY_MS);
  process.env.ASSET_GC_GRACE_DAYS = '-1';
  assert.equal(getGraceMs(), 30 * DAY_MS, 'invalid values fall back to 30d');
});

test('decodeAssetKey parses workspace-scoped and legacy keys', () => {
  const scoped = decodeAssetKey('assets--ws-1--note_1--photo%20(1).png');
  assert.deepEqual(scoped, {
    type: 'assets',
    workspaceId: 'ws-1',
    noteId: 'note_1',
    filename: 'photo (1).png',
  });

  const legacy = decodeAssetKey('assets--note_1--photo%20(1).png');
  assert.equal(legacy.workspaceId, null);
  assert.equal(legacy.noteId, 'note_1');
  assert.equal(legacy.filename, 'photo (1).png');

  assert.equal(decodeAssetKey('assets--note_1'), null);
  assert.equal(decodeAssetKey('a--b--c--d--e'), null);
  assert.equal(decodeAssetKey('assets--bad%2'), null);
  assert.equal(decodeAssetKey('assets/ws/note'), null);
});

test('new-scheme hashed keys are recognised and decode to a real workspace+note', () => {
  // A canonical 32-byte base64url hash: exactly the new-scheme final segment.
  const hash = Buffer.alloc(32).toString('base64url');
  assert.equal(hash.length, 43);
  assert.equal(isFilenameHash(hash), true);
  assert.equal(isFilenameHash('photo%20(1).png'), false);
  assert.equal(isFilenameHash('A'.repeat(42)), false);

  const key = `assets--ws-1--orphan-note--${hash}`;
  assert.deepEqual(
    decodeAssetKey(key),
    { type: 'assets', workspaceId: 'ws-1', noteId: 'orphan-note', filename: null, hashed: true },
    'the workspace+note are recoverable even though the filename is a one-way hash'
  );
});

test('selectOrphanAssets prunes a new-scheme dead note after grace and keeps a live one', () => {
  const now = 1_000 * DAY_MS;
  const graceMs = 30 * DAY_MS;
  const old = new Date(now - 60 * DAY_MS).toISOString();
  const fresh = new Date(now - 1 * DAY_MS).toISOString();
  const hash = Buffer.alloc(32, 7).toString('base64url');
  const deadKey = `assets--ws-1--dead-note--${hash}`;
  const liveKey = `assets--ws-1--live-note--${hash}`;
  const freshKey = `assets--ws-1--fresh-note--${hash}`;
  const existing = {
    keys: new Set(['ws-1\u0000live-note']),
    noteIds: new Set(['live-note']),
  };

  const orphans = selectOrphanAssets(
    [
      { assetKey: deadKey, lastModified: old },
      { assetKey: liveKey, lastModified: old },
      { assetKey: freshKey, lastModified: fresh },
    ],
    existing,
    { graceMs, now }
  );
  assert.deepEqual(orphans.map((o) => o.assetKey), [deadKey]);
});

test('a legacy opaque token is never a new-scheme GC candidate', () => {
  const now = 1_000 * DAY_MS;
  const old = new Date(now - 60 * DAY_MS).toISOString();
  // A real opaque token is base64url(24-byte nonce || ciphertext), so it decodes
  // to well over 40 bytes. The base64url alphabet includes '-', so about 2% of
  // real tokens contain '--' and therefore look like a 3-segment legacy key
  // (ty--note--file). This one does, so the case is deterministic instead of
  // random: the token shape is the whole point of the test.
  const opaque =
    'assets--jDDmNyi51HAGc--FHE1wUbarIvcTFlGs8OuxHxHw4cPdH5mlqUD8fHZD1shwbVzC';

  const orphans = selectOrphanAssets(
    [{ assetKey: opaque, lastModified: old }],
    { keys: new Set(), noteIds: new Set() },
    { graceMs: 30 * DAY_MS, now }
  );
  assert.deepEqual(orphans, [], 'an opaque legacy asset must never be GC-deleted');
});

test('splitAssetObject extracts user and key, rejects non-assets', () => {
  assert.deepEqual(splitAssetObject('user-1/assets/assets--ws-1--n1--a.png'), {
    userId: 'user-1',
    assetKey: 'assets--ws-1--n1--a.png',
  });
  assert.equal(splitAssetObject('user-1/commits/abc.json'), null);
  assert.equal(splitAssetObject('/assets/a'), null);
  assert.equal(splitAssetObject('user-1/assets/'), null);
});

test('selectOrphanAssets honors existence and grace period', () => {
  const now = 1_000 * DAY_MS;
  const graceMs = 30 * DAY_MS;
  const old = new Date(now - 60 * DAY_MS).toISOString();
  const fresh = new Date(now - 1 * DAY_MS).toISOString();
  const existing = {
    keys: new Set(['ws-1\u0000live-note']),
    noteIds: new Set(['live-note']),
  };

  // Opaque keys reveal no workspace/note id, so the server cannot prove an
  // asset is an orphan. It must leave them alone (safe) rather than guess.
  const opaque = 'assets--' + crypto.randomBytes(80).toString('base64url');
  const objects = [
    { assetKey: 'assets--ws-1--live-note--a.png', lastModified: old },
    { assetKey: 'assets--ws-1--orphan-note--b.png', lastModified: old },
    { assetKey: 'assets--ws-1--orphan2--c.png', lastModified: fresh },
    { assetKey: 'assets--dead-note--d.png', lastModified: old },
    { assetKey: 'assets--live-note--e.png', lastModified: old },
    { assetKey: 'commits--not-an-asset', lastModified: old },
    { assetKey: opaque, lastModified: old },
  ];

  const orphans = selectOrphanAssets(objects, existing, { graceMs, now });
  const keys = orphans.map((o) => o.assetKey);
  assert.deepEqual(keys, [
    'assets--ws-1--orphan-note--b.png',
    'assets--dead-note--d.png',
  ]);
  assert.ok(!keys.includes(opaque), 'an opaque live asset must never be GC-deleted');
});

test('runAssetGc does not delete in dry-run, deletes orphans when armed', async () => {
  await cleanTestDb();
  const wsId = 'ws-asset-gc-' + crypto.randomUUID().slice(0, 6);
  const owner = 'acct-asset-gc-' + crypto.randomUUID().slice(0, 6);
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [owner, `${owner}-hmac`, new Date().toISOString(), true]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', owner, new Date().toISOString()]);
  await query(
    'INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [`id-${crypto.randomUUID()}`, wsId, 'live-note', Buffer.from('x'), 0, 'dev-a', 1, 1000, new Date().toISOString()]
  );

  const old = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const objects = [
    { key: `${owner}/assets/assets--${wsId}--live-note--a.png`, assetKey: `assets--${wsId}--live-note--a.png`, lastModified: old },
    { key: `${owner}/assets/assets--${wsId}--orphan--b.png`, assetKey: `assets--${wsId}--orphan--b.png`, lastModified: old },
  ];

  // Dry run (default): nothing deleted.
  let deleted = [];
  stubR2(objects, deleted);
  process.env.ASSET_GC_DRY_RUN = 'true';
  const dry = await runAssetGc({ now: Date.now() });
  assert.equal(dry.orphans, 1, 'one orphan identified');
  assert.equal(dry.deleted, 0);
  assert.equal(deleted.length, 0, 'dry-run must not delete');
  restoreR2();

  // Armed: only the orphan is deleted.
  deleted = [];
  stubR2(objects, deleted);
  process.env.ASSET_GC_DRY_RUN = 'false';
  const armed = await runAssetGc({ now: Date.now() });
  assert.equal(armed.orphans, 1);
  assert.equal(armed.deleted, 1);
  assert.deepEqual(deleted, [`${owner}/assets/assets--${wsId}--orphan--b.png`]);
  restoreR2();

  delete process.env.ASSET_GC_DRY_RUN;
});

test('runAssetGc prunes a new-scheme dead-note orphan in dry-run then armed', async () => {
  await cleanTestDb();
  const wsId = 'ws-asset-gc-new-' + crypto.randomUUID().slice(0, 6);
  const owner = 'acct-asset-gc-new-' + crypto.randomUUID().slice(0, 6);
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [owner, `${owner}-hmac`, new Date().toISOString(), true]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', owner, new Date().toISOString()]);
  await query(
    'INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [`id-${crypto.randomUUID()}`, wsId, 'live-note', Buffer.from('x'), 0, 'dev-a', 1, 1000, new Date().toISOString()]
  );

  const hash = Buffer.alloc(32, 9).toString('base64url');
  const old = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const deadKey = `assets--${wsId}--dead-note--${hash}`;
  const liveKey = `assets--${wsId}--live-note--${hash}`;
  const objects = [
    { key: `${owner}/assets/${liveKey}`, assetKey: liveKey, lastModified: old },
    { key: `${owner}/assets/${deadKey}`, assetKey: deadKey, lastModified: old },
  ];

  let deleted = [];
  stubR2(objects, deleted);
  process.env.ASSET_GC_DRY_RUN = 'true';
  const dry = await runAssetGc({ now: Date.now() });
  assert.equal(dry.orphans, 1, 'the dead-note new-scheme key is the only orphan');
  assert.equal(dry.deleted, 0);
  assert.equal(deleted.length, 0, 'dry-run must not delete');
  restoreR2();

  deleted = [];
  stubR2(objects, deleted);
  process.env.ASSET_GC_DRY_RUN = 'false';
  const armed = await runAssetGc({ now: Date.now() });
  assert.equal(armed.orphans, 1);
  assert.equal(armed.deleted, 1);
  assert.deepEqual(deleted, [`${owner}/assets/${deadKey}`], 'the live note is kept');
  restoreR2();

  delete process.env.ASSET_GC_DRY_RUN;
});

test('a note synced only via commits keeps its assets', async () => {
  await cleanTestDb();
  const wsId = 'ws-gc-commit-' + crypto.randomUUID().slice(0, 6);
  const owner = 'acct-gc-commit-' + crypto.randomUUID().slice(0, 6);
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [owner, `${owner}-hmac`, new Date().toISOString(), true]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', owner, new Date().toISOString()]);
  const noteId = `commit-only-note-${crypto.randomUUID()}`;
  // The note exists only as a commit (no yjs_doc_updates / sync_document_state row).
  await query(
    'INSERT INTO commits (commit_id, account_id, device_id, note_id_hash, workspace_id, clock, ts, size_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [`${Date.now()}-dev-a-1`, owner, 'dev-a', createNoteHash(noteId), wsId, 1, Date.now(), 10, new Date().toISOString()]
  );

  const old = new Date(Date.now() - 60 * DAY_MS).toISOString();
  const objects = [
    { key: `${owner}/assets/assets--${wsId}--${noteId}--a.png`, assetKey: `assets--${wsId}--${noteId}--a.png`, lastModified: old },
  ];

  const deleted = [];
  stubR2(objects, deleted);
  process.env.ASSET_GC_DRY_RUN = 'false';
  const res = await runAssetGc({ now: Date.now() });
  assert.equal(res.orphans, 0, 'a note with only commit evidence must count as existing');
  assert.equal(deleted.length, 0, 'live commit-synced assets must never be deleted');
  restoreR2();
  delete process.env.ASSET_GC_DRY_RUN;
});

test('scheduler registration respects ASSET_GC_INTERVAL_MS', async () => {
  const { buildApp } = require('../src/server');
  process.env.ASSET_GC_INTERVAL_MS = '0';
  const app0 = await buildApp();
  assert.ok(app0);
  await app0.close();

  process.env.ASSET_GC_INTERVAL_MS = '60000';
  const app1 = await buildApp();
  assert.ok(app1);
  await app1.close();
  delete process.env.ASSET_GC_INTERVAL_MS;
});
