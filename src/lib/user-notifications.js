'use strict';

// Human-event notifications (a comment, a mention, a note shared with you) ride
// a per-user channel, unlike sync pings which fan out per workspace. Publishing
// is best-effort: a notification must never fail the request that caused it.

const USER_NOTIFICATION_CHANNEL = 'user_notifications';

async function publishUserNotification({ userId, kind, noteId = null, workspaceId = null, actorId = null, excludeDeviceId = null }) {
  if (!userId || !kind) return false;
  try {
    const pool = require('../db/postgres').getPool();
    await pool.query('SELECT pg_notify($1, $2)', [
      USER_NOTIFICATION_CHANNEL,
      JSON.stringify({ userId, kind, noteId, workspaceId, actorId, excludeDeviceId, timestamp: Date.now() }),
    ]);
    return true;
  } catch (err) {
    console.warn('[user-notifications] publish failed:', err.message);
    return false;
  }
}

module.exports = { publishUserNotification, USER_NOTIFICATION_CHANNEL };
