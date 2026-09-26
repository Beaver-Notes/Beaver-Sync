'use strict';

// Regression: the owner (and a workspace editor) of a note that has NOT been
// pushed to the server yet must still be able to invite collaborators and
// create invite links. A non-member/outsider stays refused. The safe
// owner-recognition rule is that the caller names the workspace it is sharing
// from and the server verifies owner/editor membership in it, but ONLY while
// the note has no server-side record in any workspace.

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

const kem = () => crypto.randomBytes(1184).toString('hex');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

async function seedPaidWorkspace(tag) {
  const owner = await register('pro', { email: `${tag}-owner@test.example` });
  const wsId = `ws-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, 'e', owner.id, now]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, owner.id, 'owner', now]
  );
  return { owner, wsId };
}

async function seedInviteTarget(tag) {
  const email = `${tag}-target@test.example`;
  const account = await register('pro', { email });
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [kem(), account.id]);
  return { account, email };
}

async function post(app, url, headers, payload) {
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload,
  });
}

test('owner can invite and create an invite link for an unpushed note (no server record)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('unpushed-owner');
  const target = await seedInviteTarget('unpushed');
  const ownerHeaders = await authHeaders(owner.id);
  const noteId = `note-${crypto.randomUUID()}`;

  // No sync_document_state / yjs_doc_updates row exists for this note.
  const invite = await post(
    app,
    `/collaboration/invite/${noteId}`,
    ownerHeaders,
    { email: target.email, role: 'editor', workspaceId: wsId }
  );
  assert.equal(invite.statusCode, 201, invite.body);
  assert.equal(invite.json().userId, target.account.id);

  const link = await post(app, `/collaboration/links/${noteId}`, ownerHeaders, {
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(link.statusCode, 201, link.body);
  assert.ok(link.json().token, 'link response must carry a token');
});

test('the note owner is not refused when the workspace was only asserted client-side', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('asserted-owner');
  const target = await seedInviteTarget('asserted');
  const ownerHeaders = await authHeaders(owner.id);
  const noteId = `note-${crypto.randomUUID()}`;

  // Link creation alone (no prior invite/bootstrap) must recognise the owner.
  const link = await post(app, `/collaboration/links/${noteId}`, ownerHeaders, {
    role: 'viewer',
    workspaceId: wsId,
  });
  assert.equal(link.statusCode, 201, link.body);

  const invite = await post(app, `/collaboration/invite/${noteId}`, ownerHeaders, {
    email: target.email,
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(invite.statusCode, 201, invite.body);
  assert.equal(invite.json().userId, target.account.id);
});

test('an outsider cannot claim an unpushed note even by naming a workspace they do not belong to', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { wsId } = await seedPaidWorkspace('outsider-owner');
  const outsider = await seedInviteTarget('outsider');
  const outsiderHeaders = await authHeaders(outsider.account.id);
  const noteId = `note-${crypto.randomUUID()}`;

  const invite = await post(app, `/collaboration/invite/${noteId}`, outsiderHeaders, {
    email: 'outsider-owner@test.example',
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.equal(invite.json().error, 'note_ownership_required');

  const link = await post(app, `/collaboration/links/${noteId}`, outsiderHeaders, {
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(link.statusCode, 403, link.body);
});

test('an outsider cannot claim an unpushed note without naming a workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner } = await seedPaidWorkspace('no-ws-owner');
  const outsider = await seedInviteTarget('no-ws');
  const outsiderHeaders = await authHeaders(outsider.account.id);
  const noteId = `note-${crypto.randomUUID()}`;

  const invite = await post(app, `/collaboration/invite/${noteId}`, outsiderHeaders, {
    email: 'no-ws-owner@test.example',
    role: 'editor',
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.equal(invite.json().error, 'note_ownership_required');
  assert.ok(owner.id);
});

test('a member of a different workspace cannot claim a note that already lives in the owner workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('recorded-owner');
  const stranger = await seedPaidWorkspace('recorded-stranger');
  const strangerHeaders = await authHeaders(stranger.owner.id);
  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // The note really belongs to owner's workspace.
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1,$2,0,'',0,0,$3) ON CONFLICT DO NOTHING`,
    [wsId, noteId, now]
  );

  const invite = await post(app, `/collaboration/invite/${noteId}`, strangerHeaders, {
    email: 'recorded-stranger-target@test.example',
    role: 'editor',
    // Stranger asserts their OWN workspace; the note is unclaimed there but
    // already recorded in owner's workspace, so the claim must be refused.
    workspaceId: stranger.wsId,
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.ok(owner.id);
});

test('a viewer collaborator still cannot create an invite link', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('viewer-owner');
  const viewer = await register('pro', { email: 'viewer-collab@test.example' });
  const viewerHeaders = await authHeaders(viewer.id);
  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$3,$4,$5)',
    [noteId, viewer.id, owner.id, 'viewer', now]
  );

  const link = await post(app, `/collaboration/links/${noteId}`, viewerHeaders, {
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(link.statusCode, 403, link.body);
  assert.equal(link.json().message, 'Only editors can create invite links.');
});

test('a note owner can create an invite link even with a stale viewer row', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('owner-stale-viewer-row');
  const ownerHeaders = await authHeaders(owner.id);
  const noteId = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Reproduces the report: the owner somehow carries a 'viewer' invitation row
  // (e.g. they opened their own share link), which used to block link creation.
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1,$2,$3,$4,$5)',
    [noteId, owner.id, owner.id, 'viewer', now]
  );

  const link = await post(app, `/collaboration/links/${noteId}`, ownerHeaders, {
    role: 'editor',
    workspaceId: wsId,
  });
  assert.equal(link.statusCode, 201, link.body);
  assert.ok(link.json().token);
});
