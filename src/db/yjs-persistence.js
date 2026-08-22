'use strict'

const Y = require('yjs')

/**
 * Postgres persistence adapter for y-websocket.
 * Implements the { bindState, writeState } interface.
 *
 * @param {import('pg').Pool} pool
 */
function createPostgresPersistence(pool) {
  const docs = new Map()

  async function bindState(docName, doc) {
    try {
      const result = await pool.query(
        'SELECT blob FROM yjs_documents WHERE doc_name = $1',
        [docName]
      )

      if (result.rows.length > 0) {
        const blob = result.rows[0].blob
        Y.applyUpdate(doc, blob)
      }

      // Listen for changes and persist
      doc.on('update', (update, origin) => {
        // Don't persist updates from the persistence layer itself
        if (origin === 'persistence') return

        const docEntry = docs.get(docName)
        if (docEntry) {
          docEntry.dirty = true
        }
      })

      docs.set(docName, { doc, dirty: false })
    } catch (err) {
      console.error(`[yjs-persistence] bindState failed for ${docName}:`, err.message)
    }
  }

  async function writeState(docName, doc) {
    try {
      const stateVector = Y.encodeStateVector(doc)
      const blob = Y.encodeStateAsUpdate(doc)

      await pool.query(
        `INSERT INTO yjs_documents (doc_name, state_vector, blob, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (doc_name) DO UPDATE SET
           state_vector = EXCLUDED.state_vector,
           blob = EXCLUDED.blob,
           updated_at = NOW()`,
        [docName, stateVector, blob]
      )

      docs.delete(docName)
    } catch (err) {
      console.error(`[yjs-persistence] writeState failed for ${docName}:`, err.message)
    }
  }

  return { bindState, writeState }
}

module.exports = { createPostgresPersistence }
