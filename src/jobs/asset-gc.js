'use strict';

/**
 * Server-side orphan asset GC. The client never deletes assets by inference
 * any more (only explicit note-deletion tombstones, see sync/assets.rs); this
 * job is the safety net for assets left behind by a device that vanished
 * mid-delete, a legacy workspace-unknown key, or a note deleted on another
 * account's device.
 *
 * An asset is deleted only when BOTH hold:
 *   1. its workspace+note has no server-side existence in the server's own
 *      records (`yjs_doc_updates` / `sync_document_state`) — never a client's
 *      local view; and
 *   2. the object has not been modified for longer than the grace period
 *      (default 30 days), so a fresh upload for a note whose first push has
 *      not landed yet is never a candidate.
 *
 * New-scheme keys (`assets--<ws>--<note>--<hash>`, see Rust `encode_asset_key`)
 * reveal the workspace and note, so the object is again associable with its
 * note and is GC-eligible. Legacy 3-segment keys carry no workspace: they are
 * matched against note ids across every workspace and are also reclaimed.
 *
 * Legacy item-3 keys (`assets--<encrypted token>`) reveal nothing: the server
 * cannot prove their note, so any key `decodeAssetKey` rejects is skipped and
 * such an asset is never deleted -- including genuinely orphaned ones. That is
 * a deliberate storage-leak-over-data-loss trade.
 *
 * The scheduler is off unless ASSET_GC_INTERVAL_MS > 0. Even when running, it
 * is dry-run unless ASSET_GC_DRY_RUN=false, so enabling the schedule never
 * deletes until explicitly armed.
 */

const { query } = require('../db/postgres');
const r2 = require('../services/r2');
const { decodeAssetKey } = require('../routes/assets-shared');
const { createNoteHash } = require('../lib/crypto');

const ASSET_GC_ADVISORY_KEY = 930746;
const ASSET_OBJECT_MARKER = '/assets/';

