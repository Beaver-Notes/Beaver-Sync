'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { NoteComment, NoteInvitation } = require('../models');

const BODY_LIMIT = parseInt(process.env.COMMENTS_BODY_LIMIT_BYTES ?? '8192', 10);

const NoteIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
const CommentIdSchema = z.string().uuid();

const baseRateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.COMMENTS_RATE_LIMIT_PER_MINUTE ?? '120', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

async function requireCollaborator(noteId, userId) {
  const invite = await NoteInvitation.findOne({ noteId, userId }).lean();
  return !!invite;
}

async function commentRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  app.get('/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    if (!await requireCollaborator(noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const comments = await NoteComment.find({ noteId }).sort({ createdAt: 1 }).lean();
    return reply.send({ comments });
  });

  app.post('/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    if (!await requireCollaborator(noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const { contentEncrypted, contentIv, mentions, threadId, anchorFrom, anchorTo, parentId } = req.body ?? {};
    if (!contentEncrypted || typeof contentEncrypted !== 'string' || !contentIv || typeof contentIv !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'contentEncrypted and contentIv are required.' });
    }

    let mentionList = [];
    if (mentions !== undefined) {
      if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== 'string')) {
        return reply.status(400).send({ error: 'validation_error', message: 'mentions must be an array of user IDs.' });
      }
      const collabRows = await NoteInvitation.find({ noteId }).lean();
      const collabIds = new Set(collabRows.map((c) => c.userId));
      mentionList = mentions.filter((m) => collabIds.has(m) && m !== req.userId);
    }

    const now = new Date().toISOString();
    const comment = await NoteComment.create({
      noteId,
      threadId: threadId || crypto.randomUUID(),
      authorId: req.userId,
      contentEncrypted,
      contentIv,
      anchorFrom: anchorFrom ?? null,
      anchorTo: anchorTo ?? null,
      resolved: false,
      parentId: parentId ?? null,
      mentions: JSON.stringify(mentionList),
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send({ comment: comment.toJSON() });
  });

  app.patch('/:commentId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { commentId } = req.params;
    const parsed = CommentIdSchema.safeParse(commentId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_comment_id', message: 'Invalid comment ID format.' });
    }

    const existing = await NoteComment.findById(commentId).lean();
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Comment not found.' });
    }

    if (existing.authorId !== req.userId) {
      return reply.status(403).send({ error: 'forbidden', message: 'Can only edit your own comments.' });
    }

    const { contentEncrypted, contentIv } = req.body ?? {};
    if (!contentEncrypted || typeof contentEncrypted !== 'string' || !contentIv || typeof contentIv !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'contentEncrypted and contentIv are required.' });
    }

    await NoteComment.updateOne(
      { _id: commentId },
      { $set: { contentEncrypted, contentIv, updatedAt: new Date().toISOString() } }
    );

    return reply.send({ success: true });
  });

  app.delete('/:commentId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { commentId } = req.params;
    const parsed = CommentIdSchema.safeParse(commentId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_comment_id', message: 'Invalid comment ID format.' });
    }

    const existing = await NoteComment.findById(commentId).lean();
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Comment not found.' });
    }

    if (existing.authorId !== req.userId) {
      return reply.status(403).send({ error: 'forbidden', message: 'Can only delete your own comments.' });
    }

    await NoteComment.deleteMany({ $or: [{ _id: commentId }, { parentId: commentId }] });
    return reply.send({ success: true });
  });

  app.patch('/:commentId/resolve', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { commentId } = req.params;
    const parsed = CommentIdSchema.safeParse(commentId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_comment_id', message: 'Invalid comment ID format.' });
    }

    const existing = await NoteComment.findById(commentId).lean();
    if (!existing) {
      return reply.status(404).send({ error: 'not_found', message: 'Comment not found.' });
    }

    if (!await requireCollaborator(existing.noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const newResolved = existing.resolved ? 0 : 1;
    await NoteComment.updateOne(
      { _id: commentId },
      { $set: { resolved: newResolved, updatedAt: new Date().toISOString() } }
    );

    return reply.send({ resolved: !!newResolved });
  });
}

module.exports = commentRoutes;
