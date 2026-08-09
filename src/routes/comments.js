'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { NoteComment, NoteInvitation, Account } = require('../models');

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

async function enrichAuthors(comments) {
  if (!comments.length) return comments;
  const authorIds = [...new Set(comments.map((c) => c.authorId))];
  const accounts = await Account.find({ _id: { $in: authorIds } }).lean();
  const byId = {};
  for (const a of accounts) {
    byId[a.id] = a.username || a.emailHmac || 'Anonymous';
  }
  return comments.map((c) => ({
    ...c,
    authorName: byId[c.authorId] || 'Anonymous',
  }));
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
    const enriched = await enrichAuthors(comments);

    return reply.send({ comments: enriched });
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

    const { content, threadId, anchorFrom, anchorTo, parentId } = req.body ?? {};
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.status(400).send({ error: 'validation_error', message: 'Content is required.' });
    }

    const now = new Date().toISOString();
    const comment = await NoteComment.create({
      noteId,
      threadId: threadId || crypto.randomUUID(),
      authorId: req.userId,
      content: content.trim(),
      anchorFrom: anchorFrom ?? null,
      anchorTo: anchorTo ?? null,
      resolved: false,
      parentId: parentId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send({ comment: { ...comment.toJSON(), authorName: 'You' } });
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

    const { content } = req.body ?? {};
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.status(400).send({ error: 'validation_error', message: 'Content is required.' });
    }

    await NoteComment.updateOne(
      { _id: commentId },
      { $set: { content: content.trim(), updatedAt: new Date().toISOString() } }
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

    // Delete the comment and all its replies
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
