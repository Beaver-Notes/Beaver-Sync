'use strict';

const crypto = require('crypto');
const { Account, Workspace, WorkspaceMember, WorkspaceInvite, Session, OrgMember, Subscription } = require('../models');
const { audit } = require('../lib/audit');
const { sendWorkspaceInviteEmail } = require('../email');
const { isFreePlan, resolvePlanForAccount } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');
const { resolveOrgSubscription } = require('../lib/plan-resolution');

const BODY_LIMIT = parseInt(process.env.WORKSPACE_BODY_LIMIT_BYTES ?? '8192', 10);

function hashToken(raw) {
  return crypto.createHmac('sha256', process.env.SESSION_HMAC_KEY).update(raw).digest('hex');
}

async function getMembership(userId, workspaceId) {
  return WorkspaceMember.findOne({ workspaceId, accountId: userId }).lean();
}

async function requireMember(app, userId, workspaceId, allowedRoles) {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) {
    throw Object.assign(new Error('Not a member of this workspace.'), { statusCode: 403, code: 'forbidden' });
  }
  if (allowedRoles && !allowedRoles.has(membership.role)) {
    throw Object.assign(new Error('Insufficient permissions.'), { statusCode: 403, code: 'forbidden' });
  }
  return membership;
}

const rateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE ?? '60', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function workspaceRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.post('/', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const { nameEncrypted, recipients, orgId } = req.body ?? {};
    if (!nameEncrypted || typeof nameEncrypted !== 'string' || nameEncrypted.length > 8192) {
      return reply.status(400).send({ error: 'validation_error', message: 'Encrypted workspace name is required.' });
    }
    if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.some((r) => r.userId === req.userId)) {
      return reply.status(400).send({ error: 'validation_error', message: 'recipients must include the owner.' });
    }
    for (const r of recipients) {
      if (!r || typeof r.userId !== 'string' || typeof r.wrappedKey !== 'string' || !r.wrappedKey) {
        return reply.status(400).send({ error: 'validation_error', message: 'Each recipient needs userId and wrappedKey.' });
      }
    }

    if (!isEnterpriseMode()) {
      const sub = await Subscription.findOne({ accountId: req.userId }).lean();
      const orgSub = orgId ? await resolveOrgSubscription(orgId, req.userId) : null;
      const plan = resolvePlanForAccount({ orgSub, sub });

      if (isFreePlan(plan)) {
        return reply.status(403).send({ error: 'plan_upgrade_required', message: 'Cloud workspaces require a paid plan.' });
      }

      if (plan === 'starter' || plan === 'pro') {
        // Count per-org: a shared team workspace the user owns in another org
        // must not block provisioning their personal workspace here.
        const owned = await Workspace.countDocuments({ ownerId: req.userId, orgId });
        if (owned >= 1) {
          return reply.status(403).send({ error: 'workspace_limit_reached', message: 'Your plan includes one personal workspace.' });
        }
      }
    }

    if (!orgId) {
      return reply.status(400).send({ error: 'validation_error', message: 'Organization ID is required.' });
    }

    const membership = await OrgMember.findOne({ org_id: orgId, account_id: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_org_member' });
    }

    const workspace = await Workspace.create({ nameEncrypted, ownerId: req.userId, orgId, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: workspace.id, accountId: req.userId, role: 'owner', createdAt: new Date() });

    const { WorkspaceKey } = require('../models');
    for (const r of recipients) {
      await WorkspaceKey.findOneAndUpdate(
        { workspaceId: workspace.id, userId: r.userId },
        { $set: { wrappedKey: r.wrappedKey } },
        { upsert: true }
      );
    }

    // Initialize sync state for the new workspace so /sync/state doesn't 404
    const { query } = require('../db');
    await query(
      'INSERT INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [workspace.id, 'empty', 0, new Date().toISOString()]
    );

    app.log.info({ workspaceId: workspace.id, userId: req.userId }, 'Workspace created');
    audit(req, 'workspace_created', { workspaceId: workspace.id });

    return reply.status(201).send({ id: workspace.id, nameEncrypted, role: 'owner', createdAt: workspace.createdAt });
  });

  app.get('/', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const memberships = await WorkspaceMember.find({ accountId: req.userId }).lean();
    if (memberships.length === 0) return reply.send({ workspaces: [] });

    const workspaceIds = memberships.map(m => m.workspaceId);
    const roleMap = {};
    for (const m of memberships) roleMap[m.workspaceId] = m.role;

    const wsDocs = await Workspace
      .find({ _id: { $in: workspaceIds } }, { _id: 1, nameEncrypted: 1, ownerId: 1, orgId: 1, emoji: 1, color: 1, storageUsedBytes: 1, createdAt: 1 })
      .lean();

    const { WorkspaceKey } = require('../models');
    const envelopeRows = await WorkspaceKey.find({ userId: req.userId }).lean();
    const envelopeMap = {};
    for (const e of envelopeRows) envelopeMap[e.workspaceId] = e.wrappedKey;

    const workspaces = [];
    for (const ws of wsDocs) {
      if (!ws) continue;
      const wrappedKey = envelopeMap[ws.id] || null;
      workspaces.push({
        id: ws.id,
        nameEncrypted: ws.nameEncrypted,
        wrappedKey,
        orgId: ws.orgId,
        emoji: ws.emoji,
        color: ws.color,
        role: roleMap[ws.id],
        ownerId: ws.ownerId,
        storageUsedBytes: ws.storageUsedBytes,
        createdAt: ws.createdAt,
      });
    }

    return reply.send({ workspaces });
  });

  app.patch('/:id', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_workspace_member' });
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return reply.status(403).send({ error: 'insufficient_permissions', message: 'Only owners or admins can rename workspaces.' });
    }

    const { nameEncrypted } = req.body ?? {};
    if (!nameEncrypted || typeof nameEncrypted !== 'string' || nameEncrypted.length > 8192) {
      return reply.status(400).send({ error: 'validation_error', message: 'Encrypted workspace name is required.' });
    }

    await Workspace.updateOne({ _id: workspaceId }, { $set: { nameEncrypted } });

    app.log.info({ workspaceId, userId: req.userId }, 'Workspace renamed');
    audit(req, 'workspace_renamed', { workspaceId });

    return reply.send({ id: workspaceId, nameEncrypted });
  });

  app.delete('/:id', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId, role: 'owner' }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_workspace_owner' });
    }

    await WorkspaceMember.deleteMany({ workspace_id: workspaceId });
    await WorkspaceInvite.deleteMany({ workspace_id: workspaceId });
    await Workspace.deleteOne({ _id: workspaceId });

    app.log.info({ workspaceId, userId: req.userId }, 'Workspace deleted');
    audit(req, 'workspace_deleted', { workspaceId });

    return reply.send({ deleted: true });
  });

  app.post('/:id/members', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'editor']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const { username, email, role, ...body } = req.body ?? {};
    if ((!username || typeof username !== 'string') && (!email || typeof email !== 'string')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Provide username or email of the user to invite.' });
    }

    const inviteRole = role === 'viewer' ? 'viewer' : role === 'guest' ? 'guest' : 'editor';

    if (inviteRole === 'guest') {
      return reply.status(400).send({ error: 'invalid_role', message: 'The guest role is no longer supported. Use per-note collaboration instead.' });
    }

    const requireApproval = body.requireApproval ? 1 : 0;

    let target = null;
    if (username) {
      const normalized = username.trim().toLowerCase();
      target = await Account.findOne({ username: normalized }).lean();
    } else if (email) {
      const { createEmailHash } = require('../lib/crypto');
      const emailHash = createEmailHash(email.trim().toLowerCase());
      target = await Account.findOne({ emailHmac: emailHash }).lean();
    }

    if (!target) {
      return reply.status(404).send({ error: 'user_not_found', message: 'No user found with that username or email.' });
    }

    if (target.id === req.userId) {
      return reply.status(400).send({ error: 'self_invite', message: 'You cannot invite yourself.' });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId, accountId: target.id }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member', message: 'User is already a member of this workspace.' });
    }

    const { Subscription } = require('../models');
    if (!isEnterpriseMode()) {
      const targetSub = await Subscription.findOne({ accountId: target.id }).lean();
      const targetPlan = targetSub?.plan || 'free';
      if (targetPlan === 'free') {
        return reply.status(403).send({
          error: 'plan_upgrade_required',
          message: 'Free accounts can only be note collaborators, not workspace members.',
        });
      }
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await WorkspaceInvite.create({
      tokenHash,
      workspaceId,
      role: inviteRole,
      requireApproval,
      expiresAt,
      maxUses: 0,
      usedCount: 0,
      createdAt: new Date(),
    });

    const inviter = await Account.findById(req.userId, { username: 1 }).lean();
    const wsName = await Workspace.findById(workspaceId, { nameEncrypted: 1 }).lean();
    sendWorkspaceInviteEmail(app, target.id, {
      inviterName: inviter?.username || 'Someone',
      workspaceName: wsName?.nameEncrypted || 'a workspace',
      inviteUrl: `${process.env.INVITE_URL_SCHEME ?? 'beaver-notes://'}join/${rawToken}`,
      expiresIn: '7 days',
    });

    app.log.info({ workspaceId, invitedUser: target.id, byUser: req.userId }, 'Workspace invite created');
    audit(req, 'member_added', { workspaceId, targetUserId: target.id, role: inviteRole });

    return reply.status(201).send({
      workspaceId,
      token: rawToken,
      expiresAt,
      role: inviteRole,
      requireApproval: !!requireApproval,
    });
  });

  app.delete('/:id/members/:uid', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const targetUserId = req.params.uid;

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    if (targetUserId === req.userId) {
      return reply.status(400).send({ error: 'self_removal', message: 'Owners cannot remove themselves. Transfer ownership first.' });
    }

    const result = await WorkspaceMember.deleteOne({ workspaceId, accountId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    const { WorkspaceKey } = require('../models');
    await WorkspaceKey.deleteOne({ workspaceId, userId: targetUserId });

    try {
      await Session.updateMany(
        { accountId: targetUserId, workspaceId },
        { revoked: true }
      );
    } catch {}

    app.log.info({ workspaceId, removedUser: targetUserId, byUser: req.userId }, 'Member removed from workspace');
    audit(req, 'member_removed', { workspaceId, targetUserId });

    return reply.send({ deleted: true, workspaceId, userId: targetUserId });
  });

  app.post('/join/:token', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const rawToken = req.params.token;
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid invite token.' });
    }

    const tokenHash = hashToken(rawToken);
    const invite = await WorkspaceInvite.findOne({ tokenHash }).lean();

    if (!invite) {
      return reply.status(404).send({ error: 'invite_not_found', message: 'Invite not found or already used.' });
    }

    if (new Date(invite.expiresAt) < new Date()) {
      return reply.status(410).send({ error: 'invite_expired', message: 'This invite has expired.' });
    }

    if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) {
      return reply.status(410).send({ error: 'invite_max_uses', message: 'This invite has reached its maximum number of uses.' });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId: invite.workspaceId, accountId: req.userId }).lean();
    if (existing) {
      return reply.status(409).send({ error: 'already_member', message: 'You are already a member of this workspace.' });
    }

    const joiner = await Account.findById(req.userId, { kemPublicKey: 1 }).lean();
    if (!joiner || !joiner.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'Set up end-to-end encryption before joining.' });
    }

    const { Subscription } = require('../models');
    if (!isEnterpriseMode()) {
      const joinerSub = await Subscription.findOne({ accountId: req.userId }).lean();
      if ((joinerSub?.plan || 'free') === 'free') {
        return reply.status(403).send({
          error: 'plan_upgrade_required',
          message: 'Free accounts can only be note collaborators, not workspace members.',
        });
      }
    }

    await WorkspaceMember.create({ workspaceId: invite.workspaceId, accountId: req.userId, role: invite.role, createdAt: new Date() });
    await WorkspaceInvite.updateOne({ tokenHash }, { $inc: { usedCount: 1 } });

    app.log.info({ workspaceId: invite.workspaceId, userId: req.userId, role: invite.role }, 'User joined workspace via invite');

    return reply.send({ workspaceId: invite.workspaceId, role: invite.role });
  });

  app.get('/:id/member-lookup', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const { email, username } = req.query ?? {};

    try {
      await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin', 'editor']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    let target = null;
    if (username && typeof username === 'string') {
      const normalized = username.trim().toLowerCase();
      target = await Account.findOne({ username: normalized }).lean();
    } else if (email && typeof email === 'string') {
      const { createEmailHash } = require('../lib/crypto');
      target = await Account.findOne({ emailHmac: createEmailHash(email.trim().toLowerCase()) }).lean();
    }

    if (!target) {
      return reply.send({ found: false });
    }

    const existing = await WorkspaceMember.findOne({ workspaceId, accountId: target.id }).lean();

    return reply.send({
      found: true,
      accountId: target.id,
      hasKemPublicKey: Boolean(target.kemPublicKey),
      alreadyMember: Boolean(existing),
    });
  });

  app.patch('/:id/members/:uid', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;
    const targetUserId = req.params.uid;

    let actorMembership;
    try {
      actorMembership = await requireMember(app, req.userId, workspaceId, new Set(['owner', 'admin']));
    } catch (err) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    const { role } = req.body ?? {};
    if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) {
      return reply.status(400).send({ error: 'invalid_role', message: 'Valid roles: owner, admin, editor, viewer.' });
    }

    const target = await WorkspaceMember.findOne({ workspaceId, accountId: targetUserId }).lean();
    if (!target) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    // Only the current workspace owner may grant the owner role. This keeps an
    // admin from creating a second owner that could never be demoted.
    if (role === 'owner' && actorMembership.role !== 'owner') {
      return reply.status(403).send({ error: 'forbidden', message: 'Only the current workspace owner can grant the owner role.' });
    }

    // No one but the current owner may modify the owner row.
    if (target.role === 'owner' && targetUserId !== req.userId) {
      return reply.status(403).send({ error: 'forbidden', message: 'Only the workspace owner can modify the owner row.' });
    }

    // Self-demotion is only meaningful as part of a transfer, and transfers
    // happen automatically when the owner promotes someone else below.
    if (targetUserId === req.userId && role !== 'owner') {
      return reply.status(400).send({ error: 'cannot_demote_self', message: 'You cannot change your own role away from owner.' });
    }

    // Single-owner invariant: promoting someone else to owner transfers the
    // role, so the current owner steps down to admin.
    if (role === 'owner' && targetUserId !== req.userId) {
      await WorkspaceMember.updateOne(
        { workspaceId, accountId: req.userId },
        { $set: { role: 'admin' } }
      );
    }

    const result = await WorkspaceMember.updateOne(
      { workspaceId, accountId: targetUserId },
      { $set: { role } }
    );
    if (result.modifiedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Member not found in this workspace.' });
    }

    app.log.info({ workspaceId, targetUserId, role, byUser: req.userId }, 'Workspace member role changed');
    return reply.send({ updated: true });
  });
}

module.exports = workspaceRoutes;
