#!/usr/bin/env bash
# restore-postgres.sh — restore a pg_dump created by backup-postgres.sh.
#   ./scripts/restore-postgres.sh ./backups/pg-20250101T000000Z.sql.gz
# Env: DATABASE_URL or POSTGRES_* (same as backup). Prompts before overwriting.
set -euo pipefail
if [ $# -ne 1 ]; then
  echo "usage: $0 <dump.sql.gz>" >&2; exit 2
fi
DUMP="$1"
if [ ! -f "$DUMP" ]; then echo "not found: $DUMP" >&2; exit 2; fi
if [ -n "${DATABASE_URL:-}" ]; then
  export PGSSLMODE="${PGSSLMODE:-disable}"
  CONN="$DATABASE_URL"
else
  CONN="postgresql://${POSTGRES_USER:-beaver}:${POSTGRES_PASSWORD:-beaver}@postgres:5432/${POSTGRES_DB:-beaver}"
fi
echo "[restore] will restore $DUMP into $CONN"
read -rp "Type 'yes' to continue: " ans
if [ "$ans" != "yes" ]; then echo "aborted"; exit 1; fi
gzip -dc "$DUMP" | psql "$CONN"
echo "[restore] done — restart api/ws-relay if running via compose"
