'use strict';

const fs  = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fp  = require('fastify-plugin');
const { Session, RefreshToken } = require('../models');
const { getDb } = require('../db');
const { hashSessionId } = require('../lib/crypto');

const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS ?? '24', 10);
const SESSION_MAX_AGE_DAYS = parseInt(process.env.SESSION_MAX_AGE_DAYS ?? '30', 10);
const IDLE_TIMEOUT_HOURS = parseInt(process.env.IDLE_TIMEOUT_HOURS ?? '24', 10);
const SESSION_WRITE_THROTTLE_MS = 60 * 1000;

let privateKey;
let publicKey;

function loadKeys() {
  try {
    privateKey = fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH, 'utf8');
    publicKey  = fs.readFileSync(process.env.JWT_PUBLIC_KEY_PATH,  'utf8');
  } catch {
    // Legacy JWT keys are optional: without them only the legacy JWT fallback
    // breaks (sessions still authenticate), so a missing file must not kill
    // the boot — legacy is now on by default and fresh installs/tests have no
    // key files yet.
    console.warn(
      'JWT keys not found — legacy JWT fallback disabled. Run: npm run generate-keys to enable it.\n' +
      `   Private: ${process.env.JWT_PRIVATE_KEY_PATH}\n` +
      `   Public:  ${process.env.JWT_PUBLIC_KEY_PATH}`
    );
  }
}

if (process.env.LEGACY_AUTH_ENABLED !== 'false') {
  loadKeys();
}

const { getIpSubnet } = require('../lib/audit');

async function createSession(userId, req, workspaceId = null) {
  const rawId = crypto.randomBytes(32).toString('base64url');
  const sessionIdHash = hashSessionId(rawId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  await Session.create({
    idHash: sessionIdHash,
    accountId: userId,
    workspaceId: workspaceId ?? null,
    deviceLabel: String(req?.headers?.['x-device-label'] ?? 'Unknown Device').slice(0, 128),
    deviceId: req?.headers?.['x-device-id'] || null,
    ipSubnet: getIpSubnet(req),
    expiresAt,
    lastSeenAt: now,
    revoked: false,
  });

  return rawId;
}

async function validateSession(rawId) {
  if (!rawId || rawId.length < 32) return null;
  const sessionIdHash = hashSessionId(rawId);
  const session = await Session.findOne({ idHash: sessionIdHash });

  if (!session) return null;
  if (session.revoked) return null;
  if (session.expiresAt < new Date()) return null;

  const now = new Date();
  const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_HOURS * 60 * 60 * 1000);
  if (session.lastSeenAt < idleCutoff) return null;

  // Throttle the sliding-expiry write: the DB copy is only used for idle and
  // absolute-expiry checks that tolerate being up to a minute stale.
  const lastSeenMs = session.lastSeenAt instanceof Date ? session.lastSeenAt.getTime() : 0;
  if (lastSeenMs === 0 || now.getTime() - lastSeenMs >= SESSION_WRITE_THROTTLE_MS) {
    const newExpiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000);
    const maxExpiresAt = new Date(session.createdAt.getTime() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    session.lastSeenAt = now;
    session.expiresAt = newExpiresAt > maxExpiresAt ? maxExpiresAt : newExpiresAt;
    await session.save();
  }

  return { userId: session.accountId, deviceId: session.deviceId || null };
}

function signToken(userId) {
  return jwt.sign(
    { sub: userId },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
      issuer: 'beaver-sync',
    }
  );
}

function verifyToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: 'beaver-sync',
  });
}

