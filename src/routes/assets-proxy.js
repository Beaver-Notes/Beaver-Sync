'use strict';

const r2 = require('../services/r2');
const { verifyAssetSignature } = require('../lib/asset-sign');
const { resolveQuotaAndUsed } = require('../db/asset-reservations');
const {
  MAX_ASSET_SIZE_BYTES,
  isValidAssetKey,
  decodeAssetKey,
  ledgerWorkspaceForAsset,
  creditAssetStorage,
  debitAssetStorage,
} = require('./assets-shared');

// These bypass session auth — the HMAC token IS the authorization.
// Used when STORAGE_BACKEND=seaweedfs (internal Docker hostnames are unresolvable
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
    if (!verifyAssetSignature(key, userId, expiresNum, sig, 'download')) {
      return reply.status(403).send({ error: 'invalid_signature', message: 'Invalid or expired download token.' });
    }

    if (!isValidAssetKey(key)) {
      return reply.status(400).send({ error: 'invalid_key', message: 'Invalid asset key.' });
    }

    // The HMAC token (issued only after membership checks) IS the gate; here we
    // just translate the flat key to where the shared object lives. New-scheme
    // keys name their workspace inline — workspace-shared assets serve from the
    // shared prefix, account copies fall back to the account key.
    const decodedDownload = decodeAssetKey(key);
    const r2Key =
      decodedDownload?.hashed && decodedDownload.workspaceId
        ? r2.sharedAssetKey(decodedDownload.workspaceId, key)
        : r2.assetKey(userId, key);

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
    if (!verifyAssetSignature(key, userId, expiresNum, sig, 'upload')) {
      return reply.status(403).send({ error: 'invalid_signature', message: 'Invalid or expired upload token.' });
    }

    if (!isValidAssetKey(key)) {
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

    // Shared-namespace keys (new scheme) stat and write through the workspace
    // prefix: a member re-upload is a delta-0 overwrite, not a second metered
    // copy. Quota + credit debit the same workspace the object lives in.
    const decodedUpload = decodeAssetKey(key);
    const sharedWorkspace =
      decodedUpload?.hashed && decodedUpload.workspaceId ? decodedUpload.workspaceId : null;
    const r2Key = sharedWorkspace
      ? r2.sharedAssetKey(sharedWorkspace, key)
      : r2.assetKey(userId, key);
    const meterWorkspace = sharedWorkspace ?? null;

    // Enforce quota even on the signed-proxy path (otherwise presign + proxy bypasses accounting).
    // Resolve the SAME ledger the credit below uses (workspace when the asset
    // has a reservation, else the account) and fail closed if it cannot be
    // resolved — a falsy quota must never skip the gate.
    const statBefore = await r2.stat(r2Key).catch(() => null);
    const existingSize = statBefore?.sizeBytes ?? 0;
    const incomingDelta = body.length - existingSize;
    if (incomingDelta > 0) {
      const ledgerWorkspaceId = meterWorkspace ?? await ledgerWorkspaceForAsset(userId, key);
      let quota;
      let used;
      try {
        ({ quota, used } = await resolveQuotaAndUsed(userId, ledgerWorkspaceId));
      } catch (err) {
        req.log?.error?.({ err: err?.message }, '[assets-proxy] quota resolution failed');
        return reply.status(507).send({
          error: 'storage_quota_exceeded',
          message: 'Storage quota could not be verified.',
        });
      }
      if (!Number.isFinite(quota) || quota <= 0 || used + incomingDelta > quota) {
        return reply.status(507).send({
          error: 'storage_quota_exceeded',
          message: 'Asset would exceed your storage quota.',
          storageUsedBytes: used,
          storageQuotaBytes: Number.isFinite(quota) ? quota : null,
        });
      }
    }

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
    if (delta > 0) {
      await creditAssetStorage(userId, meterWorkspace ?? await ledgerWorkspaceForAsset(userId, key), delta);
    } else if (delta < 0) {
      await debitAssetStorage(userId, meterWorkspace ?? await ledgerWorkspaceForAsset(userId, key), -delta);
    }

    return reply.status(201).send({ assetKey: key, sizeBytes: body.length });
  });
}

module.exports = { registerAssetProxyRoutes };