function getAssetGcIntervalMs() {
  const raw = process.env.ASSET_GC_INTERVAL_MS;
  if (raw === undefined || raw === '') return 0;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

function getGraceMs() {
  const days = parseFloat(process.env.ASSET_GC_GRACE_DAYS ?? '30');
  const safeDays = Number.isFinite(days) && days >= 0 ? days : 30;
  return Math.floor(safeDays * 24 * 60 * 60 * 1000);
}

function isDryRun() {
  return process.env.ASSET_GC_DRY_RUN !== 'false';
}

async function tryGlobalLock() {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS locked', [ASSET_GC_ADVISORY_KEY]);
  return rows[0]?.locked === true;
}

async function unlockGlobal() {
  try {
    await query('SELECT pg_advisory_unlock($1)', [ASSET_GC_ADVISORY_KEY]);
  } catch {}
}

// `${userId}/assets/<assetKey>` -> { userId, assetKey }. userId is a UUID with
// no slash; anything else (commits, snapshots) is not an asset object.
// Workspace-shared objects (`ws-assets/<wsId>/<assetKey>`, new-scheme flat keys
// only) are asset objects too: their flat key carries workspace+note inline, so
// the GC existence check works without the uploader's account id.
const WS_ASSETS_PREFIX = 'ws-assets/';
function splitAssetObject(key) {
  if (key.startsWith(WS_ASSETS_PREFIX)) {
    const rest = key.slice(WS_ASSETS_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const workspaceId = rest.slice(0, slash);
    const assetKey = rest.slice(slash + 1);
    if (!assetKey || workspaceId.includes('/')) return null;
    return { workspaceId, assetKey };
  }
  const idx = key.indexOf(ASSET_OBJECT_MARKER);
  if (idx <= 0) return null;
  const userId = key.slice(0, idx);
  const assetKey = key.slice(idx + ASSET_OBJECT_MARKER.length);
  if (!assetKey || userId.includes('/')) return null;
  return { userId, assetKey };
}

function existingKey(workspaceId, noteId) {
  return `${workspaceId}\u0000${noteId}`;
}

/**
 * Pure orphan selection. `objects` are `{ key, assetKey, lastModified }`,
 * `existing` is `{ keys: Set('ws\\0note'), noteIds: Set(note) }`. Returns the
 * objects safe to delete.
 */
function selectOrphanAssets(objects, existing, { graceMs, now }) {
  const cutoff = now - graceMs;
  const orphans = [];
  for (const obj of objects) {
    // Undecodable = opaque legacy token or another type: keep, never delete.
    const decoded = decodeAssetKey(obj.assetKey);
    if (!decoded || decoded.type !== 'assets') continue;

    const exists = decoded.workspaceId
      ? existing.keys.has(existingKey(decoded.workspaceId, decoded.noteId))
      : existing.noteIds.has(decoded.noteId);
    if (exists) continue;

    const modified = obj.lastModified ? new Date(obj.lastModified).getTime() : 0;
    // Unknown or too-recent age => keep; the grace period is the only thing
    // standing between a not-yet-pushed upload and deletion.
    if (!(modified > 0 && modified < cutoff)) continue;

    orphans.push(obj);
  }
  return orphans;
}

/**
 * Load server-side note existence for the candidate workspaces/notes. Uses the
 * server's own tables, never a client's local view. A note also exists when it
 * has commits (`/commits`) even without a journal/snapshot row, and the commit
 * table only stores the note-id HMAC, so those are matched by hash.
 * `pairs` are the candidate `(workspaceId, noteId)` pairs, used to promote a
 * commit-only note existence back onto its workspace-scoped key.
 */
async function loadExistingNotes(workspaceIds, noteIds, pairs = []) {
  const keys = new Set();
  const allNoteIds = new Set();
  if (workspaceIds.length > 0 || noteIds.length > 0) {
    const { rows } = await query(
      `SELECT DISTINCT workspace_id, note_id FROM yjs_doc_updates
        WHERE workspace_id = ANY($1) OR note_id = ANY($2)
       UNION
       SELECT DISTINCT workspace_id, note_id FROM sync_document_state
        WHERE workspace_id = ANY($1) OR note_id = ANY($2)`,
      [workspaceIds, noteIds]
    );
    for (const row of rows) {
      keys.add(existingKey(row.workspace_id, row.note_id));
      allNoteIds.add(row.note_id);
    }
  }

  if (noteIds.length > 0) {
    const hashToNoteIds = new Map();
    for (const noteId of noteIds) {
      const hash = createNoteHash(noteId);
      if (!hash) continue;
      if (!hashToNoteIds.has(hash)) hashToNoteIds.set(hash, []);
      hashToNoteIds.get(hash).push(noteId);
    }
    const hashes = [...hashToNoteIds.keys()];
    if (hashes.length > 0) {
      const { rows } = await query(
        'SELECT DISTINCT note_id_hash FROM commits WHERE note_id_hash = ANY($1)',
        [hashes]
      );
      for (const row of rows) {
        for (const noteId of hashToNoteIds.get(row.note_id_hash) ?? []) allNoteIds.add(noteId);
      }
    }
  }

  for (const [workspaceId, noteId] of pairs) {
    if (allNoteIds.has(noteId)) keys.add(existingKey(workspaceId, noteId));
  }
  return { keys, noteIds: allNoteIds };
}

async function runAssetGc(opts = {}) {
  const now = opts.now ?? Date.now();
  const start = Date.now();
  const graceMs = getGraceMs();
  const dryRun = isDryRun();

  const locked = await tryGlobalLock();
  if (!locked) {
    console.log('[asset-gc] skipped: gc already running (advisory lock held)');
    return { skipped: true, reason: 'locked' };
  }

  try {
    const listed = await r2.listObjects('');
    const candidates = [];
    for (const obj of listed) {
      const split = splitAssetObject(obj.key);
      if (!split) continue;
      candidates.push({ ...split, key: obj.key, lastModified: obj.lastModified });
    }
    // ponytail: whole-bucket listing + one existence query per run. Fine at
    // current scale; if the bucket grows, page per `userId` prefix from the
    // accounts table instead.
    if (candidates.length === 0) {
      console.log(`[asset-gc] no asset objects (grace=${graceMs}ms dryRun=${dryRun})`);
      return { candidates: 0, orphans: 0, deleted: 0, failed: 0, dryRun, graceMs };
    }

    const workspaceIds = [];
    const noteIds = [];
    const pairs = [];
    for (const c of candidates) {
      const decoded = decodeAssetKey(c.assetKey);
      if (!decoded) continue;
      noteIds.push(decoded.noteId);
      if (decoded.workspaceId) {
        workspaceIds.push(decoded.workspaceId);
        pairs.push([decoded.workspaceId, decoded.noteId]);
      }
    }
    const existing = await loadExistingNotes(workspaceIds, noteIds, pairs);
    const orphans = selectOrphanAssets(candidates, existing, { graceMs, now });

    if (orphans.length === 0) {
      console.log(
        `[asset-gc] candidates=${candidates.length} orphans=0 grace=${graceMs}ms dryRun=${dryRun}`
      );
      return { candidates: candidates.length, orphans: 0, deleted: 0, failed: 0, dryRun, graceMs };
    }

    if (dryRun) {
      console.log(
        `[asset-gc] DRY RUN: candidates=${candidates.length} wouldDelete=${orphans.length} grace=${graceMs}ms ` +
          `(set ASSET_GC_DRY_RUN=false to delete)`
      );
      return {
        candidates: candidates.length,
        orphans: orphans.length,
        deleted: 0,
        failed: 0,
        dryRun,
        graceMs,
      };
    }

    const { deleted, failed } = await r2.delMany(orphans.map((o) => o.key));
    const duration = Date.now() - start;
    console.log(
      `[asset-gc] candidates=${candidates.length} orphans=${orphans.length} deleted=${deleted} failed=${failed} ` +
        `grace=${graceMs}ms duration=${duration}ms`
    );
    return { candidates: candidates.length, orphans: orphans.length, deleted, failed, dryRun, graceMs, duration };
  } finally {
    await unlockGlobal();
  }
}

let timer = null;

function startAssetGcScheduler(app) {
  const interval = getAssetGcIntervalMs();
  if (!interval) {
    app.log.info('[asset-gc] disabled (ASSET_GC_INTERVAL_MS=0)');
    return null;
  }
  app.log.info(
    `[asset-gc] scheduler enabled interval=${interval}ms graceMs=${getGraceMs()} dryRun=${isDryRun()}`
  );
  timer = setInterval(() => {
    runAssetGc().catch((err) => {
      try {
        app.log.error({ err: err.message }, '[asset-gc] run failed');
      } catch {
        console.error('[asset-gc] run failed', err.message);
      }
    });
  }, interval);
  if (timer.unref) timer.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
  return timer;
}

function stopAssetGcScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  getAssetGcIntervalMs,
  getGraceMs,
  isDryRun,
  splitAssetObject,
  selectOrphanAssets,
  runAssetGc,
  startAssetGcScheduler,
  stopAssetGcScheduler,
  ASSET_GC_ADVISORY_KEY,
};
