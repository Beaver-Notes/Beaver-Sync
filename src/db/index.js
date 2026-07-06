'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/beaver.db';

let db = null;

function columnExists(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((r) => r.name === columnName);
}

function runMigrations() {
  if (!columnExists('sessions', 'workspace_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id, account_id)');

  if (!columnExists('sso_configs', 'allowed_email_domains')) {
    db.exec('ALTER TABLE sso_configs ADD COLUMN allowed_email_domains TEXT');
  }
}

function getDb() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  runMigrations();

  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, close };
