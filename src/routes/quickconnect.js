'use strict';

const crypto = require('crypto');
const { QuickConnectCode } = require('../models');
const { hashSessionId } = require('../lib/crypto');

const AUTH_BODY_LIMIT_BYTES = parseInt(process.env.AUTH_BODY_LIMIT_BYTES ?? '16384', 10);

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_REGEX = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

// The secret is a redeemable pairing credential, so it is stored as an HMAC like
// every other secret here (sessions, SSO exchange codes, MFA challenges). The
// prefix namespaces it away from the ws-ticket and sso-exchange hashes, which share
// the same HMAC key.
function hashSecret(secret) {
  return hashSessionId(`quickconnect:${secret}`);
}

function generateCode() {
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return result.slice(0, 3) + '-' + result.slice(3);
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function quickconnectRoutes(app) {
  await app.register(require('../middleware/auth'));

  app.post('/quickconnect/initiate', {
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: AUTH_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.QUICKCONNECT_GENERATE_RATE_LIMIT_PER_MINUTE ?? '3', 10),
        timeWindow: '1 minute',
      },
    },
    bodyLimit: AUTH_BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    const code = generateCode();
    const secret = generateSecret();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await QuickConnectCode.create({ code, secret: hashSecret(secret), authorized: false, payload: null, expiresAt });

    return reply.status(201).send({ secret, code, expiresAt });
  });

  app.post('/quickconnect/authorize/:code', {
    preHandler: [app.authenticate],
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: AUTH_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.QUICKCONNECT_APPROVE_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        timeWindow: '1 minute',
      },
    },
    bodyLimit: AUTH_BODY_LIMIT_BYTES,
  }, async (req, reply) => {
    const { code } = req.params;

    if (!CODE_REGEX.test(code)) {
      return reply.status(400).send({ error: 'invalid_code', message: 'Invalid code format.' });
    }

    const qc = await QuickConnectCode.findOne({ code });
    if (!qc || qc.expiresAt < new Date()) {
      return reply.status(404).send({ error: 'not_found', message: 'Code expired or not found.' });
    }

    if (qc.authorized) {
      return reply.status(409).send({ error: 'already_authorized', message: 'Code has already been authorized.' });
    }

    const rawPayload = req.body?.payload ?? null;
    const MAX_PAYLOAD_BYTES = parseInt(process.env.QUICKCONNECT_MAX_PAYLOAD_BYTES ?? '4096', 10);
    let payload = null;
    if (rawPayload !== null && rawPayload !== undefined) {
      const payloadType = typeof rawPayload;
      if (payloadType !== 'string') {
        return reply.status(400).send({ error: 'invalid_payload', message: 'Payload must be a string.' });
      }
      if (Buffer.byteLength(rawPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
        return reply.status(413).send({ error: 'payload_too_large', message: 'QuickConnect payload exceeds the allowed size.' });
      }
      if (rawPayload.length > 0 && /[\s]/.test(rawPayload[0]) !== false) {
        if (rawPayload.includes('\r') || rawPayload.includes('\n')) {
          return reply.status(400).send({ error: 'invalid_payload', message: 'Payload cannot contain line breaks.' });
        }
      }
      payload = rawPayload;
    }

    qc.authorized = true;
    qc.payload = payload;
    await qc.save();

    return reply.send({ authorized: true });
  });

  app.get('/quickconnect/connect', {
    config: {
      rateLimit: {
        max: parseInt(process.env.QUICKCONNECT_POLL_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { secret } = req.query;

    if (!secret || typeof secret !== 'string') {
      return reply.status(400).send({ error: 'missing_secret', message: 'Secret query parameter is required.' });
    }

    const secretHash = hashSecret(secret);
    const qc = await QuickConnectCode.findOne({ secret: secretHash });
    if (!qc || qc.expiresAt < new Date()) {
      return reply.status(404).send({ error: 'not_found', message: 'Request expired or not found.' });
    }

    if (!qc.authorized) {
      return reply.send({ authorized: false, payload: null });
    }

    await QuickConnectCode.deleteOne({ secret: secretHash });

    return reply.send({ authorized: true, payload: qc.payload });
  });
}

module.exports = quickconnectRoutes;
