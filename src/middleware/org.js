'use strict';

const { OrgMember } = require('../models');
const { WorkspaceMember } = require('../models');

async function requireOrgMember(req, reply) {
  const orgId = req.params.id;

  if (!orgId) {
    return reply.status(400).send({ error: 'missing_org_id' });
  }

  const membership = await OrgMember.findOne({
    org_id: orgId,
    account_id: req.userId,
  }).lean();

  if (!membership) {
    return reply.status(403).send({ error: 'not_org_member' });
  }

  req.orgId = orgId;
  req.orgRole = membership.role;
}

async function requireOrgAdmin(req, reply) {
  await requireOrgMember(req, reply);
  if (reply.sent) return;

  if (!['owner', 'admin'].includes(req.orgRole)) {
    return reply.status(403).send({ error: 'org_admin_required' });
  }
}

async function requireOrgOwner(req, reply) {
  await requireOrgMember(req, reply);
  if (reply.sent) return;

  if (req.orgRole !== 'owner') {
    return reply.status(403).send({ error: 'org_owner_required' });
  }
}

async function requireWorkspaceMember(req, reply, workspaceId) {
  const membership = await WorkspaceMember.findOne({
    workspaceId,
    accountId: req.userId,
  }).lean();

  if (!membership) {
    return reply.status(403).send({ error: 'not_workspace_member' });
  }

  return membership;
}

async function requireWorkspaceOwner(req, reply, workspaceId) {
  const membership = await requireWorkspaceMember(req, reply, workspaceId);
  if (reply.sent) return null;

  if (membership.role !== 'owner') {
    return reply.status(403).send({ error: 'not_workspace_owner' });
  }

  return membership;
}

module.exports = {
  requireOrgMember,
  requireOrgAdmin,
  requireOrgOwner,
  requireWorkspaceMember,
  requireWorkspaceOwner,
};
