'use strict';

const { z } = require('zod');
const persistence = require('../persistence/yjs');
const { Device, NoteInvitation, WorkspaceMember } = require('../models');
const { audit } = require('../lib/audit');
const { isFreePlan } = require('../lib/plans');
const { isEnterpriseMode } = require('../lib/license');
const { resolveEffectivePlan } = require('../lib/plan-resolution');
const { getPool } = require('../db/postgres');
const { DEVICE_ID_PATTERN, isPlaceholderDeviceLabel } = require('../lib/patterns');
const { requireWorkspaceMember, requireWorkspaceWriter } = require('../middleware/org');

const MAX_UPDATES_PER_PUSH = 200;
const MAX_UPDATES_PER_PULL = 500;
const MAX_BODY_BYTES = Math.min(parseInt(process.env.YJS_SYNC_BODY_LIMIT_BYTES ?? '10485760', 10), 10485760);
const SYNC_KEY_PATTERN = /^([a-zA-Z0-9_-]{1,256})~~([a-zA-Z0-9_-]{1,128})~~([0-9]+)~~([0-9]+)\.yjs\.json$/;

// A note id belongs to exactly one workspace: its first push binds it. Without
// this, a device that boots into the wrong workspace copies its whole cached
// library in, and the same note then shows up (and deletes) everywhere (F30).
async function boundWorkspaces(noteIds) {
  if (!noteIds.length) return new Map();
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (note_id) note_id, workspace_id
       FROM yjs_doc_updates
      WHERE note_id = ANY($1::text[])
      ORDER BY note_id, created_at ASC`,
    [noteIds]
  );
  return new Map(rows.map((row) => [row.note_id, row.workspace_id]));
}

const UpdateSchema = z.object({
  key: z.string().min(1).max(512),
  data: z.string().min(1).max(MAX_BODY_BYTES),
  deviceId: z.string().regex(DEVICE_ID_PATTERN),
  sequence: z.number().int().nonnegative().safe(),
  ts: z.number().int().nonnegative().safe(),
}).strict();

const BatchPushSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  notes: z.array(z.object({
    noteId: z.string().min(1).max(256),
    updates: z.array(UpdateSchema).min(1).max(MAX_UPDATES_PER_PUSH),
  }).strict()).min(1).max(50),
}).strict();

const CheckpointSchema = z.union([z.record(z.string().regex(DEVICE_ID_PATTERN), z.object({
  ts: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
})), z.null()]).transform((value) => value || {});

const BatchPullSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  notes: z.array(z.object({
    noteId: z.string().min(1).max(256),
    checkpoint: CheckpointSchema,
    limit: z.number().int().min(1).max(MAX_UPDATES_PER_PULL),
  }).strict()).min(1).max(50),
}).strict();

const DeleteSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  keys: z.array(z.string().max(512)).min(1).max(500),
});

function validationError(reply, parsed) {
  return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
}

function getDeviceId(req, reply) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    reply.status(400).send({ error: 'missing_device_id', message: 'A valid X-Device-Id header is required.' });
    return null;
  }
  return deviceId;
}

function validateUpdateKey(noteId, update, headerDeviceId) {
  const logVal = (v) => String(v).slice(0, 128);
  const match = SYNC_KEY_PATTERN.exec(update.key);
  if (!match) {
    console.error('[validateUpdateKey] key regex failed for key:', logVal(update.key));
    return false;
  }
  if (match[1] !== noteId) {
    console.error('[validateUpdateKey] noteId mismatch: key has', logVal(match[1]), 'but body has', logVal(noteId));
    return false;
  }
  if (match[2] !== update.deviceId) {
    console.error('[validateUpdateKey] deviceId mismatch: key has', logVal(match[2]), 'but update has', logVal(update.deviceId));
    return false;
  }
  if (match[2] !== headerDeviceId) {
    console.error('[validateUpdateKey] header deviceId mismatch: key has', logVal(match[2]), 'but header has', logVal(headerDeviceId));
    return false;
  }
  if (Number(match[3]) !== update.ts) {
    console.error('[validateUpdateKey] ts mismatch: key has', logVal(match[3]), 'but update has', update.ts);
    return false;
  }
  if (Number(match[4]) !== update.sequence) {
    console.error('[validateUpdateKey] seq mismatch: key has', logVal(match[4]), 'but update has', update.sequence);
    return false;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(update.data)) {
    console.error('[validateUpdateKey] base64 regex failed for data length:', update.data?.length);
    return false;
  }
  if (Buffer.from(update.data, 'base64').toString('base64') !== update.data) {
    console.error('[validateUpdateKey] base64 round-trip failed');
    return false;
  }
  if (Buffer.byteLength(update.data, 'base64') > MAX_BODY_BYTES) {
    console.error('[validateUpdateKey] data too large:', Buffer.byteLength(update.data, 'base64'));
    return false;
  }
  return true;
}

function formatUpdate(noteId, update) {
  return {
    key: `${noteId}~~${update.deviceId}~~${update.ts}~~${update.sequence}.yjs.json`,
    data: update.data.toString('base64'),
  };
}

function summarizeStoredBatch(result) {
  return { stored: result.accepted, sizeBytes: result.acceptedBytes };
}

// Cloud sync is collaboration-only on the free plan: a free account may sync a
// workspace only when invited as a non-owner member, so an owner of a workspace
// hits this wall with an explicit 402 instead of a silently empty journal.
// Notes an account was invited to individually (a "shared note": collaborator
// on one note, not a member of the workspace that holds it). Used to authorize
// push/pull of those notes without granting workspace membership.
async function invitedNoteIds(userId, noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return new Set();
  const rows = await NoteInvitation.find(
    { userId, noteId: { $in: noteIds } }
  ).lean();
  return new Set(rows.map((r) => r.noteId));
}

// Verifies the note actually lives in `workspaceId`'s journal, so an invitation
// cannot be used to touch the same note id in a different workspace.
async function notesOwnedByWorkspace(noteIds, workspaceId) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return new Set();
  const { rows } = await getPool().query(`
    SELECT DISTINCT note_id FROM (
      SELECT note_id FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = ANY($2)
      UNION ALL
      SELECT note_id FROM sync_document_state WHERE workspace_id = $1 AND note_id = ANY($2)
    ) t
  `, [workspaceId, noteIds]);
  return new Set(rows.map((r) => r.note_id));
}

// A caller may push/pull a workspace's notes when they are a MEMBER of it, or
// when EVERY note they touch is one they were individually invited to and that
// note lives in this workspace. Returns the member row on the member path
// (so downstream role checks still run), or the string 'invited', or null
// (reply already sent with a 403).
// Short TTL cache for successful access checks only (membership/invites).
// Failures are never cached: a revoked user must lose access immediately, and a
// newly-granted invite must work on its next request. Success staleness is
// bounded by the TTL (default 2s): a demoted user keeps access for at most that.
const NOTE_ACCESS_CACHE_TTL_MS = parseInt(process.env.NOTE_ACCESS_CACHE_TTL_MS ?? '2000', 10);
const noteAccessCache = new Map();

function getNoteAccessCacheKey(userId, workspaceId, noteIds, write) {
  const sorted = [...noteIds].sort();
  return `${userId}:${workspaceId}:${write ? 'w' : 'r'}:${sorted.join(',')}`;
}

function getCachedNoteAccess(key) {
  const entry = noteAccessCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    noteAccessCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedNoteAccess(key, value) {
  noteAccessCache.set(key, { value, expiresAt: Date.now() + NOTE_ACCESS_CACHE_TTL_MS });
  if (noteAccessCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of noteAccessCache) {
      if (now > v.expiresAt) noteAccessCache.delete(k);
      if (noteAccessCache.size <= 4000) break;
    }
  }
}

async function requireNoteAccess(req, reply, workspaceId, noteIds, { write }) {
  const cacheKey = getNoteAccessCacheKey(req.userId, workspaceId, noteIds, write);
  const cached = getCachedNoteAccess(cacheKey);
  if (cached !== undefined) {
    // Only successes are cached: a miss would have been fail-closed already.
    return cached;
  }

  // Look the membership up directly: the shared requireWorkspace* helpers send
  // their own 403, which would short-circuit the invited fallback below.
  const membership = await WorkspaceMember.findOne({ workspaceId, accountId: req.userId }).lean();
  if (membership) {
    if (!write || ['owner', 'editor'].includes(membership.role)) {
      setCachedNoteAccess(cacheKey, membership);
      return membership;
    }
    reply.status(403).send({ error: 'workspace_write_forbidden' });
    // Failures are never cached: re-check the DB next request.
    return null;
  }

  // Not a member: allow only if the caller is invited to every note in the
  // batch, and each note belongs to this workspace.
  const invited = await invitedNoteIds(req.userId, noteIds);
  if (invited.size !== noteIds.length) {
    reply.status(403).send({ error: 'not_workspace_member' });
    // Failures are never cached: re-check the DB next request.
    return null;
  }
  // An invite carries a role: a viewer may read the note but must not write it
  // (F28). Membership above already enforces the same split.
  if (write) {
    const rows = await NoteInvitation.find({ userId: req.userId }).lean();
    const editable = new Set(
      rows.filter((row) => row.role === 'editor' && noteIds.includes(row.noteId)).map((row) => row.noteId)
    );
    if (!noteIds.every((id) => editable.has(id))) {
      reply.status(403).send({ error: 'note_write_forbidden' });
      // Failures are never cached: re-check the DB next request.
      return null;
    }
  }
  const owned = await notesOwnedByWorkspace([...invited], workspaceId);
  if (owned.size !== noteIds.length) {
    reply.status(403).send({ error: 'note_workspace_mismatch' });
    // Failures are never cached: re-check the DB next request.
    return null;
  }
  setCachedNoteAccess(cacheKey, 'invited');
  return 'invited';
}

async function requirePaidWorkspaceOwner(req, reply, membership) {
  if (isEnterpriseMode()) return true;
  if (membership?.role !== 'owner') return true;
  // The pull path already resolved the plan via requireActiveSync: reuse the
  // request-scoped decision instead of re-querying Subscription/Workspace.
  if (req.paidOwnerDecision) {
    if (req.paidOwnerDecision.allowed) return true;
  } else {
    const { plan } = await resolveEffectivePlan(req);
    req.paidOwnerDecision = { allowed: !isFreePlan(plan) };
    if (req.paidOwnerDecision.allowed) return true;
  }
  reply.status(402).send({
    error: 'plan_upgrade_required',
    message: 'Cloud sync of a workspace you own requires a paid plan. Upgrade to sync.',
    upgradeUrl: 'https://beaver.app/sync',
  });
  return false;
}

async function yjsSyncRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };
  // requirePaidWrite is deliberately absent: paid gating is role-aware here
  // (requirePaidWorkspaceOwner), so free invited collaborators may still push.
  const protectWrite = { preHandler: [app.authenticate, app.requireActiveSync, app.checkDeviceLimit] };
  const jsonConfig = (rate) => ({
    bodyLimit: MAX_BODY_BYTES,
    config: {
      security: { allowedContentTypes: ['application/json'], maxContentLength: MAX_BODY_BYTES },
      rateLimit: { max: rate, timeWindow: '1 minute' },
    },
  });

  // ponytail: 240, not 60 — see the note on COMMIT_WRITE_RATE_LIMIT_PER_MINUTE;
  // the client coalesces only 1.5s, so fast typing outran a 60/min bucket.
  app.post('/push-batch', { ...protectWrite, ...jsonConfig(parseInt(process.env.YJS_SYNC_WRITE_RATE_LIMIT ?? '240', 10)) }, async (req, reply) => {
    const parsed = BatchPushSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed);
    const deviceId = getDeviceId(req, reply);
    if (!deviceId) return;
    if (req.sessionDeviceId && req.sessionDeviceId !== deviceId) {
      return reply.status(403).send({ error: 'device_session_mismatch' });
    }
    const { workspaceId, notes } = parsed.data;
    const membership = await requireNoteAccess(req, reply, workspaceId, notes.map((n) => n.noteId), { write: true });
    if (!membership) return;
    if (!await requirePaidWorkspaceOwner(req, reply, membership)) return;
    req.workspaceId = workspaceId;

    // First write wins: notes already living in another workspace are dropped
    // instead of duplicated (and instead of failing the whole batch).
    // The workspace meta doc is named 'meta' in every workspace, so the
    // first-write-wins note binding would pin it to whichever workspace wrote
    // first and silently reject the other workspaces' meta docs (no note list
    // for their members). It is workspace-scoped, not a note: skip it.
    const isMetaDoc = (noteId) => noteId === 'meta';
    const bound = await boundWorkspaces(
      notes.map((n) => n.noteId).filter((id) => !isMetaDoc(id)),
    );
    const acceptedNotes = notes.filter((n) => {
      if (isMetaDoc(n.noteId)) return true;
      const owner = bound.get(n.noteId);
      return !owner || owner === workspaceId;
    });
    if (acceptedNotes.length !== notes.length) {
      req.log.info(`[yjs-sync] dropped ${notes.length - acceptedNotes.length} note(s) bound to another workspace`);
    }

    for (const { noteId, updates } of acceptedNotes) {
      if (updates.some((update) => update.deviceId !== deviceId)) return reply.status(400).send({ error: 'device_id_mismatch' });
      if (updates.some((update) => !validateUpdateKey(noteId, update, deviceId))) {
        return reply.status(400).send({ error: 'malformed_update_key' });
      }
    }

    const storedNotes = acceptedNotes.map(({ noteId, updates }) => ({
      noteId,
      updates: updates.map((update) => ({
        data: Buffer.from(update.data, 'base64'),
        // REST clients send encrypted envelopes. Hocuspocus must never try to
        // interpret these bytes as plaintext Yjs updates.
        encrypted: true,
        deviceId: update.deviceId,
        sequence: update.sequence,
        ts: update.ts,
      })),
    }));
    req.body = parsed.data;
    const { plan: effectivePlan, seats } = await resolveEffectivePlan(req);
    let result;
    try {
      result = await persistence.storeNotesBatch(workspaceId, storedNotes, {
        accountId: req.userId,
        workspaceId: req.workspaceId || null,
        subscription: req.subscription,
        plan: effectivePlan,
        seats,
      });
    } catch (error) {
      if (error.code === 'storage_quota_exceeded') {
        return reply.status(507).send({ error: error.code, message: error.message });
      }
      // The workspace owner's plan grants no cloud storage. Same answer as the
      // owner-side gate, because retrying can never succeed.
      if (error.code === 'plan_storage_unavailable') {
        return reply.status(402).send({
          error: 'plan_upgrade_required',
          message: 'Cloud sync of this workspace requires a paid plan on its owner. Upgrade to sync.',
          upgradeUrl: 'https://beaver.app/sync',
        });
      }
      throw error;
    }
    const { accepted, duplicate, acceptedBytes: sizeBytes, checkpoint } = result;

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    try {
      // Only overwrite the stored label when the client sent a real model;
      // legacy hardcoded labels ("Beaver Notes (Rust)") must not clobber it.
      const update = isPlaceholderDeviceLabel(deviceLabel)
        ? { lastSeen: new Date() }
        : { label: deviceLabel, lastSeen: new Date() };
      await Device.findOneAndUpdate({ accountId: req.userId, deviceId }, update, { upsert: true, new: true });
    } catch (err) {
      // The batch is already committed; a device-metadata write failure must
      // not turn a successful push into a 500.
      app.log.warn({ err: err?.message, deviceId }, 'device metadata update failed after push');
    }
    audit(req, 'yjs_push_batch', { accepted, duplicate, deviceId, workspaceId, noteCount: notes.length });
    if (result.purgedClaims?.length) {
      audit(req, 'note_preclaim_purged', { workspaceId, purged: result.purgedClaims });
    }

    // Notify other connected clients via Postgres LISTEN/NOTIFY so they
    // can trigger an immediate HTTP pull instead of waiting for the next
    // 30-second timer tick.  The notification is lightweight — just the
    // workspace ID and affected note IDs.  Hocuspocus subscribes to
    // 'sync_notifications' and broadcasts a stateless JSON message to
    // matching connections.
    if (accepted > 0) {
      try {
        const pool = getPool();
        const noteIds = notes.map((n) => n.noteId);
        await pool.query('SELECT pg_notify($1, $2)', [
          'sync_notifications',
          JSON.stringify({ workspaceId, noteIds, excludeDeviceId: deviceId }),
        ]);
      } catch (err) {
        // Notification failure is non-fatal — the 30-second pull timer
        // will pick up changes eventually.
        app.log.warn({ err: err?.message }, 'sync_notifications notify failed');
      }
    }

    const response = { accepted, duplicate, sizeBytes, checkpoint };
    if (notes.length > 1) response.checkpoints = result.checkpoints;
    return reply.status(201).send(response);
  });

  // Pulls skip requireActiveSync: plan gating here is role-aware
  // (requirePaidWorkspaceOwner), so free invited collaborators may still pull.
  // Prime the request-scoped plan decision once (Subscription + Workspace +
  // org lookups) so downstream helpers reuse it instead of re-querying.
  app.post('/pull-batch', { ...protect, ...jsonConfig(parseInt(process.env.YJS_SYNC_READ_RATE_LIMIT ?? '120', 10)) }, async (req, reply) => {
    const parsed = BatchPullSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const { workspaceId, notes } = parsed.data;
    const membership = await requireNoteAccess(req, reply, workspaceId, notes.map((n) => n.noteId), { write: false });
    if (!membership) return;
    if (!await requirePaidWorkspaceOwner(req, reply, membership)) return;

    // The Yjs journal is live state, not version history: it must never be
    // clamped by the plan's history window, or a reinstall/another device would
    // pull zero updates and look like total data loss. History-length limiting
    // belongs on /commits/history only.
    const cutoffTs = 0;

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[pull-batch] ws=${workspaceId} notes=${notes.length} cutoffTs=${cutoffTs} deviceId=${req.headers['x-device-id'] || 'none'}`);
      for (const { noteId, checkpoint, limit } of notes) {
        console.log(`[pull-batch]   note=${noteId} checkpoint=${JSON.stringify(checkpoint)} limit=${limit}`);
      }
    }

    // One query for the whole batch: a per-note query made a 50-note pull cost
    // 50 round trips, which dominated the per-device tick on a small box.
    const pages = await persistence.loadUpdatesBatch(
      workspaceId,
      notes.map(({ noteId, checkpoint, limit }) => ({
        noteId,
        checkpoint,
        limit: Math.min(limit, MAX_UPDATES_PER_PULL),
      })),
      cutoffTs,
    );

    const response = {};
    for (const { noteId } of notes) {
      const page = pages[noteId];
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[pull-batch]   -> ${noteId}: ${page.updates.length} updates, hasMore=${page.hasMore}${page.stale ? ' STALE' : ''}`);
      }
      const entry = {
        updates: page.updates.map((update) => formatUpdate(noteId, update)),
        nextCheckpoint: page.nextCheckpoint,
        hasMore: page.hasMore,
      };
      if (page.stale) entry.stale = true;
      response[noteId] = entry;
    }
    return reply.send({ notes: response });
  });

  app.get('/note-ids', { ...protect }, async (req, reply) => {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return reply.status(400).send({ error: 'missing_workspace' });
    if (!await requireWorkspaceMember(req, reply, workspaceId)) return;
    return reply.send({ noteIds: await persistence.listNoteIds(workspaceId) });
  });

  // Compaction deletes journal rows, but it must keep working for an account at
  // its plan device cap, so this stays on the read guard; requireWorkspaceWriter
  // below is what refuses a viewer.
  app.delete('/updates', { ...protect, bodyLimit: 4096 }, async (req, reply) => {
    const parsed = DeleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const { workspaceId, noteId, keys } = parsed.data;
    if (!await requireWorkspaceWriter(req, reply, workspaceId)) return;

    // Delete exactly the journal rows named by `keys`, never the whole note.
    // A blank `keys` array is rejected by the schema, so a compaction caller
    // cannot accidentally wipe other devices' unsnapshotted updates.
    const headerDeviceId = req.headers['x-device-id'];
    const hasHeaderDevice = typeof headerDeviceId === 'string' && DEVICE_ID_PATTERN.test(headerDeviceId);
    const rows = [];
    for (const key of keys) {
      const match = SYNC_KEY_PATTERN.exec(key);
      if (!match || match[1] !== noteId) {
        return reply.status(400).send({ error: 'malformed_delete_key' });
      }
      if (hasHeaderDevice && match[2] !== headerDeviceId) {
        return reply.status(403).send({ error: 'device_id_mismatch' });
      }
      rows.push({ deviceId: match[2], clock: Number(match[4]) });
    }
    await persistence.deleteJournalRows(workspaceId, noteId, rows);
    return reply.send({ deleted: true, deletedKeys: rows.length });
  });
}

module.exports = yjsSyncRoutes;
module.exports.summarizeStoredBatch = summarizeStoredBatch;
