'use strict';

const { z } = require('zod');
const { CommitMeta, Device, Workspace, Subscription } = require('../models');
const r2 = require('../services/r2');
const mlkem = require('../lib/mlkem');
const { createNoteHash } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { historyCutoffTs } = require('../lib/plan-lifecycle');
const { resolveEffectivePlan } = require('../lib/plan-resolution');
const { listHistory, userIsMemberOfNoteWorkspace } = require('../repositories/commits');
const { DEVICE_ID_PATTERN, isPlaceholderDeviceLabel } = require('../lib/patterns');

const COMMIT_BODY_LIMIT_BYTES = parseInt(process.env.COMMIT_BODY_LIMIT_BYTES ?? '1048576', 10);
const MAX_CURSOR_BYTES = parseInt(process.env.COMMIT_CURSOR_QUERY_MAX_BYTES ?? '4096', 10);
const MAX_CURSOR_ENTRIES = parseInt(process.env.COMMIT_CURSOR_MAX_ENTRIES ?? '100', 10);
const COMMIT_ID_PATTERN = /^\d+-[a-zA-Z0-9_-]+-\d+$/;

const CommitLegacyPayload = z.object({
  v: z.literal(3),
  nonce: z.string(),
  cipher: z.string(),
});

// v4/v5 sync envelopes are sent as JSON strings (see Beaver-Notes crypto.js
// encryptJSON). v6 is the shared note-key envelope the client uses for notes
// with a collaboration key. Raw non-envelope strings are still rejected.
const CommitEnvelopePayload = z.string().min(1).refine((s) => {
  try {
    const parsed = JSON.parse(s);
    return !!parsed && (parsed.v === 4 || parsed.v === 5 || parsed.v === 6);
  } catch {
    return false;
  }
}, 'Invalid sync envelope payload');

