'use strict';

const { z } = require('zod');
const persistence = require('../persistence/yjs');
const { Device, Workspace, Subscription } = require('../models');
const { audit } = require('../lib/audit');

const MAX_UPDATES_PER_PUSH = 200;
const MAX_UPDATES_PER_PULL = 500;
const MAX_BODY_BYTES = parseInt(process.env.YJS_SYNC_BODY_LIMIT_BYTES ?? '10485760', 10);
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const PushSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  updates: z.array(z.object({
    key: z.string().max(512),
    data: z.string().max(10485760),
  })).min(1).max(MAX_UPDATES_PER_PUSH),
});

const BatchPushSchema = z.object({
  workspaceId: z.string().min(1),
  notes: z.array(z.object({
    noteId: z.string().min(1),
    updates: z.array(z.object({
      key: z.string().max(512),
      data: z.string().max(10485760),
    })).min(1).max(MAX_UPDATES_PER_PUSH),
  })).min(1).max(50),
});

const PullSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  after: z.record(z.string(), z.object({
    ts: z.number().int().min(0),
    seq: z.number().int().min(0),
  })).optional().default({}),
});

const BatchPullSchema = z.object({
  workspaceId: z.string().min(1),
  notes: z.array(z.object({
    noteId: z.string().min(1),
    after: z.record(z.string(), z.object({
      ts: z.number().int().min(0),
      seq: z.number().int().min(0),
    })).optional().default({}),
  })).min(1).max(50),
});

const DeleteSchema = z.object({
  workspaceId: z.string().min(1),
  noteId: z.string().min(1),
  keys: z.array(z.string().max(512)).min(1).max(500),
});

/**
 * Parse the frontend sync filename format: {docId}~~{deviceId}~~{ts}~~{seq}.yjs.json
 * Returns { docId, device, ts, seq } or null.
 */
function parseSyncFilename(key) {
  const cleaned = key.replace(/\.yjs\.json$/, '');
  const parts = cleaned.split('~~');
  if (parts.length < 4) return null;
  return {
    docId: parts[0],
    device: parts[1],
    ts: parseInt(parts[2], 10) || 0,
    seq: parseInt(parts[3], 10) || 0,
  };
}

