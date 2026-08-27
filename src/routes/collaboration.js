'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { Account, NoteKey, NoteInvitation, NoteInviteLink } = require('../models');
const {
  storeRecipients,
  noteHasAnyKey,
  getEnvelopesForUser,
  createKeyDistributionRequest,
  listKeyDistributionRequests,
  deleteKeyDistributionRequest,
} = require('../repositories/noteKeys');
const { validatePublicKey } = require('../lib/recipient-wrap');
const { sendNoteInviteEmail } = require('../email');
const { isFreePlan } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');
const { resolveEffectivePlan } = require('../lib/plan-resolution');

const BODY_LIMIT = parseInt(process.env.COLLAB_BODY_LIMIT_BYTES ?? '4096', 10);

// Outbound note shares/invites require a paid plan (spec: free users can
// receive shared notes as collaborators but cannot invite/share outbound).
async function requirePaidSharePlan(req, reply) {
  if (isEnterpriseMode()) return true;
  const { plan } = await resolveEffectivePlan(req);
  if (isFreePlan(plan)) {
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

// Gate access to a note's collaboration context. The caller must already be a
// collaborator. With `bootstrap: true` (invite creation only) a caller may
// claim a note that has no collaborators yet - this is how the user who
// created a note first invites people. Never self-grant onto a note that
// already has collaborators, otherwise any authenticated user could claim
// another user's note by guessing its ID.
async function requireCollaborator(reply, noteId, userId, { bootstrap = false } = {}) {
  const existing = await NoteInvitation.findOne({ noteId, userId }).lean();
  if (existing) return existing;

  if (bootstrap) {
    const total = await NoteInvitation.countDocuments({ noteId });
    if (total === 0) {
      await NoteInvitation.create({ noteId, userId, invitedBy: userId, role: 'editor', createdAt: new Date() });
      return true;
    }
  }

  reply.status(403).send({ error: 'forbidden', message: 'Not a collaborator on this note.' });
  return null;
}

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
    const collaboratorIds = new Set(collabRows.map((c) => c.userId));
    const keypairIds = new Set(accountRows.filter((a) => a.kemPublicKey).map((a) => a.id));

    for (const r of recipients) {
      if (!collaboratorIds.has(r.userId)) {
        return reply.status(403).send({ error: 'forbidden', message: `User ${r.userId} is not a collaborator.` });
      }
      if (!keypairIds.has(r.userId)) {
        return reply.status(403).send({ error: 'keypair_required', message: `User ${r.userId} has not set up end-to-end encryption.` });
      }
    }

    // Idempotent provisioning: the first writer wins. If the note already has
    // any key envelopes, refuse to overwrite so a late joiner or a concurrent
    // provisioner cannot rotate an existing note key.
    let outcome;
    if (await NoteKey.countDocuments({ noteId }) > 0) {
      outcome = { existing: true, stored: 0 };
    } else {
      await storeRecipients(noteId, recipients);
      outcome = { existing: false, stored: recipients.length };
    }

    return reply.send({ noteId, stored: outcome.stored, noteHasKey: true, existing: outcome.existing });
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

    const membership = await requireCollaborator(reply, noteId, req.userId, { bootstrap: true });
    if (!membership) return;

    const noteHasKey = (await NoteKey.countDocuments({ noteId })) > 0;
    if (!noteHasKey) {
      return reply.send({ noteId, wrappedKey: null, noteHasKey: false });
    }

    const row = await NoteKey.findOne({ noteId, userId: req.userId }).lean();
    if (!row) {
      return reply.send({ noteId, wrappedKey: null, noteHasKey: true });
    }
    return reply.send({ noteId, wrappedKey: row.wrappedKey, noteHasKey: true });
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
    if (!isCollab) {
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
  }, async (req, reply) => {
    const noteId = req.params.noteId;
    const parsed = NoteIdSchema.safeParse(noteId);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_note_id', message: 'Invalid note ID format.' });
    }
    const membership = await requireCollaborator(reply, noteId, req.userId);
    if (!membership) return;
    const invitations = await NoteInvitation.find({ noteId }).lean();
    const userIds = [...new Set(invitations.map((inv) => inv.userId))];
    const accounts = userIds.length > 0
      ? await Account.find({ id: { $in: userIds } }, { id: 1, kemPublicKey: 1, deviceKeys: 1 }).lean()
      : [];
    const collaborators = [];
    for (const a of accounts.filter((x) => x.kemPublicKey)) {
      const devices = (a.deviceKeys && a.deviceKeys.length)
        ? a.deviceKeys
        : [{ deviceId: 'default', publicKey: a.kemPublicKey }];
      for (const d of devices) {
        collaborators.push({ userId: a.id, deviceId: d.deviceId, kemPublicKey: d.publicKey });
      }
    }
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

    // 02.3: soft gate
    const inviterAcct = await Account.findById(req.userId, { emailVerified: 1 }).lean();
    if (!inviterAcct?.emailVerified) {
      return reply.status(403).send({ error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email before inviting collaborators.' });
    }

    if (!(await requirePaidSharePlan(req, reply))) return;

    const { username, email } = req.body ?? {};
    if ((!username || typeof username !== 'string') && (!email || typeof email !== 'string')) {
      return reply.status(400).send({ error: 'validation_error', message: 'Provide username or email of the user to invite.' });
    }

    const membership = await requireCollaborator(reply, noteId, req.userId, { bootstrap: true });
    if (!membership) return;

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

    const membership = await requireCollaborator(reply, noteId, req.userId);
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

    await NoteKey.deleteOne({ noteId, userId: targetUserId });

    app.log.info({ noteId, removedUser: targetUserId, byUser: req.userId }, 'Invitation removed');

    return reply.send({ deleted: true, noteId, userId: targetUserId });
  });

  app.post('/links/:noteId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId } = req.params;
    const { role = 'editor', requireApproval = false, expiresIn } = req.body;

    const linkAcct = await Account.findById(req.userId, { emailVerified: 1 }).lean();
    if (!linkAcct?.emailVerified) {
      return reply.status(403).send({ error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email before creating invite links.' });
    }

    if (!(await requirePaidSharePlan(req, reply))) return;

    if (!['editor', 'viewer'].includes(role)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Role must be editor or viewer.' });
    }

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

  app.get('/links/:noteId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { noteId } = req.params;

    const links = await NoteInviteLink.find({
      noteId,
      createdBy: req.userId,
      revoked: 0,
    }).sort({ createdAt: -1 }).lean();

    return reply.send({ links });
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
      return reply.send({ success: true, message: 'Already a member.', role: existing.role });
    }

    const joiner = await Account.findById(req.userId, { kemPublicKey: 1 }).lean();
    if (!joiner || !joiner.kemPublicKey) {
      return reply.status(403).send({ error: 'keypair_required', message: 'Set up end-to-end encryption before joining.' });
    }

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