async function authPlugin(app) {
  app.decorate('authenticate', async function (req, reply) {
    const authHeader = req.headers['authorization'];
    let rawId = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawId = authHeader.slice(7);
    }

    if (!rawId) {
      const cookie = req.cookies?.bsession;
      if (cookie) {
        rawId = cookie;
      }
    }

    if (!rawId) {
      req.authResult = 'missing';
      return reply.status(401).send({
        error: 'unauthorized',
        message: 'Missing or malformed Authorization header.',
      });
    }

    const sessionResult = await validateSession(rawId);
    if (sessionResult) {
      req.userId = sessionResult.userId;
      req.sessionDeviceId = sessionResult.deviceId;
      req.authResult = 'authenticated';
      return;
    }

    if (process.env.LEGACY_AUTH_ENABLED !== 'false') {
      try {
        const payload = verifyToken(rawId);
        // Stateless JWTs are revocable via accounts.jwt_revoked_at (set by /auth/revoke-legacy)
        const revoked = await getDb().query('SELECT jwt_revoked_at FROM accounts WHERE id = $1', [payload.sub]);
        // Inclusive second comparison: tokens issued in the revocation second die too
        if (revoked.rows[0]?.jwt_revoked_at && payload.iat <= Math.floor(new Date(revoked.rows[0].jwt_revoked_at).getTime() / 1000)) {
          req.authResult = 'expired';
          return reply.status(401).send({ error: 'token_expired', message: 'Your session has expired. Please log in again.' });
        }
        req.userId = payload.sub;
        req.sessionDeviceId = null;
        req.authResult = 'authenticated';
        return;
      } catch (err) {
        const isExpired = err.name === 'TokenExpiredError';
        req.authResult = isExpired ? 'expired' : 'invalid';
        return reply.status(401).send({
          error: isExpired ? 'token_expired' : 'invalid_token',
          message: isExpired
            ? 'Your session has expired. Please log in again.'
            : 'Invalid authentication token.',
        });
      }
    }

    req.authResult = 'invalid';
    return reply.status(401).send({
      error: 'invalid_token',
      message: 'Invalid authentication token.',
    });
  });
}

// Opaque, single-use, rotating. The raw value is never stored — only its hash —
// and every exchange replaces it. Presenting an already-rotated token proves
// the value leaked, so the whole family is dropped instead of being re-issued.
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS ?? '30', 10);

async function createRefreshToken(accountId, rawSessionId, req, familyHash = null) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await RefreshToken.create({
    idHash: hashSessionId(raw),
    accountId,
    // The family link is carried forward through every rotation, so a replay of
    // any generation can still find (and burn) the whole set.
    sessionIdHash: familyHash ?? (rawSessionId ? hashSessionId(rawSessionId) : null),
    deviceLabel: String(req?.headers?.['x-device-label'] ?? 'Unknown Device').slice(0, 128),
    deviceId: req?.headers?.['x-device-id'] || null,
    expiresAt: new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    lastUsedAt: null,
    revoked: false,
    rotatedTo: null,
    createdAt: now,
  });

  return raw;
}

// Revoke every live token in a family: either the one bound to a session
// (logout / revoke-all) or, when `stored` is given, the family that a replayed
// token belonged to.
async function revokeRefreshTokensForSession(rawSessionId, stored = null) {
  const family = stored ? (stored.sessionIdHash ?? null) : hashSessionId(rawSessionId);
  if (family) {
    await RefreshToken.updateMany({ sessionIdHash: family, revoked: false }, { $set: { revoked: true } });
    return;
  }
  // No family link survived (row predates the link): a replay means the value
  // leaked, so drop every live token the account holds rather than leave one.
  await RefreshToken.updateMany({ accountId: stored.accountId, revoked: false }, { $set: { revoked: true } });
}

async function rotateRefreshToken(raw, req) {
  if (!raw || typeof raw !== 'string' || raw.length < 32) return null;
  const stored = await RefreshToken.findOne({ idHash: hashSessionId(raw) });
  if (!stored) return null;

  if (stored.revoked) {
    // Replay of a rotated or revoked token: treat it as leaked and burn the set.
    await revokeRefreshTokensForSession(null, stored);
    return null;
  }
  if (stored.expiresAt < new Date()) return null;

  const next = await createRefreshToken(stored.accountId, null, req, stored.sessionIdHash ?? null);
  stored.revoked = true;
  stored.rotatedTo = hashSessionId(next);
  stored.lastUsedAt = new Date();
  await stored.save();

  return { accountId: stored.accountId, refreshToken: next };
}

module.exports = fp(authPlugin);
module.exports.createSession = createSession;
module.exports.validateSession = validateSession;
module.exports.createRefreshToken = createRefreshToken;
module.exports.rotateRefreshToken = rotateRefreshToken;
module.exports.revokeRefreshTokensForSession = revokeRefreshTokensForSession;
module.exports.signToken = signToken;
module.exports.setSessionCookieIfAvailable = function setSessionCookieIfAvailable(app, reply, rawId) {
  if (app && typeof app.setSessionCookie === 'function') {
    app.setSessionCookie(reply, rawId);
  }
  return reply;
};
