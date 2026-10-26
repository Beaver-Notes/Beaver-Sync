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
process.env.APP_URL = 'http://localhost:3000';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

const Module = require('node:module');
const originalLoad = Module._load;

// ---- stub IdP state ----
let samlValidateImpl = async () => ({ email: 'saml-user@example.com', nameID: 'saml-user@example.com' });
let samlAuthorizeUrlImpl = async () => 'https://idp.example.com/sso?SAMLRequest=fake';
let oidcUserInfoEmail = 'oidc-user@example.com';
let oidcUserInfoVerified = true;
let oidcCallbackShouldFail = false;
let capturedCodeVerifier = null;
let capturedCodeChallenge = null;

Module._load = function (request, parent, isMain) {
  if (request === '@node-saml/node-saml') {
    class FakeSAML {
      constructor(cfg) { this.cfg = cfg; }
      async getAuthorizeUrlAsync() { return samlAuthorizeUrlImpl(); }
      async validatePostResponseAsync(body) {
        if (body && body.SAMLResponse === 'bad-response') throw new Error('invalid SAML');
        return samlValidateImpl(body);
      }
    }
    return { SAML: FakeSAML, generateServiceProviderMetadata: () => '<xml>metadata</xml>' };
  }
  if (request === 'openid-client') {
    class FakeClient {
      constructor(opts) { this.opts = opts; }
      authorizationUrl(params) {
        capturedCodeChallenge = params.code_challenge;
        return `https://oidc.example.com/auth?state=${params.state}&code_challenge=${params.code_challenge}`;
      }
      async callback(_url, params, opts) {
        capturedCodeVerifier = opts.code_verifier;
        if (oidcCallbackShouldFail) throw new Error('token exchange failed');
        // verify PKCE: challenge must be S256(verifier)
        const expected = crypto.createHash('sha256').update(opts.code_verifier).digest('base64url');
        if (expected !== capturedCodeChallenge) throw new Error('PKCE mismatch');
        if (!params.code || params.code === 'bad-code') throw new Error('bad code');
        return { access_token: 'fake' };
      }
      async userinfo() {
        return { email: oidcUserInfoEmail, email_verified: oidcUserInfoVerified };
      }
    }
    const FakeIssuer = { discover: async (url) => ({ Client: FakeClient, issuer: url }) };
    return { Issuer: FakeIssuer };
  }
  return originalLoad.apply(this, arguments);
};

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const mlkem = require('../src/lib/mlkem');

async function makeWs(ownerId, id) {
  const { query: q } = require('../src/db');
  await q('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1,$2,$3,$4)', [id, 'enc', ownerId, new Date().toISOString()]);
  await q('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)', [id, ownerId, 'owner', new Date().toISOString()]);
  await q('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`${ownerId}-sub-${id}`, ownerId, 'enterprise', 'active', 9999999, 0, new Date().toISOString()]);
}

async function createSsoConfig({ workspaceId, slug, protocol, allowedEmailDomains, idpSsoUrl, oidcIssuer }) {
  // encrypt fields via mlkem for realism
  let idpCertSealed = null, spPrivateKeySealed = null, oidcClientSecretSealed = null;
  if (protocol === 'saml') {
    idpCertSealed = await mlkem.encryptMetadata('-----BEGIN CERTIFICATE-----\nMIIB fake\n-----END CERTIFICATE-----');
    spPrivateKeySealed = await mlkem.encryptMetadata('-----BEGIN PRIVATE KEY-----\nMIIB fake\n-----END PRIVATE KEY-----');
  }
  if (protocol === 'oidc') {
    oidcClientSecretSealed = await mlkem.encryptMetadata('client-secret');
  }
  return models.SsoConfig.create({
    workspaceId, protocol, slug,
    idpEntityId: protocol === 'saml' ? 'https://idp.example.com' : null,
    idpSsoUrl: protocol === 'saml' ? (idpSsoUrl ?? 'https://idp.example.com/sso') : null,
    idpCertSealed,
    oidcIssuer: protocol === 'oidc' ? (oidcIssuer ?? 'https://oidc.example.com') : null,
    oidcClientId: protocol === 'oidc' ? 'client-id' : null,
    oidcClientSecretSealed,
    spCert: null, spPrivateKeySealed,
    allowedEmailDomains: allowedEmailDomains ?? 'example.com',
    createdAt: new Date(),
  });
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  Module._load = originalLoad;
  await close();
});

