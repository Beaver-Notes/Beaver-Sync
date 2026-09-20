'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.NOTE_HMAC_KEY = 'test-note-hmac-key-at-least-32-characters-long';
process.env.ENTERPRISE_MODE = 'false';
delete process.env.PLAN_OVERRIDE;

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { makeAccount, authHeaders } = require('./helpers/factory');
const { buildApp } = require('../src/server');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await close();
});

async function inject(app, headers, method, url, payload) {
  const opts = { method, url, headers };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
}

async function seedOrgWithMembers(orgId, ownerId, others = []) {
  const now = new Date().toISOString();
  await query(
    'INSERT INTO organizations (id, name_encrypted, slug, created_at) VALUES ($1,$2,$3,$4)',
    [orgId, 'e', `slug-${orgId}`, now]
  );
  await query(
    'INSERT INTO org_members (org_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [orgId, ownerId, 'owner', now]
  );
  for (const { accountId, role } of others) {
    await query(
      'INSERT INTO org_members (org_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
      [orgId, accountId, role, now]
    );
  }
}

// Org with two workspaces; `memberId` is an editor in both with two device envelopes each.
async function seedOrgWorkspaces(orgId, ownerId, memberId) {
  const now = new Date().toISOString();
  const ws1 = `ws-${crypto.randomUUID().slice(0, 8)}`;
  const ws2 = `ws-${crypto.randomUUID().slice(0, 8)}`;
  for (const ws of [ws1, ws2]) {
    await query(
      'INSERT INTO workspaces (id, name_encrypted, owner_id, org_id, created_at) VALUES ($1,$2,$3,$4,$5)',
      [ws, 'e', ownerId, orgId, now]
    );
    await query(
      'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
      [ws, ownerId, 'owner', now]
    );
    await query(
      'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
      [ws, memberId, 'editor', now]
    );
    for (const deviceId of ['default', 'laptop']) {
      await query(
        'INSERT INTO workspace_keys (workspace_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,$3,$4,$5)',
        [ws, memberId, deviceId, 'wrapped', now]
      );
    }
  }
  return { ws1, ws2 };
}

test('removing an org member also removes their workspace memberships and envelopes', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('orgrm-owner');
  const member = await makeAccount('orgrm-member');
  await seedOrgWithMembers('org-remove-ws', owner, [{ accountId: member, role: 'member' }]);
  const { ws1, ws2 } = await seedOrgWorkspaces('org-remove-ws', owner, member);

  const ownerHeaders = await authHeaders(owner);
  const res = await inject(app, ownerHeaders, 'DELETE', `/organizations/org-remove-ws/members/${member}`);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

  // Org membership gone.
  const orgRows = (await query(
    'SELECT COUNT(*)::int AS c FROM org_members WHERE org_id=$1 AND account_id=$2',
    ['org-remove-ws', member]
  )).rows[0].c;
  assert.equal(orgRows, 0, 'org membership must be removed');

  // Every workspace in the org loses the member, and every device envelope with it.
  for (const ws of [ws1, ws2]) {
    const membership = (await query(
      'SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id=$1 AND account_id=$2',
      [ws, member]
    )).rows[0].c;
    assert.equal(membership, 0, `workspace_members row must be gone for ${ws}`);

    const envelopes = (await query(
      'SELECT COUNT(*)::int AS c FROM workspace_keys WHERE workspace_id=$1 AND user_id=$2',
      [ws, member]
    )).rows[0].c;
    assert.equal(envelopes, 0, `all per-device envelopes must be gone for ${ws}`);
  }

  // Access is actually denied on a fresh session (org removal revokes the old one).
  const freshMemberHeaders = await authHeaders(member);
  const denied = await inject(app, freshMemberHeaders, 'GET', `/workspaces/${ws1}/members`);
  assert.equal(denied.statusCode, 403, `workspace access must be denied, got ${denied.statusCode}: ${denied.body}`);
});

test('a member who leaves an org loses workspace access too', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('orgleave-owner');
  const member = await makeAccount('orgleave-member');
  await seedOrgWithMembers('org-leave-ws', owner, [{ accountId: member, role: 'member' }]);
  const { ws1 } = await seedOrgWorkspaces('org-leave-ws', owner, member);

  const memberHeaders = await authHeaders(member);
  const res = await inject(app, memberHeaders, 'POST', '/organizations/org-leave-ws/leave');
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

  const membership = (await query(
    'SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id=$1 AND account_id=$2',
    [ws1, member]
  )).rows[0].c;
  assert.equal(membership, 0, 'leaving the org must drop workspace membership');

  const denied = await inject(app, memberHeaders, 'GET', `/workspaces/${ws1}/members`);
  assert.equal(denied.statusCode, 403, `workspace access must be denied, got ${denied.statusCode}`);
});

test('an org admin cannot remove the owner', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('orgowner-protect');
  const admin = await makeAccount('orgadmin-actor');
  await seedOrgWithMembers('org-owner-protect', owner, [{ accountId: admin, role: 'admin' }]);

  const adminHeaders = await authHeaders(admin);
  const res = await inject(app, adminHeaders, 'DELETE', `/organizations/org-owner-protect/members/${owner}`);
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected 4xx, got ${res.statusCode}: ${res.body}`);

  const ownerRow = (await query(
    'SELECT role FROM org_members WHERE org_id=$1 AND account_id=$2',
    ['org-owner-protect', owner]
  )).rows[0];
  assert.equal(ownerRow.role, 'owner', 'the owner must remain');
});

test('the last owner cannot be demoted', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('orglast-owner');
  await seedOrgWithMembers('org-last-owner', owner);

  const ownerHeaders = await authHeaders(owner);
  const res = await inject(app, ownerHeaders, 'PATCH', `/organizations/org-last-owner/members/${owner}`, { role: 'admin' });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected 4xx, got ${res.statusCode}: ${res.body}`);

  const ownerRow = (await query(
    'SELECT role FROM org_members WHERE org_id=$1 AND account_id=$2',
    ['org-last-owner', owner]
  )).rows[0];
  assert.equal(ownerRow.role, 'owner', 'the org must keep an owner');
});

test('a legitimate ownership transfer promotes the target and demotes the previous owner', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const owner = await makeAccount('orgxfer-owner');
  const heir = await makeAccount('orgxfer-heir');
  await seedOrgWithMembers('org-xfer', owner, [{ accountId: heir, role: 'member' }]);

  const ownerHeaders = await authHeaders(owner);
  const res = await inject(app, ownerHeaders, 'PATCH', `/organizations/org-xfer/members/${heir}`, { role: 'owner' });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

  const heirRow = (await query('SELECT role FROM org_members WHERE org_id=$1 AND account_id=$2', ['org-xfer', heir])).rows[0];
  const oldOwnerRow = (await query('SELECT role FROM org_members WHERE org_id=$1 AND account_id=$2', ['org-xfer', owner])).rows[0];
  assert.equal(heirRow.role, 'owner', 'the target must become the owner');
  assert.equal(oldOwnerRow.role, 'admin', 'the previous owner must step down');

  const ownerCount = (await query(
    "SELECT COUNT(*)::int AS c FROM org_members WHERE org_id=$1 AND role='owner'",
    ['org-xfer']
  )).rows[0].c;
  assert.equal(ownerCount, 1, 'exactly one owner after transfer');
});
