#!/bin/sh
set -e

# Cairn runs its main process as the unprivileged `app` user. The container still
# *starts* as root so it can fix ownership of the mounted volumes — a fresh named
# volume, or one created by an older root-based image, may be root-owned — and
# then drops privileges. SQLite runs in WAL mode, so an abrupt stop is crash-safe.
#
# To run a one-off command as the same user (e.g. a CLI login that must persist
# in the /home/app volume), use: docker compose exec -u app cairn <cmd>
#
# SINGLE-VOLUME MODE (CAIRN_SINGLE_VOLUME=1). A hosting platform such as Railway or
# Render gives a service exactly ONE persistent volume, mounted at /data. Everything
# that normally lives on the /home/app and /home/app/.cairn-tools volumes — provider
# logins, installed coaching CLIs, the V8 compile cache — then moves under
# $DATA_DIR/home (/data/home), so one volume holds the whole install. HOME is pointed
# there, and every other variable the image aims at /home/app (CAIRN_CLI_ROOT,
# NPM_CONFIG_PREFIX, NPM_CONFIG_CACHE, NODE_COMPILE_CACHE, PATH) is rewritten to the
# same place. The database stays at /data/cairn.db and uploads at /data/uploads;
# /data/home sits beside them. A backup of /data then includes the CLI logins.

IMAGE_HOME=/home/app
DATA_ROOT="${DATA_DIR:-/data}"
APP_HOME="$IMAGE_HOME"

is_truthy() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1 | true | yes | on) return 0 ;;
  esac
  return 1
}

# Rewrite a value — a single path or a colon-separated list such as PATH — so every
# entry under the image's home lands under APP_HOME instead. Other entries pass through.
rehome() {
  out=""
  old_ifs=$IFS
  IFS=:
  set -f
  for entry in $1; do
    case "$entry" in
      "$IMAGE_HOME") entry="$APP_HOME" ;;
      "$IMAGE_HOME"/*) entry="$APP_HOME${entry#"$IMAGE_HOME"}" ;;
    esac
    out="${out:+$out:}$entry"
  done
  set +f
  IFS=$old_ifs
  printf '%s' "$out"
}

if is_truthy "${CAIRN_SINGLE_VOLUME:-}"; then
  APP_HOME="${DATA_ROOT%/}/home"
  HOME="$APP_HOME"
  CAIRN_CLI_ROOT="$(rehome "${CAIRN_CLI_ROOT:-$APP_HOME/.cairn-tools}")"
  NPM_CONFIG_PREFIX="$(rehome "${NPM_CONFIG_PREFIX:-$CAIRN_CLI_ROOT}")"
  NPM_CONFIG_CACHE="$(rehome "${NPM_CONFIG_CACHE:-$CAIRN_CLI_ROOT/.npm-cache}")"
  NODE_COMPILE_CACHE="$(rehome "${NODE_COMPILE_CACHE:-$APP_HOME/.cache/node-compile-cache}")"
  PATH="$(rehome "$PATH")"
  case ":$PATH:" in
    *":$CAIRN_CLI_ROOT/bin:"*) ;;
    *) PATH="$CAIRN_CLI_ROOT/bin:$PATH" ;;
  esac
  export HOME CAIRN_CLI_ROOT NPM_CONFIG_PREFIX NPM_CONFIG_CACHE NODE_COMPILE_CACHE PATH
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_ROOT" "$APP_HOME/.cairn-tools/bin"
  # Chown only what isn't already owned by `app` — a full migration on the first
  # boot of the non-root image (volumes from an older root image), then a near
  # no-op on every restart after that (cheap even on a Pi with large CLI caches).
  # In single-volume mode APP_HOME is inside DATA_ROOT, so it is covered by the first.
  for d in "$DATA_ROOT" "$IMAGE_HOME"; do
    [ -d "$d" ] && find "$d" ! -user app -exec chown app:app {} + 2>/dev/null || true
  done

  # `su` (without --login) resets HOME to the passwd entry (/home/app), so HOME and
  # PATH are carried through explicitly; every other exported variable survives as is.
  CAIRN_ENTRY_HOME="$APP_HOME" CAIRN_ENTRY_PATH="$PATH"
  export CAIRN_ENTRY_HOME CAIRN_ENTRY_PATH
  exec su -s /bin/sh -c \
    'exec env -u CAIRN_ENTRY_HOME -u CAIRN_ENTRY_PATH HOME="$CAIRN_ENTRY_HOME" PATH="$CAIRN_ENTRY_PATH" "$@"' \
    app sh "$@"
fi

# Already unprivileged (a platform that runs the image as a fixed non-root uid).
# Ownership cannot be fixed from here, so only make sure the home exists.
if is_truthy "${CAIRN_SINGLE_VOLUME:-}" && ! mkdir -p "$APP_HOME/.cairn-tools/bin" 2>/dev/null; then
  echo "cairn-entrypoint: cannot create $APP_HOME as uid $(id -u); make $DATA_ROOT writable by this user" >&2
fi

exec "$@"
