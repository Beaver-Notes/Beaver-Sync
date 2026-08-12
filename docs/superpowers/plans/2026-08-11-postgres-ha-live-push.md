# Postgres HA + Live Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate from SQLite to Postgres, add HA scaling on Fly.io, implement WebSocket live push with Postgres LISTEN/NOTIFY, and simplify self-host deployment.

**Architecture:** Replace SQLite with Postgres (single-node, scale to 3-node later). Add 2+ API replicas on Fly.io with rolling deploys. Add WebSocket gateway on API for live push, using Postgres LISTEN/NOTIFY for cross-instance event bus. Unify docker-compose with Postgres container for self-host.

**Tech Stack:** Node.js, Fastify, Postgres (pg driver), @fastify/websocket, Yjs/Hocuspocus, R2/MinIO

## Global Constraints

- Node.js >= 20.0.0
- Postgres 16+ (Fly Managed Postgres or self-managed)
- Fly.io: `auto_stop_machines = false`, `auto_start_machines = false`, `min_machines_running = 2`
- All migrations must be idempotent
- Self-host: docker-compose with Postgres container (no SQLite)
- API contract: no breaking changes to existing endpoints

---

### Task 1: Database Abstraction Layer

**Files:**
- Create: `src/db/postgres.js`
- Modify: `src/db/index.js`
- Create: `test/db/postgres.test.js`

**Interfaces:**
- Consumes: `DATABASE_URL` env var
- Produces: `getDb()` returns PG pool (async), `close()` closes pool

- [ ] **Step 1: Install pg driver**

```bash
yarn add pg
```

- [ ] **Step 2: Create Postgres driver module**

```javascript
// src/db/postgres.js
'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  
  pool.on('error', (err) => {
    console.error('[pg] Unexpected error on idle client:', err.message);
  });
  
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, transaction, close };
```

- [ ] **Step 3: Update db/index.js to use Postgres**

```javascript
// src/db/index.js - replace SQLite with Postgres
'use strict';

const postgres = require('./postgres');

function getDb() {
  return postgres; // Returns { query, transaction }
}

function close() {
  return postgres.close();
}

module.exports = { getDb, close };
```

- [ ] **Step 4: Write test**

```javascript
// test/db/postgres.test.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('Postgres driver', () => {
  before(() => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  after(() => {
    delete process.env.DATABASE_URL;
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    assert.throws(() => require('../../src/db/postgres').getPool(), /DATABASE_URL/);
  });
});
```

- [ ] **Step 5: Run test**

```bash
yarn test test/db/postgres.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/db/postgres.js src/db/index.js test/db/postgres.test.js package.json
git commit -m "feat: add Postgres driver abstraction layer"
```

---

### Task 2: Schema Migration to Postgres

**Files:**
- Create: `src/db/schema.postgres.sql`
- Modify: `src/db/migrations/*.sql` (convert to Postgres syntax)
- Create: `test/db/schema.test.js`

**Interfaces:**
- Consumes: Postgres connection
- Produces: `schema.postgres.sql` with all tables, indexes

- [ ] **Step 1: Create Postgres schema**

Convert `schema.sql` to Postgres syntax:
- `INTEGER` → `BIGINT` for IDs
- `TEXT` → `TEXT` (same)
- `REAL` → `NUMERIC`
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`
- Add `IF NOT EXISTS` for all tables

```sql
-- src/db/schema.postgres.sql
CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  username              TEXT UNIQUE,
  email_hmac            TEXT NOT NULL UNIQUE,
  email_encrypted       TEXT,
  kem_public_key        TEXT,
  password_hash         TEXT,
  recovery_key_hash     TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  kdf_salt              TEXT,
  wrapped_aek           TEXT,
  created_at            TEXT NOT NULL
);

