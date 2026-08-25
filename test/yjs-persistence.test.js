'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_HMAC_KEY = 'test-session-hmac-key-at-least-32-characters-long';
process.env.EMAIL_HMAC_KEY = 'test-email-hmac-key-at-least-32-characters-long';

const { close, query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
const persistence = require('../src/persistence/yjs');
const { summarizeStoredBatch } = require('../src/routes/yjs-sync');

async function seedWorkspace() {
  await query(`
    INSERT INTO accounts (id, email_hmac, created_at)
    VALUES ($1, $2, $3)
  `, ['account-1', 'email-hmac-1', new Date().toISOString()]);
  await query(`
    INSERT INTO workspaces (id, name_encrypted, owner_id, created_at)
    VALUES ($1, $2, $3, $4)
  `, ['ws-1', 'name', 'account-1', new Date().toISOString()]);
}

async function seedUpdates(workspaceId, noteId, count) {
  return persistence.storeUpdatesBatch(workspaceId, noteId, Array.from({ length: count }, (_, index) => ({
    deviceId: 'device-a',
    sequence: index + 1,
    data: Buffer.from(String(index + 1)),
    // Recent epoch-ms: pull cursors older than 24h are treated as stale.
    ts: Date.now() - 60_000 + index,
  })));
}

test.before(async () => {
  await setupTestDb();
  await cleanTestDb();
  await seedWorkspace();
});

test.after(async () => {
  await close();
});

test('accepts an update once and reports a replay as duplicate', async () => {
  const first = await persistence.storeUpdatesBatch('ws-1', 'note-1', [
    { deviceId: 'device-a', sequence: 7, data: Buffer.from('x'), ts: 10 },
  ]);
  const second = await persistence.storeUpdatesBatch('ws-1', 'note-1', [
    { deviceId: 'device-a', sequence: 7, data: Buffer.from('x'), ts: 10 },
  ]);

  assert.equal(first.accepted, 1);
  assert.equal(second.duplicate, 1);
  assert.deepEqual(first.checkpoint, { ts: 10, sequence: 7, deviceId: 'device-a' });
  assert.deepEqual(second.checkpoint, { ts: 10, sequence: 7, deviceId: 'device-a' });
  assert.equal(await persistence.getUpdateCount('ws-1', 'note-1'), 1);
});

test('returns continuation metadata when a pull is truncated', async () => {
  await seedUpdates('ws-1', 'note-2', 3);
  const page = await persistence.loadUpdatesAfter('ws-1', 'note-2', null, 2);

  assert.equal(page.updates.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.nextCheckpoint['device-a'].ts, 'number');
  assert.equal(typeof page.nextCheckpoint['device-a'].sequence, 'number');

  const secondPage = await persistence.loadUpdatesAfter('ws-1', 'note-2', page.nextCheckpoint, 2);
  assert.deepEqual(secondPage.updates.map((update) => update.sequence), [3]);
  assert.equal(secondPage.hasMore, false);
});

test('orders same-timestamp updates from different devices deterministically', async () => {
  const sharedTs = Date.now() - 60_000;
  await persistence.storeUpdatesBatch('ws-1', 'note-same-clock', [
    { deviceId: 'device-b', sequence: 1, data: Buffer.from('b'), ts: sharedTs },
    { deviceId: 'device-a', sequence: 1, data: Buffer.from('a'), ts: sharedTs },
  ]);

  const firstPage = await persistence.loadUpdatesAfter('ws-1', 'note-same-clock', null, 1);
  const secondPage = await persistence.loadUpdatesAfter('ws-1', 'note-same-clock', firstPage.nextCheckpoint, 1);
  assert.deepEqual(firstPage.updates.map((update) => update.deviceId), ['device-a']);
  assert.deepEqual(secondPage.updates.map((update) => update.deviceId), ['device-b']);
});

test('aggregates checkpoints across notes with the device tie-breaker', async () => {
  const result = await persistence.storeNotesBatch('ws-1', [
    { noteId: 'note-checkpoint-a', updates: [{ deviceId: 'device-a', sequence: 4, data: Buffer.from('a'), ts: 60 }] },
    { noteId: 'note-checkpoint-b', updates: [{ deviceId: 'device-b', sequence: 4, data: Buffer.from('b'), ts: 60 }] },
  ]);

  assert.deepEqual(result.checkpoint, { ts: 60, sequence: 4, deviceId: 'device-b' });
});

test('rejects persistence batches larger than the API limit', async () => {
  await assert.rejects(
    persistence.storeUpdatesBatch('ws-1', 'note-too-large', Array.from({ length: 201 }, (_, index) => ({
      deviceId: 'device-a', sequence: index + 1, data: Buffer.from('x'), ts: index,
    }))),
    /maximum batch size of 200/,
  );
  assert.equal(await persistence.getUpdateCount('ws-1', 'note-too-large'), 0);
});

test('accepts a batch at the API limit', async () => {
  const result = await persistence.storeUpdatesBatch('ws-1', 'note-at-limit', Array.from({ length: 200 }, (_, index) => ({
    deviceId: 'device-a', sequence: index + 1, data: Buffer.from('x'), ts: index,
  })));

  assert.equal(result.accepted, 200);
  assert.equal(result.duplicate, 0);
  assert.equal(await persistence.getUpdateCount('ws-1', 'note-at-limit'), 200);
});

test('reports accepted payload bytes for mixed new and replayed updates', async () => {
  const update = (sequence, data) => ({ deviceId: 'device-a', sequence, data: Buffer.from(data), ts: sequence });
  await persistence.storeUpdatesBatch('ws-1', 'note-accounting', [update(1, 'old')]);

  const result = await persistence.storeUpdatesBatch('ws-1', 'note-accounting', [
    update(1, 'old'),
    update(2, 'new-payload'),
  ]);

  assert.equal(result.accepted, 1);
  assert.equal(result.duplicate, 1);
  assert.equal(result.acceptedBytes, Buffer.byteLength('new-payload'));
});

test('route accounting uses accepted persistence results', () => {
  const stats = summarizeStoredBatch(
    { accepted: 1, duplicate: 1, acceptedBytes: 3 },
  );

  assert.deepEqual(stats, { stored: 1, sizeBytes: 3 });
});
