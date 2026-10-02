'use strict';

const { Subscription } = require('../models');
const { getQuotaBytes, planFromStripePriceId, planFromStoreProductId } = require('./plans');

// A subscription resolves to the tier whose id was configured for checkout, and to
// nothing else. Substring matching is not usable here: every real Stripe product id
// begins "prod_", which contains "pro", so it classified every genuine subscription
// as the pro tier and handed out paid entitlements nobody bought.
function planFromPrice(priceId) {
  return planFromStripePriceId(priceId);
}

function planFromProductId(provider, productId) {
  return planFromStoreProductId(provider, productId);
}

async function upsertSubscription({
  accountId,
  plan,
  status,
  provider,
  providerId,
  renewsAt,
  stripeCustomerId,
})
{
  const storageBytes = getQuotaBytes(plan);

  const existing = await Subscription.findOne({ accountId }).lean();
  if (existing) {
    const update = { plan, status, provider, storageQuotaBytes: storageBytes };
    if (renewsAt) update.renewsAt = renewsAt instanceof Date ? renewsAt.toISOString() : renewsAt;
    if (stripeCustomerId) update.stripeCustomerId = stripeCustomerId;
    switch (provider) {
      case 'stripe': if (providerId) update.stripeSubscriptionId = providerId; break;
      case 'apple':  if (providerId) update.appleOriginalTransactionId = providerId; break;
      case 'google': if (providerId) update.googlePurchaseToken = providerId; break;
    }
    await Subscription.updateOne({ accountId }, { $set: update });
    return { ...existing, ...update };
  }

  const insertData = {
    accountId, plan, status, provider,
    storageQuotaBytes: storageBytes,
    createdAt: new Date().toISOString(),
  };
  if (renewsAt) insertData.renewsAt = renewsAt instanceof Date ? renewsAt.toISOString() : renewsAt;
  if (stripeCustomerId) insertData.stripeCustomerId = stripeCustomerId;
  switch (provider) {
    case 'stripe': if (providerId) insertData.stripeSubscriptionId = providerId; break;
    case 'apple':  if (providerId) insertData.appleOriginalTransactionId = providerId; break;
    case 'google': if (providerId) insertData.googlePurchaseToken = providerId; break;
  }
  const doc = await Subscription.create(insertData);
  return doc.toJSON();
}

async function findByProvider({ provider, providerId }) {
  if (!provider || !providerId) return null;
  const field = provider === 'stripe' ? 'stripeSubscriptionId'
    : provider === 'apple' ? 'appleOriginalTransactionId'
    : provider === 'google' ? 'googlePurchaseToken'
    : null;
  if (!field) return null;
  return Subscription.findOne({ [field]: providerId }).lean();
}

async function expireSubscription({ accountId }) {
  await Subscription.updateOne({ accountId }, { $set: { status: 'expired' } });
}

async function markGracePeriod({ accountId }) {
  await Subscription.updateOne({ accountId }, { $set: { status: 'grace_period' } });
}

module.exports = { upsertSubscription, findByProvider, expireSubscription, markGracePeriod, planFromPrice, planFromProductId };
