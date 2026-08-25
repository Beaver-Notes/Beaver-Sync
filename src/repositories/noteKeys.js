'use strict';

const { query } = require('../db');

async function storeRecipients(noteId, recipients) {
  const now = new Date().toISOString();
  const rows = recipients.map((r) => [noteId, r.userId, r.deviceId || 'default', r.wrappedKey, now]);
  const placeholders = rows
    .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
    .join(', ');
  await query(
    `INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, created_at)
     VALUES ${placeholders}
     ON CONFLICT(note_id, user_id, device_id) DO UPDATE SET wrapped_key = excluded.wrapped_key`,
    rows.flat()
  );
}

async function noteHasAnyKey(noteId) {
  const { rowCount } = await query('SELECT 1 FROM note_keys WHERE note_id = $1 LIMIT 1', [noteId]);
  return rowCount > 0;
}

async function getEnvelopesForUser(noteId, userId) {
  return query(
    'SELECT device_id, wrapped_key FROM note_keys WHERE note_id = $1 AND user_id = $2',
    [noteId, userId]
  );
}

async function createKeyDistributionRequest({ noteId, userId, targetDeviceId }) {
  await query(
    `INSERT INTO key_distribution_requests (note_id, user_id, target_device_id, requested_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [noteId, userId, targetDeviceId, new Date().toISOString()]
  );
}

async function listKeyDistributionRequests(userId) {
  const { rows } = await query(
    'SELECT note_id, user_id, target_device_id, requested_at FROM key_distribution_requests WHERE user_id = $1',
    [userId]
  );
  return rows;
}

async function deleteKeyDistributionRequest({ noteId, userId, targetDeviceId }) {
  await query(
    'DELETE FROM key_distribution_requests WHERE note_id=$1 AND user_id=$2 AND target_device_id=$3',
    [noteId, userId, targetDeviceId]
  );
}

module.exports = {
  storeRecipients,
  noteHasAnyKey,
  getEnvelopesForUser,
  createKeyDistributionRequest,
  listKeyDistributionRequests,
  deleteKeyDistributionRequest,
};