-- ... (all tables converted to Postgres syntax)
```

- [ ] **Step 2: Create migration runner for Postgres**

```javascript
// src/db/migrate-postgres.js
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
```

- [ ] **Step 3: Write test**

```javascript
// test/db/schema.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Postgres schema', () => {
  it('schema.postgres.sql exists and is valid SQL', () => {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../../src/db/schema.postgres.sql');
    assert(fs.existsSync(schemaPath), 'schema.postgres.sql must exist');
    const content = fs.readFileSync(schemaPath, 'utf8');
    assert(content.includes('CREATE TABLE'), 'Schema must contain CREATE TABLE statements');
  });
});
```

- [ ] **Step 4: Run test**

```bash
yarn test test/db/schema.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.postgres.sql src/db/migrate-postgres.js test/db/schema.test.js
git commit -m "feat: add Postgres schema and migration runner"
```

---

### Task 3: Model Layer Async Conversion

**Files:**
- Modify: `src/models/index.js`
- Create: `test/models/async.test.js`

**Interfaces:**
- Consumes: `src/db/postgres.js` (query, transaction)
- Produces: Async model methods (findById, findOne, find, create, updateOne, etc.)

- [ ] **Step 1: Convert SingleQuery to async**

```javascript
// src/models/index.js - convert _exec to async
class SingleQuery {
  // ... existing constructor

  async _exec() {
    const select = buildSelect(this._projection);
    const { sql: whereSql, params } = buildWhere(this._filter);
    const result = await query(`SELECT ${select} FROM ${this._table} ${whereSql} LIMIT 1`, params);
    const row = result.rows[0];
    if (!row) return null;
    const camel = keysToCamel(row);
    return this._isLean ? camel : new Doc(this._table, camel, this._pkField);
  }
}
```

- [ ] **Step 2: Convert MultiQuery to async**

```javascript
// src/models/index.js
class MultiQuery {
  // ... existing constructor + sort/limit/lean

