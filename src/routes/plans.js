'use strict';

const { getQuotaBytes, getHistoryDays, getDeviceLimit, getFlags } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');

async function plansRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate, app.requireActiveSync] };

  app.get('/', protect, async (req, reply) => {
    if (isEnterpriseMode()) {
      return reply.send({
        plan: 'enterprise',
        flags: getFlags('enterprise'),
        quotaBytes: getQuotaBytes('enterprise'),
        historyDays: getHistoryDays('enterprise'),
        deviceLimit: getDeviceLimit('enterprise'),
      });
    }

    const sub = req.subscription;
    const orgSub = req.orgSubscription;
    const plan = orgSub?.plan || sub?.plan || 'free';

    return reply.send({
      plan,
      flags: getFlags(plan),
      quotaBytes: getQuotaBytes(plan, orgSub?.seats),
      historyDays: getHistoryDays(plan),
      deviceLimit: getDeviceLimit(plan),
    });
  });
}

module.exports = plansRoutes;
