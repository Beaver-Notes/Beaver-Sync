'use strict';

// Price amounts live in Stripe, not in this codebase — env vars only hold price
// IDs. This resolves each sellable Stripe price to its live amount/currency,
// with an in-memory TTL cache so /plans does not hit Stripe on every call.
// Failures resolve to null entries (clients hide amounts) and never fail /plans.

const { getStripePriceId, SELF_SERVE_PLANS, VALID_INTERVALS } = require('./plans');

const TTL_MS = 10 * 60 * 1000;

let cache = { prices: null, expires: 0 };
let inflight = null;

function defaultRetrievePrice(priceId) {
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 5000 });
  return stripe.prices.retrieve(priceId);
}

async function fetchPrices(retrievePrice) {
  const out = {};
  const jobs = [];
  for (const plan of SELF_SERVE_PLANS) {
    out[plan] = {};
    for (const interval of VALID_INTERVALS) {
      const priceId = getStripePriceId(plan, interval);
      if (!priceId) { out[plan][interval] = null; continue; }
      jobs.push(
        Promise.resolve()
          .then(() => retrievePrice(priceId))
          // Stripe's 2025-03-31 basil API renamed Price.amount → unit_amount.
          .then((p) => { out[plan][interval] = { amount: p.unit_amount ?? p.amount, currency: p.currency }; })
          .catch(() => { out[plan][interval] = null; })
      );
    }
  }
  await Promise.allSettled(jobs);
  for (const plan of Object.keys(out)) {
    if (Object.values(out[plan]).every((v) => v == null)) delete out[plan];
  }
  return Object.keys(out).length ? out : null;
}

// Stale-if-error: if Stripe fails and we have an expired cache, serve it rather
// than nothing. `lastKnownPrices` keeps the most recent successful result.
let lastKnownPrices = null;

async function getPlanPrices(retrievePrice = defaultRetrievePrice) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (cache.prices && Date.now() < cache.expires) return cache.prices;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const prices = await fetchPrices(retrievePrice);
      if (prices) {
        lastKnownPrices = prices;
        cache = { prices, expires: Date.now() + TTL_MS };
      }
      return prices || lastKnownPrices;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function resetPricingCache() {
  cache = { prices: null, expires: 0 };
  inflight = null;
  lastKnownPrices = null;
}

module.exports = { getPlanPrices, resetPricingCache, TTL_MS };
