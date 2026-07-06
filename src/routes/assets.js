'use strict';

const r2 = require('../services/r2');
const { Subscription, Workspace } = require('../models');

const MAX_ASSET_SIZE_BYTES = parseInt(
  process.env.MAX_ASSET_SIZE_BYTES ?? String(100 * 1024 * 1024),
  10
);
const ASSET_URL_TTL_SECONDS = Math.min(
  parseInt(process.env.ASSET_URL_TTL_SECONDS ?? '300', 10),
  900
);
const ASSET_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,256}$/;

async function assetRoutes(app) {
  await app.register(require('../middleware/auth'));
  await app.register(require('../middleware/subscription'));

  const protect = {
    preHandler: [app.authenticate],
  };

  const protectWrite = {
    preHandler: [app.authenticate, app.requireActiveSync, app.requirePaidWrite, app.checkStorageQuota],
  };

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

    const existing = await r2.stat(key);
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

    const stat = await r2.stat(key);
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

    const stat = await r2.stat(key);
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
}

module.exports = assetRoutes;
