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
const { buildApp } = require('../src/server');
const { createSession } = require('../src/middleware/auth');

const now = new Date().toISOString();

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();

  await query('INSERT INTO accounts (id, email_hmac, created_at) VALUES ($1, $2, $3)', ['vault-account', 'vault-email', now]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', ['vault-workspace', 'name', 'vault-account', now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', ['vault-workspace', 'vault-account', 'owner', now]);
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', ['vault-workspace-two', 'name', 'vault-account', now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', ['vault-workspace-two', 'vault-account', 'owner', now]);
});

test.after(async () => {
  await close();
});

test('publish rejects plaintext passphrase and requires a proof', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
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
  t.after(async () => { await app.close(); });
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
  t.after(async () => { await app.close(); });
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
  t.after(async () => { await app.close(); });
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
  t.after(async () => { await app.close(); });
  const challenge = 'expired-challenge';
  const hash = require('node:crypto').createHash('sha256').update(challenge).digest('hex');
  await query(
    'INSERT INTO vault_proof_challenges (id, workspace_id, account_id, challenge_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    ['expired-challenge-row', 'vault-workspace', 'vault-account', hash, '2000-01-01T00:00:00.000Z', now]
  );
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
  t.after(async () => { await app.close(); });
  const bcrypt = require('bcrypt');
  await query(
    `INSERT INTO vault_key_params (id, workspace_id, owner_id, passphrase_hash, key_params_blob, created_at, updated_at, proof_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET
       id = EXCLUDED.id,
       owner_id = EXCLUDED.owner_id,
       passphrase_hash = EXCLUDED.passphrase_hash,
       key_params_blob = EXCLUDED.key_params_blob,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       proof_version = EXCLUDED.proof_version`,
    ['legacy-row', 'vault-workspace', 'vault-account', await bcrypt.hash('legacy-passphrase', 4), 'legacy-blob', now, now, 0]
  );
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