// ---- SAML ----

test('saml: happy JIT provisions and session set', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-saml-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-saml-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  await createSsoConfig({ workspaceId: wsId, slug: `saml-${crypto.randomBytes(3).toString('hex')}`, protocol: 'saml', allowedEmailDomains: 'example.com' });
  const slug = (await models.SsoConfig.find({ workspaceId: wsId }).lean())[0].slug;
  samlValidateImpl = async () => ({ email: 'newuser@example.com', nameID: 'newuser@example.com' });
  const r = await app.inject({ method: 'POST', url: `/auth/sso/${slug}/acs`, headers: { 'content-type': 'application/json' }, payload: { SAMLResponse: 'valid-saml-token' } });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, /\/complete\?code=/);
  const { createEmailHash } = require('../src/lib/crypto');
  const h = createEmailHash('newuser@example.com');
  const acct = await models.Account.findOne({ emailHmac: h }).lean();
  assert.ok(acct, 'JIT should create account');
});

test('saml: domain allowlist blocks', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-saml2-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-saml2-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  await createSsoConfig({ workspaceId: wsId, slug: `saml-${crypto.randomBytes(3).toString('hex')}`, protocol: 'saml', allowedEmailDomains: 'allowed.com' });
  const slug = (await models.SsoConfig.find({ workspaceId: wsId }).lean())[0].slug;
  samlValidateImpl = async () => ({ email: 'intruder@evil.com', nameID: 'intruder@evil.com' });
  const r = await app.inject({ method: 'POST', url: `/auth/sso/${slug}/acs`, headers: { 'content-type': 'application/json' }, payload: { SAMLResponse: 'valid-saml-token' } });
  assert.equal(r.statusCode, 403);
});

test('saml: validation failure returns 401', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-saml3-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-saml3-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  await createSsoConfig({ workspaceId: wsId, slug: `saml-${crypto.randomBytes(3).toString('hex')}`, protocol: 'saml' });
  const slug = (await models.SsoConfig.find({ workspaceId: wsId }).lean())[0].slug;
  samlValidateImpl = async () => { throw new Error('sig invalid'); };
  const r = await app.inject({ method: 'POST', url: `/auth/sso/${slug}/acs`, headers: { 'content-type': 'application/json' }, payload: { SAMLResponse: 'valid-saml-token' } });
  assert.equal(r.statusCode, 401);
});

test('saml: JIT links existing account when domain allowlisted', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-saml4-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-saml4-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `saml-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'saml', allowedEmailDomains: 'example.com' });
  // pre-create account
  const { createEmailHash } = require('../src/lib/crypto');
  const email = 'existing@example.com';
  const h = createEmailHash(email);
  await models.Account.create({ emailHmac: h, emailSealed: await mlkem.encryptMetadata(email), createdAt: new Date() });
  await models.Subscription.create({ accountId: (await models.Account.findOne({ emailHmac: h }).lean()).id, plan: 'free', status: 'active', storageQuotaBytes: 0, createdAt: new Date() });
  const countBefore = await models.Account.countDocuments({});
  samlValidateImpl = async () => ({ email, nameID: email });
  const r = await app.inject({ method: 'POST', url: `/auth/sso/${slug}/acs`, headers: { 'content-type': 'application/json' }, payload: { SAMLResponse: 'valid-saml-token' } });
  assert.equal(r.statusCode, 302);
  const countAfter = await models.Account.countDocuments({});
  assert.equal(countAfter, countBefore, 'should link not duplicate');
});

test('saml: JIT fails closed when domain not allowlisted for existing account', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-saml5-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-saml5-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `saml-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'saml', allowedEmailDomains: 'allowed.com' });
  const { createEmailHash } = require('../src/lib/crypto');
  const email = 'victim@example.com';
  const h = createEmailHash(email);
  await models.Account.create({ emailHmac: h, emailSealed: await mlkem.encryptMetadata(email), createdAt: new Date() });
  samlValidateImpl = async () => ({ email, nameID: email });
  const r = await app.inject({ method: 'POST', url: `/auth/sso/${slug}/acs`, headers: { 'content-type': 'application/json' }, payload: { SAMLResponse: 'valid-saml-token' } });
  assert.equal(r.statusCode, 403);
});

