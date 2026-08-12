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
process.env.LEGACY_AUTH_ENABLED = 'true';

const { buildApp } = require('../src/server');
const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const models = require('../src/models');
const { hashSessionId } = require('../src/lib/crypto');

const users = {
  owner: 'sync-owner',
  member: 'sync-member',
  outsider: 'sync-outsider',
};

async function seedDatabase() {
  const now = new Date().toISOString();
  for (const id of Object.values(users)) {
    await query('INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)', [id, `${id}-email`, now]);
  }
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', ['sync-workspace', 'encrypted-name', users.owner, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', ['sync-workspace', users.owner, 'owner', now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', ['sync-workspace', users.member, 'editor', now]);
  await query('INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4)', ['sync-workspace', 'empty', 0, now]);
}

async function resetWorkspaceState() {
  const now = new Date().toISOString();
  await query('DELETE FROM sync_document_state WHERE workspace_id = $1', ['sync-workspace']);
  await query(`
    UPDATE sync_workspace_state
    SET status = 'empty', generation = 0, initialization_token = NULL,
        initialization_expires_at = NULL, updated_at = $1
    WHERE workspace_id = $2
  `, [now, 'sync-workspace']);
}

function authFor(userId) {
  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  models.Session.findOne = async ({ idHash }) => idHash === sessionIdHash ? {
    idHash,
    accountId: userId,
    revoked: false,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    save: async () => {},
  } : null;
  return `Bearer ${rawId}`;
}

async function request(app, method, url, userId, payload) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: authFor(userId),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

async function unauthenticatedRequest(app, method, url, payload) {
  return app.inject({
    method,
    url,
    ...(payload ? { headers: { 'content-type': 'application/json' }, payload } : {}),
  });
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedDatabase();
});
test.beforeEach(async () => {
  await resetWorkspaceState();
});

test.after(async () => {
  await close();
});

test('a workspace member can read sync state', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const response = await request(app, 'GET', '/sync/state?workspaceId=sync-workspace', users.member);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    workspaceId: 'sync-workspace',
    status: 'empty',
    generation: 0,
    documents: [],
    vault: null,
  });
});

test('a non-member cannot read sync state', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const response = await request(app, 'GET', '/sync/state?workspaceId=sync-workspace', users.outsider);
  assert.equal(response.statusCode, 403);
});

test('unauthenticated state, claim, and complete requests are rejected', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  assert.equal((await unauthenticatedRequest(app, 'GET', '/sync/state?workspaceId=sync-workspace')).statusCode, 401);
  assert.equal((await unauthenticatedRequest(app, 'POST', '/sync/initialize/claim', {
    workspaceId: 'sync-workspace',
  })).statusCode, 401);
  assert.equal((await unauthenticatedRequest(app, 'POST', '/sync/initialize/complete', {
    workspaceId: 'sync-workspace', token: 'token', generation: 1, documents: [],
  })).statusCode, 401);
});

test('only the owner can claim initialization and a second claim is rejected', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const memberResponse = await request(app, 'POST', '/sync/initialize/claim', users.member, { workspaceId: 'sync-workspace' });
  assert.equal(memberResponse.statusCode, 403);

  const first = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  assert.equal(first.statusCode, 200);
  assert.match(first.json().token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(new Date(first.json().expiresAt).getTime() - Date.now() > 4 * 60_000, true);

  const second = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'sync_already_initialized');
});

test('an expired claim can be reclaimed', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await query('UPDATE sync_workspace_state SET initialization_expires_at = $1 WHERE workspace_id = $2', [new Date(Date.now() - 1_000).toISOString(), 'sync-workspace']);
  const response = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  assert.equal(response.statusCode, 200);
});

test('completion rejects documents from a different snapshot generation', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token: claim.json().token, generation: 3,
    documents: [{ noteId: 'note-1', snapshotGeneration: 2 }],
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'validation_error');
});

test('completion rejects a missing or invalid declared snapshot object', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token: claim.json().token, generation: 1,
    documents: [{ noteId: 'note-1', snapshotGeneration: 1, snapshotKey: 'not-a-snapshot-key' }],
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_snapshot_key');
});

test('completion rejects a declared snapshot absent from object storage', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token: claim.json().token, generation: 1,
    documents: [{ noteId: 'note-1', snapshotGeneration: 1, snapshotKey: 'yjs/sync-workspace/note-1/1.yjs' }],
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'snapshot_missing');
});

test('completion rejects invalid document fields and generations', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const invalidDocuments = [
    { noteId: '', snapshotGeneration: 1 },
    { noteId: 'note-1', snapshotGeneration: -1 },
    { noteId: 'note-1', snapshotGeneration: 1.5 },
    { noteId: 'note-1', snapshotGeneration: 1, checkpointTs: -1 },
  ];
  for (const document of invalidDocuments) {
    const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
      workspaceId: 'sync-workspace', token: 'unused', generation: 1, documents: [document],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'validation_error');
  }
});

