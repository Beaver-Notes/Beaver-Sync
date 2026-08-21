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

function createPayload(orgId, recipients) {
  return {
    nameEncrypted: 'enc-workspace-name',
    orgId,
    recipients,
  };
}

test('POST /workspaces persists vaultWrappedKeys and serves it to every member', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('pro');
  const orgId = `org-vk-1-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const member = await register('pro');

  const envelope = JSON.stringify({ v: 5, meta: {}, iv: 'iv-b64', enc: 'enc-b64' });
  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: {
      ...createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
      vaultWrappedKeys: envelope,
    },
  });
  assert.equal(res.statusCode, 201);
  const created = res.json();
  assert.equal(created.vaultWrappedKeys, envelope);

  const row = await models.Workspace.findById(created.id).lean();
  assert.equal(row.vaultWrappedKeys, envelope);

  // A second member who joins later must see the same envelope via GET.
  await models.WorkspaceMember.create({ workspaceId: created.id, accountId: member.id, role: 'editor', createdAt: new Date() });

  const listRes = await app.inject({ method: 'GET', url: '/workspaces', headers: authHeader(member) });
  assert.equal(listRes.statusCode, 200);
  const ws = listRes.json().workspaces.find((w) => w.id === created.id);
  assert.ok(ws, 'second member should see the workspace');
  assert.equal(ws.vaultWrappedKeys, envelope);
});

test('POST /workspaces without vaultWrappedKeys stores NULL and GET returns null', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('starter');
  const orgId = `org-vk-2-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  const res = await app.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { ...authHeader(owner), 'content-type': 'application/json' },
    payload: createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().vaultWrappedKeys, null);

  const row = await models.Workspace.findById(res.json().id).lean();
  assert.equal(row.vaultWrappedKeys, null);

  const listRes = await app.inject({ method: 'GET', url: '/workspaces', headers: authHeader(owner) });
  assert.equal(listRes.statusCode, 200);
  const ws = listRes.json().workspaces.find((w) => w.id === res.json().id);
  assert.ok(ws);
  assert.equal(ws.vaultWrappedKeys, null);
});

test('POST /workspaces rejects a non-string vaultWrappedKeys', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await register('starter');
  const orgId = `org-vk-3-${crypto.randomBytes(4).toString('hex')}`;
  await seedOrg(orgId, owner.id, 'team');

  for (const bad of [123, { iv: 'x' }, '']) {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { ...authHeader(owner), 'content-type': 'application/json' },
      payload: {
        ...createPayload(orgId, [{ userId: owner.id, wrappedKey: 'wrapped-owner' }]),
        vaultWrappedKeys: bad,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'validation_error');
  }
});
