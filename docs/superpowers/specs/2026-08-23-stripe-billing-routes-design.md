# Stripe Billing Routes — Design Spec

## Overview

Add Stripe Checkout and Customer Portal integration to enable subscription purchases and management directly through the web. No changes to existing webhook handling, billing library, subscriptions table, or plans config.

## Product ID Format

Unified across platforms: `com.beavernotes.{plan}.{interval}`

| Platform | Products |
|----------|----------|
| Apple/Google | `com.beavernotes.starter.monthly`, `com.beavernotes.starter.yearly`, `com.beavernotes.pro.monthly`, `com.beavernotes.pro.yearly` |
| Stripe | Same as above + `com.beavernotes.team.monthly`, `com.beavernotes.team.yearly` |

Team is web-only (per-seat billing not supported by IAP).

## New Files

### `src/lib/billing-config.js`

Maps Stripe price IDs to plan names. Two maps:

```js
const PRICE_TO_PLAN = {
  'price_starter_monthly': 'starter',
  'price_starter_yearly': 'starter',
  'price_pro_monthly': 'pro',
  'price_pro_yearly': 'pro',
  'price_team_monthly': 'team',
  'price_team_yearly': 'team',
}

const PLAN_TO_PRICES = {
  starter: { monthly: 'price_starter_monthly', yearly: 'price_starter_yearly' },
  pro: { monthly: 'price_pro_monthly', yearly: 'price_pro_yearly' },
  team: { monthly: 'price_team_monthly', yearly: 'price_team_yearly' },
}
```

Price IDs come from `STRIPE_PRICE_IDS` env var (JSON object) or hardcoded defaults. Exports `priceToPlan(priceId)`, `planToPrice(plan, interval)`.

### `src/routes/billing.js`

All routes require auth (reuse existing `auth` middleware). Prefix: `/billing`.

#### `POST /billing/checkout`

Body: `{ plan: 'starter'|'pro'|'team', interval: 'monthly'|'yearly' }`

1. Validate plan+interval against `PLAN_TO_PRICES`
2. Look up or create Stripe customer (by `user.email` or `stripeCustomerId` on subscription)
3. Create Checkout session:
   - `mode: 'subscription'`
   - `customer: stripeCustomerId`
   - `line_items: [{ price: priceId, quantity: 1 }]`
   - `success_url: ${CLIENT_URL}/settings/billing?session_id={CHECKOUT_SESSION_ID}`
   - `cancel_url: ${CLIENT_URL}/settings/billing`
   - `metadata: { userId, plan, interval }`
   - `subscription_data.metadata: { userId, plan, interval }`
4. Return `{ url: session.url }`

#### `GET /billing/portal`

1. Get user's `stripeCustomerId` from subscription record
2. Create Billing Portal session:
   - `customer: stripeCustomerId`
   - `return_url: ${CLIENT_URL}/settings/billing`
3. Return `{ url: session.url }`

#### `GET /billing/subscription`

1. Look up subscription by `userId`
2. Return `{ plan, status, currentPeriodEnd, cancelAtPeriodEnd, provider }`

#### `POST /billing/upgrade`

Body: `{ plan, interval }`

1. Same as checkout but with `subscription_data.behavior: 'immediate_with_proration'`
2. Store `proration_behavior` in metadata for webhook handling

#### `POST /billing/cancel`

Body: `{ atPeriodEnd: true }` (default true)

1. Get `stripeSubscriptionId` from user's subscription
2. Call `stripe.subscriptions.update(id, { cancel_at_period_end: true })` or `stripe.subscriptions.cancel(id)` if `atPeriodEnd: false`
3. Return `{ status: 'canceling', cancelAtPeriodEnd: true }`

## Auth & Routing

- All billing routes use existing `auth` middleware
- Register with `fastify.register(billingRoutes, { prefix: '/billing' })` in `src/server.js`
- No changes to existing files beyond server.js registration

## Error Handling

- Invalid plan/interval → 400 `{ error: 'Invalid plan or interval' }`
- No Stripe customer found → 400 `{ error: 'No Stripe customer' }`
- Stripe API errors → pass through with status code
- Missing subscription (for portal/cancel) → 404 `{ error: 'No active subscription' }`

## Env Vars Needed

- `STRIPE_SECRET_KEY` — already exists
- `STRIPE_WEBHOOK_SECRET` — already exists
- `CLIENT_URL` — frontend URL for redirect (new, defaults to `http://localhost:5173`)
- `STRIPE_PRICE_IDS` — JSON object mapping price keys to Stripe IDs (new, hardcoded defaults)

## What Does NOT Change

- `src/routes/webhooks.js` — unchanged, handles incoming events
- `src/lib/billing.js` — unchanged, `upsertSubscription()` etc.
- `src/db/schema.postgres.sql` — unchanged, subscriptions table has all needed fields
- `src/lib/plans.js` — unchanged, PLANS object
- `src/middleware/subscription.js` — unchanged

## Testing

1. Manual: Create a test Stripe account, set price IDs, test checkout flow end-to-end
2. Verify webhooks still fire correctly after checkout completion
3. Test portal access, upgrade proration, and cancellation flows
