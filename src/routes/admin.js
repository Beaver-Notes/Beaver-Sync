'use strict';

const { Workspace, WorkspaceMember, Device, Session, AuditLog, Account } = require('../models');
const mlkem = require('../lib/mlkem');
const { isEnterpriseMode } = require('../lib/license');
const { resolvePlanForAccount } = require('../lib/plans');

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
  const ws = await Workspace.findById(workspaceId, { nameEncrypted: 1, orgId: 1 }).lean();
  if (!ws) {
    return reply.status(404).send({ error: 'not_found', message: 'Workspace not found.' });
  }

  let sub = null;
  if (!isEnterpriseMode()) {
    const { Subscription, OrgSubscription } = require('../models');
    sub = await Subscription.findOne({ accountId: req.userId }).lean();
    const orgSub = ws.orgId ? await OrgSubscription.findOne({ orgId: ws.orgId }).lean() : null;
    const effectivePlan = resolvePlanForAccount({ orgSub, sub });
    if (!effectivePlan || (effectivePlan !== 'team' && effectivePlan !== 'enterprise')) {
      return reply.status(403).send({ error: 'forbidden', message: 'Admin routes require a Team or Enterprise plan.' });
    }
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
    const accountMap = {};
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

      // Human identity for the admin UI: an admin must never have to read UUIDs
      // to know who is in their workspace. Only the username is exposed; a
      // member's email stays private even from workspace owners/admins.
      const accounts = await Account
        .find({ _id: { $in: accountIds } }, { id: 1, username: 1 })
        .lean();
      for (const a of accounts) accountMap[a._id] = a;
    }

    const enriched = members.map((m) => {
      const acct = accountMap[m.accountId];
      return {
        userId: m.accountId,
        username: acct?.username ?? null,
        role: m.role,
        deviceCount: deviceCounts[m.accountId] ?? 0,
        lastSeen: lastSeenMap[m.accountId] ?? null,
        createdAt: m.createdAt,
      };
    });

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

    // Workspace removal drops the membership only. Account-scoped sessions are
    // NOT revoked here; that would log the member out of unrelated workspaces.
    // Per-request membership checks remain the access guard.
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

    const sessions = accountIds.length > 0
      ? (await Session.find(
          { accountId: { $in: accountIds }, workspaceId },
          { idHash: 1, accountId: 1, deviceLabel: 1, deviceId: 1, ipSubnet: 1, lastSeenAt: 1, revoked: 1, createdAt: 1 }
        ).lean())
      : [];

    const flatSessions = sessions.map(s => ({
      userId: s.accountId,
      idHash: s.idHash,
      deviceLabel: s.deviceLabel,
      deviceId: s.deviceId,
      ipSubnet: s.ipSubnet,
      lastSeenAt: s.lastSeenAt,
      revoked: Boolean(s.revoked),
      createdAt: s.createdAt,
    }));

    return reply.send({ workspaceId, devices: flat, sessions: flatSessions });
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
      const { Subscription, OrgSubscription } = require('../models');
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();

      const ws = await Workspace.findById(workspaceId, { orgId: 1 }).lean();
      const orgSub = ws?.orgId ? await OrgSubscription.findOne({ orgId: ws.orgId }).lean() : null;
      const isEnterprise = resolvePlanForAccount({ orgSub, sub }) === 'enterprise';

      if (!isEnterprise) {
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
        } catch (err) {
          console.warn('[admin] failed to decrypt audit metadata:', err?.message);
        }
      }
      return { ...log, metadataEncrypted: undefined, metadata: meta };
    }));

    return reply.send({ workspaceId, logs: result });
  });
}

module.exports = adminRoutes;
