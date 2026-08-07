'use strict';

const crypto = require('crypto');
const { Organization, OrgMember, OrgSubscription, Workspace, WorkspaceMember } = require('../models');
const { requireOrgMember, requireOrgAdmin, requireOrgOwner } = require('../middleware/org');

async function organizationRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  // List user's organizations
  app.get('/', protect, async (req, reply) => {
    const memberships = await OrgMember.find({ accountId: req.userId }).lean();
    const orgIds = memberships.map(m => m.orgId);

    if (orgIds.length === 0) return reply.send([]);

    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();

    const result = orgs.map(org => {
      const membership = memberships.find(m => m.orgId === org.id);
      return {
        id: org.id,
        name: org.nameEncrypted,
        slug: org.slug,
        role: membership.role,
        createdAt: org.createdAt,
      };
    });

    return reply.send(result);
  });

  // Create organization
  app.post('/', protect, async (req, reply) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return reply.status(400).send({ error: 'name_required' });
    }

    const orgId = crypto.randomUUID();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await Organization.create({ id: orgId, nameEncrypted: name.trim(), slug, createdAt: new Date() });
    await OrgMember.create({ orgId, accountId: req.userId, role: 'owner', createdAt: new Date() });
    await OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: 'free', status: 'active', seats: 1, createdAt: new Date() });

    // Create default workspace
    const workspace = await Workspace.create({ nameEncrypted: 'Default', ownerId: req.userId, orgId, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: workspace.id, accountId: req.userId, role: 'owner', createdAt: new Date() });

    return reply.status(201).send({
      id: orgId,
      name: name.trim(),
      slug,
      role: 'owner',
      workspace: { id: workspace.id, name: 'Default' },
    });
  });

  // Get organization details
  app.get('/:id', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const org = await Organization.findById(req.orgId).lean();
    if (!org) return reply.status(404).send({ error: 'not_found' });

    const subscription = await OrgSubscription.findOne({ orgId: req.orgId }).lean();
    const workspaces = await Workspace.find({ orgId: req.orgId }).lean();

    return reply.send({
      id: org.id,
      name: org.nameEncrypted,
      slug: org.slug,
      role: req.orgRole,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        seats: subscription.seats,
      } : null,
      workspaces: workspaces.map(ws => ({
        id: ws.id,
        name: ws.nameEncrypted,
        emoji: ws.emoji,
        color: ws.color,
      })),
    });
  });

  // Update organization
  app.patch('/:id', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const { name } = req.body || {};
    if (name) {
      await Organization.updateOne({ _id: req.orgId }, { $set: { name_encrypted: name.trim() } });
    }
    return reply.send({ updated: true });
  });

  // Delete organization
  app.delete('/:id', { preHandler: [app.authenticate, requireOrgOwner] }, async (req, reply) => {
    const workspaces = await Workspace.find({ orgId: req.orgId }).lean();
    if (workspaces.length > 0) {
      return reply.status(400).send({
        error: 'org_has_workspaces',
        message: 'Transfer or delete all workspaces before deleting the organization.',
      });
    }

    await OrgMember.deleteMany({ orgId: req.orgId });
    await OrgSubscription.deleteOne({ orgId: req.orgId });
    await Organization.deleteOne({ _id: req.orgId });

    return reply.send({ deleted: true });
  });

  // List members
  app.get('/:id/members', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const members = await OrgMember.find({ orgId: req.orgId }).lean();
    return reply.send(members.map(m => ({
      accountId: m.accountId,
      role: m.role,
      createdAt: m.createdAt,
    })));
  });

  // Add member
  app.post('/:id/members', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const { accountId, role = 'member' } = req.body || {};
    if (!accountId) {
      return reply.status(400).send({ error: 'account_id_required' });
    }

    const existing = await OrgMember.findOne({ orgId: req.orgId, accountId }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member' });
    }

    await OrgMember.create({ orgId: req.orgId, accountId, role, createdAt: new Date() });
    return reply.status(201).send({ added: true });
  });

  // Update member role
  app.patch('/:id/members/:uid', { preHandler: [app.authenticate, requireOrgOwner] }, async (req, reply) => {
    const { role } = req.body || {};
    if (!['admin', 'member'].includes(role)) {
      return reply.status(400).send({ error: 'invalid_role' });
    }

    await OrgMember.updateOne(
      { orgId: req.orgId, accountId: req.params.uid },
      { $set: { role } }
    );
    return reply.send({ updated: true });
  });

  // Remove member
  app.delete('/:id/members/:uid', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    if (req.params.uid === req.userId) {
      return reply.status(400).send({ error: 'cannot_remove_self' });
    }

    await OrgMember.deleteOne({ orgId: req.orgId, accountId: req.params.uid });
    return reply.send({ removed: true });
  });

  // Leave organization
  app.post('/:id/leave', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    if (req.orgRole === 'owner') {
      return reply.status(400).send({ error: 'owner_cannot_leave' });
    }

    await OrgMember.deleteOne({ orgId: req.orgId, accountId: req.userId });
    return reply.send({ left: true });
  });

  // Get subscription
  app.get('/:id/subscription', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const sub = await OrgSubscription.findOne({ orgId: req.orgId }).lean();
    if (!sub) return reply.status(404).send({ error: 'not_found' });
    return reply.send({
      plan: sub.plan,
      status: sub.status,
      seats: sub.seats,
      storageQuotaBytes: sub.storageQuotaBytes,
      storageUsedBytes: sub.storageUsedBytes,
    });
  });

  // Update subscription
  app.patch('/:id/subscription', { preHandler: [app.authenticate, requireOrgOwner] }, async (req, reply) => {
    const { plan, seats } = req.body || {};
    const update = {};
    if (plan) update.plan = plan;
    if (seats) update.seats = seats;

    await OrgSubscription.updateOne({ orgId: req.orgId }, { $set: update });
    return reply.send({ updated: true });
  });
}

module.exports = organizationRoutes;
