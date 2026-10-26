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
// The relay is a pure authenticated message bus. Client Yjs frames arrive
// end-to-end encrypted (MAGIC || IV || AES-256-GCM) and are undecryptable here
// by design, so bytes are forwarded verbatim and never parsed or persisted.
// Durability comes exclusively from the HTTPS sync route (routes/yjs-sync.js).

const { verifySession, verifyTicket } = require('./ws-relay-auth');
const { startSyncNotificationListener, stopSyncNotificationListener } = require('./ws-relay-notifications');

const WS_RELAY_PORT = parseInt(process.env.WS_RELAY_PORT ?? '8080', 10);
let redisRelay = null;

// encrypted-websocket.js: MAGIC(2) || IV(12) || AES-256-GCM
const ENCRYPTED_FRAME_MAGIC = [0xe7, 0x11];

function isEncryptedFrame(buf) {
  return buf.length >= 2 && buf[0] === ENCRYPTED_FRAME_MAGIC[0] && buf[1] === ENCRYPTED_FRAME_MAGIC[1];
}

// The relay holds no room key, so it cannot tell a Yjs sync frame from an
// awareness frame: AES-GCM hides the plaintext type byte. It therefore trusts
// the client's out-of-band kind declaration ({ type: 'frame', kind: 'sync' |
// 'awareness' }) sent just before the encrypted frame. A determined client can
// lie about the kind, so this is defence in depth layered on the sync route's
// server-side refusal, never the only control.
const FRAME_KINDS = new Set(['sync', 'awareness']);

function readFrameKind(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg && msg.type === 'frame' && typeof msg.kind === 'string' && FRAME_KINDS.has(msg.kind)) return msg.kind;
  } catch { /* not a control frame we understand */ }
  return null;
}

const { parseRoomName: baseParseRoomName } = require('./persistence/yjs');

function parseRoomName(documentName) {
  const base = baseParseRoomName(documentName);
  if (!base) return null;
  return base.noteId != null
    ? { kind: 'note', workspaceId: base.workspaceId, noteId: base.noteId }
    : { kind: 'meta', workspaceId: base.workspaceId, noteId: null };
}

/** @type {Map<string, { conns: Set<{ ws: import('ws').WebSocket, ctx: object }> }>} */
const rooms = new Map();

function getOrCreateRoom(documentName) {
  if (rooms.has(documentName)) return rooms.get(documentName);

  /** @type {Set<{ ws: import('ws').WebSocket, ctx: object }>} */
  const conns = new Set();
  const room = { conns };
  rooms.set(documentName, room);

  return room;
}

function broadcastToRoom(documentName, msg, excludeWs, fromRelay = false, senderCtx = null) {
  const room = rooms.get(documentName);
  if (!room) return;
  for (const conn of room.conns) {
    if (conn.ws === excludeWs) continue;
    if (conn.ws.readyState === 1) {
      // Peers get the authenticated sender identity just before the frame so
      // they can enforce read-only themselves; the payload stays opaque here.
      // ponytail: one extra text frame per relayed frame, drop the tag if
      // per-frame overhead ever matters.
      if (senderCtx) {
        try { conn.ws.send(JSON.stringify({ type: 'sender', userId: senderCtx.userId, role: senderCtx.role, readOnly: senderCtx.readOnly })); } catch { /* ignore */ }
      }
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

const UNKNOWN_FRAME_WARN_INTERVAL_MS = 60_000;
const lastUnknownFrameWarn = new Map();

// Rate-limited per room so a client sending plaintext Yjs (pre-encryption) can
// flood the relay log.
function warnUnknownFrame(documentName, buf) {
  const now = Date.now();
  const last = lastUnknownFrameWarn.get(documentName) ?? 0;
  if (now - last < UNKNOWN_FRAME_WARN_INTERVAL_MS) return;
  lastUnknownFrameWarn.set(documentName, now);
  console.warn(`[ws-relay] dropped non-encrypted binary frame in ${documentName}, first byte 0x${(buf[0] ?? 0).toString(16)}`);
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
      if (ticket && /ticket/i.test(err.message ?? '')) {
        // Single-use ticket: consumed, expired, or bound to another room. It
        // can never succeed on retry, so answer 401 with a retriable body
        // telling the client to mint a fresh ticket for this room.
        const body = JSON.stringify({ error: 'invalid_ticket', message: 'Ticket is invalid, used, or expired. Mint a fresh ws-ticket for this room and retry.', retriable: true });
        socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      } else {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
      socket.destroy();
    });
}

function handleConnection(ws, documentName, ctx) {
  const room = getOrCreateRoom(documentName);
  const conn = { ws, ctx };

  room.conns.add(conn);

  sendText(ws, { type: 'auth', readOnly: ctx.readOnly, role: ctx.role, userId: ctx.userId });

  // Kind declared by the client for the next binary frame only, so a viewer
  // cannot declare 'awareness' once and then stream sync frames under it.
  let pendingKind = null;

  // `ws` hands inbound text over as a Buffer, so isBinary is the only reliable
  // discriminator here; testing the payload type would never match.
  ws.on('message', (rawData, isBinary) => {
    if (!isBinary) {
      const kind = readFrameKind(rawData.toString());
      if (kind) pendingKind = kind;
      return; // control-plane text frame, nothing to relay
    }

    const kind = pendingKind;
    pendingKind = null;

    const buf = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    if (isEncryptedFrame(buf)) {
      if (ctx.readOnly && kind === 'sync') {
        console.debug(`[ws-relay] dropped sync frame from read-only user ${ctx.userId} in ${documentName}`);
        return;
      }
      // Verbatim fan-out to every other socket in the room. Peers own the Yjs
      // protocol: a joining client sends its own sync step 1 and existing peers
      // answer it.
      broadcastToRoom(documentName, buf, ws, false, ctx);
      return;
    }
    warnUnknownFrame(documentName, buf);
  });

  ws.on('close', () => {
    room.conns.delete(conn);
    if (room.conns.size === 0) {
      const t = setTimeout(() => {
        const current = rooms.get(documentName);
        if (current && current.conns.size === 0) {
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

  // Graceful shutdown: relay holds no document state, so there is nothing to flush
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ws-relay] Received ${signal}`);
    try { clearInterval(_heartbeatInterval); } catch {}
    try { await redisRelay?.close(); } catch {}
    try { wss.close(); } catch {}
    try { server.close(); } catch {}
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
  try { stopSyncNotificationListener(); } catch {}
  try { wss?.clients?.forEach((c) => { try { c.terminate(); } catch {} }); } catch {}
  try { wss?.close(); } catch {}
  try { await new Promise((res) => _httpServer ? _httpServer.close(res) : res()); } catch {}
  _httpServer = null;
  rooms.clear();
  wss = null;
}

module.exports = { startWsRelay, stopWsRelay, parseRoomName };

if (require.main === module) {
  startWsRelay().catch((err) => {
    console.error('Fatal ws-relay startup error:', err);
    process.exit(1);
  });
}
