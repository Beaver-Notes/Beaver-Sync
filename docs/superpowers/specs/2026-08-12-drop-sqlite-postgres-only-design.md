# Drop SQLite — Postgres-only

**Date:** 2026-08-12
**Status:** Approved design

## Overview

Remove SQLite (`better-sqlite3`) support entirely so the backend is Postgres-only.
The app is already deployed on Postgres (Docker/Fly/CI); SQLite survives only as the
local-dev backend (`.env` `DATABASE_PATH`) and the test-suite backend (19 files set
`DATABASE_PATH` to `.test-data/test.db`). This change deletes the SQLite code paths,
tooling, dependencies, and artifacts, and moves the test suite onto real Postgres.

## Current State (verified)

- `src/db/index.js` dispatches on env var: `DATABASE_URL` → Postgres, `DATABASE_PATH` → SQLite. No default; one is required.
- The db facade carries a thenable/sync shim solely to unify sync SQLite (`better-sqlite3`) with async Postgres (`pg`): `sqliteConvert`, `prepare()`, `exec()`, `runFileMigrations()`, and the SQLite branch in `getBackend()`.
- Models and routes already `await query()` / `await transaction()` — src churn is small.
- Only `src/db/migrate-data.js` uses sync `.prepare()` in src (legacy SQLite data script).
- 19 test files set `DATABASE_PATH`; ~98 synchronous `.prepare(...).run/get/all` calls in test seeding/assertions.
- `test/db/schema.test.js` reads `src/db/schema.sql`; `test/scripts/migrate.test.js` tests `scripts/migrate-sqlite-to-pg.js`; yjs-persistence migration tests use in-memory SQLite + `runFileMigrations`.
- **Gap:** nothing applies `schema.postgres.sql` (31 tables) automatically. Postgres deployments have no code path that creates the base schema; migrations only add newer tables. This must be fixed for a fresh Postgres to boot.
- `better-sqlite3` is a runtime dependency; `data/beaver.db` and `.test-data/` hold SQLite files.

## Decisions (confirmed with owner)

1. **Tests require real Postgres.** No skip-if-unreachable. CI gains a `postgres` service; local dev runs `docker compose up postgres`. DB-dependent tests are the whole suite.
2. **Full cleanup of the db layer** — pure async Postgres facade; delete thenable shims and SQLite branch.
3. **Remove all SQLite tooling** — migration scripts, `better-sqlite3`, `data/` and `.test-data/` artifacts.

## Design

### 1. Db layer: `src/db/index.js` becomes a thin Postgres facade

- `getBackend()` always `require('./postgres')`; throw a clear error if `DATABASE_URL` is missing (`DATABASE_PATH` no longer accepted).
- Delete: the SQLite branch, `sqliteConvert`, `prepare()`, `exec()`, `runFileMigrations()`, and `schema.sql` execution.
- Exported surface becomes `{ getDb, query, transaction, close, runMigrations }`.
  - `getDb()` returns the facade `{ query, transaction }` for callers/tests.
  - `query`, `transaction`, `close` delegate directly to `./postgres` (already async).
  - `runMigrations` re-exports `./migrate-postgres`.
- **New `ensureSchema()`** (in `src/db/migrate-postgres.js`, which already owns `runMigrations`):
  1. Apply `schema.postgres.sql` (all `CREATE TABLE/INDEX IF NOT EXISTS` → idempotent).
  2. Apply `.postgres.sql` migrations (existing `runMigrations`).
  - Called from `server.start()` (before listen) and from the test helper. Safe under concurrent instances because of `IF NOT EXISTS`.
- Delete `src/db/schema.sql` and the non-Postgres `migrations/*.sql` files; keep `migrations/*.postgres.sql`.

### 2. Remove SQLite artifacts

- Delete `scripts/migrate-sqlite-to-pg.js` and `src/db/migrate-data.js`.
- Remove `better-sqlite3` from `package.json` dependencies.
- Delete `data/beaver.db` and the `.test-data/` directory (confirm gitignore entries).

### 3. Tests → real Postgres

- `test/helpers/db.js`:
  - `setupTestDb()` → sets `DATABASE_URL` to a **dedicated test database** (e.g. `postgresql://beaver:beaver@localhost:5432/beaver_test`), calls `ensureSchema()`. A separate DB keeps test runs from clobbering local dev data.
  - `cleanTestDb()` (existing) becomes the sole cleanup; used in `before`/`after` where needed.
- Convert the 19 DB test files:
  - Replace `process.env.DATABASE_PATH = .../.test-data/test.db` with `setupTestDb()`.
  - Convert ~98 sync `.prepare(...).run/get/all` calls to `await query(...)` or model methods (seeding helpers become async).
  - Replace `db.exec('DELETE FROM ...')` cleanup with `cleanTestDb()`.
- Rework SQLite-only tests:
  - `test/db/schema.test.js` → validate `schema.postgres.sql` instead of `schema.sql`.
  - `test/scripts/migrate.test.js` → delete (tests a removed script).
  - yjs-persistence migration tests → drop the in-memory SQLite cases; keep the Postgres-relevant ones (dedup/rollback semantics) or adjust expectations to Postgres behavior.
  - `test/integration/postgres-ha.test.js` → remove skip logic; it is the suite.
- If Postgres is unreachable, fail fast with a clear message (do not silently skip).

### 4. Ops / config

- `.env`: remove the `DATABASE_PATH` line (keep `DATABASE_URL`).
- `.env.example`: confirm only `DATABASE_URL` (no `DATABASE_PATH`).
- `Dockerfile`: remove `mkdir -p /app/data` (keep `/app/keys`).
- `.github/workflows/ci.yml`: add a `postgres` service (with `POSTGRES_DB: beaver_test`) and `TEST_DATABASE_URL` env for the test job (set `NODE_ENV=test`).
- Test database provisioning: `docker compose up postgres` then `psql -c 'CREATE DATABASE beaver_test'` once locally; CI creates it via the service env. The helper honors `TEST_DATABASE_URL` and fails fast with a clear message if the DB is unreachable.
- Remove any remaining `DATABASE_PATH` references across `src/`, `scripts/`, `docs/` (excluding the historical plan docs).

## Execution order (each step verified)

1. Db layer + `ensureSchema()` → app boots and runs against Postgres.
2. Remove SQLite tooling + deps + schema.sql + SQLite migrations.
3. Ops/config (`.env`, Dockerfile, CI).
4. Convert tests → Postgres.
5. Full suite (`npm test`) + `npm run lint` green; CI green.

## Verification

- `npm run lint` clean.
- `npm test` runs entirely against Postgres; 0 fail, 0 skips (the postgres-ha skip logic and the two SQLite-migration skips are removed with SQLite).
- `docker compose up postgres` then `npm test` works locally.
- Fresh `docker compose up` boots the API against a fresh Postgres with schema auto-created (`ensureSchema`).
- No `DATABASE_PATH` / `better-sqlite3` / `schema.sql` references remain in `src/`, `scripts/`, or active `test/`.

## Risks

- **Test conversion is the bulk of the work** (~98 call sites + seeding helpers). Mitigated by a shared async test helper and converting file-by-file.
- **Postgres bootstrap is new behavior** (`ensureSchema`) — must be idempotent; verified by a fresh-DB test.
- **Async seeding bugs**: un-awaited thenables under Postgres fail silently. Mitigation: every converted test is run and asserts real rows.
- **Timing**: suite duration will grow (real PG round-trips vs in-memory SQLite). Acceptable; `--test-concurrency=1` retained.
