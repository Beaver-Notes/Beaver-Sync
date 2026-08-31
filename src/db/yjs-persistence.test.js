require('../../test/helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const Y = require('yjs')
const { createPostgresPersistence } = require('./yjs-persistence')
const { query } = require('./postgres')
const { getPool } = require('./postgres')

describe('yjs-persistence (journal-backed)', () => {
  let pool
  let persistence
  const TEST_WS = 'ws-test-persist'
  const TEST_NOTE = 'note-test-persist'

  before(async () => {
    pool = getPool()
    persistence = createPostgresPersistence(pool)

    // Seed workspace for FK constraints
    await query(`
      INSERT INTO accounts (id, email_hmac, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `, ['account-persist', 'email-hmac-persist', new Date().toISOString()])
    await query(`
      INSERT INTO workspaces (id, name_encrypted, owner_id, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING
    `, [TEST_WS, 'name', 'account-persist', new Date().toISOString()])
    await query(`
      INSERT INTO workspace_members (workspace_id, account_id, role, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (workspace_id, account_id) DO NOTHING
    `, [TEST_WS, 'account-persist', 'owner', new Date().toISOString()])
  })

  after(async () => {
    await query('DELETE FROM yjs_doc_updates WHERE workspace_id = $1', [TEST_WS])
  })

  function makeDocName() {
    return `workspace:${TEST_WS}:note:${TEST_NOTE}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  it('bindState loads persisted document from journal', async () => {
    const docName = makeDocName()
    const doc1 = new Y.Doc()
    const map1 = doc1.getMap('test')
    map1.set('key', 'value')

    // Persist via writeState (writes to journal)
    await persistence.writeState(docName, doc1)
    doc1.destroy()

    // Give time for async persistence
    await new Promise(r => setTimeout(r, 50))

    // Load in new doc (reads from journal)
    const doc2 = new Y.Doc()
    await persistence.bindState(docName, doc2)
    await new Promise(r => setTimeout(r, 50))
    const map2 = doc2.getMap('test')
    assert.strictEqual(map2.get('key'), 'value')
    doc2.destroy()
  })

  it('writeState updates existing document via journal append', async () => {
    const docName = makeDocName()
    const doc1 = new Y.Doc()
    doc1.getMap('test').set('v', 1)
    await persistence.writeState(docName, doc1)
    doc1.destroy()

    await new Promise(r => setTimeout(r, 50))

    const doc2 = new Y.Doc()
    await persistence.bindState(docName, doc2)
    await new Promise(r => setTimeout(r, 50))
    doc2.getMap('test').set('v', 2)
    await persistence.writeState(docName, doc2)
    doc2.destroy()

    await new Promise(r => setTimeout(r, 50))

    const doc3 = new Y.Doc()
    await persistence.bindState(docName, doc3)
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(doc3.getMap('test').get('v'), 2)
    doc3.destroy()
  })
})