const CommitUploadSchema = z.object({
  id: z.string().regex(COMMIT_ID_PATTERN, 'Invalid commit ID format'),
  deviceId: z.string().regex(DEVICE_ID_PATTERN, 'Invalid device ID'),
  clock: z.number().int().min(0),
  ts: z.number().int().min(0),
  payload: z.union([CommitLegacyPayload, CommitEnvelopePayload]),
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

    // The plan window applies here too, but it is surfaced explicitly via
    // `historyLimited` so a limited/empty feed is never mistaken for data loss.
    const { plan } = await resolveEffectivePlan(req);
    const cutoffTs = historyCutoffTs(plan);

    const baseFilter = { accountId: req.userId };
    if (cutoffTs > 0) baseFilter.createdAt = { $gte: new Date(cutoffTs).toISOString() };

    const query = orClauses.length > 0
      ? { ...baseFilter, $or: orClauses }
      : baseFilter;

    const commits = await CommitMeta
      .find(query, { commitId: 1, deviceId: 1, clock: 1, ts: 1 })
      .sort({ ts: 1 })
      .limit(500)
      .lean();

    return reply.send({ commits, historyLimited: cutoffTs > 0 });
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
        // ponytail: 240, not 60 — one keystroke burst is a push-batch plus a
        // commit, and the client coalesces only 1.5s, so fast typing in two
        // windows hit 2.7x a 60/min bucket and lost edits to 429s.
        max: parseInt(process.env.COMMIT_WRITE_RATE_LIMIT_PER_MINUTE ?? '240', 10),
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

    // Commit IDs are `${ts}-${deviceId}-${clock}` and deviceIds may
    // themselves contain dashes (UUIDs), so split on the first/last dash.
    const firstDash = id.indexOf('-');
    const lastDash = id.lastIndexOf('-');
    const commitDeviceId = firstDash > 0 && lastDash > firstDash
      ? id.slice(firstDash + 1, lastDash)
      : null;
    const commitClock = lastDash > firstDash ? id.slice(lastDash + 1) : null;
    if (commitDeviceId !== deviceId || parseInt(commitClock, 10) !== clock) {
      return reply.status(400).send({
        error: 'invalid_commit_identity',
        message: 'Commit ID must match the provided deviceId and clock.',
      });
    }

    // `commits.commit_id` is a global primary key, so the pre-check must look
    // up the id globally and compare ownership. An account-scoped lookup would
    // miss a foreign row and the insert would then 23505 into a false
    // `already_exists` (a squatter could vanish a victim's commit).
    const existing = await CommitMeta.findOne({ commitId: id }).lean();
    if (existing) {
      if (existing.accountId !== req.userId) {
        app.recordSecurityEvent(req, 'commit_id_conflict', { commitId: id });
        return reply.status(409).send({
          error: 'commit_id_conflict',
          message: 'This commit id already belongs to another account.',
        });
      }
      return reply.status(200).send({ commitId: id, status: 'already_exists' });
    }

    // v4/v5/v6 envelopes arrive as JSON strings from the client (encryptJSON);
    // storing JSON.stringify(string) would double-encode them and break decrypt
    // on read. Legacy v3 arrives as an object and is serialized as before.
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const key = r2.commitKey(req.userId, id);
    const payloadBuffer = await mlkem.wrapBlob(Buffer.from(payloadString, 'utf8'));
    await r2.put(key, payloadBuffer, 'application/json');

    const sizeBytes = payloadBuffer.byteLength;

    const noteIdHeader = req.headers['x-note-id'];
    const noteIdHash = typeof noteIdHeader === 'string' && noteIdHeader.length > 0
      ? createNoteHash(noteIdHeader)
      : null;

    try {
      await CommitMeta.create({
        commitId: id,
        accountId: req.userId,
        deviceId,
        noteIdHash,
        workspaceId: req.workspaceId ?? null,
        clock,
        ts,
        sizeBytes,
      });
    } catch (err) {
      // Concurrent retries of the same commit race the pre-check above; treat
      // the unique-key loser as the idempotent success it is, not a 500. A row
      // that turns out to belong to another account is a real conflict.
      if (err?.code === '23505' || /unique|duplicate/i.test(String(err?.message ?? ''))) {
        const clash = await CommitMeta.findOne({ commitId: id }).lean();
        if (clash && clash.accountId !== req.userId) {
          app.recordSecurityEvent(req, 'commit_id_conflict', { commitId: id });
          return reply.status(409).send({
            error: 'commit_id_conflict',
            message: 'This commit id already belongs to another account.',
          });
        }
        return reply.status(200).send({ commitId: id, status: 'already_exists' });
      }
      throw err;
    }

    const deviceLabel = String(req.headers['x-device-label'] ?? 'Unknown Device').slice(0, 128);
    // Legacy hardcoded labels must not clobber a real model stored earlier.
    await Device.findOneAndUpdate(
      { accountId: req.userId, deviceId },
      isPlaceholderDeviceLabel(deviceLabel)
        ? { lastSeen: new Date() }
        : { label: deviceLabel, lastSeen: new Date() },
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

    const { plan } = await resolveEffectivePlan(req);
    const cutoffTs = historyCutoffTs(plan);

    // A member of the workspace that owns the note sees every collaborator's
    // commits; everyone else (personal notes, non-members) sees only their own.
    const allAccounts = await userIsMemberOfNoteWorkspace(req.userId, noteId);

    const commits = await listHistory({ userId: req.userId, noteIdHash, before, cutoffTs, limit, allAccounts });

    // Surface the plan window explicitly: an empty result may mean "no history"
    // or "older than your plan allows". `limited` lets the client explain it
    // instead of rendering a false empty state.
    return reply.send({ commits, noteId, historyLimited: cutoffTs > 0 });
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

    const noteIdHeader = req.headers['x-note-id'];
    const noteId = typeof noteIdHeader === 'string' && noteIdHeader.length > 0 ? noteIdHeader : '';
    const noteIdHash = noteId ? createNoteHash(noteId) : null;

    let meta;
    if (noteIdHash) {
      // A collaborator can read a note's commits by note identity, not only the
      // account that pushed them. Members of the owning workspace may read;
      // anyone else only their own commit.
      meta = await CommitMeta.findOne({ commitId, noteIdHash }).lean();
      if (
        meta &&
        meta.accountId !== req.userId &&
        !(await userIsMemberOfNoteWorkspace(req.userId, noteId))
      ) {
        meta = null;
      }
    } else {
      // Legacy callers without X-Note-Id keep the account-scoped lookup.
      meta = await CommitMeta.findOne({
        commitId,
        accountId: req.userId,
      }).lean();
    }

    if (!meta) {
      app.recordSecurityEvent(req, 'commit_access_denied', { commitId });
      return reply.status(404).send({
        error: 'not_found',
        message: 'Commit not found.',
      });
    }

    // The blob lives under the pusher's prefix, not the reader's.
    const key = r2.commitKey(meta.accountId, commitId);
    const blob = await r2.get(key);

    if (!blob) {
      return reply.status(404).send({
        error: 'not_found',
        message: 'Commit data not found in storage.',
      });
    }

    const plaintext = await mlkem.unwrapBlob(blob);
    // The client (Beaver-Notes getCommitSnapshot) reads the body as JSON and
    // requires a STRING envelope, so reply with a JSON string literal. If the
    // stored plaintext is itself a JSON string (legacy double-encoded rows),
    // unwrap one level so the client still receives a single envelope string.
    let payloadString = plaintext.toString('utf8');
    try {
      const parsed = JSON.parse(payloadString);
      if (typeof parsed === 'string') payloadString = parsed;
    } catch {
      // Not JSON: return the raw bytes as a JSON string.
    }

    reply.header('Content-Type', 'application/json');
    return reply.send(JSON.stringify(payloadString));
  });
}

module.exports = commitRoutes;
