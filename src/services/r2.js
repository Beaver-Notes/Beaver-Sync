"use strict";

/**
 * services/r2.js
 *
 * S3-compatible object storage client. In production it defaults
 * to Cloudflare R2; in local or self-hosted non-production environments
 * it defaults to MinIO.
 *
 * Supported storage backends:
 *   - cloudflare-r2
 *   - minio
 *   - custom (any S3-compatible endpoint)
 *
 * Object key structure:
 *   <userId>/commits/<commitId>.json   - encrypted commit blobs
 *   <userId>/assets/<assetKey>         - encrypted images/files
 *   <userId>/snapshot.json             - latest compaction snapshot
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function firstDefined(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== "",
  );
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function resolveStorageConfig() {
  const provider = String(
    process.env.STORAGE_BACKEND ??
      (process.env.NODE_ENV === "production" ? "cloudflare-r2" : "minio"),
  ).toLowerCase();

  const usingMinio = provider === "minio";
  const endpoint = firstDefined(
    process.env.STORAGE_ENDPOINT,
    process.env.S3_ENDPOINT,
    process.env.R2_ENDPOINT,
    usingMinio ? process.env.MINIO_ENDPOINT : undefined,
    usingMinio ? "http://minio:9000" : undefined,
  );
  const region = firstDefined(
    process.env.STORAGE_REGION,
    process.env.S3_REGION,
    process.env.R2_REGION,
    usingMinio ? "us-east-1" : "auto",
  );
  const bucket = firstDefined(
    process.env.STORAGE_BUCKET_NAME,
    process.env.S3_BUCKET_NAME,
    process.env.R2_BUCKET_NAME,
    usingMinio ? process.env.MINIO_BUCKET_NAME : undefined,
    usingMinio ? "beaver-sync" : undefined,
  );
  const accessKeyId = firstDefined(
    process.env.STORAGE_ACCESS_KEY_ID,
    process.env.S3_ACCESS_KEY_ID,
    process.env.R2_ACCESS_KEY_ID,
    usingMinio ? process.env.MINIO_ROOT_USER : undefined,
    usingMinio ? "minioadmin" : undefined,
  );
  const secretAccessKey = firstDefined(
    process.env.STORAGE_SECRET_ACCESS_KEY,
    process.env.S3_SECRET_ACCESS_KEY,
    process.env.R2_SECRET_ACCESS_KEY,
    usingMinio ? process.env.MINIO_ROOT_PASSWORD : undefined,
    usingMinio ? "minioadmin" : undefined,
  );
  const forcePathStyle = parseBoolean(
    firstDefined(
      process.env.STORAGE_FORCE_PATH_STYLE,
      process.env.S3_FORCE_PATH_STYLE,
      usingMinio ? "true" : "false",
    ),
    usingMinio,
  );

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Storage client is missing endpoint, bucket, or credentials configuration.",
    );
  }

  return {
    provider,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  };
}

const storageConfig = resolveStorageConfig();

// Build the client once - it's safe to share across requests
const r2 = new S3Client({
  region: storageConfig.region,
  endpoint: storageConfig.endpoint,
  forcePathStyle: storageConfig.forcePathStyle,
  credentials: {
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
  },
});

const BUCKET = storageConfig.bucket;

/**
 * Ensure the storage bucket exists, creating it if necessary.
 * Called once at startup to prevent 502 errors from missing buckets.
 */
async function ensureBucket() {
  try {
    await r2.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      try {
        await r2.send(new CreateBucketCommand({ Bucket: BUCKET }));
        console.log(`[r2] Created bucket: ${BUCKET}`);
      } catch (createErr) {
        if (createErr.name === 'BucketAlreadyOwnedByYou' || createErr.$metadata?.httpStatusCode === 409) {
          console.log(`[r2] Bucket already exists: ${BUCKET}`);
        } else {
          console.error(`[r2] Failed to create bucket ${BUCKET}:`, createErr.message);
        }
      }
    } else {
      console.error(`[r2] Failed to check bucket ${BUCKET}:`, err.message);
    }
  }
}

// Low-level helpers
/**
 * Upload data to object storage.
 * @param {string} key - Object key (path in the bucket)
 * @param {Buffer|string} body - Data to store
 * @param {string} [contentType] - MIME type
 */
async function put(
  key,
  body,
  contentType = "application/octet-stream",
  options = {},
) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    // Prevent any caching of encrypted blobs by intermediaries
    CacheControl: "no-store",
  });
  if (options.ifNoneMatch) {
    command.input.IfNoneMatch = "*";
  }
  await r2.send(command);
}

/**
 * Download data from object storage as a Buffer.
 * Returns null if the object doesn't exist (404).
 */
async function get(key) {
  try {
    const res = await r2.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );

    // The SDK returns a readable stream - collect it into a Buffer
    const chunks = [];
    for await (const chunk of res.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Download data from object storage as a readable stream.
 * Returns null if the object doesn't exist (404).
 */
async function getStream(key) {
  try {
    const res = await r2.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
    return res.Body;
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Delete an object from storage.
 */
async function del(key) {
  await r2.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );
}

async function delMany(keys) {
  if (!keys || keys.length === 0) return { deleted: 0 };
  let totalDeleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000).map((k) => ({ Key: k }));
    try {
      const res = await r2.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: chunk, Quiet: false },
        }),
      );
      totalDeleted += res.Deleted?.length ?? 0;
    } catch {
      for (const e of chunk) {
        try {
          await r2.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: e.Key }),
          );
          totalDeleted++;
        } catch {}
      }
    }
  }
  return { deleted: totalDeleted };
}

/**
 * List all object keys under a given prefix.
 * Returns an array of key strings (empty if none found).
 */
async function listKeys(prefix) {
  const keys = [];
  let continuationToken;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const res = await r2.send(cmd);
    if (res.Contents) {
      for (const obj of res.Contents) {
        if (obj.Key) keys.push(obj.Key);
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

/**
 * Check if an object exists and get its size in bytes.
 * Returns null if not found.
 */
async function stat(key) {
  try {
    const res = await r2.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
    return { sizeBytes: res.ContentLength ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Generate a short-lived pre-signed URL for direct client download.
 */
async function presignGet(key, expiresInSeconds = 300) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2, cmd, { expiresIn: expiresInSeconds });
}

/**
 * Generate a pre-signed URL for direct client upload.
 */
async function presignPut(key, contentType, expiresInSeconds = 300) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, cmd, { expiresIn: expiresInSeconds });
}

// High-level helpers (keyed by userId)
const commitKey = (userId, commitId) => `${userId}/commits/${commitId}.json`;
const assetKey = (userId, assetKey) => `${userId}/assets/${assetKey}`;
const snapshotKey = (userId) => `${userId}/snapshot.json`;
const exportKey = (userId, id) => `${userId}/export-${id}.zip`;
const yjsKey = (userId, fileName) => `${userId}/yjs/${fileName}`;

module.exports = {
  put,
  get,
  getStream,
  del,
  delMany,
  listKeys,
  stat,
  presignGet,
  presignPut,
  commitKey,
  assetKey,
  snapshotKey,
  exportKey,
  yjsKey,
  storageConfig,
  ensureBucket,
};
