'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { transaction, query } = require('../db');
const { Account, NoteKey, NoteInvitation, NoteInviteLink } = require('../models');
const { publishUserNotification } = require('../lib/user-notifications');
const { noteAudienceIds, resolveNoteAccess } = require('../lib/note-access');
const {
  addRecipientsIfAbsent,
  rotateNoteKey,
  noteHasAnyKey,
  getEnvelopesForUser,
  createKeyDistributionRequest,
  listKeyDistributionRequests,
  deleteKeyDistributionRequest,
} = require('../repositories/noteKeys');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { findAccountByUsername } = require('../repositories/account');
const { audit } = require('../lib/audit');
const { sendNoteInviteEmail } = require('../email');
const { getFlags } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');
const { resolveEffectivePlan } = require('../lib/plan-resolution');
const { emailVerificationFields } = require('../lib/email-verification');

const BODY_LIMIT = parseInt(process.env.COLLAB_BODY_LIMIT_BYTES ?? '4096', 10);

// Outbound note shares/invites require a plan with the shareNotes capability
// (spec: free users can receive shared notes as collaborators but cannot
// invite/share outbound). Reads the plans.js flag so the matrix stays the single
// source of truth -- a hardcoded plan check here silently drifts from it.
// Deliberately NOT applied to the /keys/* routes: a free user provisioning the
// first key for their OWN note goes through POST /keys/:noteId/recipients, so
// gating those would leave free users unable to open anything they create.
async function requirePaidSharePlan(req, reply) {
  if (isEnterpriseMode()) return true;
  const { plan } = await resolveEffectivePlan(req);
  if (!getFlags(plan).shareNotes) {
    reply.status(403).send({
      error: 'plan_upgrade_required',
      message: 'Sharing notes requires a paid plan.',
    });
    return false;
  }
  return true;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// LINK_TOKEN_SECRET lets the server recompute a link's raw token from its id
// (only sha256(token) is stored), so GET /links can re-show the URL after a
// restart or on another device. Unset ⇒ random tokens, URLs stay session-only.
// Set once (openssl rand -hex 32); rotating the secret invalidates derived links.
function derivedLinkToken(linkId) {
  const secret = process.env.LINK_TOKEN_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(linkId).digest('hex');
}

// noteIds are claim keys for unclaimed notes; floor blocks brute-forceable short IDs (M-2)
const NoteIdSchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/);

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

// Unpushed-note bootstrap claims are the only path that trusts a client-named
// workspace, so they get a tighter per-account budget. The check runs after
// auth (in `enforcePreclaimLimit`) and only when the note is not yet
// server-registered, so ordinary invites/links for a registered note are never
// charged against it. The bucket is keyed per account (not per note), so
// guessing fresh note ids does not buy a new allowance.
const BOOTSTRAP_RATE_LIMIT_MAX = parseInt(
  process.env.COLLAB_BOOTSTRAP_RATE_LIMIT_PER_MINUTE ?? '10',
  10
);

async function noteIsServerRegistered(noteId) {
  const { rows } = await query(`
    SELECT 1 FROM sync_document_state WHERE note_id = $1
    UNION ALL
    SELECT 1 FROM yjs_doc_updates WHERE note_id = $1
    LIMIT 1
  `, [noteId]);
  return rows.length > 0;
}

// A note belongs to the workspace(s) that already hold its journal/snapshot
// rows. Bootstrap self-grant is only allowed to an owner/editor of such a
// workspace — knowing a fresh noteId is not ownership.
//
// A note that has NOT been pushed to the server yet (no row anywhere) has no
// provable owner from the server's point of view, but its legitimate owner must
// still be able to share it. The client therefore names the workspace it is
// sharing from (`workspaceId`): the claim is granted only when (a) the note is
// absent from EVERY workspace, and (b) the caller is the workspace OWNER (not
// merely an editor) of that workspace. A non-member is refused, and a member of
// a different workspace cannot steal a note that already lives in someone
// else's (the "absent everywhere" guard). Any row this leaves behind is purged
// when the note first registers to its real workspace (repositories/noteClaims).
async function callerOwnsNote(userId, noteId, workspaceId = null) {
  // A workspace's owner_id is authoritative even when that workspace has no
  // workspace_members row (a personal workspace), so both are accepted here or
  // the owner would be locked out of their own unpushed note.
  const { rows } = await query(`
    SELECT 1 FROM sync_document_state s
      JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.note_id = $1 AND w.owner_id = $2
    UNION ALL
    SELECT 1 FROM sync_document_state s
      JOIN workspace_members m ON m.workspace_id = s.workspace_id
    WHERE s.note_id = $1 AND m.account_id = $2 AND m.role IN ('owner', 'editor')
    UNION ALL
    SELECT 1 FROM yjs_doc_updates u
      JOIN workspaces w ON w.id = u.workspace_id
    WHERE u.note_id = $1 AND w.owner_id = $2
    UNION ALL
    SELECT 1 FROM yjs_doc_updates u
      JOIN workspace_members m ON m.workspace_id = u.workspace_id
    WHERE u.note_id = $1 AND m.account_id = $2 AND m.role IN ('owner', 'editor')
    LIMIT 1
  `, [noteId, userId]);
  if (rows.length > 0) return true;

  if (!workspaceId || typeof workspaceId !== 'string') return false;

  const claimed = await query(`
    SELECT 1 FROM sync_document_state WHERE note_id = $1
    UNION ALL
    SELECT 1 FROM yjs_doc_updates WHERE note_id = $1
    LIMIT 1
  `, [noteId]);
  if (claimed.rows.length > 0) return false;

  const member = await query(`
    SELECT 1 FROM workspaces
    WHERE id = $1 AND owner_id = $2
    UNION ALL
    SELECT 1 FROM workspace_members
    WHERE workspace_id = $1 AND account_id = $2 AND role = 'owner'
    LIMIT 1
  `, [workspaceId, userId]);
  return member.rows.length > 0;
}

