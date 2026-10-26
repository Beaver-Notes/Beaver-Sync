'use strict';

// A subscription must resolve to the tier that was actually bought. Matching on
// substrings cannot do that: every real Stripe product id begins "prod_", which
// contains "pro", so substring matching classifies every genuine subscription as
// the pro tier. Starter buyers get pro entitlements and enterprise buyers are
// under-provisioned, on every renewal, with no attacker involved.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_yearly';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly';
process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly';
process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly';
process.env.APPLE_PRODUCT_STARTER = 'com.beaver.notes.starter';
process.env.APPLE_PRODUCT_PRO = 'com.beaver.notes.pro';
process.env.APPLE_PRODUCT_TEAM = 'com.beaver.notes.team';
process.env.GOOGLE_PRODUCT_STARTER = 'beaver_starter';
process.env.GOOGLE_PRODUCT_PRO = 'beaver_pro';
process.env.GOOGLE_PRODUCT_TEAM = 'beaver_team';

const { planFromPrice, planFromProductId } = require('../src/lib/billing');

test('a configured Stripe price id resolves to exactly the tier it was configured as', () => {
  assert.equal(planFromPrice('price_starter_monthly'), 'starter');
  assert.equal(planFromPrice('price_starter_yearly'), 'starter');
  assert.equal(planFromPrice('price_pro_monthly'), 'pro');
  assert.equal(planFromPrice('price_pro_yearly'), 'pro');
  assert.equal(planFromPrice('price_team_monthly'), 'team');
  assert.equal(planFromPrice('price_team_yearly'), 'team');
});

test('an unconfigured Stripe price never resolves to a paid tier', () => {
  // Real Stripe ids: the product always starts prod_, which contains "pro".
  assert.equal(planFromPrice('price_1PROMOtest', 'prod_1PROMOtest'), null);
  assert.equal(planFromPrice('price_1FREETRIAL', 'prod_FREETRIAL'), null);
  assert.equal(planFromPrice('price_1LifetimeDeal', 'prod_LifetimeDeal'), null);
  assert.equal(planFromPrice(''), null);
});

test('a configured Apple or Google product id resolves to its tier', () => {
  assert.equal(planFromProductId('apple', 'com.beaver.notes.pro'), 'pro');
  assert.equal(planFromProductId('apple', 'com.beaver.notes.starter'), 'starter');
  assert.equal(planFromProductId('google', 'beaver_team'), 'team');
});

test('a comma-separated product id list resolves every listed interval to the same tier', () => {
  process.env.APPLE_PRODUCT_PRO = 'com.beaver.notes.pro.monthly,com.beaver.notes.pro.yearly';
  assert.equal(planFromProductId('apple', 'com.beaver.notes.pro.monthly'), 'pro');
  assert.equal(planFromProductId('apple', 'com.beaver.notes.pro.yearly'), 'pro');
  process.env.APPLE_PRODUCT_PRO = 'com.beaver.notes.pro';
});

test('an unconfigured store product never resolves to a paid tier', () => {
  assert.equal(planFromProductId('apple', 'com.beaver.notes.subscriber.monthly'), null);
  assert.equal(planFromProductId('google', 'someOpaqueSubscriptionId'), null);
  assert.equal(planFromProductId('apple', ''), null);
  assert.equal(planFromProductId('carrier-pigeon', 'x'), null);
});
