'use strict';

// y-websocket wire-protocol message handlers for the relay.
// Callers pass their own persistence scheduler / client-id tracking so this
// module stays free of relay-wide mutable state.

const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

// y-websocket message types
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

function handleSyncMessage(decoder, room, conn, documentName, schedulePersist) {
  const syncMessageType = decoding.readVarUint(decoder);

  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1: {
      // Client sends its state vector; reply with sync step 2 (the diff)
      const sv = decoding.readVarUint8Array(decoder);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep2(encoder, room.doc, sv);
      try { conn.ws.send(encoding.toUint8Array(encoder)); } catch { /* ignore */ }

      // Also send our own sync step 1 so the client can send us its diff
      const svEncoder = encoding.createEncoder();
      encoding.writeVarUint(svEncoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(svEncoder, room.doc);
      try { conn.ws.send(encoding.toUint8Array(svEncoder)); } catch { /* ignore */ }
      break;
    }
    case syncProtocol.messageYjsSyncStep2: {
      if (conn.ctx.readOnly) break;
      syncProtocol.readSyncStep2(decoder, room.doc, 'remote');
      schedulePersist(documentName);
      break;
    }
    case syncProtocol.messageYjsUpdate: {
      if (conn.ctx.readOnly) break;
      syncProtocol.readUpdate(decoder, room.doc, 'remote');
      schedulePersist(documentName);
      break;
    }
  }
}

function handleAwarenessMessage(decoder, room, conn, wsToClientIds) {
  const update = decoding.readVarUint8Array(decoder);

  // Track which awareness client IDs belong to this connection
  const updateDecoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(updateDecoder);
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(updateDecoder);
    decoding.readVarUint(updateDecoder); // clock
    decoding.readVarString(updateDecoder); // state JSON
    if (!wsToClientIds.has(conn.ws)) wsToClientIds.set(conn.ws, new Set());
    wsToClientIds.get(conn.ws).add(clientID);
  }

  awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn);
}

module.exports = { MSG_SYNC, MSG_AWARENESS, handleSyncMessage, handleAwarenessMessage };
