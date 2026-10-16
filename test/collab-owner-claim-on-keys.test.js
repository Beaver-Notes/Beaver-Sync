'use strict';

// Regression: the owner of a note that has been pushed to the server (its Yjs
// journal exists) but was never invited anywhere could not list its own
// collaborators — both key-distribution listing endpoints hit the plain
// `requireCollaborator` gate, which 403s when the owner has no invitation row
// yet. That stranded every solo note on fresh devices: the client's key
// fan-out (`provisionMissingEnvelopes`) could never reach the endpoint that
// reports which devices still need an envelope. Now the owner's first touch
// claims the note through the same atomic bootstrap the invite endpoints use.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.ENTERPRISE_MODE = 'false';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

const kem = () => crypto.randomBytes(1184).toString('hex');

// A pushed-but-unclaimed note: the note's Yjs journal is registered in the
// owner's workspace, but no note_invitations row exists anywhere.
async function seedPushedSoloNote(tag) {
  const owner = await register('pro', { email: `${tag}-owner@test.example` });
  const wsId = `ws-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [wsId, 'e', owner.id, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [wsId, owner.id, 'owner', now]);
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [kem(), owner.id]);

  const noteId = `note-${crypto.randomUUID()}`;
  await query(
    `INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
     VALUES ($1,$2,$3,'\\x00',0,$4,0,$5,$6)`,
    [crypto.randomUUID(), wsId, noteId, 'device-test', Date.now(), now]
  );
  return { owner, wsId, noteId };
}

test('the owner of a pushed solo note can list its public keys (self-claim on first touch)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, noteId } = await seedPushedSoloNote('claim-keys');
  const ownerHeaders = await authHeaders(owner.id);

  const first = await app.inject({ method: 'GET', url: `/collaboration/public-keys/${noteId}`, headers: ownerHeaders });
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(Array.isArray(first.json().collaborators));
  assert.equal(first.json().collaborators.some((c) => c.userId === owner.id), true, 'the owner must be listed');

  // The self-invitation row is now minted exactly once.
  const { rows } = await query('SELECT user_id, invited_by FROM note_invitations WHERE note_id = $1', [noteId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, owner.id);
  assert.equal(rows[0].invited_by, owner.id);

  // Repeated listing is idempotent — no duplicate row, still 200.
  const second = await app.inject({ method: 'GET', url: `/collaboration/public-keys/${noteId}`, headers: ownerHeaders });
  assert.equal(second.statusCode, 200, second.body);
  const after = await query('SELECT count(*)::int AS n FROM note_invitations WHERE note_id = $1', [noteId]);
  assert.equal(after.rows[0].n, 1);
});

test('the owner can also list an invitation record for a pushed solo note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, noteId } = await seedPushedSoloNote('claim-inv');
  const ownerHeaders = await authHeaders(owner.id);

  const res = await app.inject({ method: 'GET', url: `/collaboration/invitations/${noteId}`, headers: ownerHeaders });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(Array.isArray(res.json().invitations));
});

test('a stranger still cannot list a pushed note public keys', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { noteId } = await seedPushedSoloNote('claim-stranger');
  const stranger = await register('pro', { email: 'claim-stranger@test.example' });
  const strangerHeaders = await authHeaders(stranger.id);

  const res = await app.inject({ method: 'GET', url: `/collaboration/public-keys/${noteId}`, headers: strangerHeaders });
  assert.equal(res.statusCode, 403, res.body);
  // The bootstrap branch refuses a non-owner's claim explicitly.
  assert.equal(res.json().error, 'note_ownership_required');
});
