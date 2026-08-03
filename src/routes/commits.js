'use strict';

const { z } = require('zod');
const { CommitMeta, Device, Workspace, Subscription, Account } = require('../models');
const r2 = require('../services/r2');
const mlkem = require('../lib/mlkem');
const { createNoteHash } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { getDb } = require('../db');

const COMMIT_BODY_LIMIT_BYTES = parseInt(process.env.COMMIT_BODY_LIMIT_BYTES ?? '1048576', 10);
const MAX_CURSOR_BYTES = parseInt(process.env.COMMIT_CURSOR_QUERY_MAX_BYTES ?? '4096', 10);
const MAX_CURSOR_ENTRIES = parseInt(process.env.COMMIT_CURSOR_MAX_ENTRIES ?? '100', 10);
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const COMMIT_ID_PATTERN = /^\d+-[a-zA-Z0-9_-]+-\d+$/;

const CommitUploadSchema = z.object({
  id: z.string().regex(COMMIT_ID_PATTERN, 'Invalid commit ID format'),
  deviceId: z.string().regex(DEVICE_ID_PATTERN, 'Invalid device ID'),
  clock: z.number().int().min(0),
  ts: z.number().int().min(0),
  payload: z.object({
    v: z.literal(3),
    nonce: z.string(),
    cipher: z.string(),
  }),
});

function parseCursorMap(afterParam) {
  if (Buffer.byteLength(afterParam, 'utf8') > MAX_CURSOR_BYTES) {
    return { error: 'Cursor parameter is too large.' };
  }

  const cursors = {};
  if (!afterParam) {
    return { cursors };
  }

  const parts = afterParam.split(',').filter(Boolean);
  if (parts.length > MAX_CURSOR_ENTRIES) {
    return { error: 'Too many device cursors supplied.' };
  }

  for (const part of parts) {
    const [deviceId, clockStr] = part.split(':');
    if (!deviceId || !clockStr || !DEVICE_ID_PATTERN.test(deviceId)) {
      return { error: 'Cursor format must be deviceId:clock.' };
    }

    const clock = parseInt(clockStr, 10);
    if (!Number.isInteger(clock) || clock < 0) {
      return { error: 'Cursor clocks must be non-negative integers.' };
    }

    cursors[deviceId] = clock;
  }

  return { cursors };
}

