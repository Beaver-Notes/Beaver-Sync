'use strict';

const { z } = require('zod');
const r2 = require('../services/r2');
const { Device, Workspace, Subscription } = require('../models');
const { audit } = require('../lib/audit');

const YJS_KEY_PATTERN = /^[a-zA-Z0-9._~=-]{1,512}$/;
const MAX_UPDATES_PER_PUSH = 200;
const MAX_UPDATES_PER_PULL = 500;
const MAX_BODY_BYTES = parseInt(process.env.YJS_SYNC_BODY_LIMIT_BYTES ?? '10485760', 10);
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const PushSchema = z.object({
  updates: z.array(z.object({
    key: z.string().max(512),
    data: z.string().max(10485760),
  })).min(1).max(MAX_UPDATES_PER_PUSH),
});

const PullSchema = z.object({
  after: z.record(z.string(), z.object({
    ts: z.number().int().min(0),
    seq: z.number().int().min(0),
  })).optional().default({}),
});

const DeleteSchema = z.object({
  keys: z.array(z.string().max(512)).min(1).max(500),
});

async function yjsSyncRoutes(app) {
  await app.register(require('../middleware/auth'));
  await app.register(require('../middleware/subscription'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota],
  };

  // ── POST /yjs/push — Upload encrypted Yjs updates ─────────────────────
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

    const { updates } = parsed.data;
    let stored = 0;
    let skipped = 0;
    let sizeBytes = 0;

    for (const { key, data } of updates) {
      if (!YJS_KEY_PATTERN.test(key)) {
        skipped++;
        continue;
      }

      const r2Key = r2.yjsKey(req.userId, key);
      const buffer = Buffer.from(data, 'base64');

      try {
        await r2.put(r2Key, buffer, 'application/octet-stream', { ifNoneMatch: '*' });
        stored++;
        sizeBytes += buffer.byteLength;
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 412) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    if (sizeBytes > 0) {
      if (req.workspaceId) {
        await Workspace.updateOne(
          { _id: req.workspaceId },
          { $inc: { storageUsedBytes: sizeBytes } }
        );
      } else {
        await Subscription.updateOne(
          { accountId: req.userId },
          { $inc: { storageUsedBytes: sizeBytes } }
        );
      }
    }

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    await Device.findOneAndUpdate(
      { accountId: req.userId, deviceId },
      { label: deviceLabel, lastSeen: new Date() },
      { upsert: true, new: true }
    );

    audit(req, 'yjs_push', { stored, skipped, deviceId });

    return reply.status(201).send({ stored, skipped, sizeBytes });
  });

  // ── POST /yjs/pull — Fetch updates since cursor ────────────────────────
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

    const { after: cursors } = parsed.data;
    const prefix = `${req.userId}/yjs/`;

    let allKeys;
    try {
      allKeys = await r2.listKeys(prefix);
    } catch {
      return reply.send({ updates: [] });
    }

    const updates = [];
    for (const fullKey of allKeys) {
      if (updates.length >= MAX_UPDATES_PER_PULL) break;

      const fileName = fullKey.slice(prefix.length);
      if (!fileName) continue;

      const parsed = parseYjsFileName(fileName);
      if (!parsed) continue;

      const { device, ts, seq } = parsed;
      const seen = cursors[device];
      if (seen) {
        if (ts < seen.ts) continue;
        if (ts === seen.ts && seq <= seen.seq) continue;
      }

      try {
        const blob = await r2.get(fullKey);
        if (!blob) continue;
        updates.push({
          key: fileName,
          data: blob.toString('base64'),
        });
      } catch {
        continue;
      }
    }

    return reply.send({ updates });
  });

  // ── DELETE /yjs/updates — Delete compacted updates ─────────────────────
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

    const { keys } = parsed.data;
    const r2Keys = keys
      .filter((k) => YJS_KEY_PATTERN.test(k))
      .map((k) => r2.yjsKey(req.userId, k));

    if (r2Keys.length > 0) {
      await r2.delMany(r2Keys);
    }

    return reply.send({ deleted: r2Keys.length });
  });
}

/**
 * Parse a Yjs sync filename back into { docId, isSnapshot, device, ts, seq }.
 * Mirrors the client-side parseSyncFilename() in sync-yjs.js.
 */
function parseYjsFileName(fileName) {
  const EXT = '.yjs.json';
  if (!fileName.endsWith(EXT)) return null;

  const base = fileName.slice(0, -EXT.length);
  const parts = base.split('~~');
  if (parts.length < 3) return null;

  const last = parts[parts.length - 1];
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : null;
  const tsCandidate = Number(last);
  if (!Number.isFinite(tsCandidate)) return null;

  let seq;
  let ts = tsCandidate;
  parts.pop();

  if (secondLast != null) {
    const seqCandidate = Number(secondLast);
    if (Number.isInteger(seqCandidate) && seqCandidate >= 0 && seqCandidate <= 999) {
      seq = seqCandidate;
      parts.pop();
    }
  }

  if (parts.length === 0) return null;
  const device = parts[parts.length - 1];
  parts.pop();

  let isSnapshot = false;
  if (parts.length > 0 && parts[parts.length - 1] === 'snapshot') {
    isSnapshot = true;
    parts.pop();
  }

  const docId = parts.join('~~');
  if (!docId) return null;

  return { docId, isSnapshot, device, ts, seq: seq ?? 0 };
}

module.exports = yjsSyncRoutes;
