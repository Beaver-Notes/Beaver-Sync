'use strict';

const r2 = require('../services/r2');
const crypto = require('crypto');
const { query } = require('../db');
const { Subscription, Workspace, WorkspaceMember } = require('../models');
const {
  MAX_ASSET_SIZE_BYTES,
  ASSET_URL_TTL_SECONDS,
  isValidAssetKey,
  storeAssetBatch,
  ledgerWorkspaceForAsset,
  debitAssetStorage,
  assetStoreKey,
  resolveAssetLocation,
  decodeAssetKey,
} = require('./assets-shared');
const { registerAssetProxyRoutes } = require('./assets-proxy');
const { registerAssetPresignRoutes } = require('./assets-presign');

async function assetRoutes(app) {
  await app.register(require('../middleware/auth'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota],
  };

  const BATCH_MAX_ITEMS = 20;
  const BATCH_MAX_BODY_BYTES = 10 * 1024 * 1024;

  // A batch that stored nothing is a failure, not a success with an empty
  // `results` array the client may ignore.
  const CLIENT_BATCH_ERRORS = new Set(['invalid_key', 'empty_body', 'too_large']);
  function sendBatchResult(reply, results, total) {
    const uploaded = results.filter((r) => r.status === 'uploaded').length;
    const skipped = results.filter((r) => r.status === 'already_exists').length;
    if (uploaded === 0 && skipped === 0) {
      const storageFailure = results.some((r) => r.status === 'error' && !CLIENT_BATCH_ERRORS.has(r.error));
      return reply.status(storageFailure ? 502 : 400).send({
        error: 'batch_failed',
        message: 'No assets were stored.',
        results, uploaded, skipped, total,
      });
    }
    return reply.send({ results, uploaded, skipped, total });
  }

  app.post('/batch', {
    ...protectWrite,
    bodyLimit: BATCH_MAX_BODY_BYTES,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_WRITE_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || assets.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain an assets array.' });
    }
    if (assets.length > BATCH_MAX_ITEMS) {
      return reply.status(400).send({ error: 'too_many_items', message: `Max ${BATCH_MAX_ITEMS} assets per batch.` });
    }

    const results = await storeAssetBatch(req, assets);
    return sendBatchResult(reply, results, assets.length);
  });

  // Used during initial workspace seed to upload many assets at once.
  const SEED_BATCH_MAX_ITEMS = 50;
  const SEED_BATCH_MAX_BODY_BYTES = 100 * 1024 * 1024;

  app.post('/seed-batch', {
    ...protectWrite,
    bodyLimit: SEED_BATCH_MAX_BODY_BYTES,
    config: {
      rateLimit: {
        max: parseInt(process.env.SEED_BATCH_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || assets.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain an assets array.' });
    }
    if (assets.length > SEED_BATCH_MAX_ITEMS) {
      return reply.status(400).send({ error: 'too_many_items', message: `Max ${SEED_BATCH_MAX_ITEMS} assets per batch.` });
    }

    const results = await storeAssetBatch(req, assets);
    return sendBatchResult(reply, results, assets.length);
  });

  await registerAssetProxyRoutes(app);

  app.get('/', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_LIST_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const prefix = `${req.userId}/assets/`;
    const prefixes = [prefix];
    // Shared (workspace-namespaced) keys live outside the account prefix.
    // Every member workspace's `ws-assets/<wsId>/assets/` prefix is listed and
    // stripped the same way so the client sees flat assetKeys uniformly.
    const memberShips = await WorkspaceMember.find({ accountId: req.userId }, { workspaceId: 1 }).lean();
    for (const m of memberShips) {
      prefixes.push(r2.sharedAssetKey(m.workspaceId, ''));
    }

    let allKeys;
    try {
      const lists = await Promise.all(prefixes.map((p) => r2.listKeys(p)));
      allKeys = lists.flat();
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    const assetSet = new Set();
    for (const p of prefixes) {
      for (const k of allKeys) {
        if (k.startsWith(p)) assetSet.add(k.slice(p.length));
      }
    }
    const assetKeys = [...assetSet];

    // Workspace scoping can no longer be done server-side: asset keys are now
    // opaque (`assets--<encrypted token>`) and the server must not be able to
    // read the workspace id. The account-global list is returned; the client
    // decrypts each key and filters locally. `?workspaceId=` is accepted and
    // ignored for backward compatibility (it previously filtered, which would
    // now silently drop every opaque asset).
    return reply.send({
      keys: assetKeys,
      count: assetKeys.length,
    });
  });

  app.put('/:key', {
    ...protectWrite,
    bodyLimit: MAX_ASSET_SIZE_BYTES,
    config: {
      security: {
        allowedContentTypes: ['application/octet-stream'],
        maxContentLength: MAX_ASSET_SIZE_BYTES,
        requireContentLength: true,
      },
      rateLimit: {
        max: parseInt(process.env.ASSET_WRITE_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const assetKey = req.params.key;

    if (!isValidAssetKey(assetKey)) {
      return reply.status(400).send({
        error: 'invalid_key',
        message: 'Asset key must be a non-empty name without path separators.',
      });
    }

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_ASSET_SIZE_BYTES) {
      return reply.status(413).send({
        error: 'payload_too_large',
        message: `Assets must be under ${MAX_ASSET_SIZE_BYTES / 1_048_576}MB.`,
      });
    }

    // Workspace context resolves BEFORE any write: a shared-namespace key must
    // only be creatable by a verified owner/editor of that workspace, so the
    // 404/403 checks below have to precede the stat/put, not follow it.
    // (A binary PUT carries no JSON body, so checkStorageQuota never set
    // req.workspaceId — read the client's x-workspace-id header instead.)
    const headerWorkspaceId = req.workspaceId ?? req.headers['x-workspace-id'];
    let validWorkspace = null;
    if (headerWorkspaceId) {
      const ws = await Workspace.findById(headerWorkspaceId);
      if (!ws) {
        return reply.status(404).send({ error: 'workspace_not_found', message: 'Workspace not found.' });
      }
      const member = await WorkspaceMember.findOne({ workspaceId: headerWorkspaceId, accountId: req.userId }).lean();
      if (!member || !['owner', 'editor'].includes(member.role)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Not allowed to write to this workspace.' });
      }
      validWorkspace = headerWorkspaceId;
    }

    const key = assetStoreKey(req.userId, assetKey, validWorkspace);

    let existing;
    try {
      existing = await r2.stat(key);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (existing) {
      return reply.send({ assetKey, status: 'already_exists', sizeBytes: existing.sizeBytes });
    }

    const body = req.body;
    if (!body || body.length === 0) {
      return reply.status(400).send({
        error: 'empty_body',
        message: 'Asset body cannot be empty.',
      });
    }

    try {
      await r2.put(key, body, 'application/octet-stream', { ifNoneMatch: true });
    } catch (err) {
      if (err && (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412)) {
        return reply.send({ assetKey, status: 'already_exists', sizeBytes: body.length });
      }
      throw err;
    }

    const sizeBytes = body.length;

    if (validWorkspace) {
      await Workspace.updateOne(
        { _id: validWorkspace },
        { $inc: { storageUsedBytes: sizeBytes } }
      );
      // Ledger row with a workspace id: a later delete debits the workspace
      // bucket (same insert the /assets/batch path writes).
      const now = new Date().toISOString();
      await query(
        `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7)`,
        [crypto.randomUUID(), req.userId, validWorkspace, assetKey, sizeBytes, now, now]
      );
    } else if (req.workspaceId) {
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

    return reply.status(201).send({ assetKey, sizeBytes });
  });

  app.get('/:key', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_READ_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const assetKey = req.params.key;

    if (!isValidAssetKey(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    let located;
    try {
      located = await resolveAssetLocation(req.userId, assetKey);
    } catch (err) {
      if (err.statusCode === 503) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!located) {
      app.recordSecurityEvent(req, 'asset_access_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }
    const key = located.key;

    const url = await r2.presignGet(key, ASSET_URL_TTL_SECONDS);

    return reply.send({
      url,
      expiresInSeconds: ASSET_URL_TTL_SECONDS,
      expiresAt: new Date(Date.now() + ASSET_URL_TTL_SECONDS * 1000).toISOString(),
    });
  });

  app.get('/:key/content', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_READ_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const assetKey = req.params.key;

    if (!isValidAssetKey(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    let located;
    try {
      located = await resolveAssetLocation(req.userId, assetKey);
    } catch (err) {
      if (err.statusCode === 503) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!located) {
      app.recordSecurityEvent(req, 'asset_access_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }
    const key = located.key;

    const stream = await r2.getStream(key);
    if (!stream) {
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

    return reply.type('application/octet-stream').send(stream);
  });

  app.delete('/:key', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_DELETE_RATE_LIMIT_PER_MINUTE ?? '20', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const assetKey = req.params.key;

    if (!isValidAssetKey(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    let located;
    try {
      located = await resolveAssetLocation(req.userId, assetKey);
    } catch (err) {
      if (err.statusCode === 503) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!located) {
      app.recordSecurityEvent(req, 'asset_delete_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

    await r2.del(located.key);

    // Shared objects carry their workspace in the key itself; debit the
    // workspace directly. The per-account ledger lookup would otherwise read
    // the first uploader's account row, not the workspace that owns the copy.
    let workspaceId;
    if (located.shared) {
      workspaceId = decodeAssetKey(assetKey)?.workspaceId ?? null;
    } else {
      workspaceId = await ledgerWorkspaceForAsset(req.userId, assetKey);
    }
    await debitAssetStorage(req.userId, workspaceId, located.sizeBytes);

    return reply.send({ deleted: true, assetKey });
  });

  await registerAssetPresignRoutes(app, protect);
}

module.exports = assetRoutes;
