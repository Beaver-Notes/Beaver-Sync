'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { getDb } = require('../db');
const { Account, NoteKey, NoteInvitation, NoteInviteLink } = require('../models');
const { validatePublicKey } = require('../lib/recipient-wrap');

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

  app.post('/keys/:noteId/recipients', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const { recipients } = req.body ?? {};
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return reply.status(400).send({ error: 'validation_error', message: 'recipients array is required.' });
    }
    if (recipients.length > 200) {
      return reply.status(400).send({ error: 'validation_error', message: 'Too many recipients.' });
    }

    for (const r of recipients) {
      if (!r || typeof r.userId !== 'string' || typeof r.wrappedKey !== 'string' || !r.wrappedKey) {
        return reply.status(400).send({ error: 'validation_error', message: 'Each recipient needs userId and wrappedKey.' });
      }
      const isCollab = await NoteInvitation.findOne({ noteId, userId: r.userId }).lean();
      if (!isCollab) {
        return reply.status(403).send({ error: 'forbidden', message: `User ${r.userId} is not a collaborator.` });
      }
      const recipientAccount = await Account.findById(r.userId, { kemPublicKey: 1 }).lean();
      if (!recipientAccount || !recipientAccount.kemPublicKey) {
        return reply.status(403).send({ error: 'keypair_required', message: `User ${r.userId} has not set up end-to-end encryption.` });
      }
    }

    const db = getDb();
    const outcome = db.transaction(() => {
      // Idempotent provisioning: the first writer wins. If the note already has
      // any key envelopes, refuse to overwrite so a late joiner or a concurrent
      // provisioner cannot rotate an existing note key.
      if (NoteKey.countDocuments({ noteId }) > 0) {
        return { existing: true, stored: 0 };
      }
      for (const r of recipients) {
        NoteKey.findOneAndUpdate(
          { noteId, userId: r.userId },
          { $set: { wrappedKey: r.wrappedKey } },
          { upsert: true }
        );
      }
      return { existing: false, stored: recipients.length };
    })();

    return reply.send({ noteId, stored: outcome.stored, noteHasKey: true, existing: outcome.existing });
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

    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const noteHasKey = (await NoteKey.countDocuments({ noteId })) > 0;
    if (!noteHasKey) {
      return reply.send({ noteId, wrappedKey: null, noteHasKey: false });
    }

    const row = await NoteKey.findOne({ noteId, userId: req.userId }).lean();
    if (!row) {
      // Caller is a collaborator but has no envelope yet — late joiner. They
      // must be re-wrapped by an owner, not provision a fresh key.
      return reply.send({ noteId, wrappedKey: null, noteHasKey: true });
    }
    return reply.send({ noteId, wrappedKey: row.wrappedKey, noteHasKey: true });
  });

  app.post('/keys/:noteId/recipient', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const { recipientUserId, wrappedKey } = req.body ?? {};
    if (!recipientUserId || typeof recipientUserId !== 'string' || !wrappedKey || typeof wrappedKey !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'recipientUserId and wrappedKey are required.' });
    }

    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const isCollab = await NoteInvitation.findOne({ noteId, userId: recipientUserId }).lean();
    if (!isCollab) {
      return reply.status(403).send({ error: 'forbidden', message: 'Recipient is not a collaborator.' });
    }

    const recipientAccount = await Account.findById(recipientUserId, { kemPublicKey: 1 }).lean();
    if (!recipientAccount || !recipientAccount.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: `User ${recipientUserId} has not set up end-to-end encryption.` });
    }

    await NoteKey.findOneAndUpdate(
      { noteId, userId: recipientUserId },
      { $set: { wrappedKey } },
      { upsert: true }
    );

    return reply.send({ noteId, recipientUserId, stored: true });
  });

  app.get('/public-keys/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }
    const existingInvite = await NoteInvitation.findOne({ noteId, userId: req.userId }).lean();
    if (!existingInvite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }
    const invitations = await NoteInvitation.find({ noteId }).lean();
    const userIds = [...new Set(invitations.map((inv) => inv.userId))];
    const accounts = userIds.length > 0
      ? await Account.find({ id: { $in: userIds } }, { id: 1, kemPublicKey: 1 }).lean()
      : [];
    const collaborators = accounts
      .filter((a) => a.kemPublicKey)
      .map((a) => ({ userId: a.id, kemPublicKey: a.kemPublicKey }));
    return reply.send({ noteId, collaborators });
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

    if (!target.kemPublicKey || !validatePublicKey(target.kemPublicKey)) {
      return reply.status(403).send({ error: 'keypair_required', message: 'The invited user has not set up end-to-end encryption yet.' });
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
      ? await Account.find({ id: { $in: userIds } }, { id: 1, username: 1, kemPublicKey: 1 }).lean()
      : [];
    const usernameMap = new Map(accounts.map((a) => [a.id, a.username]));
    const keypairMap = new Map(accounts.map((a) => [a.id, !!a.kemPublicKey]));

    const enriched = invitations.map((inv) => ({
      ...inv,
      username: usernameMap.get(inv.userId) || null,
      hasKeypair: keypairMap.get(inv.userId) || false,
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

    await NoteKey.deleteOne({ noteId, userId: targetUserId });

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

    const joiner = await Account.findById(req.userId, { kemPublicKey: 1 }).lean();
    if (!joiner || !joiner.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'Set up end-to-end encryption before joining.' });
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
