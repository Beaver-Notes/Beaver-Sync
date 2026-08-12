# Task 4: Route Async Conversion - Design

## Summary
Convert all route files from synchronous SQLite patterns to async Postgres patterns.

## Files to Convert

### Routes (with `db.prepare()` / `db.transaction()` calls):
- `src/routes/account.js` - Transaction wrapping deletes
- `src/routes/auth.js` - INSERT OR IGNORE for sync state
- `src/routes/collaboration.js` - Transaction wrapping model methods
- `src/routes/commits.js` - Raw SQL query with joins
- `src/routes/organizations.js` - INSERT OR IGNORE for sync state
- `src/routes/sync-state.js` - Heavy raw SQL usage
- `src/routes/vault.js` - Raw SQL + transaction
- `src/routes/workspaces.js` - INSERT OR IGNORE for sync state

### Middleware (no `db.prepare()` calls, already async):
- `src/middleware/auth.js` - No changes needed
- `src/middleware/subscription.js` - No changes needed

## Conversion Patterns

1. Import: `const { getDb } = require('../db')` → `const { query, transaction } = require('../db/postgres')`
2. `.get()` → `const { rows } = await query(...); rows[0]`
3. `.all()` → `const { rows } = await query(...); rows`
4. `.run()` → `await query(...)`
5. `result.changes` → `result.rowCount`
6. `db.transaction(fn)()` → `await transaction(async (client) => {...})`
7. `?` → `$1, $2, ...`
8. `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`
9. Sync helpers using `getDb()` become `async`

## Test
Simple verification that route modules export async functions.
