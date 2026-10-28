'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPlanPrices, resetPricingCache, TTL_MS } = require('../src/lib/pricing');

const ORIG_KEY = process.env.STRIPE_SECRET_KEY;
const ORIG_PRICE_VARS = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('STRIPE_PRICE_'))
);

function key(v) {
  if (v === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = v;
}
function clearPriceVars() {
  for (const k of Object.keys(process.env)) if (k.startsWith('STRIPE_PRICE_')) delete process.env[k];
}

const money = (amount, currency) => ({ amount, currency });
const stripeFake = (prices) => (priceId) => {
  const hit = prices[priceId];
  if (!hit) return Promise.reject(new Error('no such price'));
  return Promise.resolve(hit);
};

test.beforeEach(() => { clearPriceVars(); resetPricingCache(); });
test.afterEach(() => {
  clearPriceVars();
  for (const [k, v] of Object.entries(ORIG_PRICE_VARS)) process.env[k] = v;
  key(ORIG_KEY);
  resetPricingCache();
});

test('getPlanPrices returns null without STRIPE_SECRET_KEY', async () => {
  key(undefined);
  let calls = 0;
  const counter = () => { calls += 1; return Promise.resolve(money(500, 'usd')); };
  const prices = await getPlanPrices(counter);
  assert.equal(prices, null);
  assert.equal(calls, 0); // never called
});

test('resolves env-configured prices into plan/interval map', async () => {
  key('sk_test');
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
  process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_starter_y';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_y';
  process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_m';
  process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_y';
  const prices = await getPlanPrices(stripeFake({
    price_starter_m: money(500, 'usd'),
    price_starter_y: money(4800, 'usd'),
    price_pro_m: money(1200, 'usd'),
    price_pro_y: money(11800, 'usd'),
    price_team_m: money(900, 'usd'),
    price_team_y: money(8900, 'usd'),
  }));
  assert.deepEqual(prices, {
    starter: { monthly: money(500, 'usd'), yearly: money(4800, 'usd') },
    pro: { monthly: money(1200, 'usd'), yearly: money(11800, 'usd') },
    team: { monthly: money(900, 'usd'), yearly: money(8900, 'usd') },
  });
});

test('missing env price IDs and Stripe errors become null entries', async () => {
  key('sk_test');
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  const prices = await getPlanPrices(stripeFake({ price_pro_m: money(1200, 'usd') }));
  assert.equal(prices.starter, undefined);
  assert.deepEqual(prices.pro, { monthly: money(1200, 'usd'), yearly: null });
});

test('maps the current Stripe Price shape (unit_amount) into amount', async () => {
  key('sk_test');
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  const prices = await getPlanPrices(
    stripeFake({ price_pro_m: { unit_amount: 1200, currency: 'eur' } })
  );
  assert.deepEqual(prices.pro.monthly, money(1200, 'eur'));
});

test('expired TTL refetches and outage falls back to last known prices', async (t) => {
  t.mock.timers.enable({ now: Date.now() });
  key('sk_test');
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  let calls = 0;
  const counter = (result) => () => { calls += 1; return Promise.resolve(result); };

  await getPlanPrices(counter(money(1200, 'usd')));
  assert.equal(calls, 1);

  t.mock.timers.tick(TTL_MS - 1000); // still inside TTL
  await getPlanPrices(counter(money(1200, 'usd')));
  assert.equal(calls, 1); // still cached

  t.mock.timers.tick(2000); // TTL expired → refetch
  const refreshed = await getPlanPrices(stripeFake({ price_pro_m: { amount: 1300, currency: 'usd' } }));
  assert.equal(refreshed.pro.monthly.amount, 1300);
  assert.equal(calls, 1); // refetch went through the new fake, not the counter

  // full Stripe outage after expiry still serves last known, never null
  t.mock.timers.tick(TTL_MS + 1);
  const outage = await getPlanPrices(() => Promise.reject(new Error('stripe down')));
  assert.deepEqual(outage.pro.monthly, money(1300, 'usd'));
});
