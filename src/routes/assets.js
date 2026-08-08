'use strict';

const r2 = require('../services/r2');
const { Subscription, Workspace } = require('../models');
const { verifyAssetSignature } = require('../lib/asset-sign');
const { storageConfig } = require('../services/r2');

const MAX_ASSET_SIZE_BYTES = parseInt(
  process.env.MAX_ASSET_SIZE_BYTES ?? String(100 * 1024 * 1024),
  10
);
const ASSET_URL_TTL_SECONDS = Math.min(
  parseInt(process.env.ASSET_URL_TTL_SECONDS ?? '300', 10),
  900
);
const ASSET_KEY_PATTERN = /^[a-zA-Z0-9._ -]{1,256}$/;

async function assetRoutes(app) {
  await app.register(require('../middleware/auth'));
  await app.register(require('../middleware/subscription'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota],
  };

  const BATCH_MAX_ITEMS = 20;
  const BATCH_MAX_BODY_BYTES = 10 * 1024 * 1024;

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

    const results = [];
    for (const item of assets) {
      const assetKey = item.key;
      const dataB64 = item.data;
      if (!assetKey || !dataB64 || !ASSET_KEY_PATTERN.test(assetKey)) {
        results.push({ key: assetKey || '?', status: 'error', error: 'invalid_key' });
        continue;
      }

      const body = Buffer.from(dataB64, 'base64');
      if (body.length === 0) {
        results.push({ key: assetKey, status: 'error', error: 'empty_body' });
        continue;
      }
      if (body.length > MAX_ASSET_SIZE_BYTES) {
        results.push({ key: assetKey, status: 'skipped', error: 'too_large' });
        continue;
      }

      const r2Key = r2.assetKey(req.userId, assetKey);
      try {
        const existing = await r2.stat(r2Key);
        if (existing) {
          results.push({ key: assetKey, status: 'already_exists', sizeBytes: existing.sizeBytes });
          continue;
        }
      } catch (err) {
        if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
          results.push({ key: assetKey, status: 'error', error: 'storage_unavailable' });
          continue;
        }
        throw err;
      }

      try {
        await r2.put(r2Key, body, 'application/octet-stream', { ifNoneMatch: true });
      } catch (err) {
        if (err && (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412)) {
          results.push({ key: assetKey, status: 'already_exists', sizeBytes: body.length });
          continue;
        }
        results.push({ key: assetKey, status: 'error', error: err.message });
        continue;
      }

      if (req.workspaceId) {
        await Workspace.updateOne(
          { _id: req.workspaceId },
          { $inc: { storageUsedBytes: body.length } }
        );
      } else {
        await Subscription.updateOne(
          { accountId: req.userId },
          { $inc: { storageUsedBytes: body.length } }
        );
      }
      results.push({ key: assetKey, status: 'uploaded', sizeBytes: body.length });
    }

    const uploaded = results.filter((r) => r.status === 'uploaded').length;
    const skipped = results.filter((r) => r.status === 'already_exists').length;
    return reply.send({ results, uploaded, skipped, total: assets.length });
  });

  // ── Seed batch upload (higher limits, no rate limit) ──────────────
  // Used during initial workspace seed to upload many assets at once.
  const SEED_BATCH_MAX_ITEMS = 50;
  const SEED_BATCH_MAX_BODY_BYTES = 100 * 1024 * 1024;

  app.post('/seed-batch', {
    ...protectWrite,
    bodyLimit: SEED_BATCH_MAX_BODY_BYTES,
    config: {
      rateLimit: false,
    },
  }, async (req, reply) => {
    const { assets } = req.body || {};
    if (!Array.isArray(assets) || assets.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain an assets array.' });
    }
    if (assets.length > SEED_BATCH_MAX_ITEMS) {
      return reply.status(400).send({ error: 'too_many_items', message: `Max ${SEED_BATCH_MAX_ITEMS} assets per batch.` });
    }

    const results = [];
    for (const item of assets) {
      const assetKey = item.key;
      const dataB64 = item.data;
      if (!assetKey || !dataB64 || !ASSET_KEY_PATTERN.test(assetKey)) {
        results.push({ key: assetKey || '?', status: 'error', error: 'invalid_key' });
        continue;
      }

      const body = Buffer.from(dataB64, 'base64');
      if (body.length === 0) {
        results.push({ key: assetKey, status: 'error', error: 'empty_body' });
        continue;
      }
      if (body.length > MAX_ASSET_SIZE_BYTES) {
        results.push({ key: assetKey, status: 'skipped', error: 'too_large' });
        continue;
      }

      const r2Key = r2.assetKey(req.userId, assetKey);
      try {
        const existing = await r2.stat(r2Key);
        if (existing) {
          results.push({ key: assetKey, status: 'already_exists', sizeBytes: existing.sizeBytes });
          continue;
        }
      } catch (err) {
        if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
          results.push({ key: assetKey, status: 'error', error: 'storage_unavailable' });
          continue;
        }
        throw err;
      }

      try {
        await r2.put(r2Key, body, 'application/octet-stream', { ifNoneMatch: true });
      } catch (err) {
        if (err && (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412)) {
          results.push({ key: assetKey, status: 'already_exists', sizeBytes: body.length });
          continue;
        }
        results.push({ key: assetKey, status: 'error', error: err.message });
        continue;
      }

      if (req.workspaceId) {
        await Workspace.updateOne(
          { _id: req.workspaceId },
          { $inc: { storageUsedBytes: body.length } }
        );
      } else {
        await Subscription.updateOne(
          { accountId: req.userId },
          { $inc: { storageUsedBytes: body.length } }
        );
      }
      results.push({ key: assetKey, status: 'uploaded', sizeBytes: body.length });
    }

    const uploaded = results.filter((r) => r.status === 'uploaded').length;
    const skipped = results.filter((r) => r.status === 'already_exists').length;
    return reply.send({ results, uploaded, skipped, total: assets.length });
  });

  // ── Unauthenticated HMAC-signed endpoints (for MinIO parity) ─────────
  // These bypass session auth — the HMAC token IS the authorization.
  // Used when STORAGE_BACKEND=minio (internal Docker hostnames are unresolvable
  // from clients, so presigned URLs must route through the API server).

  app.get('/download', {
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_BATCH_DOWNLOAD_RATE_LIMIT_PER_MINUTE ?? '600', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { key, userId, expires, sig } = req.query || {};
    if (!key || !userId || !expires || !sig) {
      return reply.status(400).send({ error: 'missing_params', message: 'Missing key, userId, expires, or sig.' });
    }

    const expiresNum = parseInt(expires, 10);
    if (!verifyAssetSignature(key, userId, expiresNum, sig)) {
      return reply.status(403).send({ error: 'invalid_signature', message: 'Invalid or expired download token.' });
    }

    if (!ASSET_KEY_PATTERN.test(key)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    const r2Key = r2.assetKey(userId, key);

    let stat;
    try {
      stat = await r2.stat(r2Key);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({ error: 'storage_unavailable', message: 'Asset storage is not available.' });
      }
      throw err;
    }
    if (!stat) {
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

    const stream = await r2.getStream(r2Key);
    if (!stream) {
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

    return reply
      .type('application/octet-stream')
      .header('Content-Length', stat.sizeBytes)
      .header('Cache-Control', 'no-store')
      .send(stream);
  });

  app.put('/upload', {
    bodyLimit: MAX_ASSET_SIZE_BYTES,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_WRITE_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { key, userId, expires, sig } = req.query || {};
    if (!key || !userId || !expires || !sig) {
      return reply.status(400).send({ error: 'missing_params', message: 'Missing key, userId, expires, or sig.' });
    }

    const expiresNum = parseInt(expires, 10);
    if (!verifyAssetSignature(key, userId, expiresNum, sig)) {
      return reply.status(403).send({ error: 'invalid_signature', message: 'Invalid or expired upload token.' });
    }

    if (!ASSET_KEY_PATTERN.test(key)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_ASSET_SIZE_BYTES) {
      return reply.status(413).send({ error: 'payload_too_large', message: 'Asset too large.' });
    }

    const body = req.body;
    if (!body || body.length === 0) {
      return reply.status(400).send({ error: 'empty_body', message: 'Asset body cannot be empty.' });
    }

    const r2Key = r2.assetKey(userId, key);

    try {
      await r2.put(r2Key, body, 'application/octet-stream');
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({ error: 'storage_unavailable', message: 'Asset storage is not available.' });
      }
      throw err;
    }

    return reply.status(201).send({ assetKey: key, sizeBytes: body.length });
  });

  app.get('/', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_LIST_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    let allKeys;
    try {
      allKeys = await r2.listKeys(`${req.userId}/assets/`);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    const prefix = `${req.userId}/assets/`;
    const assetKeys = allKeys
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));

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

    if (!ASSET_KEY_PATTERN.test(assetKey)) {
      return reply.status(400).send({
        error: 'invalid_key',
        message: 'Asset key must be alphanumeric with dashes, underscores, or dots.',
      });
    }

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_ASSET_SIZE_BYTES) {
      return reply.status(413).send({
        error: 'payload_too_large',
        message: `Assets must be under ${MAX_ASSET_SIZE_BYTES / 1_048_576}MB.`,
      });
    }

    const key = r2.assetKey(req.userId, assetKey);

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

    if (!ASSET_KEY_PATTERN.test(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    const key = r2.assetKey(req.userId, assetKey);

    let stat;
    try {
      stat = await r2.stat(key);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!stat) {
      app.recordSecurityEvent(req, 'asset_access_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

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

    if (!ASSET_KEY_PATTERN.test(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    const key = r2.assetKey(req.userId, assetKey);

    let stat;
    try {
      stat = await r2.stat(key);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!stat) {
      app.recordSecurityEvent(req, 'asset_access_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

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

    if (!ASSET_KEY_PATTERN.test(assetKey)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    const key = r2.assetKey(req.userId, assetKey);

    let stat;
    try {
      stat = await r2.stat(key);
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({
          error: 'storage_unavailable',
          message: 'Asset storage is not available. Please try again later.',
        });
      }
      throw err;
    }
    if (!stat) {
      app.recordSecurityEvent(req, 'asset_delete_denied', { assetKey });
      return reply.status(404).send({ error: 'not_found', message: 'Asset not found.' });
    }

    await r2.del(key);

    await Subscription.updateOne(
      { accountId: req.userId },
      { $inc: { storageUsedBytes: -stat.sizeBytes } }
    );

    return reply.send({ deleted: true, assetKey });
  });

  app.post('/presign-batch', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_WRITE_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { keys } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain a keys array.' });
    }
    if (keys.length > 200) {
      return reply.status(400).send({ error: 'too_many_keys', message: 'Max 200 keys per presign request.' });
    }

    const useProxy = storageConfig.provider === 'minio';
    const PRESIGN_TTL = 3600;
    const urls = [];

    if (useProxy) {
      // MinIO: generate server-proxied HMAC-signed upload URLs
      const { signAssetUpload } = require('../lib/asset-sign');
      for (const assetKey of keys) {
        if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) continue;
        const { url } = signAssetUpload(assetKey, req.userId, PRESIGN_TTL);
        urls.push({ assetKey, url });
      }
    } else {
      // R2/S3: generate native presigned PUT URLs
      for (const assetKey of keys) {
        if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) continue;
        try {
          const key = r2.assetKey(req.userId, assetKey);
          const url = await r2.presignPut(key, 'application/octet-stream', PRESIGN_TTL);
          urls.push({ assetKey, url });
        } catch (err) {
          console.warn('[assets] presign failed:', assetKey, err.message);
        }
      }
    }

    return reply.send({ urls, expiresInSeconds: PRESIGN_TTL });
  });

  app.post('/presign-get-batch', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_READ_RATE_LIMIT_PER_MINUTE ?? '120', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { keys } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain a keys array.' });
    }
    if (keys.length > 200) {
      return reply.status(400).send({ error: 'too_many_keys', message: 'Max 200 keys per request.' });
    }

    const useProxy = storageConfig.provider === 'minio';
    const PRESIGN_TTL = 3600;
    const urls = [];

    if (useProxy) {
      // MinIO: generate server-proxied HMAC-signed URLs
      const { signAssetDownload } = require('../lib/asset-sign');
      for (const assetKey of keys) {
        if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) continue;
        const key = r2.assetKey(req.userId, assetKey);
        try {
          const stat = await r2.stat(key);
          if (!stat) continue;
          const { url } = signAssetDownload(assetKey, req.userId, PRESIGN_TTL);
          urls.push({ assetKey, url, sizeBytes: stat.sizeBytes });
        } catch (err) {
          console.warn('[assets] presign-get-proxy failed:', assetKey, err.message);
        }
      }
    } else {
      // R2/S3: generate native presigned URLs (externally resolvable)
      for (const assetKey of keys) {
        if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) continue;
        const key = r2.assetKey(req.userId, assetKey);
        try {
          const stat = await r2.stat(key);
          if (!stat) continue;
          const url = await r2.presignGet(key, PRESIGN_TTL);
          urls.push({ assetKey, url, sizeBytes: stat.sizeBytes });
        } catch (err) {
          console.warn('[assets] presign-get failed:', assetKey, err.message);
        }
      }
    }

    return reply.send({ urls, expiresInSeconds: PRESIGN_TTL });
  });

  app.post('/confirm-seed', {
    ...protect,
    config: {
      rateLimit: {
        max: parseInt(process.env.ASSET_WRITE_RATE_LIMIT_PER_MINUTE ?? '30', 10),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { keys } = req.body || {};
    if (!Array.isArray(keys)) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain a keys array.' });
    }

    let verified = 0;
    let totalSizeBytes = 0;
    for (const assetKey of keys) {
      if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) continue;
      const key = r2.assetKey(req.userId, assetKey);
      const stat = await r2.stat(key);
      if (stat) {
        verified++;
        totalSizeBytes += stat.sizeBytes;
      }
    }

    if (req.workspaceId && totalSizeBytes > 0) {
      await Workspace.updateOne(
        { _id: req.workspaceId },
        { $inc: { storageUsedBytes: totalSizeBytes } }
      );
    } else if (totalSizeBytes > 0) {
      await Subscription.updateOne(
        { accountId: req.userId },
        { $inc: { storageUsedBytes: totalSizeBytes } }
      );
    }

    return reply.send({ verified, total: keys.length, sizeBytes: totalSizeBytes });
  });
}

module.exports = assetRoutes;
