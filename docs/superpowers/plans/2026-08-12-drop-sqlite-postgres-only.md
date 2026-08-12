# Drop SQLite — Postgres-Only Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SQLite (`better-sqlite3`) entirely so the backend and test suite run only against Postgres.

**Architecture:** `src/db/index.js` becomes a thin facade over `src/db/postgres.js` (async `pg`). A new idempotent `ensureSchema()` applies `schema.postgres.sql` + `.postgres.sql` migrations at startup and in tests. The 19 SQLite-backed test files move to a real Postgres test database (`beaver_test`). All SQLite tooling, schema, migrations, dependency, and artifacts are deleted.

**Tech Stack:** Node.js >=20 (CommonJS), Fastify 4, `pg` v8, `node:test`. No TypeScript.

## Global Constraints

- `DATABASE_PATH` is removed; `DATABASE_URL` is required everywhere. Postgres-only.
- Test DB: `TEST_DATABASE_URL` (default `postgresql://beaver:beaver@localhost:5432/beaver_test`). Tests fail fast (do NOT skip) if unreachable.
- All seeding/assertion SQL in tests is async: `await query(sql, params)`; `?` placeholders become `$1..$N`; `.get()` → `(await query(...)).rows[0]`; `.all()` → `(await query(...)).rows`; `.run()` → `await query(...)` (ignore return).
- DB cleanup via `cleanTestDb()` (FK-safe order), never `fs.rmSync` of a db file.
- `schema.postgres.sql` and `migrations/*.postgres.sql` are the only schema sources. `src/db/schema.sql` and the four non-Postgres migrations are deleted.
- Keep `npm test` (`node --test --test-concurrency=1`) and `npm run lint` green at the end of every task.
- Deleted files: `scripts/migrate-sqlite-to-pg.js`, `src/db/migrate-data.js`, `src/db/schema.sql`, `src/db/migrations/{001-organizations,002-sync-protocol,003-vault-proof-challenges,004-session-device}.sql`, `test/scripts/migrate.test.js`, `data/beaver.db`, `.test-data/`.
- Cross-cutting: when a converted test hits one of these SQLite-only error-string checks in src, apply the same case-insensitive treatment (like the `organizations.js` slug check): `src/models/index.js:423`, `src/routes/account.js:163`, `src/routes/snapshot.js:70` (all match SQLite's uppercase `'UNIQUE constraint'`; Postgres emits lowercase "duplicate key ... unique constraint").

## Prerequisites (run once before Task 1)

```bash
docker compose up -d postgres
# create the dedicated test DB (CI does this via service env instead)
PGPASSWORD=beaver psql -h localhost -U beaver -d beaver -c 'CREATE DATABASE beaver_test' 2>/dev/null || true
```
Expected: `docker compose ps` shows `postgres` healthy; `psql` succeeds (or DB already exists).

---

### Task 1: Test DB helper + `ensureSchema`

Makes the Postgres test harness exist so later tasks can convert test files against it. The db layer is still dual-mode during this task (tests not yet converted).

**Files:**
- Modify: `src/db/migrate-postgres.js` (add `ensureSchema`)
- Modify: `test/helpers/db.js` (rewrite)
- Modify: `.github/workflows/ci.yml` (postgres service)
- Test: `test/helpers/db.js` is exercised by running `node --test test/integration/postgres-ha.test.js`

**Interfaces:**
- Produces: `ensureSchema()` from `src/db/migrate-postgres` — async, idempotent, applies `schema.postgres.sql` then migrations. `setupTestDb()` from `test/helpers/db` — async, sets `DATABASE_URL`/env secrets then calls `ensureSchema()`. `cleanTestDb()` — async, FK-safe full delete.

- [ ] **Step 1: Add `ensureSchema` to `src/db/migrate-postgres.js`**

Add above `runMigrations` (keep `runMigrations` unchanged):

```js
async function ensureSchema() {
  const schemaPath = path.join(__dirname, 'schema.postgres.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('schema.postgres.sql not found; Postgres backend requires it');
  }
  const schema = fs.readFileSync(schemaPath, 'utf8');
  // schema.postgres.sql is fully idempotent (CREATE ... IF NOT EXISTS).
  await query(schema);
  await runMigrations();
}
```

Update the export:

```js
module.exports = { runMigrations, ensureSchema };
```

- [ ] **Step 2: Rewrite `test/helpers/db.js`**

Replace the whole file with:

```js
'use strict';

const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

// Dedicated Postgres test database, separate from local dev data.
const DEFAULT_DATABASE_URL = 'postgresql://beaver:beaver@localhost:5432/beaver_test';

async function setupTestDb() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || DEFAULT_DATABASE_URL;
  }

  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.SESSION_HMAC_KEY = process.env.SESSION_HMAC_KEY || 'test-session-hmac-key-at-least-32-characters-long';
  process.env.EMAIL_HMAC_KEY = process.env.EMAIL_HMAC_KEY || 'test-email-hmac-key-at-least-32-characters-long';
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-at-least-32-chars-long';
  process.env.NOTE_HMAC_KEY = process.env.NOTE_HMAC_KEY || 'test-note-hmac-key-at-least-32-characters-long';

  if (!process.env.JWT_PRIVATE_KEY_PATH) {
    process.env.JWT_PRIVATE_KEY_PATH = path.join(repoRoot, 'keys/private.pem');
  }
  if (!process.env.JWT_PUBLIC_KEY_PATH) {
    process.env.JWT_PUBLIC_KEY_PATH = path.join(repoRoot, 'keys/public.pem');
  }
  if (!process.env.WEBAUTHN_RPID) {
    process.env.WEBAUTHN_RPID = 'localhost';
  }
  if (!process.env.WEBAUTHN_ORIGIN) {
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000';
  }

  const { ensureSchema } = require('../../src/db/migrate-postgres');
  await ensureSchema();
}

// FK-safe delete order: children before parents (workspaces before orgs/accounts).
const TABLES = [
  'yjs_doc_updates', 'sync_document_state', 'sync_workspace_state',
  'note_comments', 'note_invite_links', 'note_invitations', 'note_keys',
  'vault_key_params', 'vault_proof_challenges',
  'workspace_members', 'workspace_invites', 'workspace_keys',
  'compaction_locks', 'subscriptions', 'commits', 'sessions',
  'devices', 'credentials', 'webauthn_challenges', 'quick_connect_codes',
  'email_aliases', 'audit_logs', 'sso_oidc_states', 'sso_configs',
  'workspaces',
  'org_keys', 'org_subscriptions', 'org_invites', 'org_members',
  'organizations',
  'accounts',
];

async function cleanTestDb() {
  const { query } = require('../../src/db/postgres');
  for (const table of TABLES) {
    try {
      await query(`DELETE FROM ${table}`);
    } catch (err) {
      // Table might not exist yet; ignore.
    }
  }
}

module.exports = { setupTestDb, cleanTestDb, DEFAULT_DATABASE_URL };
```

- [ ] **Step 3: Update CI to provide Postgres**

In `.github/workflows/ci.yml`, add a `services:` block after `steps:` setup (before the Lint step):

```yaml
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: beaver
          POSTGRES_PASSWORD: beaver
          POSTGRES_DB: beaver_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U beaver"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

And in the `Test` step, set the env:

```yaml
      - name: Test
        run: yarn test
        env:
          TEST_DATABASE_URL: postgresql://beaver:beaver@localhost:5432/beaver_test
```

- [ ] **Step 4: Verify helper + ensureSchema against Postgres**

Run: `node --test --test-concurrency=1 test/integration/postgres-ha.test.js`
Expected: the 4 Postgres HA tests pass (skip logic removed in a later task — they may still skip here; the important check is no crash). Then run `node -e "require('./test/helpers/db').setupTestDb().then(() => console.log('ok'))"`.
Expected: prints `ok`.

- [ ] **Step 5: Lint + commit**

Run: `npm run lint` — expected PASS (helpers are linted via eslint config `test/**/*.js`).
Commit:

```bash
git add src/db/migrate-postgres.js test/helpers/db.js .github/workflows/ci.yml
git commit -m "feat(db): add ensureSchema and Postgres test harness"
```

---

### Task 2: Convert core e2e/collab test files

Convert the four files that seed accounts/workspaces with raw SQL and previously deleted `.test-data/*.db` files: `e2e-backend`, `e2e-security`, `org-invite`, `vault`. This is the canonical conversion; reuse the same recipes in Tasks 3-4.

**Files:**
- Modify: `test/e2e-backend.test.js`
- Modify: `test/e2e-security.test.js`
- Modify: `test/org-invite.test.js`
- Modify: `test/vault.test.js`
- Test: each file individually against Postgres

**Interfaces:**
- Consumes: `setupTestDb()`, `cleanTestDb()` from `./helpers/db`.
- Produces: the converted-file pattern used by Tasks 3-4.

- [ ] **Step 1: Convert `test/e2e-backend.test.js`**

Remove the top-of-file SQLite setup. Delete lines equivalent to:

```js
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, '.test-data', 'test.db');
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });

process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db");
```

Keep `process.env.NODE_ENV = 'test';` and the secret env lines.

Convert the seeding helpers to async:

```js
async function seedAccount(id, kemPublicKey = null) {
  await query(
    'INSERT INTO accounts (id, username, email_hmac, created_at, kem_public_key) VALUES ($1, $2, $3, $4, $5)',
    [id, id, `${id}-email`, now, kemPublicKey]
  );
}

async function seedWorkspace(id, ownerId) {
  await query('INSERT INTO workspaces (id, name_encrypted, owner_id, created_at) VALUES ($1, $2, $3, $4)', [id, 'cipher', ownerId, now]);
  await query('INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)', [id, ownerId, 'owner', now]);
  await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [`${ownerId}-sub`, ownerId, 'pro', 'active', 1000000, 0, now]);
}
```

Add imports at the top (after the existing `require`s):

```js
const { query } = require('../src/db');
const { setupTestDb, cleanTestDb } = require('./helpers/db');
```

Convert `test.before` to async, replacing the whole `db.exec('DELETE FROM ...')` block (lines ~57-86) with `await cleanTestDb();` and `await setupTestDb();` before seeding:

```js
test.before(async () => {
  await setupTestDb();
  await cleanTestDb();

  alice = await makeKeypair();
  bob = await makeKeypair();

  await seedAccount('alice', alice.pk);
  await seedAccount('bob', bob.pk);
  await seedAccount('nokey', null);
  await seedWorkspace('ws-1', 'alice');

  app = await buildApp();
  await app.ready();
  aliceSession = await createSession('alice', {});
  bobSession = await createSession('bob', {});
});
```

Update `test.after` — keep `app.close()` + `close()`. Remove any `dbPath`/rmSync teardown.

Convert the remaining direct `db.prepare(...)` calls in the file body (inside tests) to `await query(...)` with `$N` placeholders. The file has 5 such sites — apply the exact recipes from the Global Constraints (`.run(...)` → `await query(sql, [...])`).

- [ ] **Step 2: Convert `test/e2e-security.test.js`**

Same recipe as Step 1:
- Remove `repoRoot`/`dbPath`/`rmSync`/`process.env.DATABASE_PATH` block; add `const { query } = require('../src/db');` and `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `seedAccount`/`seedWorkspace` become async with `$N` placeholders (same SQL as e2e-backend, except `seedWorkspace` inserts `''` for `name_encrypted`).
- `test.before` becomes `async` and calls `await setupTestDb(); await cleanTestDb();` before `makeKeypair`/seeding. `test.after` unchanged (`app.close()` + `close()`).
- The four inline `getDb().prepare('INSERT ...').run(...)` calls inside tests become `await query('INSERT ...', [...])` with `$N` placeholders.

- [ ] **Step 3: Convert `test/org-invite.test.js`**

- Remove `repoRoot`/`dbPath`/`rmSync`/`process.env.DATABASE_PATH` block; add `const { query } = require('../src/db');` and `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `seedAccount` and `seedOrg` become async with `$N` placeholders.
- `test.before` becomes `async`: `await setupTestDb(); await cleanTestDb();` then seed.
- `test.after`: keep `close()`; remove the `fs.rmSync(dbPath, ...)` block.
- Convert the inline `db.prepare('INSERT INTO note_invitations ...').run(...)` (inside the public-keys test) to `await query(...)`.

- [ ] **Step 4: Convert `test/vault.test.js`**

- Remove `repoRoot`/`dbPath`/`rmSync`/`process.env.DATABASE_PATH` block; add `const { query } = require('../src/db');` and `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `test.before` becomes `async`: `await setupTestDb(); await cleanTestDb();` then the existing `db.exec('DELETE FROM ...')` block is replaced by `cleanTestDb()` and the seed inserts become `await query(...)`.
- `test.after`: keep `close()`; remove `fs.rmSync(dbPath, ...)`.
- The inline `db.prepare('INSERT INTO vault_proof_challenges ...')` and `db.prepare('INSERT OR REPLACE INTO vault_key_params ...')` calls become `await query(...)`. Note: `vault_key_params` has a `UNIQUE INDEX` on `workspace_id` (both schemas), so `INSERT OR REPLACE` faithfully becomes `ON CONFLICT (workspace_id)`:
  ```js
  await query(
    `INSERT INTO vault_key_params (id, workspace_id, owner_id, passphrase_hash, key_params_blob, created_at, updated_at, proof_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET
       id = EXCLUDED.id,
       owner_id = EXCLUDED.owner_id,
       passphrase_hash = EXCLUDED.passphrase_hash,
       key_params_blob = EXCLUDED.key_params_blob,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       proof_version = EXCLUDED.proof_version`,
    ['legacy-row', 'vault-workspace', 'vault-account', await bcrypt.hash('legacy-passphrase', 4), 'legacy-blob', now, now, 0]
  );
  ```

- [ ] **Step 5: Verify the four files against Postgres**

Run: `node --test --test-concurrency=1 test/e2e-backend.test.js test/e2e-security.test.js test/org-invite.test.js test/vault.test.js`
Expected: all pass (18+ tests, 0 fail). Then `npm run lint` PASS.

- [ ] **Step 6: Commit**

```bash
git add test/e2e-backend.test.js test/e2e-security.test.js test/org-invite.test.js test/vault.test.js
git commit -m "test: run e2e/collab tests against Postgres"
```

---

### Task 3: Convert yjs/sync test files

`yjs-sync` has 33 `prepare()` sites (largest). `yjs-persistence` also drops its SQLite-only migration tests.

**Files:**
- Modify: `test/yjs-sync.test.js`
- Modify: `test/sync-state.test.js`
- Modify: `test/yjs-persistence.test.js`
- Modify: `test/remote-bootstrap.integration.test.js`
- Test: each file against Postgres

**Interfaces:**
- Consumes: `setupTestDb()`, `cleanTestDb()` from `./helpers/db`; `query` from `../src/db`.
- Produces: Postgres-compatible yjs persistence/sync tests.

- [ ] **Step 1: Convert `test/yjs-sync.test.js`**

Apply the standard recipe:
- Remove `repoRoot`/`dbPath`/`rmSync`/`process.env.DATABASE_PATH` block. Keep `NODE_ENV` + secrets.
- Add `const { query } = require('../src/db');` and `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `seedAccount(id)` and `seedWorkspace(id, ownerId)` become async with `$N` placeholders (SQL identical to e2e-backend's helpers).
- `test.before` becomes async: `await setupTestDb(); await cleanTestDb(); await seedAccount('account-1'); await seedWorkspace('workspace-1', 'account-1');`.
- `test.after`: keep `close()`; remove `fs.rmSync(dbPath, ...)`.
- Convert all 33 `getDb().prepare(...).run(...)`, `.get(...)`, `.all(...)` sites. Exact recipes:
  - `getDb().prepare('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...)` → `await query('INSERT INTO subscriptions (id, account_id, plan, status, storage_quota_bytes, storage_used_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [...])`.
  - `db.prepare('UPDATE subscriptions SET plan = ?, storage_used_bytes = 0 WHERE account_id = ?').run(plan, 'account-1')` → `await query('UPDATE subscriptions SET plan = $1, storage_used_bytes = 0 WHERE account_id = $2', [plan, 'account-1'])`.
  - `db.exec('CREATE TRIGGER force_yjs_transaction_failure ...')` → `await query('CREATE TRIGGER force_yjs_transaction_failure ...')` and `db.exec('DROP TRIGGER ...')` → `await query('DROP TRIGGER ...')`.
  - `getDb().prepare('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = ?').get('account-1').bytes` → `const row = (await query('SELECT storage_used_bytes AS bytes FROM subscriptions WHERE account_id = $1', ['account-1'])).rows[0]; assert.equal(row.bytes, ...)`.
  - `db.prepare('SELECT COUNT(*) AS count FROM yjs_doc_updates WHERE note_id LIKE ?').get('quota-%').count` → `(await query('SELECT COUNT(*) AS count FROM yjs_doc_updates WHERE note_id LIKE $1', ['quota-%'])).rows[0].count`.
  - `db.prepare('SELECT update_encrypted FROM yjs_doc_updates WHERE workspace_id = ? AND note_id = ? AND device_id = ? AND clock = ?').get('workspace-1', 'opaque-note', 'device-a', 1).update_encrypted` → `(await query('SELECT update_encrypted FROM yjs_doc_updates WHERE workspace_id = $1 AND note_id = $2 AND device_id = $3 AND clock = $4', ['workspace-1', 'opaque-note', 'device-a', 1])).rows[0].update_encrypted`.
  - `db.prepare('INSERT INTO devices (id, account_id, device_id, label, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(...)` → `await query('INSERT INTO devices (id, account_id, device_id, label, last_seen, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [...])`.
  - `db.prepare('DELETE FROM devices WHERE account_id = ?').run('account-1')` → `await query('DELETE FROM devices WHERE account_id = $1', ['account-1'])`.
- `test('rolls back prepared notes and quota ...')` relies on SQLite trigger syntax. Rewrite the trigger setup/teardown for Postgres (the transaction rollback behavior itself is natively correct in Postgres):
  - Before the push request:
    ```js
    await query(`CREATE OR REPLACE FUNCTION force_yjs_transaction_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.note_id = 'transaction-failure-note-b' THEN
          RAISE EXCEPTION 'forced yjs transaction failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await query(`CREATE TRIGGER force_yjs_transaction_failure
      BEFORE INSERT ON yjs_doc_updates
      FOR EACH ROW EXECUTE FUNCTION force_yjs_transaction_failure()`);
    ```
  - After the push request:
    ```js
    await query(`DROP TRIGGER IF EXISTS force_yjs_transaction_failure ON yjs_doc_updates`);
    await query(`DROP FUNCTION IF EXISTS force_yjs_transaction_failure()`);
    ```
  - Keep the assertions unchanged (converted to `await query(...)` as above).

- [ ] **Step 2: Convert `test/sync-state.test.js`**

- `sync-state.test.js` uses its own SQLite file `sync-state-test.db` with `DATABASE_PATH = testDbPath`. Replace with the standard recipe: remove `testDbPath`/`rmSync`/`DATABASE_PATH`; add `query`/`setupTestDb`/`cleanTestDb` imports.
- `test.before` becomes async: `await setupTestDb(); await cleanTestDb();` then seed. Its seeding uses `getDb().prepare` (15 sites) → convert to `await query(...)` with `$N`.
- `test.after` removes the `fs.rmSync(testDbPath, ...)` lines.

- [ ] **Step 3: Convert `test/yjs-persistence.test.js`**

- Remove `process.env.DATABASE_PATH = path.join(repoRoot, '.test-data', 'test.db')`; add `const { query } = require('../src/db');` and `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `test.before` becomes async: `await setupTestDb(); await cleanTestDb();` then `seedWorkspace()` (converted to `await query(...)`).
- `seedWorkspace` (the SQLite `getDb().prepare(...).run(...)` helper) becomes async with `$N` placeholders.
- **Remove the three SQLite-only tests** (they depend on in-memory SQLite / `runFileMigrations` semantics):
  - `test('migration cleanup retains the earliest duplicate row', ...)` (creates `new Database(':memory:')` and reads `schema.sql`).
  - `test('rolls back migration statements and tracking when a migration fails', { skip: ... }, ...)`.
  - `test('marks a partially migrated duplicate-column migration as applied after rollback', { skip: ... }, ...)`.
- The `runFileMigrations` import from `../src/db` is removed (function no longer exported in a later task; drop the import now).
- The two remaining `{ skip: 'SQLite parameter binding issue' }` markers were already removed in earlier work — leave the active tests as-is (they use `persistence.*`, no direct SQL).

- [ ] **Step 4: Convert `test/remote-bootstrap.integration.test.js`**

- Remove `process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db")`. Keep `NODE_ENV`/secrets/storage env.
- Add `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
- `seed()` becomes async; its 5 `db.prepare(...).run(...)` calls become `await query(...)` with `$N` placeholders.
- In the main test, call `await setupTestDb(); await cleanTestDb(); await seed();` (before `buildApp`). The `t.after` keeps `close()` and the tmpdir removal; drop the shared-db `rmSync` concerns.

- [ ] **Step 5: Verify**

Run: `node --test --test-concurrency=1 test/yjs-sync.test.js test/sync-state.test.js test/yjs-persistence.test.js test/remote-bootstrap.integration.test.js`
Expected: all pass, 0 fail. Then `npm run lint` PASS.

- [ ] **Step 6: Commit**

```bash
git add test/yjs-sync.test.js test/sync-state.test.js test/yjs-persistence.test.js test/remote-bootstrap.integration.test.js
git commit -m "test: run yjs/sync tests against Postgres"
```

---

### Task 4: Convert remaining test files

The remaining `DATABASE_PATH` files use models (not raw SQL) for DB access, so conversion is mostly the env swap + cleanup hooks. Files: `workspace-sessions`, `sessions`, `security`, `compaction`, `commits`, `quickconnect`, `passkey`, `email`, `e2e`, `routes/async`, `routes/ws`.

**Files:**
- Modify: `test/workspace-sessions.test.js`, `test/sessions.test.js`, `test/security.test.js`, `test/compaction.test.js`, `test/commits.test.js`, `test/quickconnect.test.js`, `test/passkey.test.js`, `test/email.test.js`, `test/e2e.test.js`, `test/routes/async.test.js`, `test/routes/ws.test.js`
- Test: the full suite

**Interfaces:**
- Consumes: `setupTestDb()`, `cleanTestDb()` from `./helpers/db`.

- [ ] **Step 1: Apply the standard env swap to each file**

For each of the 11 files:
1. Delete the `process.env.DATABASE_PATH = path.join(repoRoot, ".test-data", "test.db");` line (and any now-unused `repoRoot`/`path`/`fs` imports, plus any `fs.rmSync`/`fs.unlinkSync` db-file teardown in `test.after`).
2. Add `const { setupTestDb, cleanTestDb } = require('./helpers/db');`.
3. In `test.before` (or at the top of the first `buildApp` usage), call `await setupTestDb();` and, where the file previously relied on a fresh db file, `await cleanTestDb();`.
4. If the file has no `test.before`, add one:
   ```js
   test.before(async () => {
     await setupTestDb();
     await cleanTestDb();
   });
   ```
5. Replace any `test.after` block that deletes a db file (`fs.unlinkSync`/`rmSync`) with just the model-stub restoration + `close()` (keep whatever stub restoration already exists).

Per-file notes (each already verified to have 0 raw `prepare()` calls, so no SQL conversion):
- `test/e2e.test.js` — remove `testDbDir`/`fs.mkdirSync` + the `test.after` that `unlinkSync`s `process.env.DATABASE_PATH`; use `setupTestDb` in `before`.
- `test/email.test.js` — same treatment for its `test.after` unlink block.
- `test/workspace-sessions.test.js` — same.
- `test/commits.test.js`, `test/compaction.test.js`, `test/security.test.js`, `test/passkey.test.js`, `test/quickconnect.test.js`, `test/sessions.test.js` — add `setupTestDb` in `before`; keep the model-stub `after` blocks.
- `test/routes/async.test.js`, `test/routes/ws.test.js` — add `setupTestDb`/`cleanTestDb` in `before`.

- [ ] **Step 2: Run the full suite**

Run: `npm test` (requires local Postgres + `beaver_test`).
Expected: full suite green — 0 fail. (`postgres-ha.test.js` may still report skips until Task 5; `migrate.test.js` still passes because the script it imports is only deleted in Task 7.)

- [ ] **Step 3: Lint + commit**

Run: `npm run lint` — PASS.
Commit:

```bash
git add test/
git commit -m "test: run remaining test files against Postgres"
```

---

### Task 5: Remove SQLite-only tests and finish the Postgres integration test

**Files:**
- Delete: `test/scripts/migrate.test.js`
- Modify: `test/integration/postgres-ha.test.js`
- Test: `node --test --test-concurrency=1 test/integration/postgres-ha.test.js`

- [ ] **Step 1: Delete `test/scripts/migrate.test.js`**

```bash
git rm test/scripts/migrate.test.js
```

- [ ] **Step 2: Rewrite `test/integration/postgres-ha.test.js`**

Remove the `pgAvailable` skip logic and run against the shared helper. Replace the whole file with:

```js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { setupTestDb } = require('../helpers/db');

describe('Postgres HA integration', () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    const { close } = require('../../src/db/postgres');
    await close();
  });

  it('can connect to Postgres', async () => {
    const { query } = require('../../src/db/postgres');
    const result = await query('SELECT NOW()');
    assert(result.rows[0].now);
  });

  it('can run migrations', async () => {
    const { runMigrations } = require('../../src/db/migrate-postgres');
    await runMigrations();
  });

  it('can create and query account', async () => {
    const { Account } = require('../../src/models');
    const account = await Account.create({
      emailHmac: `test@example.com`,
      username: 'testuser',
    });
    assert(account.id);

    const found = await Account.findById(account.id).lean();
    assert(found.emailHmac === 'test@example.com');

    await Account.deleteOne({ _id: account.id });
  });

  it('can use transactions', async () => {
    const { transaction } = require('../../src/db/postgres');
    const result = await transaction(async (client) => {
      const res = await client.query('SELECT 1 as num');
      return res.rows[0].num;
    });
    assert(result === 1);
  });
});
```

- [ ] **Step 3: Verify**

Run: `node --test --test-concurrency=1 test/integration/postgres-ha.test.js`
Expected: 4 pass, 0 skip, 0 fail. Then `npm run lint` PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/postgres-ha.test.js
git commit -m "test: require Postgres for integration suite, drop SQLite migration test"
```

---

### Task 6: Make the db layer Postgres-only

**Files:**
- Rewrite: `src/db/index.js`
- Modify: `src/server.js` (call `ensureSchema` at startup)
- Delete: `src/db/schema.sql`
- Delete: `src/db/migrations/001-organizations.sql`, `002-sync-protocol.sql`, `003-vault-proof-challenges.sql`, `004-session-device.sql`
- Test: full suite

**Interfaces:**
- Consumes: `ensureSchema()` from `./db/migrate-postgres`; `query/transaction/close` from `./db/postgres`.
- Produces: `{ getDb, close, query, transaction }` from `src/db` (Postgres-only). `getDb()` returns `{ query, transaction }`.

- [ ] **Step 1: Rewrite `src/db/index.js`**

Replace the whole file with:

```js
'use strict';

// Postgres-only backend. SQLite (better-sqlite3) support has been removed.

function getBackend() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required (Postgres-only backend)');
  }
  return require('./postgres');
}

function getDb() {
  const b = getBackend();
  return { query: b.query, transaction: b.transaction };
}

function query(text, params) {
  return getBackend().query(text, params);
}

function transaction(fn) {
  return getBackend().transaction(fn);
}

function close() {
  return getBackend().close();
}

module.exports = { getDb, close, query, transaction };
```

- [ ] **Step 2: Wire `ensureSchema` into server startup**

In `src/server.js`, inside `async function start()`, before `getDb()`:

```js
  const { ensureSchema } = require('./db/migrate-postgres');
  await ensureSchema();

  getDb();
  app.log.info('Database connected');
```

- [ ] **Step 3: Delete the SQLite schema + migrations**

```bash
git rm src/db/schema.sql \
  src/db/migrations/001-organizations.sql \
  src/db/migrations/002-sync-protocol.sql \
  src/db/migrations/003-vault-proof-challenges.sql \
  src/db/migrations/004-session-device.sql
```

- [ ] **Step 4: Verify**

Run: `npm run lint` — PASS. Then `npm test`.
Expected: full suite green (0 fail). Confirm no `DATABASE_PATH` or `better-sqlite3` references remain in `src/`:

```bash
rg -n "DATABASE_PATH|better-sqlite3|schema\.sql|runFileMigrations" src/ || echo "clean"
```

- [ ] **Step 5: Commit**

```bash
git add src/db/index.js src/server.js
git commit -m "feat(db): make backend Postgres-only, ensure schema at startup"
```

---

### Task 7: Remove SQLite tooling, dependency, and artifacts

**Files:**
- Delete: `scripts/migrate-sqlite-to-pg.js`
- Delete: `src/db/migrate-data.js`
- Delete: `data/beaver.db`
- Delete: `.test-data/`
- Modify: `package.json` (remove `better-sqlite3`)
- Test: full suite

- [ ] **Step 1: Delete files**

```bash
git rm scripts/migrate-sqlite-to-pg.js src/db/migrate-data.js data/beaver.db
rm -rf .test-data
```

- [ ] **Step 2: Remove `better-sqlite3` from `package.json`**

Remove the line `"better-sqlite3": "^13.0.3",` from `dependencies`. Then run `npm install` to prune the lockfile and node_modules copy:

```bash
npm install
```

- [ ] **Step 3: Verify**

Run: `npm run lint` — PASS. `npm test` — full suite green. Confirm no references remain anywhere active:

```bash
rg -n "better-sqlite3|migrate-sqlite-to-pg|migrate-data|DATABASE_PATH" src/ scripts/ test/ package.json || echo "clean"
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove SQLite tooling, dependency, and artifacts"
```

---

### Task 8: Ops polish

**Files:**
- Modify: `Dockerfile` (stop creating `/app/data`)
- Modify: `.env` (remove `DATABASE_PATH`)
- Test: `git grep` for leftovers

- [ ] **Step 1: Dockerfile**

In `Dockerfile`, change:

```dockerfile
RUN addgroup -S beaver && adduser -S beaver -G beaver \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/data /app/keys \
    && chown -R beaver:beaver /app
```

to:

```dockerfile
RUN addgroup -S beaver && adduser -S beaver -G beaver \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/keys \
    && chown -R beaver:beaver /app
```

- [ ] **Step 2: `.env`**

Remove the `DATABASE_PATH=/app/data/beaver.db` line from `.env` (keep `DATABASE_URL`). `.env` is gitignored, so this is a local edit, not a commit.

- [ ] **Step 3: Final leftover scan**

```bash
git grep -n "DATABASE_PATH\|better-sqlite3\|schema\.sql\|migrate-sqlite-to-pg\|migrate-data" -- ':!docs/superpowers/*' || echo "clean"
```
Expected: only historical docs under `docs/superpowers/` may reference SQLite. If any active source/test/config reference remains, fix it.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore(docker): drop SQLite data dir"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full suite + lint**

```bash
npm test
npm run lint
```
Expected: `tests 191` → all pass, 0 fail, **0 skipped** (the two SQLite-migration skips and the postgres-ha skips are gone; nothing else is skipped).

- [ ] **Step 2: Fresh-DB boot check**

```bash
docker compose up -d --build api
sleep 5
curl -s http://127.0.0.1:3000/health
```
Expected: `{"status":"ok","db":"connected"}` — proves `ensureSchema` auto-created the schema on a fresh Postgres.

- [ ] **Step 3: Confirm deletion set**

```bash
git status --short
```
Expected: tracked deletions of the SQLite files listed in Global Constraints; no stray `.test-data/` or `data/*.db`.
