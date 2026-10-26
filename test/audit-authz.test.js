'use strict';

// Authorization for the enterprise audit log. admin.js is the owner-scoped
// surface for the same rows; /audit must agree with it, and must resolve the
// plan the same way (org-first) or an owner whose Enterprise plan lives on the
// org is refused because their personal subscription is free.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const models = require('../src/models');

const NOW = () => new Date().toISOString();

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function seedEnterpriseWorkspace(wsId, ownerId) {
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)',
    [wsId, 'name', ownerId, NOW()]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    [wsId, ownerId, 'owner', NOW()]
  );
}

async function addMember(wsId, accountId, role) {
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    [wsId, accountId, role, NOW()]
  );
}

async function seedAuditLog(wsId) {
  const mlkem = require('../src/lib/mlkem');
  await models.AuditLog.create({
    id: crypto.randomUUID(),
    accountIdHash: 'hash-of-someone',
    workspaceId: wsId,
    action: 'member_removed',
    metadataSealed: await mlkem.encryptMetadata(JSON.stringify({ targetId: 'acct-victim' })),
    ipSubnet: '203.0.113.0/24',
    createdAt: NOW(),
  });
}

async function getAudit(app, accountId, wsId) {
  const headers = await authHeaders(accountId);
  return app.inject({
    method: 'GET',
    url: `/audit?workspaceId=${wsId}`,
    headers,
  });
}

test('a viewer collaborator cannot read the audit log', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const wsId = `ws-audit-viewer-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await register('enterprise');
  const viewer = await register('enterprise');
  await seedEnterpriseWorkspace(wsId, owner.id);
  await addMember(wsId, viewer.id, 'viewer');
  await seedAuditLog(wsId);

  const res = await getAudit(app, viewer.id, wsId);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().logs, undefined, 'a viewer must not receive audit rows');
});

test('an editor collaborator cannot read the audit log', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const wsId = `ws-audit-editor-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await register('enterprise');
  const editor = await register('enterprise');
  await seedEnterpriseWorkspace(wsId, owner.id);
  await addMember(wsId, editor.id, 'editor');
  await seedAuditLog(wsId);

  const res = await getAudit(app, editor.id, wsId);
  assert.equal(res.statusCode, 403, res.body);
});

test('the workspace owner reads the audit log and its decrypted metadata', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const wsId = `ws-audit-owner-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await register('enterprise');
  await seedEnterpriseWorkspace(wsId, owner.id);
  await seedAuditLog(wsId);

  const res = await getAudit(app, owner.id, wsId);
  assert.equal(res.statusCode, 200, res.body);
  const log = res.json().logs[0];
  assert.equal(log.action, 'member_removed');
  assert.equal(log.ipSubnet, '203.0.113.0/24');
  assert.deepEqual(log.metadata, { targetId: 'acct-victim' });
  assert.equal(log.metadataSealed, undefined);
});

test('the plan is resolved org-first: an org Enterprise plan satisfies the gate', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const wsId = `ws-audit-orgplan-${crypto.randomUUID().slice(0, 8)}`;
  const orgId = `org-audit-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await register('free');   // personal plan stays free on purpose
  await seedEnterpriseWorkspace(wsId, owner.id);
  await models.Organization.create({ id: orgId, nameEncrypted: 'e', slug: `slug-${orgId}`, createdAt: new Date() });
  await models.OrgMember.create({ orgId, accountId: owner.id, role: 'owner', createdAt: new Date() });
  await models.OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: 'enterprise', status: 'active', seats: 1, createdAt: new Date() });
  await query('UPDATE workspaces SET org_id = $1 WHERE id = $2', [orgId, wsId]);
  await seedAuditLog(wsId);

  const res = await getAudit(app, owner.id, wsId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().logs.length, 1);
});

test('a Team plan is still refused: the audit flag is enterprise-only', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const wsId = `ws-audit-team-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await register('team');
  await seedEnterpriseWorkspace(wsId, owner.id);
  await seedAuditLog(wsId);

  const res = await getAudit(app, owner.id, wsId);
  assert.equal(res.statusCode, 403, res.body);
});