// Join-time workspace routing: a collaborator joining via invite link or
// approval must land in the workspace the note lives in, or clients open the
// note under the wrong workspace. Returns null when nothing resolves so the
// join still succeeds with the previous NULL behavior.
async function resolveNoteWorkspaceId(noteId, preferredUserId = null) {
  if (preferredUserId) {
    const { rows } = await query(
      `SELECT workspace_id FROM note_invitations WHERE note_id = $1 AND user_id = $2 AND workspace_id IS NOT NULL LIMIT 1`,
      [noteId, preferredUserId]
    );
    if (rows[0]?.workspace_id) return rows[0].workspace_id;
  }
  const { rows: anyRows } = await query(
    `SELECT workspace_id FROM note_invitations WHERE note_id = $1 AND workspace_id IS NOT NULL LIMIT 1`,
    [noteId]
  );
  if (anyRows[0]?.workspace_id) return anyRows[0].workspace_id;
  const { rows: stateRows } = await query(
    `SELECT workspace_id FROM sync_document_state WHERE note_id = $1 LIMIT 1`,
    [noteId]
  );
  if (stateRows[0]?.workspace_id) return stateRows[0].workspace_id;
  const { rows: journalRows } = await query(
    `SELECT workspace_id FROM yjs_doc_updates WHERE note_id = $1 ORDER BY created_at DESC, ts DESC LIMIT 1`,
    [noteId]
  );
  return journalRows[0]?.workspace_id ?? null;
}

// Gate access to a note's collaboration context. The caller must already be a
// collaborator. With `bootstrap: true` (invite creation only) a caller may
// claim a note that has no collaborators yet - this is how the user who
// created a note first invites people. The claim is atomic and requires
// provable ownership, so a stranger who guesses a noteId cannot self-grant.
async function requireCollaborator(reply, noteId, userId, { bootstrap = false, workspaceId = null, req = null } = {}) {
  const existing = await NoteInvitation.findOne({ noteId, userId }).lean();
  if (existing) return existing;

  if (bootstrap) {
    const owns = await callerOwnsNote(userId, noteId, workspaceId);
    // Pre-claim attempts are auditable even when refused; the note owner naming
    // their own workspace is indistinguishable from a squatter until the note
    // registers, so record both outcomes.
    if (req) audit(req, 'note_claim_attempt', { noteId, workspaceId, granted: owns });
    if (!owns) {
      reply.status(403).send({
        error: 'note_ownership_required',
        message: 'Only the owner of the workspace that owns this note can claim it.',
      });
      return null;
    }

    const now = new Date().toISOString();
    const claimed = await transaction(async (client) => {
      // Serialize claims per note so two concurrent bootstraps cannot both
      // create an editor (or race the primary key into a 500).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`note-collab:${noteId}`]);
      const { rows } = await client.query('SELECT 1 FROM note_invitations WHERE note_id = $1 LIMIT 1', [noteId]);
      if (rows.length > 0) return false;
      await client.query(
        `INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at, workspace_id)
         VALUES ($1, $2, $2, 'editor', $3, $4) ON CONFLICT DO NOTHING`,
        [noteId, userId, now, typeof workspaceId === 'string' && workspaceId ? workspaceId : null]
      );
      return true;
    });
    if (claimed) {
      return await NoteInvitation.findOne({ noteId, userId }).lean();
    }
    // A concurrent claimant won; if it was us, the membership already exists.
    const mine = await NoteInvitation.findOne({ noteId, userId }).lean();
    if (mine) return mine;
  }

  reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
  return null;
}

// Only a note's editors (its owner is represented as an editor invitation) may
// see and act on join requests. A viewer collaborator is not an approver.
async function requireNoteApprover(reply, noteId, userId) {
  const membership = await requireCollaborator(reply, noteId, userId);
  if (!membership) return null;
  if (membership !== true && membership.role !== 'editor') {
    reply.status(403).send({ error: 'forbidden', message: 'Only editors can manage join requests.' });
    return null;
  }
  return membership;
}

