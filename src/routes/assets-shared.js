'use strict';

const r2 = require('../services/r2');
const { Subscription, Workspace } = require('../models');

const MAX_ASSET_SIZE_BYTES = parseInt(
  process.env.ASSET_MAX_SIZE_BYTES ?? String(100 * 1024 * 1024),
  10
);
const ASSET_URL_TTL_SECONDS = Math.min(
  parseInt(process.env.ASSET_URL_TTL_SECONDS ?? '300', 10),
  900
);
const ASSET_KEY_PATTERN = /^[a-zA-Z0-9._ -]{1,256}$/;
const ASSET_UPLOAD_CONCURRENCY = 8;

// Shared per-asset upload pipeline used by /batch and /seed-batch.
// Runs the R2 puts with bounded concurrency and applies a single aggregated
// storage-usage increment at the end.
async function storeAssetBatch(req, assets) {
  const results = new Array(assets.length);
  let uploadedBytesAccount = 0;
  let uploadedBytesWorkspace = 0;

  const storeOne = async (index) => {
    const item = assets[index];
    const assetKey = item?.key;
    const dataB64 = item?.data;

    if (!assetKey || !dataB64 || !ASSET_KEY_PATTERN.test(assetKey)) {
      results[index] = { key: assetKey || '?', status: 'error', error: 'invalid_key' };
      return;
    }

    const body = Buffer.from(dataB64, 'base64');
    if (body.length === 0) {
      results[index] = { key: assetKey, status: 'error', error: 'empty_body' };
      return;
    }
    if (body.length > MAX_ASSET_SIZE_BYTES) {
      results[index] = { key: assetKey, status: 'skipped', error: 'too_large' };
      return;
    }

    const r2Key = r2.assetKey(req.userId, assetKey);
    try {
      await r2.put(r2Key, body, 'application/octet-stream', { ifNoneMatch: true });
    } catch (err) {
      if (err && (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412)) {
        results[index] = { key: assetKey, status: 'already_exists', sizeBytes: body.length };
        return;
      }
      results[index] = { key: assetKey, status: 'error', error: err.message };
      return;
    }

    if (req.workspaceId) {
      uploadedBytesWorkspace += body.length;
    } else {
      uploadedBytesAccount += body.length;
    }
    results[index] = { key: assetKey, status: 'uploaded', sizeBytes: body.length };
  };

  let cursor = 0;
  const workers = [];
  for (let w = 0; w < ASSET_UPLOAD_CONCURRENCY; w++) {
    workers.push((async () => {
      while (cursor < assets.length) {
        const index = cursor++;
        await storeOne(index);
      }
    })());
  }
  await Promise.all(workers);

  if (uploadedBytesAccount > 0) {
    await Subscription.updateOne(
      { accountId: req.userId },
      { $inc: { storageUsedBytes: uploadedBytesAccount } }
    );
  }
  if (uploadedBytesWorkspace > 0) {
    await Workspace.updateOne(
      { _id: req.workspaceId },
      { $inc: { storageUsedBytes: uploadedBytesWorkspace } }
    );
  }

  return results;
}

module.exports = {
  MAX_ASSET_SIZE_BYTES,
  ASSET_URL_TTL_SECONDS,
  ASSET_KEY_PATTERN,
  ASSET_UPLOAD_CONCURRENCY,
  storeAssetBatch,
};
