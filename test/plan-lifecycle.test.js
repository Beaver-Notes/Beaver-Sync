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
process.env.NOTE_HMAC_KEY = 'test-note-hmac-key-at-least-32-characters-long-e2e';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const models = require('../src/models');
const { ensurePaidProvisioning, checkDowngrade } = require('../src/lib/plan-lifecycle');
const { buildApp } = require('../src/server');
const { signToken } = require('../src/middleware/auth');
const { createNoteHash } = require('../src/lib/crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

async function makeAccount() {
  return models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY)
      .update(`prov-${crypto.randomBytes(6).toString('hex')}@test.example`).digest('hex'),
    emailEncrypted: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
}

async function makeAccountWithPlan(plan) {
  const account = await makeAccount();
  await models.Subscription.create({
    accountId: account.id, plan, status: 'active',
    storageQuotaBytes: plan === 'free' ? 0 : 10 * 1024 ** 3,
    storageUsedBytes: 0, createdAt: new Date(),
  });
  return account;
}

async function seedWorkspace(workspaceId, ownerId) {
  await models.Workspace.create({ id: workspaceId, nameEncrypted: 'e', ownerId, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId, accountId: ownerId, role: 'owner', createdAt: new Date() });
}

async function seedCommit(accountId, commitId, deviceId, noteIdHash, ts) {
  await query(`
    INSERT INTO commits (commit_id, account_id, device_id, note_id_hash, clock, ts, size_bytes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [commitId, accountId, deviceId, noteIdHash ?? null, parseInt(commitId.split('-').at(-1), 10), ts, 10, new Date(ts).toISOString()]);
}

async function seedYjsUpdate(workspaceId, noteId, deviceId, clock, ts) {
  await query(`
    INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [`${workspaceId}-${noteId}-${deviceId}-${clock}`, workspaceId, noteId,
    Buffer.from(`update-${clock}`), 1, deviceId, clock, ts, new Date(ts).toISOString()]);
}

test('ensurePaidProvisioning creates org + personal workspace for paid account', async () => {
  const account = await makeAccount();
  await models.Subscription.create({ accountId: account.id, plan: 'starter', status: 'active', storageQuotaBytes: 1024, storageUsedBytes: 0, createdAt: new Date() });

  const { orgId, workspaceId } = await ensurePaidProvisioning(account.id);

  const org = await models.Organization.findById(orgId).lean();
  assert.ok(org);
  const ws = await models.Workspace.findById(workspaceId).lean();
  assert.ok(ws);
  assert.equal(ws.ownerId, account.id);
  assert.equal(ws.orgId, orgId);

  const member = await models.WorkspaceMember.findOne({ workspaceId, accountId: account.id }).lean();
  assert.ok(member);
  assert.equal(member.role, 'owner');
  const orgMember = await models.OrgMember.findOne({ orgId, accountId: account.id }).lean();
  assert.ok(orgMember);
  const orgSub = await models.OrgSubscription.findOne({ orgId }).lean();
  assert.ok(orgSub);
  assert.equal(orgSub.plan, 'starter');

  const state = (await query('SELECT status, generation FROM sync_workspace_state WHERE workspace_id = $1', [workspaceId])).rows[0];
  assert.ok(state);
  assert.equal(state.status, 'empty');
  assert.equal(Number(state.generation), 0);
});

test('ensurePaidProvisioning returns nulls and creates nothing for a free account', async () => {
  const account = await makeAccountWithPlan('free');

  const result = await ensurePaidProvisioning(account.id);

  assert.deepEqual(result, { orgId: null, workspaceId: null });
  assert.equal((await models.OrgMember.find({ accountId: account.id }).lean()).length, 0);
  assert.equal((await models.Workspace.find({ ownerId: account.id }).lean()).length, 0);
});

