'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, '.test-data', 'yjs-sync-api-test.db');
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = dbPath;
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { getDb, close } = require('../src/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();

function seedAccount(id) {
  const db = getDb();
  db.prepare('INSERT INTO accounts (id, email_hmac, created_at) VALUES (?, ?, ?)').run(id, `${id}-email`, now);
}

function seedWorkspace(id, ownerId) {
  const db = getDb();
  db.prepare('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, 'name', ownerId, now);
  db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, 'owner', now);
  db.prepare('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${ownerId}-sub`, ownerId, 'pro', 'active', 1000000, 0, now);
}

async function request(app, session, url, payload, deviceId = 'device-a') {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      'x-device-id': deviceId,
      'x-workspace-id': 'workspace-1',
    },
    payload,
  });
}

test.before(async () => {
  seedAccount('account-1');
  seedWorkspace('workspace-1', 'account-1');
});

test.after(async () => {
  close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
});

test('push accepts updates, then reports an identical retry as duplicate', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const payload = {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-1', updates: [{ key: 'note-1~~device-a~~10~~1.yjs.json', data: Buffer.from('one').toString('base64'), deviceId: 'device-a', sequence: 1, ts: 10 }] }],
  };

  const first = await request(app, session, '/yjs/push-batch', payload);
  const second = await request(app, session, '/yjs/push-batch', payload);

  assert.equal(first.statusCode, 201);
  assert.deepEqual(first.json(), { accepted: 1, duplicate: 0, sizeBytes: 3, checkpoint: { ts: 10, sequence: 1, deviceId: 'device-a' } });
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.json(), { accepted: 0, duplicate: 1, sizeBytes: 0, checkpoint: { ts: 10, sequence: 1, deviceId: 'device-a' } });
  assert.equal(getDb().prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes, 3);
});

test('REST pushed envelopes are stored as opaque encrypted journal rows', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const response = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'opaque-note', updates: [{
      key: 'opaque-note~~device-a~~20~~1.yjs.json',
      data: Buffer.from('opaque-envelope').toString('base64'),
      deviceId: 'device-a', sequence: 1, ts: 20,
    }] }],
  });

  assert.equal(response.statusCode, 201);
  assert.equal(getDb().prepare(`
    SELECT update_encrypted FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND device_id = ? AND clock = ?
  `).get('workspace-1', 'opaque-note', 'device-a', 1).update_encrypted, 1);
});

test('duplicate-only retries are not rejected by quota or an untrusted workspace header', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const payload = {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-1', updates: [{ key: 'note-1~~device-a~~10~~1.yjs.json', data: Buffer.from('one').toString('base64'), deviceId: 'device-a', sequence: 1, ts: 10 }] }],
  };
  getDb().prepare('UPDATE subscriptions SET storage_quota_bytes = 3, storage_used_bytes = 3 WHERE account_id = ?').run('account-1');
  const response = await app.inject({
    method: 'POST',
    url: '/yjs/push-batch',
    headers: {
      authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      'x-device-id': 'device-a',
      'x-workspace-id': 'outsider-workspace',
    },
    payload,
  });
  getDb().prepare('UPDATE subscriptions SET storage_quota_bytes = 1000000 WHERE account_id = ?').run('account-1');

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), { accepted: 0, duplicate: 1, sizeBytes: 0, checkpoint: { ts: 10, sequence: 1, deviceId: 'device-a' } });
});

