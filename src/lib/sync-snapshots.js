'use strict';

const Y = require('yjs');
const defaultR2 = require('../services/r2');
const defaultPersistence = require('../persistence/yjs');

function nextGeneration(documentState) {
  return (documentState?.snapshotGeneration ?? documentState?.snapshot_generation ?? 0) + 1;
}

function snapshotKey(workspaceId, noteId, generation) {
  return `yjs/${workspaceId}/${noteId}/${generation}.yjs`;
}

function createSnapshotService({ r2 = defaultR2, persistence = defaultPersistence } = {}) {
  const locks = new Map();

  async function withDocumentLock(workspaceId, noteId, operation) {
    const lockKey = `${workspaceId}/${noteId}`;
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(lockKey, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(lockKey) === queued) locks.delete(lockKey);
    }
  }

  async function promoteSnapshot({ workspaceId, noteId, expectedGeneration, generation, key, checkpoint }) {
    if (typeof persistence.promoteDocumentSyncState === 'function') {
      const promoted = await persistence.promoteDocumentSyncState(
        workspaceId,
        noteId,
        expectedGeneration,
        generation,
        key,
        checkpoint,
      );
      if (!promoted) throw new Error(`snapshot generation mismatch: expected ${generation}, received ${expectedGeneration}`);
      return;
    }
    await persistence.updateDocumentSyncState(workspaceId, noteId, generation, key, checkpoint);
  }

  async function writeSnapshot({ workspaceId, noteId, generation, state, expectedGeneration, checkpoint }) {
    const current = await persistence.getDocumentSyncState(workspaceId, noteId);
    const actualGeneration = current?.snapshotGeneration ?? current?.snapshot_generation ?? 0;
    const expected = expectedGeneration ?? actualGeneration;
    if (generation !== expected + 1) {
      throw new Error(`snapshot generation mismatch: expected ${expected + 1}, received ${generation}`);
    }

    const body = Buffer.from(state);
    const key = snapshotKey(workspaceId, noteId, generation);
    await r2.put(key, body, 'application/octet-stream', { ifNoneMatch: true });

    const object = await r2.stat(key);
    if (!object || object.sizeBytes !== body.byteLength) {
      throw new Error(`snapshot verification failed for ${key}`);
    }

    await promoteSnapshot({ workspaceId, noteId, expectedGeneration: expected, generation, key, checkpoint });
    return { key, generation };
  }

  async function writeDocumentSnapshot({ workspaceId, noteId, generation, state }) {
    if (process.env.YJS_PLAINTEXT_RECOVERY !== 'true') {
      return { disabled: true };
    }
    return withDocumentLock(workspaceId, noteId, () => writeSnapshot({
      workspaceId, noteId, generation, state,
    }));
  }

  async function recoverDocument(workspaceId, noteId) {
    if (process.env.YJS_PLAINTEXT_RECOVERY !== 'true') {
      return { disabled: true };
    }
    return withDocumentLock(workspaceId, noteId, async () => {
      const current = await persistence.getDocumentSyncState(workspaceId, noteId);
      const updates = await persistence.loadAllUpdates(workspaceId, noteId);
      if (updates.length === 0) return null;

      const doc = new Y.Doc();
      let checkpoint = null;
      const appliedRows = [];
      try {
        const snapshotKeyValue = current?.snapshotKey ?? current?.snapshot_key;
        if (snapshotKeyValue) {
          const snapshot = await r2.get(snapshotKeyValue);
          if (!snapshot) throw new Error(`advertised snapshot missing: ${snapshotKeyValue}`);
          if (!(snapshot instanceof Uint8Array)) throw new Error(`advertised snapshot invalid: ${snapshotKeyValue}`);
          try {
            Y.applyUpdate(doc, snapshot);
          } catch (err) {
            throw new Error(`advertised snapshot invalid: ${snapshotKeyValue}`, { cause: err });
          }
        }

        for (const update of updates) {
          if (update.encrypted) continue;
          try {
            const data = update.data instanceof Uint8Array ? update.data : Buffer.from(update.data);
            Y.applyUpdate(doc, data);
            appliedRows.push(update);
            const candidate = {
              ts: update.ts ?? 0,
              sequence: update.clock ?? update.sequence ?? 0,
              deviceId: update.deviceId ?? '',
            };
            if (!checkpoint || candidate.ts > checkpoint.ts || (candidate.ts === checkpoint.ts && candidate.sequence > checkpoint.sequence) || (candidate.ts === checkpoint.ts && candidate.sequence === checkpoint.sequence && candidate.deviceId > checkpoint.deviceId)) {
              checkpoint = candidate;
            }
          } catch (err) {
            throw new Error(`journal update could not be applied: ${update.deviceId ?? ''}/${update.clock ?? update.sequence ?? ''}`, { cause: err });
          }
        }

        const result = await writeSnapshot({
          workspaceId,
          noteId,
          generation: nextGeneration(current),
          expectedGeneration: current?.snapshotGeneration ?? current?.snapshot_generation ?? 0,
          state: Y.encodeStateAsUpdate(doc),
          checkpoint,
        });
        if (typeof persistence.deleteJournalRows === 'function') {
          await persistence.deleteJournalRows(workspaceId, noteId, appliedRows);
        } else {
          await persistence.deleteUnencryptedUpdatesForNote(workspaceId, noteId);
        }
        return result;
      } finally {
        doc.destroy();
      }
    });
  }

  async function loadDocumentSnapshot(workspaceId, noteId) {
    const state = await persistence.getDocumentSyncState(workspaceId, noteId);
    const key = state?.snapshotKey ?? state?.snapshot_key;
    return key ? r2.get(key) : null;
  }

  return { writeDocumentSnapshot, recoverDocument, loadDocumentSnapshot };
}

const service = createSnapshotService();

module.exports = {
  createSnapshotService,
  writeDocumentSnapshot: service.writeDocumentSnapshot,
  recoverDocument: service.recoverDocument,
  loadDocumentSnapshot: service.loadDocumentSnapshot,
  snapshotKey,
};
