# Deployment Guide

## Self-Host

1. Clone repo
2. `cp .env.example .env`
3. Edit `.env` — set `COOKIE_SECRET`, `SESSION_HMAC_KEY`, `EMAIL_HMAC_KEY`, `NOTE_HMAC_KEY` (min 32 chars each)
4. `bash scripts/generate-keys.sh`
5. `docker compose up -d`
6. Access at http://localhost:4000

The stack includes Postgres, MinIO (object storage), the API, the WebSocket relay (`ws-relay`, port 8080), and a scheduled Postgres backup sidecar. Data persists in Docker volumes.

### Enterprise Self-Host

```bash
cp .env.example .env
# Set ENTERPRISE_MODE=true, LICENSE_SECRET and LICENSE_KEY in .env
# Generate a license: LICENSE_SECRET=$(openssl rand -hex 32) node scripts/generate-license.js --licensee "Acme" --expiry 2027-08-30 --seats 50
docker compose -f docker-compose.enterprise.yml up -d
```

Adds GlitchTip (error monitoring) to the stack. Licenses are offline HMAC (`BL<base64url(payload)>.<base64url(HMAC)>)`, canonical JSON `{licensee, plan:'enterprise', seats?, expiry}`), timing-safe verified, 14-day grace after expiry, seats soft-warn. In development `ENTERPRISE_MODE=true` alone unlocks enterprise; in production (`NODE_ENV=production`) a valid `LICENSE_KEY` is required — `ENTERPRISE_MODE=true` alone is insufficient. Only `src/lib/license.js` reads `LICENSE_SECRET` at runtime; `scripts/generate-license.js` is excluded from images via `.dockerignore`.

## VPS Deployment

### Prerequisites

1. A VPS with Docker + Docker Compose
2. DNS records pointing your domain at the VPS
3. External or co-located Postgres reachable via `DATABASE_URL`
4. Cloudflare R2 bucket (or self-hosted MinIO) for blob storage

### Deploy

```bash
# 1. Configure secrets
cp .env.example .env
bash scripts/generate-keys.sh   # JWT signing keys + ML-KEM seed
# Edit .env with real values (including DATABASE_URL)

# 2. Start the stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

CI/CD: on push to `main`, GitHub Actions runs lint + tests against Postgres, then — when the repo variable `DEPLOY_TARGET=vps` is set and secrets `VPS_HOST` / `VPS_USERNAME` / `VPS_SSH_KEY` are configured — pulls and redeploys on the VPS over SSH.

### Update / Rollback

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Rollback: check out the previous release tag/commit and redeploy the same way. Both processes handle SIGTERM gracefully (in-flight Yjs persists are flushed before exit).

### Scaling

The API is stateless and scales horizontally via the scale overlay, which adds Redis as the shared rate-limit store:

```bash
export REDIS_URL=redis://redis:6379
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale api=3
```

The WebSocket relay must remain a single instance — collaboration rooms live in memory (`ws-relay.js`). Caddy's sticky-cookie routing keeps clients pinned to it; do not run multiple relay replicas without adding a room-routing layer first.

### Backups

The `pg-backup` sidecar dumps Postgres on a schedule:

- `BACKUP_INTERVAL_SECONDS` — cadence (set `0` to disable)
- `BACKUP_RETENTION_DAYS` — prune window (newest dump always kept)
- Dumps land in `./backups` as gzipped `pg_dump` files

Restore drill (run quarterly):

```bash
scripts/restore-postgres.sh backups/pg-<timestamp>.sql.gz <scratch-db>
```

### Monitor

```bash
docker compose logs -f api ws-relay
docker compose ps
curl -fsS http://localhost:4000/health   # 503 when the DB is unreachable
```
