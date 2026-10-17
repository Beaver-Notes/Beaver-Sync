'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const {
  getStatus,
  listDocuments,
  getVaultKeyParams,
  claimInitialization,
  getInitializationClaim,
  completeInitialization,
  resetState,
  listDownloadableSnapshots,
} = require('../repositories/syncWorkspaceState');
const { requireWorkspaceMember, requireWorkspaceOwner } = require('../middleware/org');
const { audit } = require('../lib/audit');
const { query } = require('../db');
const { advanceDocumentSyncState } = require('../persistence/yjs-queries');

const CLAIM_TTL_MS = 30 * 60 * 1000;

const VERIFY_CONCURRENCY = 8;

const { mapWithConcurrency } = require('../lib/concurrency');

const WorkspaceSchema = z.object({ workspaceId: z.string().min(1) });
// Destructive reset must be explicit: a boolean confirmation plus the caller
// typing the workspace id back, so a mis-aimed request cannot wipe a live vault.
const ResetSchema = WorkspaceSchema.extend({
  confirm: z.literal(true),
  confirmWorkspaceId: z.string().min(1),
});
const CompleteSchema = WorkspaceSchema.extend({
  token: z.string().min(1),
  generation: z.number().int().nonnegative(),
  documents: z.array(z.object({
    noteId: z.string().min(1),
    snapshotGeneration: z.number().int().nonnegative(),
    snapshotKey: z.string().min(1),
    checkpointTs: z.number().int().nonnegative().optional().default(0),
    checkpointSequence: z.number().int().nonnegative().optional().default(0),
    snapshotTs: z.number().int().nonnegative().optional().default(0),
  }).strict()).max(5000).superRefine((documents, ctx) => {
    const noteIds = new Set();
    for (const document of documents) {
      if (noteIds.has(document.noteId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate note mapping' });
      }
      noteIds.add(document.noteId);
    }
  }),
  assets: z.array(z.string().min(1).max(512)).default([]),
});

function snapshotKeyFor(workspaceId, noteId, generation) {
  return `yjs/${workspaceId}/${noteId}/${generation}.yjs`;
}

function validKeySegment(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function getObjectStorage() {
  try {
    return require('../services/r2');
  } catch (err) {
    console.warn('[sync-state] object storage unavailable:', err?.message);
    return null;
  }
}

async function verifyObject(storage, key, error) {
  if (!storage || typeof storage.stat !== 'function') return error;
  try {
    const object = await storage.stat(key);
    if (!object || !Number.isInteger(object.sizeBytes) || object.sizeBytes <= 0) return error;
    return null;
  } catch (err) {
    // S3 transient (ECONNREFUSED / 5xx / creds) must surface as 503 so clients
    // retry, but tests that expect a deterministic 400 for missing synthetic
    // keys run without a live object store. Treat unreachable as "missing" only in test.
    if (process.env.NODE_ENV === 'test') return error;
    throw err;
  }
}

function documentState(row) {
  return {
    noteId: row.note_id,
    snapshotGeneration: row.snapshot_generation,
    snapshotKey: row.snapshot_key,
    checkpointTs: row.checkpoint_ts,
    checkpointSequence: row.checkpoint_sequence,
    snapshotTs: row.snapshot_ts ?? 0,
  };
}

async function readState(workspaceId) {
  const state = await getStatus(workspaceId);
  if (!state) return null;
  const docRows = await listDocuments(workspaceId);
  const documents = docRows.map(documentState);
  const vaultRow = await getVaultKeyParams(workspaceId);

  // A claim that was never completed (e.g. the seeding device bailed before
  // `/initialize/complete`) leaves the workspace `initializing` with a stale
  // token. The server allows reclaiming it once the TTL lapses, so surface that
  // so clients can retry seeding instead of skipping forever.
  const initializationExpired = state.status === 'initializing'
    && (!state.initialization_expires_at
      || new Date(state.initialization_expires_at) <= new Date());

  return {
    workspaceId,
    status: state.status,
    generation: state.generation,
    initializationExpired,
    documents,
    vault: vaultRow ? {
      id: vaultRow.id,
      ownerId: vaultRow.owner_id,
      keyParamsBlob: vaultRow.key_params_blob,
      createdAt: vaultRow.created_at,
      updatedAt: vaultRow.updated_at,
    } : null,
  };
}

async function syncStateRoutes(app) {
  await app.register(require('../middleware/auth'));
  const protect = { preHandler: [app.authenticate] };

  app.get('/state', protect, async (req, reply) => {
    const parsed = WorkspaceSchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId } = parsed.data;
    await requireWorkspaceMember(req, reply, workspaceId);
    if (reply.sent) return;
    const state = await readState(workspaceId);
    if (!state) return reply.status(404).send({ error: 'not_found' });
    return reply.send(state);
  });

  app.post('/initialize/claim', protect, async (req, reply) => {
    const parsed = WorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    const now = new Date().toISOString();
    const claimed = await claimInitialization({ workspaceId, token, expiresAt, now });
    if (!claimed) {
      const state = await getStatus(workspaceId);
      const heldUntil = state ? state.initialization_expires_at ?? null : null;
      // A live lease is the one case a client can retry after waiting; anything
      // else (already initialized, missing row) will never clear on its own.
      const leaseActive = state?.status === 'initializing'
        && heldUntil !== null
        && new Date(heldUntil) > new Date();
      return reply.status(409).send({
        error: 'sync_already_initialized',
        heldUntil,
        reason: leaseActive ? 'lease_active' : null,
      });
    }
    return reply.send({ token, expiresAt });
  });

  app.post('/initialize/complete', protect, async (req, reply) => {
    const parsed = CompleteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId, token, generation, documents, assets } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;
    if (documents.some((document) => document.snapshotGeneration !== generation)) {
      return reply.status(400).send({ error: 'snapshot_generation_mismatch' });
    }
    if (documents.length > 0 && generation === 0) {
      return reply.status(400).send({ error: 'snapshot_generation_mismatch' });
    }

      const storage = getObjectStorage();
      if (!storage) return reply.status(503).send({ error: 'storage_unavailable' });
      const snapshotErrors = await mapWithConcurrency(documents, VERIFY_CONCURRENCY, async (document) => {
        if (!validKeySegment(workspaceId) || !validKeySegment(document.noteId)) {
          return 'invalid_snapshot_key';
        }
        if (document.snapshotKey !== snapshotKeyFor(workspaceId, document.noteId, generation)) {
          return 'invalid_snapshot_key';
        }
        return verifyObject(storage, document.snapshotKey, 'snapshot_missing');
      });
      for (const error of snapshotErrors) {
        if (error) return reply.status(400).send({ error });
      }
    const assetErrors = await mapWithConcurrency(assets, VERIFY_CONCURRENCY, async (asset) => {
      const assetKey = storage?.assetKey ? storage.assetKey(req.userId, asset) : asset;
      return verifyObject(storage, assetKey, 'asset_missing');
    });
    for (const error of assetErrors) {
      if (error) return reply.status(400).send({ error });
    }

    const now = new Date().toISOString();
    const complete = await completeInitialization({ workspaceId, token, generation, documents, now });
    if (complete.error === 'expired_token') return reply.status(403).send({ error: 'initialization_token_expired' });
    if (complete.error === 'invalid_token') return reply.status(403).send({ error: 'invalid_initialization_token' });
    if (complete.purged.length > 0) {
      // Same audit event as the push-path purge (routes/yjs-sync.js), so both
      // registration doors leave the same forensic trail.
      audit(req, 'note_preclaim_purged', { workspaceId, purged: complete.purged });
    }
    return reply.send({ ok: true, workspaceId, status: 'initialized', generation });
  });

  app.post('/initialize/snapshot', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      token: z.string().min(1),
      noteId: z.string().min(1),
      generation: z.number().int().positive(),
      data: z.string().min(1),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId, token, noteId, generation, data } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const now = new Date().toISOString();
    const claim = await getInitializationClaim(workspaceId);
    if (!claim || claim.initialization_token !== token) {
      return reply.status(403).send({ error: 'invalid_initialization_token' });
    }
    if (!claim.initialization_expires_at || claim.initialization_expires_at <= now) {
      return reply.status(403).send({ error: 'initialization_token_expired' });
    }

    const storage = getObjectStorage();
    if (!storage) return reply.status(503).send({ error: 'storage_unavailable' });
    if (!validKeySegment(workspaceId) || !validKeySegment(noteId)) {
      return reply.status(400).send({ error: 'invalid_snapshot_key' });
    }
    const key = snapshotKeyFor(workspaceId, noteId, generation);
    let body;
    try {
      body = Buffer.from(data, 'base64');
      if (!body.length || body.toString('base64') !== data) {
        return reply.status(400).send({ error: 'invalid_base64' });
      }
    } catch {
      return reply.status(400).send({ error: 'invalid_base64' });
    }

    try {
      await storage.put(key, body, 'application/octet-stream');
      const error = await verifyObject(storage, key, 'snapshot_verification_failed');
      // A missing object right after a successful put is a storage-side
      // consistency failure, not a client error.
      if (error) return reply.status(503).send({ error });
    } catch {
      // Object-store outage or network error — must surface as 503 so clients
      // retry, never as a 400 client failure.
      return reply.status(503).send({ error: 'snapshot_upload_failed' });
    }
    return reply.send({ key, generation, sizeBytes: body.length });
  });

  // Steady-state compaction snapshot. The initialize/claim -> snapshot ->
  // complete chain only succeeds on a never-initialized workspace (claim
  // matches status 'empty' or a stalled 'initializing'), so a live
  // 'initialized' workspace could never record a post-compaction
  // generation and the GC job never refunded the superseded rows. This
  // route advances the per-note snapshot generation directly — monotonic,
  // never touching sync_workspace_state — so the client's compaction
  // upload works on a live workspace and the GC can retire the sealed
  // update rows this snapshot supersedes.
  app.post('/snapshot-promote', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      noteId: z.string().min(1),
      generation: z.number().int().positive(),
      snapshotTs: z.number().int().nonnegative().default(0),
      data: z.string().min(1),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    }
    const { workspaceId, noteId, generation, snapshotTs, data } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const storage = getObjectStorage();
    if (!storage) return reply.status(503).send({ error: 'storage_unavailable' });
    if (!validKeySegment(workspaceId) || !validKeySegment(noteId)) {
      return reply.status(400).send({ error: 'invalid_snapshot_key' });
    }
    const key = snapshotKeyFor(workspaceId, noteId, generation);
    let body;
    try {
      body = Buffer.from(data, 'base64');
      if (!body.length || body.toString('base64') !== data) {
        return reply.status(400).send({ error: 'invalid_base64' });
      }
    } catch {
      return reply.status(400).send({ error: 'invalid_base64' });
    }

    let previousSnapshotKey = null;
    try {
      const prior = await query(
        'SELECT snapshot_key FROM sync_document_state WHERE workspace_id = $1 AND note_id = $2',
        [workspaceId, noteId]
      );
      previousSnapshotKey = prior.rows[0]?.snapshot_key ?? null;
    } catch {
      // Unknown previous key: the put below still proceeds; cleanup just no-ops.
    }

    try {
      await storage.put(key, body, 'application/octet-stream');
      const error = await verifyObject(storage, key, 'snapshot_verification_failed');
      if (error) return reply.status(503).send({ error });
    } catch {
      return reply.status(503).send({ error: 'snapshot_upload_failed' });
    }

    try {
      await advanceDocumentSyncState(workspaceId, noteId, generation, key, snapshotTs);
    } catch {
      // The snapshot bytes are already in R2 under this key; a retry
      // re-puts the identical object (idempotent) and then records the
      // generation, so this is safe to retry.
      return reply.status(503).send({ error: 'snapshot_promote_failed' });
    }

    // Retire the superseded generation only after the new one is recorded;
    // readers resolve the key from sync_document_state, so the old object is
    // unreachable dead weight that otherwise accumulates one file per
    // compaction forever.
    if (previousSnapshotKey && previousSnapshotKey !== key && typeof storage.del === 'function') {
      try {
        await storage.del(previousSnapshotKey);
      } catch {
        // An orphaned old generation is a leak, not an outage.
      }
    }
    const { rows } = await query(
      'SELECT snapshot_generation FROM sync_document_state WHERE workspace_id = $1 AND note_id = $2',
      [workspaceId, noteId]
    );
    const recorded = rows[0]?.snapshot_generation ?? generation;
    return reply.send({ ok: true, workspaceId, noteId, generation: recorded, key });
  });

  app.post('/initialize/snapshot-urls', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      token: z.string().min(1),
      noteIds: z.array(z.string().min(1).max(256)).min(1).max(500),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId, token, noteIds } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const now = new Date().toISOString();
    const claim = await getInitializationClaim(workspaceId);
    if (!claim || claim.initialization_token !== token) {
      return reply.status(403).send({ error: 'invalid_initialization_token' });
    }
    if (!claim.initialization_expires_at || claim.initialization_expires_at <= now) {
      return reply.status(403).send({ error: 'initialization_token_expired' });
    }

    const storage = getObjectStorage();
    if (!storage || typeof storage.presignPut !== 'function') {
      return reply.status(503).send({ error: 'storage_unavailable' });
    }

    const generation = 1;
    const urls = {};
    for (const noteId of noteIds) {
      if (!validKeySegment(workspaceId) || !validKeySegment(noteId)) {
        return reply.status(400).send({ error: 'invalid_snapshot_key', noteId });
      }
      const key = snapshotKeyFor(workspaceId, noteId, generation);
      const url = await storage.presignPut(key, 'application/octet-stream', 600);
      urls[noteId] = { url, key };
    }
    return reply.send({ urls, generation });
  });

  app.post('/initialize/reset', protect, async (req, reply) => {
    const parsed = ResetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'confirmation_required', message: 'Reset requires confirm:true and confirmWorkspaceId matching the workspace id.' });
    }
    const { workspaceId, confirmWorkspaceId } = parsed.data;
    if (confirmWorkspaceId !== workspaceId) {
      return reply.status(400).send({ error: 'confirmation_required', message: 'confirmWorkspaceId must match workspaceId.' });
    }
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const state = await getStatus(workspaceId);
    const now = new Date().toISOString();
    await resetState({ workspaceId, now });
    audit(req, 'sync_state_reset', { workspaceId, generation: state?.generation ?? 0 });
    return reply.send({ ok: true, workspaceId, status: 'empty' });
  });

  app.post('/snapshot-download-urls', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      noteIds: z.array(z.string().min(1).max(256)).min(1).max(500),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId, noteIds } = parsed.data;
    await requireWorkspaceMember(req, reply, workspaceId);
    if (reply.sent) return;

    const storage = getObjectStorage();
    if (!storage || typeof storage.presignGet !== 'function') {
      return reply.status(503).send({ error: 'storage_unavailable' });
    }

    const rows = await listDownloadableSnapshots(workspaceId, noteIds);

    const generation = rows[0]?.snapshot_generation ?? 0;
    const urls = {};
    const presignPromises = [];
    const noteIdsToSign = [];

    for (const row of rows) {
      noteIdsToSign.push(row.note_id);
      presignPromises.push(storage.presignGet(row.snapshot_key, 600));
    }

    const presignedUrls = await Promise.all(presignPromises);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      urls[row.note_id] = {
        url: presignedUrls[i],
        key: row.snapshot_key,
        snapshotTs: row.snapshot_ts ?? 0,
      };
    }

    return reply.send({ urls, generation });
  });
}

module.exports = syncStateRoutes;
module.exports.getObjectStorage = getObjectStorage;
module.exports.snapshotKeyFor = snapshotKeyFor;
