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
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, seedOrg } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { signToken } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function workspaceInject(app, account, payload) {
  return app.inject({
    method: 'POST', url: '/workspaces',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload,
  });
}

test('free plan cannot create a cloud workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('free');
  const res = await workspaceInject(app, account, {
    nameEncrypted: 'e',
    recipients: [{ userId: account.id, wrappedKey: 'w' }],
    orgId: 'org-x',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plan_upgrade_required');
});

test('starter plan blocked when already owning one workspace', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('starter');
  await seedOrg('org-x', account.id, 'starter');
  await models.Workspace.create({ nameEncrypted: 'e', ownerId: account.id, orgId: 'org-x', createdAt: new Date() });
  const res = await workspaceInject(app, account, {
    nameEncrypted: 'e',
    recipients: [{ userId: account.id, wrappedKey: 'w' }],
    orgId: 'org-x',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'workspace_limit_reached');
});

test('starter plan workspace count is per-org', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('starter');
  await seedOrg('org-count-a', account.id, 'starter');
  await models.Workspace.create({ nameEncrypted: 'e', ownerId: account.id, orgId: 'org-count-a', createdAt: new Date() });

  await seedOrg('org-count-b', account.id, 'starter');
  const res = await workspaceInject(app, account, {
    nameEncrypted: 'e',
    recipients: [{ userId: account.id, wrappedKey: 'w' }],
    orgId: 'org-count-b',
  });
  assert.equal(res.statusCode, 201);
});

