'use strict';

// Regression: an account that owns/edits SOME workspace must not be able to
// pre-claim a guessed note id for a note that has not been pushed yet and have
// that squat survive once the note is first registered to its real workspace.
// On first registration the server reconciles pre-existing collaboration rows:
// anything not created by a member of the owning workspace was a pre-claim and
// is purged, so the squatter can never be wrapped a note key. Legitimate
// pre-registration shares created by members survive.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-chars-long';
process.env.ENTERPRISE_MODE = 'false';
process.env.COLLAB_BOOTSTRAP_RATE_LIMIT_PER_MINUTE = '3';

const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register, authHeaders } = require('./helpers/factory');
const { storeNotesBatch } = require('../src/persistence/yjs');
const { buildApp } = require('../src/server');

const kem = () => crypto.randomBytes(1184).toString('hex');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await cleanTestDb();
});

async function seedPaidWorkspace(tag, role = 'owner') {
  const owner = await register('pro', { email: `${tag}-${role}@test.example` });
  const wsId = `ws-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, 'e', owner.id, now]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, owner.id, role, now]
  );
  return { owner, wsId };
}

async function addMember(wsId, accountId, role) {
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)',
    [wsId, accountId, role, new Date().toISOString()]
  );
}

async function seedInviteTarget(tag) {
  const email = `${tag}-target@test.example`;
  const account = await register('pro', { email });
  await query('UPDATE accounts SET kem_public_key = $1 WHERE id = $2', [kem(), account.id]);
  return { account, email };
}

async function post(app, url, headers, payload) {
  return app.inject({ method: 'POST', url, headers, payload });
}

async function registerNote(workspaceId, noteId) {
  return storeNotesBatch(workspaceId, [{
    noteId,
    updates: [{
      data: Buffer.from('encrypted-bytes'),
      encrypted: true,
      deviceId: 'device-1',
      sequence: 1,
      ts: Date.now(),
    }],
  }]);
}

test('a non-member pre-claim is purged (invitation and key) when the note is first registered', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { wsId: ownerWs } = await seedPaidWorkspace('reconcile-real');
  const attacker = await seedPaidWorkspace('reconcile-attacker');
  const attackerHeaders = await authHeaders(attacker.owner.id);
  const target = await seedInviteTarget('reconcile');
  const noteId = `note-${crypto.randomUUID()}`;

  // Attacker owns a workspace, so the unpushed-note bootstrap accepts them and
  // plants an invitation row for a note that (unknown to them) belongs to
  // someone else's workspace.
  const invite = await post(app, `/collaboration/invite/${noteId}`, attackerHeaders, {
    email: target.email, role: 'editor', workspaceId: attacker.wsId,
  });
  assert.equal(invite.statusCode, 201, invite.body);

  const before = await query('SELECT user_id FROM note_invitations WHERE note_id = $1', [noteId]);
  assert.equal(before.rowCount, 2, 'attacker + target pre-claim rows exist');

  // Simulate an envelope that could have been wrapped for the squatter before
  // the note existed server-side.
  await query(
    'INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,$3,$4,$5)',
    [noteId, attacker.owner.id, 'device-1', 'opaque', new Date().toISOString()]
  );

  const result = await registerNote(ownerWs, noteId);
  assert.ok(result.purgedClaims.length >= 1, 'registration must report the purge');

  const after = await query('SELECT user_id FROM note_invitations WHERE note_id = $1', [noteId]);
  assert.equal(after.rowCount, 0, 'pre-claim invitations purged');
  const keys = await query('SELECT user_id FROM note_keys WHERE note_id = $1', [noteId]);
  assert.equal(keys.rowCount, 0, 'pre-claim key envelope purged');

  const keyResp = await app.inject({
    method: 'GET', url: `/collaboration/keys/${noteId}`, headers: attackerHeaders,
  });
  assert.equal(keyResp.statusCode, 403, 'squatter is no longer a collaborator');
});

test('a pre-registration invite created by a member of the owning workspace survives', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('reconcile-owner');
  const ownerHeaders = await authHeaders(owner.id);
  const target = await seedInviteTarget('reconcile-member');
  const noteId = `note-${crypto.randomUUID()}`;

  const invite = await post(app, `/collaboration/invite/${noteId}`, ownerHeaders, {
    email: target.email, role: 'editor', workspaceId: wsId,
  });
  assert.equal(invite.statusCode, 201, invite.body);

  await query(
    'INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, created_at) VALUES ($1,$2,$3,$4,$5)',
    [noteId, target.account.id, 'device-1', 'opaque', new Date().toISOString()]
  );

  await registerNote(wsId, noteId);

  const invRows = await query('SELECT user_id FROM note_invitations WHERE note_id = $1 ORDER BY user_id', [noteId]);
  assert.equal(invRows.rowCount, 2, 'owner + invited member share both survive');
  const keyRows = await query('SELECT user_id FROM note_keys WHERE note_id = $1', [noteId]);
  assert.equal(keyRows.rowCount, 1, 'legitimate pre-registration envelope survives');
  assert.equal(keyRows.rows[0].user_id, target.account.id);
});

test('an editor of the owning workspace cannot bootstrap an unpushed note (owner only)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { wsId } = await seedPaidWorkspace('reconcile-editor');
  const editor = await register('pro', { email: 'reconcile-editor@test.example' });
  await addMember(wsId, editor.id, 'editor');
  const editorHeaders = await authHeaders(editor.id);
  const target = await seedInviteTarget('reconcile-editor-target');
  const noteId = `note-${crypto.randomUUID()}`;

  const invite = await post(app, `/collaboration/invite/${noteId}`, editorHeaders, {
    email: target.email, role: 'editor', workspaceId: wsId,
  });
  assert.equal(invite.statusCode, 403, invite.body);
  assert.equal(invite.json().error, 'note_ownership_required');
});

test('repeated pre-claim attempts are rate-limited and audited', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const attacker = await seedPaidWorkspace('reconcile-ratelimit');
  const attackerHeaders = await authHeaders(attacker.owner.id);
  const target = await seedInviteTarget('reconcile-ratelimit');

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const resp = await post(app, `/collaboration/invite/note-${crypto.randomUUID()}`, attackerHeaders, {
      email: target.email, role: 'editor', workspaceId: attacker.wsId,
    });
    statuses.push(resp.statusCode);
  }
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const auditRows = await query(
    "SELECT action FROM audit_logs WHERE action = 'note_claim_attempt'"
  );
  assert.ok(auditRows.rowCount >= 1, 'pre-claim attempts must be audited');
});

test('legitimate invites to a registered note are not throttled by the bootstrap budget', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { owner, wsId } = await seedPaidWorkspace('reconcile-registered');
  const ownerHeaders = await authHeaders(owner.id);
  const target = await seedInviteTarget('reconcile-registered');
  const noteId = `note-${crypto.randomUUID()}`;
  // The note is already server-registered: inviting collaborators is ordinary
  // collaboration traffic, not an unpushed-note pre-claim.
  await registerNote(wsId, noteId);

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const resp = await post(app, `/collaboration/invite/${noteId}`, ownerHeaders, {
      email: target.email, role: 'editor', workspaceId: wsId,
    });
    statuses.push(resp.statusCode);
  }
  assert.ok(
    statuses.every((s) => s < 300),
    `registered-note invites must not be throttled by the pre-claim budget: ${statuses.join(',')}`
  );
});
