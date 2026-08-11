'use strict';

const { validateSession } = require('../middleware/auth');
const { WorkspaceMember } = require('../models');
const { subscribe, publish } = require('../lib/events');

async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url, `http://${host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    try {
      const session = await validateSession(token);

      if (!session) {
        socket.close(4002, 'Invalid token');
        return;
      }

      const memberships = await WorkspaceMember.find({ accountId: session.userId }).lean();
      const workspaceIds = memberships.map((m) => m.workspaceId);

      const unsubscribers = [];

      for (const workspaceId of workspaceIds) {
        const unsub = subscribe(`workspace:${workspaceId}`, (data) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify(data));
          }
        });
        unsubscribers.push(unsub);
      }

      const heartbeatInterval = setInterval(() => {
        if (socket.readyState === 1) {
          publish('presence', { userId: session.userId, status: 'online' });
        }
      }, 30000);

      socket.on('close', () => {
        clearInterval(heartbeatInterval);
        unsubscribers.forEach((unsub) => unsub());
        publish('presence', { userId: session.userId, status: 'offline' });
      });

      socket.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'heartbeat') {
            socket.send(JSON.stringify({ type: 'heartbeat_ack' }));
          }
        } catch {
          // Ignore invalid messages
        }
      });

      socket.send(JSON.stringify({ type: 'connected', userId: session.userId }));
    } catch {
      socket.close(4002, 'Invalid token');
    }
  });
}

module.exports = wsRoutes;