test('team and enterprise pushes charge workspace storage, including duplicate-only retries charging neither counter', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const db = getDb();

  for (const plan of ['team', 'enterprise']) {
    db.prepare('UPDATE subscriptions SET plan = ?, storage_used_bytes = 0 WHERE account_id = ?').run(plan, 'account-1');
    db.prepare('UPDATE workspaces SET storage_used_bytes = 0 WHERE id = ?').run('workspace-1');
    const payload = {
      workspaceId: 'workspace-1',
      notes: [{ noteId: `workspace-quota-${plan}`, updates: [{ key: `workspace-quota-${plan}~~device-a~~30~~1.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 30 }] }],
    };

    const first = await request(app, session, '/yjs/push-batch', payload);
    const retry = await request(app, session, '/yjs/push-batch', payload);

    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 201);
    assert.equal(db.prepare('SELECT storage_used_bytes AS bytes FROM workspaces WHERE id = ?').get('workspace-1').bytes, 1);
    assert.equal(db.prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes, 0);
  }

  db.prepare('UPDATE subscriptions SET plan = ?, storage_used_bytes = 3 WHERE account_id = ?').run('pro', 'account-1');
  db.prepare('UPDATE workspaces SET storage_used_bytes = 0 WHERE id = ?').run('workspace-1');
});

test('rolls back prepared notes and quota when persistence fails mid-transaction', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const db = getDb();
  db.prepare('UPDATE subscriptions SET plan = ?, storage_used_bytes = 3 WHERE account_id = ?').run('team', 'account-1');
  db.prepare('UPDATE workspaces SET storage_used_bytes = 7 WHERE id = ?').run('workspace-1');
  db.exec(`CREATE TRIGGER force_yjs_transaction_failure
    BEFORE INSERT ON yjs_doc_updates
    WHEN NEW.note_id = 'transaction-failure-note-b'
    BEGIN SELECT RAISE(ABORT, 'forced yjs transaction failure'); END`);

  const response = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [
      { noteId: 'transaction-failure-note-a', updates: [{ key: 'transaction-failure-note-a~~device-a~~40~~1.yjs.json', data: 'YWJj', deviceId: 'device-a', sequence: 1, ts: 40 }] },
      { noteId: 'transaction-failure-note-b', updates: [{ key: 'transaction-failure-note-b~~device-a~~41~~2.yjs.json', data: 'ZGVm', deviceId: 'device-a', sequence: 2, ts: 41 }] },
    ],
  });

  db.exec('DROP TRIGGER force_yjs_transaction_failure');
  assert.equal(response.statusCode, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM yjs_doc_updates WHERE workspace_id = ? AND note_id LIKE ?').get('workspace-1', 'transaction-failure-note-%').count, 0);
  assert.equal(db.prepare('SELECT storage_used_bytes AS bytes FROM workspaces WHERE id = ?').get('workspace-1').bytes, 7);
  assert.equal(db.prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes, 3);
  db.prepare('UPDATE subscriptions SET plan = ? WHERE account_id = ?').run('pro', 'account-1');
  db.prepare('UPDATE workspaces SET storage_used_bytes = 0 WHERE id = ?').run('workspace-1');
});

test('rejects a device identity that does not match the request header', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const response = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-2', updates: [{ key: 'note-2~~device-b~~10~~1.yjs.json', data: 'eA==', deviceId: 'device-b', sequence: 1, ts: 10 }] }],
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'device_id_mismatch');
});

test('requires membership for reads and rejects viewer writes', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  seedAccount('account-2');
  const outsiderSession = await createSession('account-2', { headers: {} });
  const outsider = await request(app, outsiderSession, '/yjs/pull-batch', { workspaceId: 'workspace-1', notes: [{ noteId: 'note-1', checkpoint: null, limit: 10 }] });
  assert.equal(outsider.statusCode, 403);
  const db = getDb();
  db.prepare('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('account-2-sub', 'account-2', 'pro', 'active', 1000000, 0, now);
  const outsiderWrite = await request(app, outsiderSession, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'outsider-note', updates: [{ key: 'outsider-note~~device-a~~1~~1.yjs.json', data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 1 }] }],
  });
  assert.equal(outsiderWrite.statusCode, 403);

  db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)').run('workspace-1', 'account-2', 'viewer', now);
  const viewer = await request(app, outsiderSession, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-1', updates: [{ key: 'note-1~~device-a~~11~~2.yjs.json', data: 'eA==', deviceId: 'device-a', sequence: 2, ts: 11 }] }],
  });
  assert.equal(viewer.statusCode, 403);
});

test('validates every note before storing any note', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const response = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [
      { noteId: 'rollback-note-a', updates: [{ key: 'rollback-note-a~~device-a~~20~~1.yjs.json', data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 20 }] },
      { noteId: 'rollback-note-b', updates: [{ key: 'rollback-note-b~~device-a~~21~~2.yjs.json', data: 'not-base64!', deviceId: 'device-a', sequence: 2, ts: 21 }] },
    ],
  });

  assert.equal(response.statusCode, 400);
  assert.equal(await require('../src/persistence/yjs').getUpdateCount('workspace-1', 'rollback-note-a'), 0);
  assert.equal(getDb().prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes, 3);
});

test('rejects malformed keys and unsafe numeric fields', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const malformedKey = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-invalid', updates: [{ key: 'wrong-key', data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 1 }] }],
  });
  assert.equal(malformedKey.statusCode, 400);
  assert.equal(malformedKey.json().error, 'malformed_update_key');

  const unsafeNumber = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-invalid', updates: [{ key: `note-invalid~~device-a~~${Number.MAX_SAFE_INTEGER + 1}~~1.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence: 1, ts: Number.MAX_SAFE_INTEGER + 1 }] }],
  });
  assert.equal(unsafeNumber.statusCode, 400);
});

