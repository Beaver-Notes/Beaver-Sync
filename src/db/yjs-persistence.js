'use strict'

const { deleteUnencryptedUpdatesForNote } = require('../persistence/yjs-queries')
const { parseRoomName } = require('../persistence/yjs')

/**
 * Ephemeral relay adapter for y-websocket (E2EE).
 * Never persists note-room Yjs bytes: yjs_doc_updates holds only
 * client-encrypted envelopes, and relay plaintext mixed into it breaks
 * envelope-decrypt on pull. Broadcast only; deletes pre-fix poison rows.
 *
 * Client-encrypted envelopes (REST push-batch) and client-uploaded snapshots
 * (sync-state) use separate paths and are unaffected.
 *
 * @param {import('pg').Pool} _pool - Unused; kept for interface compatibility
 */
function createPostgresPersistence(_pool) {
  const docs = new Map()

  /**
   * Ephemeral bind: start empty, broadcast only. Never loads snapshots or
   * journal rows (journal holds encrypted envelopes, not valid Yjs updates).
   * Best-effort deletes pre-fix plaintext relay rows for this note.
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
      await deleteUnencryptedUpdatesForNote(workspaceId, noteId)
    } catch (err) {
      console.warn(`[yjs-persistence] poison-row cleanup failed for ${docName}:`, err.message)
    }

    // Track dirty flag only so writeState can skip no-op persists
    doc.on('update', (update, origin) => {
      if (origin === 'persistence') return

      const docEntry = docs.get(docName)
      if (docEntry) {
        docEntry.dirty = true
      }
    })

    docs.set(docName, { doc, dirty: false, workspaceId, noteId })
  }

  /**
   * Ephemeral persist: broadcast only, never writes relay plaintext to the
   * journal or S3. Best-effort deletes pre-fix plaintext relay rows.
   * @param {string} docName
   * @param {Y.Doc} doc
   * @returns {Promise<void>}
   */
  async function writeState(docName, _doc) {
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
      await deleteUnencryptedUpdatesForNote(workspaceId, noteId)
    } catch (err) {
      console.warn(`[yjs-persistence] poison-row cleanup failed for ${docName}:`, err.message)
    }

    if (docEntry) {
      docEntry.dirty = false
    }
  }

  return { bindState, writeState }
}

module.exports = { createPostgresPersistence }
