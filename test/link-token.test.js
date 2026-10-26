'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';

// Invite-link tokens are derived from the link id under this secret, so
// GET /links/:noteId can re-show a share URL it never stored in the clear.
const SECRET = 'test-link-token-secret-at-least-32-chars!!';
process.env.LINK_TOKEN_SECRET = SECRET;

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { seedAccount } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();
const PUBKEY = 'lt-pub-1';
const PUBKEY_2 = 'lt-pub-2';
const OWNER = 'lt-owner';
const JOINER = 'lt-joiner';
const JOINER_2 = 'lt-joiner-2';
const NOTE_ID = 'note-link-token-0001';

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

function derive(linkId) {
  return crypto.createHmac('sha256', SECRET).update(linkId).digest('hex');
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedAccount(OWNER, PUBKEY);
  await seedPaid(OWNER);
  await seedAccount(JOINER, PUBKEY_2);
  await seedPaid(JOINER);
  await seedAccount(JOINER_2, PUBKEY);
  await seedPaid(JOINER_2);
  await query(
    'INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at) VALUES ($1, $2, $3, $4, $5)',
    [NOTE_ID, OWNER, OWNER, 'editor', now]
  );
});

test.after(async () => {
  delete process.env.LINK_TOKEN_SECRET;
  await close();
});

test('GET recomputes the invite token so a share URL survives a restart', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession(OWNER, { headers: {} });
  const joiner = await createSession(JOINER, { headers: {} });

  const create = await inject(app, owner, 'POST', `/collaboration/links/${NOTE_ID}`, { role: 'editor' });
  assert.equal(create.statusCode, 201, create.body);
  const created = create.json();
  assert.equal(created.token, derive(created.id), 'token derives from the link id');

  const listed = await inject(app, owner, 'GET', `/collaboration/links/${NOTE_ID}`);
  assert.equal(listed.statusCode, 200, listed.body);
  const row = listed.json().links.find((l) => l.id === created.id);
  assert.ok(row, 'link row listed');
  assert.equal(row.token, derive(created.id), 'GET hands the URL back without having stored it');
  assert.equal(
    crypto.createHash('sha256').update(row.token).digest('hex'),
    row.tokenHash,
    'recomputed token still verifies against the stored hash'
  );

  const join = await inject(app, joiner, 'POST', `/collaboration/join/${row.token}`);
  assert.equal(join.statusCode, 201, join.body);
  assert.equal(join.json().noteId, NOTE_ID);
  assert.equal(join.json().role, 'editor');
});

test('without the secret, GET returns no token and the created URL still works', async (t) => {
  delete process.env.LINK_TOKEN_SECRET;
  t.after(() => { process.env.LINK_TOKEN_SECRET = SECRET; });

  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const owner = await createSession(OWNER, { headers: {} });
  const joiner = await createSession(JOINER_2, { headers: {} });

  const create = await inject(app, owner, 'POST', `/collaboration/links/${NOTE_ID}`, { role: 'viewer' });
  assert.equal(create.statusCode, 201, create.body);
  const created = create.json();
  assert.notEqual(created.token, derive(created.id), 'no secret ⇒ random token, not derived');

  const listed = await inject(app, owner, 'GET', `/collaboration/links/${NOTE_ID}`);
  assert.equal(listed.statusCode, 200, listed.body);
  const row = listed.json().links.find((l) => l.id === created.id);
  assert.ok(row, 'link row listed');
  assert.equal(row.token, undefined, 'random-token links come back tokenless, never a guess');

  const join = await inject(app, joiner, 'POST', `/collaboration/join/${created.token}`);
  assert.equal(join.statusCode, 201, join.body);
  assert.equal(join.json().role, 'viewer');
});
