'use strict';

const { getDb } = require('../db');
const persistence = require('../persistence/yjs');

let r2 = null;
try {
  r2 = require('../services/r2');
} catch {
  // R2 not configured
}

const FLUSH_AGE_MS = parseInt(process.env.YJS_FLUSH_AGE_MS ?? '300000', 10); // 5 minutes

/**
 * Flush Yjs updates from SQLite to R2 for documents that haven't been
 * synced (e.g., after a crash or unclean shutdown).
 *
 * This is a safety net — the normal path flushes on document close
 * via the Hocuspocus onStoreDocument hook.
 */
async function flushUnsyncedDocuments() {
  if (!r2) return { flushed: 0 };

  const db = getDb();

  // Find documents with updates older than FLUSH_AGE_MS
  // (likely un-flushed due to crash or unclean shutdown)
  const staleDocs = db.prepare(`
    SELECT DISTINCT workspace_id, note_id, MIN(ts) as oldest_ts
    FROM yjs_doc_updates
    WHERE ts < ? AND update_encrypted = 0
    GROUP BY workspace_id, note_id
  `).all(Date.now() - FLUSH_AGE_MS);

  if (staleDocs.length === 0) return { flushed: 0 };

  console.log(`[recovery] Found ${staleDocs.length} documents with unflushed updates`);

  let flushed = 0;
  for (const { workspace_id, note_id } of staleDocs) {
    try {
      const updates = await persistence.loadAllUpdates(workspace_id, note_id);
      if (updates.length === 0) continue;

      // Merge updates into full document state
      const { Doc } = require('yjs');
      const doc = new Doc();
      for (const update of updates) {
        try {
          const data = update.encrypted
            ? Buffer.from(update.data)
            : update.data instanceof Uint8Array
              ? update.data
              : new Uint8Array(update.data);
          doc.applyUpdate(data);
        } catch {
          // skip corrupt updates
        }
      }

      const state = doc.toBinary();
      const key = `yjs/${workspace_id}/${note_id}.yjs`;
      await r2.put(key, Buffer.from(state), 'application/octet-stream');

      // Clear after successful write
      await persistence.deleteUpdatesForNote(workspace_id, note_id);
      doc.destroy();

      flushed++;
      console.log(`[recovery] Flushed ${workspace_id}/${note_id} (${updates.length} updates, ${state.byteLength} bytes)`);
    } catch (err) {
      console.warn(`[recovery] Failed to flush ${workspace_id}/${note_id}:`, err.message);
    }
  }

  console.log(`[recovery] Flushed ${flushed}/${staleDocs.length} documents`);
  return { flushed };
}

module.exports = { flushUnsyncedDocuments };
