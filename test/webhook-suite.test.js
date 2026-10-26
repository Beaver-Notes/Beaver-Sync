'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const jwt = require('jsonwebtoken');

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
process.env.STRIPE_SECRET_KEY = 'sk_test_webhook_suite';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_webhook_suite_secret_1234567890abcdef';
process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly';
process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_yearly';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly';
process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly';
process.env.APPLE_BUNDLE_ID = 'com.beaver.test';
process.env.APP_URL = 'http://localhost:3000';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
const models = require('../src/models');

// Stripe helper
function stripeSignature(rawBody, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
function makeStripeEvent(type, object) {
  return { id: `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type, data: { object }, created: Math.floor(Date.now() / 1000) };
}

// Apple helpers — generate RSA + self-signed cert via openssl once
let appleKid = 'test-kid-1';
let applePrivatePem = null;
let appleX5cB64 = null;
let appleOtherPrivatePem = null;

function genAppleCert(tmpDir) {
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  const otherKeyPath = path.join(tmpDir, 'other.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout "${keyPath}" -out "${certPath}" -subj "/CN=apple-test" 2>/dev/null`);
  execSync(`openssl genrsa -out "${otherKeyPath}" 2048 2>/dev/null`);
  applePrivatePem = fs.readFileSync(keyPath, 'utf8');
  const certPem = fs.readFileSync(certPath, 'utf8');
  appleX5cB64 = certPem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
  appleOtherPrivatePem = fs.readFileSync(otherKeyPath, 'utf8');
}

function signAppleJwt(payload, kid, privatePem) {
  return jwt.sign(payload, privatePem, { algorithm: 'RS256', header: { kid } });
}

function makeAppleNotification({ bundleId, appAccountToken, productId, originalTransactionId, expiresDate, notificationType, subtype }) {
  const txPayload = {
    bundleId: bundleId ?? process.env.APPLE_BUNDLE_ID,
    appAccountToken: appAccountToken ?? null,
    productId: productId ?? 'pro_monthly',
    originalTransactionId: originalTransactionId ?? `orig_${crypto.randomBytes(4).toString('hex')}`,
    expiresDate: expiresDate ?? String(Date.now() + 86400000),
    transactionId: `tx_${crypto.randomBytes(4).toString('hex')}`,
  };
  const signedTransactionInfo = signAppleJwt(txPayload, appleKid, applePrivatePem);
  const outer = {
    notificationType: notificationType ?? 'SUBSCRIBED',
    subtype: subtype ?? 'INITIAL_BUY',
    data: { signedTransactionInfo },
  };
  return signAppleJwt(outer, appleKid, applePrivatePem);
}

// Google Pub/Sub helper
function b64Json(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64'); }

async function makeAccountWithFreePlan() {
  const id = `wh-${crypto.randomBytes(6).toString('hex')}`;
  const account = await models.Account.create({
    emailHmac: crypto.createHmac('sha256', process.env.EMAIL_HMAC_KEY).update(`${id}@test.example`).digest('hex'),
    emailSealed: 'e', passwordHash: '$2b$12$test', kdfSalt: crypto.randomBytes(32).toString('hex'),
  });
  await models.Subscription.create({ accountId: account.id, plan: 'free', status: 'active', storageQuotaBytes: 0, storageUsedBytes: 0, createdAt: new Date() });
  return account;
}

let rawFetch;
let originalVerifyIdToken;

test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-wh-'));
  genAppleCert(tmp);
  await setupTestDb();
  await cleanTestDb();
  // mock global.fetch for Apple JWKS
  rawFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('storekit') || String(url).includes('apple.com')) {
      return { json: async () => ({ keys: [{ kid: appleKid, x5c: [appleX5cB64] }] }) };
    }
    return rawFetch(url);
  };
  // mock Google OAuth2Client.verifyIdToken
  const { OAuth2Client } = require('google-auth-library');
  originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
  OAuth2Client.prototype.verifyIdToken = async function ({ idToken, audience }) {
    if (idToken === 'valid-google-jwt') {
      return { getPayload: () => ({ iss: 'pubsub.googleapis.com', aud: audience }) };
    }
    if (idToken === 'wrong-iss-jwt') {
      return { getPayload: () => ({ iss: 'evil.com', aud: audience }) };
    }
    throw new Error('invalid token');
  };
});

