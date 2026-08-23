'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

const { createPostgresPersistence } = require('./db/yjs-persistence');

const AUTH_BACKEND_URL = process.env.AUTH_BACKEND_URL ?? 'https://beaver-sync.internal:3000';
const WS_RELAY_PORT = parseInt(process.env.WS_RELAY_PORT ?? '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const ROOM_PATTERN = /^workspace:([a-zA-Z0-9_-]+):note:([a-zA-Z0-9_-]+)$/;
const META_ROOM_PATTERN = /^workspace:([a-zA-Z0-9_-]+):meta$/;

// y-websocket message types
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

function parseRoomName(documentName) {
  const noteMatch = ROOM_PATTERN.exec(documentName);
  if (noteMatch) {
    return { kind: 'note', workspaceId: noteMatch[1], noteId: noteMatch[2] };
  }
  const metaMatch = META_ROOM_PATTERN.exec(documentName);
  if (metaMatch) {
    return { kind: 'meta', workspaceId: metaMatch[1], noteId: null };
  }
  return null;
}

let persistence = null;

// --- Per-room state ---

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

  // Broadcast doc updates to other connections in the room
  doc.on('update', (update, origin) => {
    if (origin === 'persistence') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    broadcastToRoom(documentName, msg, null);
  });

  // Broadcast awareness changes to other connections in the room
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

  // Load persisted state from Postgres via adapter
  if (persistence) {
    persistence.bindState(documentName, doc);
  }

  return room;
}

// Debounced persistence per room
const persistTimers = new Map();

/** @type {WeakMap<import('ws').WebSocket, Set<number>>} */
const wsToClientIds = new Map();

function schedulePersist(documentName) {
  if (persistTimers.has(documentName)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(documentName);
    const room = rooms.get(documentName);
    if (room && persistence) {
      persistence.writeState(documentName, room.doc);
    }
  }, 1000);
  persistTimers.set(documentName, timer);
}

function broadcastToRoom(documentName, msg, excludeWs) {
  const room = rooms.get(documentName);
  if (!room) return;
  for (const conn of room.conns) {
    if (conn.ws === excludeWs) continue;
    if (conn.ws.readyState === 1) {
      try { conn.ws.send(msg); } catch { /* ignore */ }
    }
  }
}

function sendText(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

// --- Authentication ---

async function verifySession(token, workspaceId, noteId) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_API_SECRET) {
    headers['X-Internal-Secret'] = INTERNAL_API_SECRET;
  }
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

  return response.json();
}

// --- Connection handling ---

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const documentName = url.pathname.replace(/^\//, '');

  console.log(`[ws-relay] upgrade request: ${documentName} (token: ${token ? token.slice(0, 8) + '...' : 'MISSING'})`);

  if (!token) {
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

  // Authenticate before upgrading
  const workspaceId = room.workspaceId;
  verifySession(token, workspaceId, room.noteId)
    .then(({ userId, role }) => {
      const readOnly = role === 'viewer' || role === 'guest';
      console.log(`[ws-relay] upgrade accepted: ${documentName} user=${userId} role=${role}`);

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        const ctx = {
          userId,
          workspaceId,
          noteId: room.noteId,
          role,
          readOnly,
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

  // Send auth info
  sendText(ws, { type: 'auth', readOnly: ctx.readOnly, role: ctx.role });

  // Send full awareness state to new connection
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
          handleSyncMessage(decoder, room, conn, documentName);
          break;
        case MSG_AWARENESS:
          handleAwarenessMessage(decoder, room, conn);
          break;
        default:
          // ignore unknown message types
          break;
      }
    } catch (err) {
      console.warn('[ws-relay] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    room.conns.delete(conn);

    // Remove awareness state for disconnected client
    const clientIds = wsToClientIds.get(ws);
    if (clientIds && clientIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(clientIds), null);
    }
    wsToClientIds.delete(ws);

    // Cleanup empty rooms
    if (room.conns.size === 0) {
      schedulePersist(documentName);
      // Don't destroy doc immediately — keep for persistence
      setTimeout(() => {
        const current = rooms.get(documentName);
        if (current && current.conns.size === 0) {
          current.awareness.destroy();
          current.doc.destroy();
          rooms.delete(documentName);
        }
      }, 30_000);
    }
  });
}

function handleSyncMessage(decoder, room, conn, documentName) {
  const syncMessageType = decoding.readVarUint(decoder);

  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1: {
      // Client sends its state vector; reply with sync step 2 (the diff)
      const sv = decoding.readVarUint8Array(decoder);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep2(encoder, room.doc, sv);
      try { conn.ws.send(encoding.toUint8Array(encoder)); } catch { /* ignore */ }

      // Also send our own sync step 1 so the client can send us its diff
      const svEncoder = encoding.createEncoder();
      encoding.writeVarUint(svEncoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(svEncoder, room.doc);
      try { conn.ws.send(encoding.toUint8Array(svEncoder)); } catch { /* ignore */ }
      break;
    }
    case syncProtocol.messageYjsSyncStep2: {
      if (conn.ctx.readOnly) break;
      syncProtocol.readSyncStep2(decoder, room.doc, 'remote');
      schedulePersist(documentName);
      break;
    }
    case syncProtocol.messageYjsUpdate: {
      if (conn.ctx.readOnly) break;
      syncProtocol.readUpdate(decoder, room.doc, 'remote');
      schedulePersist(documentName);
      break;
    }
  }
}

function handleAwarenessMessage(decoder, room, conn) {
  const update = decoding.readVarUint8Array(decoder);

  // Track which awareness client IDs belong to this connection
  const updateDecoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(updateDecoder);
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(updateDecoder);
    decoding.readVarUint(updateDecoder); // clock
    decoding.readVarString(updateDecoder); // state JSON
    if (!wsToClientIds.has(conn.ws)) wsToClientIds.set(conn.ws, new Set());
    wsToClientIds.get(conn.ws).add(clientID);
  }

  awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn);
}

// --- LISTEN/NOTIFY sync notifications ---

async function startSyncNotificationListener() {
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
    setTimeout(() => { listen().catch(() => {}); }, delay);
  }

  await listen();
}

// --- Server startup ---

let wss;

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

  server.listen(WS_RELAY_PORT, () => {
    console.log(`[ws-relay] listening on port ${WS_RELAY_PORT}`);
  });

  server.on('upgrade', handleUpgrade);

  // Heartbeat to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  await startSyncNotificationListener();

  return wss;
}

module.exports = { startWsRelay, parseRoomName };

if (require.main === module) {
  startWsRelay().catch((err) => {
    console.error('Fatal ws-relay startup error:', err);
    process.exit(1);
  });
}
