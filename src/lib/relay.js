'use strict';

const { OutgoingMessage } = require('@hocuspocus/server');

/**
 * Relay stored (opaque, client-encrypted) updates to a freshly connected
 * real-time client as Yjs sync-update messages. The server never decrypts:
 * it only forwards the stored bytes, and the client decrypts on receipt.
 *
 * Returns the number of updates sent.
 */
async function relayStoredUpdates({ connection, persistence, workspaceId, noteId, log = console }) {
  const updates = await persistence.loadAllUpdates(workspaceId, noteId);

  let relayed = 0;
  for (const update of updates) {
    if (!update.data) continue;
    const bytes = update.data instanceof Uint8Array
      ? update.data
      : new Uint8Array(update.data);
    const msg = new OutgoingMessage(connection.messageAddress)
      .createSyncMessage()
      .writeUpdate(bytes)
      .toUint8Array();
    connection.send(msg);
    relayed += 1;
  }

  if (relayed > 0) {
    log(`Relayed ${relayed} encrypted update(s) to new joiner for ${connection.messageAddress}`);
  }

  return relayed;
}

module.exports = { relayStoredUpdates };
