'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');

const { Account, Subscription, Device, Organization, OrgMember, OrgSubscription, Workspace } = require('../models');
const { deleteAccountData } = require('../repositories/account');
const mlkem = require('../lib/mlkem');
const r2 = require('../services/r2');
const { hashSessionId, hashRecoveryCode, hashVerificationToken } = require('../lib/crypto');
const { isEnterpriseMode } = require('../lib/license');
const { getQuotaBytes } = require('../lib/plans');
const { sendAccountDeletedEmail, sendVerifyEmail, sendPasswordChangedEmail } = require('../email');
const { DEVICE_ID_PATTERN } = require('../lib/patterns');
const { audit } = require('../lib/audit');

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

const ACCOUNT_DELETE_BODY_LIMIT_BYTES = parseInt(process.env.ACCOUNT_DELETE_BODY_LIMIT_BYTES ?? '8192', 10);
const EXPORT_URL_TTL = parseInt(process.env.EXPORT_URL_TTL_SECONDS ?? '604800', 10);

async function accountRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  app.get('/', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ACCOUNT_READ_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const [account, sub, devices, memberships] = await Promise.all([
      Account.findById(req.userId, { id: 1, username: 1, emailHmac: 1, emailSealed: 1, emailVerified: 1, createdAt: 1, kemPublicKey: 1, deviceKeys: 1 }).lean(),
      Subscription.findOne({ accountId: req.userId }).lean(),
      Device.find({ accountId: req.userId }).sort({ lastSeen: -1 }).lean(),
      OrgMember.find({ account_id: req.userId }).lean(),
    ]);
    let subscription = sub;

    if (!account) {
      return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    }

    const orgIds = memberships.map(m => m.orgId);
    let organizations = [];
    if (orgIds.length > 0) {
      const [orgs, orgSubs, allWorkspaces] = await Promise.all([
        Organization.find({ _id: { $in: orgIds } }).lean(),
        OrgSubscription.find({ orgId: { $in: orgIds } }).lean(),
        Workspace.find({ orgId: { $in: orgIds } }).lean(),
      ]);

      organizations = orgs.map(org => {
        const membership = memberships.find(m => m.orgId === org.id);
        const orgSub = orgSubs.find(s => s.orgId === org.id);
        const workspaces = allWorkspaces.filter(ws => ws.orgId === org.id);

        return {
          id: org.id,
          name: org.nameEncrypted,
          slug: org.slug,
          role: membership.role,
          subscription: orgSub ? {
            plan: orgSub.plan,
            status: orgSub.status,
            seats: orgSub.seats,
          } : null,
          workspaces: workspaces.map(ws => ({
            id: ws.id,
            name: ws.nameEncrypted,
            emoji: ws.emoji,
            color: ws.color,
          })),
        };
      });
    }

    if (isEnterpriseMode()) {
      if (!subscription) {
        subscription = { plan: 'enterprise', status: 'active', renewsAt: null, storageUsedBytes: 0, storageQuotaBytes: getQuotaBytes('enterprise') };
      } else {
        subscription.plan = 'enterprise';
        subscription.storageQuotaBytes = getQuotaBytes('enterprise');
      }
    }

    const usedBytes  = subscription?.storageUsedBytes  ?? 0;
    const quotaBytes = subscription?.storageQuotaBytes ?? 0;
    const usedPercent = quotaBytes > 0
      ? Math.round((usedBytes / quotaBytes) * 100)
      : 0;

    let email = null;
    if (account.emailSealed) {
      try {
        email = await mlkem.decryptMetadata(account.emailSealed);
      } catch (err) {
        app.log.warn({ err, userId: req.userId }, 'Failed to decrypt account email');
      }
    }

    return reply.send({
      user: {
        id:            account.id,
        username:      account.username ?? null,
        emailHash:     account.emailHmac,
        email,
        emailVerified: Boolean(account.emailVerified),
        createdAt:     account.createdAt,
        kemPublicKey:  account.kemPublicKey ?? null,
        deviceKeys:    Array.isArray(account.deviceKeys) ? account.deviceKeys : [],
      },
      organizations,
      subscription: subscription
        ? {
            plan:         subscription.plan,
            status:       subscription.status,
            renewsAt:     subscription.renewsAt,
            storage: {
              usedBytes,
              quotaBytes,
              usedPercent,
              usedMB:  (usedBytes  / 1_048_576).toFixed(1),
              quotaMB: (quotaBytes / 1_048_576).toFixed(0),
            },
          }
        : null,
      devices: devices.map(d => ({
        deviceId:  d.deviceId,
        label:     d.label,
        lastSeen:  d.lastSeen,
      })),
    });
  });

  app.patch('/username', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.USERNAME_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { username } = req.body ?? {};
    if (!username || typeof username !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'Username is required.' });
    }

    const normalized = username.trim().toLowerCase();
    if (!USERNAME_REGEX.test(normalized)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Username must be 3-32 alphanumeric characters, hyphens or underscores.' });
    }

    const existing = await Account.findOne({ username: normalized }).lean();
    if (existing && existing.id !== req.userId) {
      return reply.status(409).send({ error: 'username_taken', message: 'This username is already taken.' });
    }

    try {
      await Account.updateOne({ _id: req.userId }, { username: normalized });
    } catch (err) {
      if (err && (err.message.includes('UNIQUE constraint') || (err.code === 'SQLITE_CONSTRAINT_UNIQUE'))) {
        return reply.status(409).send({ error: 'username_taken', message: 'This username is already taken.' });
      }
      throw err;
    }
    app.log.info({ userId: req.userId, username: normalized }, 'Username set');

    return reply.send({ username: normalized });
  });

  app.delete('/devices/:deviceId', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.DEVICE_DELETE_RATE_LIMIT_PER_MINUTE ?? '20', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { deviceId } = req.params;

    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      return reply.status(400).send({
        error: 'invalid_device_id',
        message: 'Device ID format is invalid.',
      });
    }

    const result = await Device.deleteOne({
      accountId: req.userId,
      deviceId,
    });

    if (result.deletedCount === 0) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'Device not found on your Beaver Account.',
      });
    }

    return reply.send({ deleted: true, deviceId });
  });

  app.delete('/', {
    ...protect,
    bodyLimit: ACCOUNT_DELETE_BODY_LIMIT_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: ACCOUNT_DELETE_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.ACCOUNT_DELETE_RATE_LIMIT_PER_MINUTE ?? '5', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { password } = req.body ?? {};

    if (!password) {
      return reply.status(400).send({
        error: 'password_required',
        message: 'Please provide your password to confirm Beaver Account deletion.',
      });
    }

    const bcrypt = require('bcrypt');
    const account = await Account.findById(req.userId);

    if (!account) {
      return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    }

    if (!account.passwordHash) {
      return reply.status(400).send({
        error: 'password_not_available',
        message: 'Password deletion is unavailable for passkey-only accounts. Contact support to delete your account.',
      });
    }

    const match = await bcrypt.compare(password, account.passwordHash);
    if (!match) {
      return reply.status(401).send({
        error: 'invalid_credentials',
        message: 'Password incorrect.',
      });
    }

    // Fire-and-forget (matches sendWelcomeEmail convention): sendWithAlias resolves the
    // recipient from the account before deletion and swallows its own errors, so the
    // deletion below must not be gated on the (untimed) Resend HTTP call.
    sendAccountDeletedEmail(app, account.id);

    const accountIdHash = hashSessionId(req.userId);

    const { purgedWorkspaceIds } = await deleteAccountData({ userId: req.userId, accountIdHash });

    setImmediate(() => {
      (async () => {
        try {
          // yjs snapshots are namespaced by workspace, not account, so the workspace
          // ids captured before the cascade are the only way to find them. yjs-gc
          // enumerates workspaces from the DB and asset-gc only looks under /assets/,
          // so nothing else can reclaim these.
          const prefixes = [`${req.userId}/`, ...purgedWorkspaceIds.map((id) => `yjs/${id}/`)];
          const keys = [...new Set((await Promise.all(prefixes.map((p) => r2.listKeys(p)))).flat())];
          const CONCURRENT = 8;
          for (let i = 0; i < keys.length; i += CONCURRENT) {
            await Promise.allSettled(keys.slice(i, i + CONCURRENT).map((key) => r2.del(key)));
          }
          app.log.info(
            { userId: req.userId, deletedKeys: keys.length, workspaces: purgedWorkspaceIds.length },
            'R2 cleanup complete'
          );
        } catch (err) {
          app.log.error({ err, userId: req.userId }, 'R2 cleanup failed');
        }
      })();
    });

    return reply.send({ deleted: true, message: 'Beaver Account and all data deleted.' });
  });

  // 02.2: single high-entropy recovery code, HMAC-hashed, regenerate-invalidates-old
  app.post('/recovery-code', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.RECOVERY_CODE_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const code = crypto.randomBytes(32).toString('hex');
    const hash = hashRecoveryCode(code);
    const now = new Date();
    await Account.updateOne({ _id: req.userId }, { recoveryCodeHash: hash, recoveryCodeGeneratedAt: now });
    audit(req, 'recovery_code_generated', {});
    return reply.send({ recoveryCode: code, generatedAt: now.toISOString(), warning: 'Store this code securely. It will not be shown again. Regenerating invalidates the previous code. This restores ACCOUNT access only; E2E data needs vault passphrase.' });
  });

  // 02.3: email verification soft gate — request (authed, throttled) + confirm (unauth, single-use 24h)
  app.post('/verify-email/request', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.VERIFY_EMAIL_REQUEST_RATE_LIMIT_PER_MINUTE ?? '5', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const account = await Account.findById(req.userId, { emailVerified: 1, emailSealed: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    if (account.emailVerified) return reply.send({ sent: false, alreadyVerified: true });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashVerificationToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Account.updateOne({ _id: req.userId }, { verificationTokenHash: tokenHash, verificationExpiresAt: expiresAt });
    let email = null;
    if (account.emailSealed) {
      try { email = await mlkem.decryptMetadata(account.emailSealed); } catch {}
    }
    const baseUrl = process.env.VERIFY_EMAIL_URL_BASE || process.env.FRONTEND_URL || 'beaver-notes://verify-email';
    const verifyUrl = baseUrl.includes('?') ? `${baseUrl}&token=${rawToken}` : `${baseUrl}?token=${rawToken}`;
    // also support path-based deep link if baseUrl is beaver-notes://verify-email
    // the query-param form works for both web and deep-link handlers
    sendVerifyEmail(app, req.userId, { verifyUrl, token: rawToken, email: email || '', expiresIn: '24 hours' });
    audit(req, 'verification_email_requested', {});
    return reply.send({ sent: true, expiresAt: expiresAt.toISOString() });
  });

  app.post('/verify-email/confirm', {
    config: {
      security: { public: true },
      rateLimit: {
        max: parseInt(process.env.VERIFY_EMAIL_CONFIRM_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { token } = req.body ?? {};
    if (!token || typeof token !== 'string' || token.trim().length < 16) {
      return reply.status(400).send({ error: 'validation_error', message: 'Verification token is required.' });
    }
    const raw = token.trim();
    const tokenHash = hashVerificationToken(raw);
    const account = await Account.findOne({ verificationTokenHash: tokenHash }).lean();
    if (!account) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid or expired verification token.' });
    }
    const expiresAt = account.verificationExpiresAt ? new Date(account.verificationExpiresAt) : null;
    if (!expiresAt || expiresAt < new Date()) {
      await Account.updateOne({ _id: account.id }, { verificationTokenHash: null, verificationExpiresAt: null });
      return reply.status(410).send({ error: 'token_expired', message: 'Verification token has expired.' });
    }
    await Account.updateOne({ _id: account.id }, { emailVerified: true, verificationTokenHash: null, verificationExpiresAt: null });
    req.userId = account.id;
    audit(req, 'email_verified', {});
    return reply.send({ verified: true });
  });

  // 02.4: change password — verifies current, rotates, revokes others, sends notification
  app.patch('/password', {
    ...protect,
    config: {
      rateLimit: { max: parseInt(process.env.PASSWORD_CHANGE_RATE_LIMIT_PER_MINUTE ?? '5', 10), timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    if (process.env.LEGACY_AUTH_ENABLED === 'false') {
      return reply.status(410).send({ error: 'legacy_auth_disabled', message: 'Password authentication has been replaced by passkeys.' });
    }
    const { currentPassword, newPassword, current_password, new_password } = req.body ?? {};
    const cur = typeof currentPassword === 'string' ? currentPassword : (typeof current_password === 'string' ? current_password : '');
    const nxt = typeof newPassword === 'string' ? newPassword : (typeof new_password === 'string' ? new_password : '');
    if (!cur || !nxt) {
      return reply.status(400).send({ error: 'validation_error', message: 'Current and new passwords are required.' });
    }
    if (nxt.length < 12) return reply.status(400).send({ error: 'validation_error', message: 'Password must be at least 12 characters.' });
    if (nxt.length > 128) return reply.status(400).send({ error: 'validation_error', message: 'Password too long.' });
    const account = await Account.findById(req.userId);
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    if (!account.passwordHash) return reply.status(400).send({ error: 'password_not_available', message: 'No password set on this account.' });
    const bcrypt = require('bcrypt');
    const ok = await bcrypt.compare(cur, account.passwordHash);
    if (!ok) return reply.status(401).send({ error: 'invalid_credentials', message: 'Current password is incorrect.' });
    const newHash = await bcrypt.hash(nxt, 12);
    await Account.updateOne({ _id: req.userId }, { passwordHash: newHash });
    // revoke other sessions, keep current
    const { Session } = require('../models');
    const { hashSessionId } = require('../lib/crypto');
    let keepHash = null;
    const authHeader = req.headers['authorization'];
    const rawId = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.cookies?.bsession || null);
    if (rawId) keepHash = hashSessionId(rawId);
    const filter = { accountId: req.userId, revoked: false };
    if (keepHash) filter.idHash = { $ne: keepHash };
    await Session.updateMany(filter, { revoked: true });
    const deviceInfo = String(req.headers['x-device-label'] ?? req.headers['user-agent'] ?? 'Unknown device').slice(0, 128);
    sendPasswordChangedEmail(app, req.userId, { timestamp: new Date().toISOString(), deviceInfo });
    audit(req, 'password_changed', {});
    return reply.send({ message: 'Password changed.' });
  });

  // 02.5: TOTP 2FA (password accounts only) — setup/verify-before-persist/disable
  app.post('/totp/setup', {
    ...protect,
    config: { rateLimit: { max: parseInt(process.env.TOTP_RATE_LIMIT_PER_MINUTE ?? '10', 10), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const account = await Account.findById(req.userId, { passwordHash: 1, totpSecretSealed: 1, emailSealed: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    if (!account.passwordHash) return reply.status(400).send({ error: 'totp_not_available', message: 'TOTP is only available for password accounts.' });
    if (account.totpSecretSealed) return reply.status(409).send({ error: 'totp_already_enabled', message: 'TOTP is already enabled. Disable it first.' });
    const { generateSecret, buildOtpauthUrl } = require('../lib/totp');
    const secret = generateSecret(20);
    const encryptedPending = await mlkem.encryptMetadata(secret);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await Account.updateOne({ _id: req.userId }, { totpPendingSecretSealed: encryptedPending, totpPendingExpiresAt: expiresAt });
    let email = '';
    if (account.emailSealed) { try { email = await mlkem.decryptMetadata(account.emailSealed); } catch {} }
    const label = email || req.userId;
    const otpauthUrl = buildOtpauthUrl(secret, label, 'Beaver Notes');
    audit(req, 'totp_setup_initiated', {});
    return reply.send({ secret, otpauthUrl, expiresAt: expiresAt.toISOString() });
  });

  app.post('/totp/verify', {
    ...protect,
    config: { rateLimit: { max: parseInt(process.env.TOTP_RATE_LIMIT_PER_MINUTE ?? '10', 10), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { code } = req.body ?? {};
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return reply.status(400).send({ error: 'validation_error', message: 'A 6-digit code is required.' });
    }
    const account = await Account.findById(req.userId, { totpSecretSealed: 1, totpPendingSecretSealed: 1, totpPendingExpiresAt: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    if (account.totpSecretSealed) return reply.status(409).send({ error: 'totp_already_enabled', message: 'TOTP already enabled.' });
    if (!account.totpPendingSecretSealed) return reply.status(400).send({ error: 'no_pending_setup', message: 'No pending TOTP setup. Call /account/totp/setup first.' });
    const exp = account.totpPendingExpiresAt ? new Date(account.totpPendingExpiresAt) : null;
    if (!exp || exp < new Date()) {
      await Account.updateOne({ _id: req.userId }, { totpPendingSecretSealed: null, totpPendingExpiresAt: null });
      return reply.status(410).send({ error: 'totp_setup_expired', message: 'TOTP setup has expired. Start again.' });
    }
    let secret;
    try { secret = await mlkem.decryptMetadata(account.totpPendingSecretSealed); } catch { return reply.status(500).send({ error: 'decrypt_failed', message: 'Failed to decrypt pending secret.' }); }
    const { totpVerify } = require('../lib/totp');
    const timestep = totpVerify(secret, code.trim(), 1);
    if (timestep === null) return reply.status(401).send({ error: 'invalid_code', message: 'Invalid TOTP code.' });
    // verify-before-persist: move pending → active
    await Account.updateOne({ _id: req.userId }, { totpSecretSealed: account.totpPendingSecretSealed, totpLastTimestep: timestep, totpPendingSecretSealed: null, totpPendingExpiresAt: null });
    audit(req, 'totp_enabled', {});
    return reply.send({ verified: true, enabled: true });
  });

  app.post('/totp/disable', {
    ...protect,
    config: { rateLimit: { max: parseInt(process.env.TOTP_RATE_LIMIT_PER_MINUTE ?? '10', 10), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { code, recoveryCode, password } = req.body ?? {};
    const account = await Account.findById(req.userId);
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    if (!account.totpSecretSealed) return reply.status(400).send({ error: 'totp_not_enabled', message: 'TOTP is not enabled.' });
    let ok = false;
    if (typeof code === 'string' && /^\d{6}$/.test(code.trim())) {
      try {
        const secret = await mlkem.decryptMetadata(account.totpSecretSealed);
        const { totpVerify } = require('../lib/totp');
        const ts = totpVerify(secret, code.trim(), 1);
        if (ts !== null && Number(ts) !== Number(account.totpLastTimestep)) ok = true;
      } catch {}
    }
    if (!ok && typeof recoveryCode === 'string' && recoveryCode.length >= 16) {
      try {
        const { hashRecoveryCode } = require('../lib/crypto');
        const h = hashRecoveryCode(recoveryCode);
        const stored = account.recoveryCodeHash;
        if (stored) {
          const a = Buffer.from(stored, 'hex');
          const b = Buffer.from(h, 'hex');
          if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
        }
      } catch {}
    }
    if (!ok && typeof password === 'string' && password.length >= 8) {
      if (account.passwordHash) {
        const bcrypt = require('bcrypt');
        ok = await bcrypt.compare(password, account.passwordHash);
      }
    }
    if (!ok) return reply.status(401).send({ error: 'invalid_credentials', message: 'Valid code, recovery code, or password required to disable TOTP.' });
    await Account.updateOne({ _id: req.userId }, { totpSecretSealed: null, totpLastTimestep: null, totpPendingSecretSealed: null, totpPendingExpiresAt: null });
    audit(req, 'totp_disabled', {});
    return reply.send({ disabled: true });
  });

  app.get('/totp/status', {
    ...protect,
    config: { rateLimit: { max: parseInt(process.env.TOTP_RATE_LIMIT_PER_MINUTE ?? '30', 10), timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const account = await Account.findById(req.userId, { totpSecretSealed: 1, totpPendingSecretSealed: 1, totpPendingExpiresAt: 1 }).lean();
    if (!account) return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    const enabled = Boolean(account.totpSecretSealed);
    let pending = false;
    if (account.totpPendingSecretSealed) {
      const exp = account.totpPendingExpiresAt ? new Date(account.totpPendingExpiresAt) : null;
      pending = exp ? exp > new Date() : true;
    }
    return reply.send({ enabled, pending });
  });

  app.get('/export', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.EXPORT_RATE_LIMIT_PER_MINUTE ?? '5', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const keys = await r2.listKeys(`${req.userId}/`);
    const exportKeys = keys.filter((k) => !k.startsWith(`${req.userId}/export-`));

    const MAX_EXPORT_OBJECTS = parseInt(process.env.EXPORT_MAX_OBJECTS ?? '10000', 10);
    if (exportKeys.length > MAX_EXPORT_OBJECTS) {
      return reply.status(413).send({
        error: 'export_too_large',
        message: 'Your account contains too many objects for a single export. Contact support for a chunked export.',
        objectCount: exportKeys.length,
        maxObjects: MAX_EXPORT_OBJECTS,
      });
    }

    const exportId = crypto.randomUUID();
    const ek = r2.exportKey(req.userId, exportId);
    const tmpPath = path.join(os.tmpdir(), `beaver-export-${exportId}.zip`);
    let sizeBytes;
    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        const archive = typeof archiver === 'function' ? archiver('zip', { zlib: { level: 0 } }) : new archiver.ZipArchive({ zlib: { level: 0 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        (async () => {
          try {
            const CONCURRENT = 8;
            for (let i = 0; i < exportKeys.length; i += CONCURRENT) {
              const chunk = exportKeys.slice(i, i + CONCURRENT);
              const datas = await Promise.all(chunk.map((key) => r2.get(key).catch(() => null)));
              for (let j = 0; j < chunk.length; j++) {
                if (datas[j]) {
                  archive.append(datas[j], { name: chunk[j].slice(req.userId.length + 1) });
                }
              }
            }
          } catch (err) {
            archive.emit('error', err);
            return;
          }
          archive.finalize();
        })().catch((err) => archive.emit('error', err));
      });

      const stat = await fs.promises.stat(tmpPath);
      sizeBytes = stat.size;
      await r2.put(ek, fs.createReadStream(tmpPath), 'application/zip');
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }

    const url = await r2.presignGet(ek, EXPORT_URL_TTL);

    return reply.send({
      url,
      expiresInSeconds: EXPORT_URL_TTL,
      objectCount: exportKeys.length,
      sizeBytes,
      note: 'This export URL will expire and the archive will be deleted automatically.',
    });
  });
}

module.exports = accountRoutes;
