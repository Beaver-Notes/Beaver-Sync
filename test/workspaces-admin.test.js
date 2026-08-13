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

const authHeader = (account) => ({ authorization: `Bearer ${signToken(account.id)}` });

test('GET /plans resolves flags for a starter subscription', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const account = await register('starter');

  const res = await app.inject({ method: 'GET', url: '/plans', headers: authHeader(account) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.plan, 'starter');
  assert.equal(body.quotaBytes, 10 * 1024 ** 3);
  assert.equal(body.historyDays, 30);
  assert.equal(body.deviceLimit, 5);
  assert.equal(body.flags.dashboard, false);
});

test('GET /plans reports free plan with zero quota for a free subscription', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const account = await register('free');

  const res = await app.inject({ method: 'GET', url: '/plans', headers: authHeader(account) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.plan, 'free');
  assert.equal(body.quotaBytes, 0);
  assert.equal(body.flags.shareNotes, false);
});

test('GET /plans requires authentication', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/plans' });
  assert.equal(res.statusCode, 401);
});

test('GET /plans resolves the org plan when an orgId is supplied', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const account = await register('free');
  await seedOrg('org-plans-1', account.id, 'team');

  const res = await app.inject({
    method: 'GET',
    url: '/plans?orgId=org-plans-1',
    headers: authHeader(account),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.plan, 'team');
  assert.equal(body.quotaBytes, 100 * 1024 ** 3 + 25 * 1024 ** 3);
  assert.equal(body.flags.teamWorkspaces, true);
});

test('GET /plans resolves the org plan from a workspaceId in the query', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-plans-2', owner.id, 'team');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-plans-2', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const res = await app.inject({
    method: 'GET',
    url: `/plans?workspaceId=${ws.id}`,
    headers: authHeader(owner),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().plan, 'team');
});

test('GET /plans does not leak another org plan to a non-member', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const otherOwner = await register('free');
  await seedOrg('org-leak-b', otherOwner.id, 'team');

  const caller = await register('starter');

  const res = await app.inject({
    method: 'GET',
    url: '/plans?orgId=org-leak-b',
    headers: authHeader(caller),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.plan, 'starter');
  assert.equal(body.flags.teamWorkspaces, false);
  assert.equal(body.quotaBytes, 10 * 1024 ** 3);
});

test('GET /plans resolves the org plan for a workspace member who is not an org member', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-ws-member', owner.id, 'team');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-ws-member', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const member = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'editor', createdAt: new Date() });

  const res = await app.inject({
    method: 'GET',
    url: `/plans?workspaceId=${ws.id}`,
    headers: authHeader(member),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().plan, 'team');
  assert.equal(res.json().seats, 1);
});

test('member-lookup finds a user by username', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-lookup-1', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-lookup-1', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const target = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY)
      .update(`lookup-${crypto.randomBytes(6).toString('hex')}@test.example`).digest('hex'),
    emailEncrypted: 'e',
    username: 'lookupuser',
    kemPublicKey: 'kpub',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });

  const res = await app.inject({
    method: 'GET',
    url: `/workspaces/${ws.id}/member-lookup?username=LookupUser`,
    headers: authHeader(owner),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.found, true);
  assert.equal(body.accountId, target.id);
  assert.equal(body.hasKemPublicKey, true);
});

test('member-lookup finds a user by email', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-lookup-2', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-lookup-2', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const email = `lookup-${crypto.randomBytes(6).toString('hex')}@test.example`;
  const target = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY).update(email).digest('hex'),
    emailEncrypted: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });

  const res = await app.inject({
    method: 'GET',
    url: `/workspaces/${ws.id}/member-lookup?email=${encodeURIComponent(email.toUpperCase())}`,
    headers: authHeader(owner),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.found, true);
  assert.equal(body.accountId, target.id);
  assert.equal(body.hasKemPublicKey, false);
});

test('member-lookup returns found:false for an unknown user', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-lookup-3', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-lookup-3', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const res = await app.inject({
    method: 'GET',
    url: `/workspaces/${ws.id}/member-lookup?username=ghost`,
    headers: authHeader(owner),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().found, false);
});

test('member-lookup is forbidden for viewer members', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-lookup-4', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-lookup-4', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const viewer = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: viewer.id, role: 'viewer', createdAt: new Date() });

  const res = await app.inject({
    method: 'GET',
    url: `/workspaces/${ws.id}/member-lookup?username=ghost`,
    headers: authHeader(viewer),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('PATCH member role allows owner to promote a member to admin', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-1', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-1', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const member = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'viewer', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${member.id}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { role: 'admin' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().updated, true);

  const row = await models.WorkspaceMember.findOne({ workspaceId: ws.id, accountId: member.id }).lean();
  assert.equal(row.role, 'admin');
});

test('PATCH member role rejects an invalid role', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-2', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-2', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const member = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: member.id, role: 'viewer', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${member.id}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { role: 'superuser' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_role');
});

test('PATCH member role blocks self-demotion away from owner', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-3', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-3', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${owner.id}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { role: 'editor' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'cannot_demote_self');
});

test('PATCH member role is forbidden for viewers', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-4', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-4', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const viewer = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: viewer.id, role: 'viewer', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${owner.id}`,
    headers: { ...authHeader(viewer), 'content-type': 'application/json' },
    payload: { role: 'admin' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('PATCH member role returns 404 for a non-member target', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-5', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-5', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const stranger = await register('free');

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${stranger.id}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { role: 'editor' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('PATCH member role rejects admin self-promotion to owner', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-6', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-6', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const admin = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: admin.id, role: 'admin', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${admin.id}`,
    headers: { ...authHeader(admin), 'content-type': 'application/json' },
    payload: { role: 'owner' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'cannot_promote_self');

  const row = await models.WorkspaceMember.findOne({ workspaceId: ws.id, accountId: admin.id }).lean();
  assert.equal(row.role, 'admin');
});

test('PATCH member role rejects an admin demoting the owner', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-7', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-7', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const admin = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: admin.id, role: 'admin', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${owner.id}`,
    headers: { ...authHeader(admin), 'content-type': 'application/json' },
    payload: { role: 'admin' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');

  const row = await models.WorkspaceMember.findOne({ workspaceId: ws.id, accountId: owner.id }).lean();
  assert.equal(row.role, 'owner');
});

test('PATCH member role allows owner to promote an admin to owner', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  await seedOrg('org-patch-8', owner.id, 'free');
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: owner.id, orgId: 'org-patch-8', createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: owner.id, role: 'owner', createdAt: new Date() });

  const admin = await register('free');
  await models.WorkspaceMember.create({ workspaceId: ws.id, accountId: admin.id, role: 'admin', createdAt: new Date() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/workspaces/${ws.id}/members/${admin.id}`,
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: { role: 'owner' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().updated, true);

  const row = await models.WorkspaceMember.findOne({ workspaceId: ws.id, accountId: admin.id }).lean();
  assert.equal(row.role, 'owner');
});
