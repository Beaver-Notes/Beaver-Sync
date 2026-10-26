const { setupTestDb } = require('../../test/helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const Y = require('yjs')
const { createPostgresPersistence } = require('./yjs-persistence')
const { query } = require('./postgres')
const { getPool } = require('./postgres')

describe('yjs-persistence (ephemeral relay)', () => {
  let pool
  let persistence
  const TEST_WS = 'ws-test-persist'
  const TEST_NOTE = 'note-test-persist'

  before(async () => {
    await setupTestDb() // creates schema on a fresh DB (CI) and only assumes tables locally
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

  function makeNote() {
    const noteId = `${TEST_NOTE}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return { noteId, docName: `workspace:${TEST_WS}:note:${noteId}` }
  }

  async function countRows(noteId) {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS count FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2',
      [TEST_WS, noteId]
    )
    return rows[0].count
  }

  it('writeState does not INSERT relay rows', async () => {
    const { noteId, docName } = makeNote()
    const doc = new Y.Doc()
    doc.getMap('test').set('key', 'value')
    await persistence.writeState(docName, doc)
    doc.destroy()
    assert.strictEqual(await countRows(noteId), 0)
  })

  it('bindState starts empty (broadcast only, never loads journal)', async () => {
    const { docName } = makeNote()
    const doc1 = new Y.Doc()
    doc1.getMap('test').set('key', 'value')
    await persistence.writeState(docName, doc1)
    doc1.destroy()

    const doc2 = new Y.Doc()
    await persistence.bindState(docName, doc2)
    assert.strictEqual(doc2.getMap('test').get('key'), undefined)
    doc2.destroy()
  })

  it('bindState cleans pre-existing poison rows, keeps encrypted envelopes', async () => {
    const { noteId, docName } = makeNote()
    const now = new Date().toISOString()
    await query(`
      INSERT INTO yjs_doc_updates
        (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
      VALUES
        ($1, $2, $3, $4, 0, 'relay', 1, $5, $6),
        ($7, $2, $3, $8, 1, 'client-device', 1, $5, $6)
    `, [`poison-${noteId}`, TEST_WS, noteId, Buffer.from('poison'), Date.now(), now,
        `envelope-${noteId}`, Buffer.from('envelope')])
    assert.strictEqual(await countRows(noteId), 2)

    const doc = new Y.Doc()
    await persistence.bindState(docName, doc)
    doc.destroy()

    const { rows } = await query(
      'SELECT device_id, update_encrypted FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2',
      [TEST_WS, noteId]
    )
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].device_id, 'client-device')
  })
})
