'use strict';

// Phase 2 — one vault key per account. The account-scoped row is adopted
// deterministically from the oldest per-workspace params the account published.
// Adoption is idempotent and NEVER deletes or rewrites the per-workspace rows,
// so old clients and already-sealed workspace data stay readable.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();
const OLDEST = '2020-01-01T00:00:00.000Z';
const NEWER = '2024-01-01T00:00:00.000Z';

async function seedWorkspace(workspaceId, accountId, blob, createdAt) {
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)',
    [workspaceId, 'name', accountId, createdAt]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    [workspaceId, accountId, 'owner', createdAt]
  );
  await query(
    `INSERT INTO vault_key_params
       (id, workspace_id, owner_id, passphrase_hash, key_params_blob, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [`params-${workspaceId}`, workspaceId, accountId, 'hash', blob, createdAt, createdAt]
  );
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();

  for (const id of ['acct-a', 'acct-b', 'acct-c']) {
    await query('INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)', [
      id,
      `${id}-email`,
      now,
    ]);
  }

  // acct-a published two different per-workspace vaults; the older one wins.
  await seedWorkspace('acct-a-ws-old', 'acct-a', 'blob-oldest', OLDEST);
  await seedWorkspace('acct-a-ws-new', 'acct-a', 'blob-newest', NEWER);

  // acct-b owns one workspace with its own vault.
  await seedWorkspace('acct-b-ws', 'acct-b', 'blob-b', OLDEST);

  // acct-b is also an editor on acct-a's oldest workspace: adoption must still
  // scope to the caller's OWN published params, never a workspace it merely
  // belongs to.
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    ['acct-a-ws-old', 'acct-b', 'editor', now]
  );
});

test.after(async () => {
  await close();
});

function headersFor(app, session) {
  return { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
}

test('adopts the oldest per-workspace params at account scope, idempotently', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });
  const session = await createSession('acct-a', { headers: {} });
  const headers = headersFor(app, session);

  const first = await app.inject({ method: 'GET', url: '/vault/account/key-params', headers });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().keyParams, 'blob-oldest');

  const second = await app.inject({ method: 'GET', url: '/vault/account/key-params', headers });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().keyParams, 'blob-oldest');
  // Same adopted row: adoption is a one-shot, not a re-derivation.
  assert.equal(second.json().id, first.json().id);

  // The per-workspace rows are untouched; nothing was deleted or rewritten.
  const { rows } = await query(
    'SELECT id, key_params_blob FROM vault_key_params WHERE workspace_id = ANY($1) ORDER BY id',
    [['acct-a-ws-old', 'acct-a-ws-new']]
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.key_params_blob).sort(),
    ['blob-newest', 'blob-oldest']
  );
});

test('scopes adoption to the caller\'s own params, never a workspace they belong to', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });
  const session = await createSession('acct-b', { headers: {} });
  const headers = headersFor(app, session);

  const res = await app.inject({ method: 'GET', url: '/vault/account/key-params', headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().keyParams, 'blob-b');
});

test('returns 404 when the account has published no vault params', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });
  const session = await createSession('acct-c', { headers: {} });
  const headers = headersFor(app, session);

  const res = await app.inject({ method: 'GET', url: '/vault/account/key-params', headers });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('publish is idempotent and refuses to rewrite an existing account vault', async (t) => {
  const app = await buildApp();
  t.after(async () => {
    await app.close();
  });
  const session = await createSession('acct-c', { headers: {} });
  const headers = headersFor(app, session);
  const url = '/vault/account/key-params';

  const published = await app.inject({ method: 'PUT', url, headers, payload: { keyParams: 'blob-c' } });
  assert.equal(published.statusCode, 200);

  const republished = await app.inject({ method: 'PUT', url, headers, payload: { keyParams: 'blob-c' } });
  assert.equal(republished.statusCode, 200);

  const conflicting = await app.inject({ method: 'PUT', url, headers, payload: { keyParams: 'blob-c-other' } });
  assert.equal(conflicting.statusCode, 409);
  assert.equal(conflicting.json().error, 'vault_already_exists');

  const read = await app.inject({ method: 'GET', url, headers });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().keyParams, 'blob-c');
});
