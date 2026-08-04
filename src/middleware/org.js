'use strict';

const { OrgMember } = require('../models');

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

module.exports = { requireOrgMember, requireOrgAdmin, requireOrgOwner };
