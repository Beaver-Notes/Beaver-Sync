'use strict';

const crypto = require('crypto');
const { Subscription, Organization, OrgMember, OrgSubscription, Workspace, WorkspaceMember } = require('../models');
const { getQuotaBytes, getHistoryDays } = require('./plans');

const DAY_MS = 24 * 60 * 60 * 1000;

// Creates the org + personal workspace for a paid account that is missing one.
// NOTE: the wrapped workspace-key envelope is NOT provisioned here. The client
// runs its own workspace provisioning flow after the upgrade and supplies the
// key material; server-side wrapping would produce an envelope format the
// client cannot unwrap.
async function ensurePaidProvisioning(accountId) {
  const sub = await Subscription.findOne({ accountId }).lean();
  if (!sub || sub.plan === 'free') return { orgId: null, workspaceId: null };

  const existingMemberships = await OrgMember.find({ accountId }).lean();
  for (const m of existingMemberships) {
    const existing = await Workspace.find({ orgId: m.orgId, ownerId: accountId }).lean();
    if (existing.length > 0) {
      return { orgId: m.orgId, workspaceId: existing[0].id };
    }
  }

  const orgId = crypto.randomUUID();
  await Organization.create({ id: orgId, nameEncrypted: '', slug: `org-${crypto.randomUUID()}`, createdAt: new Date() });
  await OrgMember.create({ orgId, accountId, role: 'owner', createdAt: new Date() });
  await OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: sub.plan, status: 'active', seats: 1, createdAt: new Date() });

  const workspace = await Workspace.create({ nameEncrypted: '', ownerId: accountId, orgId, createdAt: new Date() });
  await WorkspaceMember.create({ workspaceId: workspace.id, accountId, role: 'owner', createdAt: new Date() });

  const { query } = require('../db');
  await query(
    'INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [workspace.id, 'empty', 0, new Date().toISOString()]
  );

  return { orgId, workspaceId: workspace.id };
}

async function checkDowngrade(accountId, fromPlan, toPlan) {
  const sub = await Subscription.findOne({ accountId }).lean();
  const usedBytes = sub?.storageUsedBytes ?? 0;
  const newQuota = getQuotaBytes(toPlan);
  if (usedBytes > newQuota) {
    return { ok: false, reason: 'storage', usedBytes, quotaBytes: newQuota };
  }
  return { ok: true };
}

// Lower bound (epoch ms) for serving history to a plan. null days (enterprise)
// means unlimited history → returns 0 so no clamp applies.
function historyCutoffTs(plan, now = Date.now()) {
  const days = getHistoryDays(plan);
  if (days === null) return 0;
  return now - days * DAY_MS;
}

// Resolves the effective plan for an account (org subscription wins when the
// workspace belongs to a team/enterprise org) and returns the history cutoff.
async function historyCutoffForAccount(accountId, workspaceId = null) {
  const sub = await Subscription.findOne({ accountId }).lean();
  let plan = sub?.plan || 'free';
  if (workspaceId) {
    const ws = await Workspace.findById(workspaceId, { orgId: 1 }).lean();
    if (ws?.orgId) {
      const orgSub = await OrgSubscription.findOne({ orgId: ws.orgId }).lean();
      if (orgSub?.plan) plan = orgSub.plan;
    }
  }
  return { plan, cutoffTs: historyCutoffTs(plan) };
}

module.exports = { ensurePaidProvisioning, checkDowngrade, historyCutoffTs, historyCutoffForAccount };
