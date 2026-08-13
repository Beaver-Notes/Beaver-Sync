'use strict';

const { OutgoingMessage } = require('@hocuspocus/server');

/**
 * Relay stored (opaque, client-encrypted) updates to a freshly connected
 * real-time client as Yjs sync-update messages. The server never decrypts:
 * it only forwards the stored bytes, and the client decrypts on receipt.
 *
 * `cutoffTs` is the plan history-window lower bound (epoch ms). Updates older
 * than the cutoff are not served to the joiner (free = now → nothing older
 * than now; starter 30d; pro/team 365d; enterprise unlimited → 0/omitted).
 * Pass 0 for no window.
 *
 * Returns the number of updates sent.
 */
async function relayStoredUpdates({ connection, persistence, workspaceId, noteId, cutoffTs = 0, log = console }) {
  const updates = await persistence.loadAllUpdates(workspaceId, noteId, cutoffTs);

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
