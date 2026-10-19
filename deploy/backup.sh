#!/bin/sh
# Nightly consistent copy of the database (safe while the server runs). Cron: 15 3 * * * /opt/ai-caller/deploy/backup.sh
set -eu
DATA_DIR=${DATA_DIR:-/var/lib/aicaller}
OUT=${BACKUP_DIR:-/var/backups/aicaller}
mkdir -p "$OUT"
sqlite3 "$DATA_DIR/aicaller.db" ".backup '$OUT/aicaller-$(date +%F).db'"
# Keep 14 days.
find "$OUT" -name 'aicaller-*.db' -mtime +14 -delete
