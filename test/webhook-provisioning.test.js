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
process.env.STRIPE_SECRET_KEY = 'sk_test_123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_1H2tM1e2whsecTestSecretKey1234567890abcdef';
process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly';
process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_yearly';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly';
process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const models = require('../src/models');

function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function makeStripeEvent(type, object) {
  return {
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    object: 'event',
    type,
    data: { object },
    created: Math.floor(Date.now() / 1000),
  };
}

// Minimal recorded payloads
function checkoutSessionCompletedPayload(accountId) {
  return makeStripeEvent('checkout.session.completed', {
    id: 'cs_test_123',
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    client_reference_id: accountId,
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: accountId },
  });
}

function subscriptionUpdatedPayload(accountId, { status = 'active', priceId = 'price_pro_monthly', cancelAtPeriodEnd = false, periodEnd = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return makeStripeEvent('customer.subscription.updated', {
    id: 'sub_test_123',
    object: 'subscription',
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    current_period_end: periodEnd ?? (now + 86400),
    customer: 'cus_test_123',
    metadata: { userId: accountId },
    items: { data: [{ price: { id: priceId, product: priceId.includes('team') ? 'prod_team' : priceId.includes('pro') ? 'prod_pro' : 'prod_starter' } }] },
  });
}

function subscriptionDeletedPayload(accountId, priceId = 'price_pro_monthly') {
  return makeStripeEvent('customer.subscription.deleted', {
    id: 'sub_test_123',
    object: 'subscription',
    status: 'canceled',
    current_period_end: Math.floor(Date.now() / 1000) - 10,
    customer: 'cus_test_123',
    metadata: { userId: accountId },
    items: { data: [{ price: { id: priceId, product: priceId.includes('team') ? 'prod_team' : 'prod_pro' } }] },
  });
}

function invoicePaidPayload(accountId) {
  return makeStripeEvent('invoice.paid', {
    id: 'in_test_123',
    object: 'invoice',
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: accountId },
    subscription_details: { metadata: { userId: accountId } },
  });
}

function invoicePaymentFailedPayload(accountId) {
  return makeStripeEvent('invoice.payment_failed', {
    id: 'in_test_failed',
    object: 'invoice',
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: accountId },
    subscription_details: { metadata: { userId: accountId } },
  });
}

async function postStripeWebhook(app, event) {
  const rawBody = JSON.stringify(event);
  const sig = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: rawBody,
  });
  return res;
}

async function makeAccountWithFreePlan() {
  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY).update(`wh-${crypto.randomBytes(6).toString('hex')}@test.example`).digest('hex'),
    emailSealed: 'e',
    passwordHash: '$2b$12$test',
    kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
  await models.Subscription.create({
    accountId: account.id, plan: 'free', status: 'active',
    storageQuotaBytes: 0, storageUsedBytes: 0, createdAt: new Date(),
  });
  return account;
}

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => { await close(); });

test('checkout.session.completed provisions paid account (idempotent)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  // upgrade subscription to pro before webhook (simulates prior billing state)
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 50 * 1024 ** 3 } });
  const event = checkoutSessionCompletedPayload(account.id);
  const rawBody = JSON.stringify(event);
  const sig = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const res1 = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: rawBody,
  });
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(res1.json(), { received: true, processed: true });
  const orgsAfterFirst = await models.Organization.find({}).lean();
  assert.equal(orgsAfterFirst.length, 1);
  const workspacesAfterFirst = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.equal(workspacesAfterFirst.length, 1);
  // duplicate delivery same rawBody + same sig timestamp would differ; recreate with same event id but fresh signature
  const sig2 = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const res2 = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'stripe-signature': sig2, 'content-type': 'application/json' },
    payload: rawBody,
  });
  assert.equal(res2.statusCode, 200);
  const orgsAfterSecond = await models.Organization.find({}).lean();
  assert.equal(orgsAfterSecond.length, 1, 'duplicate checkout should not create second org');
  const workspacesAfterSecond = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.equal(workspacesAfterSecond.length, 1);
});

