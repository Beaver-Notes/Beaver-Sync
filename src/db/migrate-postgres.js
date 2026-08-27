'use strict';

const fs = require('fs');
const path = require('path');
const { query, getPool } = require('./postgres');

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
    await query(schema);
    // 02.1: username is a display label, not unique — drop legacy UNIQUE constraint
    try {
      await query('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_username_key');
    } catch {}
    try {
      await query('DROP INDEX IF EXISTS accounts_username_key');
    } catch {}
    // 02.2: recovery code — single active per account, HMAC-hashed
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT');
    } catch {}
    try {
      await query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_code_generated_at TIMESTAMPTZ');
    } catch {}
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    } finally {
      lockClient.release();
    }
  }
}

module.exports = { ensureSchema };
