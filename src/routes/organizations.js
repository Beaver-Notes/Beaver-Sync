'use strict';

const crypto = require('crypto');
const { Organization, OrgMember, OrgSubscription, Workspace, WorkspaceMember, OrgKey, OrgInvite } = require('../models');
const { createEmptyState } = require('../repositories/syncWorkspaceState');
const { requireOrgMember, requireOrgAdmin, requireOrgOwner } = require('../middleware/org');

const VALID_PLANS = new Set(['free', 'starter', 'pro', 'team', 'enterprise']);

async function organizationRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  app.get('/', protect, async (req, reply) => {
    const memberships = await OrgMember.find({ accountId: req.userId }).lean();
    const orgIds = memberships.map(m => m.orgId);

    if (orgIds.length === 0) return reply.send([]);

    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();
    const envelopeRows = await OrgKey.find({ userId: req.userId }).lean();
    const envelopeMap = {};
    for (const e of envelopeRows) envelopeMap[e.orgId] = e.wrappedKey;

    const result = orgs.map(org => {
      const membership = memberships.find(m => m.orgId === org.id);
      return {
        id: org.id,
        nameEncrypted: org.nameEncrypted,
        slug: org.slug,
        role: membership.role,
        wrappedKey: envelopeMap[org.id] || null,
        createdAt: org.createdAt,
      };
    });

    return reply.send(result);
  });

  app.post('/', protect, async (req, reply) => {
    const { nameEncrypted, recipients, slug: clientSlug } = req.body || {};
    if (!nameEncrypted || typeof nameEncrypted !== 'string' || !nameEncrypted.trim()) {
      return reply.status(400).send({ error: 'name_required' });
    }
    if (!Array.isArray(recipients) || !recipients.some((r) => r.userId === req.userId)) {
      return reply.status(400).send({ error: 'validation_error', message: 'recipients must include the owner.' });
    }
    for (const r of recipients) {
      if (!r || typeof r.userId !== 'string' || typeof r.wrappedKey !== 'string' || !r.wrappedKey) {
        return reply.status(400).send({ error: 'validation_error', message: 'Each recipient needs userId and wrappedKey.' });
      }
    }

    const orgId = crypto.randomUUID();
    const slug = (typeof clientSlug === 'string' && clientSlug.trim() && /^[a-z0-9-]{1,63}$/.test(clientSlug))
      ? clientSlug.trim()
      : `org-${orgId}`;

    try {
      await Organization.create({ id: orgId, nameEncrypted: nameEncrypted.trim(), slug, createdAt: new Date() });
    } catch (err) {
      if (String(err?.message ?? err).toLowerCase().includes('unique')) {
        return reply.status(409).send({ error: 'slug_taken', message: 'That slug is already in use.' });
      }
      throw err;
    }
    await OrgMember.create({ orgId, accountId: req.userId, role: 'owner', createdAt: new Date() });
    await OrgSubscription.create({ id: crypto.randomUUID(), orgId, plan: 'free', status: 'active', seats: 1, createdAt: new Date() });

    // Org key envelopes
    for (const r of recipients) {
      await OrgKey.findOneAndUpdate(
        { orgId, userId: r.userId },
        { $set: { wrappedKey: r.wrappedKey } },
        { upsert: true }
      );
    }

    // Create default workspace. `name_encrypted` is NOT NULL, so store '' (client renders "Workspace").
    const wsRecipients = recipients.filter((r) => r.userId === req.userId);
    const workspace = await Workspace.create({ nameEncrypted: '', ownerId: req.userId, orgId, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: workspace.id, accountId: req.userId, role: 'owner', createdAt: new Date() });
    const { WorkspaceKey } = require('../models');
    for (const r of wsRecipients) {
      await WorkspaceKey.findOneAndUpdate(
        { workspaceId: workspace.id, userId: r.userId },
        { $set: { wrappedKey: r.wrappedKey } },
        { upsert: true }
      );
    }

    await createEmptyState(workspace.id);

    return reply.status(201).send({
      id: orgId,
      nameEncrypted,
      slug,
      role: 'owner',
      workspace: { id: workspace.id, nameEncrypted: '' },
    });
  });

  app.get('/:id', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const org = await Organization.findById(req.orgId).lean();
    if (!org) return reply.status(404).send({ error: 'not_found' });

    const envelope = await OrgKey.findOne({ orgId: req.orgId, userId: req.userId }).lean();
    const subscription = await OrgSubscription.findOne({ orgId: req.orgId }).lean();
    const workspaces = await Workspace.find({ orgId: req.orgId }).lean();

    const { WorkspaceKey } = require('../models');
    const wsEnvelopeRows = await WorkspaceKey.find({ userId: req.userId }).lean();
    const wsEnvelopeMap = {};
    for (const e of wsEnvelopeRows) wsEnvelopeMap[e.workspaceId] = e.wrappedKey;

    return reply.send({
      id: org.id,
      nameEncrypted: org.nameEncrypted,
      wrappedKey: envelope?.wrappedKey || null,
      slug: org.slug,
      role: req.orgRole,
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        seats: subscription.seats,
      } : null,
      workspaces: workspaces.map(ws => ({
        id: ws.id,
        nameEncrypted: ws.nameEncrypted,
        wrappedKey: wsEnvelopeMap[ws.id] || null,
        emoji: ws.emoji,
        color: ws.color,
      })),
    });
  });

  app.patch('/:id', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const { nameEncrypted } = req.body || {};
    if (nameEncrypted) {
      if (typeof nameEncrypted !== 'string' || !nameEncrypted.trim()) {
        return reply.status(400).send({ error: 'name_required' });
      }
      await Organization.updateOne({ _id: req.orgId }, { $set: { name_encrypted: nameEncrypted.trim() } });
    }
    return reply.send({ updated: true });
  });

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

  app.get('/:id/members', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const members = await OrgMember.find({ orgId: req.orgId }).lean();
    return reply.send(members.map(m => ({
      accountId: m.accountId,
      role: m.role,
      createdAt: m.createdAt,
    })));
  });

  app.post('/:id/members', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const { accountId, role = 'member', wrappedKey } = req.body || {};
    if (!accountId) {
      return reply.status(400).send({ error: 'account_id_required' });
    }

    const existing = await OrgMember.findOne({ orgId: req.orgId, accountId }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member' });
    }

    const { Account } = require('../models');
    const target = await Account.findById(accountId, { kemPublicKey: 1 }).lean();
    if (!target || !target.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'The new member has not set up end-to-end encryption yet.' });
    }
    if (!wrappedKey || typeof wrappedKey !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'wrappedKey is required to add a member.' });
    }

    await OrgMember.create({ orgId: req.orgId, accountId, role, createdAt: new Date() });
    await OrgKey.findOneAndUpdate(
      { orgId: req.orgId, userId: accountId },
      { $set: { wrappedKey } },
      { upsert: true }
    );
    return reply.status(201).send({ added: true });
  });

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

  app.delete('/:id/members/:uid', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    if (req.params.uid === req.userId) {
      return reply.status(400).send({ error: 'cannot_remove_self' });
    }

    await OrgMember.deleteOne({ orgId: req.orgId, accountId: req.params.uid });
    await OrgKey.deleteOne({ orgId: req.orgId, userId: req.params.uid });
    return reply.send({ removed: true });
  });

  app.post('/:id/leave', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    if (req.orgRole === 'owner') {
      return reply.status(400).send({ error: 'owner_cannot_leave' });
    }

    await OrgMember.deleteOne({ orgId: req.orgId, accountId: req.userId });
    return reply.send({ left: true });
  });

  app.post('/:id/invite', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const { role = 'member', requireApproval = false, maxUses = 0, expiresIn } = req.body ?? {};
    if (!['member', 'admin'].includes(role)) return reply.status(400).send({ error: 'invalid_role' });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    let expiresAt = null;
    if (expiresIn) { const ms = parseInt(expiresIn, 10); if (Number.isFinite(ms) && ms > 0) expiresAt = new Date(Date.now() + ms).toISOString(); }
    const invite = await OrgInvite.create({
      orgId: req.orgId, createdBy: req.userId, tokenHash, role,
      requireApproval: requireApproval ? 1 : 0, maxUses, usedCount: 0, expiresAt,
    });
    return reply.status(201).send({ id: invite.id, token: rawToken, role, requireApproval, maxUses, expiresAt });
  });

  app.get('/:id/invite', { preHandler: [app.authenticate, requireOrgMember] }, async (req, reply) => {
    const invites = await OrgInvite.find({ orgId: req.orgId, revoked: 0 }).sort({ createdAt: -1 }).lean();
    return reply.send({ invites });
  });

  app.delete('/:id/invite/:token', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    await OrgInvite.updateOne({ orgId: req.orgId, tokenHash }, { $set: { revoked: 1 } });
    return reply.send({ revoked: true });
  });

  app.post('/join/:token', { preHandler: [app.authenticate] }, async (req, reply) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const invite = await OrgInvite.findOne({ tokenHash, revoked: 0 }).lean();
    if (!invite) return reply.status(404).send({ error: 'invite_not_found' });
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return reply.status(410).send({ error: 'invite_expired' });
    if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) return reply.status(410).send({ error: 'invite_max_uses' });
    const existing = await OrgMember.findOne({ orgId: invite.orgId, accountId: req.userId }).lean();
    if (existing) return reply.status(409).send({ error: 'already_member' });
    const { Account } = require('../models');
    const joiner = await Account.findById(req.userId, { kemPublicKey: 1 }).lean();
    if (!joiner || !joiner.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'Set up end-to-end encryption before joining.' });
    }
    if (invite.requireApproval && !invite.approvedBy) {
      return reply.status(202).send({ pending: true, message: 'Join request requires approval.' });
    }
    await OrgMember.create({ orgId: invite.orgId, accountId: req.userId, role: invite.role, createdAt: new Date() });
    await OrgInvite.updateOne({ tokenHash }, { $inc: { usedCount: 1 } });
    return reply.status(201).send({ orgId: invite.orgId, role: invite.role });
  });

  app.post('/:id/invite/:token/approve', { preHandler: [app.authenticate, requireOrgAdmin] }, async (req, reply) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const invite = await OrgInvite.findOne({ orgId: req.orgId, tokenHash, revoked: 0 }).lean();
    if (!invite) return reply.status(404).send({ error: 'invite_not_found' });
    await OrgInvite.updateOne({ tokenHash }, { $set: { approvedBy: req.userId } });
    return reply.send({ approved: true });
  });

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

  app.patch('/:id/subscription', { preHandler: [app.authenticate, requireOrgOwner] }, async (req, reply) => {
    const { plan, seats } = req.body || {};
    const update = {};

    if (plan !== undefined) {
      if (!VALID_PLANS.has(plan)) {
        return reply.status(400).send({ error: 'validation_error', message: 'Invalid plan.' });
      }
      update.plan = plan;
    }
    if (seats !== undefined) {
      if (!Number.isInteger(seats) || seats < 1 || seats > 1000) {
        return reply.status(400).send({ error: 'validation_error', message: 'seats must be an integer between 1 and 1000.' });
      }
      update.seats = seats;
    }

    await OrgSubscription.updateOne({ orgId: req.orgId }, { $set: update });
    return reply.send({ updated: true });
  });
}

module.exports = organizationRoutes;
