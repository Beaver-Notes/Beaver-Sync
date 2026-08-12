'use strict';

const EventEmitter = require('events');
const { getPool } = require('../db/postgres');

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(100);

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

let activeClient = null;
let reconnecting = false;
let reconnectAttempts = 0;

function subscribe(channel, callback) {
  localEmitter.on(channel, callback);
  return () => localEmitter.off(channel, callback);
}

function publish(channel, data) {
  localEmitter.emit(channel, data);
}

async function startPostgresListener() {
  if (activeClient) return;

  const pool = getPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('LISTEN beaver_events');
    activeClient = client;
    reconnectAttempts = 0;

    client.on('notification', (msg) => {
      try {
        const { channel, payload } = msg;
        localEmitter.emit(channel, JSON.parse(payload));
      } catch (err) {
        console.error('[events] Failed to parse notification:', err.message);
      }
    });

    const teardown = () => {
      if (activeClient === client) {
        activeClient = null;
        // Destroy the broken connection instead of returning it to the pool.
        client.release(true);
      }
      scheduleReconnect();
    };
    client.on('error', teardown);
    client.on('end', teardown);

    console.log('[events] Postgres LISTEN/NOTIFY started');
  } catch (err) {
    console.error('[events] Failed to start Postgres listener:', err.message);
    if (client) client.release(true);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const delay = Math.min(
    RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
    MAX_RECONNECT_DELAY_MS
  );
  reconnectAttempts++;
  setTimeout(() => {
    reconnecting = false;
    startPostgresListener().catch((err) =>
      console.error('[events] Reconnect failed:', err.message)
    );
  }, delay);
}

async function notify(channel, data) {
  const pool = getPool();
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(data)]);
}

module.exports = { subscribe, publish, notify, startPostgresListener };
