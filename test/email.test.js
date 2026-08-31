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
process.env.NOTIFY_DOMAIN = 'notify.test.example.com';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const email = require('../src/lib/email');
const emailTemplates = require('../src/email');
const { extractAlias } = require('../src/routes/email');
const mlkem = require('../src/lib/mlkem');

const counter = { value: 0 };

async function registerAccount(emailAddr) {
  const emailHash = crypto
    .createHmac('sha256', process.env.EMAIL_HMAC_KEY)
    .update(emailAddr.trim().toLowerCase())
    .digest('hex');
  const emailEncrypted = await mlkem.encryptMetadata(emailAddr);

  const account = await models.Account.create({
    emailHmac: emailHash,
    emailEncrypted,
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });

  return { id: account.id, emailEncrypted };
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await close();
});

test('createEmailAlias stores mapping and returns alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('alice@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted);

  assert.ok(alias, 'should return an alias string');
  assert.ok(alias.endsWith('@notify.test.example.com'), 'should end with notify domain');
  assert.match(alias, /^[A-Za-z0-9_-]+@/, 'alias token should be base64url');

  const stored = await models.EmailAlias.findOne({ alias }).lean();
  assert.ok(stored, 'should be stored in database');
  assert.equal(stored.accountId, id);
  assert.equal(stored.emailEncrypted, emailEncrypted);
});

test('createEmailAlias with TTL sets expiresAt', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('bob@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted, 3600_000);

  const stored = await models.EmailAlias.findOne({ alias }).lean();
  assert.ok(stored.expiresAt, 'should have expiresAt');
  assert.ok(new Date(stored.expiresAt) > new Date(), 'should be in the future');
});

test('resolveAlias returns decrypted email for valid alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('carol@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted);

  const resolved = await email.resolveAlias(alias);
  assert.ok(resolved, 'should resolve');
  assert.equal(resolved.accountId, id);
  assert.equal(resolved.email, 'carol@example.com');
});

test('resolveAlias returns null for non-existent alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const resolved = await email.resolveAlias('nonexistent@notify.test.example.com');
  assert.equal(resolved, null);
});

test('resolveAlias returns null and deletes expired alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('dave@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted, -1);

  const resolved = await email.resolveAlias(alias);
  assert.equal(resolved, null);

  const stored = await models.EmailAlias.findOne({ alias }).lean();
  assert.equal(stored, null, 'expired alias should be deleted');
});

test('deleteAlias removes alias from database', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('eve@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted);

  await email.deleteAlias(alias);
  const stored = await models.EmailAlias.findOne({ alias }).lean();
  assert.equal(stored, null);
});

test('deleteAliasesForAccount removes all aliases for account', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted: enc1 } = await registerAccount('frank@example.com');
  const enc2 = await mlkem.encryptMetadata('frank2@example.com');
  await email.createEmailAlias(id, enc1);
  await email.createEmailAlias(id, enc2);

  let count = await models.EmailAlias.countDocuments({ accountId: id });
  assert.equal(count, 2);

  await email.deleteAliasesForAccount(id);
  count = await models.EmailAlias.countDocuments({ accountId: id });
  assert.equal(count, 0);
});

test('sendWithAlias gracefully skips when no API key', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id } = await registerAccount('sendtest@example.com');
  await email.sendWithAlias(app, id, 'Test', '<p>test</p>');
  assert.ok(true, 'should not throw');
});

test('sendWelcomeEmail gracefully skips when no API key', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id } = await registerAccount('welcome@example.com');
  await emailTemplates.sendWelcomeEmail(app, id);
  assert.ok(true, 'should not throw');
});

test('extractAlias returns alias for matching domain', () => {
  const result = extractAlias('token123@notify.test.example.com');
  assert.equal(result, 'token123@notify.test.example.com');
});

test('extractAlias handles angle-bracket format', () => {
  const result = extractAlias('User <token456@notify.test.example.com>');
  assert.equal(result, 'token456@notify.test.example.com');
});

test('extractAlias returns null for non-matching domain', () => {
  const result = extractAlias('token@other.com');
  assert.equal(result, null);
});

test('extractAlias returns null for null input', () => {
  assert.equal(extractAlias(null), null);
  assert.equal(extractAlias(undefined), null);
});

test('extractAlias returns null for beavernotes domain', () => {
  const result = extractAlias('token@beavernotes.com');
  assert.equal(result, null);
});

test('inbound webhook returns handled:false for unknown alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const res = await app.inject({
    method: 'POST',
    url: '/email/inbound',
    headers: { 'content-type': 'application/json' },
    payload: {
      to: 'unknown@notify.test.example.com',
      from: 'sender@other.com',
      subject: 'Reply',
      text: 'Hello',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().handled, false);
});

test('inbound webhook resolves valid alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('grace@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted);

  const res = await app.inject({
    method: 'POST',
    url: '/email/inbound',
    headers: { 'content-type': 'application/json' },
    payload: {
      to: alias,
      from: 'sender@other.com',
      subject: 'Re: Notification',
      text: 'Thanks!',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.json().handled, 'should be handled');
});

test('alias cascade deletes with account', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  const { id, emailEncrypted } = await registerAccount('hank@example.com');
  const alias = await email.createEmailAlias(id, emailEncrypted);

  await models.Account.deleteOne({ _id: id });

  const stored = await models.EmailAlias.findOne({ alias }).lean();
  assert.equal(stored, null, 'alias should cascade delete with account');
});

test('forwardToRealEmail throws for unknown alias', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });

  await assert.rejects(
    () => email.forwardToRealEmail('ghost@notify.test.example.com', {}),
    /not found/,
  );
});