test('member invite with guest role is rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  await seedOrg('org-members', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-members', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const res = await app.inject({
    method: 'POST', url: `/workspaces/${ws.id}/members`,
    headers: { authorization: `Bearer ${signToken(owner.id)}`, 'content-type': 'application/json' },
    payload: { email: 'someone@example.com', role: 'guest' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_role');
});

test('member invite for a free-plan user is rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  await seedOrg('org-free-invite', owner.id, 'pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-free-invite', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  await register('free', { email: 'free-invite@example.com' });
  const res = await app.inject({
    method: 'POST', url: `/workspaces/${ws.id}/members`,
    headers: { authorization: `Bearer ${signToken(owner.id)}`, 'content-type': 'application/json' },
    payload: { email: 'free-invite@example.com', role: 'viewer' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plan_upgrade_required');
});

test('free-plan user cannot join a workspace via invite', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  await seedOrg('org-free-join', owner.id, 'pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-free-join', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHmac('sha256', process.env.SESSION_HMAC_KEY).update(rawToken).digest('hex');
  await models.WorkspaceInvite.create({
    tokenHash, workspaceId: ws.id, role: 'viewer', requireApproval: 0,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), maxUses: 0, usedCount: 0, createdAt: new Date(),
  });

  const freeJoiner = await register('free');
  await models.Account.updateOne({ _id: freeJoiner.id }, { $set: { kemPublicKey: 'free-joiner-pub' } });
  const res = await app.inject({
    method: 'POST', url: `/workspaces/join/${rawToken}`,
    headers: { authorization: `Bearer ${signToken(freeJoiner.id)}` },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plan_upgrade_required');
});

test('paid user can join a workspace via invite', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  await seedOrg('org-paid-join', owner.id, 'pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-paid-join', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHmac('sha256', process.env.SESSION_HMAC_KEY).update(rawToken).digest('hex');
  await models.WorkspaceInvite.create({
    tokenHash, workspaceId: ws.id, role: 'viewer', requireApproval: 0,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), maxUses: 0, usedCount: 0, createdAt: new Date(),
  });

  const paidJoiner = await register('pro');
  await models.Account.updateOne({ _id: paidJoiner.id }, { $set: { kemPublicKey: 'paid-joiner-pub' } });
  const res = await app.inject({
    method: 'POST', url: `/workspaces/join/${rawToken}`,
    headers: { authorization: `Bearer ${signToken(paidJoiner.id)}` },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, 'viewer');
});

test('workspace audit logs require an enterprise plan', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('team');
  await seedOrg('org-audit', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-audit', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const res = await app.inject({
    method: 'GET', url: `/admin/workspaces/${ws.id}/audit`,
    headers: { authorization: `Bearer ${signToken(owner.id)}` },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('free plan cannot invite collaborators to a note (share-notes gating)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('free');
  await register('pro', { email: 'paid-target@example.com' });

  const res = await app.inject({
    method: 'POST',
    url: '/collaboration/invite/note-share-free-plan',
    headers: { authorization: `Bearer ${signToken(owner.id)}`, 'content-type': 'application/json' },
    payload: { email: 'paid-target@example.com' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plan_upgrade_required');
});

test('free plan cannot create a note invite link (share-notes gating)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('free');

  const res = await app.inject({
    method: 'POST',
    url: '/collaboration/links/note-share-link-free',
    headers: { authorization: `Bearer ${signToken(owner.id)}`, 'content-type': 'application/json' },
    payload: { role: 'editor' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'plan_upgrade_required');
});

test('paid plan can invite collaborators to a note', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const target = await register('free', { email: 'free-collab@example.com' });
  await models.Account.updateOne({ _id: target.id }, { $set: { kemPublicKey: 'a'.repeat(1184 * 2) } });

  // Bootstrap requires provable note ownership: the note lives in the owner's workspace.
  const { query } = require('../src/db');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  await query(
    `INSERT INTO sync_document_state (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
     VALUES ($1, $2, 0, '', 0, 0, $3) ON CONFLICT DO NOTHING`,
    [ws.id, 'note-share-paid-plan', new Date().toISOString()]
  );

  const res = await app.inject({
    method: 'POST',
    url: '/collaboration/invite/note-share-paid-plan',
    headers: { authorization: `Bearer ${signToken(owner.id)}`, 'content-type': 'application/json' },
    payload: { email: 'free-collab@example.com' },
  });

  assert.equal(res.statusCode, 201);
});

test('free-plan workspace owner is blocked from yjs push and pull with an explicit 402', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  const headers = {
    authorization: `Bearer ${signToken(owner.id)}`,
    'content-type': 'application/json',
    'x-device-id': 'device-a',
  };

  const push = await app.inject({
    method: 'POST', url: '/yjs/push-batch', headers,
    payload: { workspaceId: ws.id, notes: [{ noteId: 'n', updates: [{ key: 'n~~device-a~~1~~1.yjs.json', data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 1 }] }] },
  });
  assert.equal(push.statusCode, 402);
  assert.equal(push.json().error, 'plan_upgrade_required');

  const pull = await app.inject({
    method: 'POST', url: '/yjs/pull-batch', headers,
    payload: { workspaceId: ws.id, notes: [{ noteId: 'n', checkpoint: null, limit: 10 }] },
  });
  assert.equal(pull.statusCode, 402);
  assert.equal(pull.json().error, 'plan_upgrade_required');
});

test('free invited collaborator can sync a paid owner\u2019s workspace both ways', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await register('pro');
  const collaborator = await register('free');
  await seedOrg('org-collab-sync', owner.id, 'pro');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-collab-sync', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: collaborator.id, role: 'editor', createdAt: new Date() });
  const headers = {
    authorization: `Bearer ${signToken(collaborator.id)}`,
    'content-type': 'application/json',
    'x-device-id': 'device-a',
  };

  const push = await app.inject({
    method: 'POST', url: '/yjs/push-batch', headers,
    payload: { workspaceId: ws.id, notes: [{ noteId: 'n', updates: [{ key: 'n~~device-a~~1~~1.yjs.json', data: 'eA==', deviceId: 'device-a', sequence: 1, ts: 1 }] }] },
  });
  assert.equal(push.statusCode, 201, push.body);

  const pull = await app.inject({
    method: 'POST', url: '/yjs/pull-batch', headers,
    payload: { workspaceId: ws.id, notes: [{ noteId: 'n', checkpoint: null, limit: 10 }] },
  });
  assert.equal(pull.statusCode, 200);
  assert.equal(pull.json().notes.n.updates.length, 1);
});
