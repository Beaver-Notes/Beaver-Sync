'use strict';

const fs = require('fs');
const path = require('path');
const { query, getPool } = require('./postgres');

// Fixed advisory lock key so concurrently booting instances serialize schema
// creation instead of racing on CREATE TABLE.
const SCHEMA_ADVISORY_LOCK_KEY = 930743;

async function ensureSchema() {
  const schemaPath = path.join(__dirname, 'schema.postgres.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('schema.postgres.sql not found; Postgres backend requires it');
  }

  const lockClient = await getPool().connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    const schema = fs.readFileSync(schemaPath, 'utf8');
    // schema.postgres.sql is fully idempotent (CREATE ... IF NOT EXISTS).
    await query(schema);
    await runMigrations();
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    } finally {
      lockClient.release();
    }
  }
}

async function runMigrations() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = await query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.rows.map(r => r.filename));

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && f.includes('.postgres.'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await query(sql);
      await query('INSERT INTO _migrations (filename, applied_at) VALUES ($1, $2)', [file, new Date().toISOString()]);
      console.log(`[db] Applied migration: ${file}`);
    } catch (err) {
      // Postgres reports duplicate objects created outside this runner with
      // "already exists". Treat only that specific case as already-applied and
      // warn with the full error so a genuinely broken migration is not
      // silently swallowed. Anything else must fail loudly.
      if (err.message.includes('already exists')) {
        console.warn(`[db] Migration ${file} skipped, object already exists. Full error: ${err.message}`);
        await query('INSERT INTO _migrations (filename, applied_at) VALUES ($1, $2)', [file, new Date().toISOString()]);
        console.log(`[db] Skipped migration: ${file}`);
      } else {
        throw err;
      }
    }
  }
}

module.exports = { runMigrations, ensureSchema };
