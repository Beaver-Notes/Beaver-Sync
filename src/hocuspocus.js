'use strict';

const { Server } = require('@hocuspocus/server');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const HOCUSPOCUS_PORT = parseInt(process.env.HOCUSPOCUS_PORT ?? '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

/**
 * Start a Postgres LISTEN client that receives sync notifications from the
 * Fastify push-batch route and broadcasts them as stateless JSON messages
 * to all Hocuspocus connections in the matching workspace.
 *
 * This is how Device B learns about Device A's pushes without waiting for
 * the 30-second pull timer.  The notification payload is:
 *   { workspaceId, noteIds, excludeDeviceId }
 *
 * Connections whose context.workspaceId matches AND whose deviceId differs
 * from excludeDeviceId receive a stateless message:
 *   { type: 'notification', noteIds, timestamp }
 *
 * The client then triggers an immediate HTTP pull to fetch the encrypted
 * updates from yjs_doc_updates.
 */
async function startSyncNotificationListener(server) {
  let pool;
  try {
    // The db/postgres module may not be loaded yet in standalone Hocuspocus
    // mode.  Lazy-require so the module is optional.
    const postgres = require('./db/postgres');
    pool = postgres.getPool();
  } catch {
    console.warn('[hocuspocus] Postgres pool unavailable — sync notifications disabled');
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
      console.log('[hocuspocus] Listening for sync notifications on Postgres');

      client.on('notification', (msg) => {
        try {
          const { workspaceId, noteIds, excludeDeviceId } = JSON.parse(msg.payload);
          if (!workspaceId) return;

          let notified = 0;
          // server.connections is a Map<string, Connection[]> keyed by documentName.
          // Each connection has a context.workspaceId set by onAuthenticate.
          for (const [, connections] of server.connections) {
            for (const conn of connections) {
              const ctx = conn.context ?? {};
              if (ctx.workspaceId !== workspaceId) continue;
              // Don't notify the device that just pushed — they already know.
              if (excludeDeviceId && ctx.deviceId === excludeDeviceId) continue;
              try {
                conn.sendStateless(JSON.stringify({
                  type: 'notification',
                  noteIds,
                  timestamp: Date.now(),
                }));
                notified++;
              } catch {
                // client may have disconnected between notification dispatch
              }
            }
          }
          if (notified > 0) {
            console.log(`[hocuspocus] Notified ${notified} client(s) in workspace ${workspaceId} about ${noteIds.length} note(s)`);
          }
        } catch (err) {
          console.warn('[hocuspocus] Failed to process sync notification:', err.message);
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
      console.warn('[hocuspocus] Failed to start sync notification listener:', err.message);
      if (client) { client.release(true); client = null; }
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    const delay = Math.min(5000 * 2 ** reconnectAttempts, MAX_DELAY);
    reconnectAttempts++;
    setTimeout(() => { listen().catch(() => {}); }, delay);
  }

  await listen();
}

async function startHocuspocus() {
  const { initErrorMonitoring } = require('./lib/error-monitoring');
  initErrorMonitoring(process.env.GLITCHTIP_DSN ?? process.env.HOCUSPOCUS_GLITCHTIP_DSN);

  const server = new Server({
    port: HOCUSPOCUS_PORT,

    async onAuthenticate({ token, documentName, connection }) {
      if (!token || typeof token !== 'string') {
        throw new Error('Missing session token');
      }

      const match = ROOM_PATTERN.exec(documentName);
      if (!match) {
        throw new Error('Invalid room name format');
      }

      const workspaceId = match[1];
      const noteId = match[2];

      const headers = { 'Content-Type': 'application/json' };
      if (INTERNAL_API_SECRET) {
        headers['X-Internal-Secret'] = INTERNAL_API_SECRET;
      }

      // /auth/verify-session validates membership when workspaceId is provided (returns role)
      const body = { token, workspaceId };
      if (noteId) body.noteId = noteId;

      const response = await fetch(`${AUTH_BACKEND_URL}/auth/verify-session`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 403) {
        throw new Error('Not a member of this workspace');
      }

      if (!response.ok) {
        throw new Error('Invalid or expired session token');
      }

      const { userId, role } = await response.json();

      const readOnly = role === 'viewer' || role === 'guest';
      if (readOnly) {
        connection.readOnly = true;
      }

      return { userId, workspaceId, noteId, role, readOnly };
    },

    async connected({ documentName, connection, context }) {
      const role = context?.role || 'editor';
      const readOnly = connection.readOnly || false;
      try {
        connection.sendStateless(JSON.stringify({ type: 'auth', readOnly, role }));
      } catch {
        // client may have disconnected before we could send
      }

      // Catch-up is handled by the HTTP sync engine (pull-batch), which
      // returns sync-key-encrypted envelopes from yjs_doc_updates.  We
      // intentionally do NOT relay stored updates here because the stored
      // data may be in a different encryption format than what the client
      // expects.  The client pulls via HTTP after connecting.
    },

    async onLoadDocument() {
      // No-op: the server never reconstructs documents.  Catch-up is
      // handled by the HTTP sync engine (pull-batch), and real-time
      // relay is handled by Hocuspocus broadcasting to connected clients.
    },

    async onChange({ document: _document, documentName, update, connection }) {
      // We do NOT persist raw Yjs updates from Hocuspocus.  Persistence
      // is handled exclusively by the HTTP sync engine (push-batch).
      //
      // Hocuspocus already relays updates to other clients IN THE SAME
      // NOTE ROOM.  But clients viewing different notes in the same
      // workspace won't receive the update.  Notify them so they can
      // pull the change via HTTP when they open that note later.
      const match = ROOM_PATTERN.exec(documentName);
      if (!match) return;
      const [, workspaceId, noteId] = match;

      try {
        for (const [, connections] of server.connections) {
          for (const conn of connections) {
            const ctx = conn.context ?? {};
            if (ctx.workspaceId !== workspaceId) continue;
            if (ctx.noteId === noteId) continue; // same room — already getting relay
            try {
              conn.sendStateless(JSON.stringify({
                type: 'notification',
                noteIds: [noteId],
                timestamp: Date.now(),
              }));
            } catch {
              // client may have disconnected
            }
          }
        }
      } catch {
        // iteration failure is non-fatal
      }
    },

    async onListen({ port }) {
      console.log(`Hocuspocus server listening on port ${port}`);
    },
  });

  await server.listen();

  // Start listening for sync notifications from the Fastify push-batch route.
  // This allows clients to be notified in real-time when other devices push
  // encrypted updates, triggering an immediate HTTP pull.
  await startSyncNotificationListener(server);

  return server;
}

module.exports = { startHocuspocus };

if (require.main === module) {
  startHocuspocus().catch((err) => {
    console.error('Fatal Hocuspocus startup error:', err);
    process.exit(1);
  });
}
