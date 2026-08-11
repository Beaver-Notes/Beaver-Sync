'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('./postgres');

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
      if (err.message.includes('already exists')) {
        await query('INSERT INTO _migrations (filename, applied_at) VALUES ($1, $2)', [file, new Date().toISOString()]);
        console.log(`[db] Skipped migration: ${file}`);
      } else {
        throw err;
      }
    }
  }
}

module.exports = { runMigrations };
