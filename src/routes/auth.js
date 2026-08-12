'use strict';

const bcrypt = require('bcrypt');
const { z }  = require('zod');
const { Account, Subscription, Session, Workspace, WorkspaceMember, Organization, OrgMember, OrgSubscription } = require('../models');
const { createSession, validateSession, setSessionCookieIfAvailable } = require('../middleware/auth');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { createEmailHash } = require('../lib/crypto');
const mlkem = require('../lib/mlkem');
const { sendWelcomeEmail } = require('../email');
const { audit } = require('../lib/audit');
const { isEnterpriseMode } = require('../lib/license');
const { getQuotaBytes } = require('../lib/plans');

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;
const AUTH_BODY_LIMIT_BYTES = parseInt(process.env.AUTH_BODY_LIMIT_BYTES ?? '16384', 10);
const DUMMY_BCRYPT_HASH = '$2b$12$' + 'a'.repeat(53);

const RegisterSchema = z.object({
  email:    z.string().email('Invalid email address').max(254),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(128, 'Password too long'),
  kemPublicKey: z.string().max(4096).optional(),
});

const LoginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(128),
});

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

  app.post('/register', authRateLimit, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED !== 'true') {
      return reply.status(410).send({
        error: 'legacy_auth_disabled',
        message: 'Password authentication has been replaced by passkeys.',
      });
    }

    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const { password } = parsed.data;
    const emailHash = createEmailHash(email);

    const existing = await Account.findOne({ emailHmac: emailHash }).lean();
    if (existing) {
      app.recordSecurityEvent(req, 'register_conflict', { emailDomain: email.split('@')[1] ?? null });
      return reply.status(409).send({
        error: 'registration_failed',
        message: 'Unable to create Beaver Account with those details.',
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const kdfSalt = require('crypto').randomBytes(32).toString('hex');
    const emailEncrypted = await mlkem.encryptMetadata(email);

    const kemPublicKey = parsed.data.kemPublicKey;
    if (kemPublicKey && !validatePublicKey(kemPublicKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid kemPublicKey.' });
    }
    const accountData = { emailHmac: emailHash, emailEncrypted, passwordHash, kdfSalt };
    if (kemPublicKey) accountData.kemPublicKey = kemPublicKey;
    const account = await Account.create(accountData);

    const plan = isEnterpriseMode() ? 'enterprise' : 'free';
    const storageQuotaBytes = isEnterpriseMode() ? getQuotaBytes('enterprise') : 0;
    await Subscription.create({ accountId: account.id, plan, status: 'active', storageQuotaBytes, createdAt: new Date() });

    // Create personal org
    const orgId = require('crypto').randomUUID();
    const orgName = account.username || email.split('@')[0];
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await Organization.create({ id: orgId, nameEncrypted: '', slug, createdAt: new Date() });
    await OrgMember.create({ orgId, accountId: account.id, role: 'owner', createdAt: new Date() });
    await OrgSubscription.create({ id: require('crypto').randomUUID(), orgId, plan, status: 'active', seats: 1, storageQuotaBytes, createdAt: new Date() });

    // Create default workspace in personal org
    const defaultWorkspace = await Workspace.create({ nameEncrypted: '', ownerId: account.id, orgId, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: defaultWorkspace.id, accountId: account.id, role: 'owner', createdAt: new Date() });

    // Initialize sync state for the new workspace so /sync/state doesn't 404
    const { query } = require('../db');
    await query(
      'INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [defaultWorkspace.id, 'empty', 0, new Date().toISOString()]
    );

    const token = await createSession(account.id, req);

    app.log.info({ userId: account.id }, 'New account registered');
    sendWelcomeEmail(app, account.id);
    req.userId = account.id;
    audit(req, 'register', {});

    setSessionCookieIfAvailable(app, reply, token);
    return reply.status(201).send({
      token,
      user: {
        id:    account.id,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
        kemPublicKey: account.kemPublicKey || null,
      },
      organization: {
        id: orgId,
        nameEncrypted: '',
        role: 'owner',
      },
      workspace: {
        id: defaultWorkspace.id,
        nameEncrypted: '',
        role: 'owner',
      },
    });
  });

  app.post('/token', authRateLimit, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED !== 'true') {
      return reply.status(410).send({
        error: 'legacy_auth_disabled',
        message: 'Password authentication has been replaced by passkeys.',
      });
    }

    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Invalid email or password.',
      });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const { password } = parsed.data;
    const emailHash = createEmailHash(email);

    const account = await Account.findOne({ emailHmac: emailHash });

    const genericError = {
      error: 'invalid_credentials',
      message: 'Invalid email or password.',
    };

    if (!account) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      app.recordSecurityEvent(req, 'login_failure', { reason: 'unknown_account', emailDomain: email.split('@')[1] ?? null });
      return reply.status(401).send(genericError);
    }

    if (account.lockedUntil && account.lockedUntil > new Date()) {
      app.recordSecurityEvent(req, 'account_locked', { userId: account.id });
      const minutesLeft = Math.ceil((account.lockedUntil - Date.now()) / 60_000);
      return reply.status(429).send({
        error: 'beaver_account_locked',
        message: `Too many failed attempts. Try again in ${minutesLeft} minute(s).`,
      });
    }

    const passwordMatch = await bcrypt.compare(password, account.passwordHash);

    if (!passwordMatch) {
      const newAttempts = (account.failedLoginAttempts ?? 0) + 1;
      const update = { failedLoginAttempts: newAttempts };

      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        update.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
        update.failedLoginAttempts = 0;
        app.log.warn({ userId: account.id }, 'Account locked after repeated failures');
        app.recordSecurityEvent(req, 'account_locked', { userId: account.id });
      }

      await Account.updateOne({ _id: account.id }, update);
      app.recordSecurityEvent(req, 'login_failure', {
        userId: account.id,
        reason: 'invalid_password',
      });
      return reply.status(401).send(genericError);
    }

    await Account.updateOne(
      { _id: account.id },
      { failedLoginAttempts: 0, lockedUntil: null }
    );

    const token = await createSession(account.id, req);
    req.userId = account.id;
    audit(req, 'login', { method: 'password' });

    let subscription = await Subscription.findOne(
      { accountId: account.id },
      { plan: 1, status: 1, renewsAt: 1, storageUsedBytes: 1, storageQuotaBytes: 1 }
    ).lean();

    if (isEnterpriseMode()) {
      if (!subscription) {
        subscription = { plan: 'enterprise', status: 'active', renewsAt: null, storageUsedBytes: 0, storageQuotaBytes: getQuotaBytes('enterprise') };
      } else {
        subscription.plan = 'enterprise';
        subscription.storageQuotaBytes = getQuotaBytes('enterprise');
      }
    }

    setSessionCookieIfAvailable(app, reply, token);
    return reply.send({
      token,
      user: {
        id:    account.id,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
        kemPublicKey: account.kemPublicKey || null,
      },
      subscription: subscription ?? null,
    });
  });

  app.post('/keypair', {
    ...authRateLimit,
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const { kemPublicKey } = req.body ?? {};
    if (!kemPublicKey || typeof kemPublicKey !== 'string' || !validatePublicKey(kemPublicKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'A valid kemPublicKey is required.' });
    }
    await Account.updateOne({ _id: req.userId }, { $set: { kemPublicKey } });
    audit(req, 'kem_keypair_updated', {});
    return reply.send({ ok: true });
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
      if (!providedSecret || providedSecret !== internalSecret) {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Internal API access denied.',
        });
      }
    }

    const { token, workspaceId } = req.body ?? {};
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

      const { WorkspaceMember } = require('../models');
      const membership = await WorkspaceMember.findOne({ workspaceId, accountId: result.userId }).lean();

      if (!membership) {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Not a member of this workspace.',
        });
      }

      return reply.send({ userId: result.userId, role: membership.role });
    }

    return reply.send({ userId: result.userId });
  });

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
    }

    audit(req, 'logout', {});
    reply.clearCookie('bsession');
    return reply.send({ message: 'Logged out successfully.' });
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
}

module.exports = authRoutes;