test('ensurePaidProvisioning is idempotent for an existing org + workspace', async () => {
  const account = await makeAccountWithPlan('pro');

  const first = await ensurePaidProvisioning(account.id);
  const second = await ensurePaidProvisioning(account.id);

  assert.deepEqual(second, first);
  assert.equal((await models.Workspace.find({ ownerId: account.id }).lean()).length, 1);
  assert.equal((await models.Organization.find({}).lean()).filter((o) => o.id === first.orgId).length, 1);
});

test('checkDowngrade blocks when storage exceeds new quota', async () => {
  const account = await makeAccount();
  await models.Subscription.create({ accountId: account.id, plan: 'pro', status: 'active', storageQuotaBytes: 50 * 1024 ** 3, storageUsedBytes: 20 * 1024 ** 3, createdAt: new Date() });

  const result = await checkDowngrade(account.id, 'pro', 'starter');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage');
});

test('checkDowngrade allows when under new quota', async () => {
  const account = await makeAccount();
  await models.Subscription.create({ accountId: account.id, plan: 'pro', status: 'active', storageQuotaBytes: 50 * 1024 ** 3, storageUsedBytes: 2 * 1024 ** 3, createdAt: new Date() });

  const result = await checkDowngrade(account.id, 'pro', 'starter');
  assert.equal(result.ok, true);
});

test('checkDowngrade allows an account with no subscription', async () => {
  const account = await makeAccount();

  const result = await checkDowngrade(account.id, 'pro', 'starter');
  assert.equal(result.ok, true);
});

test('commits /history is clamped to the starter 30-day window', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter');
  const noteId = 'history-note';
  const noteIdHash = createNoteHash(noteId);

  await seedCommit(account.id, '1-dev-a-1', 'dev-a', noteIdHash, Date.now() - 40 * DAY_MS);
  await seedCommit(account.id, '2-dev-a-2', 'dev-a', noteIdHash, Date.now() - 1 * DAY_MS);

  const res = await app.inject({
    method: 'GET',
    url: `/commits/history?noteId=${noteId}`,
    headers: { authorization: `Bearer ${signToken(account.id)}` },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.commits.length, 1);
  assert.equal(body.commits[0].commitid, '2-dev-a-2');
});

test('commits list is clamped to the starter 30-day window', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter');

  await seedCommit(account.id, '1-dev-b-1', 'dev-b', null, Date.now() - 40 * DAY_MS);
  await seedCommit(account.id, '2-dev-b-2', 'dev-b', null, Date.now() - 1 * DAY_MS);

  const res = await app.inject({
    method: 'GET',
    url: '/commits',
    headers: { authorization: `Bearer ${signToken(account.id)}` },
  });

  assert.equal(res.statusCode, 200);
  const commits = res.json().commits;
  assert.equal(commits.length, 1);
  assert.equal(commits[0].commitId, '2-dev-b-2');
});

test('yjs pull-batch is clamped to the starter 30-day window', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter');
  await seedWorkspace('ws-clamp', account.id);
  await seedYjsUpdate('ws-clamp', 'note-x', 'dev-c', 1, Date.now() - 40 * DAY_MS);
  await seedYjsUpdate('ws-clamp', 'note-x', 'dev-c', 2, Date.now() - 1 * DAY_MS);

  const res = await app.inject({
    method: 'POST',
    url: '/yjs/pull-batch',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { workspaceId: 'ws-clamp', notes: [{ noteId: 'note-x', checkpoint: {}, limit: 500 }] },
  });

  assert.equal(res.statusCode, 200);
  const notes = res.json().notes;
  const updates = notes['note-x'].updates;
  assert.equal(updates.length, 1);
  assert.ok(updates[0].key.endsWith('~~2.yjs.json'));
});