test.after(async () => {
  global.fetch = rawFetch;
  const { OAuth2Client } = require('google-auth-library');
  OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
  await close();
});

// ---- Stripe ----

test('stripe: valid signature provisions and idempotent redelivery', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_wh_1', stripeSubscriptionId: 'sub_wh_1', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 50 * 1024 ** 3 } });
  const evt = makeStripeEvent('checkout.session.completed', { id: 'cs_wh_1', object: 'checkout.session', payment_status: 'paid', status: 'complete', client_reference_id: account.id, customer: 'cus_wh_1', subscription: 'sub_wh_1', metadata: { userId: account.id } });
  const rawBody = JSON.stringify(evt);
  const sig = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const r1 = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, payload: rawBody });
  assert.equal(r1.statusCode, 200); assert.deepEqual(r1.json(), { received: true, processed: true });
  const orgs1 = await models.Organization.find({}).lean();
  assert.equal(orgs1.length, 1);
  const sig2 = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const r2 = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'stripe-signature': sig2, 'content-type': 'application/json' }, payload: rawBody });
  assert.equal(r2.statusCode, 200);
  const orgs2 = await models.Organization.find({}).lean();
  assert.equal(orgs2.length, 1, 'stripe redelivery must be idempotent');
});

test('stripe: tampered payload rejected (processed:false)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const evt = makeStripeEvent('checkout.session.completed', { id: 'cs_wh_t', object: 'checkout.session', payment_status: 'paid', status: 'complete', client_reference_id: account.id, customer: 'cus_wh_t', subscription: 'sub_wh_t', metadata: { userId: account.id } });
  const rawBody = JSON.stringify(evt);
  const sig = stripeSignature(rawBody, process.env.STRIPE_WEBHOOK_SECRET);
  const tampered = rawBody.replace('paid', 'free');
  const r = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, payload: tampered });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().processed, false);
});

test('stripe: wrong secret rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const evt = makeStripeEvent('checkout.session.completed', { id: 'cs_wh_w', object: 'checkout.session', payment_status: 'paid', status: 'complete', client_reference_id: 'nope', customer: 'cus_x', subscription: 'sub_x', metadata: { userId: 'nope' } });
  const rawBody = JSON.stringify(evt);
  const sig = stripeSignature(rawBody, 'whsec_wrong_secret_1234567890abcdef');
  const r = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, payload: rawBody });
  assert.equal(r.json().processed, false);
});

test('stripe: missing signature returns 400', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const evt = makeStripeEvent('checkout.session.completed', { id: 'cs_wh_m', object: 'checkout.session', payment_status: 'paid', status: 'complete', client_reference_id: 'x', customer: 'cus_x', subscription: 'sub_x', metadata: { userId: 'x' } });
  const r = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(evt) });
  assert.equal(r.statusCode, 400);
});

test('stripe: subscription.updated idempotent redelivery', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { plan: 'starter', status: 'active', stripeCustomerId: 'cus_wh_s', stripeSubscriptionId: 'sub_wh_s', renewsAt: new Date(Date.now() + 86400000).toISOString(), storageQuotaBytes: 10 * 1024 ** 3 } });
  const evt = makeStripeEvent('customer.subscription.updated', { id: 'sub_wh_s', object: 'subscription', status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 86400, customer: 'cus_wh_s', metadata: { userId: account.id }, items: { data: [{ price: { id: 'price_starter_monthly', product: '' } }] } });
  const post = async () => {
    const raw = JSON.stringify(evt);
    const sig = stripeSignature(raw, process.env.STRIPE_WEBHOOK_SECRET);
    return app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, payload: raw });
  };
  const r1 = await post(); assert.equal(r1.statusCode, 200);
  const r2 = await post(); assert.equal(r2.statusCode, 200);
  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.plan, 'starter'); assert.equal(sub.status, 'active');
});

// ---- Apple ----

