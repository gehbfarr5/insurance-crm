#!/usr/bin/env bash
set -euo pipefail

# Daily encrypted PostgreSQL backup with 14-day retention & optional offsite upload.
BACKUP_DIR="${BACKUP_DIR:-/var/backups/insurance-crm}"
CONTAINER_NAME="${PG_CONTAINER:-insurance-crm-postgres}"
PG_USER="${POSTGRES_USER:-crm}"
PG_DB="${POSTGRES_DB:-insurance_crm}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/insurance-crm/backup.passphrase}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [[ ! -f "$PASSPHRASE_FILE" ]]; then
  echo "Missing backup passphrase file: $PASSPHRASE_FILE" >&2
  exit 1
fi

install -d -m 0700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/insurance_crm_${STAMP}.sql.gz.enc"

docker exec "$CONTAINER_NAME" pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass "file:${PASSPHRASE_FILE}" -out "$OUT_FILE"

chmod 0600 "$OUT_FILE"

if [[ -n "${OFFSITE_UPLOAD_CMD:-}" ]]; then
  # Example: OFFSITE_UPLOAD_CMD="rclone copy --quiet" -> invoked with file argument
  ${OFFSITE_UPLOAD_CMD} "$OUT_FILE"
fi

find "$BACKUP_DIR" -name 'insurance_crm_*.sql.gz.enc' -type f -mtime +"$RETENTION_DAYS" -delete
echo "Encrypted backup created: $(basename "$OUT_FILE")"
