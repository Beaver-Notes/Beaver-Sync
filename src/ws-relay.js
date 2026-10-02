'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

process.on('uncaughtException', (err) => {
  console.error('[ws-relay][fatal] uncaughtException', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ws-relay][fatal] unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason });
});
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const { createPostgresPersistence } = require('./db/yjs-persistence');
const { verifySession, verifyTicket } = require('./ws-relay-auth');
const { MSG_SYNC, MSG_AWARENESS, handleSyncMessage, handleAwarenessMessage } = require('./ws-relay-protocol');
const { startSyncNotificationListener, stopSyncNotificationListener } = require('./ws-relay-notifications');

const WS_RELAY_PORT = parseInt(process.env.WS_RELAY_PORT ?? '8080', 10);
let redisRelay = null;

const { parseRoomName: baseParseRoomName } = require('./persistence/yjs');

function parseRoomName(documentName) {
  const base = baseParseRoomName(documentName);
  if (!base) return null;
  return base.noteId != null
    ? { kind: 'note', workspaceId: base.workspaceId, noteId: base.noteId }
    : { kind: 'meta', workspaceId: base.workspaceId, noteId: null };
}

let persistence = null;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Set<{ ws: import('ws').WebSocket, ctx: object }>, persistenceDirty: boolean }>} */
const rooms = new Map();

function getOrCreateRoom(documentName) {
  if (rooms.has(documentName)) return rooms.get(documentName);

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  /** @type {Set<{ ws: import('ws').WebSocket, ctx: object }>} */
  const conns = new Set();
  const room = { doc, awareness, conns };
  rooms.set(documentName, room);

  doc.on('update', (update, origin) => {
    if (origin === 'persistence') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    broadcastToRoom(documentName, msg, null);
  });

  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'persistence') return;
    const changedClients = added.concat(updated).concat(removed);
    if (changedClients.length === 0) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    broadcastToRoom(documentName, msg, null);
  });

  if (persistence) {
    persistence.bindState(documentName, doc);
  }

  return room;
}

const persistTimers = new Map();

/** @type {WeakMap<import('ws').WebSocket, Set<number>>} */
const wsToClientIds = new Map();

function schedulePersist(documentName) {
  if (persistTimers.has(documentName)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(documentName);
    const room = rooms.get(documentName);
    if (room && persistence) {
      persistence.writeState(documentName, room.doc).catch((err) => {
        console.warn(`[ws-relay] persist failed for ${documentName}, retrying:`, err?.message);
        schedulePersist(documentName);
      });
    }
  }, 1000);
  persistTimers.set(documentName, timer);
}

function broadcastToRoom(documentName, msg, excludeWs, fromRelay = false) {
  const room = rooms.get(documentName);
  if (!room) return;
  for (const conn of room.conns) {
    if (conn.ws === excludeWs) continue;
    if (conn.ws.readyState === 1) {
      try { conn.ws.send(msg); } catch { /* ignore */ }
    }
  }
  // A message that arrived over Redis already went to every replica. Publishing it
  // again re-stamps origin with this instance's id, so the self-filter in
  // ws-relay-redis.js never matches and the fan-out loops until the stack overflows.
  if (!fromRelay) {
    try { redisRelay?.publish(documentName, msg); } catch {}
  }
}

