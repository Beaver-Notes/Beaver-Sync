'use strict';

const bcrypt = require('bcrypt');
const { z }  = require('zod');
const { Account, Subscription, Workspace, WorkspaceMember, Organization, OrgMember, OrgSubscription } = require('../models');
const { createEmptyState } = require('../repositories/syncWorkspaceState');
const { createSession, createRefreshToken, setSessionCookieIfAvailable } = require('../middleware/auth');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { createEmailHash, hashPasswordResetToken } = require('../lib/crypto');
const mlkem = require('../lib/mlkem');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../email');
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
  // eslint-disable-next-line no-control-regex
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
    const emailSealed = await mlkem.encryptMetadata(email);

    const kemPublicKey = parsed.data.kemPublicKey;
    if (kemPublicKey && !validatePublicKey(kemPublicKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid kemPublicKey.' });
    }
    const sanitizedUsername = sanitizeUsername(parsed.data.username);
    const accountData = { emailHmac: emailHash, emailSealed, passwordHash, kdfSalt };
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
    const refreshToken = await createRefreshToken(account.id, token, req);
    const profileUsername = sanitizedUsername || null;
    return reply.status(201).send({
      token,
      refreshToken,
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

    // 02.5: TOTP MFA branch — if TOTP enabled, return single-use ticket instead of session
    if (account.totpSecretSealed) {
      const { hashSessionId } = require('../lib/crypto');
      const { getDb } = require('../db');
      const ticket = require('crypto').randomBytes(32).toString('base64url');
      const ttlSeconds = parseInt(process.env.MFA_CHALLENGE_TTL_SECONDS ?? '300', 10);
      try { await getDb().query('DELETE FROM mfa_challenges WHERE expires_at < NOW()'); } catch {}
      await getDb().query(
        'INSERT INTO mfa_challenges (id_hash, account_id, expires_at) VALUES ($1,$2,NOW() + make_interval(secs => $3))',
        [hashSessionId(ticket), account.id, ttlSeconds]
      );
      audit({ ...req, userId: account.id }, 'login_mfa_required', {});
      return reply.send({ mfaRequired: true, mfaChallenge: ticket, challenge: ticket });
    }

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
    // Opaque refresh credential: the session expires, this lets the client come
    // back silently instead of telling the user to sign in again.
    const refreshToken = await createRefreshToken(account.id, token, req);
    return reply.send({
      token,
      refreshToken,
      user: {
        id:    account.id,
        emailHash: account.emailHmac,
        kdfSalt: account.kdfSalt,
        kemPublicKey: account.kemPublicKey || null,
      },
      subscription: subscription ?? null,
    });
  });

  // 02.5: POST /auth/token/mfa — verifies timestep with replay protection, recovery code path via 02.2
  app.post('/token/mfa', {
    config: {
      security: { public: true, allowedContentTypes: ['application/json'] },
      rateLimit: { max: parseInt(process.env.MFA_RATE_LIMIT_PER_MINUTE ?? '10', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED !== 'true') {
      return reply.status(410).send({ error: 'legacy_auth_disabled', message: 'Password authentication has been replaced by passkeys.' });
    }
    const { challenge, mfaChallenge, code, recoveryCode } = req.body ?? {};
    const ticket = typeof challenge === 'string' ? challenge : (typeof mfaChallenge === 'string' ? mfaChallenge : '');
    if (!ticket || ticket.length < 16) {
      return reply.status(400).send({ error: 'validation_error', message: 'MFA challenge is required.' });
    }
    const hasCode = typeof code === 'string' && code.trim().length > 0;
    const hasRecovery = typeof recoveryCode === 'string' && recoveryCode.trim().length > 0;
    if (!hasCode && !hasRecovery) {
      return reply.status(400).send({ error: 'validation_error', message: 'Code or recoveryCode is required.' });
    }
    const { hashSessionId, hashRecoveryCode } = require('../lib/crypto');
    const { getDb } = require('../db');
    const idHash = hashSessionId(ticket);
    const consumed = await getDb().query(
      'DELETE FROM mfa_challenges WHERE id_hash = $1 AND expires_at > NOW() RETURNING account_id',
      [idHash]
    );
    if (consumed.rows.length === 0) {
      return reply.status(401).send({ error: 'invalid_challenge', message: 'MFA challenge is invalid, used, or expired.' });
    }
    const accountId = consumed.rows[0].account_id;
    const account = await Account.findById(accountId);
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });

    // recovery code path
    if (hasRecovery) {
      const raw = recoveryCode.trim();
      const h = hashRecoveryCode(raw);
      const stored = account.recoveryCodeHash;
      let valid = false;
      if (stored) {
        try {
          const a = Buffer.from(stored, 'hex');
          const b = Buffer.from(h, 'hex');
          valid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
        } catch { valid = false; }
      } else {
        try { const d = hashRecoveryCode('dummy-recovery-not-found-0000000000000000'); require('crypto').timingSafeEqual(Buffer.from(d,'hex'), Buffer.from(h,'hex')); } catch {}
      }
      if (!valid) {
        // re-insert challenge? no, single-use consumed — need new login
        app.recordSecurityEvent(req, 'mfa_recovery_failure', { userId: account.id });
        return reply.status(401).send({ error: 'invalid_recovery_code', message: 'Invalid recovery code.' });
      }
      // consumed-on-use per 02.2 semantics
      await Account.updateOne({ _id: account.id }, { recoveryCodeHash: null, recoveryCodeGeneratedAt: null });
      const token = await createSession(account.id, req);
      req.userId = account.id;
      audit(req, 'login_mfa_recovery', {});
      let subscription = await Subscription.findOne({ accountId: account.id }, { plan: 1, status: 1, renewsAt: 1, storageUsedBytes: 1, storageQuotaBytes: 1 }).lean();
      if (isEnterpriseMode()) {
        if (!subscription) subscription = { plan: 'enterprise', status: 'active', renewsAt: null, storageUsedBytes: 0, storageQuotaBytes: getQuotaBytes('enterprise') };
        else { subscription.plan = 'enterprise'; subscription.storageQuotaBytes = getQuotaBytes('enterprise'); }
      }
      setSessionCookieIfAvailable(app, reply, token);
      const refreshToken = await createRefreshToken(account.id, token, req);
      return reply.send({ token, refreshToken, user: { id: account.id, emailHash: account.emailHmac, kdfSalt: account.kdfSalt, kemPublicKey: account.kemPublicKey || null }, subscription: subscription ?? null });
    }

    // TOTP path
    const rawCode = String(code).trim();
    if (!/^\d{6}$/.test(rawCode)) {
      return reply.status(401).send({ error: 'invalid_code', message: 'Invalid TOTP code.' });
    }
    if (!account.totpSecretSealed) {
      return reply.status(400).send({ error: 'totp_not_enabled', message: 'TOTP is not enabled on this account.' });
    }
    let secret;
    try { secret = await require('../lib/mlkem').decryptMetadata(account.totpSecretSealed); } catch { return reply.status(500).send({ error: 'decrypt_failed', message: 'Failed to decrypt TOTP secret.' }); }
    const { totpVerify } = require('../lib/totp');
    const timestep = totpVerify(secret, rawCode, 1);
    if (timestep === null) {
      app.recordSecurityEvent(req, 'mfa_totp_failure', { userId: account.id });
      return reply.status(401).send({ error: 'invalid_code', message: 'Invalid TOTP code.' });
    }
    // replay protection
    if (account.totpLastTimestep != null && Number(account.totpLastTimestep) === Number(timestep)) {
      return reply.status(401).send({ error: 'code_reused', message: 'Code has already been used. Wait for the next code.' });
    }
    await Account.updateOne({ _id: account.id }, { totpLastTimestep: timestep });
    const token = await createSession(account.id, req);
    req.userId = account.id;
    audit(req, 'login_mfa_totp', {});
    let subscription = await Subscription.findOne({ accountId: account.id }, { plan: 1, status: 1, renewsAt: 1, storageUsedBytes: 1, storageQuotaBytes: 1 }).lean();
    if (isEnterpriseMode()) {
      if (!subscription) subscription = { plan: 'enterprise', status: 'active', renewsAt: null, storageUsedBytes: 0, storageQuotaBytes: getQuotaBytes('enterprise') };
      else { subscription.plan = 'enterprise'; subscription.storageQuotaBytes = getQuotaBytes('enterprise'); }
    }
    setSessionCookieIfAvailable(app, reply, token);
    const refreshToken = await createRefreshToken(account.id, token, req);
    return reply.send({ token, refreshToken, user: { id: account.id, emailHash: account.emailHmac, kdfSalt: account.kdfSalt, kemPublicKey: account.kemPublicKey || null }, subscription: subscription ?? null });
  });

  // 02.4: password reset — respects LEGACY_AUTH_ENABLED 410 gating
  // POST /auth/password/reset-request always 200 decoy
  app.post('/password/reset-request', {
    config: {
      security: { public: true, allowedContentTypes: ['application/json'] },
      rateLimit: { max: parseInt(process.env.PASSWORD_RESET_REQUEST_RATE_LIMIT_PER_MINUTE ?? '5', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED !== 'true') {
      return reply.status(410).send({ error: 'legacy_auth_disabled', message: 'Password authentication has been replaced by passkeys.' });
    }
    const { email } = req.body ?? {};
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const decoyMessage = 'If an account exists for that email, you will receive a password reset link. Check your inbox (and spam folder).';
    if (!normalized || !normalized.includes('@')) {
      return reply.send({ message: decoyMessage });
    }
    const emailHash = createEmailHash(normalized);
    const account = await Account.findOne({ emailHmac: emailHash }).lean();
    if (account) {
      const rawToken = require('crypto').randomBytes(32).toString('hex');
      const tokenHash = hashPasswordResetToken(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await Account.updateOne({ _id: account.id }, { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt });
      const baseUrl = process.env.PASSWORD_RESET_URL_BASE || process.env.FRONTEND_URL || 'beaver-notes://reset-password';
      const resetUrl = baseUrl.includes('?') ? `${baseUrl}&token=${rawToken}` : `${baseUrl}?token=${rawToken}`;
      sendPasswordResetEmail(app, account.id, { resetUrl, token: rawToken, expiresIn: '1 hour' });
      audit({ ...req, userId: account.id }, 'password_reset_requested', {});
    } else {
      // timing-safe dummy hash to avoid enumeration timing leak
      try { hashPasswordResetToken('dummy-not-found-' + normalized); } catch {}
    }
    return reply.send({ message: decoyMessage });
  });

  // POST /auth/password/reset-complete — validates, revokes all sessions, clears lockout
  app.post('/password/reset-complete', {
    config: {
      security: { public: true, allowedContentTypes: ['application/json'] },
      rateLimit: { max: parseInt(process.env.PASSWORD_RESET_COMPLETE_RATE_LIMIT_PER_MINUTE ?? '5', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED !== 'true') {
      return reply.status(410).send({ error: 'legacy_auth_disabled', message: 'Password authentication has been replaced by passkeys.' });
    }
    const { token, password, newPassword } = req.body ?? {};
    const raw = typeof token === 'string' ? token.trim() : '';
    const nextPw = typeof newPassword === 'string' ? newPassword : (typeof password === 'string' ? password : '');
    if (!raw || raw.length < 16) {
      return reply.status(400).send({ error: 'validation_error', message: 'Reset token is required.' });
    }
    if (!nextPw || nextPw.length < 12) {
      return reply.status(400).send({ error: 'validation_error', message: 'Password must be at least 12 characters.' });
    }
    if (nextPw.length > 128) {
      return reply.status(400).send({ error: 'validation_error', message: 'Password too long.' });
    }
    const tokenHash = hashPasswordResetToken(raw);
    const account = await Account.findOne({ passwordResetTokenHash: tokenHash }).lean();
    if (!account) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid or expired reset token.' });
    }
    const expiresAt = account.passwordResetExpiresAt ? new Date(account.passwordResetExpiresAt) : null;
    if (!expiresAt || expiresAt < new Date()) {
      await Account.updateOne({ _id: account.id, passwordResetTokenHash: tokenHash }, { $set: { passwordResetTokenHash: null, passwordResetExpiresAt: null } });
      return reply.status(410).send({ error: 'token_expired', message: 'Reset token has expired.' });
    }
    const claimed = await Account.updateOne({ _id: account.id, passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { $gte: new Date() } }, { $set: { passwordResetTokenHash: null, passwordResetExpiresAt: null } });
    if (claimed.modifiedCount === 0) return reply.status(400).send({ error: 'invalid_token', message: 'Invalid or expired reset token.' });
    const newHash = await bcrypt.hash(nextPw, BCRYPT_ROUNDS);
    await Account.updateOne({ _id: account.id }, { $set: { passwordHash: newHash, failedLoginAttempts: 0, lockedUntil: null } });
    const { Session } = require('../models');
    await Session.updateMany({ accountId: account.id }, { revoked: true });
    try { const { getDb } = require('../db'); await getDb().query('DELETE FROM ws_tickets WHERE account_id = $1', [account.id]); } catch {}
    req.userId = account.id;
    audit(req, 'password_reset_complete', {});
    return reply.send({ message: 'Password has been reset. You can now sign in.' });
  });
}

module.exports = { registerLegacyPasswordRoutes };
