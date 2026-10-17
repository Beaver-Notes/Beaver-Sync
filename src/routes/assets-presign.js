'use strict';

const r2 = require('../services/r2');
const { storageConfig } = require('../services/r2');
const { Subscription, Workspace } = require('../models');
const { mapWithConcurrency } = require('../lib/concurrency');
const { isValidAssetKey, ASSET_UPLOAD_CONCURRENCY, MAX_ASSET_SIZE_BYTES, assetStoreKey, resolveAssetLocation } = require('./assets-shared');
const { reserveForPresign, confirmReservations } = require('../db/asset-reservations');
const { requireWorkspaceWriter } = require('../middleware/org');

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
    const { keys, sizes, workspaceId: bodyWorkspaceId } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain a keys array.' });
    }
    if (keys.length > 200) {
      return reply.status(400).send({ error: 'too_many_keys', message: 'Max 200 keys per presign request.' });
    }

    const workspaceId = bodyWorkspaceId || req.headers['x-workspace-id'] || null;

    // The workspace id is client-supplied: only a member who can write to that
    // workspace may reserve against its ledger. Otherwise an authenticated caller
    // could reserve (and later confirm) against another tenant's quota (S3).
    if (workspaceId) {
      const membership = await requireWorkspaceWriter(req, reply, workspaceId);
      if (!membership) return;
    }

    // Build size map capped at MAX_ASSET_SIZE_BYTES. Missing sizes default to 0 (legacy clients).
    // Clients should send sizes array parallel to keys or object mapping key->size for accurate quota preflight.
    const validKeys = keys.filter((k) => k && isValidAssetKey(k));
    const sizeMap = new Map();
    if (Array.isArray(sizes) && sizes.length === keys.length) {
      keys.forEach((k, i) => {
        const raw = Number(sizes[i]);
        const capped = Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_ASSET_SIZE_BYTES)) : 0;
        if (k && isValidAssetKey(k)) sizeMap.set(k, capped);
      });
    } else if (sizes && typeof sizes === 'object' && !Array.isArray(sizes)) {
      for (const k of validKeys) {
        const raw = Number(sizes[k]);
        const capped = Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_ASSET_SIZE_BYTES)) : 0;
        sizeMap.set(k, capped);
      }
    } else {
      for (const k of validKeys) sizeMap.set(k, 0);
    }

    // Quota preflight with advisory-lock to prevent concurrent overcommit (N parallel presigns).
    if (validKeys.length > 0) {
      const items = validKeys.map((k) => ({ assetKey: k, sizeBytes: sizeMap.get(k) ?? 0 }));
      const requestedTotal = items.reduce((s, it) => s + it.sizeBytes, 0);
      if (requestedTotal > 0) {
        try {
          const res = await reserveForPresign({ accountId: req.userId, workspaceId, items });
          if (!res.ok) {
            const usedMB = (res.used / 1_048_576).toFixed(1);
            const quotaMB = (res.quota / 1_048_576).toFixed(0);
            return reply.status(507).send({
              error: 'storage_quota_exceeded',
              message: `Storage full: ${usedMB} MB used of ${quotaMB} MB (including ${res.pending} bytes pending).`,
              storageUsedBytes: res.used,
              storageQuotaBytes: res.quota,
              pendingBytes: res.pending,
              requestedBytes: res.requested,
              upgradeUrl: 'https://beaver.app/sync',
            });
          }
        } catch (err) {
          // Reservation failure should not silently bypass quota — fail closed on DB errors, allow on transient lock contention?
          console.warn('[assets] presign reservation failed:', err.message);
          return reply.status(503).send({ error: 'storage_unavailable', message: 'Quota check temporarily unavailable.' });
        }
      } else {
        // Even for 0-size reservations, create pending rows for TTL tracking (size 0)
        try {
          const items = validKeys.map((k) => ({ assetKey: k, sizeBytes: 0 }));
          await reserveForPresign({ accountId: req.userId, workspaceId, items });
        } catch {}
      }
    }

    const useProxy = storageConfig.provider === 'seaweedfs';
    const PRESIGN_TTL = 3600;
    const urls = [];

    if (useProxy) {
      // SeaweedFS: generate server-proxied HMAC-signed upload URLs
      const { signAssetUpload } = require('../lib/asset-sign');
      for (const assetKey of keys) {
        if (!assetKey || !isValidAssetKey(assetKey)) continue;
        const { url } = signAssetUpload(assetKey, req.userId, PRESIGN_TTL);
        urls.push({ assetKey, url });
      }
    } else {
      // R2/S3: generate native presigned PUT URLs concurrently.
      // Workspace-verified batches presign the shared object location, not a
      // per-account copy — the same flat key must resolve for every member.
      const presignPromises = keys.map((assetKey) => {
        if (!assetKey || !isValidAssetKey(assetKey)) return Promise.resolve(null);
        const key = assetStoreKey(req.userId, assetKey, workspaceId);
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

    const useProxy = storageConfig.provider === 'seaweedfs';
    const PRESIGN_TTL = 3600;

    const entries = await mapWithConcurrency(keys, ASSET_UPLOAD_CONCURRENCY, async (assetKey) => {
      if (!assetKey || !isValidAssetKey(assetKey)) return null;
      try {
        const located = await resolveAssetLocation(req.userId, assetKey);
        if (!located) return null;
        const stat = { sizeBytes: located.sizeBytes };
        const key = located.key;
        if (useProxy) {
          // SeaweedFS: generate server-proxied HMAC-signed URLs
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
    const { keys, workspaceId: bodyWorkspaceId } = req.body || {};
    if (!Array.isArray(keys)) {
      return reply.status(400).send({ error: 'invalid_body', message: 'Body must contain a keys array.' });
    }
    if (keys.length > 200) {
      return reply.status(400).send({ error: 'too_many_keys', message: 'Max 200 keys per request.' });
    }

    const workspaceId = bodyWorkspaceId || req.headers['x-workspace-id'] || req.workspaceId || null;

    // Same client-supplied id as presign-batch: only a workspace writer may
    // finalize accounting against that workspace's storage ledger (S3).
    if (workspaceId) {
      const membership = await requireWorkspaceWriter(req, reply, workspaceId);
      if (!membership) return;
    }

    const stats = await mapWithConcurrency(keys, ASSET_UPLOAD_CONCURRENCY, async (assetKey) => {
      if (!assetKey || !isValidAssetKey(assetKey)) return null;
      try {
        const located = await resolveAssetLocation(req.userId, assetKey);
        if (!located) return null;
        if (located.sizeBytes > MAX_ASSET_SIZE_BYTES) return { assetKey, sizeBytes: located.sizeBytes, tooLarge: true };
        return { assetKey, sizeBytes: located.sizeBytes };
      } catch (err) {
        console.warn('[assets] confirm-seed stat failed:', assetKey, err.message);
        return null;
      }
    });

    // Build map of verified keys -> actual size from R2 (ground truth, not declared)
    const sizeByKey = new Map();
    let verified = 0;
    for (const entry of stats) {
      if (entry) {
        verified++;
        sizeByKey.set(entry.assetKey, entry.sizeBytes);
      }
    }

    // Reservation finalization: pending->confirmed, idempotent. Also handles legacy (no prior reservation).
    let totalSizeBytes = 0;
    let confirmed = 0;
    if (verified > 0) {
      try {
        const verifiedKeys = Array.from(sizeByKey.keys());
        const result = await confirmReservations({ accountId: req.userId, workspaceId, keys: verifiedKeys, sizeByKey });
        confirmed = result.confirmed;
        totalSizeBytes = result.totalSizeBytes;
      } catch (err) {
        console.warn('[assets] confirm reservation failed:', err.message);
        // Fallback: sum sizes directly (fail open for accounting)
        for (const v of sizeByKey.values()) totalSizeBytes += v;
      }
    }

    if (totalSizeBytes > 0) {
      const { query } = require('../db/postgres');
      const { resolveQuotaAndUsed } = require('../db/asset-reservations');
      const { quota } = await resolveQuotaAndUsed(req.userId, workspaceId, null);
      if (quota !== Number.MAX_SAFE_INTEGER) {
        let res;
        if (workspaceId) {
          res = await query('UPDATE workspaces SET storage_used_bytes = storage_used_bytes + $1 WHERE id=$2 AND storage_used_bytes + $1 <= $3', [totalSizeBytes, workspaceId, quota]);
        } else {
          res = await query('UPDATE subscriptions SET storage_used_bytes = storage_used_bytes + $1 WHERE account_id=$2 AND storage_used_bytes + $1 <= $3', [totalSizeBytes, req.userId, quota]);
        }
        if (!res || res.rowCount !== 1) {
          return reply.status(507).send({ error: 'storage_quota_exceeded', message: 'Storage quota exceeded at confirm time.' });
        }
      } else if (workspaceId) {
        await Workspace.updateOne({ _id: workspaceId }, { $inc: { storageUsedBytes: totalSizeBytes } });
      } else {
        await Subscription.updateOne({ accountId: req.userId }, { $inc: { storageUsedBytes: totalSizeBytes } });
      }
    }
    return reply.send({ verified, total: keys.length, sizeBytes: totalSizeBytes, confirmed });
  });
}

module.exports = { registerAssetPresignRoutes };
