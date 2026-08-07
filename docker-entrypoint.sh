#!/bin/sh
set -e

# Auto-generate JWT keys if LEGACY_AUTH_ENABLED=true and keys are missing
if [ "$LEGACY_AUTH_ENABLED" = "true" ]; then
  PRIV="${JWT_PRIVATE_KEY_PATH:-./keys/private.pem}"
  PUB="${JWT_PUBLIC_KEY_PATH:-./keys/public.pem}"
  if [ ! -f "$PRIV" ] || [ ! -f "$PUB" ]; then
    DIR="$(dirname "$PRIV")"
    # Try to generate — skip if directory is read-only (bind mount)
    if mkdir -p "$DIR" 2>/dev/null && touch "$DIR/.write-test" 2>/dev/null; then
      rm -f "$DIR/.write-test"
      echo "JWT keys missing — generating..."
      openssl genrsa -out "$PRIV" 2048 2>/dev/null
      openssl rsa -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
      echo "JWT keys generated."
    else
      echo "WARNING: Keys directory is read-only and JWT keys are missing."
      echo "  Mount keys from host or generate them before starting the container."
    fi
  fi
fi

exec "$@"
