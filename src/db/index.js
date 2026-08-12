'use strict';

let backend = null;
let backendType = null;

function getBackend() {
  if (backend) return backend;

  if (process.env.DATABASE_URL) {
    backend = require('./postgres');
    backendType = 'postgres';
  } else if (process.env.DATABASE_PATH) {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      db.exec(schema);
    }

    backend = { sqlite: db };
    backendType = 'sqlite';
  } else {
    throw new Error('Either DATABASE_URL or DATABASE_PATH environment variable is required');
  }

  return backend || {};
}

function prepare(sql) {
  const b = getBackend();

  if (backendType === 'sqlite') {
    // Synchronous SQLite
    const stmt = b.sqlite.prepare(sql);
    return {
      run(...params) { return stmt.run(...params); },
      get(...params) { return stmt.get(...params); },
      all(...params) { return stmt.all(...params); }
    };
  }

  // Async Postgres
  let paramIndex = 0;
  const converted = sql.replace(/\?/g, () => `$${++paramIndex}`);

  return {
    run(...params) {
      return {
        then(resolve, reject) {
          return b.query(converted, params)
            .then(r => resolve({ changes: r.rowCount || 0 }))
            .catch(reject);
        }
      };
    },
    get(...params) {
      return {
        then(resolve, reject) {
          return b.query(converted, params)
            .then(r => resolve(r.rows ? r.rows[0] : null))
            .catch(reject);
        }
      };
    },
    all(...params) {
      return {
        then(resolve, reject) {
          return b.query(converted, params)
            .then(r => resolve(r.rows || []))
            .catch(reject);
        }
      };
    }
  };
}

function exec(sql) {
  const b = getBackend();

  if (backendType === 'sqlite') {
    b.sqlite.exec(sql);
    return { then(resolve) { resolve(); } };
  }

  return {
    then(resolve, reject) {
      return b.query(sql)
        .then(() => resolve())
        .catch(reject);
    }
  };
}

// Convert Postgres $1, $2, ... placeholders to SQLite positional ? while
// expanding values so each placeholder occurrence binds the value it names.
// Postgres allows $1 to be referenced more than once; SQLite does not, so a
// repeated $1 must become two positional ? bound to the same value.
function sqliteConvert(text, params) {
  const values = [];
  const converted = String(text).replace(/\$\d+/g, (match) => {
    values.push((params || [])[Number(match.slice(1)) - 1]);
    return '?';
  });
  return { converted, values };
}

function transaction(fn) {
  const b = getBackend();

  if (backendType === 'sqlite') {
    // better-sqlite3 is synchronous, so the async callback runs to completion
    // before the event loop can interleave another write on this connection.
    const started = !b.sqlite.inTransaction;
    if (started) b.sqlite.exec('BEGIN');

    return Promise.resolve()
      .then(() => fn({
        query: (text, params) => {
          const { converted, values } = sqliteConvert(text, params);
          const stmt = b.sqlite.prepare(converted);
          if (text.trim().toUpperCase().startsWith('SELECT')) {
            return Promise.resolve({ rows: stmt.all(...values) });
          }
          const result = stmt.run(...values);
          return Promise.resolve({ rowCount: result.changes });
        },
      }))
      .then((result) => {
        if (started) b.sqlite.exec('COMMIT');
        return result;
      })
      .catch((err) => {
        if (started) b.sqlite.exec('ROLLBACK');
        throw err;
      });
  }

  return b.transaction(fn);
}

function query(text, params) {
  const b = getBackend();

  if (backendType === 'sqlite') {
    const { converted, values } = sqliteConvert(text, params);
    const stmt = b.sqlite.prepare(converted);
    if (text.trim().toUpperCase().startsWith('SELECT')) {
      return Promise.resolve({ rows: stmt.all(...values) });
    } else {
      const result = stmt.run(...values);
      return Promise.resolve({ rowCount: result.changes });
    }
  }

  if (!b.getPool || !b.getPool()) {
    return Promise.reject(new Error('Database not initialized'));
  }

  return b.query(text, params);
}

function runFileMigrations(migrationsDir) {
  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(migrationsDir)) return;

  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = db.prepare('SELECT filename FROM _migrations').all();
  const appliedSet = new Set(applied.map(r => r.filename));

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    } catch (err) {
      if (err.message && err.message.includes('duplicate column')) {
        db.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      } else {
        throw err;
      }
    }
  }
}

function getDb() {
  return { prepare, exec, transaction, query };
}

function close() {
  if (backend) {
    if (backendType === 'sqlite' && backend.sqlite) {
      backend.sqlite.close();
      backend = null;
      backendType = null;
    } else if (backend.close) {
      return backend.close().then(() => {
        backend = null;
        backendType = null;
      });
    }
  }
  return Promise.resolve();
}

module.exports = { getDb, close, runFileMigrations, query, transaction };
