# Deployment Guide

## Self-Host

1. Clone repo
2. `cp .env.example .env`
3. Edit `.env` — set `COOKIE_SECRET`, `SESSION_HMAC_KEY`, `EMAIL_HMAC_KEY`, `NOTE_HMAC_KEY` (min 32 chars each)
4. `bash scripts/generate-keys.sh`
5. `docker compose up -d`
6. Access at http://localhost:4000

The stack includes Postgres, SeaweedFS (object storage), the API, the WebSocket relay (`ws-relay`, port 8080), and a scheduled Postgres backup sidecar. Data persists in Docker volumes.

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
4. SeaweedFS or a Cloudflare R2 bucket for blob storage

### Deploy

```bash
# 1. Configure secrets
cp .env.example .env
bash scripts/generate-keys.sh   # JWT signing keys + ML-KEM seed
# Edit .env with real values (including DATABASE_URL)

# 2. Start the stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

CI/CD: on push to `main`, GitHub Actions runs lint + tests against Postgres, builds the `api` and `ws-relay` images and pushes them to GHCR, then — when the repo variable `DEPLOY_TARGET=digitalocean` is set and the `DIGITALOCEAN_*` secrets are configured — pulls those images and redeploys over SSH. See [DigitalOcean deployment](#digitalocean-deployment).

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

With `REDIS_URL` set, the WebSocket relay also scales horizontally (`src/ws-relay-redis.js` publishes Yjs/awareness broadcasts via Redis pub/sub `beaver:ws-relay`); fan-out falls back to in-memory when Redis is absent. Without `REDIS_URL`, keep `ws-relay` at one replica (rooms live in memory).

```bash
# scaled relay (requires REDIS_URL)
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.scale.yml up -d --scale api=3 --scale ws-relay=2
```

### Database — PgBouncer

Direct Postgres Pool is `max:20` (`DATABASE_POOL_MAX`, `src/db/postgres.js:19`). When DB queue wait p95 >50ms, front Postgres with PgBouncer (transaction mode) and point `DATABASE_URL` at the bouncer; lower `DATABASE_POOL_MAX` to 5–10 per app replica. No code change needed — `pg` Pool works transparently through the bouncer.

## DigitalOcean deployment

Production runs on a DigitalOcean droplet with the stack deployed over SSH from GitHub Actions. Blob storage is Cloudflare R2, not the self-hosted SeaweedFS used for local development — see [Cloudflare R2 storage](#cloudflare-r2-storage).

### Droplet setup

One-time, as a user that can write to `/opt`:

```bash
git clone <repo-url> /opt/beaver-sync
# Docker Engine with the compose plugin: https://docs.docker.com/compose/install/
```

Then create `/opt/beaver-sync/.env` (gitignored, loaded by `docker-compose.prod.yml` via `env_file`). At minimum it needs:

```bash
# Secrets — 32+ chars each, rejected at startup if left at .env.example defaults
SESSION_HMAC_KEY=...
EMAIL_HMAC_KEY=...
COOKIE_SECRET=...
NOTE_HMAC_KEY=...
INTERNAL_API_SECRET=...

# WebAuthn passkeys
WEBAUTHN_RPID=example.com
WEBAUTHN_ORIGIN=https://example.com

# Cloudflare R2
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_BUCKET_NAME=beaver-sync
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
```

Generating the secret half is a single paste on the droplet — everything it writes is hex, so no `$` or `#` can be mangled by compose interpolation. Empty feature blocks disable that feature; the API does not require them.

