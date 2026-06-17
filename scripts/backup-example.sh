#!/usr/bin/env bash
# Example backup script for a running Cairn instance. Copy it, adjust the vars,
# and run it from cron. It pulls BOTH portable formats and rotates old copies:
#   - cairn-export-<ts>.json  : the JSON export (human-readable, version-portable)
#   - cairn-snapshot-<ts>.db  : a consistent SQLite snapshot (VACUUM INTO)
# Restore is documented in docs/OPERATIONS.md.
#
# This is a TEMPLATE — it ships in the public repo as a starting point. The real,
# host-specific cron wrapper stays out of the repo (see docs/DEPLOYMENT.md).
set -euo pipefail

# ---- config (override via env) ----
CAIRN_URL="${CAIRN_URL:-http://localhost:8787}"   # where the server is reachable
CAIRN_TOKEN="${CAIRN_TOKEN:-}"                     # set if CAIRN_AUTH_TOKEN is enabled
BACKUP_DIR="${BACKUP_DIR:-./cairn-backups}"        # where to write backups
KEEP="${KEEP:-14}"                                 # how many of each format to retain

ts="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Auth header only when a token is configured.
auth=()
[ -n "$CAIRN_TOKEN" ] && auth=(-H "Authorization: Bearer ${CAIRN_TOKEN}")

echo "Backing up ${CAIRN_URL} -> ${BACKUP_DIR}"

# 1) JSON export (portable across versions; what /api/import-style restores read).
curl -fsS "${auth[@]}" "${CAIRN_URL}/api/export" -o "${BACKUP_DIR}/cairn-export-${ts}.json"
echo "  wrote cairn-export-${ts}.json"

# 2) SQLite snapshot (VACUUM INTO — a consistent point-in-time copy of the DB).
curl -fsS "${auth[@]}" "${CAIRN_URL}/api/export/db" -o "${BACKUP_DIR}/cairn-snapshot-${ts}.db"
echo "  wrote cairn-snapshot-${ts}.db"

# ---- rotate: keep the newest $KEEP of each format ----
rotate() {
  local pattern="$1"
  # shellcheck disable=SC2012
  ls -1t "${BACKUP_DIR}"/${pattern} 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && echo "  pruned $(basename "$old")"
  done
}
rotate "cairn-export-*.json"
rotate "cairn-snapshot-*.db"

echo "Done. ${KEEP} most recent of each kept."

# ---- cron example (daily at 03:30) ----
#   30 3 * * *  CAIRN_TOKEN=xxxx BACKUP_DIR=/srv/cairn-backups /path/to/backup-example.sh >> /var/log/cairn-backup.log 2>&1
#
# Note: data/art/ (the generated-image cache) is intentionally NOT backed up — it
# regenerates on demand. data/uploads/ (original lab/scan files) is NOT in these
# exports; back that directory up separately if you want the source binaries.
