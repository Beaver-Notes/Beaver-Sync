'use strict';

const r2 = require('../services/r2');
const { CommitMeta, Subscription, Workspace, CompactionLock } = require('../models');
const mlkem = require('../lib/mlkem');
const { getQuotaBytes } = require('../lib/plans');
const { resolveEffectivePlan } = require('../lib/plan-resolution');

const COMPACT_LOCK_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_BODY_LIMIT_BYTES = parseInt(process.env.SNAPSHOT_BODY_LIMIT_BYTES ?? '10485760', 10);
const MAX_COMPACTED_COMMIT_IDS = parseInt(process.env.MAX_COMPACTED_COMMIT_IDS ?? '500', 10);
const COMMIT_ID_PATTERN = /^\d+-[a-zA-Z0-9_-]+-\d+$/;

async function snapshotRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite],
  };

  app.get('/', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.SNAPSHOT_READ_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const key  = r2.snapshotKey(req.userId);
    const blob = await r2.get(key);

    if (!blob) {
      return reply.send({ snapshot: null });
    }

    const plaintext = await mlkem.unwrapBlob(blob);
    reply.header('Content-Type', 'application/json');
    return reply.send(plaintext);
  });

  app.post('/', {
    ...protectWrite,
    bodyLimit: SNAPSHOT_BODY_LIMIT_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json', 'application/octet-stream'],
        maxContentLength: SNAPSHOT_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.SNAPSHOT_WRITE_RATE_LIMIT_PER_MINUTE ?? '10', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const userId = req.userId;
    let acquired = null;

    try {
      try {
        acquired = await CompactionLock.findOneAndUpdate(
          { _id: userId, expiresAt: { $lt: new Date() } },
          { $set: { lockedAt: new Date(), expiresAt: new Date(Date.now() + COMPACT_LOCK_TTL_MS) } },
          { upsert: true, new: true }
        );
      } catch (err) {
        if (!err || (err.message && err.message.includes('UNIQUE constraint'))) acquired = null;
        else throw err;
      }

      if (!acquired) {
        return reply.status(409).send({
          error: 'compaction_in_progress',
          message: 'Another device is currently compacting. Try again in a moment.',
        });
      }

      const body = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(
            typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body ?? '')
          );

      if (!body || body.length === 0) {
        return reply.status(400).send({
          error: 'empty_body',
          message: 'Snapshot body cannot be empty.',
        });
      }

      const compactedCommitIds = req.headers['x-compacted-commits']
        ? req.headers['x-compacted-commits'].split(',').filter(Boolean)
        : [];

      if (compactedCommitIds.length > MAX_COMPACTED_COMMIT_IDS) {
        return reply.status(400).send({
          error: 'too_many_compacted_commits',
          message: 'Too many compacted commit IDs supplied.',
        });
      }

      if (!compactedCommitIds.every((id) => COMMIT_ID_PATTERN.test(id))) {
        return reply.status(400).send({
          error: 'invalid_compacted_commit_id',
          message: 'Compacted commit IDs must use the standard commit ID format.',
        });
      }

      const existingSnapshot = await r2.stat(r2.snapshotKey(userId));
      const { plan: effectivePlan, seats, sub: subscription } = await resolveEffectivePlan(req);
      const workspaceId = req.headers['x-workspace-id'];

      if (workspaceId && typeof workspaceId === 'string' && ['team', 'enterprise'].includes(effectivePlan)) {
        const ws = await Workspace.findById(workspaceId, { storageUsedBytes: 1, orgId: 1 }).lean();
        if (!ws) {
          return reply.status(404).send({ error: 'not_found', message: 'Workspace not found.' });
        }
        if (effectivePlan === 'team') {
          const quotaBytes = getQuotaBytes('team', seats);
          const projectedUsage = ws.storageUsedBytes - (existingSnapshot?.sizeBytes ?? 0) + body.length;
          if (projectedUsage > quotaBytes) {
            return reply.status(507).send({
              error: 'storage_quota_exceeded',
              message: 'Snapshot would exceed workspace storage quota.',
              storageUsedBytes: ws.storageUsedBytes,
              storageQuotaBytes: quotaBytes,
            });
          }
        }
        req.workspaceId = workspaceId;
      } else if (effectivePlan !== 'enterprise') {
        const quotaBytes = getQuotaBytes(effectivePlan, seats);
        const projectedUsage =
          (subscription?.storageUsedBytes ?? 0) -
          (existingSnapshot?.sizeBytes ?? 0) +
          body.length;

        if (projectedUsage > quotaBytes) {
          return reply.status(507).send({
            error: 'storage_quota_exceeded',
            message: 'Snapshot would exceed your storage quota.',
            storageUsedBytes: subscription?.storageUsedBytes ?? 0,
            storageQuotaBytes: quotaBytes,
          });
        }
      }

      const key = r2.snapshotKey(userId);
      await r2.put(key, await mlkem.wrapBlob(body), 'application/json');

      if (compactedCommitIds.length > 0) {
        const compactedKeys = compactedCommitIds.map((id) => r2.commitKey(userId, id));
        await r2.delMany(compactedKeys).catch(() => null);

        const deletedMeta = await CommitMeta.find(
          { accountId: userId, commitId: { $in: compactedCommitIds } },
          { sizeBytes: 1 }
        ).lean();

        const freedBytes = deletedMeta.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
        const snapshotSize = body.length;
        const netChange = snapshotSize - freedBytes;

        if (req.workspaceId) {
          await Workspace.updateOne(
            { _id: req.workspaceId },
            { $inc: { storageUsedBytes: netChange } }
          );
        } else {
          await Subscription.updateOne(
            { accountId: userId },
            { $inc: { storageUsedBytes: netChange } }
          );
        }

        await CommitMeta.deleteMany({ accountId: userId, commitId: { $in: compactedCommitIds } });
      }

      return reply.status(201).send({
        status: 'snapshot_written',
        compactedCount: compactedCommitIds.length,
      });

    } finally {
      if (acquired) {
        await CompactionLock.deleteOne({ _id: userId });
      }
    }
  });
}

module.exports = snapshotRoutes;
