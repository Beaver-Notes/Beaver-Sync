'use strict';

const { Account, Session } = require('../models');
const { audit } = require('../lib/audit');

async function registerSessionRoutes(app) {
  app.post('/logout', {
    preHandler: [app.authenticate],
    config: {
      rateLimit: {
        max: parseInt(process.env.LOGOUT_RATE_LIMIT_PER_MINUTE ?? '20', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const authHeader = req.headers['authorization'];
    let rawId = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawId = authHeader.slice(7);
    }
    if (!rawId && req.cookies?.bsession) {
      rawId = req.cookies.bsession;
    }

    if (rawId) {
      const { hashSessionId } = require('../lib/crypto');
      const sessionIdHash = hashSessionId(rawId);
      await Session.updateOne({ idHash: sessionIdHash }, { revoked: true });
      // Refresh tokens outlive the session by design, so logging out has to
      // kill them explicitly or a client could silently come back.
      const { revokeRefreshTokensForSession } = require('../middleware/auth');
      await revokeRefreshTokensForSession(rawId);
    }

    audit(req, 'logout', {});
    reply.clearCookie('bsession');
    return reply.send({ message: 'Logged out successfully.' });
  });

  // Kill switch for legacy stateless JWTs: everything issued before now stops working.
  app.post('/revoke-legacy', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED === 'false') {
      return reply.status(410).send({ error: 'legacy_auth_disabled', message: 'Legacy auth is disabled.' });
    }
    await Account.updateOne({ _id: req.userId }, { $set: { jwtRevokedAt: new Date() } });
    audit(req, 'revoke_legacy_tokens', {});
    return reply.send({ message: 'All legacy tokens revoked.' });
  });

  app.get('/sessions', {
    preHandler: [app.authenticate],
    config: {
      rateLimit: {
        max: parseInt(process.env.SESSION_LIST_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const sessions = await Session.find({
      accountId: req.userId,
      revoked: false,
      expiresAt: { $gt: new Date() },
    }).sort({ lastSeenAt: -1 }).lean();

    return reply.send(sessions.map(s => ({
      id: s.idHash,
      deviceLabel: s.deviceLabel,
      ipSubnet: s.ipSubnet,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
    })));
  });

  app.delete('/sessions/:id', {
    preHandler: [app.authenticate],
    config: {
      rateLimit: {
        max: parseInt(process.env.SESSION_REVOKE_RATE_LIMIT_PER_MINUTE ?? '20', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const sessionIdHash = req.params.id;

    const session = await Session.findOne({ idHash: sessionIdHash });
    if (!session) {
      return reply.status(404).send({ error: 'not_found', message: 'Session not found.' });
    }

    if (session.accountId !== req.userId) {
      app.recordSecurityEvent(req, 'session_revoke_unauthorized', { targetSession: sessionIdHash });
      return reply.status(403).send({ error: 'forbidden', message: 'You can only revoke your own sessions.' });
    }

    session.revoked = true;
    await session.save();

    app.recordSecurityEvent(req, 'session_revoked', { targetSession: sessionIdHash });
    return reply.send({ revoked: true });
  });

  app.post('/sessions/revoke-all', {
    preHandler: [app.authenticate],
    config: {
      security: {
        allowedContentTypes: ['application/json'],
      },
      rateLimit: {
        max: parseInt(process.env.SESSION_REVOKE_ALL_RATE_LIMIT_PER_MINUTE ?? '3', 10),
        timeWindow: '1 minute',
      },
    },
    bodyLimit: parseInt(process.env.SESSION_REVOKE_ALL_BODY_LIMIT_BYTES ?? '8192', 10),
  }, async (req, reply) => {
    const { keepCurrent = true, currentSessionId = null } = req.body || {};
    let keepIdHash = null;

    if (keepCurrent) {
      const authHeader = req.headers['authorization'];
      const rawId = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies?.bsession || null;

      if (rawId) {
        const { hashSessionId } = require('../lib/crypto');
        keepIdHash = hashSessionId(rawId);
      } else if (currentSessionId) {
        keepIdHash = currentSessionId;
      }
    }

    const filter = { accountId: req.userId, revoked: false };
    if (keepIdHash) {
      filter.idHash = { $ne: keepIdHash };
    }

    const result = await Session.updateMany(filter, { $set: { revoked: true } });

    const revoked = Number(result?.modifiedCount ?? result?.changes ?? 0);

    app.recordSecurityEvent(req, 'sessions_revoked_all', { revoked, keepCurrent: !!keepIdHash });
    return reply.send({ revoked, keepCurrent: !!keepIdHash });
  });

  // Exchange a refresh token for a fresh session. Deliberately unauthenticated:
  // the refresh token is the credential, and it is presented precisely when the
  // session it was issued with has already expired.
  app.post('/refresh', {
    config: {
      security: { public: true, allowedContentTypes: ['application/json'] },
      rateLimit: {
        max: parseInt(process.env.REFRESH_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'Refresh token is required.' });
    }

    // Lazy require: auth.js pulls in this module at load time, and
    // middleware/auth must not be dragged into that cycle.
    const { createSession, setSessionCookieIfAvailable, rotateRefreshToken } = require('../middleware/auth');
    const rotated = await rotateRefreshToken(refreshToken, req);
    if (!rotated) {
      return reply.status(401).send({
        error: 'invalid_refresh_token',
        message: 'Your session has expired. Please log in again.',
      });
    }

    const token = await createSession(rotated.accountId, req);
    req.userId = rotated.accountId;
    setSessionCookieIfAvailable(app, reply, token);
    audit(req, 'session_refreshed', {});
    return reply.send({ token, sessionToken: token, refreshToken: rotated.refreshToken });
  });
}

module.exports = { registerSessionRoutes };
