"use strict";

// ┌─────────────────────────────────┬──────────┬─────────────┬───────────┬───────────────┬─────────────┐
// │ Feature                         │ Free     │ Basic ($4)  │ Pro ($9)  │ Team ($12/s)  │ Enterprise  │
// ├─────────────────────────────────┼──────────┼─────────────┼───────────┼───────────────┼─────────────┤
// │ Notes & editor                  │    ✓     │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Version history                 │    ✗     │  30 days    │    ✓      │     ✓         │     ✓       │
// │ Encrypted cloud sync            │ BYO app  │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Cloud storage                   │    ✗     │   4 GB      │  10 GB    │   50 GB       │ Unlimited   │
// │ End-to-end encryption           │    ✓     │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Quantum-resistant encryption ‡  │    ✓     │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Real-time multiplayer editing   │    ✓     │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Team workspaces & permissions   │    ✗     │     ✗       │    ✗      │     ✓         │     ✓       │
// │ Guest access                    │    ✗     │     ✗       │    ✗      │     ✓         │     ✓       │
// │ Admin dashboard                 │    ✗     │     ✗       │    ✗      │     ✓         │     ✓       │
// │ Audit logs                      │    ✗     │     ✗       │    ✗      │     ✗         │     ✓       │
// │ SSO / SAML                      │    ✗     │     ✗       │    ✗      │     ✗         │     ✓       │
// │ GDPR data export & deletion     │    ✓     │     ✓       │    ✓      │     ✓         │     ✓       │
// │ Device limit                    │ Unlimited│     5        │ Unlimited │  Unlimited    │ Unlimited   │
// ├─────────────────────────────────┼──────────┼─────────────┼───────────┼───────────────┼─────────────┤
// │ Write API                       │ Blocked  │   Allowed   │  Allowed  │   Allowed     │  Allowed    │
// │ Quota enforcement               │   N/A    │  Account    │  Account  │  Workspace    │  Bypassed   │
// │ Payment provider                │    -     │  Stripe /   │  Stripe / │   Stripe      │  Stripe     │
// │                                 │          │  Apple /    │  Apple /  │               │  (Invoice)  │
// │                                 │          │  Google     │  Google   │               │             │
// └─────────────────────────────────┴──────────┴─────────────┴───────────┴───────────────┴─────────────┘

const GB = 1024 * 1024 * 1024;

const PLAN_QUOTAS = {
  free: 0,
  basic: 4 * GB,
  pro: 10 * GB,
  team: 50 * GB,
  enterprise: Number.MAX_SAFE_INTEGER,
};

const PAID_PLANS = new Set(["basic", "pro", "team", "enterprise"]);

function isPaidPlan(plan) {
  return PAID_PLANS.has(plan);
}

function isFreePlan(plan) {
  return plan === "free";
}

function getQuotaBytes(plan) {
  return PLAN_QUOTAS[plan] ?? 0;
}

module.exports = { PLAN_QUOTAS, isPaidPlan, isFreePlan, getQuotaBytes };
