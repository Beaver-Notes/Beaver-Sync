'use strict';

const crypto = require('crypto');
const { Account, Workspace, WorkspaceMember, WorkspaceInvite, Session, OrgMember } = require('../models');
const mlkem = require('../lib/mlkem');
const { audit } = require('../lib/audit');

const BODY_LIMIT = parseInt(process.env.WORKSPACE_BODY_LIMIT_BYTES ?? '8192', 10);

const WS_NAME_REGEX = /^.{1,256}$/;

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
    const { name, orgId } = req.body ?? {};
    if (!name || typeof name !== 'string' || !WS_NAME_REGEX.test(name)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Workspace name is required (max 256 chars).' });
    }

    if (!orgId) {
      return reply.status(400).send({ error: 'validation_error', message: 'Organization ID is required.' });
    }

    // Verify user is member of the org
    const membership = await OrgMember.findOne({ org_id: orgId, account_id: req.userId }).lean();
    if (!membership) {
      return reply.status(403).send({ error: 'not_org_member' });
    }

    const nameEncrypted = await mlkem.encryptMetadata(name);
    const workspace = await Workspace.create({ nameEncrypted, ownerId: req.userId, orgId, createdAt: new Date() });
    await WorkspaceMember.create({ workspaceId: workspace.id, accountId: req.userId, role: 'owner', createdAt: new Date() });

    // Initialize sync state for the new workspace so /sync/state doesn't 404
    const { getDb } = require('../db');
    const syncDb = getDb();
    syncDb.prepare(
      'INSERT OR IGNORE INTO sync_workspace_state (workspace_id, status, generation, updated_at) VALUES (?, ?, ?, ?)'
    ).run(workspace.id, 'empty', 0, new Date().toISOString());

    app.log.info({ workspaceId: workspace.id, userId: req.userId }, 'Workspace created');
    audit(req, 'workspace_created', { workspaceId: workspace.id });

    return reply.status(201).send({ id: workspace.id, name, role: 'owner', createdAt: workspace.createdAt });
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

    const workspaces = [];
    for (const ws of wsDocs) {
      if (!ws) continue;
      let name;
      try { name = await mlkem.decryptMetadata(ws.nameEncrypted); } catch { name = null; }
      workspaces.push({
        id: ws.id,
        name,
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

  app.delete('/:id', {
    ...rateLimit,
    ...protect,
  }, async (req, reply) => {
    const workspaceId = req.params.id;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Check user is owner
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

    await WorkspaceMember.create({ workspaceId: invite.workspaceId, accountId: req.userId, role: invite.role, createdAt: new Date() });
    await WorkspaceInvite.updateOne({ tokenHash }, { $inc: { usedCount: 1 } });

    app.log.info({ workspaceId: invite.workspaceId, userId: req.userId, role: invite.role }, 'User joined workspace via invite');

    return reply.send({ workspaceId: invite.workspaceId, role: invite.role });
  });
}

module.exports = workspaceRoutes;
