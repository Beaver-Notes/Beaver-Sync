'use strict';

// Canonical shared test fixtures. One copy of each helper that used to live
// diverged in a dozen test files; variants are expressed as options params,
// never as second copies.
//
// All src/ modules are required lazily inside the helpers so this file can be
// imported before src/server (and thus before dotenv) loads: e.g.
// middleware/auth exits the process at require time if LEGACY_AUTH_ENABLED=true
// and the JWT key env vars are still unset.

require('./db'); // Own DATABASE_URL/STORAGE_ENDPOINT before anything loads src/db.

const crypto = require('node:crypto');

const NOW = () => new Date().toISOString();

// Raw-SQL account by fixed id. Canonical from e2e-backend/e2e-security;
// `username` is nullable TEXT UNIQUE, so always writing it is safe for suites
// that used the narrower insert.
async function seedAccount(id, kemPublicKey = null) {
  const { query } = require('../../src/db');
  await query(
    'INSERT INTO accounts (id, username, email_hmac, created_at, kem_public_key, email_verified) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, id, `${id}-email`, NOW(), kemPublicKey, true]
  );
}

// Account with throwaway unique id/email, for suites that don't care about identity.
async function makeAccount(tag) {
  const { query } = require('../../src/db');
  const id = `acct-${tag}-${crypto.randomUUID()}`;
  await query(
    'INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1, $2, $3, $4)',
    [id, `acct-hmac-${tag}-${crypto.randomUUID()}`, NOW(), true]
  );
  return id;
}

// Workspace owned by ownerId with an owner membership and a pro subscription.
async function seedWorkspace(id, ownerId, { nameEncrypted = 'name', plan = 'pro' } = {}) {
  const { query } = require('../../src/db');
  await query(
    'INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)',
    [id, nameEncrypted, ownerId, NOW()]
  );
  await query(
    'INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)',
    [id, ownerId, 'owner', NOW()]
  );
  await query(
    'INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [`${ownerId}-sub`, ownerId, plan, 'active', 1000000, 0, NOW()]
  );
}

// Org + owner membership + active org subscription (models layer).
async function seedOrg(orgId, ownerId, plan) {
  const models = require('../../src/models');
  await models.Organization.create({ id: orgId, nameEncrypted: 'e', slug: `slug-${orgId}`, createdAt: new Date() });
  await models.OrgMember.create({ orgId, accountId: ownerId, role: 'owner', createdAt: new Date() });
  await models.OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan, status: 'active', seats: 1, createdAt: new Date() });
}

// Registered account + subscription via the models layer. Pass { email } to
// control the address (covers the old registerWithEmail variant).
async function register(plan, { email, emailVerified } = {}) {
  const models = require('../../src/models');
  const address = email ?? `${plan}-${crypto.randomBytes(6).toString('hex')}@test.example`;
  let emailEncrypted = 'e';
  try {
    const mlkem = require('../../src/lib/mlkem');
    emailEncrypted = await mlkem.encryptMetadata(address);
  } catch (_) {
    // mlkem not initialized yet (unit tests without buildApp) — fallback keeps fixture usable
    emailEncrypted = 'e';
  }
  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY).update(address).digest('hex'),
    emailEncrypted,
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
    emailVerified: emailVerified ?? true,
  });
  await models.Subscription.create({
    accountId: account.id, plan, status: 'active',
    storageQuotaBytes: plan === 'free' ? 0 : 1024, storageUsedBytes: 0, createdAt: new Date(),
  });
  return account;
}

// Headers backed by a real DB session.
async function authHeaders(accountId) {
  const { createSession } = require('../../src/middleware/auth');
  const session = await createSession(accountId, { headers: {} });
  return { authorization: `Bearer ${session}`, 'content-type': 'application/json' };
}

// Bearer header backed by a stubbed models.Session.findOne (for suites that
// stub the session model). Restores nothing here; suites restore originals.
async function authHeaderFor(userId = '507f1f77bcf86cd799439011') {
  const models = require('../../src/models');
  const { hashSessionId } = require('../../src/lib/crypto');
  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  models.Session.findOne = async ({ idHash: h }) => {
    if (h === sessionIdHash) {
      return {
        idHash: h,
        accountId: userId,
        revoked: false,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        save: async () => {},
      };
    }
    return null;
  };
  return `Bearer ${rawId}`;
}

module.exports = {
  seedAccount,
  makeAccount,
  seedWorkspace,
  seedOrg,
  register,
  authHeaders,
  authHeaderFor,
};
