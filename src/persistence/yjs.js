'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const { YjsDocUpdate } = require('../models');

const MIN_UPDATE_INTERVAL_MS = 50;
const MAX_BATCH_SIZE = 100;

const roomPattern = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

function parseRoomName(documentName) {
  const match = roomPattern.exec(documentName);
  if (!match) return null;
  return { workspaceId: match[1], noteId: match[2] };
}

function generateUpdateId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

async function storeUpdate(workspaceId, noteId, updateData, deviceId, clock, encrypted = false) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateUpdateId(),
    workspaceId,
    noteId,
    Buffer.isBuffer(updateData) ? updateData : Buffer.from(updateData),
    encrypted ? 1 : 0,
    deviceId,
    clock,
    Date.now(),
    now,
  );
}

async function storeUpdatesBatch(workspaceId, noteId, updates) {
  if (!updates.length) return;

  const db = getDb();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = updates.slice(0, MAX_BATCH_SIZE).map((u, i) => [
    generateUpdateId(),
    workspaceId,
    noteId,
    Buffer.isBuffer(u.data) ? u.data : Buffer.from(u.data),
    u.encrypted ? 1 : 0,
    u.deviceId,
    u.clock,
    u.ts ?? Date.now(),
    now,
  ]);

  const stmt = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(...row);
    }
  });

  stmt(batch);
}

async function loadUpdatesSince(workspaceId, noteId, sinceTs) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND ts > ?
    ORDER BY ts ASC, clock ASC
  `).all(workspaceId, noteId, sinceTs);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function loadAllUpdates(workspaceId, noteId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT update_data, update_encrypted, device_id, clock, ts
    FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
    ORDER BY ts ASC, clock ASC
  `).all(workspaceId, noteId);

  return rows.map((row) => ({
    data: row.update_data,
    encrypted: row.update_encrypted === 1,
    deviceId: row.device_id,
    clock: row.clock,
    ts: row.ts,
  }));
}

async function deleteUpdatesBefore(workspaceId, noteId, beforeTs) {
  const db = getDb();
  db.prepare(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ? AND ts < ?
  `).run(workspaceId, noteId, beforeTs);
}

async function deleteUpdatesForNote(workspaceId, noteId) {
  const db = getDb();
  db.prepare(`
    DELETE FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
  `).run(workspaceId, noteId);
}

async function getUpdateCount(workspaceId, noteId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM yjs_doc_updates
    WHERE workspace_id = ? AND note_id = ?
  `).get(workspaceId, noteId);
  return row?.count ?? 0;
}

module.exports = {
  parseRoomName,
  storeUpdate,
  storeUpdatesBatch,
  loadUpdatesSince,
  loadAllUpdates,
  deleteUpdatesBefore,
  deleteUpdatesForNote,
  getUpdateCount,
};