async function yjsSyncRoutes(app) {
  await app.register(require('../middleware/auth'));
  await app.register(require('../middleware/subscription'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota],
  };

  // POST /yjs/push — Store Yjs updates in SQLite
  app.post('/push', {
    ...protectWrite,
    bodyLimit: MAX_BODY_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: MAX_BODY_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.YJS_SYNC_WRITE_RATE_LIMIT ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = PushSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
      return reply.status(400).send({
        error: 'missing_device_id',
        message: 'A valid X-Device-Id header is required.',
      });
    }

    const { workspaceId, noteId, updates } = parsed.data;

    // Verify workspace access
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'workspace_not_found' });
    }

    // Store each update in SQLite (batch insert in single transaction)
    let stored = 0;
    let sizeBytes = 0;

    const batchData = [];
    for (const { key, data } of updates) {
      const buffer = Buffer.from(data, 'base64');
      const parsedKey = parseSyncFilename(key);
      const seq = parsedKey?.seq || 0;
      batchData.push({
        data: buffer,
        encrypted: false,
        deviceId,
        clock: seq,
        ts: parsedKey?.ts ?? Date.now(),
      });
      sizeBytes += buffer.byteLength;
    }
    await persistence.storeUpdatesBatch(workspaceId, noteId, batchData);
    stored = batchData.length;

    // Update per-account storage quota (req.subscription set by middleware)
    if (req.subscription && sizeBytes > 0) {
      await Subscription.updateOne(
        { accountId: req.userId },
        { $inc: { storageUsedBytes: sizeBytes } },
      );
    }

    // Track device
    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    await Device.findOneAndUpdate(
      { accountId: req.userId, deviceId },
      { label: deviceLabel, lastSeen: new Date() },
      { upsert: true, new: true },
    );

    audit(req, 'yjs_push', { stored, deviceId, workspaceId, noteId });

    return reply.status(201).send({ stored, sizeBytes });
  });

  // POST /yjs/push-batch — Store Yjs updates for multiple notes in one request
  app.post('/push-batch', {
    ...protectWrite,
    bodyLimit: MAX_BODY_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: MAX_BODY_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.YJS_SYNC_WRITE_RATE_LIMIT ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = BatchPushSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) {
      return reply.status(400).send({
        error: 'missing_device_id',
        message: 'A valid X-Device-Id header is required.',
      });
    }

    const { workspaceId, notes } = parsed.data;

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) {
      return reply.status(404).send({ error: 'workspace_not_found' });
    }

    let totalStored = 0;
    let totalSizeBytes = 0;

    for (const { noteId, updates } of notes) {
      const batchData = [];
      for (const { key, data } of updates) {
        const buffer = Buffer.from(data, 'base64');
        const parsedKey = parseSyncFilename(key);
        const seq = parsedKey?.seq || 0;
        batchData.push({
          data: buffer,
          encrypted: false,
          deviceId,
          clock: seq,
          ts: parsedKey?.ts ?? Date.now(),
        });
      }
      await persistence.storeUpdatesBatch(workspaceId, noteId, batchData);
      totalStored += batchData.length;
      totalSizeBytes += batchData.reduce((sum, u) => sum + u.data.byteLength, 0);
    }

    if (req.subscription && totalSizeBytes > 0) {
      await Subscription.updateOne(
        { accountId: req.userId },
        { $inc: { storageUsedBytes: totalSizeBytes } },
      );
    }

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    await Device.findOneAndUpdate(
      { accountId: req.userId, deviceId },
      { label: deviceLabel, lastSeen: new Date() },
      { upsert: true, new: true },
    );

    audit(req, 'yjs_push_batch', { stored: totalStored, deviceId, workspaceId, noteCount: notes.length });

    return reply.status(201).send({ stored: totalStored, sizeBytes: totalSizeBytes });
  });

  // POST /yjs/pull — Fetch updates from SQLite
  app.post('/pull', {
    ...protect,
    bodyLimit: 4096,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: 4096,
      },
      rateLimit: {
        max: parseInt(process.env.YJS_SYNC_READ_RATE_LIMIT ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = PullSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const { workspaceId, noteId, after: cursors } = parsed.data;

    // Find minimum timestamp across all cursors
    const minTs = Object.values(cursors).reduce((min, cursor) =>
      Math.min(min, cursor.ts), Infinity);
    const effectiveMinTs = minTs === Infinity ? 0 : minTs;

    // Get updates from SQLite
    const updates = await persistence.loadUpdatesSince(workspaceId, noteId, effectiveMinTs);

    // Filter out updates already seen by each device
    const filtered = updates.filter(update => {
      const cursor = cursors[update.deviceId];
      if (!cursor) return true;
      if (update.ts > cursor.ts) return true;
      if (update.ts === cursor.ts && update.clock > cursor.seq) return true;
      return false;
    }).slice(0, MAX_UPDATES_PER_PULL);

    // Format response — key must match parseSyncFilename format on the frontend
    const result = filtered.map(update => ({
      key: `${noteId}~~${update.deviceId}~~${update.ts}~~${update.clock}.yjs.json`,
      data: update.data.toString('base64'),
    }));

    return reply.send({ updates: result });
  });

  // POST /yjs/pull-batch — Fetch updates for multiple notes in one request
  app.post('/pull-batch', {
    ...protect,
    bodyLimit: MAX_BODY_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: MAX_BODY_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.YJS_SYNC_READ_RATE_LIMIT ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = BatchPullSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const { workspaceId, notes } = parsed.data;
    const result = {};

    for (const { noteId, after: cursors } of notes) {
      const minTs = Object.values(cursors).reduce((min, cursor) =>
        Math.min(min, cursor.ts), Infinity);
      const effectiveMinTs = minTs === Infinity ? 0 : minTs;

      const updates = await persistence.loadUpdatesSince(workspaceId, noteId, effectiveMinTs);

      const filtered = updates.filter(update => {
        const cursor = cursors[update.deviceId];
        if (!cursor) return true;
        if (update.ts > cursor.ts) return true;
        if (update.ts === cursor.ts && update.clock > cursor.seq) return true;
        return false;
      }).slice(0, MAX_UPDATES_PER_PULL);

      result[noteId] = filtered.map(update => ({
        key: `${noteId}~~${update.deviceId}~~${update.ts}~~${update.clock}.yjs.json`,
        data: update.data.toString('base64'),
      }));
    }

    return reply.send({ notes: result });
  });

  // DELETE /yjs/updates — Delete updates for a note
  app.delete('/updates', {
    ...protect,
    bodyLimit: 4096,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: 4096,
      },
      rateLimit: {
        max: parseInt(process.env.YJS_SYNC_DELETE_RATE_LIMIT ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = DeleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const { workspaceId, noteId } = parsed.data;

    await persistence.deleteUpdatesForNote(workspaceId, noteId);

    return reply.send({ deleted: true });
  });
}

module.exports = yjsSyncRoutes;
