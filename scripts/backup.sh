#!/usr/bin/env bash
# =====================================================================
# ADHERE+ nightly database backup (host crontab).
#   crontab -e  →  15 1 * * *  /root/ADHERE-plus/scripts/backup.sh >> /var/log/adhere-backup.log 2>&1
# Keeps KEEP_DAYS of gzipped dumps locally; off-site copy is one uncomment away.
# =====================================================================
set -euo pipefail
DB_CONTAINER="${DB_CONTAINER:-deploy-db-1}"
BACKUP_DIR="${BACKUP_DIR:-/root/adhere-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TS="$(date +%F-%H%M)"
OUT="$BACKUP_DIR/adhere-$TS.sql.gz"

docker exec "$DB_CONTAINER" sh -c 'exec mysqldump --no-tablespaces --single-transaction -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' | gzip > "$OUT"
echo "$(date -Is) backup -> $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: delete dumps older than KEEP_DAYS.
find "$BACKUP_DIR" -name 'adhere-*.sql.gz' -mtime +"$KEEP_DAYS" -delete

# OFF-SITE (recommended): configure rclone once (S3 / DO Spaces / Drive) then uncomment:
# rclone copy "$OUT" "remote:adhere-backups/" && echo "$(date -Is) off-site copy ok"
