'use strict';

const crypto = require('crypto');
const r2 = require('../services/r2');
const { query } = require('../db');
const { Subscription, Workspace, WorkspaceMember } = require('../models');

const MAX_ASSET_SIZE_BYTES = parseInt(
  process.env.ASSET_MAX_SIZE_BYTES ?? String(100 * 1024 * 1024),
  10
);
const ASSET_URL_TTL_SECONDS = Math.min(
  parseInt(process.env.ASSET_URL_TTL_SECONDS ?? '300', 10),
  900
);
// Asset keys arrive percent-encoded: the client serializes
// `encode_uri_component(ty)--encode_uri_component(note)--encode_uri_component(file)`
// and the URL path is decoded once on the way in. So a key may legally contain
// `%XX` escapes plus the client's unreserved set (`-_.!~*'()`); a raw/legacy
// key may contain arbitrary unicode (spaces, parens, `+`, `'`). Aligning with
// the Rust `safe_segment` (minus our per-key traversal guard) is what lets
// `Résumé (final)+v2.pdf` upload at all.
const ASSET_KEY_MAX_LENGTH = 4096;

function hasControlChars(value) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isValidAssetKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > ASSET_KEY_MAX_LENGTH) return false;

  let decoded;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // A bare `%` that is not a valid escape can only come from a raw key the
    // client would have encoded; refuse rather than guess.
    return false;
  }

  for (const value of decoded === key ? [key] : [key, decoded]) {
    if (hasControlChars(value)) return false;
    if (value.includes('/') || value.includes('\\')) return false;
    // `.`, `..`, and dotfiles: the Rust `safe_segment` rejects these too.
    // Embedded `..` (e.g. `report..final.pdf`) stays legal — it is not a path.
    if (value.startsWith('.')) return false;
  }
  return true;
}
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

    if (!assetKey || !dataB64 || !isValidAssetKey(assetKey)) {
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

    const r2Key = assetStoreKey(req.userId, assetKey, req.workspaceId);
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
    // Record which ledger credited each asset, so a later delete debits the
    // same one. Without this the delete falls back to the account ledger (the
    // /assets/batch path creates no presign reservation).
    const now = new Date().toISOString();
    for (const r of results) {
      if (!r || r.status !== 'uploaded') continue;
      await query(
        `INSERT INTO asset_reservations (id, account_id, workspace_id, asset_key, size_bytes, status, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7)`,
        [crypto.randomUUID(), req.userId, req.workspaceId, r.key, r.sizeBytes, now, now]
      );
    }
  }

  return results;
}

// Flat-key helper shared by the asset GC job. New uploads use the
// deterministic filename-hash scheme
// (`assets--<uri(ws)>--<uri(note)>--<base64url(hash))`, see Rust
// `encode_asset_key`). That form reveals workspace+note (the orphan-GC key
// input) while the filename stays one-way; it is decoded here with
// `filename: null, hashed: true` so the GC can reclaim it. Legacy item-3 keys
// are opaque (`assets--<encrypted token>`): nothing is derivable, so they stay
// undecodable and are never GC candidates. Legacy 3/4-segment keys with a
// readable filename are also decoded.
// Mirror of Rust `decode_asset_key`: 4 segments is the new scheme (hash) or
// legacy workspace-scoped (filename), 3 is legacy (workspaceId null). Returns
// null for anything malformed, another type, or an opaque token.
// `assets--`. Mirrors Rust `ASSET_KEY_WIRE_PREFIX`.
const ASSET_KEY_WIRE_PREFIX = 'assets--';

const FILENAME_HASH_LENGTH = 43;

// Minimum opaque-token size: a 24-byte nonce plus a 16-byte Poly1305 tag.
// Mirrors the length check in Rust `decode_opaque_asset_key`, but needs no key
// material, so the server can apply it. Without this a real opaque token that
// happens to contain '--' (about 2% of them, since base64url includes '-')
// splits into 3 segments and is then read as a legacy `ty--note--file` key,
// which made the GC delete assets it had no way of proving were orphans.
const OPAQUE_TOKEN_MIN_BLOB_BYTES = 24 + 16;

