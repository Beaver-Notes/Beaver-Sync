'use strict';

const r2 = require('../services/r2');
const { verifyAssetSignature } = require('../lib/asset-sign');
const { Subscription } = require('../models');
const { MAX_ASSET_SIZE_BYTES, ASSET_KEY_PATTERN } = require('./assets-shared');

// These bypass session auth — the HMAC token IS the authorization.
// Used when STORAGE_BACKEND=minio (internal Docker hostnames are unresolvable
// from clients, so presigned URLs must route through the API server).

async function registerAssetProxyRoutes(app) {
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

    // Enforce quota even on the signed-proxy path (otherwise presign + proxy bypasses accounting)
    try {
      const statBefore = await r2.stat(r2.assetKey(userId, key)).catch(() => null);
      const existingSize = statBefore?.sizeBytes ?? 0;
      const delta = body.length - existingSize;
      if (delta > 0) {
        const sub = await Subscription.findOne({ accountId: userId }).lean();
        if (sub) {
          const { getQuotaBytes } = require('../lib/plans');
          const quota = getQuotaBytes(sub.plan, sub.seats ?? 1);
          if (quota && (sub.storageUsedBytes ?? 0) + delta > quota) {
            return reply.status(507).send({
              error: 'storage_quota_exceeded',
              message: 'Asset would exceed your storage quota.',
              storageUsedBytes: sub.storageUsedBytes ?? 0,
              storageQuotaBytes: quota,
            });
          }
        }
      }
    } catch { /* quota check best-effort; do not block upload on lookup failure */ }

    const r2Key = r2.assetKey(userId, key);
    let existingBefore;
    try { existingBefore = await r2.stat(r2Key).catch(() => null); } catch { existingBefore = null; }

    try {
      await r2.put(r2Key, body, 'application/octet-stream');
    } catch (err) {
      if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
        return reply.status(503).send({ error: 'storage_unavailable', message: 'Asset storage is not available.' });
      }
      throw err;
    }

    const delta = body.length - (existingBefore?.sizeBytes ?? 0);
    if (delta !== 0) {
      await Subscription.updateOne({ accountId: userId }, { $inc: { storageUsedBytes: delta } });
    }

    return reply.status(201).send({ assetKey: key, sizeBytes: body.length });
  });
}

module.exports = { registerAssetProxyRoutes };
