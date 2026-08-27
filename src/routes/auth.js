'use strict';

const crypto = require('crypto');
const { Account, WorkspaceMember } = require('../models');
const { validateSession } = require('../middleware/auth');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { audit } = require('../lib/audit');
const { registerLegacyPasswordRoutes } = require('./auth-password');
const { registerSessionRoutes } = require('./auth-sessions');

const AUTH_BODY_LIMIT_BYTES = parseInt(process.env.AUTH_BODY_LIMIT_BYTES ?? '16384', 10);

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Shared workspace/note role resolution for verify-session and ws-ticket.
// Returns { role } or { error: { status, payload } }.
async function resolveAuthRole(userId, workspaceId, noteId) {
  if (!workspaceId && !noteId) return {};
  if (workspaceId) {
    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
    if (membership) return { role: membership.role };
    if (noteId === undefined) {
      return { error: { status: 403, payload: { error: 'forbidden', message: 'Not a member of this workspace.' } } };
    }
  }
  const { NoteInvitation } = require('../models');
  const collab = await NoteInvitation.findOne({ noteId, userId }).lean();
  if (!collab) {
    return { error: { status: 403, payload: { error: 'forbidden', message: 'Not a collaborator on this note.' } } };
  }
  return { role: collab.role === 'viewer' ? 'viewer' : 'editor' };
}

async function authRoutes(app) {
  await app.register(require('../middleware/auth'));

  const authRateLimit = {
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: AUTH_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? '5', 10),
        timeWindow: '1 minute',
      },
    },
    bodyLimit: AUTH_BODY_LIMIT_BYTES,
  };

  await registerLegacyPasswordRoutes(app, authRateLimit);

  app.post('/keypair', {
    ...authRateLimit,
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const { kemPublicKey, deviceId } = req.body ?? {};
    if (!kemPublicKey || typeof kemPublicKey !== 'string' || !validatePublicKey(kemPublicKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'A valid kemPublicKey is required.' });
    }
    const did = typeof deviceId === 'string' && deviceId ? deviceId : 'default';
    const account = await Account.findById(req.userId);
    const keys = Array.isArray(account?.deviceKeys) ? account.deviceKeys : [];
    // Append-only per deviceId: drop any prior entry for this device, then
    // append the new one. Never overwrite the whole array.
    const without = keys.filter((d) => d.deviceId !== did);
    const next = [
      ...without,
      { deviceId: did, publicKey: kemPublicKey, createdAt: new Date().toISOString() },
    ];
    const update = { deviceKeys: JSON.stringify(next) };
    // kemPublicKey stays the legacy primary (first key) so single-key clients
    // keep working; only seed it when not already present.
    if (!account?.kemPublicKey) update.kemPublicKey = kemPublicKey;
    await Account.updateOne({ _id: req.userId }, { $set: update });
    audit(req, 'kem_keypair_updated', { deviceId: did });
    return reply.send({ ok: true, deviceId: did, deviceCount: next.length });
  });

  app.get('/keypair', {
    ...authRateLimit,
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const targetId = req.query?.userId ? String(req.query.userId) : req.userId;
    const account = await Account.findById(targetId, { kemPublicKey: 1, deviceKeys: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'User not found.' });
    return reply.send({ kemPublicKey: account.kemPublicKey || null, deviceKeys: account.deviceKeys || [] });
  });

  app.post('/verify-session', {
    config: {
      security: {
        public: true,
      },
      rateLimit: {
        max: parseInt(process.env.VERIFY_SESSION_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) {
      const providedSecret = req.headers['x-internal-secret'];
      if (!providedSecret || !timingSafeEqualStr(providedSecret, internalSecret)) {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Internal API access denied.',
        });
      }
    }

    const { token, workspaceId, noteId } = req.body ?? {};
    if (!token || typeof token !== 'string' || token.length < 32) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Valid session token required.',
      });
    }

    const result = await validateSession(token);
    if (!result) {
      return reply.status(401).send({
        error: 'invalid_token',
        message: 'Session token is invalid or expired.',
      });
    }

    if (workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Invalid workspaceId.',
        });
      }

      const resolved = await resolveAuthRole(result.userId, workspaceId, noteId);
      if (resolved.error) {
        return reply.status(resolved.error.status).send(resolved.error.payload);
      }
      return reply.send({ userId: result.userId, role: resolved.role });
    }

    if (noteId !== undefined) {
      if (typeof noteId !== 'string' || noteId.length === 0) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Invalid noteId.',
        });
      }

      const resolved = await resolveAuthRole(result.userId, undefined, noteId);
      if (resolved.error) {
        return reply.status(resolved.error.status).send(resolved.error.payload);
      }
      return reply.send({ userId: result.userId, role: resolved.role });
    }

    return reply.send({ userId: result.userId });
  });

  // One-time short-lived ticket so session tokens never appear in WS URLs (L-1).
  app.post('/ws-ticket', {
    preHandler: [app.authenticate],
    config: {
      security: { public: false },
      rateLimit: { max: parseInt(process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE ?? '30', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const { workspaceId, noteId } = req.body ?? {};
    const resolved = await resolveAuthRole(req.userId, workspaceId, noteId);
    if (resolved.error) {
      return reply.status(resolved.error.status).send(resolved.error.payload);
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    const ttlSeconds = parseInt(process.env.WS_TICKET_TTL_SECONDS ?? '60', 10);
    const { getDb } = require('../db');
    const { hashSessionId } = require('../lib/crypto');
    await getDb().query('DELETE FROM ws_tickets WHERE expires_at < NOW()');
    await getDb().query(
      'INSERT INTO ws_tickets (id_hash, account_id, device_id, role, expires_at) VALUES ($1,$2,$3,$4, NOW() + make_interval(secs => $5))',
      [hashSessionId(ticket), req.userId, req.sessionDeviceId ?? null, resolved.role ?? null, ttlSeconds]
    );
    return reply.send({ ticket });
  });

  // Relay-only consumption of ws-tickets. Single-use via atomic DELETE ... RETURNING.
  app.post('/verify-ticket', {
    config: {
      security: { public: true },
      rateLimit: { max: parseInt(process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE ?? '30', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) {
      const providedSecret = req.headers['x-internal-secret'];
      if (!providedSecret || !timingSafeEqualStr(providedSecret, internalSecret)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Internal API access denied.' });
      }
    }
    const { ticket } = req.body ?? {};
    if (!ticket || typeof ticket !== 'string' || ticket.length < 16) {
      return reply.status(400).send({ error: 'invalid_request', message: 'Valid ticket required.' });
    }
    const { getDb } = require('../db');
    const { hashSessionId } = require('../lib/crypto');
    const consumed = await getDb().query(
      'DELETE FROM ws_tickets WHERE id_hash = $1 AND expires_at > NOW() RETURNING account_id, device_id, role',
      [hashSessionId(ticket)]
    );
    if (consumed.rows.length === 0) {
      return reply.status(401).send({ error: 'invalid_ticket', message: 'Ticket is invalid, used, or expired.' });
    }
    const row = consumed.rows[0];
    const out = { userId: row.account_id };
    if (row.device_id) out.deviceId = row.device_id;
    if (row.role) out.role = row.role;
    return reply.send(out);
  });

  await registerSessionRoutes(app);
}

module.exports = authRoutes;
