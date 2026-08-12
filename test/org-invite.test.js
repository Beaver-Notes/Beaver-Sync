'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, '.test-data', 'test.db');
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db");
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { getDb, close } = require('../src/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();
const PUBKEY = 'alice-pub-1';
const PUBKEY_2 = 'bob-pub-2';

function seedAccount(id, kemKey) {
  const db = getDb();
  db.prepare('INSERT INTO accounts (id, email_hmac, kem_public_key, created_at) VALUES (?, ?, ?, ?)')
    .run(id, `${id}-email`, kemKey ?? null, now);
}

function seedOrg(orgId, ownerId) {
  const db = getDb();
  db.prepare('INSERT INTO organizations (id, name_encrypted, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(orgId, 'org-name', `slug-${orgId}`, now);
  db.prepare('INSERT INTO org_members (org_id, account_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(orgId, ownerId, 'owner', now);
}

async function inject(app, session, method, url, payload) {
  const headers = { authorization: `Bearer ${session}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload });
}

test.before(async () => {
  seedAccount('inv-owner', PUBKEY);
  seedAccount('inv-joiner', PUBKEY_2);
  seedAccount('inv-joiner2', PUBKEY);
  seedOrg('org-invite-1', 'inv-owner');
  seedOrg('org-invite-2', 'inv-owner');
});

test.after(async () => {
  close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
});

test('admin creates an invite that returns a raw token and grants membership on join', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const ownerSession = await createSession('inv-owner', { headers: {} });
  const joinerSession = await createSession('inv-joiner', { headers: {} });

  const create = await inject(app, ownerSession, 'POST', '/organizations/org-invite-1/invite', { role: 'member' });
  assert.equal(create.statusCode, 201);
  const created = create.json();
  assert.ok(created.token && created.token.length === 64);
  assert.equal(created.role, 'member');
  assert.equal(created.requireApproval, false);
  assert.equal(created.maxUses, 0);

  const list = await inject(app, ownerSession, 'GET', '/organizations/org-invite-1/invite');
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().invites.length, 1);
  assert.ok(list.json().invites[0].id);

  const join = await inject(app, joinerSession, 'POST', `/organizations/join/${created.token}`);
  assert.equal(join.statusCode, 201);
  assert.deepEqual(join.json(), { orgId: 'org-invite-1', role: 'member' });
  const membership = getDb().prepare('SELECT role FROM org_members WHERE org_id = ? AND account_id = ?')
    .get('org-invite-1', 'inv-joiner');
  assert.equal(membership.role, 'member');

  const duplicate = await inject(app, joinerSession, 'POST', `/organizations/join/${created.token}`);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error, 'already_member');
});

test('a keyless user cannot join via invite and is rejected with 403 keypair_required', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  seedAccount('inv-keyless', null);
  const ownerSession = await createSession('inv-owner', { headers: {} });
  const keylessSession = await createSession('inv-keyless', { headers: {} });

  const create = await inject(app, ownerSession, 'POST', '/organizations/org-invite-1/invite', { role: 'member' });
  assert.equal(create.statusCode, 201);
  const token = create.json().token;

  const join = await inject(app, keylessSession, 'POST', `/organizations/join/${token}`);
  assert.equal(join.statusCode, 403);
  assert.equal(join.json().error, 'keypair_required');
  const membership = getDb().prepare('SELECT COUNT(*) AS count FROM org_members WHERE org_id = ? AND account_id = ?')
    .get('org-invite-1', 'inv-keyless').count;
  assert.equal(membership, 0);
});

test('a require-approval invite is pending until an admin approves it, then join succeeds', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const ownerSession = await createSession('inv-owner', { headers: {} });
  const joinerSession = await createSession('inv-joiner2', { headers: {} });

  const create = await inject(app, ownerSession, 'POST', '/organizations/org-invite-2/invite', { role: 'member', requireApproval: true });
  assert.equal(create.statusCode, 201);
  const token = create.json().token;
  assert.equal(create.json().requireApproval, true);

  const pending = await inject(app, joinerSession, 'POST', `/organizations/join/${token}`);
  assert.equal(pending.statusCode, 202);
  assert.deepEqual(pending.json(), { pending: true, message: 'Join request requires approval.' });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM org_members WHERE org_id = ? AND account_id = ?')
    .get('org-invite-2', 'inv-joiner2').count, 0);

  const approve = await inject(app, ownerSession, 'POST', '/organizations/org-invite-2/invite/' + token + '/approve');
  assert.equal(approve.statusCode, 200);
  assert.deepEqual(approve.json(), { approved: true });

  const join = await inject(app, joinerSession, 'POST', `/organizations/join/${token}`);
  assert.equal(join.statusCode, 201);
  assert.deepEqual(join.json(), { orgId: 'org-invite-2', role: 'member' });
});

test('revoked invites are rejected with 404 on join', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const ownerSession = await createSession('inv-owner', { headers: {} });
  const joinerSession = await createSession('inv-joiner', { headers: {} });

  const create = await inject(app, ownerSession, 'POST', '/organizations/org-invite-1/invite', { role: 'member' });
  assert.equal(create.statusCode, 201);
  const token = create.json().token;

  const revoke = await inject(app, ownerSession, 'DELETE', `/organizations/org-invite-1/invite/${token}`);
  assert.equal(revoke.statusCode, 200);
  assert.deepEqual(revoke.json(), { revoked: true });

  const join = await inject(app, joinerSession, 'POST', `/organizations/join/${token}`);
  assert.equal(join.statusCode, 404);
  assert.equal(join.json().error, 'invite_not_found');
});

test('public-keys returns only collaborators with keypairs and 403s for outsiders', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  seedAccount('pk-owner', PUBKEY);
  seedAccount('pk-user1', PUBKEY_2);
  seedAccount('pk-user2', null);
  seedAccount('pk-outsider', PUBKEY);
  const db = getDb();
  for (const uid of ['pk-owner', 'pk-user1', 'pk-user2']) {
    db.prepare('INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('note-pk', uid, 'pk-owner', 'editor', now);
  }

  const ownerSession = await createSession('pk-owner', { headers: {} });
  const outsiderSession = await createSession('pk-outsider', { headers: {} });

  const response = await inject(app, ownerSession, 'GET', '/collaboration/public-keys/note-pk');
  assert.equal(response.statusCode, 200);
  const expected = [
    { userId: 'pk-owner', kemPublicKey: PUBKEY },
    { userId: 'pk-user1', kemPublicKey: PUBKEY_2 },
  ];
  assert.deepEqual(
    response.json().collaborators.sort((a, b) => a.userId.localeCompare(b.userId)),
    expected.sort((a, b) => a.userId.localeCompare(b.userId))
  );

  const forbidden = await inject(app, outsiderSession, 'GET', '/collaboration/public-keys/note-pk');
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error, 'forbidden');
});
