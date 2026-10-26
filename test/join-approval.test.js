'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount, seedWorkspace } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();
const PUBKEY = 'ja-pub-1';
const PUBKEY_2 = 'ja-pub-2';

async function seedPaid(accountId, plan = 'pro') {
  await query(
    `INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at)
     VALUES ($1, $2, $3, 'active', 1000000, 0, $4)`,
    [`${accountId}-sub`, accountId, plan, now]
  );
}

async function inject(app, session, method, url, payload) {
  const headers = { authorization: `Bearer ${session}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload });
}

async function countInvitations(noteId, userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS count FROM note_invitations WHERE note_id = $1 AND user_id = $2',
    [noteId, userId]
  );
  return rows[0].count;
}

async function countPending(table, column, value) {
  const { rows } = await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`, [value]);
  return rows[0].count;
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedAccount('ja-owner', PUBKEY);
  for (const [id, key] of [
    ['ja-joiner', PUBKEY_2],
    ['ja-joiner2', PUBKEY],
    ['ja-outsider', PUBKEY_2],
    ['ja-ws-joiner', PUBKEY],
    ['ja-ws-joiner2', PUBKEY_2],
  ]) {
    await seedAccount(id, key);
    await seedPaid(id);
  }
  // seedWorkspace creates the owner membership and a pro subscription.
  // Shared-workspace invites require the team flag, so seed at team tier.
  await seedWorkspace('ws-approval-1', 'ja-owner', { plan: 'team' });
  // The note already has one editor (the approver); joiners are not members.
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['note-approval-0001', 'ja-owner', 'ja-owner', 'editor', now]
  );
});

test.after(async () => {
  await close();
});

// Each test starts from a clean approval surface, keeping the fixed owner
// membership so only the pending requests under test exist.
test.beforeEach(async () => {
  await query('DELETE FROM note_join_requests');
  await query('DELETE FROM workspace_join_requests');
  await query('DELETE FROM workspace_invites');
  await query('DELETE FROM note_invitations WHERE note_id = $1 AND user_id <> $2', ['note-approval-0001', 'ja-owner']);
  await query('DELETE FROM workspace_members WHERE workspace_id = $1 AND account_id <> $2', ['ws-approval-1', 'ja-owner']);
});

test('note link request creates a durable pending row and returns 202, no invitation', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const joiner = await createSession('ja-joiner', { headers: {} });

  const create = await inject(app, owner, 'POST', '/collaboration/links/note-approval-0001', {
    role: 'viewer',
    requireApproval: true,
  });
  assert.equal(create.statusCode, 201, create.body);
  const token = create.json().token;

  const join = await inject(app, joiner, 'POST', `/collaboration/join/${token}`);
  assert.equal(join.statusCode, 202, join.body);
  assert.equal(join.json().pending, true);
  assert.equal(join.json().noteId, 'note-approval-0001');
  assert.equal(join.json().role, 'viewer');

  assert.equal(await countInvitations('note-approval-0001', 'ja-joiner'), 0, 'must not grant before approval');
  assert.equal(await countPending('note_join_requests', 'account_id', 'ja-joiner'), 1, 'pending row must be durable');

  // Re-requesting keeps a single pending row.
  const again = await inject(app, joiner, 'POST', `/collaboration/join/${token}`);
  assert.equal(again.statusCode, 202, again.body);
  assert.equal(await countPending('note_join_requests', 'account_id', 'ja-joiner'), 1, 're-request must not duplicate');
});

test('non-approver cannot approve a note join request', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const joiner = await createSession('ja-joiner', { headers: {} });
  const outsider = await createSession('ja-outsider', { headers: {} });

  const create = await inject(app, owner, 'POST', '/collaboration/links/note-approval-0001', {
    role: 'editor',
    requireApproval: true,
  });
  const token = create.json().token;
  await inject(app, joiner, 'POST', `/collaboration/join/${token}`);

  const list = await inject(app, owner, 'GET', '/collaboration/notes/note-approval-0001/join-requests');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().requests.length, 1, list.body);
  const requestId = list.json().requests[0].id;
  assert.equal(list.json().requests[0].accountId, 'ja-joiner');

  const forbidden = await inject(app, outsider, 'POST', `/collaboration/join-requests/${requestId}/approve`);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(await countInvitations('note-approval-0001', 'ja-joiner'), 0, 'non-approver must not grant');
});

