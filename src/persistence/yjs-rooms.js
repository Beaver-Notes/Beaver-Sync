'use strict';

const crypto = require('crypto');

// Room-name parsing and update-identity/checkpoint helpers shared by the
// persistence write path and consumers like ws-relay.

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9_-]+):note:([a-zA-Z0-9_-]+)$/;
const META_ROOM_PATTERN = /^workspace:([a-zA-Z0-9_-]+):meta$/;
const UPDATE_IDENTITY_SEP = '\u0000';

function identityOf(noteId, deviceId, clock) {
  return `${noteId}${UPDATE_IDENTITY_SEP}${deviceId}${UPDATE_IDENTITY_SEP}${clock}`;
}

function parseRoomName(documentName) {
  const noteMatch = ROOM_PATTERN.exec(documentName);
  if (noteMatch) {
    return { workspaceId: noteMatch[1], noteId: noteMatch[2] };
  }
  const metaMatch = META_ROOM_PATTERN.exec(documentName);
  if (metaMatch) {
    return { workspaceId: metaMatch[1], noteId: null };
  }
  return null;
}

function generateUpdateId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function compareCheckpoints(a, b) {
  return a.ts - b.ts || a.sequence - b.sequence || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
}

function checkpointForRows(rows) {
  return rows
    .map((row) => ({ ts: row.ts, sequence: row.clock, deviceId: row.device_id }))
    .sort(compareCheckpoints)
    .at(-1) ?? null;
}

module.exports = {
  identityOf,
  parseRoomName,
  generateUpdateId,
  compareCheckpoints,
  checkpointForRows,
};
