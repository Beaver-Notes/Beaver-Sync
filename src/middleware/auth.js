'use strict';

const fs  = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fp  = require('fastify-plugin');
const { Session } = require('../models');
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
    console.error(
      'JWT keys not found. Run: npm run generate-keys\n' +
      `   Private: ${process.env.JWT_PRIVATE_KEY_PATH}\n` +
      `   Public:  ${process.env.JWT_PUBLIC_KEY_PATH}`
    );
    process.exit(1);
  }
}

if (process.env.LEGACY_AUTH_ENABLED === 'true') {
  loadKeys();
}

function getIpSubnet(req) {
  const ip = req.ip ?? '0.0.0.0';
  const ipv4 = ip.includes(':') ? '0.0.0.0' : ip;
  const parts = ipv4.split('.');
  return parts.slice(0, 3).join('.');
}

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

    if (process.env.LEGACY_AUTH_ENABLED === 'true') {
      try {
        const payload = verifyToken(rawId);
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

module.exports = fp(authPlugin);
module.exports.createSession = createSession;
module.exports.validateSession = validateSession;
module.exports.signToken = signToken;
module.exports.setSessionCookieIfAvailable = function setSessionCookieIfAvailable(app, reply, rawId) {
  if (app && typeof app.setSessionCookie === 'function') {
    app.setSessionCookie(reply, rawId);
  }
  return reply;
};