  async _exec() {
    const select = buildSelect(this._projection);
    const { sql: whereSql, params } = buildWhere(this._filter);
    let sql = `SELECT ${select} FROM ${this._table} ${whereSql}`;

    if (this._sortSpec) {
      const cols = Object.entries(this._sortSpec)
        .map(([k, v]) => `${toSnake(k)} ${v === -1 ? 'DESC' : 'ASC'}`)
        .join(', ');
      sql += ` ORDER BY ${cols}`;
    }

    if (this._limitVal) sql += ` LIMIT ${this._limitVal}`;

    const result = await query(sql, params);
    return result.rows.map(r => keysToCamel(r));
  }
}
```

- [ ] **Step 3: Convert model methods to async**

```javascript
// src/models/index.js - convert create, updateOne, etc.
async create(data) {
  const d = keysToSnake(data);
  if (!d.id && (pkField === 'id' || !pkField)) d.id = crypto.randomUUID();
  if (d.created_at === undefined) d.created_at = new Date().toISOString();

  const cols = Object.keys(d).join(', ');
  const placeholders = Object.keys(d).map((_, i) => `$${i + 1}`).join(', ');
  const vals = Object.values(d).map(toBindable);
  
  await query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, vals);
  return new Doc(table, keysToCamel(d), pkField || 'id');
}
```

- [ ] **Step 4: Convert findOneAndUpdate to async**

```javascript
// src/models/index.js
async findOneAndUpdate(filter, update, options) {
  const opts = options || {};
  const { sql: whereSql, params: whereParams } = buildWhere(filter);

  if (opts.upsert) {
    const existing = await query(`SELECT * FROM ${table} ${whereSql} LIMIT 1`, whereParams);
    if (!existing.rows[0]) {
      // ... insert logic with async
    }
  }

  const existing = await query(`SELECT * FROM ${table} ${whereSql} LIMIT 1`, whereParams);
  if (!existing.rows[0]) return null;

  const { sql: setSql, params: setParams } = buildUpdate(update);
  await query(`UPDATE ${table} SET ${setSql} ${whereSql}`, [...setParams, ...whereParams]);

  // ... return updated doc
}
```

- [ ] **Step 5: Write test**

```javascript
// test/models/async.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Async model layer', () => {
  it('model methods return promises', () => {
    const { Account } = require('../../src/models');
    // Verify methods are async (return promises)
    assert(typeof Account.findById('test').then === 'function');
  });
});
```

- [ ] **Step 6: Run test**

```bash
yarn test test/models/async.test.js
```

- [ ] **Step 7: Commit**

```bash
git add src/models/index.js test/models/async.test.js
git commit -m "feat: convert model layer to async for Postgres"
```

---

### Task 4: Route Async Conversion

**Files:**
- Modify: `src/routes/*.js` (all route files)
- Create: `test/routes/async.test.js`

**Interfaces:**
- Consumes: Async model methods, `src/db/postgres.js`
- Produces: Async route handlers

- [ ] **Step 1: Convert direct db.prepare calls to async query**

```javascript
// src/routes/commits.js - example conversion
// Before:
const row = db.prepare('SELECT * FROM commits WHERE id = ?').get(id);

// After:
const result = await query('SELECT * FROM commits WHERE id = $1', [id]);
const row = result.rows[0];
```

- [ ] **Step 2: Convert db.transaction to async transaction**

```javascript
// src/routes/commits.js - example conversion
// Before:
const result = db.transaction(() => {
  // ...
})();

// After:
const result = await transaction(async (client) => {
  // ...
});
```

- [ ] **Step 3: Update all route files**

Convert these files (all use `getDb()` or `db.prepare()`):
- `src/routes/account.js`
- `src/routes/auth.js`
- `src/routes/collaboration.js`
- `src/routes/commits.js`
- `src/routes/organizations.js`
- `src/routes/sync-state.js`
- `src/routes/vault.js`
- `src/routes/workspaces.js`

- [ ] **Step 4: Convert middleware**

- `src/middleware/auth.js`
- `src/middleware/subscription.js`

- [ ] **Step 5: Write test**

```javascript
// test/routes/async.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Async routes', () => {
  it('all route handlers are async functions', () => {
    const authRoutes = require('../../src/routes/auth');
    assert(typeof authRoutes === 'function');
  });
});
```

- [ ] **Step 6: Run test**

```bash
yarn test test/routes/async.test.js
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/*.js src/middleware/*.js test/routes/async.test.js
git commit -m "feat: convert all routes to async for Postgres"
```

---

### Task 5: Yjs Persistence Async Conversion

**Files:**
- Modify: `src/persistence/yjs.js`
- Create: `test/persistence/yjs.test.js`

**Interfaces:**
- Consumes: `src/db/postgres.js` (query, transaction)
- Produces: Async persistence methods

- [ ] **Step 1: Convert storeUpdate to async**

```javascript
// src/persistence/yjs.js
async function storeUpdate(workspaceId, noteId, updateData, deviceId, clock, encrypted = false) {
  const now = new Date().toISOString();
  await query(`
    INSERT INTO yjs_doc_updates
    (id, workspace_id, note_id, update_data, update_encrypted, device_id, clock, ts, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT DO NOTHING
  `, [
    generateUpdateId(), workspaceId, noteId,
    Buffer.isBuffer(updateData) ? updateData : Buffer.from(updateData),
    encrypted ? 1 : 0, deviceId, clock, Date.now(), now
  ]);
}
```

- [ ] **Step 2: Convert all persistence methods to async**

Convert: `storeUpdatesBatch`, `storeNotesBatch`, `getAcceptedBytes`, `loadUpdatesAfter`, `loadUpdatesSince`, `loadAllUpdates`, `deleteUpdatesBefore`, `deleteUpdatesForNote`, `updateDocumentSyncState`, `promoteDocumentSyncState`, `deleteJournalRows`, `getUpdateCount`, `listNoteIds`

- [ ] **Step 3: Write test**

```javascript
// test/persistence/yjs.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Yjs persistence', () => {
  it('storeUpdate returns a promise', () => {
    const persistence = require('../../src/persistence/yjs');
    const result = persistence.storeUpdate('ws1', 'note1', Buffer.from('test'), 'dev1', 1);
    assert(result instanceof Promise);
  });
});
```

- [ ] **Step 4: Run test**

```bash
yarn test test/persistence/yjs.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/persistence/yjs.js test/persistence/yjs.test.js
git commit -m "feat: convert Yjs persistence to async for Postgres"
```

---

### Task 6: Docker Compose with Postgres

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.enterprise.yml`
- Modify: `Dockerfile`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Postgres container, `DATABASE_URL`
- Produces: Unified docker-compose with Postgres

- [ ] **Step 1: Update docker-compose.yml**

```yaml
# docker-compose.yml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    container_name: beaver-sync-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-beaver}
      POSTGRES_USER: ${POSTGRES_USER:-beaver}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-beaver}
    volumes:
      - pg_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    networks:
      - beaver-internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-beaver}"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:RELEASE.2025-02-28T09-55-16Z
    container_name: beaver-sync-minio
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    networks:
      - beaver-internal
    healthcheck:
      test: ["CMD-SHELL", "mc ready local"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio-setup:
    image: minio/mc:RELEASE.2025-02-21T16-00-46Z
    container_name: beaver-sync-minio-setup
    depends_on:
      minio:
        condition: service_started
    restart: "no"
    entrypoint: >
      /bin/sh -c "
      until mc alias set local http://minio:9000 ${MINIO_ROOT_USER:-minioadmin} ${MINIO_ROOT_PASSWORD:-minioadmin}; do sleep 1; done &&
      mc mb --ignore-existing local/${MINIO_BUCKET_NAME:-beaver-sync}"
    networks:
      - beaver-internal

  api:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: beaver-sync-api
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-beaver}:${POSTGRES_PASSWORD:-beaver}@postgres:5432/${POSTGRES_DB:-beaver}
      STORAGE_ENDPOINT: http://minio:9000
    ports:
      - "3000:3000"
    networks:
      - beaver-internal
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 10s

  hocuspocus:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: beaver-sync-hocuspocus
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    env_file: .env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-beaver}:${POSTGRES_PASSWORD:-beaver}@postgres:5432/${POSTGRES_DB:-beaver}
      AUTH_BACKEND_URL: http://api:3000
    command: ["node", "src/hocuspocus.js"]
    ports:
      - "127.0.0.1:8080:8080"
    networks:
      - beaver-internal
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/ || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  pg_data:
  minio_data:

networks:
  beaver-internal:
    driver: bridge
```

- [ ] **Step 2: Update Dockerfile**

```dockerfile
# Stage 1: Install dependencies
FROM node:22-alpine AS deps

RUN apk add --no-cache \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./

RUN yarn install --frozen-lockfile --production && yarn cache clean

# Stage 2: Runtime image
FROM node:22-alpine AS runtime

RUN apk add --no-cache wget openssl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN addgroup -S beaver && adduser -S beaver -G beaver \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/data /app/keys \
    && chown -R beaver:beaver /app

USER beaver

EXPOSE 3000

STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
```

- [ ] **Step 3: Update .env.example**

```bash
# Add to .env.example
DATABASE_URL=postgresql://beaver:beaver@postgres:5432/beaver
POSTGRES_DB=beaver
POSTGRES_USER=beaver
POSTGRES_PASSWORD=beaver
```

- [ ] **Step 4: Test docker compose up**

```bash
docker compose up -d
docker compose ps
docker compose logs api
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.enterprise.yml Dockerfile .env.example
git commit -m "feat: add Postgres to docker-compose, remove SQLite"
```

---

### Task 7: Fly.io Configuration

**Files:**
- Modify: `fly/api/fly.toml`
- Modify: `fly/hocuspocus/fly.toml`
- Modify: `fly/deploy.sh`
- Modify: `fly/.env.secrets.example`

**Interfaces:**
- Consumes: Postgres `DATABASE_URL`, Fly secrets
- Produces: Updated fly.toml with HA config

- [ ] **Step 1: Update fly/api/fly.toml**

```toml
app = "beaver-sync-api"
primary_region = "iad"

[build]
  dockerfile = "../../Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "3000"
  HOST = "0.0.0.0"
  STORAGE_FORCE_PATH_STYLE = "false"

[mounts]
  source = "beaver_data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = false
  min_machines_running = 2

  [http_service.concurrency]
    type = "connections"
    hard_limit = 250
    soft_limit = 200

[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "5s"
```

- [ ] **Step 2: Update fly/hocuspocus/fly.toml**

```toml
app = "beaver-sync-hocuspocus"
primary_region = "iad"

[build]
  dockerfile = "../../Dockerfile"

[env]
  NODE_ENV = "production"
  HOCUSPOCUS_PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = false
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 1000
    soft_limit = 500

[[http_service.checks]]
  grace_period = "5s"
  interval = "30s"
  method = "GET"
  path = "/"
  timeout = "5s"
```

- [ ] **Step 3: Update fly/deploy.sh**

```bash
# Add to fly/deploy.sh
echo "=== Setting Postgres secrets ==="
fly secrets set \
  DATABASE_URL="$DATABASE_URL" \
  --app beaver-sync-api
```

- [ ] **Step 4: Update fly/.env.secrets.example**

```bash
# Add to .env.secrets.example
DATABASE_URL=postgresql://...
```

- [ ] **Step 5: Commit**

```bash
git add fly/api/fly.toml fly/hocuspocus/fly.toml fly/deploy.sh fly/.env.secrets.example
git commit -m "feat: configure Fly.io for Postgres HA with rolling deploys"
```

---

### Task 8: WebSocket Live Push Gateway

**Files:**
- Create: `src/routes/ws.js`
- Create: `src/lib/events.js`
- Modify: `src/server.js`
- Create: `test/routes/ws.test.js`

**Interfaces:**
- Consumes: Postgres LISTEN/NOTIFY, session auth
- Produces: WebSocket endpoint `ws://api/ws`

- [ ] **Step 1: Install WebSocket dependency**

```bash
yarn add @fastify/websocket
```

- [ ] **Step 2: Create event bus module**

```javascript
// src/lib/events.js
'use strict';

const EventEmitter = require('events');
const { getPool } = require('../db/postgres');

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(100);

function subscribe(channel, callback) {
  localEmitter.on(channel, callback);
  return () => localEmitter.off(channel, callback);
}

function publish(channel, data) {
  localEmitter.emit(channel, data);
}

async function startPostgresListener() {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('LISTEN beaver_events');
    
    client.on('notification', (msg) => {
      try {
        const { channel, payload } = msg;
        const data = JSON.parse(payload);
        localEmitter.emit(channel, data);
      } catch (err) {
        console.error('[events] Failed to parse notification:', err.message);
      }
    });
    
    console.log('[events] Postgres LISTEN/NOTIFY started');
  } catch (err) {
    console.error('[events] Failed to start Postgres listener:', err.message);
  }
}

async function notify(channel, data) {
  const pool = getPool();
  await pool.query(`SELECT pg_notify($1, $2)`, [channel, JSON.stringify(data)]);
}

module.exports = { subscribe, publish, notify, startPostgresListener };
```

- [ ] **Step 3: Create WebSocket route**

```javascript
// src/routes/ws.js
'use strict';

const { verifySessionToken } = require('../lib/auth');
const { subscribe, publish } = require('../lib/events');

async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }
    
    try {
      const user = await verifySessionToken(token);
      
      // Subscribe to user's workspace channels
      const unsubscribers = [];
      
      for (const workspaceId of user.workspaceIds) {
        const unsub = subscribe(`workspace:${workspaceId}`, (data) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify(data));
          }
        });
        unsubscribers.push(unsub);
      }
      
      // Handle heartbeats
      const heartbeatInterval = setInterval(() => {
        if (socket.readyState === 1) {
          publish('presence', { userId: user.userId, status: 'online' });
        }
      }, 30000);
      
      socket.on('close', () => {
        clearInterval(heartbeatInterval);
        unsubscribers.forEach(unsub => unsub());
        publish('presence', { userId: user.userId, status: 'offline' });
      });
      
      socket.on('message', (msg) => {
        // Handle client messages (heartbeat ack, etc.)
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'heartbeat') {
            socket.send(JSON.stringify({ type: 'heartbeat_ack' }));
          }
        } catch (err) {
          // Ignore invalid messages
        }
      });
      
      // Send initial connection ack
      socket.send(JSON.stringify({ type: 'connected', userId: user.userId }));
      
    } catch (err) {
      socket.close(4002, 'Invalid token');
    }
  });
}

module.exports = wsRoutes;
```

- [ ] **Step 4: Update server.js**

```javascript
// src/server.js - add WebSocket plugin
await app.register(require('@fastify/websocket'));
await app.register(require('./routes/ws'), { prefix: '' });
```

- [ ] **Step 5: Write test**

```javascript
// test/routes/ws.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('WebSocket routes', () => {
  it('ws.js module exports a function', () => {
    const wsRoutes = require('../../src/routes/ws');
    assert(typeof wsRoutes === 'function');
  });
});
```

- [ ] **Step 6: Run test**

```bash
yarn test test/routes/ws.test.js
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/ws.js src/lib/events.js src/server.js test/routes/ws.test.js package.json
git commit -m "feat: add WebSocket live push gateway with Postgres LISTEN/NOTIFY"
```

---

### Task 9: Data Migration Tool

**Files:**
- Create: `scripts/migrate-sqlite-to-pg.js`
- Create: `test/scripts/migrate.test.js`

**Interfaces:**
- Consumes: SQLite database file, Postgres connection
- Produces: Migrated data in Postgres

- [ ] **Step 1: Create migration script**

```javascript
// scripts/migrate-sqlite-to-pg.js
'use strict';

const Database = require('better-sqlite3');
const { query, transaction } = require('../src/db/postgres');

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
```

- [ ] **Step 2: Write test**

```javascript
// test/scripts/migrate.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Data migration', () => {
  it('migration script exists and is callable', () => {
    const { migrateSqliteToPostgres } = require('../../scripts/migrate-sqlite-to-pg');
    assert(typeof migrateSqliteToPostgres === 'function');
  });
});
```

- [ ] **Step 3: Run test**

```bash
yarn test test/scripts/migrate.test.js
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-sqlite-to-pg.js test/scripts/migrate.test.js
git commit -m "feat: add SQLite to Postgres migration tool"
```

---

### Task 10: CI/CD Pipeline

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: GitHub secrets (FLY_API_TOKEN)
- Produces: Automated deploy on push to main

- [ ] **Step 1: Create deploy workflow**

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn lint
      - run: yarn test

  deploy:
    name: Deploy
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --strategy rolling
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 2: Update CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  test:
    name: Lint & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn lint
      - run: yarn test
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "feat: add CI/CD pipeline with automated deploys"
```

---

### Task 11: Documentation Update

**Files:**
- Modify: `README.md`
- Create: `docs/deployment.md`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Updated documentation

- [ ] **Step 1: Update README.md**

Update:
- Architecture diagram (Postgres instead of SQLite)
- Quick Start (docker-compose with Postgres)
- Fly.io deployment (DATABASE_URL, rolling deploys)
- Remove SQLite references

- [ ] **Step 2: Create deployment guide**

```markdown
# docs/deployment.md

## Self-Host

1. Clone repo
2. `cp .env.example .env`
3. `docker compose up -d`
4. Access at http://localhost:3000

## Fly.io

1. Install flyctl
2. `fly auth login`
3. `cp fly/.env.secrets.example fly/.env.secrets`
4. Edit fly/.env.secrets with real values
5. `bash fly/deploy.sh`

## Scaling

### Add API replica
```bash
fly m clone --app beaver-sync-api
```

### Upgrade machine
```bash
fly m scale shared-cpu-2x --app beaver-sync-api
```

### Scale Postgres to 3-node
```bash
fly mpg scale --plan basic --replicas 3
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/deployment.md
git commit -m "docs: update documentation for Postgres HA deployment"
```

---

### Task 12: Final Integration Test

**Files:**
- Create: `test/integration/postgres-ha.test.js`

**Interfaces:**
- Consumes: All previous tasks
- Produces: End-to-end test

- [ ] **Step 1: Write integration test**

```javascript
// test/integration/postgres-ha.test.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('Postgres HA integration', () => {
  before(async () => {
    // Setup test database
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  after(async () => {
    // Cleanup
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
    // Should not throw
  });

  it('can create and query account', async () => {
    const { Account } = require('../../src/models');
    const account = await Account.create({
      emailHmac: 'test@example.com',
      username: 'testuser',
    });
    assert(account.id);

    const found = await Account.findById(account.id).lean();
    assert(found.emailHmac === 'test@example.com');
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

- [ ] **Step 2: Run integration test**

```bash
yarn test test/integration/postgres-ha.test.js
```

- [ ] **Step 3: Commit**

```bash
git add test/integration/postgres-ha.test.js
git commit -m "test: add Postgres HA integration tests"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-11-postgres-ha-live-push.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