```bash
cd /opt/beaver-sync
umask 077
cat > .env <<EOF
# ── Core ──────────────────────────────────────────────
APP_URL=https://api.example.com
ALLOWED_ORIGINS=https://app.example.com
TRUST_PROXY=true

# ── Postgres (bundled container; first boot only) ─────
POSTGRES_PASSWORD=$(openssl rand -hex 24)

# ── Secrets ───────────────────────────────────────────
SESSION_HMAC_KEY=$(openssl rand -hex 32)
EMAIL_HMAC_KEY=$(openssl rand -hex 32)
COOKIE_SECRET=$(openssl rand -hex 32)
NOTE_HMAC_KEY=$(openssl rand -hex 32)
INTERNAL_API_SECRET=$(openssl rand -hex 32)
LINK_TOKEN_SECRET=$(openssl rand -hex 32)
MLKEM_SEED=$(openssl rand -hex 64)
INBOUND_WEBHOOK_SECRET=$(openssl rand -hex 32)

# ── Auth ──────────────────────────────────────────────
LEGACY_AUTH_ENABLED=true
WEBAUTHN_RPID=example.com
WEBAUTHN_ORIGIN=https://app.example.com
WEBAUTHN_RP_NAME=Beaver Notes

# ── Cloudflare R2 ─────────────────────────────────────
STORAGE_BACKEND=cloudflare-r2
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_BUCKET_NAME=beaver-sync
STORAGE_ACCESS_KEY_ID=<r2-key-id>
STORAGE_SECRET_ACCESS_KEY=<r2-secret>
STORAGE_PUBLIC_ENDPOINT=https://pub-<hash>.r2.dev

# ── Email ─────────────────────────────────────────────
# Sending is ON unless this is exactly "false" (src/lib/email.js:82).
EMAIL_ENABLED=true
RESEND_API_KEY=<re_...>
RESEND_FROM_ADDRESS=noreply@example.com
NOTIFY_DOMAIN=notify.example.com

# ── Stripe (omit to disable checkout) ─────────────────
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER_MONTHLY=
STRIPE_PRICE_STARTER_YEARLY=
STRIPE_PRICE_PRO_MONTHLY=
STRIPE_PRICE_PRO_YEARLY=
STRIPE_PRICE_TEAM_MONTHLY=
STRIPE_PRICE_TEAM_YEARLY=

# ── Apple / Google IAP (omit to disable) ──────────────
# Verification uses Apple's own cert chain and Google's Pub/Sub OIDC token;
# no .p8 or service-account file is read by the API.
APPLE_BUNDLE_ID=
APPLE_PRODUCT_STARTER=
APPLE_PRODUCT_PRO=
APPLE_PRODUCT_TEAM=
GOOGLE_PRODUCT_STARTER=
GOOGLE_PRODUCT_PRO=
GOOGLE_PRODUCT_TEAM=

# ── Backups ───────────────────────────────────────────
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=14
# BACKUP_S3_TARGET=s3://beaver-backups/pg
# BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

# ── Monitoring (optional) ─────────────────────────────
GLITCHTIP_DSN=
EOF
```

Then replace the `<...>` placeholders and check the result resolves before involving CI:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q && echo ok
```

`APP_URL` is also the expected audience of the Google Pub/Sub push token (`${APP_URL}/webhooks/google`), so a trailing slash or the web app's host silently breaks Android IAP.

Do not set `DATABASE_URL` here: `docker-compose.prod.yml` computes it from `POSTGRES_PASSWORD` and points it at the `postgres` service. Setting `POSTGRES_PASSWORD` after the `pg_data` volume exists has no effect — Postgres only reads it on first init — so a rotated password means `ALTER USER` or destroying the volume.

`src/server.js` validates the secrets at startup and exits on anything missing; the JWT keys are generated into the `beaver_data` volume by `docker-entrypoint.sh` on first boot unless `LEGACY_AUTH_ENABLED=false`. Back up that volume: it also holds `MLKEM_SEED` if you leave the variable unset, and the seed is the only way back into encrypted metadata.



Caddy terminates TLS on ports 80 and 443, so the droplet firewall and any DigitalOcean load balancer must allow both. Point DNS at the droplet before the first deploy so Caddy can obtain a certificate.

Size the droplet at the 2 GB tier. The same compose files also carry per-service memory ceilings set deliberately below what each service could consume, so a leak in one process shows up as that container being killed instead of the whole host going under.

### GitHub Actions

The `deploy` job in `.github/workflows/deploy.yml` is gated on the repository variable `DEPLOY_TARGET` being set to `digitalocean`. Set these repository secrets:

| Secret | Value |
| --- | --- |
| `DIGITALOCEAN_HOST` | Droplet public IPv4 |
| `DIGITALOCEAN_SSH_USER` | SSH user (e.g. `root`) |
| `DIGITALOCEAN_SSH_KEY` | Private key for that user |
| `GHCR_TOKEN` | PAT with `read:packages` — only if the GHCR packages are private |

On a push to `main` the `build` job builds both images on the runner and pushes `ghcr.io/<owner>/<repo>/api` and `.../ws-relay`, tagged with the commit SHA and `latest`. The `deploy` job then SSHes in, runs `git pull --ff-only` in `/opt/beaver-sync`, pulls just those two images, and runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build api ws-relay postgres pg-backup caddy` before pruning images. Nothing compiles on the droplet, which is what keeps a 1 vCPU / 2 GB box from running out of memory mid-deploy. SeaweedFS is left out of every service list, so the droplet runs no local object store; `docker-compose.prod.yml` also clears the `seaweedfs` dependency the base file gives `api`, so R2 is the only store.

