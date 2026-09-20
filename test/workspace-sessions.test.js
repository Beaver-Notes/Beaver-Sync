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
const { Account, Session, Workspace, WorkspaceMember, Subscription, Organization, OrgMember } = require('../src/models');
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

async function makeAccount(email, { username } = {}) {
  const { createEmailHash } = require('../src/lib/crypto');
  const emailHash = createEmailHash(email);
  const kdfSalt = crypto.randomBytes(32).toString('hex');
  const data = {
    emailHmac: emailHash,
    emailEncrypted: await mlkem.encryptMetadata(email),
    passwordHash: null,
    kdfSalt,
  };
  if (username) data.username = username;
  const account = await Account.create(data);
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

test('removing a workspace member drops membership without revoking any session', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

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

  // Workspace removal is membership-only: revoking sessions would log the
  // member out of unrelated workspaces (sessions are account-scoped).
  assert.equal(wsSessAfter.revoked, 0, 'workspace removal must not revoke the member\'s sessions');
  assert.equal(acctSessAfter.revoked, 0, 'account-wide session must NOT be revoked by a workspace removal');
});

test('admin removing a workspace member also drops membership without revoking sessions', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

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

  assert.equal(wsSessAfter.revoked, 0, 'admin workspace removal must not revoke the member\'s sessions');
  assert.equal(acctSessAfter.revoked, 0, 'account-wide session must NOT be revoked by a workspace removal');
});

test('admin members endpoint joins username but never email onto each member', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('owner-names@example.com', { username: 'owner-names' });
  const member = await makeAccount('member-names@example.com', { username: 'alice' });

  const nameEncrypted = await mlkem.encryptMetadata('Names Workspace');
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

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  await Session.create({
    idHash: hashSessionId(ownerRawId),
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0.0',
    expiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
    revoked: false,
  });

  const res = await app.inject({
    method: 'GET',
    url: `/admin/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
  const members = res.json().members;
  const alice = members.find((m) => m.role === 'editor');
  assert.equal(alice.userId, member.id, 'raw id stays available as the stable identifier');
  assert.equal(alice.username, 'alice', 'username is joined for the human identity');
  assert.equal('email' in alice, false, 'member email must never be exposed to owners/admins');
  assert.equal(
    JSON.stringify(members).includes('member-names@example.com'),
    false,
    'the roster response must not contain another member\'s email anywhere',
  );
});

test('removing a member from an organization revokes all their account sessions', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('owner-org-remove@example.com');
  const member = await makeAccount('member-org-remove@example.com');

  await Organization.create({ id: 'org-remove-1', nameEncrypted: 'e', slug: 'org-remove-1', createdAt: new Date() });
  await OrgMember.create({ orgId: 'org-remove-1', accountId: owner.id, role: 'owner', createdAt: new Date() });
  await OrgMember.create({ orgId: 'org-remove-1', accountId: member.id, role: 'member', createdAt: new Date() });

  const memberSession = await makeSession(member.id, null);

  const ownerRawId = crypto.randomBytes(32).toString('base64url');
  await Session.create({
    idHash: hashSessionId(ownerRawId),
    accountId: owner.id,
    workspaceId: null,
    deviceLabel: 'Owner Device',
    ipSubnet: '127.0',
    expiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
    revoked: false,
  });

  const res = await app.inject({
    method: 'DELETE',
    url: '/organizations/org-remove-1/members/' + member.id,
    headers: { authorization: `Bearer ${ownerRawId}` },
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
  const sessAfter = await Session.findOne({ idHash: memberSession.idHash }).lean();
  assert.equal(sessAfter.revoked, 1, 'org removal must log the member out everywhere (sessions are account-scoped)');
});

test('admin cannot revoke another user\'s account-wide (non-workspace) session', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

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
  t.after(async () => { await app.close(); });

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
