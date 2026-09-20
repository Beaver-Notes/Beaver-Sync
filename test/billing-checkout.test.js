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
process.env.LEGACY_AUTH_ENABLED = 'true';
process.env.ENTERPRISE_MODE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_123';
process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_yearly';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly';
process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly';
process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly';

const { close } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const { register } = require('./helpers/factory');
const { buildApp } = require('../src/server');
const { signToken } = require('../src/middleware/auth');

// Mock Stripe: intercept require('stripe') to return fake instance
const Module = require('node:module');
const originalLoad = Module._load;
let lastCheckoutArgs = null;
let lastPortalArgs = null;
let stripeCheckoutShouldFail = false;

Module._load = function (request, parent, isMain) {
  if (request === 'stripe') {
    return function StripeMock() {
      return {
        checkout: {
          sessions: {
            create: async (args) => {
              if (stripeCheckoutShouldFail) throw new Error('stripe down');
              lastCheckoutArgs = args;
              return { id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' };
            },
          },
        },
        billingPortal: {
          sessions: {
            create: async (args) => {
              lastPortalArgs = args;
              return { url: 'https://billing.stripe.com/portal/test' };
            },
          },
        },
      };
    };
  }
  return originalLoad.apply(this, arguments);
};

test.before(async () => { await setupTestDb(); await cleanTestDb(); });
test.after(async () => {
  Module._load = originalLoad;
  await close();
});

test('POST /billing/checkout-session requires auth', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { 'content-type': 'application/json' },
    payload: { plan: 'starter', interval: 'monthly' },
  });
  assert.equal(res.statusCode, 401);
});

test('POST /billing/checkout-session proceeds for unverified email with advisory warning', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('free', { emailVerified: false });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'starter', interval: 'monthly' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().emailVerified, false);
  assert.equal(res.json().warning, 'EMAIL_NOT_VERIFIED');
  assert.ok(res.json().url);
});

test('POST /billing/checkout-session creates Checkout Session with correct args', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  lastCheckoutArgs = null;
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'starter', interval: 'monthly' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.url, 'https://checkout.stripe.com/pay/cs_test_123');
  assert.equal(body.id, 'cs_test_123');
  assert.ok(lastCheckoutArgs);
  assert.equal(lastCheckoutArgs.mode, 'subscription');
  assert.ok(lastCheckoutArgs.customer_email.includes('@'));
  assert.equal(lastCheckoutArgs.client_reference_id, account.id);
  assert.equal(lastCheckoutArgs.line_items[0].price, 'price_starter_monthly');
  assert.equal(lastCheckoutArgs.success_url, 'beavernotes://billing/return?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(lastCheckoutArgs.cancel_url, 'beavernotes://billing/return?canceled=1');
});

test('POST /billing/checkout-session rejects invalid plan', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'enterprise', interval: 'monthly' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_plan');
});

test('POST /billing/checkout-session rejects invalid interval', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'starter', interval: 'weekly' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_interval');
});

test('POST /billing/checkout-session maps price env correctly (pro yearly)', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  lastCheckoutArgs = null;
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'pro', interval: 'yearly' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(lastCheckoutArgs.line_items[0].price, 'price_pro_yearly');
});

test('POST /billing/portal-session creates portal session', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  lastPortalArgs = null;
  const account = await register('pro', { emailVerified: true });
  const models = require('../src/models');
  await models.Subscription.updateOne({ accountId: account.id }, { $set: { stripeCustomerId: 'cus_test_123' } });
  const res = await app.inject({
    method: 'POST', url: '/billing/portal-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().url, 'https://billing.stripe.com/portal/test');
  assert.equal(lastPortalArgs.customer, 'cus_test_123');
  assert.equal(lastPortalArgs.return_url, 'beavernotes://billing/return');
});

test('POST /billing/portal-session 404 when no customer', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/portal-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'no_subscription');
});

test('checkout requires STRIPE_PRICE env to be set', async (t) => {
  const app = await buildApp();
  t.after(async () => { await app.close(); });
  const saved = process.env.STRIPE_PRICE_TEAM_MONTHLY;
  delete process.env.STRIPE_PRICE_TEAM_MONTHLY;
  const account = await register('free', { emailVerified: true });
  const res = await app.inject({
    method: 'POST', url: '/billing/checkout-session',
    headers: { authorization: `Bearer ${signToken(account.id)}`, 'content-type': 'application/json' },
    payload: { plan: 'team', interval: 'monthly' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'billing_not_configured');
  process.env.STRIPE_PRICE_TEAM_MONTHLY = saved;
});
