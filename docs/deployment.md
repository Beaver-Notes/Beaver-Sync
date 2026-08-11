# Deployment Guide

## Self-Host

1. Clone repo
2. `cp .env.example .env`
3. Edit `.env` — set `COOKIE_SECRET`, `SESSION_HMAC_KEY`, `EMAIL_HMAC_KEY`, `NOTE_HMAC_KEY` (min 32 chars each)
4. `bash scripts/generate-keys.sh`
5. `docker compose up -d`
6. Access at http://localhost:3000

The stack includes Postgres, MinIO (object storage), API, and Hocuspocus (WebSocket). Data persists in Docker volumes.

### Enterprise Self-Host

```bash
cp .env.example .env
# Set ENTERPRISE_MODE=true and LICENSE_SECRET in .env
docker compose -f docker-compose.enterprise.yml up -d
```

Adds GlitchTip (error monitoring) to the stack. All features work offline.

## Fly.io

### Prerequisites

1. [Fly.io](https://fly.io) account + `flyctl` CLI installed
2. Cloudflare R2 bucket created with API token
3. DNS records pointing to Fly for your custom domain
4. Fly Postgres cluster (or external Postgres)

### Deploy

```bash
# 1. Install flyctl and authenticate
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Configure secrets
cp fly/.env.secrets.example fly/.env.secrets
# Edit fly/.env.secrets with real values (including DATABASE_URL)

# 3. Run deploy script
bash fly/deploy.sh
```

The deploy script:
- Creates Fly apps (API, Hocuspocus, GlitchTip)
- Sets all secrets via `fly secrets set`
- Deploys with rolling strategy (`--strategy immediate`)
- Initializes JWT keys on the API volume
- Configures your custom domain TLS certificate

### Update

```bash
# Deploy individual services
fly deploy fly/api/
fly deploy fly/hocuspocus/
fly deploy fly/glitchtip/
```

### Rollback

```bash
fly releases rollback -a <app-name>
```

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

## Monitor

```bash
fly logs -a beaver-sync-api
fly status --app beaver-sync-api
```
