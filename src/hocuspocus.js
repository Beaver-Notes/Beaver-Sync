'use strict';

const { Server } = require('@hocuspocus/server');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const HOCUSPOCUS_PORT = parseInt(process.env.HOCUSPOCUS_PORT ?? '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9-]+):note:([a-zA-Z0-9-]+)$/;

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
      // Intentionally a no-op: we do NOT persist raw Yjs updates from
      // Hocuspocus to yjs_doc_updates.  Persistence is handled exclusively
      // by the HTTP sync engine (push-batch), which stores sync-key-encrypted
      // envelopes.  This keeps the storage format uniform and ensures the
      // server never persists plaintext.
      //
      // Real-time relay still works: Hocuspocus broadcasts the update to
      // other connected clients in memory (server sees plaintext transiently
      // during relay but never writes it to disk).
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