function sendText(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const ticket = url.searchParams.get('ticket');
  const documentName = url.pathname.replace(/^\//, '');

  // Avoid logging tokens (even truncated) and noisy per-upgrade logs in prod.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[ws-relay] upgrade request: ${documentName}`);
  }

  if (!token && !ticket) {
    console.warn('[ws-relay] upgrade rejected: no token');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const room = parseRoomName(documentName);
  if (!room) {
    console.warn(`[ws-relay] upgrade rejected: bad room name "${documentName}"`);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const workspaceId = room.workspaceId;
  const authPromise = ticket
    ? verifyTicket(ticket)
    : verifySession(token, workspaceId, room.noteId);
  authPromise
    .then((auth) => {
      const userId = auth.userId;
      // The ticket is redeemable for exactly one room; a role is always present
      // because ws-ticket now requires a workspaceId and resolveAuthRole either
      // returns a role or 403s.
      if (ticket) {
        if (auth.workspaceId !== room.workspaceId || (auth.noteId ?? null) !== room.noteId) {
          throw new Error('Ticket is not valid for this room');
        }
      }
      const role = auth.role ?? 'editor';
      const deviceId = auth.deviceId ?? null;
      const readOnly = role === 'viewer' || role === 'guest';
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[ws-relay] upgrade accepted: ${documentName} user=${userId} role=${role}${deviceId ? ` deviceId=${deviceId}` : ''}`);
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        const ctx = {
          userId,
          workspaceId,
          noteId: room.noteId,
          role,
          readOnly,
          deviceId,
          clientId: Math.random().toString(36).slice(2),
        };
        ws._wsCtx = ctx;
        ws._wsDocumentName = documentName;

        wss.emit('connection', ws, req);
        handleConnection(ws, documentName, ctx);
      });
    })
    .catch((err) => {
      console.warn(`[ws-relay] Auth failed for ${documentName}: ${err.message}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    });
}

function handleConnection(ws, documentName, ctx) {
  const room = getOrCreateRoom(documentName);
  const conn = { ws, ctx };

  room.conns.add(conn);

  sendText(ws, { type: 'auth', readOnly: ctx.readOnly, role: ctx.role });

  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const clients = Array.from(awarenessStates.keys());
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients, awarenessStates);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    try { ws.send(encoding.toUint8Array(encoder)); } catch { /* ignore */ }
  }

  ws.on('message', (rawData) => {
    try {
      const data = new Uint8Array(rawData);
      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MSG_SYNC:
          handleSyncMessage(decoder, room, conn, documentName, schedulePersist);
          break;
        case MSG_AWARENESS:
          handleAwarenessMessage(decoder, room, conn, wsToClientIds);
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('[ws-relay] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    room.conns.delete(conn);

    const clientIds = wsToClientIds.get(ws);
    if (clientIds && clientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(clientIds), null);
    }
    wsToClientIds.delete(ws);

    if (room.conns.size === 0) {
      schedulePersist(documentName);
      // Don't destroy doc immediately — keep for persistence
      const t = setTimeout(() => {
        const current = rooms.get(documentName);
        if (current && current.conns.size === 0) {
          current.awareness.destroy();
          current.doc.destroy();
          rooms.delete(documentName);
        }
      }, 30_000);
      if (t.unref) t.unref();
    }
  });
}

let wss;
let _httpServer;
let _heartbeatInterval;

async function startWsRelay() {
  const postgres = require('./db/postgres');
  persistence = createPostgresPersistence(postgres.getPool());

  const { initErrorMonitoring } = require('./lib/error-monitoring');
  initErrorMonitoring(process.env.GLITCHTIP_DSN ?? process.env.WS_RELAY_GLITCHTIP_DSN);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  });

  wss = new WebSocketServer({ noServer: true });
  _httpServer = server;
  _heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);
  if (_heartbeatInterval.unref) _heartbeatInterval.unref();

  server.listen(WS_RELAY_PORT, () => {
    console.log(`[ws-relay] listening on port ${WS_RELAY_PORT}`);
  });
  if (server.unref) server.unref();

  server.on('upgrade', handleUpgrade);

  wss.on('close', () => {
    clearInterval(_heartbeatInterval);
    try { stopSyncNotificationListener(); } catch {}
  });

  await startSyncNotificationListener(rooms, sendText);
  try {
    const { init } = require('./ws-relay-redis');
    redisRelay = init(rooms, broadcastToRoom);
  } catch {}

  // Graceful shutdown: flush debounced persists (<=1s of edits per room) before exit
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ws-relay] Received ${signal} — flushing persists`);
    try { clearInterval(_heartbeatInterval); } catch {}
    try { await redisRelay?.close(); } catch {}
    // Flush every pending debounce timer immediately
    for (const timer of persistTimers.values()) clearTimeout(timer);
    persistTimers.clear();
    const flushes = [];
    for (const [documentName, room] of rooms) {
      if (persistence && room?.doc) {
        flushes.push(
          persistence.writeState(documentName, room.doc).catch((err) =>
            console.warn(`[ws-relay] Final persist failed for ${documentName}:`, err?.message)
          )
        );
      }
    }
    await Promise.allSettled(flushes);
    try { wss.close(); } catch {}
    try { server.close(); } catch {}
    try {
      const postgres = require('./db/postgres');
      await postgres.close?.();
    } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return wss;
}

async function stopWsRelay() {
  try { clearInterval(_heartbeatInterval); } catch {}
  try { await redisRelay?.close(); } catch {}
  redisRelay = null;
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  try { stopSyncNotificationListener(); } catch {}
  try { wss?.clients?.forEach((c) => { try { c.terminate(); } catch {} }); } catch {}
  try { wss?.close(); } catch {}
  try { await new Promise((res) => _httpServer ? _httpServer.close(res) : res()); } catch {}
  _httpServer = null;
  // destroy all room docs immediately so no 30s timer remains
  for (const [, room] of rooms) {
    try { room.awareness.destroy(); } catch {}
    try { room.doc.destroy(); } catch {}
  }
  rooms.clear();
  for (const c of wsToClientIds.keys()) wsToClientIds.delete(c);
  wss = null;
}

module.exports = { startWsRelay, stopWsRelay, parseRoomName };

if (require.main === module) {
  startWsRelay().catch((err) => {
    console.error('Fatal ws-relay startup error:', err);
    process.exit(1);
  });
}
