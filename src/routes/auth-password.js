'use strict';

const bcrypt = require('bcrypt');
const { z }  = require('zod');
const { Account, Subscription, Workspace, WorkspaceMember, Organization, OrgMember, OrgSubscription } = require('../models');
const { createEmptyState } = require('../repositories/syncWorkspaceState');
const { createSession, setSessionCookieIfAvailable } = require('../middleware/auth');
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
const DUMMY_BCRYPT_HASH = '$2b$12$' + 'a'.repeat(53);

function sanitizeUsername(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  let v = raw.trim().replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!v) return null;
  if (v.length > 50) v = v.slice(0, 50);
  return v;
}

const RegisterSchema = z.object({
  email:    z.string().email('Invalid email address').max(254),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(128, 'Password too long'),
  kemPublicKey: z.string().max(4096).optional(),
  username: z.string().max(50).optional(),
});

const LoginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(128),
});

async function registerLegacyPasswordRoutes(app, authRateLimit) {
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
    const sanitizedUsername = sanitizeUsername(parsed.data.username);
    const accountData = { emailHmac: emailHash, emailEncrypted, passwordHash, kdfSalt };
    if (kemPublicKey) accountData.kemPublicKey = kemPublicKey;
    if (sanitizedUsername) accountData.username = sanitizedUsername;
    const account = await Account.create(accountData);

    const plan = isEnterpriseMode() ? 'enterprise' : 'free';
    const storageQuotaBytes = isEnterpriseMode() ? getQuotaBytes('enterprise') : 0;
    await Subscription.create({ accountId: account.id, plan, status: 'active', storageQuotaBytes, createdAt: new Date() });

    let orgId = null;
    let defaultWorkspace = null;
    if (plan !== 'free') {
      orgId = require('crypto').randomUUID();
      const orgName = account.username || email.split('@')[0];
      const slugBase = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
      const slug = `${slugBase}-${account.id.slice(0, 8)}`;

      await Organization.create({ id: orgId, nameEncrypted: '', slug, createdAt: new Date() });
      await OrgMember.create({ orgId, accountId: account.id, role: 'owner', createdAt: new Date() });
      await OrgSubscription.create({ id: require('crypto').randomUUID(), orgId, plan, status: 'active', seats: 1, storageQuotaBytes, createdAt: new Date() });

      defaultWorkspace = await Workspace.create({ nameEncrypted: '', ownerId: account.id, orgId, createdAt: new Date() });
      await WorkspaceMember.create({ workspaceId: defaultWorkspace.id, accountId: account.id, role: 'owner', createdAt: new Date() });

      // Initialize sync state for the new workspace so /sync/state doesn't 404
      await createEmptyState(defaultWorkspace.id);
    }

    const token = await createSession(account.id, req);

    app.log.info({ userId: account.id }, 'New account registered');
    sendWelcomeEmail(app, account.id);
    req.userId = account.id;
    audit(req, 'register', {});

    setSessionCookieIfAvailable(app, reply, token);
    const profileUsername = sanitizedUsername || null;
    return reply.status(201).send({
      token,
      user: {
        id:    account.id,
        username: profileUsername,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
        kemPublicKey: account.kemPublicKey || null,
      },
      profile: {
        id: account.id,
        username: profileUsername,
        emailHash: account.emailHmac,
      },
      organization: orgId ? {
        id: orgId,
        nameEncrypted: '',
        role: 'owner',
      } : null,
      workspace: defaultWorkspace ? {
        id: defaultWorkspace.id,
        nameEncrypted: '',
        role: 'owner',
      } : null,
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
}

module.exports = { registerLegacyPasswordRoutes };
