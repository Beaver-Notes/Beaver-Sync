'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-e2e';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long-e2e';
process.env.ENTERPRISE_MODE = 'false';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { createSession } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function inject(app, session, payload) {
  return app.inject({
    method: 'POST', url: '/auth/verify-session',
    // The relay presents this on every call (src/ws-relay-auth.js); the endpoint 503s without it.
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET, },
    payload,
  });
}

test('verify-session grants editor role to a note collaborator via noteId', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const editor = await register('pro');
  await models.NoteInvitation.create({
    noteId: 'note-editor', userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-editor' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: editor.id, role: 'editor', deviceId: null });
});

test('verify-session grants viewer role to a note collaborator via noteId', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const viewer = await register('pro');
  await models.NoteInvitation.create({
    noteId: 'note-viewer', userId: viewer.id, invitedBy: owner.id, role: 'viewer', createdAt: new Date(),
  });

  const session = await createSession(viewer.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-viewer' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: viewer.id, role: 'viewer', deviceId: null });
});

test('verify-session rejects a non-collaborator on a note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const outsider = await register('pro');
  await models.NoteInvitation.create({
    noteId: 'note-gated', userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(outsider.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-gated' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('verify-session denies cross-workspace access: non-member with noteId not in workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const editor = await register('pro');
  await models.NoteInvitation.create({
    noteId: 'note-collab-ws', userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: 'some-ws', noteId: 'note-collab-ws' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.match(res.json().message, /Note not found in this workspace/);
});

test('verify-session returns 403 when a non-member sends workspaceId + noteId and is not a collaborator either', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const outsider = await register('pro');
  await models.NoteInvitation.create({
    noteId: 'note-gated-ws', userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(outsider.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: 'some-ws', noteId: 'note-gated-ws' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('verify-session rejects an empty-string noteId', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const user = await register('pro');

  const session = await createSession(user.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: '' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_request');
});

test('verify-session rejects an invalid noteId', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const user = await register('pro');

  const session = await createSession(user.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 12345 });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_request');
});

test('verify-session still validates workspace membership when noteId is absent', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const member = await register('pro');
  const outsider = await register('pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'viewer', createdAt: new Date() });

  const memberSession = await createSession(member.id, { headers: {} });
  const memberRes = await inject(app, memberSession, { token: memberSession, workspaceId: ws.id });
  assert.equal(memberRes.statusCode, 200);
  assert.deepEqual(memberRes.json(), { userId: member.id, role: 'viewer', deviceId: null });

  const outsiderSession = await createSession(outsider.id, { headers: {} });
  const outsiderRes = await inject(app, outsiderSession, { token: outsiderSession, workspaceId: ws.id });
  assert.equal(outsiderRes.statusCode, 403);
});

// --- Regression tests for Task 03.3: Room authorization fall-through ---

test('verify-session allows valid (workspaceId, noteId) pair when note belongs to workspace and user is collaborator', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const editor = await register('pro');
  
  // Create workspace and associate note with it via sync_document_state
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  
  const noteId = 'note-valid-pair';
  await models.NoteInvitation.create({
    noteId, userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });
  
  // Associate note with workspace in sync_document_state
  const { query } = require('../src/db');
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1, $2, 0, '', 0, 0, NOW())
     ON CONFLICT (workspace_id, note_id) DO NOTHING`,
    [ws.id, noteId]
  );

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: ws.id, noteId });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: editor.id, role: 'editor', deviceId: null });
});

test('verify-session denies access when collaborator removed from note in workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const editor = await register('pro');
  
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  
  const noteId = 'note-removed-collab';
  await models.NoteInvitation.create({
    noteId, userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });
  
  // Associate note with workspace
  const { query } = require('../src/db');
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1, $2, 0, '', 0, 0, NOW())
     ON CONFLICT (workspace_id, note_id) DO NOTHING`,
    [ws.id, noteId]
  );

  // Remove collaborator
  await models.NoteInvitation.deleteOne({ noteId, userId: editor.id });

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: ws.id, noteId });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  assert.match(res.json().message, /Not a collaborator on this note/);
});

test('verify-session allows workspace member access to note room without note collaboration', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const member = await register('pro');
  
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'editor', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  
  const noteId = 'note-member-access';
  // Note belongs to workspace but member is NOT a note collaborator
  const { query } = require('../src/db');
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1, $2, 0, '', 0, 0, NOW())
     ON CONFLICT (workspace_id, note_id) DO NOTHING`,
    [ws.id, noteId]
  );

  const session = await createSession(member.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: ws.id, noteId });

  // Workspace membership should grant access even without note collaboration
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, 'editor');
});

test('verify-session denies note-only access when user not collaborator', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const outsider = await register('pro');
  
  const noteId = 'note-no-collab';
  await models.NoteInvitation.create({
    noteId, userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(outsider.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});