// ---- OIDC ----

test('oidc: happy flow with PKCE and JIT', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  capturedCodeChallenge = null; capturedCodeVerifier = null;
  oidcUserInfoEmail = 'oidc-new@example.com'; oidcUserInfoVerified = true; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  assert.equal(login.statusCode, 301);
  const loc = login.headers.location;
  assert.match(loc, /oidc\.example\.com/);
  const state = new URL(loc).searchParams.get('state');
  assert.ok(state);
  // verify PKCE challenge is S256 of stored verifier
  const row = await models.SsoOidcState.findOne({ state }).lean();
  assert.ok(row);
  const expectedChallenge = crypto.createHash('sha256').update(row.codeVerifier).digest('base64url');
  assert.equal(capturedCodeChallenge, expectedChallenge);
  // callback
  const cb = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(cb.statusCode, 302);
  assert.match(cb.headers.location, /\/complete\?code=/);
  assert.equal(capturedCodeVerifier, row.codeVerifier, 'code_verifier must be forwarded to IdP');
  // state consumed
  const gone = await models.SsoOidcState.findOne({ state }).lean();
  assert.equal(gone, null);
  const { createEmailHash } = require('../src/lib/crypto');
  const acct = await models.Account.findOne({ emailHmac: createEmailHash('oidc-new@example.com') }).lean();
  assert.ok(acct);
});

test('oidc: domain allowlist blocks', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcUserInfoEmail = 'bad@evil.com'; oidcUserInfoVerified = true; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc2-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc2-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'allowed.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r.statusCode, 403);
});

test('oidc: email_verified false rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcUserInfoEmail = 'unverified@example.com'; oidcUserInfoVerified = false; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc3-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc3-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'email_not_verified');
});

test('oidc: missing state rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-oidc4-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc4-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc' });
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code` });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'missing_state');
});

test('oidc: invalid state rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const ownerId = `owner-oidc5-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc5-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc' });
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=not-a-state` });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'invalid_state');
});

test('oidc: reused state rejected (one-time)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcUserInfoEmail = 'reuse@example.com'; oidcUserInfoVerified = true; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc6-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc6-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  const r1 = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r1.statusCode, 302);
  const r2 = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.json().error, 'invalid_state');
});

test('oidc: expired state rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcUserInfoEmail = 'exp@example.com'; oidcUserInfoVerified = true; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc7-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc7-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  // expire by moving createdAt back 11 minutes
  await query("UPDATE sso_oidc_states SET created_at = NOW() - INTERVAL '11 minutes' WHERE state = $1", [state]);
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'state_expired');
});

test('oidc: PKCE code_verifier mismatch rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcUserInfoEmail = 'pkce@example.com'; oidcUserInfoVerified = true; oidcCallbackShouldFail = false;
  const ownerId = `owner-oidc8-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc8-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  // tamper stored verifier so challenge mismatches
  await query('UPDATE sso_oidc_states SET code_verifier = $1 WHERE state = $2', ['tampered-verifier-' + crypto.randomBytes(8).toString('hex'), state]);
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r.statusCode, 401);
});

test('oidc: token exchange failure returns 401', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  oidcCallbackShouldFail = true;
  const ownerId = `owner-oidc9-${crypto.randomBytes(3).toString('hex')}`;
  await query('INSERT INTO accounts (id, email_hmac, created_at, email_verified) VALUES ($1,$2,$3,$4)', [ownerId, `hmac-${ownerId}`, new Date().toISOString(), true]);
  const wsId = `ws-oidc9-${crypto.randomBytes(3).toString('hex')}`;
  await makeWs(ownerId, wsId);
  const slug = `oidc-${crypto.randomBytes(3).toString('hex')}`;
  await createSsoConfig({ workspaceId: wsId, slug, protocol: 'oidc', allowedEmailDomains: 'example.com' });
  const login = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/login` });
  const state = new URL(login.headers.location).searchParams.get('state');
  const r = await app.inject({ method: 'GET', url: `/auth/sso/${slug}/oidc/callback?code=good-code&state=${state}` });
  assert.equal(r.statusCode, 401);
  oidcCallbackShouldFail = false;
});
