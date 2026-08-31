'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const Stripe = require('stripe');

const { upsertSubscription, findByProvider, expireSubscription, markGracePeriod, planFromPrice, planFromProductId } = require('../lib/billing');
const { ensurePaidProvisioning, checkDowngrade, downgradeAtPeriodEnd } = require('../lib/plan-lifecycle');
const { Subscription: SubscriptionModel } = require('../models');
const { getQuotaBytes } = require('../lib/plans');
const { sendSubscriptionReceiptEmail } = require('../email');

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const WEBHOOK_BODY_LIMIT_BYTES = parseInt(process.env.WEBHOOK_BODY_LIMIT_BYTES ?? '262144', 10);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID;
let appleJwksCache = null;
let appleJwksCachedAt = 0;
const APPLE_JWKS_TTL = 3600_000;

async function fetchAppleJWKS() {
  if (appleJwksCache && Date.now() - appleJwksCachedAt < APPLE_JWKS_TTL) return appleJwksCache;
  const res = await fetch('https://api.storekit.itunes.apple.com/inApps/v1/certs');
  const jwks = await res.json();
  appleJwksCache = jwks.keys;
  appleJwksCachedAt = Date.now();
  return appleJwksCache;
}

async function verifyAppleJWS(signedPayload) {
  const parts = signedPayload.split('.');
  if (parts.length !== 3) throw new Error('invalid_jws_format');

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const keys = await fetchAppleJWKS();
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error('apple_key_not_found');
  if (!Array.isArray(key.x5c) || key.x5c.length === 0) throw new Error('apple_key_missing_x5c');

  const certB64 = key.x5c[0];
  if (!/^[A-Za-z0-9+/=]+$/.test(certB64)) throw new Error('apple_x5c_not_base64');
  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    certB64.match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----';

  try {
    new crypto.X509Certificate(pem);
  } catch {
    throw new Error('apple_cert_parse_failed');
  }

  return jwt.verify(signedPayload, pem, { algorithms: ['RS256'] });
}

