'use strict';

process.env.YJS_PLAINTEXT_RECOVERY = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const Y = require('yjs');

const { createSnapshotService } = require('../src/lib/sync-snapshots');

function setup() {
  const state = new Map();
  const rows = new Map();
  const objects = new Map();
  const calls = [];

  const keyFor = (workspaceId, noteId) => `${workspaceId}/${noteId}`;
  const r2 = {
    async put(key, body) {
      calls.push(['put', key]);
      objects.set(key, Buffer.from(body));
    },
    async stat(key) {
      calls.push(['stat', key]);
      const body = objects.get(key);
      return body ? { sizeBytes: body.length } : null;
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
  };

  const persistence = {
    async getDocumentSyncState(workspaceId, noteId) {
      return state.get(keyFor(workspaceId, noteId)) ?? null;
    },
    async updateDocumentSyncState(workspaceId, noteId, generation, snapshotKey, checkpoint) {
      const stateKey = keyFor(workspaceId, noteId);
      state.set(stateKey, {
        workspaceId,
        noteId,
        ...(state.get(stateKey) ?? {}),
        snapshot_generation: generation,
        snapshot_key: snapshotKey,
        checkpoint_ts: checkpoint?.ts ?? 0,
        checkpoint_sequence: checkpoint?.sequence ?? 0,
      });
    },
    async loadAllUpdates(workspaceId, noteId) {
      return rows.get(keyFor(workspaceId, noteId)) ?? [];
    },
    async deleteUpdatesForNote(workspaceId, noteId) {
      rows.delete(keyFor(workspaceId, noteId));
    },
    async deleteUnencryptedUpdatesForNote(workspaceId, noteId) {
      const key = keyFor(workspaceId, noteId);
      const remaining = (rows.get(key) ?? []).filter((update) => update.encrypted);
      if (remaining.length === 0) rows.delete(key);
      else rows.set(key, remaining);
    },
    async deleteJournalRows(workspaceId, noteId, captured) {
      const key = keyFor(workspaceId, noteId);
      const identities = new Set(captured.map((update) => `${update.deviceId ?? ''}/${update.clock ?? update.sequence ?? ''}`));
      const remaining = (rows.get(key) ?? []).filter((update) => !identities.has(`${update.deviceId ?? ''}/${update.clock ?? update.sequence ?? ''}`));
      if (remaining.length === 0) rows.delete(key);
      else rows.set(key, remaining);
    },
    async promoteDocumentSyncState(workspaceId, noteId, expectedGeneration, generation, snapshotKey, checkpoint) {
      const key = keyFor(workspaceId, noteId);
      const current = state.get(key);
      const actual = current?.snapshot_generation ?? current?.snapshotGeneration ?? 0;
      if (actual !== expectedGeneration) return false;
      await this.updateDocumentSyncState(workspaceId, noteId, generation, snapshotKey, checkpoint);
      return true;
    },
  };

  return { state, rows, objects, calls, r2, persistence, service: createSnapshotService({ r2, persistence }) };
}

function yjsState(text) {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, text);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function yjsFixture(initialText, nextText) {
  const doc = new Y.Doc();
  doc.getText('note').insert(0, initialText);
  const snapshot = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.getText('note').insert(initialText.length, nextText);
  const update = Y.encodeStateAsUpdate(doc, stateVector);
  doc.destroy();
  return { snapshot, update };
}

test('writes a verified versioned snapshot and advertises its generation', async () => {
  const { service, state, objects } = setup();
  const result = await service.writeDocumentSnapshot({
    workspaceId: 'ws-1',
    noteId: 'note-1',
    generation: 1,
    state: Buffer.from('encrypted-snapshot'),
  });

  assert.deepEqual(result, { key: 'yjs/ws-1/note-1/1.yjs', generation: 1 });
  assert.deepEqual(objects.get(result.key), Buffer.from('encrypted-snapshot'));
  assert.equal(state.get('ws-1/note-1').snapshot_generation, 1);
  assert.equal(state.get('ws-1/note-1').snapshot_key, result.key);
});

test('preserves journal rows when R2 verification fails', async () => {
  const setupResult = setup();
  const { service, rows, persistence, r2 } = setupResult;
  rows.set('ws-1/note-1', [{ data: yjsState('keep'), encrypted: false }]);
  r2.stat = async () => null;

  await assert.rejects(
    service.recoverDocument('ws-1', 'note-1'),
    /snapshot verification failed/,
  );
  assert.equal((await persistence.loadAllUpdates('ws-1', 'note-1')).length, 1);
});

test('preserves a corrupt unencrypted row and does not promote a snapshot', async () => {
  const { service, state, rows, objects, persistence } = setup();
  const row = { data: Buffer.from('corrupt-yjs-update'), encrypted: false, deviceId: 'bad', clock: 1 };
  rows.set('ws-1/note-1', [row]);

  await assert.rejects(service.recoverDocument('ws-1', 'note-1'), /corrupt|invalid|update/i);

  assert.deepEqual(await persistence.loadAllUpdates('ws-1', 'note-1'), [row]);
  assert.equal(state.has('ws-1/note-1'), false);
  assert.equal(objects.size, 0);
});

test('preserves journal rows when the advertised snapshot is missing', async () => {
  const { service, state, rows, objects, persistence } = setup();
  const key = 'yjs/ws-1/note-1/1.yjs';
  const row = { data: yjsState('keep'), encrypted: false, deviceId: 'a', clock: 1 };
  state.set('ws-1/note-1', { snapshot_generation: 1, snapshot_key: key });
  rows.set('ws-1/note-1', [row]);

  await assert.rejects(service.recoverDocument('ws-1', 'note-1'), /advertised snapshot/i);

  assert.deepEqual(await persistence.loadAllUpdates('ws-1', 'note-1'), [row]);
  assert.deepEqual(state.get('ws-1/note-1'), { snapshot_generation: 1, snapshot_key: key });
  assert.equal(objects.size, 0);
});

test('recovers after an interrupted compaction without deleting the journal first', async () => {
  const { service, state, rows, objects } = setup();
  rows.set('ws-1/note-1', [
    { data: yjsState('recovered'), encrypted: false },
  ]);

  await service.recoverDocument('ws-1', 'note-1');

  assert.equal(state.get('ws-1/note-1').snapshot_generation, 1);
  assert.ok(objects.has('yjs/ws-1/note-1/1.yjs'));
  assert.equal(rows.has('ws-1/note-1'), false);
});

test('loads the advertised snapshot before applying journal rows', async () => {
  const { service, state, rows, objects } = setup();
  const key = 'yjs/ws-1/note-1/1.yjs';
  const fixture = yjsFixture('base', '-journal');
  state.set('ws-1/note-1', { snapshot_generation: 1, snapshot_key: key });
  objects.set(key, Buffer.from(fixture.snapshot));
  rows.set('ws-1/note-1', [{ data: fixture.update, encrypted: false, deviceId: 'a', clock: 1, ts: 1 }]);

  await service.recoverDocument('ws-1', 'note-1');

  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, objects.get('yjs/ws-1/note-1/2.yjs'));
  assert.equal(recovered.getText('note').toString(), 'base-journal');
  recovered.destroy();
});

