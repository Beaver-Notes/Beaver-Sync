#!/usr/bin/env bash
set -euo pipefail

# Beaver-Sync Fly.io Deploy Script
# Usage: bash fly/deploy.sh
#
# Prerequisites:
#   1. flyctl CLI installed and authenticated (fly auth login)
#   2. fly/.env.secrets configured with real values
#   3. DNS records pointing to Fly for your custom domain

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.secrets"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy .env.secrets.example to .env.secrets and fill in real values."
  exit 1
fi

# Source secrets into environment
set -a
source "$ENV_FILE"
set +a

# Validate required variables
required_vars=(
  COOKIE_SECRET SESSION_HMAC_KEY EMAIL_HMAC_KEY NOTE_HMAC_KEY MLKEM_SEED
  WEBAUTHN_RPID WEBAUTHN_ORIGIN APP_URL ALLOWED_ORIGINS
  R2_ENDPOINT R2_BUCKET_NAME R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  GLITCHTIP_DSN GLITCHTIP_SECRET_KEY
  JWT_PRIVATE_KEY_B64 JWT_PUBLIC_KEY_B64
)

missing=()
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing required secrets:"
  for var in "${missing[@]}"; do
    echo "   - $var"
  done
  exit 1
fi

echo "=== Creating Fly apps ==="
fly apps create beaver-sync-api --org "${FLY_ORG:-personal}" 2>/dev/null || true
fly apps create beaver-sync-hocuspocus --org "${FLY_ORG:-personal}" 2>/dev/null || true
fly apps create beaver-glitchtip --org "${FLY_ORG:-personal}" 2>/dev/null || true

echo "=== Creating volumes ==="
fly volumes create beaver_data --region iad --app beaver-sync-api --size 1 2>/dev/null || true
fly volumes create glitchtip_data --region iad --app beaver-glitchtip --size 1 2>/dev/null || true

echo "=== Setting API secrets ==="
fly secrets set \
  COOKIE_SECRET="$COOKIE_SECRET" \
  SESSION_HMAC_KEY="$SESSION_HMAC_KEY" \
  EMAIL_HMAC_KEY="$EMAIL_HMAC_KEY" \
  NOTE_HMAC_KEY="$NOTE_HMAC_KEY" \
  MLKEM_SEED="$MLKEM_SEED" \
  WEBAUTHN_RPID="$WEBAUTHN_RPID" \
  WEBAUTHN_ORIGIN="$WEBAUTHN_ORIGIN" \
  APP_URL="$APP_URL" \
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
  R2_ENDPOINT="$R2_ENDPOINT" \
  R2_BUCKET_NAME="$R2_BUCKET_NAME" \
  R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}" \
  STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}" \
  RESEND_API_KEY="${RESEND_API_KEY:-}" \
  GLITCHTIP_DSN="$GLITCHTIP_DSN" \
  --app beaver-sync-api

echo "=== Setting Hocuspocus secrets ==="
fly secrets set \
  AUTH_BACKEND_URL="http://beaver-sync-api.internal:3000" \
  GLITCHTIP_DSN="$GLITCHTIP_DSN" \
  --app beaver-sync-hocuspocus

echo "=== Setting GlitchTip secrets ==="
fly secrets set \
  SECRET_KEY="$GLITCHTIP_SECRET_KEY" \
  --app beaver-glitchtip

echo "=== Deploying API ==="
fly deploy "$SCRIPT_DIR/api/" --app beaver-sync-api --strategy immediate

echo "=== Initializing JWT keys on volume ==="
fly ssh console --app beaver-sync-api -C "
  mkdir -p /app/keys &&
  printf '%s' '$JWT_PRIVATE_KEY_B64' | base64 -d > /app/keys/jwt.pem &&
  printf '%s' '$JWT_PUBLIC_KEY_B64' | base64 -d > /app/keys/jwt.pub &&
  chmod 600 /app/keys/jwt.pem &&
  chmod 644 /app/keys/jwt.pub &&
  echo 'JWT keys written'
"

echo "=== Deploying Hocuspocus ==="
fly deploy "$SCRIPT_DIR/hocuspocus/" --app beaver-sync-hocuspocus --strategy immediate

echo "=== Deploying GlitchTip ==="
fly deploy "$SCRIPT_DIR/glitchtip/" --app beaver-glitchtip --strategy immediate

echo "=== Configuring custom domain ==="
fly certs create "$WEBAUTHN_RPID" --app beaver-sync-api 2>/dev/null || true

echo ""
echo "=== Deploy complete ==="
echo "API:         https://$WEBAUTHN_RPID"
echo "Hocuspocus:  wss://$WEBAUTHN_RPID (WebSocket)"
echo "GlitchTip:   internal only (http://beaver-glitchtip.internal:8000)"
echo ""
echo "Health checks:"
fly status --app beaver-sync-api
fly status --app beaver-sync-hocuspocus
fly status --app beaver-glitchtip
