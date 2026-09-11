# Key & Secret Rotation Runbook

All commands assume the single-VPS docker compose deployment
(`docker-compose.yml` + `docker-compose.prod.yml`). After any rotation:
`docker compose up -d` to pick up new `.env` values.

## Summary

| Secret | Users logged out? | Downtime |
|---|---|---|
| JWT `keys/private.pem`/`public.pem` | **Yes** | none |
| `COOKIE_SECRET` | **Yes** | none |
| `SESSION_HMAC_KEY` | **Yes** | existing signed asset URLs break until refetched |
| `EMAIL_HMAC_KEY` | No | old notify aliases stop resolving |
| `INTERNAL_API_SECRET` | No | relay auth fails unless api+ws-relay updated together |
| MinIO credentials | No | brief asset errors during restart |
| Postgres credentials | No | brief DB errors during restart |

---

## 1. JWT signing keys (`keys/private.pem`, `keys/public.pem`)

Written at deploy by `scripts/generate-keys.sh` (RSA-4096); paths configured
via `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` (`/app/keys/*.pem` in
containers; Fly deploys initialize them on the API volume).

```bash
openssl genrsa -out keys/private.pem.new 4096
openssl rsa -in keys/private.pem.new -pubout -out keys/public.pem.new
mv keys/private.pem.new keys/private.pem && mv keys/public.pem.new keys/public.pem
docker compose restart api ws-relay
```

**Logs every user out**: all outstanding JWTs were signed with the old key
and fail verification against the new public key. Clients must re-authenticate.
There is no dual-key verification window; schedule rotation accordingly.

Never commit `keys/*.pem`.

## 2. `COOKIE_SECRET`

Signs session cookies. Rotating invalidates all session cookies.

```bash
# .env: COOKIE_SECRET=$(openssl rand -hex 32)
docker compose up -d api
```

**Logs every user out.**

## 3. `SESSION_HMAC_KEY` (min 32 chars)

Used for session token HMACs **and** asset URL signing (`src/lib/asset-sign.js`).

```bash
# .env: SESSION_HMAC_KEY=$(openssl rand -hex 32)
docker compose up -d api ws-relay
```

**Logs every user out.** Previously issued presigned asset URLs stop
verifying and return 401 until the client re-requests fresh URLs.

## 4. `EMAIL_HMAC_KEY` (min 32 chars)

Derives hashed email notify aliases. Does **not** log anyone out.

```bash
# .env: EMAIL_HMAC_KEY=$(openssl rand -hex 32)
docker compose up -d api
```

Consequence: previously generated alias addresses no longer resolve to their
accounts. Only rotate when alias compromise is suspected.

## 5. `INTERNAL_API_SECRET` (required in production, min 32 chars)

Authenticates ws-relay -> API calls (`X-Internal-Secret` header on
`/auth/verify-session` and `/auth/verify-ticket`) and webhook verification.

Rotation must update **api and ws-relay in the same step** — a mismatch makes
every WebSocket upgrade fail authentication:

```bash
# .env: INTERNAL_API_SECRET=$(openssl rand -hex 32)
docker compose up -d api ws-relay   # same command recreates both with the new value
```

If running the scale overlay, also restart every API replica.

## 6. MinIO credentials

Two pairs exist: `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (the MinIO server
itself) and `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` (what the API
uses; prod may instead use `S3_*` or `R2_*` aliases).

1. Create a new service account via `mc admin user svcacct add` (or console).
2. Update `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` in `.env`.
3. `docker compose up -d api`
4. Verify uploads work, then remove the old service account.
5. For root-credential rotation, change `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`
   and recreate the minio container — data volumes are unaffected.

No logouts; brief asset 5xx while the API restarts.

## 7. Postgres credentials

Change the password in the database first, then the app config:

```bash
docker compose exec postgres psql -U beaver -d beaver \
  -c "ALTER USER beaver WITH PASSWORD 'NEW_PASSWORD';"
# .env: DATABASE_URL=postgresql://beaver:NEW_PASSWORD@localhost:5432/beaver
#       POSTGRES_PASSWORD=NEW_PASSWORD
docker compose up -d api ws-relay pg-backup
```

The pg-backup sidecar uses the same credentials; include it or nightly dumps
start failing silently. No logouts; in-flight requests error during the
restart window.

## What never rotates casually

- `MLKEM_SEED` (`keys/mlkem-seed.hex`) — derives the E2E encryption keys.
  Rotating it means re-encrypting everything client-side; losing it loses
  all data. Treat as permanent infrastructure.