Rolling back means redeploying an earlier SHA, so `API_IMAGE` / `WS_IMAGE` can be pinned by hand when CI is not the fastest route:

```bash
cd /opt/beaver-sync
API_IMAGE=ghcr.io/<owner>/<repo>/api:<sha> WS_IMAGE=ghcr.io/<owner>/<repo>/ws-relay:<sha> \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml pull api ws-relay
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build api ws-relay
```

Leaving `API_IMAGE` unset falls back to `beaver-sync-api:local` and builds on the host, which is the self-host path and will exhaust a small droplet.


A droplet missing any of the four R2 variables fails at `docker compose up` with the message compose prints, rather than starting an API that cannot reach storage.

### Rollback

Get the current state first:

```bash
docker ps                                  # what is actually running right now
```

The last workflow run log ends with a `deployed <sha> <timestamp>` line — read it in the Actions UI (Deploy → Deploy to DigitalOcean) to know which commit shipped and when.

To go back to the previous good commit, work inside the clone on the droplet:

```bash
cd /opt/beaver-sync
git checkout <previous-good-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build api ws-relay postgres pg-backup caddy
git checkout main
```

Return to the branch as shown before the next deploy — a `git pull --ff-only` fails while the clone is on a detached HEAD.

If the previous build's images were already pruned, that does not block the rollback: check out the previous sha and let `--build` rebuild the images from it. Never try to restore an image id from `/opt/beaver-sync/.beaver-previous-api-image`; rebuilding from a known-good sha is the recovery path.

A rollback never touches Postgres or the R2 bucket. These deploys change no database schema, and blobs are content-addressed by the API, so the same objects keep resolving from R2 after the older build comes back.

Because the deploy waits for the api and caddy health checks and runs under `set -e`, a bad build fails on the droplet instead of being silently left in place; the `deployed` line in the log plus the clone's git history is the record of what shipped.

### Cloudflare R2 storage

- `STORAGE_ENDPOINT` is `https://<account-id>.r2.cloudflarestorage.com`.
- Keep `STORAGE_FORCE_PATH_STYLE` off (the prod default) — R2 rejects path-style addressing.
- `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` come from an R2 API token with Object Read & Write on that bucket.
- Bucket contents stay private; the API issues presigned URLs for access.

For offsite Postgres dumps to R2, see [Offsite backups to Cloudflare R2](#offsite-backups-to-cloudflare-r2).

### Backups

The `pg-backup` sidecar dumps Postgres on a schedule:

- `BACKUP_INTERVAL_SECONDS` — cadence (set `0` to disable)
- `BACKUP_RETENTION_DAYS` — prune window (newest dump always kept)
- Dumps land in `./backups` as gzipped `pg_dump` files

Restore drill (run quarterly):

```bash
scripts/restore-postgres.sh backups/pg-<timestamp>.sql.gz <scratch-db>
```

#### Offsite backups to Cloudflare R2

`scripts/backup-postgres.sh` already copies each dump to S3 when `BACKUP_S3_TARGET` is set; point it at R2 and run it from a host cron entry, as a user allowed to install packages, that installs the AWS CLI when missing before calling the script.

Set `BACKUP_S3_TARGET` to the R2 destination in s3 form, for example `s3://<bucket>/<prefix>`, and `BACKUP_S3_ENDPOINT` to `https://<account-id>.r2.cloudflarestorage.com`. `BACKUP_RETENTION_DAYS` applies to the local copies only; R2 retention is managed in the bucket.

Two prerequisites. An R2 API token must be present in the environment the script runs with, as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` readable by that user. And `scripts/backup-postgres.sh` calls `aws s3 cp` only when the aws CLI is on PATH, which is why the cron runs on the host rather than inside the pg-backup sidecar — the sidecar image is `postgres:16-alpine` and deliberately ships no AWS CLI.

### Monitor

```bash
docker compose logs -f api ws-relay
docker compose ps
curl -fsS http://localhost:4000/health   # 503 when the DB is unreachable
```
