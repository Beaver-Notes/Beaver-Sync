'use strict';

// A signed asset URL must be usable for exactly one verb. The signature used to
// cover only "{assetKey}:{userId}:{expires}", and both the download and the upload
// proxy verified with the same function, so a read-only share token (300s TTL) was
// a byte-valid upload token and could overwrite the asset it was only meant to read.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';

const {
  signAssetDownload,
  signAssetUpload,
  verifyAssetSignature,
} = require('../src/lib/asset-sign');

const KEY = 'assets--note1--file.png';
const USER = 'acct-1';

test('a download signature does not authorise an upload', () => {
  const { expires, sig } = signAssetDownload(KEY, USER, 300);
  assert.equal(verifyAssetSignature(KEY, USER, expires, sig, 'download'), true, 'the owner must still be able to read');
  assert.equal(
    verifyAssetSignature(KEY, USER, expires, sig, 'upload'), false,
    'a read-only share token must not be able to overwrite the asset');
});

test('an upload signature does not authorise a download', () => {
  const { expires, sig } = signAssetUpload(KEY, USER, 300);
  assert.equal(verifyAssetSignature(KEY, USER, expires, sig, 'upload'), true);
  assert.equal(verifyAssetSignature(KEY, USER, expires, sig, 'download'), false);
});

test('the signature is bound to the asset key, the user and the expiry', () => {
  const { expires, sig } = signAssetDownload(KEY, USER, 300);
  assert.equal(verifyAssetSignature('assets--note2--file.png', USER, expires, sig, 'download'), false);
  assert.equal(verifyAssetSignature(KEY, 'acct-2', expires, sig, 'download'), false);
  assert.equal(verifyAssetSignature(KEY, USER, expires + 1, sig, 'download'), false);
});

test('an expired or malformed signature is refused', () => {
  const { expires: future, sig: live } = signAssetDownload(KEY, USER, 300);
  assert.equal(verifyAssetSignature(KEY, USER, future, live, 'download'), true);

  const { expires: past, sig: stale } = signAssetDownload(KEY, USER, -10);
  assert.ok(past < Math.floor(Date.now() / 1000), 'the token must actually be expired');
  assert.equal(verifyAssetSignature(KEY, USER, past, stale, 'download'), false, 'expired token must fail');

  assert.equal(verifyAssetSignature(KEY, USER, future, 'deadbeef', 'download'), false, 'malformed signature must fail');
  assert.equal(verifyAssetSignature(null, USER, future, live, 'download'), false);
});
