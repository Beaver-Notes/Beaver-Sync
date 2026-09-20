'use strict';

const { query, transaction } = require('../db');

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

// Add-only fan-out for late joiners / newly-linked devices: never overwrites an
// existing envelope, so it can re-wrap for a recipient that lacks a key without
// rotating (splitting) the note's existing key. Returns the number inserted.
async function addRecipientsIfAbsent(noteId, recipients) {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const r of recipients) {
    const { rowCount } = await query(
      `INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(note_id, user_id, device_id) DO NOTHING`,
      [noteId, r.userId, r.deviceId || 'default', r.wrappedKey, now]
    );
    inserted += rowCount;
  }
  return inserted;
}

// L8: replace every envelope for a note with a fresh set wrapped under a new
// key generation. Atomic (delete + insert in one transaction) and zero-
// knowledge: the server only ever sees opaque wrapped strings and never a note
// key. The generation is recorded so pre-rotation envelopes cannot be replayed
// as current. Returns the stored count and the new generation.
async function rotateNoteKey(noteId, recipients) {
  const now = new Date().toISOString();
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM note_keys WHERE note_id = $1',
      [noteId]
    );
    const generation = Number(rows[0]?.next ?? 1);
    await client.query('DELETE FROM note_keys WHERE note_id = $1', [noteId]);
    for (const r of recipients) {
      await client.query(
        `INSERT INTO note_keys (note_id, user_id, device_id, wrapped_key, generation, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [noteId, r.userId, r.deviceId || 'default', r.wrappedKey, generation, now]
      );
    }
    return { stored: recipients.length, generation };
  });
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
  addRecipientsIfAbsent,
  rotateNoteKey,
  noteHasAnyKey,
  getEnvelopesForUser,
  createKeyDistributionRequest,
  listKeyDistributionRequests,
  deleteKeyDistributionRequest,
};
