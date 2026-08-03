'use strict';

const fp = require('fastify-plugin');
const { Subscription, Workspace, WorkspaceMember } = require('../models');
const { isFreePlan } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');

const TEAM_WORKSPACE_QUOTA = 50 * 1024 * 1024 * 1024;

async function subscriptionPlugin(app) {
  app.decorate('requireActiveSync', async function (req, reply) {
    if (isEnterpriseMode()) return;

    let sub = await Subscription.findOne({ accountId: req.userId }).lean();

    if (!sub) {
      await Subscription.create({
        accountId: req.userId,
        plan: 'free',
        status: 'active',
        storageQuotaBytes: 0,
        createdAt: new Date(),
      });
      sub = await Subscription.findOne({ accountId: req.userId }).lean();
    }

    if (sub.status === 'expired') {
      return reply.status(402).send({
        error: 'sync_inactive',
        message: 'Your subscription has expired. Renew to continue syncing.',
        upgradeUrl: 'https://beaver.app/sync',
      });
    }

    req.subscription = sub;
  });

  app.decorate('requirePaidWrite', async function (req, reply) {
    if (isEnterpriseMode()) return;

    const sub = req.subscription;
    if (!sub || isFreePlan(sub.plan)) {
      return reply.status(402).send({
        error: 'plan_upgrade_required',
        message: 'Cloud sync requires a paid plan. Upgrade to start syncing.',
        upgradeUrl: 'https://beaver.app/sync',
      });
    }
  });

  app.decorate('checkStorageQuota', async function (req, reply) {
    if (isEnterpriseMode()) return;

    const sub = req.subscription;
    if (!sub) return;

    const incomingBytes =
      req.body?.sizeBytes ??
      parseInt(req.headers['content-length'] ?? '0', 10);

    const workspaceId = req.headers['x-workspace-id'];
    if (workspaceId && typeof workspaceId === 'string' && (sub.plan === 'team' || sub.plan === 'enterprise')) {
      const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
      if (!membership) {
        return reply.status(403).send({ error: 'forbidden', message: 'Not a member of this workspace.' });
      }

      const allowedWriteRoles = new Set(['owner', 'editor']);
      if (!allowedWriteRoles.has(membership.role)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Write access requires owner or editor role in this workspace.' });
      }

      const ws = await Workspace.findById(workspaceId, { storageUsedBytes: 1 }).lean();
      if (!ws) {
        return reply.status(404).send({ error: 'not_found', message: 'Workspace not found.' });
      }

      if (sub.plan === 'enterprise') {
        req.workspaceId = workspaceId;
        return;
      }

      const projectedUsage = ws.storageUsedBytes + incomingBytes;
      if (projectedUsage > TEAM_WORKSPACE_QUOTA) {
        const usedMB = (ws.storageUsedBytes / 1_048_576).toFixed(1);
        return reply.status(507).send({
          error: 'storage_quota_exceeded',
          message: `Workspace storage full: ${usedMB} MB used of 51200 MB.`,
          storageUsedBytes: ws.storageUsedBytes,
          storageQuotaBytes: TEAM_WORKSPACE_QUOTA,
          upgradeUrl: 'https://beaver.app/sync',
        });
      }

      req.workspaceId = workspaceId;
      return;
    }

    if (sub.plan === 'enterprise') return;

    const quotaBytes = sub.storageQuotaBytes;
    if (quotaBytes <= 0) return;

    const projectedUsage = sub.storageUsedBytes + incomingBytes;
    if (projectedUsage > quotaBytes) {
      const usedMB  = (sub.storageUsedBytes / 1_048_576).toFixed(1);
      const quotaMB = (quotaBytes / 1_048_576).toFixed(0);

      return reply.status(507).send({
        error: 'storage_quota_exceeded',
        message: `Storage full: ${usedMB} MB used of ${quotaMB} MB.`,
        storageUsedBytes: sub.storageUsedBytes,
        storageQuotaBytes: quotaBytes,
        upgradeUrl: 'https://beaver.app/sync',
      });
    }
  });

  app.decorate('checkDeviceLimit', async function (req, reply) {
    if (isEnterpriseMode()) return;

    const sub = req.subscription;
    if (!sub) return;

    const DEVICE_LIMITS = { basic: 5 };
    const MAX_DEVICES = DEVICE_LIMITS[sub.plan];
    if (MAX_DEVICES === undefined) return;

    const { Device } = require('../models');
    const deviceId = req.headers['x-device-id'];

    if (!deviceId) {
      return reply.status(400).send({
        error: 'missing_device_id',
        message: 'X-Device-Id header is required.',
      });
    }

    const existingDevice = await Device.findOne({
      accountId: req.userId,
      deviceId,
    }).lean();

    if (!existingDevice) {
      const deviceCount = await Device.countDocuments({ accountId: req.userId });
      if (deviceCount >= MAX_DEVICES) {
        return reply.status(403).send({
          error: 'device_limit_reached',
          message: 'Your plan supports up to 5 devices. Remove a device or upgrade.',
          upgradeUrl: 'https://beaver.app/sync',
        });
      }
    }
  });
}

module.exports = fp(subscriptionPlugin);
