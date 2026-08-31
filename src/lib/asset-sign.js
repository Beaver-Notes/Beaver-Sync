'use strict';

const crypto = require('crypto');
const { URL } = require('url');

const SIGNING_KEY = process.env.SESSION_HMAC_KEY;

function getSigningKey() {
  if (!SIGNING_KEY || SIGNING_KEY.length < 32) {
    throw new Error('SESSION_HMAC_KEY is required and must be at least 32 characters for asset URL signing.');
  }
  return SIGNING_KEY;
}

/**
 * HMAC-SHA256 signature for asset URLs.
 * Payload: "{assetKey}:{userId}:{expires}"
 */
function signPayload(assetKey, userId, expires) {
  const key = getSigningKey();
  const payload = `${assetKey}:${userId}:${expires}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Generate a server-proxied signed download URL for an asset.
 * @param {string} assetKey - flat asset key (e.g. "assets--noteId--file.png")
 * @param {string} userId - account/user ID
 * @param {number} ttlSec - time-to-live in seconds (default 300)
 * @param {string} [baseUrl] - API server base URL (defaults to APP_URL env)
 * @returns {{ url: string, expires: number, sig: string }}
 */
function signAssetDownload(assetKey, userId, ttlSec = 300, baseUrl) {
  const base = baseUrl || process.env.APP_URL || 'http://localhost:4000';
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = signPayload(assetKey, userId, expires);

  const url = new URL(`${base}/assets/download`);
  url.searchParams.set('key', assetKey);
  url.searchParams.set('userId', userId);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('sig', sig);

  return { url: url.toString(), expires, sig };
}

/**
 * Generate a server-proxied signed upload URL for an asset.
 * @param {string} assetKey - flat asset key
 * @param {string} userId - account/user ID
 * @param {number} ttlSec - time-to-live in seconds (default 3600)
 * @param {string} [baseUrl] - API server base URL
 * @returns {{ url: string, expires: number, sig: string }}
 */
function signAssetUpload(assetKey, userId, ttlSec = 3600, baseUrl) {
  const base = baseUrl || process.env.APP_URL || 'http://localhost:4000';
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = signPayload(assetKey, userId, expires);

  const url = new URL(`${base}/assets/upload`);
  url.searchParams.set('key', assetKey);
  url.searchParams.set('userId', userId);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('sig', sig);

  return { url: url.toString(), expires, sig };
}

/**
 * Verify an asset URL signature.
 * @param {string} assetKey
 * @param {string} userId
 * @param {number} expires - unix timestamp (seconds)
 * @param {string} sig - hex signature to verify
 * @returns {boolean}
 */
function verifyAssetSignature(assetKey, userId, expires, sig) {
  if (!assetKey || !userId || !expires || !sig) return false;
  if (typeof expires !== 'number' || typeof sig !== 'string') return false;
  if (sig.length !== 64) return false; // SHA-256 hex = 64 chars

  const now = Math.floor(Date.now() / 1000);
  if (now > expires) return false;

  const expected = signPayload(assetKey, userId, expires);

  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

module.exports = {
  signAssetDownload,
  signAssetUpload,
  verifyAssetSignature,
};
