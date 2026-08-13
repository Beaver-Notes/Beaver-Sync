'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars-long-e2e';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long-e2e';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long-e2e';
process.env.ENTERPRISE_MODE = 'false';
process.env.SESSION_HMAC_KEY = process.env.SESSION_HMAC_KEY || 'test-session-hmac-key-at-least-32-characters-long';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const models = require('../src/models');
const crypto = require('node:crypto');

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
});

test.after(async () => {
  await close();
});

async function makeAccountWithPlan(plan, orgPlan, seats) {
  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY)
      .update(`${plan}-${crypto.randomBytes(6).toString('hex')}@test.example`)
      .digest('hex'),
    emailEncrypted: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
  await models.Subscription.create({
    accountId: account.id, plan, status: 'active',
    storageQuotaBytes: plan === 'free' ? 0 : 1024, storageUsedBytes: 0,
    createdAt: new Date(),
  });
  if (orgPlan) {
    const orgId = crypto.randomUUID();
    await models.Organization.create({ id: orgId, nameEncrypted: '', slug: `org-${crypto.randomUUID()}`, createdAt: new Date() });
    await models.OrgMember.create({ orgId, accountId: account.id, role: 'owner', createdAt: new Date() });
    await models.OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: orgPlan, status: 'active', seats, createdAt: new Date() });
  }
  return account;
}

test('requirePaidWrite rejects free plan with 402', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('free');

  const req = { userId: account.id, subscription: { plan: 'free' } };
  const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };

  await app.requirePaidWrite(req, reply);
  assert.equal(reply._sent.error, 'plan_upgrade_required');
});

test('requirePaidWrite allows starter', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter');

  const req = { userId: account.id, subscription: { plan: 'starter' } };
  const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };

  await app.requirePaidWrite(req, reply);
  assert.equal(reply._sent, undefined);
});

test('checkDeviceLimit enforces starter limit of 5', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter');
  await models.Subscription.updateOne(
    { accountId: account.id },
    { $set: { storageQuotaBytes: 10 * 1024 ** 3 } }
  );

  for (let i = 0; i < 5; i++) {
    await models.Device.create({ accountId: account.id, deviceId: `dev-${i}`, lastSeen: new Date(), createdAt: new Date() });
  }

  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  const req = { userId: account.id, subscription: sub, headers: { 'x-device-id': 'new-device' } };
  const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };
  await app.checkDeviceLimit(req, reply);
  assert.equal(reply._sent.error, 'device_limit_reached');
});

test('requirePaidWrite allows a free personal sub when the org is paid', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const req = {
    userId: 'any',
    subscription: { plan: 'free' },
    orgSubscription: { plan: 'team', seats: 5 },
  };
  const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };
  await app.requirePaidWrite(req, reply);
  assert.equal(reply._sent, undefined);
});

test('checkDeviceLimit uses the org plan first (team is unlimited)', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('starter', 'team', 5);

  for (let i = 0; i < 6; i++) {
    await models.Device.create({ accountId: account.id, deviceId: `dev-${i}`, lastSeen: new Date(), createdAt: new Date() });
  }

  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  const req = { userId: account.id, subscription: sub, orgSubscription: { plan: 'team', seats: 5 }, headers: { 'x-device-id': 'new-device' } };
  const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };
  await app.checkDeviceLimit(req, reply);
  assert.equal(reply._sent, undefined);
});

test('PLAN_OVERRIDE makes a free personal sub pass requirePaidWrite', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());

  const prevOverride = process.env.PLAN_OVERRIDE;
  process.env.PLAN_OVERRIDE = 'team';
  try {
    const req = { userId: 'any', subscription: { plan: 'free' }, orgSubscription: null };
    const reply = { status: () => ({ send: (body) => { reply._sent = body; } }) };
    await app.requirePaidWrite(req, reply);
    assert.equal(reply._sent, undefined);
  } finally {
    if (prevOverride === undefined) delete process.env.PLAN_OVERRIDE;
    else process.env.PLAN_OVERRIDE = prevOverride;
  }
});

test('requireActiveSync resolves the org from a workspaceId in the body', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const account = await makeAccountWithPlan('free', 'team', 5);

  const orgMember = await models.OrgMember.findOne({ accountId: account.id }).lean();
  const ws = await models.Workspace.create({ nameEncrypted: 'e', ownerId: account.id, orgId: orgMember.orgId, createdAt: new Date() });

  const req = { userId: account.id, body: { workspaceId: ws.id } };
  const reply = { status: () => ({ send: () => {} }) };
  await app.requireActiveSync(req, reply);
  assert.equal(req.orgSubscription?.plan, 'team');
});
