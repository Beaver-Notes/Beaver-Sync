'use strict';

// TDD test for Task 3: a server-side key-distribution queue so a newly-linked
// device can ask an existing online device of the same account to re-wrap the
// note's content key for its new device id.
//
// This repo uses `node --test` (no vitest) with the real harness (buildApp,
// setupTestDb, createSession) and the real `/collaboration` route prefix. The
// helpers below are built inline following Task 1/Task 2's device-keys and
// note-keys-fanout tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

async function makeAccount(tag) {
  const id = `kdist-${tag}-${crypto.randomUUID()}`;
  const emailHmac = `kdist-hmac-${tag}-${crypto.randomUUID()}`;
  await query(
    'INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)',
    [id, emailHmac, new Date().toISOString()]
  );
  return id;
}

async function authHeaders(accountId) {
  const session = await createSession(accountId, { headers: {} });
  return { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
}

// Seed a note owned by a fresh account that is a collaborator on it, so it can
// exercise the distribution-request routes (which require collaborator
// membership). A freshly-created note has no key envelopes yet.
async function seedNote() {
  const ownerId = await makeAccount('owner');
  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$2,$3,$4)',
    [noteId, ownerId, 'editor', now]
  );
  return { noteId, ownerHeaders: await authHeaders(ownerId), ownerId };
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

test('create + list + delete key distribution request', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId, ownerHeaders } = await seedNote();
  const create = await app.inject({
    method: 'POST',
    url: `/collaboration/keys/${noteId}/distribute-request`,
    headers: ownerHeaders,
    payload: { targetDeviceId: 'dev-b' },
  });
  assert.equal(create.statusCode, 200, `create failed: ${create.body}`);
  assert.equal(create.json().ok, true);

  const list = await app.inject({
    method: 'GET',
    url: '/collaboration/keys/distribute-requests',
    headers: ownerHeaders,
  });
  assert.equal(list.statusCode, 200, list.body);
  const req = list.json().requests.find((r) => r.noteId === noteId && r.targetDeviceId === 'dev-b');
  assert.ok(req, 'expected distribution request to be listed');

  const del = await app.inject({
    method: 'DELETE',
    url: `/collaboration/keys/distribute-requests/${noteId}/dev-b`,
    headers: ownerHeaders,
  });
  assert.equal(del.statusCode, 200, `delete failed: ${del.body}`);
  assert.equal(del.json().ok, true);

  const list2 = await app.inject({
    method: 'GET',
    url: '/collaboration/keys/distribute-requests',
    headers: ownerHeaders,
  });
  assert.equal(
    list2.json().requests.find((r) => r.noteId === noteId),
    undefined,
    'expected distribution request to be removed after delete'
  );
});
