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
// │ Device limit           │Unlim  │    5    │Unlim │ Unlim│   Unlim    │
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
    devices: 5,
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

module.exports = {
  PLANS, VALID_PLANS, getPlan, getQuotaBytes, getHistoryDays,
  getDeviceLimit, getFlags, isFreePlan, isPaidPlan,
};
