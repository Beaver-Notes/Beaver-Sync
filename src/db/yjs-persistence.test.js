const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const Y = require('yjs')
const { createPostgresPersistence } = require('./yjs-persistence')

describe('yjs-persistence', () => {
  let pool
  let persistence

  before(async () => {
    // Use test database
    const { Pool } = require('pg')
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    persistence = createPostgresPersistence(pool)

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS yjs_documents (
        doc_name TEXT PRIMARY KEY,
        state_vector BYTEA,
        blob BYTEA NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
  })

  after(async () => {
    await pool.query('DELETE FROM yjs_documents')
    await pool.end()
  })

  it('bindState loads persisted document', async () => {
    const docName = `test-${Date.now()}`
    const doc1 = new Y.Doc()
    const map1 = doc1.getMap('test')
    map1.set('key', 'value')

    // Persist
    await persistence.writeState(docName, doc1)
    doc1.destroy()

    // Load in new doc
    const doc2 = new Y.Doc()
    await persistence.bindState(docName, doc2)
    const map2 = doc2.getMap('test')
    assert.strictEqual(map2.get('key'), 'value')
    doc2.destroy()
  })

  it('writeState updates existing document', async () => {
    const docName = `test-update-${Date.now()}`
    const doc1 = new Y.Doc()
    doc1.getMap('test').set('v', 1)
    await persistence.writeState(docName, doc1)
    doc1.destroy()

    const doc2 = new Y.Doc()
    await persistence.bindState(docName, doc2)
    doc2.getMap('test').set('v', 2)
    await persistence.writeState(docName, doc2)
    doc2.destroy()

    const doc3 = new Y.Doc()
    await persistence.bindState(docName, doc3)
    assert.strictEqual(doc3.getMap('test').get('v'), 2)
    doc3.destroy()
  })
})
