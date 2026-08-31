'use strict';

const crypto = require('crypto');
const { Subscription, Organization, OrgMember, OrgSubscription, Workspace, WorkspaceMember } = require('../models');
const { getQuotaBytes, getHistoryDays, resolvePlanForAccount } = require('./plans');
const { isOrgParticipant } = require('./plan-resolution');

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

async function downgradeAtPeriodEnd(accountId) {
  const sub = await Subscription.findOne({ accountId }).lean();
  if (!sub || sub.plan === 'free') return { alreadyFree: true, ok: true };
  const renewsAtMs = sub.renewsAt ? new Date(sub.renewsAt).getTime() : 0;
  if (renewsAtMs && renewsAtMs > Date.now()) {
    return { pending: true, renewsAt: sub.renewsAt, ok: false };
  }
  const check = await checkDowngrade(accountId, sub.plan, 'free');
  if (!check.ok) return check;
  await Subscription.updateOne({ accountId }, { $set: { plan: 'free', status: 'expired', storageQuotaBytes: getQuotaBytes('free') } });
  try {
    const owned = await OrgMember.find({ accountId, role: 'owner' }).lean();
    for (const m of owned) {
      await OrgSubscription.updateOne({ orgId: m.orgId }, { $set: { plan: 'free', status: 'expired', storageQuotaBytes: getQuotaBytes('free') } });
    }
  } catch {}
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
// workspace belongs to a team/enterprise org AND the account participates in
// that org) and returns the history cutoff. A note collaborator who is not a
// workspace/org member must never inherit the org's window — their personal
// plan (free → 0 days) governs instead.
async function historyCutoffForAccount(accountId, workspaceId = null) {
  const sub = await Subscription.findOne({ accountId }).lean();
  let orgSub = null;
  if (workspaceId) {
    const ws = await Workspace.findById(workspaceId, { orgId: 1 }).lean();
    if (ws?.orgId && (await isOrgParticipant(ws.orgId, accountId))) {
      orgSub = await OrgSubscription.findOne({ orgId: ws.orgId }).lean();
    }
  }
  const plan = resolvePlanForAccount({ orgSub, sub });
  return { plan, cutoffTs: historyCutoffTs(plan) };
}

module.exports = { ensurePaidProvisioning, checkDowngrade, downgradeAtPeriodEnd, historyCutoffTs, historyCutoffForAccount };
