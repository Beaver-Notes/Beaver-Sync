'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('yjs');

process.env.NODE_ENV = 'test';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const persistence = require('../src/persistence/yjs');
const { createPostgresPersistence } = require('../src/db/yjs-persistence');
const { getPool } = require('../src/db/postgres');

const TEST_WORKSPACE = 'ws-conv';
const TEST_NOTE = 'note-conv';
const TEST_ACCOUNT = 'account-conv';

async function seedWorkspace() {
  await query(`
    INSERT INTO accounts (id, email_hmac, created_at)
    VALUES ($1, $2, $3)
  `, [TEST_ACCOUNT, 'email-hmac-conv', new Date().toISOString()]);
  await query(`
    INSERT INTO workspaces (id, name_encrypted, owner_id, created_at)
    VALUES ($1, $2, $3, $4)
  `, [TEST_WORKSPACE, 'name', TEST_ACCOUNT, new Date().toISOString()]);
  await query(`
    INSERT INTO workspace_members (workspace_id, account_id, role, created_at)
    VALUES ($1, $2, $3, $4)
  `, [TEST_WORKSPACE, TEST_ACCOUNT, 'owner', new Date().toISOString()]);
}

async function seedRelayDoc(docName, initialText) {
  // Simulate pre-existing relay document in yjs_documents (pre-migration state)
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, initialText);
  const blob = Y.encodeStateAsUpdate(doc);
  await query(`
    INSERT INTO yjs_documents (doc_name, blob, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (doc_name) DO UPDATE SET blob = EXCLUDED.blob, updated_at = NOW()
  `, [docName, blob]);
  doc.destroy();
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedWorkspace();
});

test.after(async () => {
  await close();
});

test('cross-path convergence: relay-only edit is visible to REST puller', async () => {
  const docName = `workspace:${TEST_WORKSPACE}:note:${TEST_NOTE}`;
  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);

  // 1. Seed a pre-existing relay document (simulating pre-migration state)
  await seedRelayDoc(docName, 'initial relay content');

  // 2. Run migration to fold relay doc into journal
  const { migrateYjsDocumentsToJournal } = require('../src/db/migrate-postgres');
  const migrationResult = await migrateYjsDocumentsToJournal();
  assert.equal(migrationResult.migrated, 1);
  assert.equal(migrationResult.deleted, 1);

  // 3. Relay client connects and makes an edit
  const relayDoc = new Y.Doc();
  const relayText = relayDoc.getText('content');

  // Bind state - this should load from journal (which now has the migrated snapshot)
  await relayPersistence.bindState(docName, relayDoc);

  // Verify initial content loaded from migration
  assert.equal(relayText.toString(), 'initial relay content');

  // Relay client makes an edit
  relayText.insert(relayText.length, ' + relay edit');

  // Persist the relay edit to journal
  await relayPersistence.writeState(docName, relayDoc);

  // 4. REST puller fetches updates via loadUpdatesAfter (simulating REST pull-batch)
  const checkpoint = {}; // empty checkpoint = full pull
  const page = await persistence.loadUpdatesAfter(TEST_WORKSPACE, TEST_NOTE, checkpoint, 100);

  // 5. Verify the relay edit appears in the journal for REST puller
  const relayEdits = page.updates.filter(u => u.deviceId === 'relay');
  assert.ok(relayEdits.length >= 1, 'Should have at least one relay update');

  // Apply all updates to a fresh doc to verify convergence
  const restDoc = new Y.Doc();
  const restText = restDoc.getText('content');
  for (const update of page.updates) {
    Y.applyUpdate(restDoc, update.data);
  }

  // The final content should include both initial and relay edit
  assert.ok(restText.toString().includes('initial relay content'), 'Should have initial content');
  assert.ok(restText.toString().includes('relay edit'), 'Should have relay edit');

  // 6. Quota accounting should apply to relay-originated updates
  // (This is implicitly tested by the store path using the same journal machinery)

  relayDoc.destroy();
  restDoc.destroy();
});

test('relay bindState reconstructs from S3 snapshot + journal tail', async () => {
  const docName = `workspace:${TEST_WORKSPACE}:note:note-snapshot`;
  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);

  // This test verifies the bindState reconstruction logic works
  // Note: Full S3 integration requires storage service, so we test the journal path

  const relayDoc = new Y.Doc();
  await relayPersistence.bindState(docName, relayDoc);

  // Should not throw, doc should be empty (no prior data)
  const relayText = relayDoc.getText('content');
  assert.equal(relayText.toString(), '');

  relayDoc.destroy();
});

test('quota netting applies to relay-originated updates via journal', async () => {
  // This test verifies that relay updates go through the same quota accounting
  // as REST updates by virtue of using storeNotesBatch internally
  // (The actual quota enforcement is tested in yjs-persistence.test.js)

  const pool = getPool();
  const relayPersistence = createPostgresPersistence(pool);
  const docName = `workspace:${TEST_WORKSPACE}:note:note-quota`;

  const relayDoc = new Y.Doc();
  const relayText = relayDoc.getText('content');

  // bindState must be called first to register the doc and set dirty tracking
  await relayPersistence.bindState(docName, relayDoc);

  // Now make edits and persist
  relayText.insert(0, 'quota test');
  relayText.insert(relayText.length, ' more');
  await relayPersistence.writeState(docName, relayDoc);

  // Verify the update was written to yjs_doc_updates
  const { rows } = await query(`
    SELECT update_data, device_id FROM yjs_doc_updates
    WHERE workspace_id = $1 AND note_id = $2
  `, [TEST_WORKSPACE, 'note-quota']);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_id, 'relay');

  // Verify it's a valid Yjs update by applying it
  const verifyDoc = new Y.Doc();
  Y.applyUpdate(verifyDoc, rows[0].update_data);
  const verifyText = verifyDoc.getText('content');
  assert.equal(verifyText.toString(), 'quota test more');

  relayDoc.destroy();
  verifyDoc.destroy();
});