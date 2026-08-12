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

test.before(() => {
  // Clean up leftover data from previous runs
  const db = getDb();
  db.exec('DELETE FROM vault_key_params');
  db.exec('DELETE FROM vault_proof_challenges');
  db.exec('DELETE FROM note_comments');
  db.exec('DELETE FROM note_invite_links');
  db.exec('DELETE FROM note_invitations');
  db.exec('DELETE FROM note_keys');
  db.exec('DELETE FROM workspace_members');
  db.exec('DELETE FROM workspace_invites');
  db.exec('DELETE FROM workspace_keys');
  db.exec('DELETE FROM org_members');
  db.exec('DELETE FROM org_invites');
  db.exec('DELETE FROM org_subscriptions');
  db.exec('DELETE FROM org_keys');
  db.exec('DELETE FROM organizations');
  db.exec('DELETE FROM audit_logs');
  db.exec('DELETE FROM sso_oidc_states');
  db.exec('DELETE FROM sso_configs');
  db.exec('DELETE FROM email_aliases');
  db.exec('DELETE FROM webauthn_challenges');
  db.exec('DELETE FROM quick_connect_codes');
  db.exec('DELETE FROM compaction_locks');
  db.exec('DELETE FROM credentials');
  db.exec('DELETE FROM devices');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM subscriptions');
  db.exec('DELETE FROM commits');
  db.exec('DELETE FROM workspaces');
  db.exec('DELETE FROM accounts');

  db.prepare('INSERT INTO accounts (id, email_hmac, created_at) VALUES (?, ?, ?)').run('vault-account', 'vault-email', now);
  db.prepare('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES (?, ?, ?, ?)').run('vault-workspace', 'name', 'vault-account', now);
  db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)').run('vault-workspace', 'vault-account', 'owner', now);
  db.prepare('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES (?, ?, ?, ?)').run('vault-workspace-two', 'name', 'vault-account', now);
  db.prepare('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)').run('vault-workspace-two', 'vault-account', 'owner', now);
});

test.after(() => {
  close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
});

test('publish rejects plaintext passphrase and requires a proof', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('vault-account', { headers: {} });
  const response = await app.inject({
    method: 'PUT',
    url: '/vault/vault-workspace/key-params',
    headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
    payload: { passphrase: 'plaintext', keyParams: 'blob', passphraseProof: 'proof' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'validation_error');
});

test('verify accepts a proof and rejects a plaintext passphrase field', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('vault-account', { headers: {} });
  const headers = { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
  const challenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace/challenge', headers, payload: {} });
  const publish = await app.inject({
    method: 'PUT',
    url: '/vault/vault-workspace/key-params',
    headers,
    payload: { keyParams: 'blob', passphraseProof: 'proof-a', challenge: challenge.json().challenge },
  });
  assert.equal(publish.statusCode, 200);

  const plaintextVerify = await app.inject({
    method: 'POST',
    url: '/vault/vault-workspace/verify',
    headers,
    payload: { passphrase: 'plaintext' },
  });
  assert.equal(plaintextVerify.statusCode, 400);

  const verifyChallenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace/challenge', headers, payload: {} });
  const verify = await app.inject({
    method: 'POST',
    url: '/vault/vault-workspace/verify',
    headers,
    payload: { passphraseProof: 'proof-a', challenge: verifyChallenge.json().challenge },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().verified, true);
});

test('rejects a proof issued for another workspace', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('vault-account', { headers: {} });
  const headers = { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
  const challenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace/challenge', headers, payload: {} });
  const publish = await app.inject({
    method: 'PUT', url: '/vault/vault-workspace/key-params', headers,
    payload: { keyParams: 'blob-a', passphraseProof: 'proof-a', challenge: challenge.json().challenge },
  });
  assert.equal(publish.statusCode, 200);
  const otherChallenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace-two/challenge', headers, payload: {} });
  const verify = await app.inject({
    method: 'POST', url: '/vault/vault-workspace/verify', headers,
    payload: { passphraseProof: 'proof-a', challenge: otherChallenge.json().challenge },
  });
  assert.equal(verify.statusCode, 401);
});

test('consumes a challenge exactly once', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const session = await createSession('vault-account', { headers: {} });
  const headers = { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
  const challenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace/challenge', headers, payload: {} });
  const payload = { keyParams: 'blob-replay', passphraseProof: 'proof-replay', challenge: challenge.json().challenge };
  const first = await app.inject({ method: 'PUT', url: '/vault/vault-workspace/key-params', headers, payload });
  assert.equal(first.statusCode, 200);
  const replay = await app.inject({ method: 'PUT', url: '/vault/vault-workspace/key-params', headers, payload });
  assert.equal(replay.statusCode, 401);
});

test('rejects an expired challenge', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const db = getDb();
  const challenge = 'expired-challenge';
  const hash = require('node:crypto').createHash('sha256').update(challenge).digest('hex');
  db.prepare('INSERT INTO vault_proof_challenges (id, workspace_id, account_id, challenge_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('expired-challenge-row', 'vault-workspace', 'vault-account', hash, '2000-01-01T00:00:00.000Z', now);
  const session = await createSession('vault-account', { headers: {} });
  const headers = { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
  const verify = await app.inject({
    method: 'POST', url: '/vault/vault-workspace/verify', headers,
    payload: { passphraseProof: 'proof', challenge },
  });
  assert.equal(verify.statusCode, 401);
  assert.equal(verify.json().error, 'invalid_challenge');
});

test('gates legacy rows until the owner republishes', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const db = getDb();
  const bcrypt = require('bcrypt');
  db.prepare('INSERT OR REPLACE INTO vault_key_params (id, workspace_id, owner_id, passphrase_hash, key_params_blob, created_at, updated_at, proof_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-row', 'vault-workspace', 'vault-account', await bcrypt.hash('legacy-passphrase', 4), 'legacy-blob', now, now, 0);
  const session = await createSession('vault-account', { headers: {} });
  const headers = { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
  const challenge = await app.inject({ method: 'POST', url: '/vault/vault-workspace/challenge', headers, payload: {} });
  const verify = await app.inject({
    method: 'POST', url: '/vault/vault-workspace/verify', headers,
    payload: { passphraseProof: 'legacy-passphrase', challenge: challenge.json().challenge },
  });
  assert.equal(verify.statusCode, 409);
  assert.equal(verify.json().error, 'vault_republish_required');
});