test('pull returns bounded pages and a retry of the checkpoint is stable', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: {} });
  const push = await request(app, session, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'note-pages', updates: [1, 2, 3].map((sequence) => ({ key: `note-pages~~device-a~~${sequence}~~${sequence}.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence, ts: sequence })) }],
  });
  assert.equal(push.statusCode, 201);

  const first = await request(app, session, '/yjs/pull-batch', { workspaceId: 'workspace-1', notes: [{ noteId: 'note-pages', checkpoint: null, limit: 2 }] });
  assert.equal(first.statusCode, 200);
  const page = first.json().notes['note-pages'];
  assert.equal(page.updates.length, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCheckpoint, { 'device-a': { ts: 2, sequence: 2 } });

  const retry = await request(app, session, '/yjs/pull-batch', { workspaceId: 'workspace-1', notes: [{ noteId: 'note-pages', checkpoint: page.nextCheckpoint, limit: 2 }] });
  assert.deepEqual(retry.json().notes['note-pages'].updates.map((update) => update.key), ['note-pages~~device-a~~3~~3.yjs.json']);
});

test('pull filters each device independently when timestamps are interleaved', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('account-1', { headers: { 'x-device-id': 'device-a' } });
  const payload = {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'interleaved', updates: [
      { key: 'interleaved~~device-a~~100~~1.yjs.json', data: 'YQ==', deviceId: 'device-a', sequence: 1, ts: 100 },
      { key: 'interleaved~~device-b~~50~~1.yjs.json', data: 'Yg==', deviceId: 'device-b', sequence: 1, ts: 50 },
    ] }],
  };
  assert.equal((await request(app, session, '/yjs/push-batch', payload, 'device-a')).statusCode, 400);
  const deviceBSession = await createSession('account-1', { headers: { 'x-device-id': 'device-b' } });
  assert.equal((await request(app, deviceBSession, '/yjs/push-batch', {
    workspaceId: 'workspace-1',
    notes: [{ noteId: 'interleaved', updates: [payload.notes[0].updates[1]] }],
  }, 'device-b')).statusCode, 201);
  const first = await request(app, session, '/yjs/pull-batch', {
    workspaceId: 'workspace-1', notes: [{ noteId: 'interleaved', checkpoint: {
      'device-a': { ts: 100, sequence: 1 },
    }, limit: 10 }],
  }, 'device-a');
  assert.deepEqual(first.json().notes.interleaved.updates.map((update) => update.key), ['interleaved~~device-b~~50~~1.yjs.json']);
});

test('reserves quota atomically when concurrent pushes race for the last byte', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const db = getDb();
  db.prepare('UPDATE subscriptions SET plan = ?, storage_quota_bytes = 1, storage_used_bytes = 0 WHERE account_id = ?').run('pro', 'account-1');
  const session = await createSession('account-1', { headers: { 'x-device-id': 'device-a' } });
  const makePayload = (noteId) => ({ workspaceId: 'workspace-1', notes: [{ noteId, updates: [{ key: `${noteId}~~device-a~~${noteId === 'quota-a' ? 60 : 61}~~1.yjs.json`, data: 'eA==', deviceId: 'device-a', sequence: 1, ts: noteId === 'quota-a' ? 60 : 61 }] }] });
  const responses = await Promise.all([
    request(app, session, '/yjs/push-batch', makePayload('quota-a')),
    request(app, session, '/yjs/push-batch', makePayload('quota-b')),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 507]);
  assert.equal(db.prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM yjs_doc_updates WHERE note_id LIKE ?').get('quota-%').count, 1);
  db.prepare('UPDATE subscriptions SET storage_quota_bytes = 1000000 WHERE account_id = ?').run('account-1');
});

test('binds a device header to its session and enforces the account device limit', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const db = getDb();
  db.prepare('UPDATE subscriptions SET plan = ?, storage_quota_bytes = 1000000 WHERE account_id = ?').run('basic', 'account-1');
  const boundSession = await createSession('account-1', { headers: { 'x-device-id': 'bound-device' } });
  const mismatch = await request(app, boundSession, '/yjs/push-batch', {
    workspaceId: 'workspace-1', notes: [{ noteId: 'device-mismatch', updates: [{ key: 'device-mismatch~~other-device~~70~~1.yjs.json', data: 'eA==', deviceId: 'other-device', sequence: 1, ts: 70 }] }],
  }, 'other-device');
  assert.equal(mismatch.statusCode, 403);
  db.prepare('DELETE FROM devices WHERE account_id = ?').run('account-1');
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO devices (id, account_id, device_id, label, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`device-limit-${i}`, 'account-1', `existing-${i}`, 'test', now, now);
  const limitedSession = await createSession('account-1', { headers: { 'x-device-id': 'new-device' } });
  const limited = await request(app, limitedSession, '/yjs/push-batch', {
    workspaceId: 'workspace-1', notes: [{ noteId: 'device-limit', updates: [{ key: 'device-limit~~new-device~~71~~1.yjs.json', data: 'eA==', deviceId: 'new-device', sequence: 1, ts: 71 }] }],
  }, 'new-device');
  assert.equal(limited.statusCode, 403);
  db.prepare('DELETE FROM devices WHERE account_id = ?').run('account-1');
  db.prepare('UPDATE subscriptions SET plan = ?, storage_used_bytes = 0 WHERE account_id = ?').run('pro', 'account-1');
});
