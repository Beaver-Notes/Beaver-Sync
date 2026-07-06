'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../src/services/r2.js');

function loadStorageModule(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[servicePath];
  const loaded = require(servicePath);

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  delete require.cache[servicePath];
  return loaded;
}

test('non-production storage defaults to MinIO when no provider is specified', () => {
  const moduleUnderTest = loadStorageModule({
    NODE_ENV: 'development',
    STORAGE_BACKEND: null,
    STORAGE_ENDPOINT: null,
    STORAGE_BUCKET_NAME: null,
    STORAGE_ACCESS_KEY_ID: null,
    STORAGE_SECRET_ACCESS_KEY: null,
    STORAGE_FORCE_PATH_STYLE: null,
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_BUCKET_NAME: 'beaver-sync',
    MINIO_ROOT_USER: 'minioadmin',
    MINIO_ROOT_PASSWORD: 'minioadmin',
    R2_ENDPOINT: null,
    R2_BUCKET_NAME: null,
    R2_ACCESS_KEY_ID: null,
    R2_SECRET_ACCESS_KEY: null,
  });

  assert.equal(moduleUnderTest.storageConfig.provider, 'minio');
  assert.equal(moduleUnderTest.storageConfig.endpoint, 'http://minio:9000');
  assert.equal(moduleUnderTest.storageConfig.bucket, 'beaver-sync');
  assert.equal(moduleUnderTest.storageConfig.forcePathStyle, true);
});

test('production storage can still use Cloudflare R2 settings', () => {
  const moduleUnderTest = loadStorageModule({
    NODE_ENV: 'production',
    STORAGE_BACKEND: null,
    STORAGE_ENDPOINT: null,
    STORAGE_BUCKET_NAME: null,
    STORAGE_ACCESS_KEY_ID: null,
    STORAGE_SECRET_ACCESS_KEY: null,
    STORAGE_FORCE_PATH_STYLE: null,
    R2_ENDPOINT: 'https://example-account.r2.cloudflarestorage.com',
    R2_BUCKET_NAME: 'prod-bucket',
    R2_ACCESS_KEY_ID: 'r2-key',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
  });

  assert.equal(moduleUnderTest.storageConfig.provider, 'cloudflare-r2');
  assert.equal(moduleUnderTest.storageConfig.endpoint, 'https://example-account.r2.cloudflarestorage.com');
  assert.equal(moduleUnderTest.storageConfig.bucket, 'prod-bucket');
  assert.equal(moduleUnderTest.storageConfig.forcePathStyle, false);
});
