'use strict';

const { CommitMeta, Subscription } = require('../models');
const r2 = require('../services/r2');

const BASIC_RETENTION_DAYS = 30;

async function enforceVersionRetention() {
  const subs = await Subscription.find({ plan: 'basic', status: 'active' }).lean();
  if (subs.length === 0) return { deleted: 0 };

  const cutoff = new Date(Date.now() - BASIC_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  for (const sub of subs) {
    const oldCommits = await CommitMeta
      .find({
        accountId: sub.accountId,
        createdAt: { $lt: cutoff },
      }, { commitId: 1 })
      .lean();

    if (oldCommits.length === 0) continue;

    const commitIds = oldCommits.map((c) => c.commitId);

    await CommitMeta.deleteMany({ commitId: { $in: commitIds }, accountId: sub.accountId });

    const keys = commitIds.map((id) => r2.commitKey(sub.accountId, id));
    await r2.delMany(keys);

    totalDeleted += commitIds.length;
  }

  return { deleted: totalDeleted };
}

module.exports = { enforceVersionRetention };
