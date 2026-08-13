'use strict';

const { Server } = require('@hocuspocus/server');
const { relayStoredUpdates } = require('./lib/relay');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const HOCUSPOCUS_PORT = parseInt(process.env.HOCUSPOCUS_PORT ?? '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const YJS_PERSISTENCE_ENABLED = process.env.YJS_PERSISTENCE_ENABLED !== 'false';

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

const persistence = YJS_PERSISTENCE_ENABLED
  ? require('./persistence/yjs')
  : null;

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

      if (!persistence) return;

      const parsed = persistence.parseRoomName(documentName);
      if (!parsed) return;

      const { workspaceId, noteId } = parsed;

      try {
        // Plan history window: free collaborators get nothing older than now,
        // starter 30d, pro/team 365d, enterprise unlimited. `historyCutoffForAccount`
        // is membership-aware so a note collaborator who is not a workspace member
        // never inherits the org's window.
        const { historyCutoffForAccount } = require('./lib/plan-lifecycle');
        let cutoffTs = 0;
        if (context?.userId) {
          const resolved = await historyCutoffForAccount(context.userId, workspaceId);
          cutoffTs = resolved.cutoffTs || 0;
        }

        await relayStoredUpdates({
          connection,
          persistence,
          workspaceId,
          noteId,
          cutoffTs,
          log: (msg) => console.log(`[hocuspocus] ${msg}`),
        });
      } catch (err) {
        console.warn(
          `[hocuspocus] Failed to relay stored updates for ${documentName}:`,
          err.message,
        );
      }
    },

    async onLoadDocument() {
      // Server never reconstructs documents — updates are opaque and relayed
      // to new joiners via the connected hook. No-op by design.
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
          true,
        );
      } catch (err) {
        console.warn(
          `[hocuspocus] Failed to persist update for ${documentName}:`,
          err.message,
        );
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
