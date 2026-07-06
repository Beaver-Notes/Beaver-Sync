'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { Account, CollaborationKey, NoteInvitation } = require('../models');
const mlkem = require('../lib/mlkem');

const BODY_LIMIT = parseInt(process.env.COLLAB_BODY_LIMIT_BYTES ?? '4096', 10);

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

async function ensureInvited(app, userId, noteId) {
  const invite = await NoteInvitation.findOne({ noteId, userId }).lean();
  if (!invite) {
    throw Object.assign(new Error('Not invited to this note.'), { statusCode: 403, code: 'forbidden' });
  }
  return invite;
}

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

    try {
      await ensureInvited(app, req.userId, noteId);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.code ?? 'internal_error', message: err.message });
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

    try {
      await ensureInvited(app, req.userId, noteId);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.code ?? 'internal_error', message: err.message });
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

    try {
      await ensureInvited(app, req.userId, noteId);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.code ?? 'internal_error', message: err.message });
    }

    const invitations = await NoteInvitation.find({ noteId }).lean();
    return reply.send({ noteId, invitations });
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

    try {
      await ensureInvited(app, req.userId, noteId);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.code ?? 'internal_error', message: err.message });
    }

    const result = await NoteInvitation.deleteOne({ noteId, userId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Invitation not found.' });
    }

    app.log.info({ noteId, removedUser: targetUserId, byUser: req.userId }, 'Invitation removed');

    return reply.send({ deleted: true, noteId, userId: targetUserId });
  });
}

module.exports = collaborationRoutes;
