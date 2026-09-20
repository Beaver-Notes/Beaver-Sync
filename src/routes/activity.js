'use strict';

const { z } = require('zod');
const { query } = require('../db');
const { NoteActivity, NoteInvitation } = require('../models');

// Count cap, not a TTL: the client keeps at most 200 local entries per note
// (see `ACTIVITY_LOG_MAX_PER_NOTE` in the Rust client), so a count cap makes
// the shared timeline converge on the same bound and cannot grow unbounded for
// a note that is written to every minute. A TTL would still let a busy note
// accumulate arbitrarily many rows inside the window.
const ACTIVITY_LOG_MAX_PER_NOTE = 200;

const BODY_LIMIT = parseInt(process.env.ACTIVITY_BODY_LIMIT_BYTES ?? '8192', 10);

const NoteIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const EntryIdSchema = z.string().min(1).max(128);

const baseRateLimit = {
  config: {
    security: { public: false },
    rateLimit: {
      max: parseInt(process.env.ACTIVITY_RATE_LIMIT_PER_MINUTE ?? '120', 10),
      timeWindow: '1 minute',
    },
  },
  bodyLimit: BODY_LIMIT,
};

// Same gate as comments: any collaborator (editor or viewer) may read.
async function requireCollaborator(noteId, userId) {
  return NoteInvitation.findOne({ noteId, userId }).lean();
}

// Only a note-level editor may append. The owner is represented as an editor
// invitation, so this covers the owner too.
function isEditor(invite) {
  return !!invite && invite.role === 'editor';
}

async function activityRoutes(app) {
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

    const activity = await NoteActivity.find({ noteId }).sort({ createdAt: -1 }).lean();
    return reply.send({ activity });
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

    const invite = await requireCollaborator(noteId, req.userId);
    if (!invite) {
      return reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
    }
    if (!isEditor(invite)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Only editors can append activity.' });
    }

    const { id: entryId, kind, contentEncrypted, contentIv } = req.body ?? {};
    if (!EntryIdSchema.safeParse(entryId).success) {
      return reply.status(400).send({ error: 'validation_error', message: 'A valid entry id is required.' });
    }
    // `kind` is legacy: the client now keeps it inside the encrypted payload.
    // A legacy client may still send it; new writes omit it (stored NULL).
    if (kind !== undefined && (typeof kind !== 'string' || !kind)) {
      return reply.status(400).send({ error: 'validation_error', message: 'kind must be a non-empty string when provided.' });
    }
    if (!contentEncrypted || typeof contentEncrypted !== 'string' || !contentIv || typeof contentIv !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'contentEncrypted and contentIv are required.' });
    }

    const now = new Date().toISOString();
    try {
      await NoteActivity.create({
        id: entryId,
        noteId,
        authorId: req.userId,
        kind: kind ?? null,
        contentEncrypted,
        contentIv,
        createdAt: now,
      });
    } catch (err) {
      // Retries re-send the same entry id: the primary key makes this idempotent
      // so a network retry never fails or duplicates.
      if (!isUniqueViolation(err)) throw err;
      return reply.status(200).send({ success: true });
    }

    await pruneActivity(noteId);

    return reply.status(201).send({
      activity: { id: entryId, noteId, authorId: req.userId, kind: kind ?? null, contentEncrypted, contentIv, createdAt: now },
    });
  });
}

function isUniqueViolation(err) {
  return err?.code === '23505' || /duplicate key|unique constraint/i.test(String(err?.message ?? ''));
}

// Keep only the newest ACTIVITY_LOG_MAX_PER_NOTE rows for this note. Scoped to
// note_id, so pruning one note never touches another note's rows.
async function pruneActivity(noteId) {
  await query(`
    DELETE FROM note_activity
     WHERE note_id = $1
       AND id IN (
         SELECT id FROM note_activity
          WHERE note_id = $1
          ORDER BY created_at DESC, id DESC
          OFFSET $2
       )
  `, [noteId, ACTIVITY_LOG_MAX_PER_NOTE]);
}

module.exports = activityRoutes;
