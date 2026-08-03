'use strict';

const { CommitMeta, Subscription, Account } = require('../models');
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

async function cleanupOrphanedR2Objects() {
  const allKeys = await r2.listKeys('');
  if (allKeys.length === 0) return { deleted: 0 };

  const userPrefixes = new Set();
  for (const key of allKeys) {
    const parts = key.split('/');
    if (parts.length > 0) {
      userPrefixes.add(parts[0]);
    }
  }

  const accounts = await Account.find({}, { id: 1 }).lean();
  const activeUserIds = new Set(accounts.map((a) => a.id));

  let totalDeleted = 0;
  for (const prefix of userPrefixes) {
    if (!activeUserIds.has(prefix)) {
      const orphanedKeys = allKeys.filter((k) => k.startsWith(prefix + '/'));
      if (orphanedKeys.length > 0) {
        await r2.delMany(orphanedKeys);
        totalDeleted += orphanedKeys.length;
      }
    }
  }

  return { deleted: totalDeleted };
}

module.exports = { enforceVersionRetention, cleanupOrphanedR2Objects };