test('promotes only one competing generation', async () => {
  const { service } = setup();
  const writes = await Promise.allSettled([
    service.writeDocumentSnapshot({ workspaceId: 'ws-1', noteId: 'note-1', generation: 1, state: Buffer.from('a') }),
    service.writeDocumentSnapshot({ workspaceId: 'ws-1', noteId: 'note-1', generation: 1, state: Buffer.from('b') }),
  ]);

  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter((result) => result.status === 'rejected').length, 1);
});

test('deletes only rows captured before compaction', async () => {
  const setupResult = setup();
  const { service, rows, persistence, r2 } = setupResult;
  const early = { data: yjsState('early'), encrypted: false, deviceId: 'a', clock: 1, ts: 1 };
  const late = { data: yjsState('late'), encrypted: false, deviceId: 'b', clock: 2, ts: 2 };
  rows.set('ws-1/note-1', [early]);
  const originalStat = r2.stat;
  r2.stat = async (key) => {
    rows.set('ws-1/note-1', [early, late]);
    return originalStat(key);
  };

  await service.recoverDocument('ws-1', 'note-1');

  assert.deepEqual(await persistence.loadAllUpdates('ws-1', 'note-1'), [late]);
});

test('keeps journal rows when SQLite promotion fails', async () => {
  const setupResult = setup();
  const { service, rows, persistence } = setupResult;
  const row = { data: yjsState('keep'), encrypted: false, deviceId: 'a', clock: 1, ts: 1 };
  rows.set('ws-1/note-1', [row]);
  persistence.promoteDocumentSyncState = async () => {
    throw new Error('sqlite update failed');
  };

  await assert.rejects(service.recoverDocument('ws-1', 'note-1'), /sqlite update failed/);
  assert.deepEqual(await persistence.loadAllUpdates('ws-1', 'note-1'), [row]);
});

