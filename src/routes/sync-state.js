'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');
const { getDb } = require('../db');
const { requireWorkspaceMember, requireWorkspaceOwner } = require('../middleware/org');

const CLAIM_TTL_MS = 5 * 60 * 1000;

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
  }).strict()).superRefine((documents, ctx) => {
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
  };
}

function readState(workspaceId) {
  const db = getDb();
  const state = db.prepare('SELECT status, generation FROM sync_workspace_state WHERE workspace_id = ?').get(workspaceId);
  if (!state) return null;
  const documents = db.prepare(`
    SELECT note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence
    FROM sync_document_state WHERE workspace_id = ? ORDER BY note_id
  `).all(workspaceId).map(documentState);
  const vaultRow = db.prepare(`
    SELECT id, owner_id, key_params_blob, created_at, updated_at
    FROM vault_key_params WHERE workspace_id = ?
  `).get(workspaceId);

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
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId } = parsed.data;
    await requireWorkspaceMember(req, reply, workspaceId);
    if (reply.sent) return;
    const state = readState(workspaceId);
    if (!state) return reply.status(404).send({ error: 'not_found' });
    return reply.send(state);
  });

  app.post('/initialize/claim', protect, async (req, reply) => {
    const parsed = WorkspaceSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const db = getDb();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE sync_workspace_state
      SET status = 'initializing', initialization_token = ?, initialization_expires_at = ?, updated_at = ?
      WHERE workspace_id = ?
        AND (status = 'empty' OR (status = 'initializing' AND initialization_expires_at <= ?))
    `).run(token, expiresAt, now, workspaceId, now);
    if (result.changes === 0) return reply.status(409).send({ error: 'sync_already_initialized' });
    return reply.send({ token, expiresAt });
  });

  app.post('/initialize/complete', protect, async (req, reply) => {
    const parsed = CompleteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
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
    for (const document of documents) {
      if (!validKeySegment(workspaceId) || !validKeySegment(document.noteId)) {
        return reply.status(400).send({ error: 'invalid_snapshot_key' });
      }
      if (document.snapshotKey !== snapshotKeyFor(workspaceId, document.noteId, generation)) {
        return reply.status(400).send({ error: 'invalid_snapshot_key' });
      }
      const error = await verifyObject(storage, document.snapshotKey, 'snapshot_missing');
      if (error) return reply.status(400).send({ error });
    }
    for (const asset of assets) {
      const assetKey = storage?.assetKey ? storage.assetKey(req.userId, asset) : asset;
      const error = await verifyObject(storage, assetKey, 'asset_missing');
      if (error) return reply.status(400).send({ error });
    }

    const db = getDb();
    const now = new Date().toISOString();
    const complete = db.transaction(() => {
      const state = db.prepare(`
        SELECT initialization_token, initialization_expires_at
        FROM sync_workspace_state
        WHERE workspace_id = ? AND status = 'initializing'
      `).get(workspaceId);
      if (!state || state.initialization_token !== token) return 'invalid_token';
      if (!state.initialization_expires_at || state.initialization_expires_at <= now) return 'expired_token';

      const upsert = db.prepare(`
        INSERT INTO sync_document_state
          (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, note_id) DO UPDATE SET
          snapshot_generation = excluded.snapshot_generation,
          snapshot_key = excluded.snapshot_key,
          checkpoint_ts = excluded.checkpoint_ts,
          checkpoint_sequence = excluded.checkpoint_sequence,
          updated_at = excluded.updated_at
      `);
      for (const document of documents) {
        upsert.run(workspaceId, document.noteId, document.snapshotGeneration, document.snapshotKey ?? null,
          document.checkpointTs, document.checkpointSequence, now);
      }
      db.prepare(`
        UPDATE sync_workspace_state
        SET status = 'initialized', generation = ?, initialization_token = NULL,
            initialization_expires_at = NULL, updated_at = ?
        WHERE workspace_id = ?
      `).run(generation, now, workspaceId);
      return null;
    })();
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
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId, token, noteId, generation, data } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const db = getDb();
    const now = new Date().toISOString();
    const claim = db.prepare(`
      SELECT initialization_token, initialization_expires_at
      FROM sync_workspace_state WHERE workspace_id = ? AND status = 'initializing'
    `).get(workspaceId);
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
      if (!body.length || body.toString('base64') !== data) throw new Error('invalid base64');
      await storage.put(key, body, 'application/octet-stream');
      const error = await verifyObject(storage, key, 'snapshot_verification_failed');
      if (error) return reply.status(400).send({ error });
    } catch {
      return reply.status(400).send({ error: 'snapshot_upload_failed' });
    }
    return reply.send({ key, generation, sizeBytes: body.length });
  });

  app.post('/initialize/snapshot-urls', protect, async (req, reply) => {
    const parsed = z.object({
      workspaceId: z.string().min(1),
      token: z.string().min(1),
      noteIds: z.array(z.string().min(1).max(256)).min(1).max(500),
    }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId, token, noteIds } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const db = getDb();
    const now = new Date().toISOString();
    const claim = db.prepare(`
      SELECT initialization_token, initialization_expires_at
      FROM sync_workspace_state WHERE workspace_id = ? AND status = 'initializing'
    `).get(workspaceId);
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
    if (!parsed.success) return reply.status(400).send({ error: 'validation_error' });
    const { workspaceId } = parsed.data;
    const membership = await requireWorkspaceOwner(req, reply, workspaceId);
    if (reply.sent || !membership) return;

    const db = getDb();
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE sync_workspace_state
        SET status = 'empty', generation = 0, initialization_token = NULL,
            initialization_expires_at = NULL, updated_at = ?
        WHERE workspace_id = ?
      `).run(now, workspaceId);
      db.prepare('DELETE FROM sync_document_state WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM yjs_doc_updates WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM vault_key_params WHERE workspace_id = ?').run(workspaceId);
    })();
    return reply.send({ ok: true, workspaceId, status: 'empty' });
  });
}

module.exports = syncStateRoutes;
