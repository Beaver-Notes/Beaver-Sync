'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-ws';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { Account, Session, Workspace, WorkspaceMember, Subscription } = require('../src/models');
const { hashSessionId } = require('../src/lib/crypto');
const mlkem = require('../src/lib/mlkem');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await mlkem.init();
});

test.after(async () => {
  await close();
});

async function makeAccount(email) {
  const { createEmailHash } = require('../src/lib/crypto');
  const emailHash = createEmailHash(email);
  const kdfSalt = crypto.randomBytes(32).toString('hex');
  const account = await Account.create({
    emailHmac: emailHash,
    passwordHash: null,
    kdfSalt,
  });
  await Subscription.create({
    accountId: account.id,
    plan: 'team',
    status: 'active',
    storageQuotaBytes: 50 * 1024 * 1024 * 1024,
    createdAt: new Date(),
  });
  return account;
}

async function makeSession(userId, workspaceId) {
  const rawId = crypto.randomBytes(32).toString('base64url');
  const idHash = hashSessionId(rawId);
  const now = new Date();
  await Session.create({
    idHash,
    accountId: userId,
    workspaceId: workspaceId ?? null,
    deviceLabel: 'Test Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });
  return { rawId, idHash };
}

test('removing a workspace member revokes only workspace-scoped sessions, not account-wide ones', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await makeAccount('owner-ws@example.com');
  const member = await makeAccount('member-ws@example.com');

  const nameEncrypted = await mlkem.encryptMetadata('Test Workspace');
  const workspace = await Workspace.create({
    nameEncrypted,
    ownerId: owner.id,
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: owner.id,
    role: 'owner',
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: member.id,
    role: 'editor',
    createdAt: new Date(),
  });

  const wsSession = await makeSession(member.id, workspace.id);
  const accountSession = await makeSession(member.id, null);

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  const ownerIdHash = hashSessionId(ownerRawId);
  const now = new Date();
  await Session.create({
    idHash: ownerIdHash,
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });

  const res = await app.inject({
    method: 'DELETE',
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);

  const wsSessAfter = await Session.findOne({ idHash: wsSession.idHash }).lean();
  const acctSessAfter = await Session.findOne({ idHash: accountSession.idHash }).lean();

  assert.equal(wsSessAfter.revoked, 1, 'workspace-scoped session should be revoked');
  assert.equal(acctSessAfter.revoked, 0, 'account-wide session should NOT be revoked');
});

test('admin removing a workspace member also scopes session revocation', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await makeAccount('owner-admin@example.com');
  const member = await makeAccount('member-admin@example.com');

  const nameEncrypted = await mlkem.encryptMetadata('Admin Workspace');
  const workspace = await Workspace.create({
    nameEncrypted,
    ownerId: owner.id,
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: owner.id,
    role: 'owner',
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: member.id,
    role: 'editor',
    createdAt: new Date(),
  });

  const wsSession = await makeSession(member.id, workspace.id);
  const accountSession = await makeSession(member.id, null);

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  const ownerIdHash = hashSessionId(ownerRawId);
  const now = new Date();
  await Session.create({
    idHash: ownerIdHash,
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });

  const res = await app.inject({
    method: 'DELETE',
    url: `/admin/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);

  const wsSessAfter = await Session.findOne({ idHash: wsSession.idHash }).lean();
  const acctSessAfter = await Session.findOne({ idHash: accountSession.idHash }).lean();

  assert.equal(wsSessAfter.revoked, 1, 'workspace-scoped session should be revoked');
  assert.equal(acctSessAfter.revoked, 0, 'account-wide session should NOT be revoked');
});

test('admin cannot revoke another user\'s account-wide (non-workspace) session', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await makeAccount('owner-revoke@example.com');
  const other = await makeAccount('other-revoke@example.com');

  const otherRawId = crypto.randomBytes(32).toString('base64url');
  const otherIdHash = hashSessionId(otherRawId);
  const now = new Date();
  await Session.create({
    idHash: otherIdHash,
    accountId: other.id,
    workspaceId: null,
    deviceLabel: 'Other Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  const ownerIdHash = hashSessionId(ownerRawId);
  await Session.create({
    idHash: ownerIdHash,
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });

  const res = await app.inject({
    method: 'DELETE',
    url: `/admin/sessions/${otherIdHash}`,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 403, 'should forbid revoking account-wide session of another user');
  assert.equal(res.json().error, 'forbidden');

  const sessAfter = await Session.findOne({ idHash: otherIdHash }).lean();
  assert.equal(sessAfter.revoked, 0, 'session should still be active');
});

test('workspace owner can revoke a session issued by their workspace SSO', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const owner = await makeAccount('owner-ws-sso@example.com');
  const member = await makeAccount('member-ws-sso@example.com');

  const nameEncrypted = await mlkem.encryptMetadata('SSO Workspace');
  const workspace = await Workspace.create({
    nameEncrypted,
    ownerId: owner.id,
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: owner.id,
    role: 'owner',
    createdAt: new Date(),
  });
  await WorkspaceMember.create({
    workspaceId: workspace.id,
    accountId: member.id,
    role: 'editor',
    createdAt: new Date(),
  });

  const wsSession = await makeSession(member.id, workspace.id);

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  const ownerIdHash = hashSessionId(ownerRawId);
  const now = new Date();
  await Session.create({
    idHash: ownerIdHash,
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(now.getTime() + 3600_000),
    lastSeenAt: now,
    revoked: false,
  });

  const res = await app.inject({
    method: 'DELETE',
    url: `/admin/sessions/${wsSession.idHash}`,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
  const sessAfter = await Session.findOne({ idHash: wsSession.idHash }).lean();
  assert.equal(sessAfter.revoked, 1, 'workspace-scoped session should be revoked');
});
