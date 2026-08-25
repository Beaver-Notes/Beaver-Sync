'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');
const { createMlKem768 } = require('mlkem');

const now = new Date().toISOString();

async function seedAccount(id, kemPublicKey = null) {
  await query(
    'INSERT INTO accounts (id, username, email_hmac, created_at, kem_public_key) VALUES ($1, $2, $3, $4, $5)',
    [id, id, `${id}-email`, now, kemPublicKey]
  );
}

async function seedWorkspace(id, ownerId) {
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', [id, '', ownerId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', [id, ownerId, 'owner', now]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [`${ownerId}-sub`, ownerId, 'pro', 'active', 1000000, 0, now]);
}

async function makeKeypair() {
  const k = await createMlKem768();
  const [pk, sk] = k.generateKeyPair();
  return { pk: Buffer.from(pk).toString('hex'), sk: Buffer.from(sk).toString('hex') };
}

let app;
let alice;
let aliceSession, nokeySession;

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();

  alice = await makeKeypair();

  await seedAccount('alice', alice.pk);
  await seedAccount('nokey', null);
  await seedWorkspace('ws-1', 'alice');

  app = await buildApp();
  await app.ready();
  aliceSession = await createSession('alice', {});
  nokeySession = await createSession('nokey', {});
});

test.after(async () => {
  await app.close();
  close();
});

function post(session, url, payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    payload,
  });
}

test('note join-link gate: keyless joiner is rejected with keypair_required', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    'INSERT INTO note_invite_links (id, note_id, created_by, token_hash, role, require_approval, revoked, created_at) VALUES ($1, $2, $3, $4, $5, 0, 0, $6)',
    [crypto.randomUUID(), 'join-note', 'alice', tokenHash, 'editor', now]
  );

  const res = await post(nokeySession, `/collaboration/join/${token}`, {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('workspace join gate: keyless joiner is rejected with keypair_required', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHmac('sha256', process.env.SESSION_HMAC_KEY).update(token).digest('hex');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await query(
    'INSERT INTO workspace_invites (token_hash, workspace_id, role, expires_at, max_uses, used_count, created_at) VALUES ($1, $2, $3, $4, 0, 0, $5)',
    [tokenHash, 'ws-1', 'editor', future, now]
  );

  const res = await post(nokeySession, `/workspaces/join/${token}`, {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('singular recipient gate: keyless collaborator is rejected with keypair_required', async () => {
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['rec-note-gate-check', 'alice', 'alice', 'editor', now]
  );
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['rec-note-gate-check', 'nokey', 'alice', 'editor', now]
  );

  const res = await post(aliceSession, '/collaboration/keys/rec-note-gate-check/recipient', {
    recipientUserId: 'nokey',
    wrappedKey: '{"kemCt":"abc","ct":"def","tag":"ghi"}',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('plural recipients gate: keyless collaborator is rejected with keypair_required', async () => {
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['recs-note-gate-check', 'alice', 'alice', 'editor', now]
  );
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['recs-note-gate-check', 'nokey', 'alice', 'editor', now]
  );

  const res = await post(aliceSession, '/collaboration/keys/recs-note-gate-check/recipients', {
    recipients: [{ userId: 'nokey', wrappedKey: '{"kemCt":"abc","ct":"def","tag":"ghi"}' }],
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'keypair_required');
});

test('slug collision: second org create with the same slug returns 409 slug_taken', async () => {
  const payload = {
    nameEncrypted: 'cipher',
    recipients: [{ userId: 'alice', wrappedKey: 'wrapped' }],
    slug: 'dup-slug',
  };

  const first = await post(aliceSession, '/organizations/', payload);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().slug, 'dup-slug');

  const second = await post(aliceSession, '/organizations/', payload);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'slug_taken');
});

test('registration stores empty encrypted names for personal org and workspace', async () => {
  const { pk } = await makeKeypair();
  const previousMode = process.env.ENTERPRISE_MODE;
  process.env.ENTERPRISE_MODE = 'true';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'reg-e2e@example.com',
        password: 'correct horse battery staple',
        kemPublicKey: pk,
      },
    });
    assert.equal(res.statusCode, 201);
    const { organization, workspace } = res.json();
    assert.ok(organization, 'paid registration should provision a personal org');
    assert.equal(organization.nameEncrypted, '');
    assert.equal(workspace.nameEncrypted, '');

    const org = (await query('SELECT name_encrypted FROM organizations WHERE id = $1', [organization.id])).rows[0];
    assert.equal(org.name_encrypted, '');
    const personalWs = (await query('SELECT name_encrypted FROM workspaces WHERE id = $1', [workspace.id])).rows[0];
    assert.equal(personalWs.name_encrypted, '');
  } finally {
    process.env.ENTERPRISE_MODE = previousMode;
  }
});