async function commitRoutes(app) {
  await app.register(require('../middleware/auth'));
  await app.register(require('../middleware/subscription'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota, app.checkDeviceLimit],
  };

  app.get('/', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.COMMIT_READ_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const afterParam = typeof req.query.after === 'string' ? req.query.after : '';
    const { cursors, error } = parseCursorMap(afterParam);

    if (error) {
      return reply.status(400).send({
        error: 'invalid_cursor',
        message: error,
      });
    }

    const orClauses = Object.entries(cursors).map(([deviceId, clock]) => ({
      accountId: req.userId,
      deviceId,
      clock: { $gt: clock },
    }));

    const query = orClauses.length > 0
      ? { $or: orClauses }
      : { accountId: req.userId };

    const commits = await CommitMeta
      .find(query, { commitId: 1, deviceId: 1, clock: 1, ts: 1 })
      .sort({ ts: 1 })
      .limit(500)
      .lean();

    return reply.send({ commits });
  });

  app.post('/', {
    ...protectWrite,
    bodyLimit: COMMIT_BODY_LIMIT_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/json'],
        maxContentLength: COMMIT_BODY_LIMIT_BYTES,
      },
      rateLimit: {
        max: parseInt(process.env.COMMIT_WRITE_RATE_LIMIT_PER_MINUTE ?? '60', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const parsed = CommitUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.errors[0].message,
      });
    }

    const { id, deviceId, clock, ts, payload } = parsed.data;
    const headerDeviceId = req.headers['x-device-id'];

    if (typeof headerDeviceId !== 'string' || !DEVICE_ID_PATTERN.test(headerDeviceId)) {
      return reply.status(400).send({
        error: 'missing_device_id',
        message: 'A valid X-Device-Id header is required.',
      });
    }

    if (headerDeviceId !== deviceId) {
      app.recordSecurityEvent(req, 'device_id_mismatch', {
        headerDeviceId,
        bodyDeviceId: deviceId,
      });
      return reply.status(400).send({
        error: 'device_id_mismatch',
        message: 'Commit deviceId must match the X-Device-Id header.',
      });
    }

    const [, commitDeviceId, commitClock] = id.split('-');
    if (commitDeviceId !== deviceId || parseInt(commitClock, 10) !== clock) {
      return reply.status(400).send({
        error: 'invalid_commit_identity',
        message: 'Commit ID must match the provided deviceId and clock.',
      });
    }

    const existing = await CommitMeta.findOne({ commitId: id, accountId: req.userId }).lean();
    if (existing) {
      return reply.status(200).send({ commitId: id, status: 'already_exists' });
    }

    const payloadString = JSON.stringify(payload);
    const key = r2.commitKey(req.userId, id);
    const payloadBuffer = await mlkem.wrapBlob(Buffer.from(payloadString, 'utf8'));
    await r2.put(key, payloadBuffer, 'application/json');

    const sizeBytes = payloadBuffer.byteLength;

    const noteIdHeader = req.headers['x-note-id'];
    const noteIdHash = typeof noteIdHeader === 'string' && noteIdHeader.length > 0
      ? createNoteHash(noteIdHeader)
      : null;

    await CommitMeta.create({
      commitId: id,
      accountId: req.userId,
      deviceId,
      noteIdHash,
      clock,
      ts,
      sizeBytes,
    });

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    await Device.findOneAndUpdate(
      { accountId: req.userId, deviceId },
      { label: deviceLabel, lastSeen: new Date() },
      { upsert: true, new: true }
    );

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

    audit(req, 'note_edited', { commitId: id, noteId: noteIdHeader ?? null, workspaceId: req.workspaceId ?? null });

    return reply.status(201).send({ commitId: id, sizeBytes });
  });

  app.get('/history', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.COMMIT_HISTORY_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const noteId = req.query.noteId;
    if (!noteId || typeof noteId !== 'string') {
      return reply.status(400).send({ error: 'validation_error', message: 'noteId query parameter is required.' });
    }

    const noteIdHash = createNoteHash(noteId);
    if (!noteIdHash) {
      return reply.status(500).send({ error: 'server_error', message: 'Note HMAC not configured on this server.' });
    }

    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const beforeTs = parseInt(req.query.before, 10);
    const before = Number.isFinite(beforeTs) ? new Date(beforeTs) : null;

    const db = getDb();
    const params = [req.userId, noteIdHash];
    let sql = `
      SELECT
        commits.commit_id AS commitId,
        commits.device_id AS deviceId,
        commits.clock,
        commits.ts,
        commits.created_at AS createdAt,
        accounts.username AS authorName,
        devices.label AS deviceLabel
      FROM commits
      LEFT JOIN accounts ON commits.account_id = accounts.id
      LEFT JOIN devices ON commits.account_id = devices.account_id AND commits.device_id = devices.device_id
      WHERE commits.account_id = ? AND commits.note_id_hash = ?
    `;
    if (before) {
      sql += ` AND commits.created_at < ?`;
      params.push(before.toISOString());
    }
    sql += ` ORDER BY commits.created_at DESC LIMIT ?`;
    params.push(limit);

    const commits = db.prepare(sql).all(...params);

    return reply.send({ commits, noteId });
  });

  app.get('/:id', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.COMMIT_OBJECT_READ_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const commitId = req.params.id;

    if (!COMMIT_ID_PATTERN.test(commitId)) {
      return reply.status(400).send({
        error: 'invalid_commit_id',
        message: 'Commit ID format is invalid.',
      });
    }

    const meta = await CommitMeta.findOne({
      commitId,
      accountId: req.userId,
    }).lean();

    if (!meta) {
      app.recordSecurityEvent(req, 'commit_access_denied', { commitId });
      return reply.status(404).send({
        error: 'not_found',
        message: 'Commit not found.',
      });
    }

    const key = r2.commitKey(req.userId, commitId);
    const blob = await r2.get(key);

    if (!blob) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'Commit data not found in storage.',
      });
    }

    const plaintext = await mlkem.unwrapBlob(blob);
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(plaintext.toString('utf8'));
    } catch {
      parsedPayload = plaintext.toString('utf8');
    }

    reply.header('Content-Type', 'application/json');
    return reply.send(parsedPayload);
  });
}

module.exports = commitRoutes;