test('advances through repeated generations without losing prior content', async () => {
  const setupResult = setup();
  const { service, state, rows, objects } = setupResult;
  const fixture = yjsFixture('one', '-two');
  rows.set('ws-1/note-1', [{ data: fixture.snapshot, encrypted: false, deviceId: 'a', clock: 1, ts: 1 }]);
  await service.recoverDocument('ws-1', 'note-1');
  rows.set('ws-1/note-1', [{ data: fixture.update, encrypted: false, deviceId: 'a', clock: 2, ts: 2 }]);
  await service.recoverDocument('ws-1', 'note-1');

  assert.equal(state.get('ws-1/note-1').snapshot_generation, 2);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, objects.get('yjs/ws-1/note-1/2.yjs'));
  assert.equal(doc.getText('note').toString(), 'one-two');
  doc.destroy();
});

test('rejects a generation that is not the next advertised generation', async () => {
  const { service, state } = setup();
  state.set('ws-1/note-1', {
    workspaceId: 'ws-1',
    noteId: 'note-1',
    snapshot_generation: 3,
    snapshot_key: 'yjs/ws-1/note-1/3.yjs',
  });

  await assert.rejects(
    service.writeDocumentSnapshot({
      workspaceId: 'ws-1',
      noteId: 'note-1',
      generation: 5,
      state: Buffer.from('state'),
    }),
    /generation mismatch/,
  );
});

test('does not delete encrypted journal data during recovery', async () => {
  const { service, rows, persistence } = setup();
  rows.set('ws-1/note-1', [
    { data: yjsState('plain'), encrypted: false, deviceId: 'plain', clock: 1 },
    { data: Buffer.from('opaque-ciphertext'), encrypted: true, deviceId: 'encrypted', clock: 1 },
  ]);

  await service.recoverDocument('ws-1', 'note-1');

  const remaining = await persistence.loadAllUpdates('ws-1', 'note-1');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].encrypted, true);
  assert.deepEqual(remaining[0].data, Buffer.from('opaque-ciphertext'));
});

test('keeps opaque rows available after recovery and compaction', async () => {
  const { service, rows, persistence } = setup();
  rows.set('ws-1/note-1', [
    { data: yjsState('plain'), encrypted: false, deviceId: 'plain', clock: 1 },
    { data: Buffer.from('opaque-envelope'), encrypted: true, deviceId: 'remote', clock: 2 },
  ]);

  await service.recoverDocument('ws-1', 'note-1');

  assert.deepEqual(await persistence.loadAllUpdates('ws-1', 'note-1'), [
    { data: Buffer.from('opaque-envelope'), encrypted: true, deviceId: 'remote', clock: 2 },
  ]);
});
