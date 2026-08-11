'use strict';

const Database = require('better-sqlite3');
const { transaction } = require('../src/db/postgres');

async function migrateSqliteToPostgres(sqlitePath, dryRun = false) {
  console.log(`[migrate] Starting migration from ${sqlitePath}`);
  
  const sqlite = new Database(sqlitePath, { readonly: true });
  
  // Get all tables
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_%'").all();
  
  for (const { name: table } of tables) {
    console.log(`[migrate] Migrating table: ${table}`);
    
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    console.log(`[migrate]   Found ${rows.length} rows`);
    
    if (dryRun) {
      console.log(`[migrate]   Dry run - skipping insert`);
      continue;
    }
    
    // Insert in batches of 1000
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      await insertBatch(table, batch);
      console.log(`[migrate]   Inserted ${Math.min(i + 1000, rows.length)}/${rows.length}`);
    }
  }
  
  sqlite.close();
  console.log('[migrate] Migration complete');
}

async function insertBatch(table, rows) {
  if (rows.length === 0) return;
  
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  
  await transaction(async (client) => {
    for (const row of rows) {
      const values = columns.map(col => row[col]);
      await client.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
    }
  });
}

// CLI
if (require.main === module) {
  const sqlitePath = process.argv[2] || './data/beaver.db';
  const dryRun = process.argv.includes('--dry-run');
  
  migrateSqliteToPostgres(sqlitePath, dryRun).catch(err => {
    console.error('[migrate] Error:', err);
    process.exit(1);
  });
}

module.exports = { migrateSqliteToPostgres };