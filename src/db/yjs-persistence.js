'use strict'

const Y = require('yjs')
const { query } = require('./postgres')
const { loadUpdatesSince, getDocumentSyncState } = require('../persistence/yjs-queries')
const { parseRoomName, generateUpdateId } = require('../persistence/yjs')
const { getObjectStorage } = require('../routes/sync-state')
const { snapshotKeyFor } = require('../routes/sync-state')

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
   * Uses generation-aware checkpoint (checkpointTs/checkpointSequence) for incremental loading.
   * @param {string} docName - Room name like "workspace:ws-123:note:note-456"
   * @param {Y.Doc} doc - Yjs document to populate
   * @returns {Promise<void>}
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

      // 2. Load journal tail using snapshot timestamp (generation-aware: only updates after snapshot)
      // loadUpdatesSince loads all updates after a timestamp without pagination limit
      const sinceTs = syncState?.snapshotTs ?? 0
      const updates = await loadUpdatesSince(workspaceId, noteId, sinceTs)
      for (const update of updates) {
        Y.applyUpdate(doc, update.data)
      }
      console.log(`[yjs-persistence] Applied ${updates.length} journal updates for ${docName} (sinceTs=${sinceTs}, gen=${syncState?.snapshotGeneration ?? 0})`)

      // 3. Track state vector for incremental updates
      const stateVector = Y.encodeStateVector(doc)

      // 4. Listen for changes and persist to journal
      doc.on('update', (update, origin) => {
        if (origin === 'persistence') return

        const docEntry = docs.get(docName)
        if (docEntry) {
          docEntry.dirty = true
        }
      })

      docs.set(docName, { doc, dirty: false, workspaceId, noteId, stateVector })
    } catch (err) {
      console.error(`[yjs-persistence] bindState failed for ${docName}:`, err.message)
    }
  }

  /**
   * Persist document state by appending incremental update to yjs_doc_updates journal.
   * Triggers periodic S3 snapshot generation based on update count/generation.
   * @param {string} docName
   * @param {Y.Doc} doc
   * @returns {Promise<void>}
   */
  async function writeState(docName, doc) {
    const docEntry = docs.get(docName)

    // Parse workspaceId/noteId from docName if not already in docEntry
    let workspaceId, noteId, stateVector, isFirstWrite = false
    if (docEntry) {
      if (!docEntry.dirty) return
      workspaceId = docEntry.workspaceId
      noteId = docEntry.noteId
      stateVector = docEntry.stateVector
    } else {
      // Allow writeState to be called before bindState (e.g., in tests)
      const parsed = parseRoomName(docName)
      if (!parsed || !parsed.noteId) {
        console.warn(`[yjs-persistence] writeState: invalid docName "${docName}"`)
        return
      }
      workspaceId = parsed.workspaceId
      noteId = parsed.noteId
      // For first write without bindState, we don't have a prior state vector
      // so we'll encode the full state
      stateVector = null
      isFirstWrite = true
    }

    if (!workspaceId || !noteId) {
      console.warn(`[yjs-persistence] writeState: missing workspaceId/noteId for ${docName}`)
      return
    }

    try {
      // Encode incremental update from last known state vector, or full state if first write
      const update = isFirstWrite ? Y.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdate(doc, stateVector)

      // Update stored state vector for next incremental write
      if (docEntry) {
        docEntry.stateVector = Y.encodeStateVector(doc)
      }

      // Store as a single journal entry with a synthetic device/clock
      // Use a reserved device_id prefix to distinguish relay-originated updates
      const deviceId = 'relay'
      const clock = Date.now()
      const ts = clock
      const updateId = generateUpdateId()

      await query(`
        INSERT INTO yjs_doc_updates (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, note_id, device_id, clock) DO NOTHING
      `, [
        updateId,
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
        docEntry.lastClock = clock
      }
      console.log(`[yjs-persistence] Persisted incremental journal update for ${docName} (${update.byteLength} bytes)`)

      // Periodic S3 snapshot generation: trigger every 100 updates or when update size exceeds threshold
      await maybeCreateSnapshot(workspaceId, noteId, doc, clock)
    } catch (err) {
      console.error(`[yjs-persistence] writeState failed for ${docName}:`, err.message)
      throw err
    }
  }

  /**
   * Create S3 snapshot if generation threshold reached.
   * Uses generation-tagged key and updates sync_document_state.
   * @param {string} workspaceId
   * @param {string} noteId
   * @param {Y.Doc} doc
   * @param {number} clock - Timestamp of the last update
   * @returns {Promise<void>}
   */
  async function maybeCreateSnapshot(workspaceId, noteId, doc, clock) {
    try {
      const syncState = await getDocumentSyncState(workspaceId, noteId)
      const currentGeneration = syncState?.snapshotGeneration ?? 0
      const updateCount = await getUpdateCountSinceSnapshot(workspaceId, noteId, syncState?.checkpointTs ?? 0)

      // Trigger snapshot every 100 updates or if no snapshot exists yet
      const shouldSnapshot = currentGeneration === 0 || updateCount >= 100

      if (!shouldSnapshot) return

      const storage = getObjectStorage()
      if (!storage || typeof storage.put !== 'function') {
        console.warn(`[yjs-persistence] Object storage unavailable, skipping snapshot for ${workspaceId}/${noteId}`)
        return
      }

      const nextGeneration = currentGeneration + 1
      const key = snapshotKeyFor(workspaceId, noteId, nextGeneration)
      const snapshotData = Y.encodeStateAsUpdate(doc)

      await storage.put(key, snapshotData, 'application/octet-stream')

      // Verify the snapshot was written
      if (typeof storage.stat === 'function') {
        const obj = await storage.stat(key)
        if (!obj || !Number.isInteger(obj.sizeBytes) || obj.sizeBytes <= 0) {
          console.error(`[yjs-persistence] Snapshot verification failed for ${key}`)
          return
        }
      }

      // Update sync_document_state with new snapshot generation and checkpoint
      const checkpointTs = Date.now()
      const checkpointSequence = clock
      await query(`
        INSERT INTO sync_document_state
          (workspace_id, note_id, snapshot_generation, snapshot_key, checkpoint_ts, checkpoint_sequence, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(workspace_id, note_id) DO UPDATE SET
          snapshot_generation = excluded.snapshot_generation,
          snapshot_key = excluded.snapshot_key,
          checkpoint_ts = excluded.checkpoint_ts,
          checkpoint_sequence = excluded.checkpoint_sequence,
          updated_at = excluded.updated_at
      `, [workspaceId, noteId, nextGeneration, key, checkpointTs, checkpointSequence, new Date().toISOString()])

      console.log(`[yjs-persistence] Created S3 snapshot gen=${nextGeneration} for ${workspaceId}/${noteId} (${snapshotData.byteLength} bytes)`)
    } catch (err) {
      console.error(`[yjs-persistence] Failed to create snapshot for ${workspaceId}/${noteId}:`, err.message)
    }
  }

  /**
   * Count updates since last snapshot checkpoint.
   * @param {string} workspaceId
   * @param {string} noteId
   * @param {number} sinceTs
   * @returns {Promise<number>}
   */
  async function getUpdateCountSinceSnapshot(workspaceId, noteId, sinceTs) {
    const { rows } = await query(`
      SELECT COUNT(*)::int AS count FROM yjs_doc_updates
      WHERE workspace_id = $1 AND note_id = $2 AND ts > $3
    `, [workspaceId, noteId, sinceTs])
    return rows[0]?.count ?? 0
  }

  return { bindState, writeState }
}

module.exports = { createPostgresPersistence }
