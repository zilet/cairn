#!/bin/sh
set -e

# Cairn runs its main process as the unprivileged `app` user. The container still
# *starts* as root so it can fix ownership of the mounted volumes — a fresh named
# volume, or one created by an older root-based image, may be root-owned — and
# then drops privileges. SQLite runs in WAL mode, so an abrupt stop is crash-safe.
#
# To run a one-off command as the same user (e.g. a CLI login that must persist
# in the /home/app volume), use: docker compose exec -u app cairn <cmd>

if [ "$(id -u)" = "0" ]; then
  # Chown only what isn't already owned by `app` — a full migration on the first
  # boot of the non-root image (volumes from an older root image), then a near
  # no-op on every restart after that (cheap even on a Pi with large CLI caches).
  for d in /data /home/app; do
    [ -d "$d" ] && find "$d" ! -user app -exec chown app:app {} + 2>/dev/null || true
  done
  exec su -s /bin/sh -c 'exec "$@"' app sh "$@"
fi

exec "$@"
