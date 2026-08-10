'use strict';

const crypto = require('crypto');
const archiver = require('archiver');

const { Account, Subscription, Device, Organization, OrgMember, OrgSubscription, Workspace } = require('../models');
const { getDb } = require('../db');
const mlkem = require('../lib/mlkem');
const r2 = require('../services/r2');
const { hashAccountId } = require('../lib/crypto');
const { isEnterpriseMode } = require('../lib/license');
const { getQuotaBytes } = require('../lib/plans');
const { sendAccountDeletedEmail } = require('../email');

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

const ACCOUNT_DELETE_BODY_LIMIT_BYTES = parseInt(process.env.ACCOUNT_DELETE_BODY_LIMIT_BYTES ?? '8192', 10);
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
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
    const [account, subscription, devices, memberships] = await Promise.all([
      Account.findById(req.userId, { username: 1, emailHmac: 1, emailEncrypted: 1, createdAt: 1 }).lean(),
      Subscription.findOne({ accountId: req.userId }).lean(),
      Device.find({ accountId: req.userId }).sort({ lastSeen: -1 }).lean(),
      OrgMember.find({ account_id: req.userId }).lean(),
    ]);

    if (!account) {
      return reply.status(404).send({ error: 'not_found', message: 'Beaver Account not found.' });
    }

    // Get orgs with subscriptions and workspaces
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
    if (account.emailEncrypted) {
      try {
        email = await mlkem.decryptMetadata(account.emailEncrypted);
      } catch { }
    }

    return reply.send({
      user: {
        id:        account.id,
        username:  account.username ?? null,
        emailHash: account.emailHmac,
        email,
        createdAt: account.createdAt,
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

    const accountIdHash = hashAccountId(req.userId);

    const db = getDb();
    const deleteTx = db.transaction(() => {
      db.prepare(`DELETE FROM audit_logs WHERE account_id_hash = ?`).run(accountIdHash);

      // Remove org memberships
      db.prepare(`DELETE FROM org_members WHERE account_id = ?`).run(req.userId);

      // Remove org subscriptions for orgs owned by this account
      db.prepare(`DELETE FROM org_subscriptions WHERE org_id IN (
        SELECT org_id FROM org_members WHERE account_id = ? AND role = 'owner'
      )`).run(req.userId);

      // Remove workspaces for orgs owned by this account
      db.prepare(`DELETE FROM workspaces WHERE org_id IN (
        SELECT org_id FROM org_members WHERE account_id = ? AND role = 'owner'
      )`).run(req.userId);

      // Remove organizations owned by this account
      db.prepare(`DELETE FROM organizations WHERE id IN (
        SELECT org_id FROM org_members WHERE account_id = ? AND role = 'owner'
      )`).run(req.userId);

      // Remove the account itself
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(req.userId);
    });
    deleteTx();

    setImmediate(() => {
      (async () => {
        try {
          const keys = await r2.listKeys(`${req.userId}/`);
          const CONCURRENT = 8;
          for (let i = 0; i < keys.length; i += CONCURRENT) {
            await Promise.allSettled(keys.slice(i, i + CONCURRENT).map((key) => r2.del(key)));
          }
          app.log.info({ userId: req.userId, deletedKeys: keys.length }, 'R2 cleanup complete');
        } catch (err) {
          app.log.error({ err, userId: req.userId }, 'R2 cleanup failed');
        }
      })();
    });

    return reply.send({ deleted: true, message: 'Beaver Account and all data deleted.' });
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

    const zipBuf = await new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 0 } });
      const chunks = [];

      archive.on('data', (c) => { chunks.push(c); });
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err) => reject(err));

      (async () => {
        for (const key of exportKeys) {
          const data = await r2.get(key).catch(() => null);
          if (data) {
            archive.append(data, { name: key.slice(req.userId.length + 1) });
          }
        }
        archive.finalize();
      })();
    });

    const exportId = crypto.randomUUID();
    const ek = r2.exportKey(req.userId, exportId);
    await r2.put(ek, zipBuf, 'application/zip');

    const url = await r2.presignGet(ek, EXPORT_URL_TTL);

    return reply.send({
      url,
      expiresInSeconds: EXPORT_URL_TTL,
      objectCount: exportKeys.length,
      sizeBytes: zipBuf.length,
      note: 'This export URL will expire and the archive will be deleted automatically.',
    });
  });
}

module.exports = accountRoutes;
