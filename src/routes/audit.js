'use strict';

const { AuditLog, WorkspaceMember } = require('../models');
const mlkem = require('../lib/mlkem');
const { isEnterpriseMode } = require('../lib/license');

const AUDIT_BODY_LIMIT = parseInt(process.env.AUDIT_BODY_LIMIT_BYTES ?? '4096', 10);

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.AUDIT_RATE_LIMIT_PER_MINUTE ?? '30', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: AUDIT_BODY_LIMIT,
};

async function auditRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.get('/', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    if (!isEnterpriseMode()) {
      const { Subscription } = require('../models');
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();
      if (!sub || sub.plan !== 'enterprise') {
        return reply.status(403).send({ error: 'forbidden', message: 'Audit log requires an Enterprise plan.' });
      }
    }

    const workspaceId = req.query.workspaceId;
    if (!workspaceId || typeof workspaceId !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'workspaceId query parameter is required.' });
    }

    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a member of this workspace.' });
    }

    const filter = { workspaceId };

    const fromTs = parseInt(req.query.from, 10);
    const toTs = parseInt(req.query.to, 10);

    if (Number.isFinite(fromTs) || Number.isFinite(toTs)) {
      filter.createdAt = {};
      if (Number.isFinite(fromTs)) filter.createdAt.$gte = new Date(fromTs);
      if (Number.isFinite(toTs)) filter.createdAt.$lte = new Date(toTs);
    }

    const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500);

    const logs = await AuditLog
      .find(filter, { accountIdHash: 1, action: 1, metadataEncrypted: 1, ipSubnet: 1, createdAt: 1 })
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

    return reply.send({ logs: result });
  });
}

module.exports = auditRoutes;
