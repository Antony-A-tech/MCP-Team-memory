#!/bin/bash
# Team Memory — PostgreSQL backup script
# Usage: ./scripts/backup.sh [output_dir]
# Reads DATABASE_URL from .env or environment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${1:-$PROJECT_DIR/data/backups/pg}"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/team-memory-$TIMESTAMP.sql.gz"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/.env" | grep DATABASE_URL | xargs)
fi

DATABASE_URL="${DATABASE_URL:-postgresql://memory:memory@localhost:5432/team_memory}"

mkdir -p "$BACKUP_DIR"

echo "Backing up to: $BACKUP_FILE"
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"

# Keep only last 30 backups
ls -1t "$BACKUP_DIR"/team-memory-*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm -f

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
