'use strict';

const EventEmitter = require('events');
const { getPool } = require('../db/postgres');

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(100);

function subscribe(channel, callback) {
  localEmitter.on(channel, callback);
  return () => localEmitter.off(channel, callback);
}

function publish(channel, data) {
  localEmitter.emit(channel, data);
}

async function startPostgresListener() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('LISTEN beaver_events');

    client.on('notification', (msg) => {
      try {
        const { channel, payload } = msg;
        const data = JSON.parse(payload);
        localEmitter.emit(channel, data);
      } catch (err) {
        console.error('[events] Failed to parse notification:', err.message);
      }
    });

    console.log('[events] Postgres LISTEN/NOTIFY started');
  } catch (err) {
    console.error('[events] Failed to start Postgres listener:', err.message);
  }
}

async function notify(channel, data) {
  const pool = getPool();
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(data)]);
}

module.exports = { subscribe, publish, notify, startPostgresListener };
