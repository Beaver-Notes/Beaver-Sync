'use strict';

process.env.DATABASE_URL = 'postgresql://localhost:5432/test';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const persistence = require('../../src/persistence/yjs');

describe('Yjs persistence', () => {
  it('storeUpdate returns a promise', async () => {
    const result = persistence.storeUpdate('ws1', 'note1', Buffer.from('test'), 'dev1', 1);
    assert(result instanceof Promise);
    await result.catch(() => {});
  });

  it('exports expected functions', () => {
    assert.equal(typeof persistence.parseRoomName, 'function');
    assert.equal(typeof persistence.storeUpdate, 'function');
    assert.equal(typeof persistence.storeUpdatesBatch, 'function');
    assert.equal(typeof persistence.storeNotesBatch, 'function');
    assert.equal(typeof persistence.getAcceptedBytes, 'function');
    assert.equal(typeof persistence.getWorkspaceSyncState, 'function');
    assert.equal(typeof persistence.getDocumentSyncState, 'function');
    assert.equal(typeof persistence.loadUpdatesAfter, 'function');
    assert.equal(typeof persistence.loadUpdatesSince, 'function');
    assert.equal(typeof persistence.loadAllUpdates, 'function');
    assert.equal(typeof persistence.deleteUpdatesBefore, 'function');
    assert.equal(typeof persistence.deleteUpdatesForNote, 'function');
    assert.equal(typeof persistence.deleteUnencryptedUpdatesForNote, 'function');
    assert.equal(typeof persistence.updateDocumentSyncState, 'function');
    assert.equal(typeof persistence.promoteDocumentSyncState, 'function');
    assert.equal(typeof persistence.deleteJournalRows, 'function');
    assert.equal(typeof persistence.getUpdateCount, 'function');
    assert.equal(typeof persistence.listNoteIds, 'function');
  });

  it('storeUpdatesBatch returns a promise when given updates', async () => {
    const result = persistence.storeUpdatesBatch('ws1', 'note1', [
      { deviceId: 'dev1', sequence: 1, data: Buffer.from('x'), ts: 1 }
    ]);
    assert(result instanceof Promise);
    await result.catch(() => {});
  });

  it('storeUpdatesBatch with empty array resolves to default shape', async () => {
    const result = await persistence.storeUpdatesBatch('ws1', 'note1', []);
    assert.deepEqual(result, { accepted: 0, duplicate: 0, checkpoint: null });
  });

  it('parseRoomName parses workspace and note IDs', () => {
    const result = persistence.parseRoomName('workspace:ws-123:note:note-456');
    assert.deepEqual(result, { workspaceId: 'ws-123', noteId: 'note-456' });
  });

  it('parseRoomName returns null for invalid names', () => {
    assert.equal(persistence.parseRoomName('invalid'), null);
    assert.equal(persistence.parseRoomName(''), null);
  });
});