function isOpaqueToken(key) {
  if (!key.startsWith(ASSET_KEY_WIRE_PREFIX)) return false;
  const token = key.slice(ASSET_KEY_WIRE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;
  const blob = Buffer.from(token, 'base64url');
  // Canonical round-trip rejects keys that are only incidentally base64url,
  // the same guard `isFilenameHash` uses.
  if (blob.toString('base64url') !== token) return false;
  return blob.length >= OPAQUE_TOKEN_MIN_BLOB_BYTES;
}

// `base64url-no-pad(32 bytes)` is exactly 43 chars. Mirrors Rust
// `is_filename_hash`; the GC uses it to flag new-scheme keys.
function isFilenameHash(segment) {
  if (typeof segment !== 'string' || segment.length !== FILENAME_HASH_LENGTH) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === segment;
}

function decodeAssetKey(key) {
  if (typeof key !== 'string' || key.includes('/') || key.includes('\\') || key.includes('\0')) {
    return null;
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const parts = key.split('--');
  if (parts.length === 3) {
    // An opaque token that contains '--' also lands here, so reject it before
    // reading a note id out of ciphertext. The 4-segment branch needs no such
    // check: a new-scheme key is pinned by its 43-char hash.
    if (isOpaqueToken(key)) return null;
    const [type, noteId, filename] = parts.map(decode);
    if (type === null || noteId === null || filename === null) return null;
    return { type, workspaceId: null, noteId, filename };
  }
  if (parts.length === 4) {
    // New scheme: `assets--<ws>--<note>--<hash>` has a real workspace/note but
    // a one-way filename. Decode the location, keep the hash opaque to callers.
    if (parts[0] === 'assets' && isFilenameHash(parts[3])) {
      const workspaceId = decode(parts[1]);
      const noteId = decode(parts[2]);
      if (workspaceId === null || noteId === null) return null;
      return { type: 'assets', workspaceId, noteId, filename: null, hashed: true };
    }
    const [type, workspaceId, noteId, filename] = parts.map(decode);
    if (type === null || workspaceId === null || noteId === null || filename === null) return null;
    return { type, workspaceId, noteId, filename };
  }
  return null;
}

// Which ledger did this asset's upload credit? The presign/confirm flow stamps
// `workspace_id` on the reservation, so it is the authoritative record. Legacy
// direct uploads have no reservation and fall back to the account ledger.
async function ledgerWorkspaceForAsset(accountId, assetKey) {
  const { rows } = await query(
    `SELECT workspace_id FROM asset_reservations
      WHERE account_id = $1 AND asset_key = $2 AND workspace_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [accountId, assetKey]
  );
  return rows[0]?.workspace_id ?? null;
}

// Debit the same ledger that was credited. GREATEST(...,0) keeps the schema's
// CHECK(storage_used_bytes >= 0) from turning a stale double-delete into a 500.
async function debitAssetStorage(accountId, workspaceId, sizeBytes) {
  if (!sizeBytes) return;
  if (workspaceId) {
    await query('UPDATE workspaces SET storage_used_bytes = GREATEST(storage_used_bytes - $1, 0) WHERE id = $2', [sizeBytes, workspaceId]);
  } else {
    await query('UPDATE subscriptions SET storage_used_bytes = GREATEST(storage_used_bytes - $1, 0) WHERE account_id = $2', [sizeBytes, accountId]);
  }
}

async function creditAssetStorage(accountId, workspaceId, sizeBytes) {
  if (!sizeBytes) return;
  if (workspaceId) {
    await query('UPDATE workspaces SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2', [sizeBytes, workspaceId]);
  } else {
    await query('UPDATE subscriptions SET storage_used_bytes = storage_used_bytes + $1 WHERE account_id = $2', [sizeBytes, accountId]);
  }
}

// Where an upload lands. New-scheme flat keys embed the workspace id, so when
// that workspace matches the caller's (verified) workspace context the object
// goes into the shared prefix and every member converges on the identical
// location — one R2 object and one meter increment instead of one per member.
// Legacy/opaque keys stay account-scoped: their location must not change.
function assetStoreKey(userId, assetKey, workspaceId) {
  const decoded = decodeAssetKey(assetKey);
  if (
    workspaceId && decoded?.hashed &&
    decoded.workspaceId === workspaceId
  ) {
    return r2.sharedAssetKey(workspaceId, assetKey);
  }
  return r2.assetKey(userId, assetKey);
}

// Where an asset actually lives. The account prefix is checked first (legacy
// copies, or an upload from before the shared store); a miss on a new-scheme
// key falls back to the shared prefix, which any workspace member may read.
// Returns null when the object exists nowhere readable.
async function resolveAssetLocation(userId, assetKey) {
  const accountKey = r2.assetKey(userId, assetKey);
  try {
    const existing = await r2.stat(accountKey);
    if (existing) return { key: accountKey, shared: false, sizeBytes: existing.sizeBytes };
  } catch (err) {
    if (err.name === 'ECONNREFUSED' || err.name === 'NetworkingError' || err.$metadata?.httpStatusCode === 502) {
      const e = new Error('storage_unavailable');
      e.statusCode = 503;
      throw e;
    }
    throw err;
  }
  const decoded = decodeAssetKey(assetKey);
  if (!decoded?.workspaceId) return null;
  const member = await WorkspaceMember.findOne({ workspaceId: decoded.workspaceId, accountId: userId }).lean();
  if (!member) return null;
  const sharedKey = r2.sharedAssetKey(decoded.workspaceId, assetKey);
  const existing = await r2.stat(sharedKey);
  if (!existing) return null;
  return { key: sharedKey, shared: true, sizeBytes: existing.sizeBytes };
}

module.exports = {
  MAX_ASSET_SIZE_BYTES,
  ASSET_URL_TTL_SECONDS,
  ASSET_KEY_MAX_LENGTH,
  isValidAssetKey,
  ASSET_UPLOAD_CONCURRENCY,
  storeAssetBatch,
  ledgerWorkspaceForAsset,
  creditAssetStorage,
  debitAssetStorage,
  decodeAssetKey,
  isFilenameHash,
  assetStoreKey,
  resolveAssetLocation,
};