test('an expired completion claim is rejected and leaves the workspace initializing', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  await query('UPDATE sync_workspace_state SET initialization_expires_at = $1 WHERE workspace_id = $2', [new Date(Date.now() - 1_000).toISOString(), 'sync-workspace']);
  const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token: claim.json().token, generation: 1, documents: [],
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'initialization_token_expired');
  assert.equal((await query('SELECT status FROM sync_workspace_state WHERE workspace_id = $1', ['sync-workspace'])).rows[0].status, 'initializing');
});

test('a completion database failure rolls back document rows and initialization', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  await query(`CREATE OR REPLACE FUNCTION fail_sync_document_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.note_id = 'note-2' THEN
        RAISE EXCEPTION 'forced completion failure';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await query(`CREATE TRIGGER fail_sync_document_insert
    BEFORE INSERT ON sync_document_state
    FOR EACH ROW EXECUTE FUNCTION fail_sync_document_insert()`);
  try {
    const response = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
      workspaceId: 'sync-workspace', token: claim.json().token, generation: 1,
      documents: [
        { noteId: 'note-1', snapshotGeneration: 1 },
        { noteId: 'note-2', snapshotGeneration: 1 },
      ],
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await query('DROP TRIGGER IF EXISTS fail_sync_document_insert ON sync_document_state');
    await query('DROP FUNCTION IF EXISTS fail_sync_document_insert()');
  }
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM sync_document_state WHERE workspace_id = $1', ['sync-workspace'])).rows[0].count, 0);
  assert.equal((await query('SELECT status FROM sync_workspace_state WHERE workspace_id = $1', ['sync-workspace'])).rows[0].status, 'initializing');
});

test('state reads include persisted workspace and document mappings', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await query(`
    INSERT INTO sync_document_state
      (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, ['sync-workspace', 'persisted-note', 4, 'snapshot-key', 123, 9, new Date().toISOString()]);
  await query(`
    UPDATE sync_workspace_state
    SET status = 'initialized', generation = 4, updated_at = $1
    WHERE workspace_id = $2
  `, [new Date().toISOString(), 'sync-workspace']);

  const response = await request(app, 'GET', '/sync/state?workspaceId=sync-workspace', users.member);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'initialized');
  assert.equal(response.json().generation, 4);
  assert.deepEqual(response.json().documents, [{
    noteId: 'persisted-note', snapshotGeneration: 4, snapshotKey: 'snapshot-key',
    checkpointTs: 123, checkpointSequence: 9,
  }]);
});

test('completion rejects the wrong token and atomically initializes an empty mapping', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await query('UPDATE sync_workspace_state SET initialization_expires_at = $1 WHERE workspace_id = $2', [new Date(Date.now() - 1_000).toISOString(), 'sync-workspace']);
  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  const { token } = claim.json();
  const wrong = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token: 'wrong-token', generation: 1, documents: [],
  });
  assert.equal(wrong.statusCode, 403);

  const complete = await request(app, 'POST', '/sync/initialize/complete', users.owner, {
    workspaceId: 'sync-workspace', token, generation: 1, documents: [],
  });
  assert.equal(complete.statusCode, 200);

  const state = await request(app, 'GET', '/sync/state?workspaceId=sync-workspace', users.member);
  assert.equal(state.json().status, 'initialized');
  assert.equal(state.json().generation, 1);
  assert.deepEqual(state.json().documents, []);
});

test('snapshot-urls returns presigned URLs for batch upload', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  assert.equal(claim.statusCode, 200);
  const { token } = claim.json();

  const response = await request(app, 'POST', '/sync/initialize/snapshot-urls', users.owner, {
    workspaceId: 'sync-workspace',
    token,
    noteIds: ['meta', 'note-1', 'note-2'],
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.generation, 1);
  assert.ok(body.urls);
  assert.ok(body.urls['meta']);
  assert.ok(body.urls['note-1']);
  assert.ok(body.urls['note-2']);
  assert.ok(body.urls['meta'].url.includes('X-Amz'));
  assert.ok(body.urls['meta'].key.startsWith('yjs/sync-workspace/meta/'));
});

test('snapshot-urls rejects invalid token', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });

  const response = await request(app, 'POST', '/sync/initialize/snapshot-urls', users.owner, {
    workspaceId: 'sync-workspace',
    token: 'wrong-token',
    noteIds: ['meta'],
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'invalid_initialization_token');
});

test('snapshot-urls rejects non-owner', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const claim = await request(app, 'POST', '/sync/initialize/claim', users.owner, { workspaceId: 'sync-workspace' });
  const { token } = claim.json();

  const response = await request(app, 'POST', '/sync/initialize/snapshot-urls', users.member, {
    workspaceId: 'sync-workspace',
    token,
    noteIds: ['meta'],
  });
  assert.equal(response.statusCode, 403);
});