test('approving a note request grants the invite role and consumes the pending row; double-approve is safe', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const joiner2 = await createSession('ja-joiner2', { headers: {} });

  const create = await inject(app, owner, 'POST', '/collaboration/links/note-approval-0001', {
    role: 'viewer',
    requireApproval: true,
  });
  const token = create.json().token;
  await inject(app, joiner2, 'POST', `/collaboration/join/${token}`);
  const list = await inject(app, owner, 'GET', '/collaboration/notes/note-approval-0001/join-requests');
  const requestId = list.json().requests.find((r) => r.accountId === 'ja-joiner2').id;

  const approve = await inject(app, owner, 'POST', `/collaboration/join-requests/${requestId}/approve`);
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().approved, true);
  assert.equal(approve.json().userId, 'ja-joiner2');
  assert.equal(approve.json().role, 'viewer');

  const { rows } = await query(
    'SELECT role FROM note_invitations WHERE note_id = $1 AND user_id = $2',
    ['note-approval-0001', 'ja-joiner2']
  );
  assert.equal(rows.length, 1, 'approval must create the invitation');
  assert.equal(rows[0].role, 'viewer', 'granted role must match the link');
  assert.equal(await countPending('note_join_requests', 'account_id', 'ja-joiner2'), 0, 'pending row must be consumed');

  const again = await inject(app, owner, 'POST', `/collaboration/join-requests/${requestId}/approve`);
  assert.ok(again.statusCode === 404 || again.statusCode === 409, `double-approve must not be 2xx, got ${again.statusCode}`);
  assert.equal(await countInvitations('note-approval-0001', 'ja-joiner2'), 1, 'no double grant');
});

test('approving one note requester does not unlock the link for others', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const joiner = await createSession('ja-joiner', { headers: {} });
  const joiner2 = await createSession('ja-joiner2', { headers: {} });

  const create = await inject(app, owner, 'POST', '/collaboration/links/note-approval-0001', {
    role: 'editor',
    requireApproval: true,
  });
  const token = create.json().token;

  await inject(app, joiner, 'POST', `/collaboration/join/${token}`);
  const list = await inject(app, owner, 'GET', '/collaboration/notes/note-approval-0001/join-requests');
  const requestId = list.json().requests.find((r) => r.accountId === 'ja-joiner').id;
  const approve = await inject(app, owner, 'POST', `/collaboration/join-requests/${requestId}/approve`);
  assert.equal(approve.statusCode, 200, approve.body);

  // A different account hitting the same link must still be pending.
  const other = await inject(app, joiner2, 'POST', `/collaboration/join/${token}`);
  assert.equal(other.statusCode, 202, `other requester must not auto-join: ${other.body}`);
  assert.equal(await countInvitations('note-approval-0001', 'ja-joiner2'), 0, 'other requester must not be granted');
});

test('denying a note request removes it without granting access', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const joiner = await createSession('ja-joiner', { headers: {} });

  const create = await inject(app, owner, 'POST', '/collaboration/links/note-approval-0001', {
    role: 'editor',
    requireApproval: true,
  });
  const token = create.json().token;
  await inject(app, joiner, 'POST', `/collaboration/join/${token}`);
  const list = await inject(app, owner, 'GET', '/collaboration/notes/note-approval-0001/join-requests');
  const requestId = list.json().requests.find((r) => r.accountId === 'ja-joiner').id;

  const deny = await inject(app, owner, 'POST', `/collaboration/join-requests/${requestId}/deny`);
  assert.equal(deny.statusCode, 200, deny.body);
  assert.equal(deny.json().denied, true);
  assert.equal(await countPending('note_join_requests', 'account_id', 'ja-joiner'), 0, 'denied row must be gone');
  assert.equal(await countInvitations('note-approval-0001', 'ja-joiner'), 0, 'deny must not grant');
});

