'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { query, transaction } = require('../db');
const { requireWorkspaceMember, requireWorkspaceOwner } = require('../middleware/org');

const CLAIM_TTL_MS = 30 * 60 * 1000;

const VERIFY_CONCURRENCY = 8;

const { mapWithConcurrency } = require('../lib/concurrency');

const WorkspaceSchema = z.object({ workspaceId: z.string().min(1) });
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
  } catch {
    return null;
  }
}

async function verifyObject(storage, key, error) {
  if (!storage || typeof storage.stat !== 'function') return error;
  const object = await storage.stat(key);
  if (!object || !Number.isInteger(object.sizeBytes) || object.sizeBytes <= 0) return error;
  return null;
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
  const { rows } = await query('SELECT status, generation FROM sync_workspace_state WHERE workspace_id = $1', [workspaceId]);
  const state = rows[0];
  if (!state) return null;
  const { rows: docRows } = await query(`
    SELECT note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts
    FROM sync_document_state WHERE workspace_id = $1
    UNION
    SELECT note_id, 0, NULL, 0, 0, 0
    FROM yjs_doc_updates u WHERE workspace_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM sync_document_state s
        WHERE s.workspace_id = $1 AND s.note_id = u.note_id
      )
    ORDER BY note_id
  `, [workspaceId]);
  const documents = docRows.map(documentState);
  const { rows: vaultRows } = await query(`
    SELECT id, owner_id, key_params_blob, created_at, updated_at
    FROM vault_key_params WHERE workspace_id = $1
  `, [workspaceId]);
  const vaultRow = vaultRows[0];

  return {
    workspaceId,
    status: state.status,
    generation: state.generation,
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
    const result = await query(`
      UPDATE sync_workspace_state
      SET status = 'initializing', initialization_token = $1, initialization_expires_at = $2, updated_at = $3
      WHERE workspace_id = $4
        AND (status = 'empty' OR (status = 'initializing' AND initialization_expires_at <= $5))
    `, [token, expiresAt, now, workspaceId, now]);
    if (result.rowCount === 0) return reply.status(409).send({ error: 'sync_already_initialized' });
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
          return { error: 'invalid_snapshot_key' };
        }
        if (document.snapshotKey !== snapshotKeyFor(workspaceId, document.noteId, generation)) {
          return { error: 'invalid_snapshot_key' };
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
    const complete = await transaction(async (client) => {
      const { rows } = await client.query(`
        SELECT initialization_token, initialization_expires_at
        FROM sync_workspace_state
        WHERE workspace_id = $1 AND status = 'initializing'
      `, [workspaceId]);
      const state = rows[0];
      if (!state || state.initialization_token !== token) return 'invalid_token';
      if (!state.initialization_expires_at || state.initialization_expires_at <= now) return 'expired_token';

      if (documents.length > 0) {
        const columnCount = 8;
        const placeholders = documents.map((_, i) => {
          const b = i * columnCount;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
        }).join(', ');
        const values = [];
        for (const d of documents) {
          values.push(
            workspaceId, d.noteId, d.snapshotGeneration, d.snapshotKey ?? null,
            d.checkpointTs, d.checkpointSequence, d.snapshotTs ?? 0, now
          );
        }
        const upsertSql = `
          INSERT INTO sync_document_state
            (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, snapshot_ts, updated_at)
          VALUES ${placeholders}
          ON CONFLICT(workspace_id, note_id) DO UPDATE SET
            snapshot_generation = excluded.snapshot_generation,
            snapshot_key = excluded.snapshot_key,
            checkpoint_ts = excluded.checkpoint_ts,
            checkpoint_sequence = excluded.checkpoint_sequence,
            snapshot_ts = excluded.snapshot_ts,
            updated_at = excluded.updated_at
        `;
        await client.query(upsertSql, values);
      }
      await client.query(`
        UPDATE sync_workspace_state
        SET status = 'initialized', generation = $1, initialization_token = NULL,
            initialization_expires_at = NULL, updated_at = $2
        WHERE workspace_id = $3
      `, [generation, now, workspaceId]);
      return null;
    });
    if (complete === 'expired_token') return reply.status(403).send({ error: 'initialization_token_expired' });
    if (complete === 'invalid_token') return reply.status(403).send({ error: 'invalid_initialization_token' });
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
    const { rows: claimRows } = await query(`
      SELECT initialization_token, initialization_expires_at
      FROM sync_workspace_state WHERE workspace_id = $1 AND status = 'initializing'
    `, [workspaceId]);
    const claim = claimRows[0];
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
      // R2/MinIO outage or network error — must surface as 503 so clients
      // retry, never as a 400 client failure.
      return reply.status(503).send({ error: 'snapshot_upload_failed' });
    }
    return reply.send({ key, generation, sizeBytes: body.length });
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
    const { rows: claimRows } = await query(`
      SELECT initialization_token, initialization_expires_at
      FROM sync_workspace_state WHERE workspace_id = $1 AND status = 'initializing'
    `, [workspaceId]);
    const claim = claimRows[0];
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
    const parsed = WorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error', message: parsed.error.errors[0].message });
    const { workspaceId } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const now = new Date().toISOString();
    await transaction(async (client) => {
      await client.query(`
        UPDATE sync_workspace_state
        SET status = 'empty', generation = 0, initialization_token = NULL,
            initialization_expires_at = NULL, updated_at = $1
        WHERE workspace_id = $2
      `, [now, workspaceId]);
      await client.query('DELETE FROM sync_document_state WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM yjs_doc_updates WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM vault_key_params WHERE workspace_id = $1', [workspaceId]);
    });
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

    const { rows } = await query(`
      SELECT note_id, snapshot_generation, snapshot_key, snapshot_ts
      FROM sync_document_state
      WHERE workspace_id = $1 AND note_id = ANY($2)
        AND snapshot_key IS NOT NULL AND snapshot_key != ''
    `, [workspaceId, noteIds]);

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
