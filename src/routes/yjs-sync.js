'use strict';

const { z } = require('zod');
const persistence = require('../persistence/yjs');
const { Device } = require('../models');
const { audit } = require('../lib/audit');
const { historyCutoffForAccount } = require('../lib/plan-lifecycle');
const { resolveEffectivePlan } = require('../lib/plan-resolution');
const { getPool } = require('../db/postgres');
const { DEVICE_ID_PATTERN } = require('../lib/patterns');
const { requireWorkspaceMember, requireWorkspaceWriter } = require('../middleware/org');

const MAX_UPDATES_PER_PUSH = 200;
const MAX_UPDATES_PER_PULL = 500;
const MAX_BODY_BYTES = Math.min(parseInt(process.env.YJS_SYNC_BODY_LIMIT_BYTES ?? '10485760', 10), 10485760);
const SYNC_KEY_PATTERN = /^([a-zA-Z0-9_-]{1,256})~~([a-zA-Z0-9_-]{1,128})~~([0-9]+)~~([0-9]+)\.yjs\.json$/;

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

async function yjsSyncRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = { preHandler: [app.authenticate] };
  const protectWrite = { preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkDeviceLimit] };
  const jsonConfig = (rate) => ({
    bodyLimit: MAX_BODY_BYTES,
    config: {
      security: { allowedContentTypes: ['application/json'], maxContentLength: MAX_BODY_BYTES },
      rateLimit: { max: rate, timeWindow: '1 minute' },
    },
  });

  app.post('/push-batch', { ...protectWrite, ...jsonConfig(parseInt(process.env.YJS_SYNC_WRITE_RATE_LIMIT ?? '60', 10)) }, async (req, reply) => {
    const parsed = BatchPushSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed);
    const deviceId = getDeviceId(req, reply);
    if (!deviceId) return;
    if (req.sessionDeviceId && req.sessionDeviceId !== deviceId) {
      return reply.status(403).send({ error: 'device_session_mismatch' });
    }
    const { workspaceId, notes } = parsed.data;
    if (!await requireWorkspaceWriter(req, reply, workspaceId)) return;
    req.workspaceId = workspaceId;

    for (const { noteId, updates } of notes) {
      if (updates.some((update) => update.deviceId !== deviceId)) return reply.status(400).send({ error: 'device_id_mismatch' });
      if (updates.some((update) => !validateUpdateKey(noteId, update, deviceId))) {
        return reply.status(400).send({ error: 'malformed_update_key' });
      }
    }

    const storedNotes = notes.map(({ noteId, updates }) => ({
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
      throw error;
    }
    const { accepted, duplicate, acceptedBytes: sizeBytes, checkpoint } = result;

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    try {
      await Device.findOneAndUpdate({ accountId: req.userId, deviceId }, { label: deviceLabel, lastSeen: new Date() }, { upsert: true, new: true });
    } catch (err) {
      // The batch is already committed; a device-metadata write failure must
      // not turn a successful push into a 500.
      app.log.warn({ err: err?.message, deviceId }, 'device metadata update failed after push');
    }
    audit(req, 'yjs_push_batch', { accepted, duplicate, deviceId, workspaceId, noteCount: notes.length });

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

  app.post('/pull-batch', { ...protect, ...jsonConfig(parseInt(process.env.YJS_SYNC_READ_RATE_LIMIT ?? '120', 10)) }, async (req, reply) => {
    const parsed = BatchPullSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const { workspaceId, notes } = parsed.data;
    if (!await requireWorkspaceMember(req, reply, workspaceId)) return;

    const { cutoffTs } = await historyCutoffForAccount(req.userId, workspaceId);

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[pull-batch] ws=${workspaceId} notes=${notes.length} cutoffTs=${cutoffTs} deviceId=${req.headers['x-device-id'] || 'none'}`);
      for (const { noteId, checkpoint, limit } of notes) {
        console.log(`[pull-batch]   note=${noteId} checkpoint=${JSON.stringify(checkpoint)} limit=${limit}`);
      }
    }

    const entries = await Promise.all(notes.map(async ({ noteId, checkpoint, limit }) => {
      const page = await persistence.loadUpdatesAfter(workspaceId, noteId, checkpoint, Math.min(limit, MAX_UPDATES_PER_PULL), cutoffTs);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[pull-batch]   -> ${noteId}: ${page.updates.length} updates, hasMore=${page.hasMore}${page.stale ? ' STALE' : ''}`);
      }
      const entry = {
        updates: page.updates.map((update) => formatUpdate(noteId, update)),
        nextCheckpoint: page.nextCheckpoint,
        hasMore: page.hasMore,
      };
      if (page.stale) entry.stale = true;
      return [noteId, entry];
    }));
    return reply.send({ notes: Object.fromEntries(entries) });
  });

  app.get('/note-ids', { ...protect }, async (req, reply) => {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return reply.status(400).send({ error: 'missing_workspace' });
    if (!await requireWorkspaceMember(req, reply, workspaceId)) return;
    return reply.send({ noteIds: await persistence.listNoteIds(workspaceId) });
  });

  app.delete('/updates', { ...protect, bodyLimit: 4096 }, async (req, reply) => {
    const parsed = DeleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    if (!await requireWorkspaceWriter(req, reply, parsed.data.workspaceId)) return;
    await persistence.deleteUpdatesForNote(parsed.data.workspaceId, parsed.data.noteId);
    return reply.send({ deleted: true });
  });
}

module.exports = yjsSyncRoutes;
module.exports.summarizeStoredBatch = summarizeStoredBatch;