test('yjs pull-batch is not clamped for enterprise plans', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('enterprise');
  await seedWorkspace('ws-ent', account.id);
  await seedYjsUpdate('ws-ent', 'note-y', 'dev-d', 1, Date.now() - 40 * DAY_MS);
  await seedYjsUpdate('ws-ent', 'note-y', 'dev-d', 2, Date.now() - 1 * DAY_MS);

  const res = await app.inject({
    method: 'POST',
    url: '/yjs/pull-batch',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { workspaceId: 'ws-ent', notes: [{ noteId: 'note-y', checkpoint: {}, limit: 500 }] },
  });

  assert.equal(res.statusCode, 200);
  const notes = res.json().notes;
  const updates = notes['note-y'].updates;
  assert.equal(updates.length, 2);
});

test('relayStoredUpdates serves only updates inside the plan history window', async (t) => {
  const { relayStoredUpdates } = require('../src/lib/relay');
  const { historyCutoffForAccount } = require('../src/lib/plan-lifecycle');
  const persistence = require('../src/persistence/yjs');

  const account = await makeAccountWithPlan('starter');
  await seedWorkspace('ws-relay', account.id);
  await seedYjsUpdate('ws-relay', 'note-r', 'dev-r', 1, Date.now() - 40 * DAY_MS);
  await seedYjsUpdate('ws-relay', 'note-r', 'dev-r', 2, Date.now() - 1 * DAY_MS);

  const sent = [];
  const connection = {
    messageAddress: 'workspace:ws-relay:note:note-r',
    send: (bytes) => sent.push(bytes),
  };

  const { cutoffTs } = await historyCutoffForAccount(account.id, 'ws-relay');
  const relayed = await relayStoredUpdates({
    connection,
    persistence,
    workspaceId: 'ws-relay',
    noteId: 'note-r',
    cutoffTs,
    log: () => {},
  });

  assert.equal(relayed, 1);
  assert.equal(sent.length, 1);
});

test('relay serves nothing older than now for a free collaborator', async (t) => {
  const { relayStoredUpdates } = require('../src/lib/relay');
  const { historyCutoffForAccount } = require('../src/lib/plan-lifecycle');
  const persistence = require('../src/persistence/yjs');

  // Free account that is NOT a member of the team-org workspace: they must get
  // the free window (serve nothing older than now), never the org's 365 days.
  const owner = await makeAccountWithPlan('team');
  const freeUser = await makeAccountWithPlan('free');

  const orgId = crypto.randomUUID();
  await models.Organization.create({ id: orgId, nameEncrypted: 'e', slug: `org-relay-${orgId}`, createdAt: new Date() });
  await models.OrgMember.create({ orgId, accountId: owner.id, role: 'owner', createdAt: new Date() });
  await models.OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: 'team', status: 'active', seats: 1, createdAt: new Date() });

  await models.Workspace.create({ id: 'ws-relay-free', nameEncrypted: 'e', ownerId: owner.id, orgId, createdAt: new Date() });
  await models.WorkspaceMember.create({ workspaceId: 'ws-relay-free', accountId: owner.id, role: 'owner', createdAt: new Date() });
  await seedYjsUpdate('ws-relay-free', 'note-free', 'dev-f', 1, Date.now() - 1 * DAY_MS);

  const sent = [];
  const connection = {
    messageAddress: 'workspace:ws-relay-free:note:note-free',
    send: (bytes) => sent.push(bytes),
  };

  const { cutoffTs } = await historyCutoffForAccount(freeUser.id, 'ws-relay-free');
  const relayed = await relayStoredUpdates({
    connection,
    persistence,
    workspaceId: 'ws-relay-free',
    noteId: 'note-free',
    cutoffTs,
    log: () => {},
  });

  assert.equal(relayed, 0);
  assert.equal(sent.length, 0);
});

test('free signup skips org + workspace provisioning', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const email = `free-${crypto.randomBytes(4).toString('hex')}@test.example`;

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'super-secure-password-123' },
  });

  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.organization, null);
  assert.equal(body.workspace, null);
  assert.equal((await models.Organization.find({}).lean()).filter((o) => o.slug && o.slug.startsWith('free-')).length, 0);
});
