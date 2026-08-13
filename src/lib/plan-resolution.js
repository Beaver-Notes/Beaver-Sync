'use strict';

const { Subscription, OrgSubscription, Workspace, OrgMember, WorkspaceMember } = require('../models');
const { resolvePlanForAccount } = require('./plans');

// Does the caller participate in this org at all — as an org member, or as a
// workspace member of a workspace that belongs to the org? Org context from a
// request (orgId/workspaceId) must never leak another org's plan/seats to a
// non-participant.
async function isOrgParticipant(orgId, userId) {
  if (!orgId || !userId) return false;
  const member = await OrgMember.findOne({ orgId, accountId: userId }).lean();
  if (member) return true;
  const wsRows = await Workspace.find({ orgId }, { _id: 1 }).lean();
  if (wsRows.length === 0) return false;
  const wsIds = wsRows.map((w) => w.id);
  const wsMember = await WorkspaceMember.findOne({
    workspaceId: { $in: wsIds },
    accountId: userId,
  }).lean();
  return Boolean(wsMember);
}

// Loads the org subscription for `orgId` only when the caller participates in
// the org; otherwise returns null so the caller falls back to their own plan.
async function resolveOrgSubscription(orgId, userId) {
  if (!orgId) return null;
  const orgSub = await OrgSubscription.findOne({ orgId }).lean();
  if (!orgSub) return null;
  if (!(await isOrgParticipant(orgId, userId))) return null;
  return orgSub;
}

// Org-first effective plan resolution shared across write paths. Honors
// req.subscription / req.orgSubscription when the middleware already resolved
// them, and otherwise resolves org context from the request (body/params/query
// orgId or workspaceId, plus the x-workspace-id header used by snapshot writes).
//
// Returns { plan, seats, orgSub, sub } where `plan` is the effective tier
// (resolvePlanForAccount, which also honors PLAN_OVERRIDE in test envs).
async function resolveEffectivePlan(req, subOverride) {
  const sub = subOverride || req.subscription || (await Subscription.findOne({ accountId: req.userId }).lean());
  let orgSub = req.orgSubscription;
  if (!orgSub) {
    let orgId = req.body?.orgId ?? req.params?.orgId ?? req.query?.orgId ?? null;
    const workspaceId =
      req.body?.workspaceId ??
      req.params?.workspaceId ??
      req.query?.workspaceId ??
      req.headers?.['x-workspace-id'] ??
      null;
    if (!orgId && workspaceId && typeof workspaceId === 'string') {
      const ws = await Workspace.findById(workspaceId, { orgId: 1 }).lean();
      if (ws) orgId = ws.orgId;
    }
    orgSub = orgId ? await resolveOrgSubscription(orgId, req.userId) : null;
  }
  const plan = resolvePlanForAccount({ orgSub, sub });
  return { plan, seats: orgSub?.seats ?? 1, orgSub, sub };
}

module.exports = { resolveEffectivePlan, resolveOrgSubscription, isOrgParticipant };
