'use strict';

const r2 = require('../services/r2');
const { storageConfig } = require('../services/r2');
const { Subscription, Workspace } = require('../models');
const { mapWithConcurrency } = require('../lib/concurrency');
const { ASSET_KEY_PATTERN, ASSET_UPLOAD_CONCURRENCY } = require('./assets-shared');

async function registerAssetPresignRoutes(app, protect) {
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
      // R2/S3: generate native presigned PUT URLs concurrently
      const presignPromises = keys.map((assetKey) => {
        if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) return Promise.resolve(null);
        const key = r2.assetKey(req.userId, assetKey);
        return r2.presignPut(key, 'application/octet-stream', PRESIGN_TTL)
          .then((url) => ({ assetKey, url }))
          .catch((err) => {
            console.warn('[assets] presign failed:', assetKey, err.message);
            return null;
          });
      });
      const presigned = await Promise.all(presignPromises);
      for (const entry of presigned) {
        if (entry) urls.push(entry);
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

    const entries = await mapWithConcurrency(keys, ASSET_UPLOAD_CONCURRENCY, async (assetKey) => {
      if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) return null;
      const key = r2.assetKey(req.userId, assetKey);
      try {
        const stat = await r2.stat(key);
        if (!stat) return null;
        if (useProxy) {
          // MinIO: generate server-proxied HMAC-signed URLs
          const { signAssetDownload } = require('../lib/asset-sign');
          const { url } = signAssetDownload(assetKey, req.userId, PRESIGN_TTL);
          return { assetKey, url, sizeBytes: stat.sizeBytes };
        }
        // R2/S3: generate native presigned URLs (externally resolvable)
        const url = await r2.presignGet(key, PRESIGN_TTL);
        return { assetKey, url, sizeBytes: stat.sizeBytes };
      } catch (err) {
        console.warn('[assets] presign-get failed:', assetKey, err.message);
        return null;
      }
    });

    return reply.send({ urls: entries.filter(Boolean), expiresInSeconds: PRESIGN_TTL });
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
    if (keys.length > 200) {
      return reply.status(400).send({ error: 'too_many_keys', message: 'Max 200 keys per request.' });
    }

    const stats = await mapWithConcurrency(keys, ASSET_UPLOAD_CONCURRENCY, async (assetKey) => {
      if (!assetKey || !ASSET_KEY_PATTERN.test(assetKey)) return null;
      const key = r2.assetKey(req.userId, assetKey);
      try {
        return await r2.stat(key);
      } catch (err) {
        console.warn('[assets] confirm-seed stat failed:', assetKey, err.message);
        return null;
      }
    });

    let verified = 0;
    let totalSizeBytes = 0;
    for (const stat of stats) {
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

module.exports = { registerAssetPresignRoutes };
