'use strict';

const { Server } = require('@hocuspocus/server');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const HOCUSPOCUS_PORT = parseInt(process.env.HOCUSPOCUS_PORT ?? '8080', 10);

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9-]+):note:[a-zA-Z0-9-]+$/;

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

      const response = await fetch(`${AUTH_BACKEND_URL}/auth/verify-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      return { userId, workspaceId, role };
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
