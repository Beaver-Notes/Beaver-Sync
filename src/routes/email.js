'use strict';

const crypto = require('crypto');
const email = require('../lib/email');

function extractAlias(to) {
  if (!to || typeof to !== 'string') return null;

  const angleMatch = to.match(/<([^>]+)>/);
  const addr = (angleMatch ? angleMatch[1].trim() : to.trim()).toLowerCase();

  const notifyDomain = process.env.NOTIFY_DOMAIN ?? 'notify.beavernotes.com';
  if (!addr.endsWith(`@${notifyDomain}`)) return null;

  return addr;
}

async function emailRoutes(app) {
  // Raw bytes for HMAC verification; the JSON parser would re-serialize and byte-mismatch.
  app.addHook('preParsing', (req, _reply, payload, done) => {
    if (req.method !== 'POST' || !req.url.startsWith('/email/inbound')) return done(null, payload);
    const chunks = [];
    payload.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    payload.on('end', () => {
      const buf = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      req.rawBody = buf.toString('utf-8');
      const { Readable } = require('stream');
      done(null, Readable.from(buf));
    });
    payload.on('error', (err) => done(err));
  });

  app.post('/email/inbound', {
    config: {
      security: { public: true },
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const webhookSecret = process.env.INBOUND_WEBHOOK_SECRET;
      if (webhookSecret) {
        const signature = req.headers['x-webhook-signature'];
        if (!signature) {
          app.log.warn('Inbound email missing webhook signature');
          return reply.status(401).send({ error: 'missing_signature', message: 'Webhook signature required.' });
        }

        // Exact signed bytes; JSON.stringify fallback only for inject-style callers without rawBody.
        const rawBody = req.rawBody != null ? req.rawBody : JSON.stringify(req.body ?? '');
        const expectedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(rawBody)
          .digest('hex');

        const a = Buffer.from(signature, 'utf8');
        const b = Buffer.from(expectedSignature, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          app.log.warn('Inbound email invalid webhook signature');
          return reply.status(401).send({ error: 'invalid_signature', message: 'Invalid webhook signature.' });
        }
      } else if (process.env.NOTIFY_DOMAIN) {
        app.log.warn('INBOUND_WEBHOOK_SECRET unset while NOTIFY_DOMAIN is configured — inbound aliases are spam-forwardable');
      }

      const payload = req.body || {};

      const to = payload.to || payload.recipient || payload.envelope?.to || '';
      const alias = extractAlias(to);

      if (!alias) {
        app.log.warn({ to }, 'Inbound email for unrecognized address');
        return reply.status(200).send({ handled: false });
      }

      const resolved = await email.resolveAlias(alias);
      if (!resolved) {
        app.log.warn({ alias }, 'Alias not found or expired for inbound email');
        return reply.status(200).send({ handled: false });
      }

      await email.forwardToRealEmail(alias, {
        from: payload.from || '',
        subject: payload.subject || '',
        html: payload.html || payload.text || '',
        text: payload.text || '',
      });

      app.log.info({ alias }, 'Inbound email forwarded');
      return reply.status(200).send({ handled: true });
    } catch (err) {
      app.log.error({ err }, 'Failed to process inbound email');
      return reply.status(200).send({ handled: false });
    }
  });
}

module.exports = emailRoutes;
module.exports.extractAlias = extractAlias;