test('workspace link request is pending until an owner approves; non-approver gets 403; double-approve is safe', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const wsJoiner = await createSession('ja-ws-joiner', { headers: {} });
  const outsider = await createSession('ja-outsider', { headers: {} });

  const create = await inject(app, owner, 'POST', '/workspaces/ws-approval-1/members', {
    username: 'ja-ws-joiner',
    role: 'editor',
    requireApproval: true,
  });
  assert.equal(create.statusCode, 201, create.body);
  const token = create.json().token;

  const pending = await inject(app, wsJoiner, 'POST', `/workspaces/join/${token}`);
  assert.equal(pending.statusCode, 202, pending.body);
  assert.equal(pending.json().pending, true);
  assert.equal(await countPending('workspace_join_requests', 'account_id', 'ja-ws-joiner'), 1, 'pending row required');
  assert.equal(
    (await query('SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id=$1 AND account_id=$2', ['ws-approval-1', 'ja-ws-joiner'])).rows[0].c,
    0,
    'must not grant before approval'
  );

  const list = await inject(app, owner, 'GET', '/workspaces/ws-approval-1/join-requests');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().requests.length, 1, list.body);
  const requestId = list.json().requests[0].id;

  const forbidden = await inject(app, outsider, 'POST', `/workspaces/join-requests/${requestId}/approve`);
  assert.equal(forbidden.statusCode, 403, forbidden.body);

  const approve = await inject(app, owner, 'POST', `/workspaces/join-requests/${requestId}/approve`);
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().approved, true);
  assert.equal(approve.json().userId, 'ja-ws-joiner');
  assert.equal(approve.json().role, 'editor');
  const member = (await query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND account_id=$2', ['ws-approval-1', 'ja-ws-joiner'])).rows;
  assert.equal(member.length, 1, 'approval must create the membership');
  assert.equal(member[0].role, 'editor', 'granted role must match the link');
  assert.equal(await countPending('workspace_join_requests', 'account_id', 'ja-ws-joiner'), 0, 'pending row consumed');

  const again = await inject(app, owner, 'POST', `/workspaces/join-requests/${requestId}/approve`);
  assert.ok(again.statusCode === 404 || again.statusCode === 409, `double-approve must not be 2xx, got ${again.statusCode}`);
  assert.equal(
    (await query('SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id=$1 AND account_id=$2', ['ws-approval-1', 'ja-ws-joiner'])).rows[0].c,
    1,
    'no double membership'
  );
});

test('workspace pending queue is per requester and listed for admins and for the requester', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession('ja-owner', { headers: {} });
  const wsJoiner2 = await createSession('ja-ws-joiner2', { headers: {} });

  const create = await inject(app, owner, 'POST', '/workspaces/ws-approval-1/members', {
    username: 'ja-ws-joiner2',
    role: 'viewer',
    requireApproval: true,
  });
  const token = create.json().token;
  await inject(app, wsJoiner2, 'POST', `/workspaces/join/${token}`);

  const adminList = await inject(app, owner, 'GET', '/workspaces/join-requests');
  assert.equal(adminList.statusCode, 200, adminList.body);
  const mine = adminList.json().requests.find((r) => r.accountId === 'ja-ws-joiner2');
  assert.ok(mine, 'admin aggregate list must include the pending request');
  assert.equal(mine.role, 'viewer');

  const ownList = await inject(app, wsJoiner2, 'GET', '/workspaces/my-pending-requests');
  assert.equal(ownList.statusCode, 200, ownList.body);
  assert.ok(
    ownList.json().requests.some((r) => r.workspaceId === 'ws-approval-1'),
    'requester must see their own pending request'
  );
});