test('customer.subscription.updated active provisions and is idempotent', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'starter', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 10 * 1024 ** 3 } });
  const event = subscriptionUpdatedPayload(account.id, { status: 'active', priceId: 'price_starter_monthly' });
  const res1 = await postStripeWebhook(app, event);
  assert.equal(res1.statusCode, 200);
  const orgs1 = await models.Organization.find({}).lean();
  assert.ok(orgs1.length >= 1);
  const ws1 = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.ok(ws1.length >= 1);
  // duplicate same event
  const res2 = await postStripeWebhook(app, event);
  assert.equal(res2.statusCode, 200);
  const orgs2 = await models.Organization.find({}).lean();
  assert.equal(orgs2.length, orgs1.length, 'duplicate subscription.updated should be idempotent');
});

test('subscription.updated with cancel_at_period_end keeps active until period end', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 50 * 1024 ** 3 } });
  // first provision via active event
  const activeEvt = subscriptionUpdatedPayload(account.id, { status: 'active', priceId: 'price_pro_monthly', cancelAtPeriodEnd: false });
  await postStripeWebhook(app, activeEvt);
  let sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.status, 'active');
  assert.equal(sub.plan, 'pro');
  // cancel at period end - future expiry
  const future = Math.floor(Date.now() / 1000) + 86400;
  const cancelEvt = subscriptionUpdatedPayload(account.id, { status: 'active', priceId: 'price_pro_monthly', cancelAtPeriodEnd: true, periodEnd: future });
  const res = await postStripeWebhook(app, cancelEvt);
  assert.equal(res.statusCode, 200);
  sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.status, 'active', 'cancel_at_period_end should keep status active');
  assert.equal(sub.plan, 'pro', 'should not downgrade before period end');
  const ws = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.ok(ws.length >= 1);
});

test('customer.subscription.deleted downgrades at period end (idempotent)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 50 * 1024 ** 3, storageUsedBytes: 0 } });
  // provision first
  const evt = subscriptionUpdatedPayload(account.id, { status: 'active', priceId: 'price_pro_monthly' });
  await postStripeWebhook(app, evt);
  let sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.plan, 'pro');
  // now delete - period already ended (renewsAt in past)
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { renewsAt: new Date(Date.now() - 1000).toISOString() } });
  const delEvt = subscriptionDeletedPayload(account.id, 'price_pro_monthly');
  const res1 = await postStripeWebhook(app, delEvt);
  assert.equal(res1.statusCode, 200);
  sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.plan, 'free', 'deleted subscription should downgrade to free at period end');
  assert.equal(sub.status, 'expired');
  // duplicate deleted should stay free and not error
  const res2 = await postStripeWebhook(app, delEvt);
  assert.equal(res2.statusCode, 200);
  sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.plan, 'free');
});

test('invoice.paid provisions paid account', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'team', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 100 * 1024 ** 3 } });
  const evt = invoicePaidPayload(account.id);
  const res = await postStripeWebhook(app, evt);
  assert.equal(res.statusCode, 200);
  const ws = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.ok(ws.length >= 1, 'invoice.paid should provision');
  // duplicate
  const res2 = await postStripeWebhook(app, evt);
  assert.equal(res2.statusCode, 200);
  const ws2 = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.equal(ws2.length, ws.length);
});

test('invoice.payment_failed marks grace period', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'starter', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 10 * 1024 ** 3 } });
  const evt = invoicePaymentFailedPayload(account.id);
  const res = await postStripeWebhook(app, evt);
  assert.equal(res.statusCode, 200);
  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.status, 'grace_period');
  // duplicate still grace_period not downgrade
  const res2 = await postStripeWebhook(app, evt);
  assert.equal(res2.statusCode, 200);
  const sub2 = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub2.status, 'grace_period');
});

test('invoice.payment_succeeded variant provisions', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_test_123', stripeSubscriptionId: 'sub_test_123', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 50 * 1024 ** 3 } });
  const evt = makeStripeEvent('invoice.payment_succeeded', {
    id: 'in_succeeded',
    object: 'invoice',
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: account.id },
    subscription_details: { metadata: { userId: account.id } },
  });
  const res = await postStripeWebhook(app, evt);
  assert.equal(res.statusCode, 200);
  const ws = await models.Workspace.find({ ownerId: account.id }).lean();
  assert.ok(ws.length >= 1);
});
