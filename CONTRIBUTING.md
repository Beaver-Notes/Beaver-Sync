# Contributing

## Prerequisites

- Node.js (see `engines`/CI for the version in use) with npm
- Docker Compose — provides Postgres and MinIO locally
- A local Postgres and MinIO must be reachable for the test suite

## Setup

```bash
cp .env.example .env        # then edit secrets (min 32 chars each)
bash scripts/generate-keys.sh   # writes keys/private.pem + keys/public.pem (never commit)
docker compose up -d postgres minio   # or the full stack: docker compose up -d
npm install
npm run dev                 # nodemon on src/server.js; API on PORT (default 3000, compose maps 4000)
```

## Running tests

```bash
docker compose up -d postgres minio   # tests need real local Postgres + MinIO
npm test
```

- `npm test` runs `node --test --test-concurrency=1`. **Keep
  `--test-concurrency=1`** — suites share one database and are not
  parallel-safe.
- Tests run against a dedicated `beaver_test` database (override with
  `TEST_DATABASE_URL`). The suite **refuses to start** unless the database
  name ends in `_test`, so an exported prod `DATABASE_URL` can never be
  wiped.
- Single file: `node --test --test-concurrency=1 test/<file>.test.js`

## Test suite rule

Every test entry point must require `test/helpers/db` **before** requiring
anything under `src/server`:

```js
const { setupTestDb } = require('./helpers/db');
const { buildApp } = require('../src/server');
```

`test/helpers/db.js` pins `DATABASE_URL` to the `_test` database, forces the
storage endpoint to localhost, and strips dev `.env` leakage (`PLAN_OVERRIDE`,
public endpoint). Requiring it late means app modules may already have
captured the wrong env at import time.

## Lint

```bash
npm run lint    # eslint src/
```

## Commit conventions

Short imperative subjects, Conventional-Commit-ish prefixes as seen in the
log:

- `feat:` new capability (`feat: add resolveConfig() for auto-derived production defaults`)
- `fix:` bug fix, optionally scoped — `fix(security): ...`, `fix(perf/H3): ...`
- `refactor:` behavior-preserving cleanup, optionally tagged with the ADR it implements — `refactor(ADR-1): extract ... into src/repositories`
- `chore:` tooling/deps

## Branch flow

- Work happens on `feat/*` branches, merged to `main`.
- CI runs test + deploy on push to `main`; keep branches green before merging.

## Docs

Architecture decisions live in `docs/adr/` (MADR style — copy the template in
0001). Operational runbooks live in `docs/`.
