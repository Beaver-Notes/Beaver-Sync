#!/usr/bin/env bash
# backup-postgres.sh — compressed pg_dump + retention pruning.
# Runs inside the pg-backup container (pg_dumpall available); also safe to run
# directly on the VPS host (requires psql/pg_dump installed + DATABASE_URL or
# POSTGRES_* env). Intended to be polled by the backup sidecar / cron.
#
# Env (all optional, defaults for `docker compose up -d`):
#   POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, DATABASE_URL,
#   BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (default 14)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

# Prefer DATABASE_URL if set (VPS prod); otherwise compose convention.
if [ -n "${DATABASE_URL:-}" ]; then
  # Force plain auth via URL; disable sslmode mismatch noise.
  export PGSSLMODE="${PGSSLMODE:-disable}"
  CONN="$DATABASE_URL"
else
  CONN="postgresql://${POSTGRES_USER:-beaver}:${POSTGRES_PASSWORD:-beaver}@postgres:5432/${POSTGRES_DB:-beaver}"
fi

OUT="$BACKUP_DIR/pg-$TS.sql.gz"
echo "[backup] dumping to $OUT (retention ${RETENTION_DAYS}d)"
pg_dump "$CONN" | gzip -9 >"$OUT"
echo "[backup] wrote $(du -h "$OUT" | cut -f1) compressed"

# Prune files older than retention; keep at least the newest dump regardless.
if [ "$RETENTION_DAYS" -ge 0 ] 2>/dev/null; then
  OLDEST="$(ls -1t "$BACKUP_DIR"/pg-*.sql.gz 2>/dev/null | tail -n+2 || true)"
  if [ -n "$OLDEST" ]; then
    echo "[backup] pruning dumps older than ${RETENTION_DAYS}d (never deletes newest)"
    find "$BACKUP_DIR" -name 'pg-*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete || true
  fi
fi

echo "[backup] done"