async function webhookRoutes(app) {
  // Capture raw body for signature verification (Stripe needs exact bytes)
  const { Readable } = require('stream');
  app.addHook('preParsing', (req, reply, payload, done) => {
    if (req.method !== 'POST') return done(null, payload);
    if (!payload) {
      req.rawBody = '';
      return done(null, payload);
    }
    // Fastify inject provides payload as string/Buffer, not a stream
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      const rawStr = payload.toString('utf-8');
      req.rawBody = rawStr;
      const stream = Readable.from(Buffer.from(rawStr));
      return done(null, stream);
    }
    if (typeof payload.on !== 'function') {
      req.rawBody = '';
      return done(null, payload);
    }
    let raw = '';
    payload.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    payload.on('end', () => {
      req.rawBody = raw;
      // Provide a fresh stream containing the same bytes for downstream parsers
      const stream = Readable.from(Buffer.from(raw));
      done(null, stream);
    });
    payload.on('error', (err) => done(err));
  });

  app.post('/stripe', {
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    config: {
      security: { public: true },
      rateLimit: {
        max: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return reply.send({ received: true, processed: false });
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return reply.status(400).send({ error: 'missing_signature', message: 'Stripe-Signature header is required.' });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      app.log.warn({ err }, 'Stripe webhook signature verification failed');
      return reply.send({ received: true, processed: false });
    }

    const obj = event.data.object;

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = obj;
          const accountId = session.client_reference_id || session.metadata?.userId;
          if (!accountId) break;
          const isPaid = session.payment_status === 'paid' || session.status === 'complete';
          if (!isPaid) break;
          try { await ensurePaidProvisioning(accountId); } catch (e) { app.log.warn({ err: e }, 'checkout provisioning failed'); }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = obj;
          const accountId = sub.metadata?.userId;
          if (!accountId) break;
          const plan = planFromPrice(
            sub.items?.data?.[0]?.price?.id || '',
            sub.items?.data?.[0]?.price?.product || ''
          );
          const isCancelAtPeriodEnd = sub.cancel_at_period_end === true;
          let status;
          if (sub.status === 'active' || sub.status === 'trialing') {
            status = 'active';
          } else if (isCancelAtPeriodEnd) {
            status = 'active';
          } else {
            status = 'expired';
          }
          const renewsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          await upsertSubscription({ accountId, plan, status, provider: 'stripe', providerId: sub.id, renewsAt, stripeCustomerId: sub.customer });
          if (status === 'active') {
            sendSubscriptionReceiptEmail(app, accountId, {});
            try { await ensurePaidProvisioning(accountId); } catch (e) { app.log.warn({ err: e }, 'subscription provisioning failed'); }
            if (isCancelAtPeriodEnd) {
              app.log.info({ accountId, renewsAt }, 'subscription cancel scheduled at period end');
            }
          } else {
            const renewsAtMs = renewsAt ? renewsAt.getTime() : 0;
            if (!renewsAtMs || renewsAtMs <= Date.now()) {
              try { await downgradeAtPeriodEnd(accountId); } catch (e) { app.log.warn({ err: e }, 'downgrade failed'); }
              try {
                const existing = await SubscriptionModel.findOne({ accountId }).lean();
                if (existing && existing.plan !== 'free') {
                  const c = await checkDowngrade(accountId, existing.plan, 'free');
                  if (!c.ok) app.log.info({ accountId, reason: c.reason }, 'downgrade blocked by quota');
                }
              } catch {}
            } else {
              app.log.info({ accountId, renewsAt }, 'subscription downgrade deferred until period end');
            }
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = obj;
          const accountId = sub.metadata?.userId;
          if (!accountId) break;
          await expireSubscription({ accountId });
          try { await downgradeAtPeriodEnd(accountId); } catch (e) { app.log.warn({ err: e }, 'downgrade failed'); }
          try {
            const existing = await SubscriptionModel.findOne({ accountId }).lean();
            if (existing && existing.plan !== 'free') {
              const c = await checkDowngrade(accountId, existing.plan, 'free');
              if (!c.ok) app.log.info({ accountId, reason: c.reason }, 'downgrade blocked by quota');
              else if (existing.plan !== 'free') {
                await SubscriptionModel.updateOne({ accountId }, { $set: { plan: 'free', status: 'expired', storageQuotaBytes: getQuotaBytes('free') } });
              }
            }
          } catch {}
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          const invoice = obj;
          let accountId = invoice.subscription_details?.metadata?.userId || invoice.metadata?.userId;
          if (!accountId && invoice.customer) {
            const found = await SubscriptionModel.findOne({ stripeCustomerId: invoice.customer }).lean();
            accountId = found?.accountId;
          }
          if (!accountId && invoice.subscription) {
            const found = await SubscriptionModel.findOne({ stripeSubscriptionId: invoice.subscription }).lean();
            accountId = found?.accountId;
          }
          if (!accountId) break;
          try { await ensurePaidProvisioning(accountId); } catch (e) { app.log.warn({ err: e }, 'invoice provisioning failed'); }
          try {
            const sub = await SubscriptionModel.findOne({ accountId }).lean();
            if (sub && sub.status !== 'active') {
              await SubscriptionModel.updateOne({ accountId }, { $set: { status: 'active' } });
            }
          } catch {}
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = obj;
          let accountId = invoice.subscription_details?.metadata?.userId || invoice.metadata?.userId;
          if (!accountId && invoice.customer) {
            const found = await SubscriptionModel.findOne({ stripeCustomerId: invoice.customer }).lean();
            accountId = found?.accountId;
          }
          if (!accountId && invoice.subscription) {
            const found = await SubscriptionModel.findOne({ stripeSubscriptionId: invoice.subscription }).lean();
            accountId = found?.accountId;
          }
          if (accountId) await markGracePeriod({ accountId });
          break;
        }
        default:
          app.log.info({ type: event.type }, 'Unhandled Stripe event');
      }
    } catch (err) {
      app.log.error({ err, type: event.type }, 'Error processing Stripe webhook');
      throw err;
    }

    return reply.send({ received: true, processed: true });
  });

  app.post('/apple', {
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    config: {
      security: { public: true },
      rateLimit: {
        max: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    if (!APPLE_BUNDLE_ID) {
      return reply.send({ received: true, processed: false });
    }

    const { signedPayload } = req.body;
    if (!signedPayload) return reply.send({ received: true, processed: false });

    let decoded;
    try {
      decoded = await verifyAppleJWS(signedPayload);
    } catch (err) {
      app.log.warn({ err }, 'Apple JWS verification failed');
      return reply.send({ received: true, processed: false });
    }

    try {
      const notificationType = decoded.notificationType;
      const subtype = decoded.subtype;
      const transactionInfoJWS = decoded.data?.signedTransactionInfo;
      if (!transactionInfoJWS) {
        app.log.info({ notificationType }, 'Apple notification without transaction info');
        return reply.send({ received: true });
      }

      let transactionInfo;
      try {
        transactionInfo = await verifyAppleJWS(transactionInfoJWS);
      } catch (err) {
        app.log.warn({ err, notificationType }, 'Apple inner transactionInfo JWS verification failed');
        return reply.send({ received: true, processed: false });
      }

      if (transactionInfo.bundleId !== APPLE_BUNDLE_ID) {
        app.log.warn({ bundleId: transactionInfo.bundleId }, 'Apple transaction bundleId mismatch');
        return reply.send({ received: true, processed: false });
      }

      const accountId = transactionInfo.appAccountToken;
      if (!accountId) {
        app.log.warn({ originalTransactionId: transactionInfo.originalTransactionId }, 'Apple notification missing appAccountToken');
        return reply.send({ received: true });
      }

      const plan = planFromProductId(transactionInfo.productId || '');
      const originalTransactionId = transactionInfo.originalTransactionId;
      const expiresMs = transactionInfo.expiresDate ? parseInt(transactionInfo.expiresDate) : null;
      const renewsAt = expiresMs ? new Date(expiresMs) : null;

      let status = 'active';
      if (notificationType === 'EXPIRED') {
        status = subtype === 'BILLING_RETRY' ? 'grace_period' : 'expired';
      } else if (notificationType === 'REFUND' || notificationType === 'REVOKE') {
        status = 'expired';
      } else if (notificationType === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED') {
        status = 'active';
      }

      await upsertSubscription({ accountId, plan, status, provider: 'apple', providerId: originalTransactionId, renewsAt });
    } catch (err) {
      app.log.error({ err }, 'Error processing Apple webhook');
      throw err;
    }

    return reply.send({ received: true });
  });

  app.post('/google', {
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    config: {
      security: { public: true },
      rateLimit: {
        max: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const envelope = req.body;
    if (!envelope?.message?.data) {
      return reply.send({ received: true, processed: false });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      app.log.warn({ url: req.url }, 'Google webhook missing Bearer authorization');
      return reply.status(401).send({ received: true, processed: false });
    }

    try {
      const token = authHeader.slice(7);
      const client = new OAuth2Client();
      const ticket = await client.verifyIdToken({ idToken: token, audience: `${APP_URL}/webhooks/google` });
      const payload = ticket.getPayload();
      if (payload.iss !== 'pubsub.googleapis.com' && payload.iss !== 'accounts.google.com') {
        return reply.send({ received: true, processed: false });
      }
    } catch (err) {
      app.log.warn({ err }, 'Google Pub/Sub JWT verification failed');
      return reply.send({ received: true, processed: false });
    }

    try {
      const decoded = JSON.parse(Buffer.from(envelope.message.data, 'base64').toString());
      const notification = decoded.subscriptionNotification;
      if (!notification) return reply.send({ received: true });

      const { notificationType, purchaseToken, subscriptionId } = notification;
      const plan = planFromProductId(subscriptionId || '');

      if (notificationType === 4) {
        const existing = await findByProvider({ provider: 'google', providerId: purchaseToken });
        if (!existing) {
          app.log.warn({ purchaseToken }, 'Google SUBSCRIPTION_PURCHASED for unknown token');
          return reply.send({ received: true });
        }
        await upsertSubscription({ accountId: existing.accountId, plan, status: 'active', provider: 'google', providerId: purchaseToken });
        return reply.send({ received: true });
      }

      const existing = await findByProvider({ provider: 'google', providerId: purchaseToken });
      if (!existing) {
        app.log.warn({ purchaseToken, notificationType }, 'Google notification for unknown token');
        return reply.send({ received: true });
      }

      let status = 'active';
      if (notificationType === 11 || notificationType === 12) status = 'expired';
      else if (notificationType === 5) status = 'grace_period';

      await upsertSubscription({ accountId: existing.accountId, plan, status, provider: 'google', providerId: purchaseToken });
    } catch (err) {
      app.log.error({ err }, 'Error processing Google webhook');
      throw err;
    }

    return reply.send({ received: true });
  });

}

module.exports = webhookRoutes;
