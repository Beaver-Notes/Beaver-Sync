'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beaver-sync-task7-'));

process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.STORAGE_BACKEND = 'minio';
process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:0';
process.env.STORAGE_BUCKET_NAME = 'integration-test';
process.env.STORAGE_ACCESS_KEY_ID = 'test-access';
process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { createSession } = require('../src/middleware/auth');

const ids = { account: 'bootstrap-owner', workspace: 'bootstrap-workspace', note: 'bootstrap-note' };
const deviceId = 'bootstrap-device';

async function seed() {
  const now = new Date().toISOString();
  await query('INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)', [ids.account, 'bootstrap-email', now]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', [ids.workspace, 'encrypted-workspace', ids.account, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', [ids.workspace, ids.account, 'owner', now]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', ['bootstrap-subscription', ids.account, 'pro', 'active', 10_000_000, 0, now]);
  await query('INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4)', [ids.workspace, 'empty', 0, now]);
}

function update(sequence) {
  const ts = 100 + sequence;
  return {
    key: `${ids.note}~~${deviceId}~~${ts}~~${sequence}.yjs.json`,
    data: Buffer.from(`encrypted-yjs-${sequence}`).toString('base64'),
    deviceId,
    sequence,
    ts,
  };
}

async function request(app, session, url, payload, method = 'POST') {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${session}`,
      'content-type': 'application/json',
      'x-device-id': deviceId,
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

test('bootstraps, completes, pushes, replays, and pulls every update exactly once', async (t) => {
  const expectedKeys = new Set([
    `${ids.account}/snapshot.json`,
    `${ids.account}/yjs/${ids.note}~~${deviceId}~~101~~1.yjs.json`,
    `${ids.account}/yjs/${ids.note}~~${deviceId}~~102~~2.yjs.json`,
    `yjs/${ids.workspace}/${ids.note}/1.yjs`,
  ]);
  const storageRequests = [];
  const storage = http.createServer((req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
      .replace(/^\/integration-test\/?/, '');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      storageRequests.push({ method: req.method, key, bodyLength: body.length });
      if (req.method === 'HEAD' && (key === '' || expectedKeys.has(key))) {
        res.statusCode = 200;
        if (key === `yjs/${ids.workspace}/${ids.note}/1.yjs`) {
          res.setHeader('content-length', '26');
        }
      } else if (['GET', 'DELETE'].includes(req.method) && expectedKeys.has(key)) {
        res.statusCode = 404;
      } else if (req.method === 'PUT' && expectedKeys.has(key) && body.length > 0) {
        res.statusCode = 200;
      } else {
        res.statusCode = 400;
      }
      res.end();
    });
  });
  await new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve));
  process.env.STORAGE_ENDPOINT = `http://127.0.0.1:${storage.address().port}`;
  const { buildApp } = require('../src/server');
  const objectStorage = require('../src/services/r2');

  await setupTestDb();
  await cleanTestDb();
  await seed();
  let app;
  t.after(async () => {
    if (app) await app.close();
    await new Promise((resolve) => storage.close(resolve));
    await close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  await objectStorage.put(`${ids.account}/snapshot.json`, Buffer.from('snapshot-fixture'));
  await objectStorage.stat(`${ids.account}/snapshot.json`);
  await objectStorage.put(`${ids.account}/yjs/${firstStorageKey()}`, Buffer.from('encrypted-yjs-1'));
  await objectStorage.stat(`${ids.account}/yjs/${firstStorageKey()}`);

  const session = await createSession(ids.account, { headers: {} });
  const claim = await request(app, session, '/sync/initialize/claim', { workspaceId: ids.workspace });
  assert.equal(claim.statusCode, 200);

  const snapshot = await request(app, session, '/sync/initialize/snapshot', {
    workspaceId: ids.workspace,
    token: claim.json().token,
    noteId: ids.note,
    generation: 1,
    data: Buffer.from('encrypted-initial-snapshot').toString('base64'),
  });
  assert.equal(snapshot.statusCode, 200);

  const complete = await request(app, session, '/sync/initialize/complete', {
    workspaceId: ids.workspace,
    token: claim.json().token,
    generation: 1,
    documents: [{ noteId: ids.note, snapshotGeneration: 1, snapshotKey: snapshot.json().key }],
  });
  assert.equal(complete.statusCode, 200);

  const firstUpdate = update(1);
  const secondUpdate = update(2);
  const push = (updates) => request(app, session, '/yjs/push-batch', {
    workspaceId: ids.workspace,
    notes: [{ noteId: ids.note, updates }],
  });
  const pushRes1 = (await push([firstUpdate, secondUpdate])).json();
  assert.equal(pushRes1.accepted, 2);
  assert.equal(pushRes1.duplicate, 0);
  assert.equal(pushRes1.sizeBytes, 30);
  assert.deepEqual(pushRes1.checkpoint, { ts: 102, sequence: 2, deviceId });

  const pushRes2 = (await push([firstUpdate])).json();
  assert.equal(pushRes2.accepted, 0);
  assert.equal(pushRes2.duplicate, 1);
  assert.equal(pushRes2.sizeBytes, 0);
  assert.deepEqual(pushRes2.checkpoint, { ts: 101, sequence: 1, deviceId });

  const seen = [];
  let checkpoint = null;
  let hasMore = true;
  while (hasMore) {
    const response = await request(app, session, '/yjs/pull-batch', {
      workspaceId: ids.workspace,
      notes: [{ noteId: ids.note, checkpoint, limit: 1 }],
    });
    assert.equal(response.statusCode, 200);
    const page = response.json().notes[ids.note];
    seen.push(...page.updates.map((entry) => entry.key));
    checkpoint = page.nextCheckpoint;
    hasMore = page.hasMore;
  }

  assert.deepEqual(seen, [firstUpdate.key, secondUpdate.key]);
  assert.equal(new Set(seen).size, 2);
  assert.deepEqual(checkpoint, { [deviceId]: { ts: 102, sequence: 2 } });
  assert.notEqual(storageRequests.length, 0);
  assert.deepEqual(storageRequests, [
    { method: 'PUT', key: `${ids.account}/snapshot.json`, bodyLength: 16 },
    { method: 'HEAD', key: `${ids.account}/snapshot.json`, bodyLength: 0 },
    { method: 'PUT', key: `${ids.account}/yjs/${firstStorageKey()}`, bodyLength: 15 },
    { method: 'HEAD', key: `${ids.account}/yjs/${firstStorageKey()}`, bodyLength: 0 },
    { method: 'PUT', key: `yjs/${ids.workspace}/${ids.note}/1.yjs`, bodyLength: 26 },
    { method: 'HEAD', key: `yjs/${ids.workspace}/${ids.note}/1.yjs`, bodyLength: 0 },
    { method: 'HEAD', key: `yjs/${ids.workspace}/${ids.note}/1.yjs`, bodyLength: 0 },
  ]);
});

function firstStorageKey() {
  return `${ids.note}~~${deviceId}~~101~~1.yjs.json`;
}
