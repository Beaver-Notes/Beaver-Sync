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
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { createSession } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function seedAccount(plan) {
  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY)
      .update(`${plan}-${crypto.randomBytes(6).toString('hex')}@test.example`).digest('hex'),
    emailEncrypted: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
  await models.Subscription.create({
    accountId: account.id, plan, status: 'active',
    storageQuotaBytes: plan === 'free' ? 0 : 1024, storageUsedBytes: 0, createdAt: new Date(),
  });
  return account;
}

async function inject(app, session, payload) {
  return app.inject({
    method: 'POST', url: '/auth/verify-session',
    headers: { 'content-type': 'application/json' },
    payload,
  });
}

test('verify-session grants editor role to a note collaborator via noteId', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const editor = await seedAccount('pro');
  await models.NoteInvitation.create({
    noteId: 'note-editor', userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-editor' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: editor.id, role: 'editor' });
});

test('verify-session grants viewer role to a note collaborator via noteId', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const viewer = await seedAccount('pro');
  await models.NoteInvitation.create({
    noteId: 'note-viewer', userId: viewer.id, invitedBy: owner.id, role: 'viewer', createdAt: new Date(),
  });

  const session = await createSession(viewer.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-viewer' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: viewer.id, role: 'viewer' });
});

test('verify-session rejects a non-collaborator on a note', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const outsider = await seedAccount('pro');
  await models.NoteInvitation.create({
    noteId: 'note-gated', userId: owner.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(outsider.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 'note-gated' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('verify-session falls through to the collaborator check when a non-member sends workspaceId + noteId', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const editor = await seedAccount('pro');
  await models.NoteInvitation.create({
    noteId: 'note-collab-ws', userId: editor.id, invitedBy: owner.id, role: 'editor', createdAt: new Date(),
  });

  const session = await createSession(editor.id, { headers: {} });
  const res = await inject(app, session, { token: session, workspaceId: 'some-ws', noteId: 'note-collab-ws' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { userId: editor.id, role: 'editor' });
});

test('verify-session returns 403 when a non-member sends workspaceId + noteId and is not a collaborator either', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const outsider = await seedAccount('pro');
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
  t.after(() => app.close());
  const user = await seedAccount('pro');

  const session = await createSession(user.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: '' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_request');
});

test('verify-session rejects an invalid noteId', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const user = await seedAccount('pro');

  const session = await createSession(user.id, { headers: {} });
  const res = await inject(app, session, { token: session, noteId: 12345 });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_request');
});

test('verify-session still validates workspace membership when noteId is absent', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const owner = await seedAccount('pro');
  const member = await seedAccount('pro');
  const outsider = await seedAccount('pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'viewer', createdAt: new Date() });

  const memberSession = await createSession(member.id, { headers: {} });
  const memberRes = await inject(app, memberSession, { token: memberSession, workspaceId: ws.id });
  assert.equal(memberRes.statusCode, 200);
  assert.deepEqual(memberRes.json(), { userId: member.id, role: 'viewer' });

  const outsiderSession = await createSession(outsider.id, { headers: {} });
  const outsiderRes = await inject(app, outsiderSession, { token: outsiderSession, workspaceId: ws.id });
  assert.equal(outsiderRes.statusCode, 403);
});