test('apple: valid JWS provisions', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const signedPayload = makeAppleNotification({ appAccountToken: account.id });
  const r = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().received, true);
  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.ok(sub); assert.equal(sub.status, 'active');
});

test('apple: invalid signature rejected (processed:false)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const good = makeAppleNotification({ appAccountToken: account.id });
  // tamper payload: flip last char
  const tampered = good.slice(0, -2) + (good.slice(-2, -1) === 'a' ? 'b' : 'a') + good.slice(-1);
  const r = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload: tampered } });
  assert.equal(r.json().processed, false);
});

test('apple: wrong signing key rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const tx = signAppleJwt({ bundleId: process.env.APPLE_BUNDLE_ID, appAccountToken: account.id, productId: 'pro_monthly', originalTransactionId: 'orig_x', expiresDate: String(Date.now() + 864e5) }, appleKid, applePrivatePem);
  const outer = signAppleJwt({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', data: { signedTransactionInfo: tx } }, appleKid, appleOtherPrivatePem);
  const r = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload: outer } });
  assert.equal(r.json().processed, false);
});

test('apple: bundleId mismatch rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const bad = makeAppleNotification({ appAccountToken: account.id, bundleId: 'com.evil.app' });
  const r = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload: bad } });
  assert.equal(r.json().processed, false);
});

test('apple: idempotent redelivery keeps single subscription row', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  const origTx = `orig_idemp_${crypto.randomBytes(3).toString('hex')}`;
  const p1 = makeAppleNotification({ appAccountToken: account.id, originalTransactionId: origTx });
  const r1 = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload: p1 } });
  assert.equal(r1.statusCode, 200);
  const r2 = await app.inject({ method: 'POST', url: '/webhooks/apple', headers: { 'content-type': 'application/json' }, payload: { signedPayload: p1 } });
  assert.equal(r2.statusCode, 200);
  const subs = await models.Subscription.find({ accountId: account.id }).lean();
  assert.equal(subs.length, 1);
});

// ---- Google ----

test('google: valid Bearer JWT provisions if token known', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  // seed a google subscription so purchaseToken is known (google flow requires existing mapping)
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { provider: 'google', googlePurchaseToken: 'tok_google_1', plan: 'starter', status: 'active' } });
  const envelope = { message: { data: b64Json({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok_google_1', subscriptionId: 'starter_monthly' } }) } };
  const r = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { authorization: 'Bearer valid-google-jwt', 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().received, true);
  const sub = await models.Subscription.findOne({ accountId: account.id }).lean();
  assert.equal(sub.status, 'active');
});

test('google: missing Bearer rejected 401', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const envelope = { message: { data: b64Json({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok_x', subscriptionId: 'pro_monthly' } }) } };
  const r = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r.statusCode, 401);
});

test('google: invalid JWT rejected (processed:false)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const envelope = { message: { data: b64Json({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok_x', subscriptionId: 'pro_monthly' } }) } };
  const r = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { authorization: 'Bearer bad-jwt', 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r.json().processed, false);
});

test('google: wrong iss rejected', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const envelope = { message: { data: b64Json({ subscriptionNotification: { notificationType: 4, purchaseToken: 'tok_x', subscriptionId: 'pro_monthly' } }) } };
  const r = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { authorization: 'Bearer wrong-iss-jwt', 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r.json().processed, false);
});

test('google: idempotent redelivery', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  await cleanTestDb();
  const account = await makeAccountWithFreePlan();
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { provider: 'google', googlePurchaseToken: 'tok_idemp', plan: 'pro', status: 'active' } });
  const envelope = { message: { data: b64Json({ subscriptionNotification: { notificationType: 2, purchaseToken: 'tok_idemp', subscriptionId: 'pro_monthly' } }) } };
  const r1 = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { authorization: 'Bearer valid-google-jwt', 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r1.statusCode, 200);
  const r2 = await app.inject({ method: 'POST', url: '/webhooks/google', headers: { authorization: 'Bearer valid-google-jwt', 'content-type': 'application/json' }, payload: envelope });
  assert.equal(r2.statusCode, 200);
  const subs = await models.Subscription.find({ accountId: account.id }).lean();
  assert.equal(subs.length, 1);
});
