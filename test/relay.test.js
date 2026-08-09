'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutgoingMessage } = require('@hocuspocus/server');
const dec = require('lib0/decoding');

const { relayStoredUpdates } = require('../src/lib/relay');

const ROOM = 'workspace:ws-1:note:note-1';

function decodeSent(bytes) {
  const decoder = dec.createDecoder(bytes);
  return {
    documentName: dec.readVarString(decoder),
    messageType: dec.readVarUint(decoder),
    syncType: dec.readVarUint(decoder),
    payload: dec.readVarUint8Array(decoder),
  };
}

function fakeConnection() {
  const sent = [];
  return {
    messageAddress: ROOM,
    sent,
    send: (bytes) => sent.push(bytes),
  };
}

function fakePersistence(updates) {
  return {
    loadAllUpdates: async () => updates,
  };
}

test('OutgoingMessage is exported from @hocuspocus/server', () => {
  assert.equal(typeof OutgoingMessage, 'function');
});

test('relays every stored update as a Yjs sync-update message to the connection', async () => {
  const connection = fakeConnection();
  const bufferPayload = Uint8Array.from([1, 2, 3]);
  const typedPayload = Uint8Array.from([4, 5, 6, 7]);
  const updates = [
    { data: Buffer.from(bufferPayload) },
    { data: typedPayload },
  ];

  const relayed = await relayStoredUpdates({
    connection,
    persistence: fakePersistence(updates),
    workspaceId: 'ws-1',
    noteId: 'note-1',
    log: () => {},
  });

  assert.equal(relayed, 2);
  assert.equal(connection.sent.length, 2);

  const [first, second] = connection.sent;
  assert.equal(decodeSent(first).documentName, ROOM);
  assert.equal(decodeSent(first).messageType, 0); // MessageType.Sync
  assert.equal(decodeSent(first).syncType, 2); // messageYjsUpdate
  assert.deepEqual(Array.from(decodeSent(first).payload), [1, 2, 3]);
  assert.deepEqual(Array.from(decodeSent(second).payload), [4, 5, 6, 7]);
});

test('sends nothing and returns 0 when there are no stored updates', async () => {
  const connection = fakeConnection();

  const relayed = await relayStoredUpdates({
    connection,
    persistence: fakePersistence([]),
    workspaceId: 'ws-1',
    noteId: 'note-1',
    log: () => {},
  });

  assert.equal(relayed, 0);
  assert.equal(connection.sent.length, 0);
});

test('skips rows without data', async () => {
  const connection = fakeConnection();
  const updates = [
    { data: null },
    { data: Uint8Array.from([9, 9]) },
    { data: undefined },
  ];

  const relayed = await relayStoredUpdates({
    connection,
    persistence: fakePersistence(updates),
    workspaceId: 'ws-1',
    noteId: 'note-1',
    log: () => {},
  });

  assert.equal(relayed, 1);
  assert.equal(connection.sent.length, 1);
});

test('logs the relayed count via the provided log callback', async () => {
  const connection = fakeConnection();
  const calls = [];
  const relayed = await relayStoredUpdates({
    connection,
    persistence: fakePersistence([{ data: Uint8Array.from([1]) }]),
    workspaceId: 'ws-1',
    noteId: 'note-1',
    log: (msg) => calls.push(msg),
  });

  assert.equal(relayed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Relayed 1 encrypted update\(s\) to new joiner/);
});

test('does not log when there is nothing to relay', async () => {
  const connection = fakeConnection();
  const calls = [];
  await relayStoredUpdates({
    connection,
    persistence: fakePersistence([]),
    workspaceId: 'ws-1',
    noteId: 'note-1',
    log: (msg) => calls.push(msg),
  });

  assert.equal(calls.length, 0);
});
