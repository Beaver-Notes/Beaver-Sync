'use strict';

const { getQuotaBytes, getHistoryDays, getDeviceLimit, getFlags } = require('../lib/plans');
const { getPlanPrices } = require('../lib/pricing');
const { isEnterpriseMode } = require('../lib/license');
const { resolveEffectivePlan } = require('../lib/plan-resolution');

async function plansRoutes(app) {
  await app.register(require('../middleware/auth'));

  // authenticate only: expired/lapsed accounts must still be able to load
  // prices + plan flags here, or the paywall they need to resubscribe 402s.
  const protect = { preHandler: [app.authenticate] };

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

    const { plan, seats, orgSub } = await resolveEffectivePlan(req);

    return reply.send({
      plan,
      flags: getFlags(plan),
      quotaBytes: getQuotaBytes(plan, seats),
      historyDays: getHistoryDays(plan),
      deviceLimit: getDeviceLimit(plan),
      seats: orgSub?.seats ?? null,
      prices: await getPlanPrices(),
    });
  });
}

module.exports = plansRoutes;
