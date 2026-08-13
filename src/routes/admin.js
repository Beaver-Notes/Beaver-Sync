'use strict';

const { Workspace, WorkspaceMember, Device, Session, AuditLog } = require('../models');
const mlkem = require('../lib/mlkem');
const { isEnterpriseMode } = require('../lib/license');

const BODY_LIMIT = parseInt(process.env.ADMIN_BODY_LIMIT_BYTES ?? '4096', 10);

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.ADMIN_RATE_LIMIT_PER_MINUTE ?? '30', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function requirePlanAndOwner(app, req, reply, workspaceId) {
  let sub = null;
  if (!isEnterpriseMode()) {
    const { Subscription } = require('../models');
    sub = await Subscription.findOne({ accountId: req.userId }).lean();
    if (!sub || (sub.plan !== 'team' && sub.plan !== 'enterprise')) {
      return reply.status(403).send({ error: 'forbidden', message: 'Admin routes require a Team or Enterprise plan.' });
    }
  }

  const ws = await Workspace.findById(workspaceId, { nameEncrypted: 1 }).lean();
  if (!ws) {
    return reply.status(404).send({ error: 'not_found', message: 'Workspace not found.' });
  }

  const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
  if (!membership || membership.role !== 'owner') {
    return reply.status(403).send({ error: 'forbidden', message: 'Workspace owner access required.' });
  }

  return { sub, ws };
}

async function adminRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.get('/workspaces/:id/members', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const ownerCheck = await requirePlanAndOwner(app, req, reply, workspaceId);
    if (!ownerCheck) return;

    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const accountIds = members.map((m) => m.accountId);

    const deviceCounts = {};
    const lastSeenMap = {};
    if (accountIds.length > 0) {
      const allDevices = await Device.find({ accountId: { $in: accountIds } }, { accountId: 1 }).lean();
      for (const d of allDevices) {
        deviceCounts[d.accountId] = (deviceCounts[d.accountId] ?? 0) + 1;
      }

      const allSessions = await Session
        .find({ accountId: { $in: accountIds } }, { accountId: 1, lastSeenAt: 1 })
        .lean();
      for (const s of allSessions) {
        const existing = lastSeenMap[s.accountId];
        if (!existing || (s.lastSeenAt && new Date(s.lastSeenAt) > new Date(existing))) {
          lastSeenMap[s.accountId] = s.lastSeenAt;
        }
      }
    }

    const enriched = members.map((m) => ({
      userId: m.accountId,
      role: m.role,
      deviceCount: deviceCounts[m.accountId] ?? 0,
      lastSeen: lastSeenMap[m.accountId] ?? null,
      createdAt: m.createdAt,
    }));

    return reply.send({ workspaceId, members: enriched });
  });

  app.delete('/workspaces/:id/members/:uid', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const targetUserId = req.params.uid;
    const ownerCheck = await requirePlanAndOwner(app, req, reply, workspaceId);
    if (!ownerCheck) return;

    if (targetUserId === req.userId) {
      return reply.status(400).send({ error: 'self_removal', message: 'Owners cannot remove themselves.' });
    }

    const result = await WorkspaceMember.deleteOne({ workspaceId, accountId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    try {
      await Session.updateMany(
        { accountId: targetUserId, workspaceId },
        { revoked: true }
      );
    } catch {}

    return reply.send({ deleted: true, workspaceId, userId: targetUserId });
  });

  app.get('/workspaces/:id/devices', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const ownerCheck = await requirePlanAndOwner(app, req, reply, workspaceId);
    if (!ownerCheck) return;

    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const accountIds = members.map(m => m.accountId);

    const devices = accountIds.length > 0
      ? (await Device.find({ accountId: { $in: accountIds } }, { accountId: 1, deviceId: 1, label: 1, lastSeen: 1, createdAt: 1 }).lean())
      : [];

    const flat = devices.map(d => ({
      userId: d.accountId,
      deviceId: d.deviceId,
      label: d.label,
      lastSeen: d.lastSeen,
      createdAt: d.createdAt,
    }));

    return reply.send({ workspaceId, devices: flat });
  });

  app.delete('/sessions/:hash', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const sessionHash = req.params.hash;
    if (!sessionHash || typeof sessionHash !== 'string') {
      return reply.status(400).send({ error: 'invalid_hash', message: 'Valid session hash required.' });
    }

    if (!isEnterpriseMode()) {
      const { Subscription } = require('../models');
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();
      if (!sub || (sub.plan !== 'team' && sub.plan !== 'enterprise')) {
        return reply.status(403).send({ error: 'forbidden', message: 'Team or Enterprise plan required.' });
      }
    }

    const session = await Session.findOne({ idHash: sessionHash }).lean();
    if (!session) {
      return reply.status(404).send({ error: 'not_found', message: 'Session not found.' });
    }

    if (session.accountId !== req.userId) {
      if (session.workspaceId) {
        const owned = await Workspace.find(
          { ownerId: req.userId, _id: session.workspaceId },
          { _id: 1 }
        ).lean();
        if (owned.length === 0) {
          return reply.status(403).send({
            error: 'forbidden',
            message: 'You can only revoke sessions issued by workspaces you own.',
          });
        }
      } else {
        return reply.status(403).send({
          error: 'forbidden',
          message: 'Account-wide sessions can only be revoked by the account owner.',
        });
      }
    }

    await Session.updateOne({ idHash: sessionHash }, { revoked: true });
    return reply.send({ revoked: true, sessionHash });
  });

  app.get('/workspaces/:id/audit', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    if (!isEnterpriseMode()) {
      const { Subscription } = require('../models');
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();
      if (!sub || sub.plan !== 'enterprise') {
        return reply.status(403).send({ error: 'forbidden', message: 'Audit logs require an Enterprise plan.' });
      }
    }

    const ownerCheck = await requirePlanAndOwner(app, req, reply, workspaceId);
    if (!ownerCheck) return;

    const fromTs = parseInt(req.query.from, 10);
    const toTs = parseInt(req.query.to, 10);

    const filter = { workspaceId };
    if (Number.isFinite(fromTs) || Number.isFinite(toTs)) {
      filter.createdAt = {};
      if (Number.isFinite(fromTs)) filter.createdAt.$gte = new Date(fromTs);
      if (Number.isFinite(toTs)) filter.createdAt.$lte = new Date(toTs);
    }

    const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500);

    const logs = await AuditLog
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const result = await Promise.all(logs.map(async (log) => {
      let meta = null;
      if (log.metadataEncrypted) {
        try {
          const raw = await mlkem.decryptMetadata(log.metadataEncrypted);
          meta = JSON.parse(raw);
        } catch { }
      }
      return { ...log, metadataEncrypted: undefined, metadata: meta };
    }));

    return reply.send({ workspaceId, logs: result });
  });
}

module.exports = adminRoutes;
