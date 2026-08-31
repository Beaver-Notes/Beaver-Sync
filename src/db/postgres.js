'use strict';

const { Pool, types } = require('pg');

// Return BIGINT columns as JS numbers so the Postgres backend matches the
// numeric semantics the rest of the codebase expects (SQLite returned numbers).
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // PgBouncer (transaction mode) sits in front of Postgres when DB queue
  // p95 >50ms: point DATABASE_URL at the bouncer and tune pool via
  // DATABASE_POOL_MAX (default 20, lower to 5-10 behind a bouncer).
  // Pool 20 is direct-Postgres; no code change needed for bouncer.
  pool = new Pool({
    connectionString,
    max: parseInt(process.env.DATABASE_POOL_MAX ?? '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true,
  });

  pool.on('error', (err) => {
    console.error('[pg] Unexpected error on idle client:', err.message);
  });

  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, transaction, close };
