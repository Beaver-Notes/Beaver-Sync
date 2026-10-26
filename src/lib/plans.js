'use strict';

// ┌────────────────────────┬───────┬─────────┬──────┬──────┬────────────┐
// │ Feature                │ Free  │ Starter │ Pro  │ Team │ Enterprise │
// ├────────────────────────┼───────┼─────────┼──────┼──────┼────────────┤
// │ Notes & editor         │  ✓    │   ✓     │  ✓   │  ✓   │     ✓      │
// │ Sync container         │ Folder│ Personal│Personal│Personal+shared│Personal+shared│
// │ Receive shared notes   │  ✓ (collaborator) │ ✓   │  ✓   │   ✓      │   ✓      │
// │ Invite / share notes   │  ✗    │   ✓     │  ✓   │  ✓   │     ✓      │
// │ Team workspaces        │  ✗    │   ✗     │  ✗   │  ✓   │     ✓      │
// │ Collaborators          │  ✗    │   ✗     │  ✗   │  ✓   │     ✓      │
// │ Admin dashboard        │  ✗    │   ✗     │  ✗   │  ✓   │     ✓      │
// │ Audit logs             │  ✗    │   ✗     │  ✗   │  ✗   │     ✓      │
// │ SSO / SAML             │  ✗    │   ✗     │  ✗   │  ✗   │     ✓      │
// │ Self-hosted            │  ✗    │   ✗     │  ✗   │  ✗   │     ✓      │
// │ Cloud storage          │  0    │ 10 GB   │ 50 GB│100GB+25GB×seats│Contractual│
// │ Version history        │  ✗    │ 30 days │ 1 yr │ 1 yr │ Contractual│
// │ Device limit           │Unlim  │  Unlim  │Unlim │ Unlim│   Unlim    │
// └────────────────────────┴───────┴─────────┴──────┴──────┴────────────┘

const GB = 1024 * 1024 * 1024;

const PLANS = {
  free: {
    quotaBytes: 0,
    historyDays: 0,
    devices: null,
    flags: { shareNotes: false, teamWorkspaces: false, collaborators: false, dashboard: false, audit: false, sso: false, selfHosted: false },
  },
  starter: {
    quotaBytes: 10 * GB,
    historyDays: 30,
    devices: null,
    flags: { shareNotes: true, teamWorkspaces: false, collaborators: false, dashboard: false, audit: false, sso: false, selfHosted: false },
  },
  pro: {
    quotaBytes: 50 * GB,
    historyDays: 365,
    devices: null,
    flags: { shareNotes: true, teamWorkspaces: false, collaborators: false, dashboard: false, audit: false, sso: false, selfHosted: false },
  },
  team: {
    baseQuotaBytes: 100 * GB,
    perSeatBytes: 25 * GB,
    historyDays: 365,
    devices: null,
    flags: { shareNotes: true, teamWorkspaces: true, collaborators: true, dashboard: true, audit: false, sso: false, selfHosted: false },
  },
  enterprise: {
    quotaBytes: Number.MAX_SAFE_INTEGER,
    historyDays: null,
    devices: null,
    flags: { shareNotes: true, teamWorkspaces: true, collaborators: true, dashboard: true, audit: true, sso: true, selfHosted: true },
  },
};

const VALID_PLANS = new Set(Object.keys(PLANS));

const VALID_INTERVALS = new Set(['monthly', 'yearly']);
const SELF_SERVE_PLANS = new Set(['starter', 'pro', 'team']);

function getStripePriceId(plan, interval) {
  if (!plan || !interval) return null;
  const key = `STRIPE_PRICE_${String(plan).toUpperCase()}_${String(interval).toUpperCase()}`;
  return process.env[key] || null;
}

// Apple/Google product ids are chosen per store listing, so there is nothing to
// derive them from. They are configured the same way Stripe prices are, one
// variable per sellable tier, and an unset variable resolves to nothing. A
// slot may hold several comma-separated ids (one per billing interval).
function getStoreProductId(provider, plan) {
  if (!provider || !SELF_SERVE_PLANS.has(plan)) return null;
  return process.env[`${String(provider).toUpperCase()}_PRODUCT_${String(plan).toUpperCase()}`] || null;
}

function planFromStoreProductId(provider, productId) {
  if (!productId) return null;
  // Stores sell one product per tier per interval, so a slot may list several
  // comma-separated ids that all resolve to the same tier.
  for (const plan of SELF_SERVE_PLANS) {
    if ((getStoreProductId(provider, plan) || '').split(',').map((s) => s.trim()).includes(productId)) {
      return plan;
    }
  }
  return null;
}

function planFromStripePriceId(priceId) {
  if (!priceId) return null;
  for (const plan of SELF_SERVE_PLANS) {
    for (const interval of VALID_INTERVALS) {
      if (getStripePriceId(plan, interval) === priceId) return plan;
    }
  }
  return null;
}

function isSelfServePlan(plan) {
  return SELF_SERVE_PLANS.has(plan);
}

function isValidInterval(interval) {
  return VALID_INTERVALS.has(interval);
}

function getPlan(plan) {
  return PLANS[plan] || PLANS.free;
}

function getQuotaBytes(plan, seats = 1) {
  const p = getPlan(plan);
  if (typeof p.baseQuotaBytes === 'number') {
    return p.baseQuotaBytes + (p.perSeatBytes * (Math.max(1, Number(seats) || 1)));
  }
  return p.quotaBytes ?? 0;
}

function getHistoryDays(plan) {
  return getPlan(plan).historyDays ?? null;
}

function getDeviceLimit(plan) {
  return getPlan(plan).devices ?? null;
}

function getFlags(plan) {
  return { ...getPlan(plan).flags };
}

function isFreePlan(plan) {
  return plan === 'free';
}

function isPaidPlan(plan) {
  return VALID_PLANS.has(plan) && plan !== 'free';
}

function resolvePlanForAccount({ orgSub, sub } = {}) {
  // PLAN_OVERRIDE is a dev/test escape hatch only. In production it must never
  // be honored, or a leaked env value silently disables every plan/quota/device
  // gate for all users (billing bypass).
  if (process.env.NODE_ENV !== 'production' && process.env.PLAN_OVERRIDE && VALID_PLANS.has(process.env.PLAN_OVERRIDE)) {
    return process.env.PLAN_OVERRIDE;
  }
  return orgSub?.plan || sub?.plan || 'free';
}

module.exports = {
  VALID_PLANS, VALID_INTERVALS, SELF_SERVE_PLANS,
  getPlan, getQuotaBytes, getHistoryDays,
  getDeviceLimit, getFlags, isFreePlan, isPaidPlan, resolvePlanForAccount,
  getStripePriceId, isSelfServePlan, isValidInterval,
  getStoreProductId, planFromStoreProductId, planFromStripePriceId,
};
