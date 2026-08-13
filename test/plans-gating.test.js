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
const { buildApp } = require('../src/server');
const models = require('../src/models');
const { signToken } = require('../src/middleware/auth');

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function register(plan) {
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

async function seedOrg(orgId, ownerId, plan) {
  await models.Organization.create({ id: orgId, nameEncrypted: 'e', slug: `slug-${orgId}`, createdAt: new Date() });
  await models.OrgMember.create({ orgId, accountId: ownerId, role: 'owner', createdAt: new Date() });
  await models.OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan, status: 'active', seats: 1, createdAt: new Date() });
}

async function workspaceInject(app, account, payload) {
  return app.inject({
    method: 'POST', url: '/workspaces',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload,
  });
}

test('free plan cannot create a cloud workspace', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
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
  t.after(() => app.close());
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

test('member invite with guest role is rejected', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
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

test('workspace audit logs require an enterprise plan', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
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
