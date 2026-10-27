'use strict';

const Stripe = require('stripe');
const { Account, Subscription } = require('../models');
const { getStripePriceId, SELF_SERVE_PLANS, VALID_INTERVALS } = require('../lib/plans');
const { emailVerificationFields } = require('../lib/email-verification');

async function billingRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.post('/checkout-session', protect, async (req, reply) => {
    const { plan, interval } = req.body || {};

    if (!plan || typeof plan !== 'string' || !SELF_SERVE_PLANS.has(plan)) {
      return reply.status(400).send({ error: 'invalid_plan', message: 'Invalid plan. Must be one of: starter, pro, team.' });
    }
    if (!interval || typeof interval !== 'string' || !VALID_INTERVALS.has(interval)) {
      return reply.status(400).send({ error: 'invalid_interval', message: 'Invalid interval. Must be monthly or yearly.' });
    }

    const priceId = getStripePriceId(plan, interval);
    if (!priceId) {
      return reply.status(503).send({ error: 'billing_not_configured', message: `Stripe price not configured for ${plan}/${interval}.` });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.status(503).send({ error: 'billing_not_configured', message: 'Stripe is not configured.' });
    }

    const account = await Account.findById(req.userId, { emailVerified: 1, emailSealed: 1 }).lean();
    if (!account) {
      return reply.status(404).send({ error: 'not_found', message: 'Account not found.' });
    }
    // Verification is advisory (no delivery pipeline ever sets it); proceed and
    // report the state instead of blocking checkout.
    const verification = emailVerificationFields(Boolean(account.emailVerified));

    let email = null;
    if (account.emailSealed) {
      try {
        const mlkem = require('../lib/mlkem');
        const decrypted = await mlkem.decryptMetadata(account.emailSealed);
        if (decrypted && typeof decrypted === 'string' && decrypted.includes('@')) {
          email = decrypted;
        }
      } catch {
        // decrypt failed — email stays null and handler returns 500 below
      }
    }
    if (!email) {
      return reply.status(500).send({ error: 'email_unavailable', message: 'Account email unavailable — contact support.' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    // Stripe Tax activation lives in the Stripe dashboard; the env flag is the
    // kill switch so shipping this code cannot break checkout before then.
    const automaticTax = process.env.STRIPE_AUTOMATIC_TAX === '1';
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        client_reference_id: req.userId,
        line_items: [{ price: priceId, quantity: 1 }],
        ...(automaticTax && {
          automatic_tax: { enabled: true },
          // New-customer checkout (customer_email only): customer_update is
          // invalid without a customer; Stripe Tax needs the billing address.
          billing_address_collection: 'required',
          tax_id_collection: { enabled: true },
        }),
        success_url: 'beavernotes://billing/return?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'beavernotes://billing/return?canceled=1',
        metadata: { userId: req.userId, plan, interval },
        subscription_data: { metadata: { userId: req.userId, plan, interval } },
      });
      return reply.send({ url: session.url, id: session.id, ...verification });
    } catch (err) {
      req.log.error({ err: err.message }, 'Stripe checkout session creation failed');
      return reply.status(502).send({ error: 'stripe_error', message: err.message || 'Failed to create checkout session.' });
    }
  });

  app.post('/portal-session', protect, async (req, reply) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.status(503).send({ error: 'billing_not_configured', message: 'Stripe is not configured.' });
    }
    const sub = await Subscription.findOne({ accountId: req.userId }).lean();
    const customerId = sub?.stripeCustomerId;
    if (!customerId) {
      return reply.status(404).send({ error: 'no_subscription', message: 'No Stripe billing subscription found for this account.' });
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: 'beavernotes://billing/return',
      });
      return reply.send({ url: session.url });
    } catch (err) {
      req.log.error({ err: err.message }, 'Stripe portal session creation failed');
      return reply.status(502).send({ error: 'stripe_error', message: err.message || 'Failed to create portal session.' });
    }
  });
}

module.exports = billingRoutes;
