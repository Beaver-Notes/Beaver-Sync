'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(repoRoot, '.test-data', 'test.db');
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100';
process.env.LEGACY_AUTH_ENABLED = 'true';

const swaImpl = {
  generateRegistrationOptions: async () => ({ challenge: 'test-challenge-1' }),
  verifyRegistrationResponse: async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'cred-1',
        publicKey: Buffer.from('public-key-bytes'),
        counter: 0,
      },
    },
  }),
  generateAuthenticationOptions: async () => ({ challenge: 'test-challenge-2' }),
  verifyAuthenticationResponse: async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  }),
};

const swaMock = {
  generateRegistrationOptions: async (...args) => swaImpl.generateRegistrationOptions(...args),
  verifyRegistrationResponse: async (...args) => swaImpl.verifyRegistrationResponse(...args),
  generateAuthenticationOptions: async (...args) => swaImpl.generateAuthenticationOptions(...args),
  verifyAuthenticationResponse: async (...args) => swaImpl.verifyAuthenticationResponse(...args),
};

const swaPath = require.resolve('@simplewebauthn/server');
require.cache[swaPath] = {
  id: swaPath,
  filename: swaPath,
  loaded: true,
  exports: swaMock,
};

const { buildApp } = require('../src/server');
const models = require('../src/models');

const originalMethods = {
  Account: {
    findOne: models.Account.findOne,
    create: models.Account.create,
  },
  Credential: {
    findOne: models.Credential.findOne,
    find: models.Credential.find,
    create: models.Credential.create,
  },
  WebAuthnChallenge: {
    findOneAndDelete: models.WebAuthnChallenge.findOneAndDelete,
    create: models.WebAuthnChallenge.create,
  },
  Session: {
    findOne: models.Session.findOne,
    create: models.Session.create,
  },
  Subscription: {
    findOne: models.Subscription.findOne,
  },
};

function chain(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: () => value,
  };
}

function resetStubs() {
  models.Account.findOne = async () => null;
  models.Account.create = async (data) => ({ id: '507f1f77bcf86cd799439011', ...data });
  models.Credential.findOne = async () => null;
  models.Credential.find = () => chain([]);
  models.Credential.create = async (data) => ({ id: 'cred-id', ...data });
  models.WebAuthnChallenge.findOneAndDelete = async () => null;
  models.WebAuthnChallenge.create = async () => ({ id: 'challenge-id' });
  models.Session.findOne = async () => null;
  models.Session.create = async () => ({ id: 'sess-id' });
  models.Subscription.findOne = () => chain({
    accountId: '507f1f77bcf86cd799439011',
    plan: 'basic',
    status: 'active',
    storageUsedBytes: 0,
    storageQuotaBytes: 4 * 1024 * 1024 * 1024,
  });
}

test.after(() => {
  Object.assign(models.Account, originalMethods.Account);
  Object.assign(models.Credential, originalMethods.Credential);
  Object.assign(models.WebAuthnChallenge, originalMethods.WebAuthnChallenge);
  Object.assign(models.Session, originalMethods.Session);
  Object.assign(models.Subscription, originalMethods.Subscription);
  delete require.cache[swaPath];
});

async function makeApp() {
  resetStubs();
  delete require.cache[require.resolve('../src/routes/passkey')];
  return buildApp();
}

test('passkey registration begin returns options and stores challenge', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let challengeStored = null;
  models.WebAuthnChallenge.create = async (data) => { challengeStored = data; return { id: 'c1' }; };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/begin',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1', deviceLabel: 'MacBook' }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.challenge, 'test-challenge-1');
  assert.equal(challengeStored.emailHmac, 'hash1');
  assert.ok(challengeStored.expiresAt > new Date());
});

test('passkey registration complete verifies and creates credential', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  models.WebAuthnChallenge.findOneAndDelete = async () => ({ challenge: 'test-challenge-1' });
  models.Account.findOne = async () => ({ id: '507f1f77bcf86cd799439011', emailHmac: 'hash1', kdfSalt: 'salt1' });
  let credentialCreated = null;
  models.Credential.create = async (data) => { credentialCreated = data; return { id: 'c1' }; };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1', registrationResponse: {} }),
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(body.sessionToken);
  assert.equal(body.user.emailHash, 'hash1');
  assert.equal(credentialCreated.accountId, '507f1f77bcf86cd799439011');
  assert.equal(credentialCreated.credentialId, 'cred-1');
});

test('passkey login begin returns options for existing credentials', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  swaImpl.generateAuthenticationOptions = async ({ allowCredentials }) => ({ challenge: 'test-challenge-2', allowCredentials });
  models.Account.findOne = async () => ({ id: '507f1f77bcf86cd799439011', emailHmac: 'hash1' });
  models.Credential.find = () => chain([{ credentialId: 'cred-1' }]);
  let challengeStored = null;
  models.WebAuthnChallenge.create = async (data) => { challengeStored = data; return { id: 'c2' }; };

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/begin',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1' }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.challenge, 'test-challenge-2');
  assert.equal(challengeStored.emailHmac, 'hash1');
});

test('passkey login complete verifies and issues session', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  swaImpl.verifyAuthenticationResponse = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  });

  models.WebAuthnChallenge.findOneAndDelete = async () => ({ challenge: 'test-challenge-2' });
  models.Account.findOne = async () => ({ id: '507f1f77bcf86cd799439011', emailHmac: 'hash1' });

  let signCountUpdated = null;
  models.Credential.findOne = async () => ({
    id: 'cred-1',
    accountId: '507f1f77bcf86cd799439011',
    credentialId: 'cred-1',
    publicKey: Buffer.from('public-key-bytes').toString('base64url'),
    signCount: 0,
    save: async function () { signCountUpdated = this.signCount; },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/complete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1', authenticationResponse: { id: 'cred-1' } }),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.sessionToken);
  assert.equal(body.user.emailHash, 'hash1');
  assert.equal(signCountUpdated, 1);
});

test('passkey login rejects replay attack with non-increasing counter', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  swaImpl.verifyAuthenticationResponse = async () => ({
    verified: true,
    authenticationInfo: { newCounter: 0 },
  });

  models.WebAuthnChallenge.findOneAndDelete = async () => ({ challenge: 'test-challenge-2' });
  models.Account.findOne = async () => ({ id: '507f1f77bcf86cd799439011', emailHmac: 'hash1' });
  models.Credential.findOne = async () => ({
    id: 'cred-1',
    accountId: '507f1f77bcf86cd799439011',
    credentialId: 'cred-1',
    publicKey: Buffer.from('public-key-bytes').toString('base64url'),
    signCount: 0,
    save: async () => {},
  });

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/login/complete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1', authenticationResponse: { id: 'cred-1' } }),
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, 'replay_detected');
});

test('passkey registration rejects expired challenge', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  models.WebAuthnChallenge.findOneAndDelete = async () => null;

  const response = await app.inject({
    method: 'POST',
    url: '/auth/passkey/register/complete',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ emailHash: 'hash1', registrationResponse: {} }),
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error, 'challenge_expired');
});
