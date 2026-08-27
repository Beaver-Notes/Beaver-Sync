'use strict'

const Y = require('yjs')
const { query } = require('./postgres')
const { loadUpdatesSince, getDocumentSyncState } = require('../persistence/yjs-queries')
const { parseRoomName } = require('../persistence/yjs')
const { getObjectStorage } = require('../routes/sync-state')

/**
 * Postgres persistence adapter for y-websocket (relay).
 * Persists through the journal machinery: writes append to yjs_doc_updates,
 * reads reconstruct from latest S3 snapshot + journal tail.
 *
 * @param {import('pg').Pool} _pool - Unused; kept for interface compatibility
 */
function createPostgresPersistence(_pool) {
  const docs = new Map()

  /**
   * Reconstruct document state from latest S3 snapshot + journal tail.
   * @param {string} docName - Room name like "workspace:ws-123:note:note-456"
   * @param {Y.Doc} doc - Yjs document to populate
   */
  async function bindState(docName, doc) {
    const parsed = parseRoomName(docName)
    if (!parsed || !parsed.noteId) {
      console.warn(`[yjs-persistence] bindState: invalid docName "${docName}"`)
      return
    }

    const { workspaceId, noteId } = parsed

    try {
      // 1. Try to load latest S3 snapshot
      const syncState = await getDocumentSyncState(workspaceId, noteId)
      if (syncState && syncState.snapshotKey && syncState.snapshotGeneration > 0) {
        const storage = getObjectStorage()
        if (storage && typeof storage.get === 'function') {
          try {
            const obj = await storage.get(syncState.snapshotKey)
            if (obj && obj.body) {
              const snapshotData = await obj.body.arrayBuffer()
              Y.applyUpdate(doc, new Uint8Array(snapshotData))
              console.log(`[yjs-persistence] Applied snapshot gen=${syncState.snapshotGeneration} for ${docName}`)
            }
          } catch (err) {
            console.warn(`[yjs-persistence] Failed to load snapshot for ${docName}:`, err.message)
          }
        }
      }

      // 2. Load journal tail (updates since snapshot timestamp)
      const sinceTs = syncState?.snapshotTs ?? 0
      const updates = await loadUpdatesSince(workspaceId, noteId, sinceTs)
      for (const update of updates) {
        Y.applyUpdate(doc, update.data)
      }
      console.log(`[yjs-persistence] Applied ${updates.length} journal updates for ${docName} (sinceTs=${sinceTs})`)

      // 3. Listen for changes and persist to journal
      doc.on('update', (update, origin) => {
        if (origin === 'persistence') return

        const docEntry = docs.get(docName)
        if (docEntry) {
          docEntry.dirty = true
        }
      })

      docs.set(docName, { doc, dirty: false, workspaceId, noteId })
    } catch (err) {
      console.error(`[yjs-persistence] bindState failed for ${docName}:`, err.message)
    }
  }

  /**
   * Persist document state by appending to yjs_doc_updates journal.
   * Also triggers periodic S3 snapshot via existing mechanism.
   * @param {string} docName
   * @param {Y.Doc} doc
   */
  async function writeState(docName, doc) {
    const docEntry = docs.get(docName)

    // Parse workspaceId/noteId from docName if not already in docEntry
    let workspaceId, noteId
    if (docEntry) {
      if (!docEntry.dirty) return
      workspaceId = docEntry.workspaceId
      noteId = docEntry.noteId
    } else {
      // Allow writeState to be called before bindState (e.g., in tests)
      const parsed = parseRoomName(docName)
      if (!parsed || !parsed.noteId) {
        console.warn(`[yjs-persistence] writeState: invalid docName "${docName}"`)
        return
      }
      workspaceId = parsed.workspaceId
      noteId = parsed.noteId
    }

    if (!workspaceId || !noteId) {
      console.warn(`[yjs-persistence] writeState: missing workspaceId/noteId for ${docName}`)
      return
    }

    try {
      // Encode full document state as update
      const update = Y.encodeStateAsUpdate(doc)

      // Store as a single journal entry with a synthetic device/clock
      // Use a reserved device_id prefix to distinguish relay-originated updates
      const deviceId = 'relay'
      const clock = Date.now()
      const ts = clock

      await query(`
        INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, note_id, device_id, clock) DO NOTHING
      `, [
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        workspaceId,
        noteId,
        update,
        0, // not encrypted (relay handles plaintext)
        deviceId,
        clock,
        ts,
        new Date().toISOString()
      ])

      if (docEntry) {
        docEntry.dirty = false
      }
      console.log(`[yjs-persistence] Persisted journal update for ${docName} (${update.byteLength} bytes)`)

      // TODO: Periodic S3 snapshot - could be triggered by a background job
      // that checks document update count/generation and calls snapshot upload.
      // For now, the existing sync-state initialization flow handles snapshots.
    } catch (err) {
      console.error(`[yjs-persistence] writeState failed for ${docName}:`, err.message)
      throw err
    }
  }

  return { bindState, writeState }
}

module.exports = { createPostgresPersistence }
