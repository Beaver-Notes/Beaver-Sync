'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { Account, CollaborationKey, NoteInvitation, NoteInviteLink } = require('../models');
const mlkem = require('../lib/mlkem');

const BODY_LIMIT = parseInt(process.env.COLLAB_BODY_LIMIT_BYTES ?? '4096', 10);

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const NoteIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);

const baseRateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.COLLAB_RATE_LIMIT_PER_MINUTE ?? '60', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function collaborationRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.post('/keys/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const existing = await CollaborationKey.findOne({ noteId }).lean();
    if (existing) {
      // Auto-grant editor access if the user has no invitation yet.
      // This handles the case where the key was created by another device
      // and the current user needs editor access to manage sharing.
      const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
      if (!existingInvite) {
        await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });
      }
      return reply.status(200).send({ noteId, exists: true });
    }

    const rawKey = crypto.randomBytes(32);
    const keyEncrypted = await mlkem.encryptMetadata(rawKey.toString('hex'));

    await CollaborationKey.create({ noteId, keyEncrypted, createdAt: new Date() });
    await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });

    app.log.info({ noteId, userId: req.userId }, 'Collaboration key generated');

    return reply.status(201).send({ noteId, key: rawKey.toString('hex'), exists: false });
  });

  app.get('/keys/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    // Auto-grant editor access if the user has no invitation yet.
    // This handles the case where the key was created by another device.
    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });
    }

    const record = await CollaborationKey.findOne({ noteId }).lean();
    if (!record) {
      return reply.status(404).send({ error: 'not_found', message: 'No collaboration key for this note.' });
    }

    const rawHex = await mlkem.decryptMetadata(record.keyEncrypted);
    return reply.send({ noteId, key: rawHex });
  });

  app.post('/invite/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const { username, email } = req.body ?? {};
    if ((!username || typeof username !== 'string') && (!email || typeof email !== 'string')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Provide username or email of the user to invite.' });
    }

    // Auto-grant editor access if the user has no invitation yet.
    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });
    }

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

    const existing = await NoteInvitation.findOne({ noteId, userId: target.id }).lean();
    if (existing) {
      return reply.send({ noteId, userId: target.id, role: existing.role, alreadyInvited: true });
    }

    const role = req.body.role === 'viewer' ? 'viewer' : 'editor';
    await NoteInvitation.create({ noteId, userId: target.id, invitedBy: req.userId, role, createdAt: new Date() });

    app.log.info({ noteId, invitedUser: target.id, byUser: req.userId }, 'User invited to note');

    return reply.status(201).send({ noteId, userId: target.id, role, alreadyInvited: false });
  });

  app.get('/invitations/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    // Auto-grant editor access if the user has no invitation yet.
    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });
    }

    const invitations = await NoteInvitation.find({ noteId }).lean();

    // Fetch usernames for all invited users
    const userIds = [...new Set(invitations.map((inv) => inv.userId))];
    const accounts = userIds.length > 0
      ? await Account.find({ id: { $in: userIds } }, { id: 1, username: 1 }).lean()
      : [];
    const usernameMap = new Map(accounts.map((a) => [a.id, a.username]));

    const enriched = invitations.map((inv) => ({
      ...inv,
      username: usernameMap.get(inv.userId) || null,
    }));

    return reply.send({ noteId, invitations: enriched });
  });

  app.delete('/invite/:noteId/:userId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;

    const parsedNote = NoteIdSchema.safeParse(noteId);
    if (!parsedNote.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const targetUserId = req.params.userId;
    if (!targetUserId || typeof targetUserId !== 'string') {
      return reply.status(400).send({ error: 'invalid_user_id', message: 'Invalid user ID.' });
    }

    // Auto-grant editor access if the user has no invitation yet.
    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      await NoteInvitation.create({ noteId, userId: req.userId, invitedBy: req.userId, role: 'editor', createdAt: new Date() });
    }

    const result = await NoteInvitation.deleteOne({ noteId, userId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Invitation not found.' });
    }

    app.log.info({ noteId, removedUser: targetUserId, byUser: req.userId }, 'Invitation removed');

    return reply.send({ deleted: true, noteId, userId: targetUserId });
  });

  // Generate invite link for a note
  app.post('/links/:noteId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId } = req.params;
    const { role = 'editor', requireApproval = false, expiresIn } = req.body;

    if (!['editor', 'viewer'].includes(role)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Role must be editor or viewer.' });
    }

    // Verify user is owner/editor of the note
    const membership = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!membership || membership.role !== 'editor') {
      return reply.status(403).send({ error: 'forbidden', message: 'Only editors can create invite links.' });
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);

    let expiresAt = null;
    if (expiresIn) {
      const ms = parseInt(expiresIn, 10);
      if (Number.isFinite(ms) && ms > 0) {
        expiresAt = new Date(Date.now() + ms).toISOString();
      }
    }

    const link = await NoteInviteLink.create({
      noteId,
      createdBy: req.userId,
      tokenHash,
      role,
      requireApproval: requireApproval ? 1 : 0,
      expiresAt,
    });

    return reply.status(201).send({
      id: link.id,
      token: rawToken,
      role,
      requireApproval: requireApproval,
      expiresAt,
      createdAt: link.createdAt,
    });
  });

  // List invite links for a note
  app.get('/links/:noteId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId } = req.params;

    const links = await NoteInviteLink.find({
      noteId,
      createdBy: req.userId,
      revoked: 0,
    }).sort({ createdAt: -1 }).lean();

    return reply.send({ links });
  });

  // Revoke an invite link
  app.delete('/links/:noteId/:linkId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId, linkId } = req.params;

    const link = await NoteInviteLink.findOne({ id: linkId, noteId, createdBy: req.userId }).lean();
    if (!link) {
      return reply.status(404).send({ error: 'not_found', message: 'Link not found.' });
    }

    await NoteInviteLink.updateOne({ id: linkId }, { $set: { revoked: 1 } });

    return reply.send({ success: true });
  });

  // Join a note via invite link
  app.post('/join/:token', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { token } = req.params;
    const tokenHash = hashToken(token);

    const link = await NoteInviteLink.findOne({ tokenHash, revoked: 0 }).lean();
    if (!link) {
      return reply.status(404).send({ error: 'not_found', message: 'Invalid or revoked invite link.' });
    }

    // Check expiry
    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return reply.status(410).send({ error: 'expired', message: 'This invite link has expired.' });
    }

    // Check if already a member
    const existing = await NoteInvitation.findOne({ noteId: link.noteId, userId: req.userId }).lean();
    if (existing) {
      return reply.send({ success: true, message: 'Already a member.', role: existing.role });
    }

    // Add as collaborator
    await NoteInvitation.create({
      noteId: link.noteId,
      userId: req.userId,
      invitedBy: link.createdBy,
      role: link.role,
    });

    return reply.status(201).send({
      success: true,
      noteId: link.noteId,
      role: link.role,
    });
  });
}

module.exports = collaborationRoutes;
