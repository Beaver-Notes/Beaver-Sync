'use strict';

// LISTEN/NOTIFY fan-out: pushes Postgres sync notifications to connected
// relay clients in the affected workspace. Receives the relay's room map and
// text sender rather than reaching into relay module state.

async function startSyncNotificationListener(rooms, sendText) {
  let pool;
  try {
    const postgres = require('./db/postgres');
    pool = postgres.getPool();
  } catch {
    console.warn('[ws-relay] Postgres pool unavailable — sync notifications disabled');
    return;
  }

  let client;
  let reconnectAttempts = 0;
  const MAX_DELAY = 30_000;

  async function listen() {
    if (client) return;
    try {
      client = await pool.connect();
      await client.query('LISTEN sync_notifications');
      reconnectAttempts = 0;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[ws-relay] Listening for sync notifications on Postgres');
      }

      client.on('notification', (msg) => {
        try {
          const { workspaceId, noteIds, excludeDeviceId } = JSON.parse(msg.payload);
          if (!workspaceId) return;

          let notified = 0;
          for (const [, room] of rooms) {
            for (const conn of room.conns) {
              const ctx = conn.ctx;
              if (ctx.workspaceId !== workspaceId) continue;
              if (excludeDeviceId && ctx.deviceId === excludeDeviceId) continue;
              sendText(conn.ws, {
                type: 'notification',
                noteIds,
                timestamp: Date.now(),
              });
              notified++;
            }
          }
          if (notified > 0 && process.env.NODE_ENV !== 'production') {
            console.log(`[ws-relay] Notified ${notified} client(s) in workspace ${workspaceId} about ${noteIds.length} note(s)`);
          }
        } catch (err) {
          console.warn('[ws-relay] Failed to process sync notification:', err.message);
        }
      });

      const teardown = () => {
        if (client) {
          client.release(true);
          client = null;
        }
        scheduleReconnect();
      };
      client.on('error', teardown);
      client.on('end', teardown);
    } catch (err) {
      console.warn('[ws-relay] Failed to start sync notification listener:', err.message);
      if (client) { client.release(true); client = null; }
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    const delay = Math.min(5000 * 2 ** reconnectAttempts, MAX_DELAY);
    reconnectAttempts++;
    setTimeout(() => { listen().catch((err) => console.warn('[ws-relay] reconnect failed:', err?.message)); }, delay);
  }

  await listen();
}

module.exports = { startSyncNotificationListener };