async function collaborationRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };

  // One strict bucket per account for genuinely-unpushed-note bootstraps. It is
  // checked after authentication and only for unregistered notes, so a paid
  // user creating ordinary invites stays on the normal collaboration budget.
  const preclaimLimit = app.createRateLimit({
    max: BOOTSTRAP_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => `preclaim:${req.userId}`,
  });

  async function enforcePreclaimLimit(req, reply) {
    if (await noteIsServerRegistered(req.params.noteId)) return;
    const result = await preclaimLimit(req);
    if (result.isExceeded) {
      return reply.status(429).send({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please slow down.',
      });
    }
  }

  app.post('/keys/:noteId/recipients', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;

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
    }

    const userIds = [...new Set(recipients.map((r) => r.userId))];
    const [collabRows, accountRows] = await Promise.all([
      NoteInvitation.find({ noteId, userId: { $in: userIds } }, { userId: 1 }).lean(),
      Account.find({ id: { $in: userIds } }, { id: 1, kemPublicKey: 1 }).lean(),
    ]);
    // A workspace member reads the note by membership, so they are a legitimate
    // envelope recipient even without an invitation row of their own.
    const collaboratorIds = new Set([
      ...collabRows.map((c) => c.userId),
      ...(await noteAudienceIds(noteId)),
    ]);
    const keypairIds = new Set(accountRows.filter((a) => a.kemPublicKey).map((a) => a.id));

    for (const r of recipients) {
      if (!collaboratorIds.has(r.userId)) {
        return reply.status(403).send({ error: 'forbidden', message: `User ${r.userId} is not a collaborator.` });
      }
      if (!keypairIds.has(r.userId)) {
        return reply.status(403).send({ error: 'keypair_required', message: `User ${r.userId} has not set up end-to-end encryption.` });
      }
    }

    // Only a caller that already holds the note key (or the first provisioner
    // on a keyless note) may wrap envelopes. Without this gate a collaborator
    // with no envelope could insert one wrapping a fresh key and rotate (split)
    // the note key. Writes stay add-only per (noteId, userId, deviceId), so a
    // late joiner or newly-linked device can be re-wrapped without overwriting.
    if (await noteHasAnyKey(noteId)) {
      const { rowCount } = await query(
        'SELECT 1 FROM note_keys WHERE note_id = $1 AND user_id = $2 LIMIT 1',
        [noteId, req.userId]
      );
      if (rowCount === 0) {
        return reply.send({ noteId, stored: 0, noteHasKey: true, existing: true });
      }
    }

    const stored = await addRecipientsIfAbsent(noteId, recipients);
    return reply.send({
      noteId,
      stored,
      noteHasKey: true,
      existing: stored < recipients.length,
    });
  });

  // L8: rotate a note's key after a collaborator is removed. Only a caller that
  // currently holds an envelope may rotate (the same key-holder gate as
  // /recipients). The new set atomically REPLACES every envelope, so the removed
  // user's devices lose theirs, an old envelope cannot be replayed, and the
  // remaining collaborators are re-wrapped under the new generation. The server
  // stays zero-knowledge: it only stores opaque wrapped strings and records the
  // generation.
  app.post('/keys/:noteId/rotate', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;
    if (membership !== true && membership.role !== 'editor') {
      return reply.status(403).send({ error: 'forbidden', message: 'Only editors can rotate the note key.' });
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
    }

    // Key-holder gate: without a current envelope the caller cannot know the
    // note key, so it may not rotate/split it. This also makes a replay by an
    // already-removed member (whose envelope was deleted) impossible.
    const { rowCount } = await query(
      'SELECT 1 FROM note_keys WHERE note_id = $1 AND user_id = $2 LIMIT 1',
      [noteId, req.userId]
    );
    if (rowCount === 0) {
      return reply.status(403).send({
        error: 'forbidden',
        message: 'Only a key-holding collaborator can rotate the note key.',
      });
    }

    // Every recipient must be a *current* collaborator with an E2E keypair, so a
    // removed user cannot be re-wrapped back in by a malicious or stale caller.
    const userIds = [...new Set(recipients.map((r) => r.userId))];
    const [collabRows, accountRows] = await Promise.all([
      NoteInvitation.find({ noteId, userId: { $in: userIds } }, { userId: 1 }).lean(),
      Account.find({ id: { $in: userIds } }, { id: 1, kemPublicKey: 1 }).lean(),
    ]);
    // A workspace member reads the note by membership, so they are a legitimate
    // envelope recipient even without an invitation row of their own.
    const collaboratorIds = new Set([
      ...collabRows.map((c) => c.userId),
      ...(await noteAudienceIds(noteId)),
    ]);
    const keypairIds = new Set(accountRows.filter((a) => a.kemPublicKey).map((a) => a.id));
    for (const r of recipients) {
      if (!collaboratorIds.has(r.userId)) {
        return reply.status(403).send({ error: 'forbidden', message: `User ${r.userId} is not a collaborator.` });
      }
      if (!keypairIds.has(r.userId)) {
        return reply.status(403).send({ error: 'keypair_required', message: `User ${r.userId} has not set up end-to-end encryption.` });
      }
    }

    const result = await rotateNoteKey(noteId, recipients);
    app.log.info(
      { noteId, byUser: req.userId, generation: result.generation, recipients: recipients.length },
      'Note key rotated'
    );
    return reply.send({
      noteId,
      stored: result.stored,
      generation: result.generation,
      noteHasKey: true,
    });
  });

  // Bootstrap a note's collaboration context by registering the caller as the
  // owner collaborator (when the note has no collaborators yet) and returning
  // the key envelope status. Mirrors the GET handler's response shape so a
  // fresh note reports { noteHasKey: false } rather than 403/404.
  app.post('/keys/:noteId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    // The client names the workspace it is sharing from so an unpushed note can
    // be attributed to its owner (see callerOwnsNote). Without it the owner of a
    // personal workspace cannot bootstrap their own note.
    const bootstrapWorkspaceId =
      typeof req.body?.workspaceId === 'string' ? req.body.workspaceId
        : typeof req.query?.workspaceId === 'string' ? req.query.workspaceId
          : null;
    const membership = await requireCollaborator(reply, noteId, req.userId, {
      bootstrap: true,
      workspaceId: bootstrapWorkspaceId,
      req,
    });
    if (!membership) return;

    const noteHasKey = (await NoteKey.countDocuments({ noteId })) > 0;
    if (!noteHasKey) {
      return reply.send({ noteId, wrappedKey: null, noteHasKey: false });
    }

    // Scalar convenience for older clients: the caller's own device envelope,
    // else the account-level `default` one, else null. Never a foreign device's.
    const envelopes = await getEnvelopesForUser(noteId, req.userId);
    const rows = envelopes.rows;
    const own = req.sessionDeviceId
      ? rows.find((r) => r.device_id === req.sessionDeviceId)
      : null;
    const legacy = rows.find((r) => r.device_id === 'default');
    const wrappedKey = own?.wrapped_key ?? legacy?.wrapped_key ?? null;
    return reply.send({ noteId, wrappedKey, noteHasKey: true });
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

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;

    const anyKey = await noteHasAnyKey(noteId);
    if (!anyKey) {
      // Fresh note: no envelopes at all. The frontend (later task) detects a
      // fresh note via noteHasKey === false and provisions the first key.
      return reply.send({ noteId, wrappedKeys: [], noteHasKey: false });
    }

    const envelopes = await getEnvelopesForUser(noteId, req.userId);
    if (envelopes.rowCount === 0) {
      // Caller is a collaborator but has no envelope yet — late joiner. They
      // must be re-wrapped by an owner, not provision a fresh key.
      return reply.send({ noteId, wrappedKeys: [], noteHasKey: true });
    }
    return reply.send({
      noteId,
      wrappedKeys: envelopes.rows.map((e) => ({ deviceId: e.device_id, wrappedKey: e.wrapped_key })),
      noteHasKey: true,
    });
  });

  // Queue a request for an existing online device of the same account to
  // re-wrap the note's content key for a newly-linked device. The caller must
  // be a collaborator on the note; the request is scoped to their own account
  // (user_id = req.userId) so only their devices will poll and fulfill it.
  app.post('/keys/:noteId/distribute-request', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const { targetDeviceId } = req.body ?? {};
    if (!targetDeviceId || typeof targetDeviceId !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'targetDeviceId required.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;

    await createKeyDistributionRequest({ noteId, userId: req.userId, targetDeviceId });
    return reply.send({ ok: true });
  });

  // List pending key-distribution requests for the caller's own account.
  app.get('/keys/distribute-requests', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const requests = await listKeyDistributionRequests(req.userId);
    return reply.send({
      requests: requests.map((r) => ({
        noteId: r.note_id,
        userId: r.user_id,
        targetDeviceId: r.target_device_id,
        requestedAt: r.requested_at,
      })),
    });
  });

  // Clear a pending key-distribution request once a device has fulfilled it.
  app.delete('/keys/distribute-requests/:noteId/:targetDeviceId', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const parsed = NoteIdSchema.safeParse(req.params.noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }
    const { targetDeviceId } = req.params;
    if (!targetDeviceId || typeof targetDeviceId !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'targetDeviceId required.' });
    }

    const membership = await requireCollaborator(reply, req.params.noteId, req.userId);
    if (!membership) return;

    await deleteKeyDistributionRequest({ noteId: req.params.noteId, userId: req.userId, targetDeviceId });
    return reply.send({ ok: true });
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

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;

    const isCollab = await NoteInvitation.findOne({ noteId, userId: recipientUserId }).lean();
    // Workspace membership is the same grant for a team note: it carries an
    // invitation row only for its creator.
    const inAudience = isCollab || (await noteAudienceIds(noteId)).includes(recipientUserId);
    if (!inAudience) {
      return reply.status(403).send({ error: 'forbidden', message: 'Recipient is not a collaborator.' });
    }

    const recipientAccount = await Account.findById(recipientUserId, { kemPublicKey: 1 }).lean();
    if (!recipientAccount || !recipientAccount.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: `User ${recipientUserId} has not set up end-to-end encryption.` });
    }

    // Mirror storeRecipients idempotency: if the note already has any key
    // envelopes, refuse to overwrite so no caller can rotate an existing key.
    let outcome;
    if (await NoteKey.countDocuments({ noteId }) > 0) {
      outcome = { existing: true, stored: false };
    } else {
      await NoteKey.findOneAndUpdate(
        { noteId, userId: recipientUserId },
        { $set: { wrappedKey } },
        { upsert: true }
      );
      outcome = { existing: false, stored: true };
    }

    return reply.send({ noteId, recipientUserId, stored: outcome.stored, existing: outcome.existing, noteHasKey: true });
  });

  app.get('/public-keys/:noteId', {
    ...baseRateLimit,
    ...protect,
    // Bootstrap widening on this route lets an owner self-claim an unpushed
    // note, so blind unregistered-note probes get the same budget as invites.
    preHandler: [app.authenticate, enforcePreclaimLimit],
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }
    const membership = await requireCollaborator(reply, noteId, req.userId, {
      bootstrap: true,
      workspaceId: req.query?.workspaceId ?? null,
      req,
    });
    if (!membership) return;
    const invitations = await NoteInvitation.find({ noteId }).lean();
    // Team notes carry an invitation row only for their creator; the rest of the
    // workspace reads them by membership, so they need envelopes too.
    const userIds = [
      ...new Set([...invitations.map((inv) => inv.userId), ...(await noteAudienceIds(noteId))]),
    ];
    const accounts = userIds.length > 0
      ? await Account.find({ id: { $in: userIds } }, { id: 1, username: 1, kemPublicKey: 1, deviceKeys: 1 }).lean()
      : [];
    // One entry per user, carrying the role they were actually invited with.
    // An unknown/missing role must never widen to 'editor', so it falls back
    // to the least privileged value instead.
    const roleByUser = new Map(
      invitations.map((inv) => [inv.userId, inv.role === 'editor' ? 'editor' : 'viewer'])
    );
    // A member without an invitation takes the workspace's role for the note.
    for (const id of userIds) {
      if (roleByUser.has(id)) continue;
      const access = await resolveNoteAccess(noteId, id);
      if (access) roleByUser.set(id, access.role);
    }
    // Which (user, device) pairs already hold an envelope: lets a key-holding
    // collaborator re-wrap only for the devices still missing one. Existence
    // only; no key material is ever exposed. A legacy account-level row
    // (device_id NULL) is read by any device of that account, so it covers the
    // 'default' device the client stores under.
    const { rows: envelopeRows } = await query(
      'SELECT user_id, device_id FROM note_keys WHERE note_id = $1',
      [noteId]
    );
    const wrapped = new Set();
    const legacyHolders = new Set();
    const heldDevices = new Map();
    for (const r of envelopeRows) {
      if (r.device_id == null) {
        legacyHolders.add(r.user_id);
        continue;
      }
      wrapped.add(`${r.user_id}:${r.device_id}`);
      const set = heldDevices.get(r.user_id) || new Set();
      set.add(r.device_id);
      heldDevices.set(r.user_id, set);
    }

    // Flat, one entry per device: the client's key fan-out
    // (`src/utils/crypto/note-key.js`) reads `kemPublicKey`/`deviceId` off each
    // entry, so nesting them per user would silently disable note-key
    // provisioning. `username`/`role` ride along so the collaborator list can
    // name people and honour the role they were actually invited with.
    const collaborators = [];
    for (const a of accounts) {
      const username = a.username || null;
      const role = roleByUser.get(a.id) || 'viewer';
      const declared = Array.isArray(a.deviceKeys) ? a.deviceKeys.filter((d) => d && d.deviceId) : [];
      // deviceId -> public key. An account with no declared device keys has a
      // single implicit 'default' device, which is where a device-less client
      // stores (and reads back) its envelope.
      const devices = new Map();
      for (const d of declared) devices.set(d.deviceId, d.publicKey ?? null);
      if (devices.size === 0 && a.kemPublicKey) devices.set('default', a.kemPublicKey);
      // A device holding an envelope but absent from `device_keys` (its keypair
      // row was replaced, or the envelope predates device registration) is
      // still a member device: list it so the holder stays discoverable.
      for (const deviceId of heldDevices.get(a.id) || []) {
        if (!devices.has(deviceId)) devices.set(deviceId, null);
      }
      if (devices.size === 0) continue;
      for (const [deviceId, publicKey] of devices) {
        collaborators.push({
          userId: a.id,
          username,
          role,
          deviceId,
          kemPublicKey: publicKey,
          hasEnvelope: wrapped.has(`${a.id}:${deviceId}`)
            || (deviceId === 'default' && legacyHolders.has(a.id)),
        });
      }
    }
    return reply.send({ noteId, collaborators });
  });

  app.post('/invite/:noteId', {
    ...baseRateLimit,
    preHandler: [app.authenticate, enforcePreclaimLimit],
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    // 02.3: verification is advisory (never enforced by any pipeline); report
    // the state in the success response instead of blocking the invite.
    const inviterAcct = await Account.findById(req.userId, { emailVerified: 1 }).lean();
    const verification = emailVerificationFields(Boolean(inviterAcct?.emailVerified));

    if (!(await requirePaidSharePlan(req, reply))) return;

    const { username, email, workspaceId } = req.body ?? {};
    if ((!username || typeof username !== 'string') && (!email || typeof email !== 'string')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Provide username or email of the user to invite.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId, {
      bootstrap: true,
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
      req,
    });
    if (!membership) return;

    let target = null;
    if (username) {
      const normalized = username.trim().toLowerCase();
      const resolved = await findAccountByUsername(normalized);
      if (resolved.ambiguous) {
        return reply.status(409).send({ error: 'ambiguous_username', message: 'Multiple accounts use that username. Invite by email instead.' });
      }
      target = resolved.account;
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
      return reply.send({ noteId, userId: target.id, role: existing.role, alreadyInvited: true, ...verification });
    }

    const role = req.body.role === 'viewer' ? 'viewer' : 'editor';
    await NoteInvitation.create({
      noteId,
      userId: target.id,
      invitedBy: req.userId,
      role,
      workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : null,
      createdAt: new Date(),
    });

    // The invited person's clients hear about it now; the inviter's other
    // devices are skipped when the request carries a device id.
    publishUserNotification({
      userId: target.id,
      kind: 'note_shared',
      noteId,
      workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : null,
      actorId: req.userId,
      excludeDeviceId: req.deviceId ?? null,
    }).catch(() => {});

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await NoteInviteLink.create({
      tokenHash,
      noteId,
      role,
      createdBy: req.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    });

    const inviter = await Account.findById(req.userId, { username: 1 }).lean();
    sendNoteInviteEmail(app, target.id, {
      inviterName: inviter?.username || 'Someone',
      noteTitle: noteId, // title is encrypted server-side; pass noteId as a stable label
      inviteUrl: `${process.env.INVITE_URL_SCHEME ?? 'beaver-notes://'}join/${rawToken}`,
      expiresIn: '7 days',
    });

    app.log.info({ noteId, invitedUser: target.id, byUser: req.userId }, 'User invited to note');

    return reply.status(201).send({ noteId, userId: target.id, role, alreadyInvited: false, ...verification });
  });

  app.get('/invitations/:noteId', {
    ...baseRateLimit,
    ...protect,
    // Same bootstrap widening as /public-keys: bound the unregistered-note
    // claim attempts per account.
    preHandler: [app.authenticate, enforcePreclaimLimit],
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId, {
      bootstrap: true,
      workspaceId: req.query?.workspaceId ?? null,
      req,
    });
    if (!membership) return;

    const invitations = await NoteInvitation.find({ noteId }).lean();

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

    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;
    if (membership !== true && membership.role !== 'editor') {
      return reply.status(403).send({ error: 'forbidden', message: 'Only editors can remove collaborators.' });
    }

    const result = await NoteInvitation.deleteOne({ noteId, userId: targetUserId });
    if (result.deletedCount === 0) {
      return reply.status(404).send({ error: 'not_found', message: 'Invitation not found.' });
    }

    await NoteKey.deleteMany({ noteId, userId: targetUserId });

    app.log.info({ noteId, removedUser: targetUserId, byUser: req.userId }, 'Invitation removed');

    return reply.send({ deleted: true, noteId, userId: targetUserId });
  });

  app.post('/links/:noteId', { ...baseRateLimit, preHandler: [app.authenticate, enforcePreclaimLimit] }, async (req, reply) => {
    const { noteId } = req.params;
    const { role = 'editor', requireApproval = false, expiresIn, workspaceId } = req.body;

    const linkAcct = await Account.findById(req.userId, { emailVerified: 1 }).lean();
    const verification = emailVerificationFields(Boolean(linkAcct?.emailVerified));

    if (!(await requirePaidSharePlan(req, reply))) return;

    if (!['editor', 'viewer'].includes(role)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Role must be editor or viewer.' });
    }

    // The note's owner (and an editor of the owning workspace) may create links
    // even before it has been shared: bootstrap recognises the caller as the
    // note's editor collaborator (see callerOwnsNote). A viewer stays refused —
    // unless they genuinely own the note's workspace, which can happen when a
    // stale or accidental 'viewer' row exists for the owner (for example the
    // owner joined their own share link), so ownership is re-checked explicitly.
    const resolvedWorkspaceId = typeof workspaceId === 'string' ? workspaceId : null;
    const membership = await requireCollaborator(reply, noteId, req.userId, {
      bootstrap: true,
      workspaceId: resolvedWorkspaceId,
      req,
    });
    if (!membership) return;
    if (membership.role !== 'editor') {
      const ownsNote = await callerOwnsNote(req.userId, noteId, resolvedWorkspaceId);
      if (!ownsNote) {
        return reply.status(403).send({ error: 'forbidden', message: 'Only editors can create invite links.' });
      }
    }

    const linkId = crypto.randomUUID();
    const rawToken = derivedLinkToken(linkId) ?? generateToken();
    const tokenHash = hashToken(rawToken);

    let expiresAt = null;
    if (expiresIn) {
      const ms = parseInt(expiresIn, 10);
      if (Number.isFinite(ms) && ms > 0) {
        expiresAt = new Date(Date.now() + ms).toISOString();
      }
    }

    const link = await NoteInviteLink.create({
      id: linkId,
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
      ...verification,
    });
  });

  app.get('/links/:noteId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId } = req.params;

    const links = await NoteInviteLink.find({
      noteId,
      createdBy: req.userId,
      revoked: 0,
    }).sort({ createdAt: -1 }).lean();

    // Re-shoot derived tokens for the caller: verified against the stored hash
    // so legacy random links (and email invites) simply come back tokenless.
    return reply.send({
      links: links.map((l) => {
        const derived = derivedLinkToken(l.id);
        if (derived && hashToken(derived) === l.tokenHash) {
          return { ...l, token: derived };
        }
        return l;
      }),
    });
  });

  app.delete('/links/:noteId/:linkId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId, linkId } = req.params;

    const link = await NoteInviteLink.findOne({ id: linkId, noteId, createdBy: req.userId }).lean();
    if (!link) {
      return reply.status(404).send({ error: 'not_found', message: 'Link not found.' });
    }

    await NoteInviteLink.updateOne({ id: linkId }, { $set: { revoked: 1 } });

    return reply.send({ success: true });
  });

  app.post('/join/:token', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { token } = req.params;
    const tokenHash = hashToken(token);

    const link = await NoteInviteLink.findOne({ tokenHash, revoked: 0 }).lean();
    if (!link) {
      return reply.status(404).send({ error: 'not_found', message: 'Invalid or revoked invite link.' });
    }

    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return reply.status(410).send({ error: 'expired', message: 'This invite link has expired.' });
    }

    const existing = await NoteInvitation.findOne({ noteId: link.noteId, userId: req.userId }).lean();
    if (existing) {
      return reply.send({ success: true, message: 'Already a member.', noteId: link.noteId, role: existing.role });
    }

    // `requireApproval` links are request-access links: joining silently would
    // make the setting a lie. Record a durable per-account request (mirroring
    // org_join_requests) so one editor approval can grant this account and no
    // one else; the row's existence is the pending state.
    if (link.requireApproval) {
      await query(
        `INSERT INTO note_join_requests (id, note_id, invite_id, account_id, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (invite_id, account_id) DO NOTHING`,
        [crypto.randomUUID(), link.noteId, link.id, req.userId, new Date().toISOString()]
      );
      return reply.status(202).send({
        pending: true,
        message: 'This invite link requires an editor to approve you.',
        noteId: link.noteId,
        role: link.role,
      });
    }

    const joinWorkspaceId = await resolveNoteWorkspaceId(link.noteId, link.createdBy);
    await NoteInvitation.create({
      noteId: link.noteId,
      userId: req.userId,
      invitedBy: link.createdBy,
      role: link.role,
      workspaceId: typeof joinWorkspaceId === 'string' && joinWorkspaceId ? joinWorkspaceId : null,
    });

    return reply.status(201).send({
      success: true,
      noteId: link.noteId,
      role: link.role,
    });
  });

  // Pending note join requests for one note. Editor-gated: the server never
  // reveals who is asking to join to a viewer or an outsider.
  app.get('/notes/:noteId/join-requests', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    if (!NoteIdSchema.safeParse(noteId).success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }
    if (!(await requireNoteApprover(reply, noteId, req.userId))) return;

    const { rows } = await query(
      `SELECT r.id, r.note_id, r.account_id, r.created_at, l.role, a.username
         FROM note_join_requests r
         JOIN note_invite_links l ON l.id = r.invite_id
         LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.note_id = $1
        ORDER BY r.created_at ASC`,
      [noteId]
    );
    return reply.send({
      noteId,
      requests: rows.map((r) => ({
        id: r.id,
        noteId: r.note_id,
        accountId: r.account_id,
        username: r.username || null,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // Every pending note join request the caller can act on, across all notes
  // they edit. Lets the team settings surface a single approval queue.
  app.get('/join-requests', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      `SELECT r.id, r.note_id, r.account_id, r.created_at, l.role, a.username
         FROM note_join_requests r
         JOIN note_invite_links l ON l.id = r.invite_id
         LEFT JOIN accounts a ON a.id = r.account_id
        WHERE EXISTS (
          SELECT 1 FROM note_invitations ni
           WHERE ni.note_id = r.note_id AND ni.user_id = $1 AND ni.role = 'editor'
        )
        ORDER BY r.created_at ASC`,
      [req.userId]
    );
    return reply.send({
      requests: rows.map((r) => ({
        id: r.id,
        noteId: r.note_id,
        accountId: r.account_id,
        username: r.username || null,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // Approve a pending note join request: grants the invite's role and consumes
  // the pending row. A second approve finds no row and is rejected, so it can
  // never double-grant.
  app.post('/join-requests/:requestId/approve', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      'SELECT id, note_id, invite_id, account_id FROM note_join_requests WHERE id = $1',
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) {
      return reply.status(404).send({ error: 'not_found', message: 'Join request not found or already handled.' });
    }
    if (!(await requireNoteApprover(reply, request.note_id, req.userId))) return;

    const { rows: linkRows } = await query('SELECT role FROM note_invite_links WHERE id = $1', [request.invite_id]);
    const role = linkRows[0]?.role;
    if (!role) {
      await query('DELETE FROM note_join_requests WHERE id = $1', [request.id]);
      return reply.status(404).send({ error: 'not_found', message: 'The invite link no longer exists.' });
    }

    // Idempotent insert, then consume the request. A concurrent double-approve
    // cannot create two invitations (PK) and one delete is a no-op.
    const approveWorkspaceId = await resolveNoteWorkspaceId(request.note_id, req.userId);
    await query(
      `INSERT INTO note_invitations (note_id, user_id, invited_by, role, created_at, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [request.note_id, request.account_id, req.userId, role, new Date().toISOString(), approveWorkspaceId ?? null]
    );
    publishUserNotification({
      userId: request.account_id,
      kind: 'note_shared',
      noteId: request.note_id,
      workspaceId: approveWorkspaceId ?? null,
      actorId: req.userId,
      excludeDeviceId: req.deviceId ?? null,
    }).catch(() => {});
    // Consume every pending request from this account for this note, so a
    // second invite link cannot leave a stale "pending" row for a collaborator.
    await query(
      'DELETE FROM note_join_requests WHERE note_id = $1 AND account_id = $2',
      [request.note_id, request.account_id]
    );

    app.log.info(
      { noteId: request.note_id, approvedUser: request.account_id, byUser: req.userId, role },
      'Note join request approved'
    );
    return reply.send({ approved: true, noteId: request.note_id, userId: request.account_id, role });
  });

  // Deny a pending note join request: drops the request without granting access.
  app.post('/join-requests/:requestId/deny', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    const { rows } = await query(
      'SELECT id, note_id, account_id FROM note_join_requests WHERE id = $1',
      [req.params.requestId]
    );
    const request = rows[0];
    if (!request) {
      return reply.status(404).send({ error: 'not_found', message: 'Join request not found or already handled.' });
    }
    if (!(await requireNoteApprover(reply, request.note_id, req.userId))) return;

    await query('DELETE FROM note_join_requests WHERE id = $1', [request.id]);
    app.log.info(
      { noteId: request.note_id, deniedUser: request.account_id, byUser: req.userId },
      'Note join request denied'
    );
    return reply.send({ denied: true, noteId: request.note_id, userId: request.account_id });
  });

  // Notes the caller was invited to as a collaborator but does not necessarily
  // own a workspace for (a "shared note": invited to one note, not a member of
  // the workspace that holds it). The client uses this to materialise the note
  // locally, recover its key, and sync it against its owning workspace.
  app.get('/shared-with-me', {
    ...baseRateLimit,
    ...protect,
  }, async (req, reply) => {
    // The note owner is represented by an invitation row whose invitedBy is
    // the owner themself (requireCollaborator mints it). That is the owner's
    // access record, not a share, so it must not reach the client: listing it
    // makes the client mark its own notes as foreign and pull them into
    // whichever workspace is active when it reconciles.
    const invitations = await NoteInvitation.find(
      { userId: req.userId, invitedBy: { $ne: req.userId } }
    ).lean();

    // A note may not have been pushed to the server yet, so its owning workspace
    // can be unknown; return null and let the client fall back.
    const noteIds = invitations.map((i) => i.noteId).filter(Boolean);
    const ownerByNote = new Map();
    if (noteIds.length > 0) {
      const { rows } = await query(`
        SELECT note_id, MIN(workspace_id) AS workspace_id FROM (
          SELECT note_id, workspace_id FROM yjs_doc_updates WHERE note_id = ANY($1)
          UNION ALL
          SELECT note_id, workspace_id FROM sync_document_state WHERE note_id = ANY($1)
        ) t GROUP BY note_id
      `, [noteIds]);
      for (const row of rows) ownerByNote.set(row.note_id, row.workspace_id);
    }

    return reply.send({
      shared: invitations.map((i) => ({
        noteId: i.noteId,
        role: i.role,
        invitedBy: i.invitedBy ?? null,
        createdAt: i.createdAt ?? null,
        workspaceId: ownerByNote.get(i.noteId) ?? null,
      })),
    });
  });
}

module.exports = collaborationRoutes;
