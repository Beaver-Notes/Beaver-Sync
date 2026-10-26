'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { NoteComment, NoteCommentReaction, NoteInvitation } = require('../models');
const { query } = require('../db');
const { publishUserNotification } = require('../lib/user-notifications');
const { resolveNoteAccess } = require('../lib/note-access');

const BODY_LIMIT = parseInt(process.env.COMMENTS_BODY_LIMIT_BYTES ?? '8192', 10);

const NoteIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
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
  return resolveNoteAccess(noteId, userId, await NoteInvitation.findOne({ noteId, userId }).lean());
}

// Reactions: one row per (comment, user) holding that user's emoji list
// encrypted with the note key — same privacy as comment bodies (the server
// sees who reacted, never what). The emoji whitelist can only be enforced at
// render on the client; here we validate shape and size.
const HEX_IV = /^[0-9a-f]{24}$/i;
const HEX_BODY = /^[0-9a-f]+$/i;
const MAX_EMOJIS_CIPHERTEXT_HEX = 2048;

async function loadReactionsByComment(commentIds) {
  const map = new Map();
  if (!commentIds.length) return map;
  const rows = await NoteCommentReaction.find({ commentId: { $in: commentIds } }).lean();
  for (const r of rows) {
    if (!map.has(r.commentId)) map.set(r.commentId, []);
    map.get(r.commentId).push({
      userId: r.userId,
      emojisEncrypted: r.emojisEncrypted,
      emojisIv: r.emojisIv,
    });
  }
  return map;
}

// Reading and writing a comment of your own is open to every collaborator
// (editor or viewer), but resolving is a note-level decision: same gate as
// activity.js isEditor and collaboration.js requireNoteApprover.
function isEditor(invite) {
  return !!invite && invite.role === 'editor';
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

    // anchor_from/anchor_to were plaintext leaks: they told the server which
    // character range of a note a comment targets, even though the note and the
    // comment body stay unreadable to it. Anchors now live only inside the
    // encrypted payload, so they are neither selected nor returned.
    const comments = await NoteComment
      .find({
        noteId,
      }, {
        id: 1,
        noteId: 1,
        threadId: 1,
        authorId: 1,
        contentEncrypted: 1,
        contentIv: 1,
        resolved: 1,
        parentId: 1,
        mentions: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .sort({ createdAt: 1 })
      .lean();
    const reactionsByComment = await loadReactionsByComment(comments.map((c) => c.id));
    return reply.send({
      comments: comments.map((c) => ({
        ...c,
        reactions: reactionsByComment.get(c.id) ?? [],
      })),
    });
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

    const collabRows = await NoteInvitation.find({ noteId }).lean();
    const collabIds = new Set(collabRows.map((c) => c.userId));

    // anchorFrom/anchorTo used to be read here and stored in plaintext columns,
    // leaking which character range of the note each comment targets. Older
    // clients still send them, so they are silently ignored; the anchors are
    // now carried inside contentEncrypted and nowhere else.
    const { contentEncrypted, contentIv, mentions, threadId, parentId } = req.body ?? {};
    if (!contentEncrypted || typeof contentEncrypted !== 'string' || !contentIv || typeof contentIv !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'contentEncrypted and contentIv are required.' });
    }

    let mentionList = [];
    if (mentions !== undefined) {
      if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== 'string')) {
        return reply.status(400).send({ error: 'validation_error', message: 'mentions must be an array of user IDs.' });
      }
      mentionList = mentions.filter((m) => collabIds.has(m) && m !== req.userId);
    }

    const now = new Date().toISOString();
    const comment = await NoteComment.create({
      noteId,
      threadId: threadId || crypto.randomUUID(),
      authorId: req.userId,
      contentEncrypted,
      contentIv,
      resolved: false,
      parentId: parentId ?? null,
      mentions: JSON.stringify(mentionList),
      createdAt: now,
      updatedAt: now,
    });

    const payload = comment.toJSON();
    payload.reactions = [];

    // Tell the readers. A mentioned user gets its own kind so the client can
    // word it differently; the rest just hear a comment landed. A team note has
    // no note_invitations row per member, so the workspace's people are added
    // too (the invitation rows carry the workspace the note lives in).
    const mentioned = new Set(mentionList);
    const audience = new Set(collabIds);
    const noteWorkspaceId = collabRows.find((c) => c.workspaceId)?.workspaceId ?? null;
    if (noteWorkspaceId) {
      const { rows: readerRows } = await query(
        `SELECT account_id FROM workspace_members WHERE workspace_id = $1
         UNION SELECT owner_id FROM workspaces WHERE id = $1`,
        [noteWorkspaceId]
      );
      for (const row of readerRows) audience.add(row.account_id);
    }
    audience.delete(req.userId);
    for (const readerId of audience) {
      publishUserNotification({
        userId: readerId,
        kind: mentioned.has(readerId) ? 'mention' : 'comment',
        noteId,
        workspaceId: noteWorkspaceId,
        actorId: req.userId,
        excludeDeviceId: req.deviceId ?? null,
      }).catch(() => {});
    }
    return reply.status(201).send({ comment: payload });
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

    if (!await requireCollaborator(existing.noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
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

    if (!await requireCollaborator(existing.noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    // Only the caller's own comment. Deleting a thread must never cascade into
    // replies other users authored (they own their own words). Reaction rows
    // belong to this comment and go with it (FK ON DELETE CASCADE).
    await NoteComment.deleteOne({ _id: commentId });
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

    const invite = await requireCollaborator(existing.noteId, req.userId);
    if (!invite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }
    if (!isEditor(invite)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Only editors can resolve comments.' });
    }

    const newResolved = existing.resolved ? 0 : 1;
    await NoteComment.updateOne(
      { _id: commentId },
      { $set: { resolved: newResolved, updatedAt: new Date().toISOString() } }
    );

    return reply.send({ resolved: !!newResolved });
  });

  app.post('/:commentId/reactions', {
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

    // Any collaborator (viewer or editor) may react — same gate as reading.
    if (!await requireCollaborator(existing.noteId, req.userId)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }

    const emojisEncrypted = req.body?.emojisEncrypted;
    const emojisIv = req.body?.emojisIv;
    if (typeof emojisEncrypted !== 'string' || typeof emojisIv !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'emojisEncrypted and emojisIv are required.' });
    }

    // Caller's own row only; empty ciphertext = caller removed their last emoji.
    const own = await NoteCommentReaction.findOne({ commentId, userId: req.userId }).lean();
    if (emojisEncrypted === '') {
      if (own) await NoteCommentReaction.deleteOne({ _id: own.id });
    } else {
      if (
        !HEX_IV.test(emojisIv) ||
        !HEX_BODY.test(emojisEncrypted) ||
        emojisEncrypted.length % 2 !== 0 ||
        emojisEncrypted.length > MAX_EMOJIS_CIPHERTEXT_HEX
      ) {
        return reply.status(400).send({ error: 'validation_error', message: 'Invalid reaction payload.' });
      }
      if (own) {
        await NoteCommentReaction.updateOne(
          { _id: own.id },
          { $set: { emojisEncrypted, emojisIv } }
        );
      } else {
        await NoteCommentReaction.create({
          commentId,
          userId: req.userId,
          emojisEncrypted,
          emojisIv,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const rows = await NoteCommentReaction.find({ commentId }).lean();
    return reply.send({
      reactions: rows.map((r) => ({
        userId: r.userId,
        emojisEncrypted: r.emojisEncrypted,
        emojisIv: r.emojisIv,
      })),
    });
  });
}

module.exports = commentRoutes;
