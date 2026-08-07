'use strict';

const { Server } = require('@hocuspocus/server');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const HOCUSPOCUS_PORT = parseInt(process.env.HOCUSPOCUS_PORT ?? '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const YJS_PERSISTENCE_ENABLED = process.env.YJS_PERSISTENCE_ENABLED !== 'false';

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

const persistence = YJS_PERSISTENCE_ENABLED
  ? require('./persistence/yjs')
  : null;
let r2 = null;
if (persistence) {
  try {
    r2 = require('./services/r2');
  } catch {
    // R2 not configured — snapshot writes will be skipped
  }
}
const snapshots = persistence && r2 ? require('./lib/sync-snapshots') : null;

async function startHocuspocus() {
  const { initErrorMonitoring } = require('./lib/error-monitoring');
  initErrorMonitoring(process.env.GLITCHTIP_DSN ?? process.env.HOCUSPOCUS_GLITCHTIP_DSN);

  // Run recovery job on startup — flush stale SQLite updates to R2
  if (persistence) {
    try {
      const { flushUnsyncedDocuments } = require('./lib/yjs-recovery');
      const result = await flushUnsyncedDocuments();
      if (result.flushed > 0) {
        console.log(`[hocuspocus] Recovery: flushed ${result.flushed} documents to R2`);
      }
    } catch (err) {
      console.warn('[hocuspocus] Recovery job failed:', err.message);
    }
  }

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
      const response = await fetch(`${AUTH_BACKEND_URL}/auth/verify-session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token, workspaceId }),
      });

      if (response.status === 403) {
        throw new Error('Not a member of this workspace');
      }

      if (!response.ok) {
        throw new Error('Invalid or expired session token');
      }

      const { userId, role } = await response.json();

      if (role === 'viewer' || role === 'guest') {
        connection.readOnly = true;
      }

      return { userId, workspaceId, noteId, role };
    },

    async onConfigure({ configuration }) {
      if (!persistence) return;

      // Flush full document state to R2 on session close
      configuration.extensions.push({
        async onStoreDocument({ document, documentName }) {
          if (!r2 || !snapshots) return;

          const parsed = persistence.parseRoomName(documentName);
          if (!parsed) return;

          const { workspaceId, noteId } = parsed;

          try {
            const state = document.toBinary();
            const current = await persistence.getDocumentSyncState(workspaceId, noteId);
            await snapshots.writeDocumentSnapshot({
              workspaceId,
              noteId,
              generation: (current?.snapshotGeneration ?? 0) + 1,
              state,
            });
          } catch (err) {
            console.warn(
              `[hocuspocus] Failed to flush snapshot to R2 for ${documentName}:`,
              err.message,
            );
          }
        },
      });
    },

    async onLoadDocument({ document, documentName }) {
      if (!persistence) return;

      const parsed = persistence.parseRoomName(documentName);
      if (!parsed) return;

      const { workspaceId, noteId } = parsed;

      // Check the currently advertised versioned snapshot first.
      if (snapshots) {
        try {
          const snapshot = await snapshots.loadDocumentSnapshot(workspaceId, noteId);
          if (snapshot) {
            document.applyUpdate(new Uint8Array(snapshot));
          }
        } catch (err) {
          console.warn(
            `[hocuspocus] Failed to load snapshot from R2 for ${documentName}:`,
            err.message,
          );
        }
      }

      // Fall back to SQLite incremental updates
      const updates = await persistence.loadAllUpdates(workspaceId, noteId);

      for (const update of updates) {
        if (update.encrypted) continue;
        try {
          const data = update.data instanceof Uint8Array
            ? update.data
            : new Uint8Array(update.data);
          document.applyUpdate(data);
        } catch (err) {
          console.warn(
            `[hocuspocus] Failed to apply persisted update for ${documentName}:`,
            err.message,
          );
        }
      }
    },

    async onChange({ document: _document, documentName, update, connection }) {
      if (!persistence) return;

      const parsed = persistence.parseRoomName(documentName);
      if (!parsed) return;

      const { workspaceId, noteId } = parsed;
      const context = connection?.context ?? {};
      const userId = context.userId ?? 'unknown';

      try {
        await persistence.storeUpdate(
          workspaceId,
          noteId,
          update instanceof Uint8Array ? update : new Uint8Array(update),
          connection?.socketId ?? userId,
          Date.now(),
          false,
        );
      } catch (err) {
        console.warn(
          `[hocuspocus] Failed to persist update for ${documentName}:`,
          err.message,
        );
      }
    },

    async afterStoreDocument({ document: _document, documentName }) {
      if (!persistence) return;

      const parsed = persistence.parseRoomName(documentName);
      if (!parsed) return;

      const { workspaceId, noteId } = parsed;
      const count = await persistence.getUpdateCount(workspaceId, noteId);

      const COMPACTION_THRESHOLD = parseInt(
        process.env.YJS_COMPACTION_THRESHOLD ?? '500',
        10,
      );

      if (count > COMPACTION_THRESHOLD) {
        if (!snapshots) {
          console.warn(`[hocuspocus] Skipping compaction for ${documentName}: R2 snapshot service is unavailable`);
          return;
        }
        try {
          await snapshots.recoverDocument(workspaceId, noteId);
        } catch (err) {
          console.warn(
            `[hocuspocus] Compaction failed for ${documentName}:`,
            err.message,
          );
        }
      }
    },

    async onListen({ port }) {
      console.log(`Hocuspocus server listening on port ${port}`);
    },
  });

  await server.listen();
  return server;
}

module.exports = { startHocuspocus };

if (require.main === module) {
  startHocuspocus().catch((err) => {
    console.error('Fatal Hocuspocus startup error:', err);
    process.exit(1);
  });
}
