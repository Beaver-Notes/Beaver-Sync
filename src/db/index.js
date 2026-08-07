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
  if (!columnExists('sessions', 'device_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN device_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id, account_id)');

  if (!columnExists('sso_configs', 'allowed_email_domains')) {
    db.exec('ALTER TABLE sso_configs ADD COLUMN allowed_email_domains TEXT');
  }

  if (!columnExists('vault_key_params', 'proof_version')) {
    db.exec('ALTER TABLE vault_key_params ADD COLUMN proof_version INTEGER NOT NULL DEFAULT 0');
  }

  // Run file-based migrations from src/db/migrations/
  runFileMigrations();
}

function runFileMigrations(migrationsDir = path.join(__dirname, 'migrations')) {
  if (!fs.existsSync(migrationsDir)) return;

  // Ensure migrations tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      })();
      console.log(`[db] Applied migration: ${file}`);
    } catch (err) {
      // A legacy database may have already applied one of this migration's columns.
      if (err.message && err.message.includes('duplicate column')) {
        db.transaction(() => {
          db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        })();
        console.log(`[db] Skipped migration (columns already exist): ${file}`);
      } else {
        throw err;
      }
    }
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

module.exports = { getDb, close, runFileMigrations };
