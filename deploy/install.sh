#!/bin/sh
# Cairn: one command to get your own private Cairn, either in the cloud on Railway or
# on this computer / any 64-bit Linux box (VPS, Raspberry Pi, home server) or a Mac.
#
#   curl -fsSL https://cairn.fit/install | sh
#
# (the same file as https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh)
# With no --target it asks one question: Railway or this machine. Non-interactive:
#   ... | sh -s -- --target=railway --yes
#   ... | sh -s -- --target=local --yes --https=tailscale
#
# Subcommands (after installing, the same script lives at <dir>/cairn.sh, and for a
# Railway install at ~/.cairn/railway/<name>/cairn.sh):
#   install    (default) install or reconfigure; safe to re-run, never touches data
#   update     local: pull the release image, restart only if it changed, roll back if
#              unhealthy. Railway: redeploy the service from its image (pulls :latest)
#   status     what is installed, how it is reachable, how updates are doing
#   open       open Cairn in your browser, already signed in (a fresh one-time code)
#   logs       the last lines of Cairn's logs
#   uninstall  local: stop and remove Cairn; your data volumes stay unless --purge.
#              Railway: delete the Railway project (asks you to type its name)
#   railway-template  build the "Deploy on Railway" template from deploy/railway/template.json
#              in your own Railway workspace (a private draft; --publish after a [y/N])
#
# Full guide: docs/INSTALL.md. Run with --help for every option.
#
# Counting: an install sends cairn.fit two anonymous GETs (the target was chosen, then
# done or failed with a fixed step code) so the project can see whether installs work.
# Nothing else: no token, domain, project name, path or free text. DO_NOT_TRACK=1,
# CAIRN_NO_TELEMETRY=1 or --no-telemetry turns it off (see tel_event below).
#
# POSIX sh on purpose (dash, busybox ash, bash, zsh-as-sh): it must also run as
# `curl | sh`, where stdin is the script itself, so every prompt reads /dev/tty,
# every child that might read stdin gets </dev/null, and a run with no terminal
# needs --yes. All logic sits in functions and `main` is called on the last line,
# so a truncated download runs nothing.
#
# CAIRN_ONE_LINE_INSTALLER (marker: identifies a copy of this script)
set -eu

INSTALLER_VERSION="1"
DEFAULT_IMAGE="ghcr.io/zilet/cairn:latest"
DEFAULT_SCRIPT_URL="https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh"
# The short form people type; the project site serves deploy/install.sh from main.
ONE_LINER_URL="https://cairn.fit/install"
# The anonymous installer funnel counter (tel_event). CAIRN_INSTALL_EVENT_URL overrides
# it (https only); set it to "" to send nothing.
DEFAULT_EVENT_URL="https://cairn.fit/install/event"
DEFAULT_PORT="8787"
MARKER="CAIRN_ONE_LINE_INSTALLER"
# Contract with the app (CAIRN_UPDATE_METHOD=trigger-file): Settings -> "Update now"
# writes the trigger file into the data volume; the updater writes the status file.
TRIGGER_FILE="/data/.cairn-update-requested"
STATUS_FILE="/data/.cairn-updater.json"
HEALTH_TIMEOUT="${CAIRN_HEALTH_TIMEOUT:-180}"
# Every key the installer owns in .env. Anything else in .env is the user's and is
# carried over verbatim on every re-run.
MANAGED_KEYS="COMPOSE_PROJECT_NAME|CAIRN_CONTAINER_NAME|CAIRN_IMAGE|CAIRN_HOST_PORT|CAIRN_BIND_HOST|CAIRN_EXPOSURE|CAIRN_DOMAIN|CAIRN_ACME_EMAIL|TZ|CAIRN_AUTH_TOKEN|CAIRN_REQUIRE_AUTH|CAIRN_SETTINGS_SECRET_KEY|CAIRN_PLATFORM|CAIRN_UPDATE_METHOD|CAIRN_TRUST_PROXY|CAIRN_BLANK_PROFILE|CAIRN_ENGINE|CAIRN_UPDATER|CAIRN_UPDATE_TIME"

# Cron and launchd hand us a minimal PATH; make the usual engine locations visible.
PATH="${PATH:-/usr/bin:/bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin"
export PATH

NL='
'

# ----------------------------------------------------------------------------- output

setup_colors() {
  # Decide "is stdout a terminal" once, out here: inside $(...) stdout is a pipe.
  # CAIRN_INSTALL_FORCE_TTY=1 exists only so the tests can exercise the terminal branch.
  if [ -t 1 ] || [ "${CAIRN_INSTALL_FORCE_TTY:-0}" = "1" ]; then IS_TTY=1; else IS_TTY=0; fi
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
    C_BOLD=$(printf '\033[1m'); C_GREEN=$(printf '\033[0;32m'); C_YELLOW=$(printf '\033[1;33m')
    C_RED=$(printf '\033[0;31m'); C_CYAN=$(printf '\033[0;36m'); C_RESET=$(printf '\033[0m')
    STAMP=0
  else
    C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
    STAMP=1 # timers / cron / logs: prefix every line with a UTC timestamp
  fi
}

ts() { if [ "$STAMP" = 1 ]; then date -u '+%Y-%m-%dT%H:%M:%SZ '; fi; }
info() { printf '%s%s  ->%s %s\n' "$(ts)" "$C_CYAN" "$C_RESET" "$*"; }
ok() { printf '%s%s  ok%s %s\n' "$(ts)" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s%s  ! %s %s\n' "$(ts)" "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%s%s  error:%s %s\n' "$(ts)" "$C_RED" "$C_RESET" "$*" >&2; tel_failed; exit 1; }
step() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
say() { printf '%s\n' "$*"; }

# ----------------------------------------------------------------------------- prompts

# A terminal we can ask, even when stdin is the piped script (`curl | sh`).
has_tty() {
  [ "${CAIRN_NO_TTY:-0}" = "1" ] && return 1
  (exec </dev/tty) 2>/dev/null
}

# consent_script "Question" FLAG_VALUE FLAG_NAME "command"  -> 0 when the person agreed to run a
# third-party install script. --yes is NOT consent for this: only the explicit flag (FLAG_VALUE=1)
# or a real interactive yes counts. Unattended without the flag, print the command and stop.
consent_script() {
  if [ "$2" = 1 ]; then return 0; fi
  if [ "$OPT_YES" = 1 ]; then
    warn "--yes does not allow running a third-party install script. Run it yourself:"
    say "  $4"
    die "Or let the installer run it by re-running with $3 (for example: curl -fsSL $ONE_LINER_URL | sh -s -- $(rerun_args)--yes $3)"
  fi
  confirm "$1" "n"
}

# The arguments this run was started with, for a copy-paste re-run hint (adds --target
# when the target came from elsewhere). Prints them with a trailing space, or nothing.
rerun_args() {
  ra_out="${RERUN_ARGS:-}"
  case " $ra_out " in *" --target="*) ;; *) [ -n "${TARGET:-}" ] && ra_out="--target=$TARGET${ra_out:+ $ra_out}" ;; esac
  [ -n "$ra_out" ] && printf '%s ' "$ra_out"
  return 0
}

# confirm "Question" y|n  -> 0 for yes. --yes answers yes; no terminal and no --yes dies.
confirm() {
  if [ "$OPT_YES" = 1 ]; then return 0; fi
  if ! has_tty; then
    die "No terminal to ask: \"$1\". Re-run non-interactively with --yes, e.g. curl -fsSL $ONE_LINER_URL | sh -s -- $(rerun_args)--yes"
  fi
  if [ "${2:-n}" = "y" ]; then confirm_hint="[Y/n]"; else confirm_hint="[y/N]"; fi
  printf '%s  ? %s%s %s ' "$C_YELLOW" "$C_RESET" "$1" "$confirm_hint" >/dev/tty
  confirm_ans=""
  read -r confirm_ans </dev/tty || confirm_ans=""
  case "$confirm_ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    "") [ "${2:-n}" = "y" ] && return 0; return 1 ;;
    *) return 1 ;;
  esac
}

# ----------------------------------------------------------------------------- counting

# The installer funnel: at most two anonymous GETs per install to cairn.fit's own counter,
# `chose` once the plan is accepted, then `done` or `failed`. Every value comes from a fixed
# set (event, target railway|local, a step code, the installer version), never from the
# person or the machine. It never fails, prints or waits more than 3 seconds.
# Off with DO_NOT_TRACK / CAIRN_NO_TELEMETRY (any value but "" or 0), --no-telemetry, or an
# empty CAIRN_INSTALL_EVENT_URL. Only `install` counts, and never a --dry-run.
TEL_ARMED=0
TEL_STEP="other"

tel_url() {
  tu_url="${CAIRN_INSTALL_EVENT_URL-$DEFAULT_EVENT_URL}"
  case "$tu_url" in *[!A-Za-z0-9./:_-]*) return 1 ;; https://?*) printf '%s' "$tu_url" ;; *) return 1 ;; esac
}

tel_enabled() {
  [ "${OPT_NO_TELEMETRY:-0}" = 1 ] && return 1
  case "${DO_NOT_TRACK:-}" in "" | 0) ;; *) return 1 ;; esac
  case "${CAIRN_NO_TELEMETRY:-}" in "" | 0) ;; *) return 1 ;; esac
  tel_url >/dev/null
}

# tel_event EVENT STEP: one GET, fire and forget.
tel_event() {
  tel_enabled || return 0
  has curl || return 0
  te_url=$(tel_url) || return 0
  te_target="${TARGET:-none}"
  te_step="${2:-none}"
  case "$1$te_target$te_step" in *[!a-z0-9_]*) return 0 ;; esac
  curl -fsS --max-time 3 --proto '=https' --tlsv1.2 \
    "$te_url?e=$1&t=$te_target&s=$te_step&v=$INSTALLER_VERSION" >/dev/null 2>&1 </dev/null || true
}

# A failure from here on counts as `failed` at STEP (a fixed code).
tel_arm() { TEL_ARMED=1; TEL_STEP="$1"; }
tel_disarm() { TEL_ARMED=0; }
tel_chose() { tel_event chose none; tel_arm "${1:-other}"; }
tel_done() { tel_disarm; tel_event "done" none; }
tel_failed() {
  [ "${TEL_ARMED:-0}" = 1 ] || return 0
  TEL_ARMED=0
  tel_event failed "${TEL_STEP:-other}"
}
tel_plan_line() {
  if tel_enabled; then
    say "  Counting:    two anonymous events to cairn.fit (started; then done or failed at which step)."
    say "               No IP kept, nothing about you or this machine. --no-telemetry skips them."
  else
    say "  Counting:    off"
  fi
}

# ----------------------------------------------------------------------------- helpers

has() { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" = "0" ]; }

# valid_re VALUE ERE -> 0 when the single-line VALUE matches.
valid_re() {
  case "$1" in *"$NL"* | "") return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq "$2"
}

# env_get KEY FILE -> last value of KEY= in FILE (surrounding quotes stripped).
env_get() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

rand_hex() {
  rand_out=""
  if has openssl; then rand_out=$(openssl rand -hex "$1" 2>/dev/null || true); fi
  if [ -z "$rand_out" ] && [ -r /dev/urandom ]; then
    rand_out=$(od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n')
  fi
  valid_re "$rand_out" "^[0-9a-f]{$(($1 * 2))}\$" || die "Could not generate a random secret (need openssl or /dev/urandom)."
  printf '%s' "$rand_out"
}

rand_int() {
  rand_n=$(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' \n' || true)
  valid_re "$rand_n" '^[0-9]+$' || rand_n=$$
  printf '%s' "$((rand_n % $1))"
}

# Run as root: directly, through sudo (which asks on the terminal), or fail.
as_root() {
  if is_root; then "$@"; elif has sudo; then sudo "$@"; else die "Need root for: $* (install sudo or re-run as root)."; fi
}

json_str() {
  if [ -z "$1" ]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t')"
}

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ----------------------------------------------------------------------------- platform

detect_platform() {
  OS_RAW="${CAIRN_INSTALL_OS:-$(uname -s)}"
  ARCH_RAW="${CAIRN_INSTALL_ARCH:-$(uname -m)}"
  case "$OS_RAW" in
    Linux) PLATFORM="linux" ;;
    Darwin) PLATFORM="macos" ;;
    *) die "Unsupported OS: $OS_RAW. Cairn's installer supports 64-bit Linux and macOS." ;;
  esac
  case "$ARCH_RAW" in
    x86_64 | amd64) ARCH="amd64" ;;
    aarch64 | arm64) ARCH="arm64" ;;
    armv6* | armv7* | armv8l | armhf | armel | arm | i386 | i486 | i586 | i686 | x86)
      die "32-bit system detected ($ARCH_RAW). Cairn's image is built for 64-bit only (amd64 / arm64). On a Raspberry Pi, flash the 64-bit Raspberry Pi OS (Pi 3/4/5) and re-run."
      ;;
    *) die "Unsupported CPU architecture: $ARCH_RAW. Cairn's image is published for amd64 and arm64." ;;
  esac
  if [ "$PLATFORM" = "linux" ]; then
    # A 64-bit kernel can run a 32-bit userland (older Raspberry Pi OS images): uname
    # says aarch64 but containers would need an armv7 image that does not exist.
    LONG_BIT="${CAIRN_INSTALL_LONG_BIT:-$(getconf LONG_BIT 2>/dev/null || echo 64)}"
    if [ "$LONG_BIT" = "32" ]; then
      die "This is a 64-bit kernel running a 32-bit userland. Cairn needs a fully 64-bit OS (e.g. 64-bit Raspberry Pi OS); re-flash and re-run."
    fi
  fi
}

detect_tz() {
  if valid_re "${TZ:-}" '^[A-Za-z0-9_+/-]+$'; then printf '%s' "$TZ"; return; fi
  tz_found=""
  if has timedatectl; then tz_found=$(timedatectl show -p Timezone --value 2>/dev/null || true); fi
  if [ -z "$tz_found" ] && [ -r /etc/timezone ]; then tz_found=$(head -n 1 /etc/timezone 2>/dev/null || true); fi
  if [ -z "$tz_found" ] && [ -L /etc/localtime ]; then
    tz_found=$(readlink /etc/localtime 2>/dev/null | sed -n 's|.*zoneinfo/||p' || true)
  fi
  if valid_re "$tz_found" '^[A-Za-z0-9_+/-]+$'; then printf '%s' "$tz_found"; else printf 'UTC'; fi
}

lan_ip() {
  lan_found=""
  if [ "$PLATFORM" = "linux" ] && has hostname; then lan_found=$(hostname -I 2>/dev/null | awk '{print $1}' || true); fi
  if [ -z "$lan_found" ] && has ipconfig; then lan_found=$(ipconfig getifaddr en0 2>/dev/null || true); fi
  if [ -z "$lan_found" ] && has ip; then
    lan_found=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1 || true)
  fi
  printf '%s' "${lan_found:-<this-machine-ip>}"
}

# ----------------------------------------------------------------------------- container engine

# Same policy as scripts/container-tool.sh, in POSIX sh (that file is bash and is
# not available under `curl | sh`): docker, then podman; the engine must answer.
engine_up() {
  case "$1" in
    docker) docker info >/dev/null 2>&1 ;;
    podman) podman info >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

compose_for() {
  case "$1" in
    docker)
      if docker compose version >/dev/null 2>&1; then printf 'docker compose'
      elif has docker-compose; then printf 'docker-compose'; fi ;;
    podman)
      if podman compose version >/dev/null 2>&1; then printf 'podman compose'
      elif has podman-compose; then printf 'podman-compose'
      elif has docker-compose; then printf 'docker-compose'; fi ;;
  esac
}

resolve_engine() {
  CLI=""; COMPOSE=""; ENGINE_WHY=""
  engine_candidates="${CAIRN_CONTAINER_TOOL:-${E_ENGINE:-}}"
  [ -n "$engine_candidates" ] || engine_candidates="docker podman"
  for engine_c in $engine_candidates; do
    has "$engine_c" || continue
    if ! engine_up "$engine_c"; then
      if [ "$engine_c" = "docker" ] && docker info 2>&1 | grep -qi "permission denied"; then
        ENGINE_WHY="docker is installed but this user cannot reach it (permission denied on the Docker socket)"
      else
        ENGINE_WHY="$engine_c is installed but its engine is not running"
      fi
      continue
    fi
    CLI="$engine_c"
    COMPOSE="$(compose_for "$engine_c")"
    break
  done
  if [ -z "$CLI" ]; then
    [ -n "$ENGINE_WHY" ] || ENGINE_WHY="no container engine found (looked for: $engine_candidates)"
    return 1
  fi
  return 0
}

compose_hint() {
  case "${CLI:-}" in
    docker) say "Install the Compose plugin: https://docs.docker.com/compose/install/ (Debian/Ubuntu: sudo apt-get install docker-compose-plugin)" ;;
    podman) say "Install a Compose provider for Podman: your distro's podman-compose package, or 'pip install podman-compose'" ;;
    *) say "Install Docker (https://docs.docker.com/engine/install/) or Podman (https://podman.io)" ;;
  esac
}

compose() {
  case "$COMPOSE" in
    "docker compose") (cd "$DIR" && docker compose -p "$NAME" "$@") ;;
    "podman compose") (cd "$DIR" && podman compose -p "$NAME" "$@") ;;
    docker-compose) (cd "$DIR" && docker-compose -p "$NAME" "$@") ;;
    podman-compose) (cd "$DIR" && podman-compose -p "$NAME" "$@") ;;
    *) warn "No Compose front-end available."; return 1 ;;
  esac
}

c_running() { [ "$("$CLI" container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; }
c_exists() { "$CLI" container inspect "$NAME" >/dev/null 2>&1; }
strip_sha() { sed 's/^sha256://'; }
running_image_id() { "$CLI" container inspect -f '{{.Image}}' "$NAME" 2>/dev/null | strip_sha || true; }
container_project() {
  cp_p=$("$CLI" container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$NAME" 2>/dev/null || true)
  case "$cp_p" in "" | "<no value>")
    cp_p=$("$CLI" container inspect -f '{{index .Config.Labels "io.podman.compose.project"}}' "$NAME" 2>/dev/null || true) ;;
  esac
  case "$cp_p" in "<no value>") cp_p="" ;; esac
  printf '%s' "$cp_p"
}
image_id() { "$CLI" image inspect -f '{{.Id}}' "$1" 2>/dev/null | strip_sha || true; }

ensure_engine_linux() {
  case "$ENGINE_WHY" in
    *"permission denied"*)
      die "$ENGINE_WHY. Add yourself to the docker group (sudo usermod -aG docker \"\$USER\", then log out and back in), or re-run the installer with sudo: curl -fsSL $DEFAULT_SCRIPT_URL | sudo sh" ;;
    *"not running"*)
      die "$ENGINE_WHY. Start it (e.g. sudo systemctl start docker) and re-run." ;;
  esac
  warn "No container engine found. Cairn runs as a container (Docker or Podman)."
  consent_script "Install Docker now with Docker's official script (https://get.docker.com)?" "$OPT_INSTALL_DOCKER" "--install-docker" \
    "curl -fsSL https://get.docker.com | sh" \
    || die "Docker is required. Install it (https://docs.docker.com/engine/install/) and re-run."
  has curl || die "curl is required to download Docker's install script."
  docker_tmp=$(mktemp "${TMPDIR:-/tmp}/get-docker.XXXXXX")
  TMP_FILES="$TMP_FILES $docker_tmp"
  info "Downloading https://get.docker.com ..."
  curl -fsSL --proto '=https' --tlsv1.2 https://get.docker.com -o "$docker_tmp" \
    || die "Could not download https://get.docker.com"
  info "Running Docker's install script (this takes a minute or two)..."
  as_root sh "$docker_tmp" || die "Docker's install script failed; see its output above."
  if has systemctl; then as_root systemctl enable --now docker >/dev/null 2>&1 || true; fi
  if ! is_root; then
    docker_user="$(id -un)"
    as_root usermod -aG docker "$docker_user" || true
  fi
  if resolve_engine; then
    ok "Docker is installed."
    return 0
  fi
  if ! is_root; then
    die "Docker is installed and '$(id -un)' was added to the docker group, which takes effect at your next login. Log out and back in (or run 'newgrp docker'), then run the same install command again."
  fi
  die "Docker was installed but is not answering: $ENGINE_WHY"
}

ensure_engine() {
  if resolve_engine; then :; else
    if [ "$PLATFORM" = "macos" ]; then
      case "$ENGINE_WHY" in
        *"not running"*) die "$ENGINE_WHY. Start it (open Docker Desktop or OrbStack, or run 'podman machine start') and re-run." ;;
      esac
      die "$ENGINE_WHY. On a Mac, install and start one of: Docker Desktop (https://www.docker.com/products/docker-desktop/), OrbStack (https://orbstack.dev), or Podman (https://podman.io; then 'podman machine init && podman machine start'). Then re-run this command."
    fi
    ensure_engine_linux
  fi
  [ -n "$COMPOSE" ] || die "Found $CLI but no Compose front-end. $(compose_hint)"
  ok "Container engine: $CLI ($COMPOSE)."
}

# ----------------------------------------------------------------------------- configuration

usage() {
  cat <<'EOF'
Cairn installer: your own private Cairn, in the cloud on Railway or on this machine.

Usage:
  One command:      curl -fsSL https://cairn.fit/install | sh
  With options:     curl -fsSL https://cairn.fit/install | sh -s -- [command] [options]
  After installing: sh ~/cairn/cairn.sh [command] [options]                (this machine)
                    sh ~/.cairn/railway/cairn/cairn.sh [command] [options]  (Railway)
  (https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh is the same file.)

Commands:
  install            install or reconfigure (default; safe to re-run)
  update             this machine: pull the release image, restart if it changed, roll back
                     if unhealthy. Railway: redeploy from the image (pulls the newest :latest)
  status             show the install, its URL(s) and how updates are doing
  open               open Cairn in your browser, already signed in (a one-time code)
  logs               show the last lines of Cairn's logs
  uninstall          this machine: stop and remove Cairn; keeps your data volumes unless
                     --purge. Railway: delete the Railway project and everything in it
  railway-template   build Cairn's "Deploy on Railway" template in YOUR Railway workspace,
                     from deploy/railway/template.json (see "Railway template options")

Where it runs (asked when neither is given):
  --target=railway   in the cloud on your own Railway account (about $5/month)
  --target=local     on this computer or server (free, private, needs to stay on)

Common options:
  -y, --yes          answer yes to prompts (needed when there is no terminal). Does NOT
                     allow running a downloaded install script; see the two flags below
  --install-docker   allow running Docker's install script (https://get.docker.com) when
                     no container engine is found (Linux)
  --install-railway-cli  allow running Railway's install script (https://railway.com/install.sh)
                     when the Railway CLI is missing and brew/npm can't install it
  --name=NAME        instance name (default cairn): the Compose project, container and
                     timers here, or the Railway service and ~/.cairn/railway/NAME
  --image=REF        container image (default ghcr.io/zilet/cairn:latest)
  --no-browser       print the sign-in link instead of opening a browser
  --no-telemetry     send no anonymous install counts to cairn.fit (same as DO_NOT_TRACK=1
                     or CAIRN_NO_TELEMETRY=1)
  --dry-run          print what it would do; change nothing

Railway options:
  --railway-project-name=NAME   Railway project to create (default cairn)
  --railway-workspace=ID|NAME   workspace for a new project (when you have several)
  --confirm-purge=PROJECT       confirm uninstall without a terminal (the project name)

Railway template options (railway-template):
  --publish          publish the draft to Railway's marketplace, after showing the plan and
                     asking [y/N] (--yes answers). Only a draft whose check passed
  --template=ID|CODE check (and with --publish, publish) an existing draft instead of
                     building a new one
  --workspace=NAME   the workspace to build it in (same as --railway-workspace)
  --force            with --publish: publish although editor-only items are missing
  The draft is built in a scratch project named Cairn (--railway-project-name= renames it;
  the template takes its name), which is deleted again, also when a step fails.

This-machine options (any of these implies --target=local):
  --dir=PATH         install directory (default ~/cairn, or /opt/cairn as root)
  --port=PORT        host port Cairn listens on (default 8787)
  --https=MODE       tailscale  private HTTPS on your tailnet via Tailscale Serve
                     caddy      public HTTPS on --domain via a Caddy container (ports 80/443)
                     none       loopback only (the default)
  --domain=DOMAIN    domain for --https=caddy (its DNS must point at this server)
  --email=EMAIL      optional contact email for the TLS certificate (--https=caddy)
  --lan              listen on all interfaces, plain HTTP for your LAN (token required)
  --local            go back to loopback-only (undoes --lan / --https)
  --tz=ZONE          timezone, e.g. Europe/Berlin (default: this machine's)
  --updater=KIND     auto | systemd | cron | launchd | none (default auto)
  --no-updater       same as --updater=none
  --no-start         write the configuration only; start nothing

Update options (this machine):
  --nightly          run as the nightly scheduled check
  --if-requested     only update when the app's "Update now" asked for it
  --force            retry a release that was rolled back earlier

Uninstall options (this machine):
  --purge            ALSO delete all Cairn data (database, logins, certificates)
  --confirm-purge=NAME   confirm --purge without a terminal (NAME = instance name)

Docs: https://github.com/zilet/cairn/blob/main/docs/INSTALL.md
EOF
}

parse_args() {
  CMD="install"
  OPT_YES=0; OPT_INSTALL_DOCKER=0; OPT_INSTALL_RAILWAY_CLI=0; OPT_DRY_RUN=0; OPT_NO_START=0
  OPT_DIR=""; OPT_NAME=""; OPT_PORT=""; OPT_HTTPS=""; OPT_DOMAIN=""; OPT_EMAIL=""
  OPT_LAN=0; OPT_LOCAL=0; OPT_TZ=""; OPT_IMAGE=""; OPT_UPDATER=""
  OPT_NIGHTLY=0; OPT_IF_REQUESTED=0; OPT_FORCE=0; OPT_PURGE=0; OPT_CONFIRM_PURGE=""
  OPT_TARGET=""; OPT_RW_PROJECT=""; OPT_RW_WORKSPACE=""; OPT_NO_BROWSER=0; OPT_NO_TELEMETRY=0
  OPT_PUBLISH=0; OPT_TEMPLATE=""
  # Any of these only makes sense on this machine, so it implies --target=local.
  OPT_LOCAL_ONLY=0
  arg_cmd_seen=0
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    arg_val=""
    case "$arg" in
      --*=*) arg_val="${arg#*=}"; arg="${arg%%=*}" ;;
      --dir | --name | --port | --https | --domain | --email | --tz | --image | --updater | --confirm-purge | \
        --target | --railway-project-name | --railway-workspace | --workspace | --template)
        [ $# -gt 0 ] || die "$arg needs a value"
        arg_val="$1"; shift ;;
    esac
    case "$arg" in
      install | update | status | uninstall | open | logs | railway-template)
        [ "$arg_cmd_seen" = 0 ] || die "Only one command at a time (got '$CMD' and '$arg')."
        CMD="$arg"; arg_cmd_seen=1 ;;
      -h | --help | help) usage; exit 0 ;;
      --version) say "cairn installer $INSTALLER_VERSION"; exit 0 ;;
      -y | --yes) OPT_YES=1 ;;
      --install-docker) OPT_INSTALL_DOCKER=1 ;;
      --install-railway-cli) OPT_INSTALL_RAILWAY_CLI=1 ;;
      --dry-run) OPT_DRY_RUN=1 ;;
      --no-start) OPT_NO_START=1; OPT_LOCAL_ONLY=1 ;;
      --dir) OPT_DIR="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --name) OPT_NAME="$arg_val" ;;
      --port) OPT_PORT="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --https) OPT_HTTPS="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --domain) OPT_DOMAIN="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --email) OPT_EMAIL="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --lan) OPT_LAN=1; OPT_LOCAL_ONLY=1 ;;
      --local) OPT_LOCAL=1; OPT_LOCAL_ONLY=1 ;;
      --tz) OPT_TZ="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --image) OPT_IMAGE="$arg_val" ;;
      --updater) OPT_UPDATER="$arg_val"; OPT_LOCAL_ONLY=1 ;;
      --no-updater) OPT_UPDATER="none"; OPT_LOCAL_ONLY=1 ;;
      --nightly) OPT_NIGHTLY=1; OPT_LOCAL_ONLY=1 ;;
      --if-requested) OPT_IF_REQUESTED=1; OPT_LOCAL_ONLY=1 ;;
      --force) OPT_FORCE=1 ;;
      --purge) OPT_PURGE=1; OPT_LOCAL_ONLY=1 ;;
      --target) OPT_TARGET="$arg_val" ;;
      --railway-project-name) OPT_RW_PROJECT="$arg_val" ;;
      --railway-workspace | --workspace) OPT_RW_WORKSPACE="$arg_val" ;;
      --publish) OPT_PUBLISH=1 ;;
      --template) OPT_TEMPLATE="$arg_val" ;;
      --no-browser) OPT_NO_BROWSER=1 ;;
      --no-telemetry) OPT_NO_TELEMETRY=1 ;;
      --confirm-purge) OPT_CONFIRM_PURGE="$arg_val" ;;
      *) die "Unknown option: $arg (see --help)" ;;
    esac
  done
}

validate_opts() {
  if [ -n "$OPT_TARGET" ] && ! is_provider "$OPT_TARGET"; then die "--target must be one of: $(provider_names) (got '$OPT_TARGET')."; fi
  if [ "$OPT_TARGET" = "railway" ] && [ "$OPT_LOCAL_ONLY" = 1 ]; then
    die "--target=railway does not take this-machine options (--dir, --port, --https, --lan, --tz, --updater, --no-start, --purge, ...). See --help."
  fi
  if [ "$CMD" = "railway-template" ]; then
    case "$OPT_TARGET" in "" | railway) ;; *) die "railway-template builds a Railway template; it takes no --target=$OPT_TARGET." ;; esac
    [ "$OPT_LOCAL_ONLY" = 0 ] || die "railway-template does not take this-machine options (--dir, --port, --https, --lan, --tz, --updater, ...). See --help."
    if [ -n "$OPT_TEMPLATE" ] && ! valid_re "$OPT_TEMPLATE" '^[A-Za-z0-9_-]{1,64}$'; then
      die "--template must be a template ID or code (got '$OPT_TEMPLATE')."
    fi
  elif [ "$OPT_PUBLISH" = 1 ] || [ -n "$OPT_TEMPLATE" ]; then
    die "--publish and --template belong to the railway-template command (see --help)."
  fi
  if [ -n "$OPT_RW_PROJECT" ] && ! valid_re "$OPT_RW_PROJECT" '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'; then
    die "--railway-project-name must be letters, digits, '.', '-' or '_' (got '$OPT_RW_PROJECT')."
  fi
  # Workspace names are free text ("Ana's Projects"); the value only ever travels as one argv word.
  if [ -n "$OPT_RW_WORKSPACE" ] && ! valid_re "$OPT_RW_WORKSPACE" '^[^[:cntrl:]-][^[:cntrl:]]{0,119}$'; then
    die "--railway-workspace must be a workspace ID or name (got '$OPT_RW_WORKSPACE')."
  fi
  if [ -n "$OPT_NAME" ] && ! valid_re "$OPT_NAME" '^[a-z0-9][a-z0-9_-]{0,40}$'; then
    die "--name must be lowercase letters, digits, '-' or '_' (got '$OPT_NAME')."
  fi
  if [ -n "$OPT_PORT" ]; then
    if ! { valid_re "$OPT_PORT" '^[0-9]{1,5}$' && [ "$OPT_PORT" -ge 1 ] && [ "$OPT_PORT" -le 65535 ]; }; then
      die "--port must be a number from 1 to 65535 (got '$OPT_PORT')."
    fi
  fi
  case "$OPT_HTTPS" in "" | none | tailscale | caddy) ;; *) die "--https must be tailscale, caddy or none (got '$OPT_HTTPS')." ;; esac
  if [ -n "$OPT_DOMAIN" ] && ! valid_re "$OPT_DOMAIN" '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
    die "--domain must be a plain host name like cairn.example.com (got '$OPT_DOMAIN')."
  fi
  if [ -n "$OPT_EMAIL" ] && ! valid_re "$OPT_EMAIL" '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    die "--email does not look like an email address (got '$OPT_EMAIL')."
  fi
  if [ -n "$OPT_TZ" ] && ! valid_re "$OPT_TZ" '^[A-Za-z0-9_+/-]+$'; then die "--tz must be a zone name like Europe/Berlin (got '$OPT_TZ')."; fi
  if [ -n "$OPT_IMAGE" ] && ! valid_re "$OPT_IMAGE" '^[A-Za-z0-9][A-Za-z0-9./:_@-]*$'; then die "--image is not a valid image reference."; fi
  case "$OPT_UPDATER" in "" | auto | systemd | cron | launchd | none) ;; *) die "--updater must be auto, systemd, cron, launchd or none." ;; esac
  arg_modes=0
  [ "$OPT_LAN" = 1 ] && arg_modes=$((arg_modes + 1))
  [ "$OPT_LOCAL" = 1 ] && arg_modes=$((arg_modes + 1))
  case "$OPT_HTTPS" in tailscale | caddy) arg_modes=$((arg_modes + 1)) ;; esac
  [ "$arg_modes" -le 1 ] || die "Choose one of --lan, --local or --https=... (they are different ways to reach Cairn)."
}

# Find the install directory: --dir, else the directory of this copy when it is an
# installed cairn.sh, else the default for this user.
resolve_dir() {
  if [ -n "$OPT_DIR" ]; then
    rd="$OPT_DIR"
    # shellcheck disable=SC2088 # matching a literal, unexpanded "~/" from --dir=~/x
    case "$rd" in "~") rd="$HOME" ;; "~/"*) rd="$HOME/${rd#\~/}" ;; esac
  else
    rd=""
    case "$0" in
      cairn.sh | */cairn.sh)
        rd_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || rd_self=""
        if [ -n "$rd_self" ] && [ -f "$rd_self/docker-compose.yml" ] && grep -q "$MARKER" "$rd_self/docker-compose.yml" 2>/dev/null; then
          rd="$rd_self"
        fi ;;
    esac
    if [ -z "$rd" ]; then
      if is_root; then rd="/opt/${OPT_NAME:-cairn}"; else rd="$HOME/${OPT_NAME:-cairn}"; fi
    fi
  fi
  case "$rd" in /*) ;; *) rd="$(pwd)/$rd" ;; esac
  while [ "${rd%/}" != "$rd" ] && [ "$rd" != "/" ]; do rd="${rd%/}"; done
  valid_re "$rd" '^/[A-Za-z0-9._/@+-]+$' \
    || die "The install directory must be an absolute path of letters, digits and . _ / @ + - (no spaces): '$rd'. Pick one with --dir=."
  [ "$rd" != "/" ] || die "Refusing to install into /."
  DIR="$rd"
  ENV_FILE="$DIR/.env"
  STATE_FILE="$DIR/updater.state"
}

load_existing() {
  if [ -f "$ENV_FILE" ]; then HAVE_ENV=1; else HAVE_ENV=0; fi
  E_NAME=$(env_get COMPOSE_PROJECT_NAME "$ENV_FILE")
  E_TOKEN=$(env_get CAIRN_AUTH_TOKEN "$ENV_FILE")
  E_SECRET=$(env_get CAIRN_SETTINGS_SECRET_KEY "$ENV_FILE")
  E_TZ=$(env_get TZ "$ENV_FILE")
  E_PORT=$(env_get CAIRN_HOST_PORT "$ENV_FILE")
  E_EXPOSURE=$(env_get CAIRN_EXPOSURE "$ENV_FILE")
  E_DOMAIN=$(env_get CAIRN_DOMAIN "$ENV_FILE")
  E_EMAIL=$(env_get CAIRN_ACME_EMAIL "$ENV_FILE")
  E_IMAGE=$(env_get CAIRN_IMAGE "$ENV_FILE")
  E_BLANK=$(env_get CAIRN_BLANK_PROFILE "$ENV_FILE")
  E_ENGINE=$(env_get CAIRN_ENGINE "$ENV_FILE")
  E_UPDATER=$(env_get CAIRN_UPDATER "$ENV_FILE")
  E_UPDATE_TIME=$(env_get CAIRN_UPDATE_TIME "$ENV_FILE")
}

# The effective configuration: flags win, then what this directory already has,
# then defaults. Secrets are generated once and never regenerated.
# Best effort: does this instance's data volume already exist? Unknown (no engine) counts as yes,
# so nothing is changed for an install we cannot see.
data_volume_exists() {
  dv_seen=0
  for dv_c in ${CAIRN_CONTAINER_TOOL:-docker podman}; do
    has "$dv_c" || continue
    dv_seen=1
    "$dv_c" volume inspect "${NAME}_cairn-data" >/dev/null 2>&1 && return 0
  done
  [ "$dv_seen" = 0 ]
}

compute_config() {
  if [ -n "$OPT_NAME" ] && [ -n "$E_NAME" ] && [ "$OPT_NAME" != "$E_NAME" ]; then
    die "$DIR already holds the Cairn instance '$E_NAME'. Use --name=$E_NAME, or pick another --dir for a second instance."
  fi
  NAME="${OPT_NAME:-${E_NAME:-cairn}}"
  valid_re "$NAME" '^[a-z0-9][a-z0-9_-]{0,40}$' || die "Invalid instance name in $ENV_FILE: '$NAME'."
  PORT="${OPT_PORT:-${E_PORT:-$DEFAULT_PORT}}"
  valid_re "$PORT" '^[0-9]{1,5}$' || die "Invalid CAIRN_HOST_PORT in $ENV_FILE: '$PORT'."
  IMAGE="${OPT_IMAGE:-${E_IMAGE:-$DEFAULT_IMAGE}}"
  TZ_VALUE="${OPT_TZ:-${E_TZ:-$(detect_tz)}}"

  if [ "$OPT_LAN" = 1 ]; then EXPOSURE="lan"
  elif [ "$OPT_LOCAL" = 1 ]; then EXPOSURE="local"
  elif [ -n "$OPT_HTTPS" ]; then
    case "$OPT_HTTPS" in none) EXPOSURE="local" ;; *) EXPOSURE="$OPT_HTTPS" ;; esac
  else EXPOSURE="${E_EXPOSURE:-local}"; fi
  case "$EXPOSURE" in local | lan | tailscale | caddy) ;; *) die "Invalid CAIRN_EXPOSURE in $ENV_FILE: '$EXPOSURE'." ;; esac

  DOMAIN="${OPT_DOMAIN:-$E_DOMAIN}"
  EMAIL="${OPT_EMAIL:-$E_EMAIL}"
  if [ "$EXPOSURE" = "caddy" ] && [ -z "$DOMAIN" ]; then
    die "--https=caddy needs --domain=cairn.example.com: a domain whose DNS A/AAAA record points at this server."
  fi
  if [ "$EXPOSURE" != "caddy" ] && [ -n "$OPT_DOMAIN" ]; then
    die "--domain is only used with --https=caddy."
  fi
  if [ "$EXPOSURE" = "lan" ]; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi

  if [ -n "$E_TOKEN" ]; then TOKEN="$E_TOKEN"; TOKEN_STATE="kept"; else TOKEN=""; TOKEN_STATE="new"; fi
  if [ -n "$E_SECRET" ]; then SECRET="$E_SECRET"; SECRET_STATE="kept"; else SECRET=""; SECRET_STATE="new"; fi
  # Blank by default. An existing .env that states it is kept as is; one without the key
  # stays on the compose default only when its data volume already exists (an install with
  # data is never flipped), otherwise a fresh empty volume starts blank, not as the example athlete.
  if [ "$HAVE_ENV" = 1 ] && { [ -n "$E_BLANK" ] || data_volume_exists; }; then BLANK="$E_BLANK"; else BLANK="1"; fi

  if valid_re "$E_UPDATE_TIME" '^0[34]:[0-5][0-9]$'; then UPDATE_TIME="$E_UPDATE_TIME"
  else UPDATE_TIME=$(printf '%02d:%02d' "$((3 + $(rand_int 2)))" "$(rand_int 60)"); fi
  UPDATE_HOUR="${UPDATE_TIME%%:*}"
  UPDATE_MINUTE="${UPDATE_TIME#*:}"
  ENGINE="${E_ENGINE:-}"
}

# Which scheduler the updater uses on this machine (read-only detection).
choose_updater() {
  cu_want="${OPT_UPDATER:-${E_UPDATER:-auto}}"
  case "$cu_want" in systemd-user) cu_want="systemd" ;; esac
  case "$cu_want" in
    none) UPDATER="none" ;;
    launchd) UPDATER="launchd" ;;
    cron) UPDATER="cron" ;;
    systemd) if is_root; then UPDATER="systemd"; else UPDATER="systemd-user"; fi ;;
    *)
      if [ "$PLATFORM" = "macos" ]; then UPDATER="launchd"
      elif is_root && [ -d /run/systemd/system ] && has systemctl; then UPDATER="systemd"
      elif ! is_root && [ -d /run/systemd/system ] && has systemctl && systemctl --user show-environment >/dev/null 2>&1; then UPDATER="systemd-user"
      elif has crontab; then UPDATER="cron"
      else UPDATER="none"; fi ;;
  esac
}

# ----------------------------------------------------------------------------- rendered files

render_compose() {
  cat <<'EOF'
# Cairn: generated by the one-line installer (deploy/install.sh). CAIRN_ONE_LINE_INSTALLER
# Re-running the installer rewrites this file. Keep local changes in
# docker-compose.override.yml next to it; settings and secrets live in .env.
services:
  cairn:
    image: ${CAIRN_IMAGE:-ghcr.io/zilet/cairn:latest}
    container_name: ${CAIRN_CONTAINER_NAME:-cairn}
    restart: unless-stopped
    ports:
      # Loopback unless installed with --lan. Tailscale Serve and Caddy reach Cairn
      # over loopback / the Compose network, so the app port itself stays private.
      - "${CAIRN_BIND_HOST:-127.0.0.1}:${CAIRN_HOST_PORT:-8787}:8787"
    volumes:
      - cairn-data:/data
      - cairn-home:/home/app # provider login state
      - cairn-tools:/home/app/.cairn-tools # optional provider binaries
    environment:
      - TZ=${TZ:-UTC}
      # The installer always generates a token and requires it.
      - CAIRN_AUTH_TOKEN=${CAIRN_AUTH_TOKEN:-}
      - CAIRN_REQUIRE_AUTH=${CAIRN_REQUIRE_AUTH:-1}
      # Tells the app it is updated by this installer's updater: Settings ->
      # "Update now" writes /data/.cairn-update-requested, the updater writes
      # /data/.cairn-updater.json.
      - CAIRN_PLATFORM=${CAIRN_PLATFORM:-installer}
      - CAIRN_UPDATE_METHOD=${CAIRN_UPDATE_METHOD:-trigger-file}
      - CAIRN_TRUST_PROXY=${CAIRN_TRUST_PROXY:-}
      - CAIRN_APPLE_HEALTH_SHORTCUT_URL=${CAIRN_APPLE_HEALTH_SHORTCUT_URL:-}
      - CAIRN_APPLE_HEALTH_SHORTCUT_NAME=${CAIRN_APPLE_HEALTH_SHORTCUT_NAME:-Cairn Apple Health Sync}
      - CAIRN_SETTINGS_SECRET_KEY=${CAIRN_SETTINGS_SECRET_KEY:-}
      - CAIRN_BLANK_PROFILE=${CAIRN_BLANK_PROFILE:-0}
      # Feedback (Settings -> Send feedback) and the opt-in usage ping go to the
      # project's feedback service. Point it elsewhere, or set it to "" for none
      # (feedback then opens a prefilled GitHub issue instead).
      - CAIRN_FEEDBACK_URL=${CAIRN_FEEDBACK_URL-https://feedback.cairn.fit}
      # Coaching: claude/codex/antigravity use their CLI subscription login (in the
      # cairn-home volume), NOT these env keys. Only Grok headless uses XAI_API_KEY.
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - XAI_API_KEY=${XAI_API_KEY:-}
      # ARTWORK only (gemini image model), not a coaching agent.
      - GEMINI_API_KEY=${GEMINI_API_KEY:-}
      - COACH_AGENT=${COACH_AGENT:-}
      - COACH_DAY=${COACH_DAY:-0}
      - COACH_HOUR=${COACH_HOUR:-20}
      - AGENT_CLI_AUTO_UPDATE=${AGENT_CLI_AUTO_UPDATE:-0}
      - AGENT_CLI_AUTO_UPDATE_INTERVAL_HOURS=${AGENT_CLI_AUTO_UPDATE_INTERVAL_HOURS:-168}
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8787/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
EOF
  if [ "$EXPOSURE" = "caddy" ]; then
    cat <<'EOF'

  # Public HTTPS: Caddy terminates TLS for CAIRN_DOMAIN (certificate obtained and
  # renewed automatically) and proxies to Cairn over the Compose network.
  caddy:
    image: ${CAIRN_CADDY_IMAGE:-caddy:2-alpine}
    container_name: ${CAIRN_CONTAINER_NAME:-cairn}-caddy
    restart: unless-stopped
    depends_on:
      - cairn
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro,Z
      - caddy-data:/data
      - caddy-config:/config
EOF
  fi
  cat <<'EOF'

volumes:
  cairn-data:
  cairn-home:
  cairn-tools:
EOF
  if [ "$EXPOSURE" = "caddy" ]; then
    printf '  caddy-data:\n  caddy-config:\n'
  fi
}

render_caddyfile() {
  say "# Cairn: generated by the one-line installer. Caddy gets and renews the certificate."
  if [ -n "$EMAIL" ]; then
    say "{"
    say "	email $EMAIL"
    say "}"
    say ""
  fi
  say "$DOMAIN {"
  say "	encode zstd gzip"
  say "	reverse_proxy cairn:8787"
  say "}"
}

# render_env redacted|real
render_env() {
  if [ "$1" = "redacted" ]; then
    if [ "$TOKEN_STATE" = "kept" ]; then re_token="<kept: existing token>"; else re_token="<generated: 64 hex chars, shown once at the end>"; fi
    if [ "$SECRET_STATE" = "kept" ]; then re_secret="<kept: existing key>"; else re_secret="<generated: 64 hex chars>"; fi
  else
    re_token="$TOKEN"; re_secret="$SECRET"
  fi
  say "## Cairn instance settings, written by the one-line installer (deploy/install.sh)."
  say "## Keep this file private. Re-running the installer keeps the token and the key"
  say "## and carries every line it does not manage (below the managed block) over as-is."
  say "COMPOSE_PROJECT_NAME=$NAME"
  say "CAIRN_CONTAINER_NAME=$NAME"
  say "CAIRN_IMAGE=$IMAGE"
  say "CAIRN_HOST_PORT=$PORT"
  say "CAIRN_BIND_HOST=$BIND"
  say "CAIRN_EXPOSURE=$EXPOSURE"
  say "CAIRN_DOMAIN=$DOMAIN"
  say "CAIRN_ACME_EMAIL=$EMAIL"
  say "TZ=$TZ_VALUE"
  say "## The access token every device signs in with (and the API's Bearer token)."
  say "CAIRN_AUTH_TOKEN=$re_token"
  say "CAIRN_REQUIRE_AUTH=1"
  say "## Encrypts connector secrets saved in Settings. Never change or lose it."
  say "CAIRN_SETTINGS_SECRET_KEY=$re_secret"
  say "CAIRN_PLATFORM=installer"
  say "CAIRN_UPDATE_METHOD=trigger-file"
  ## Caddy and Tailscale Serve each sit one hop in front of Cairn; trusting that one
  ## hop gives the per-IP rate limiter the real client address instead of the proxy's.
  case "$EXPOSURE" in caddy | tailscale) say "CAIRN_TRUST_PROXY=1" ;; esac
  if [ -n "$BLANK" ]; then say "CAIRN_BLANK_PROFILE=$BLANK"; fi
  say "CAIRN_ENGINE=$ENGINE"
  say "CAIRN_UPDATER=$UPDATER"
  say "CAIRN_UPDATE_TIME=$UPDATE_TIME"
  if [ -f "$ENV_FILE" ]; then
    if [ "$1" = "redacted" ]; then
      grep -Ev "^($MANAGED_KEYS)=" "$ENV_FILE" | grep -v '^## ' | sed -e '/^[[:space:]]*$/d' -e 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1=<kept>/' || true
    else
      grep -Ev "^($MANAGED_KEYS)=" "$ENV_FILE" | grep -v '^## ' | sed -e '/^[[:space:]]*$/d' || true
    fi
  fi
}

# A small, stable PATH for timers: the system dirs plus wherever this machine's
# engine, Compose and curl actually live (never the whole interactive PATH, which
# can carry per-shell temp dirs).
unit_path() {
  up_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  [ "$PLATFORM" = "macos" ] && up_path="$up_path:/opt/homebrew/bin"
  for up_tool in docker podman docker-compose podman-compose curl tailscale; do
    up_bin=$(command -v "$up_tool" 2>/dev/null || true)
    case "$up_bin" in /*) ;; *) continue ;; esac
    up_dir=$(dirname "$up_bin")
    case ":$up_path:" in *":$up_dir:"*) continue ;; esac
    if valid_re "$up_dir" '^/[A-Za-z0-9._/@+-]+$'; then up_path="$up_path:$up_dir"; fi
  done
  printf '%s' "$up_path"
}

unit_extra_env() {
  if valid_re "${DOCKER_HOST:-}" '^[A-Za-z0-9._/:@+-]+$'; then say "Environment=DOCKER_HOST=$DOCKER_HOST"; fi
  if valid_re "${CONTAINER_HOST:-}" '^[A-Za-z0-9._/:@+-]+$'; then say "Environment=CONTAINER_HOST=$CONTAINER_HOST"; fi
  if [ "$UPDATER" = "systemd-user" ] && valid_re "${XDG_RUNTIME_DIR:-}" '^[A-Za-z0-9._/-]+$'; then say "Environment=XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"; fi
}

# render_systemd service|timer nightly|check
render_systemd() {
  if [ "$2" = "nightly" ]; then rs_what="nightly release check"; rs_flag="--nightly"; else rs_what="\"Update now\" request check"; rs_flag="--if-requested"; fi
  if [ "$1" = "service" ]; then
    say "# Generated by Cairn's installer ($DIR/cairn.sh)."
    say "[Unit]"
    say "Description=Cairn ($NAME) updater: $rs_what"
    say "Wants=network-online.target"
    say "After=network-online.target"
    say ""
    say "[Service]"
    say "Type=oneshot"
    say "Environment=PATH=$(unit_path)"
    unit_extra_env
    say "ExecStart=/bin/sh $DIR/cairn.sh update $rs_flag --dir=$DIR"
    say "TimeoutStartSec=30min"
    say "Nice=10"
  else
    say "# Generated by Cairn's installer ($DIR/cairn.sh)."
    say "[Unit]"
    say "Description=Cairn ($NAME) updater timer: $rs_what"
    say ""
    say "[Timer]"
    if [ "$2" = "nightly" ]; then
      say "OnCalendar=*-*-* $UPDATE_HOUR:$UPDATE_MINUTE:00"
      say "Persistent=true"
    else
      say "OnCalendar=*:0/5"
      say "AccuracySec=30s"
    fi
    say ""
    say "[Install]"
    say "WantedBy=timers.target"
  fi
}

# Strip one leading zero so "08" is not read as octal by printf / arithmetic.
num() { num_v="${1#0}"; printf '%s' "${num_v:-0}"; }

cron_marker() { printf '# cairn-updater:%s' "$NAME"; }

render_cron() {
  say "$(num "$UPDATE_MINUTE") $(num "$UPDATE_HOUR") * * * /bin/sh $DIR/cairn.sh update --nightly --dir=$DIR >>$DIR/updater.log 2>&1 $(cron_marker)"
  say "*/5 * * * * /bin/sh $DIR/cairn.sh update --if-requested --dir=$DIR >>$DIR/updater.log 2>&1 $(cron_marker)"
}

launchd_label() { printf 'local.cairn.%s.%s' "$NAME" "$1"; }

# render_launchd nightly|check
render_launchd() {
  if [ "$1" = "nightly" ]; then rl_label=$(launchd_label update); rl_flag="--nightly"; else rl_label=$(launchd_label update-check); rl_flag="--if-requested"; fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$rl_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>$DIR/cairn.sh</string><string>update</string>
    <string>$rl_flag</string><string>--dir=$DIR</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(unit_path)</string></dict>
EOF
  if [ "$1" = "nightly" ]; then
    printf '  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' "$(num "$UPDATE_HOUR")" "$(num "$UPDATE_MINUTE")"
  else
    printf '  <key>StartInterval</key><integer>300</integer>\n'
  fi
  cat <<EOF
  <key>StandardOutPath</key><string>$DIR/updater.log</string>
  <key>StandardErrorPath</key><string>$DIR/updater.log</string>
</dict>
</plist>
EOF
}

print_file() { printf '\n----- %s -----\n' "$1"; cat; printf -- '----- end -----\n'; }

print_updater_files() {
  case "$UPDATER" in
    systemd | systemd-user)
      if [ "$UPDATER" = "systemd" ]; then pu_dir="/etc/systemd/system"; else pu_dir="\$HOME/.config/systemd/user"; fi
      render_systemd service nightly | print_file "$pu_dir/$NAME-update.service"
      render_systemd timer nightly | print_file "$pu_dir/$NAME-update.timer"
      render_systemd service check | print_file "$pu_dir/$NAME-update-check.service"
      render_systemd timer check | print_file "$pu_dir/$NAME-update-check.timer" ;;
    cron) render_cron | print_file "crontab entries" ;;
    launchd)
      render_launchd nightly | print_file "\$HOME/Library/LaunchAgents/$(launchd_label update).plist"
      render_launchd check | print_file "\$HOME/Library/LaunchAgents/$(launchd_label update-check).plist" ;;
    none) say "" ; say "(no automatic updater; run '$DIR/cairn.sh update' yourself)" ;;
  esac
}

# Atomic write of stdin to $1 with mode $2.
write_file() {
  wf_tmp="$1.tmp.$$"
  TMP_FILES="$TMP_FILES $wf_tmp"
  cat >"$wf_tmp"
  chmod "$2" "$wf_tmp"
  mv -f "$wf_tmp" "$1"
}

# Keep a copy of this script next to the compose file as cairn.sh: the updater
# and the update/status/uninstall commands run it. Under `curl | sh` there is no
# file to copy, so it is fetched again from the same HTTPS URL and checked.
install_self() {
  is_dest="$DIR/cairn.sh"
  is_src=""
  if [ -f "$0" ] && grep -q "$MARKER" "$0" 2>/dev/null; then is_src="$0"; fi
  if [ -n "$is_src" ]; then
    is_src_abs="$(cd "$(dirname "$is_src")" && pwd)/$(basename "$is_src")"
    if [ "$is_src_abs" = "$is_dest" ]; then return 0; fi
    write_file "$is_dest" 700 <"$is_src"
    return 0
  fi
  is_url="${CAIRN_INSTALL_SCRIPT_URL:-$DEFAULT_SCRIPT_URL}"
  case "$is_url" in https://*) ;; *) die "CAIRN_INSTALL_SCRIPT_URL must be an https:// URL." ;; esac
  is_tmp="$DIR/cairn.sh.download.$$"
  TMP_FILES="$TMP_FILES $is_tmp"
  curl -fsSL --proto '=https' --tlsv1.2 "$is_url" -o "$is_tmp" || die "Could not download $is_url"
  grep -q "$MARKER" "$is_tmp" || die "$is_url is not the Cairn installer."
  sh -n "$is_tmp" || die "$is_url did not pass a syntax check."
  chmod 700 "$is_tmp"
  mv -f "$is_tmp" "$is_dest"
}

write_config() {
  umask 077
  mkdir -p "$DIR"
  chmod 700 "$DIR"
  install_self # first: a failed fetch leaves no half-written install behind
  if [ -z "$TOKEN" ]; then TOKEN=$(rand_hex 32); fi
  if [ -z "$SECRET" ]; then SECRET=$(rand_hex 32); fi
  render_env real | write_file "$ENV_FILE" 600
  if [ -f "$DIR/docker-compose.yml" ] && ! grep -q "$MARKER" "$DIR/docker-compose.yml"; then
    wc_bak="$DIR/docker-compose.yml.before-installer"
    cp "$DIR/docker-compose.yml" "$wc_bak"
    warn "Saved your existing docker-compose.yml as $wc_bak (the installer manages this file now)."
  fi
  render_compose | write_file "$DIR/docker-compose.yml" 600
  if [ "$EXPOSURE" = "caddy" ]; then
    render_caddyfile | write_file "$DIR/Caddyfile" 644
  else
    rm -f "$DIR/Caddyfile"
  fi
  ok "Wrote $DIR (docker-compose.yml, .env, cairn.sh)."
}

# ----------------------------------------------------------------------------- state + status

state_get() { env_get "$1" "$STATE_FILE"; }

state_set() {
  ss_val=$(printf '%s' "$2" | tr -d '\n\r')
  {
    if [ -f "$STATE_FILE" ]; then grep -v "^$1=" "$STATE_FILE" || true; fi
    printf '%s=%s\n' "$1" "$ss_val"
  } | write_file "$STATE_FILE" 600
}

health_body() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true; }
health_ok() { health_body | grep -q '"ok":true'; }
health_version() { health_body | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

wait_health() {
  wh_waited=0
  while [ "$wh_waited" -lt "$HEALTH_TIMEOUT" ]; do
    if health_ok; then return 0; fi
    sleep 3
    wh_waited=$((wh_waited + 3))
  done
  return 1
}

status_json() {
  printf '{"installed":true,"last_run":%s,"last_result":%s,"trigger":%s,"version":%s,"previous_version":%s,"detail":%s,"last_check":%s,"scheduler":%s,"schedule":%s,"installer_version":%s}' \
    "$(json_str "$(state_get last_run)")" "$(json_str "$(state_get last_result)")" \
    "$(json_str "$(state_get last_trigger)")" "$(json_str "$(state_get version)")" \
    "$(json_str "$(state_get previous_version)")" "$(json_str "$(state_get detail)")" \
    "$(json_str "$(now_iso)")" "$(json_str "$UPDATER")" \
    "$(json_str "nightly at $UPDATE_TIME; Update now requests within 5 minutes")" \
    "$(json_str "$INSTALLER_VERSION")"
}

# Publish the updater's status inside the data volume (for Settings) and on the host.
publish_status() {
  ps_json=$(status_json)
  printf '%s\n' "$ps_json" | write_file "$DIR/updater-status.json" 600
  if c_running; then
    printf '%s\n' "$ps_json" | "$CLI" exec -i -u app "$NAME" sh -c "cat > $STATUS_FILE.tmp && mv -f $STATUS_FILE.tmp $STATUS_FILE" >/dev/null 2>&1 \
      || warn "Could not write $STATUS_FILE inside the container."
  fi
}

record_result() { # result trigger detail version previous_version
  state_set last_run "$(now_iso)"
  state_set last_result "$1"
  state_set last_trigger "$2"
  state_set detail "$3"
  state_set version "$4"
  state_set previous_version "$5"
}

# ----------------------------------------------------------------------------- scheduler

systemctl_scope() { if [ "$UPDATER" = "systemd-user" ]; then systemctl --user "$@"; else systemctl "$@"; fi; }

systemd_unit_dir() {
  if [ "$UPDATER" = "systemd" ]; then printf '/etc/systemd/system'; else printf '%s/systemd/user' "${XDG_CONFIG_HOME:-$HOME/.config}"; fi
}

install_updater() {
  remove_updater quiet
  case "$UPDATER" in
    systemd | systemd-user)
      iu_dir=$(systemd_unit_dir)
      mkdir -p "$iu_dir"
      render_systemd service nightly | write_file "$iu_dir/$NAME-update.service" 644
      render_systemd timer nightly | write_file "$iu_dir/$NAME-update.timer" 644
      render_systemd service check | write_file "$iu_dir/$NAME-update-check.service" 644
      render_systemd timer check | write_file "$iu_dir/$NAME-update-check.timer" 644
      systemctl_scope daemon-reload
      systemctl_scope enable --now "$NAME-update.timer" "$NAME-update-check.timer" >/dev/null 2>&1 \
        || die "Could not enable the updater timers ($UPDATER). Re-run with --updater=cron to use cron instead."
      ok "Updater: systemd timers $NAME-update.timer (nightly $UPDATE_TIME) and $NAME-update-check.timer (every 5 min)."
      if [ "$UPDATER" = "systemd-user" ]; then
        iu_user=$(id -un)
        if [ "$(loginctl show-user "$iu_user" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
          loginctl enable-linger "$iu_user" >/dev/null 2>&1 || true
        fi
        if [ "$(loginctl show-user "$iu_user" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
          LINGER_NOTE="Your user timers only run while you are logged in. To keep updates running after you log out: sudo loginctl enable-linger $iu_user"
          warn "$LINGER_NOTE"
        fi
      fi
      if [ "$ENGINE" = "podman" ]; then
        # Podman has no daemon to honour restart: unless-stopped after a reboot.
        systemctl_scope enable podman-restart.service >/dev/null 2>&1 || true
      fi ;;
    cron)
      has crontab || die "crontab is not available; re-run with --updater=none and update by hand."
      {
        crontab -l 2>/dev/null | grep -vF "$(cron_marker)" || true
        render_cron
      } | crontab - || die "Could not install the crontab entries."
      ok "Updater: cron (nightly $UPDATE_TIME, Update-now check every 5 min; log $DIR/updater.log)." ;;
    launchd)
      iu_dir="$HOME/Library/LaunchAgents"
      mkdir -p "$iu_dir"
      for iu_kind in nightly check; do
        if [ "$iu_kind" = "nightly" ]; then iu_label=$(launchd_label update); else iu_label=$(launchd_label update-check); fi
        render_launchd "$iu_kind" | write_file "$iu_dir/$iu_label.plist" 644
        launchctl load -w "$iu_dir/$iu_label.plist" >/dev/null 2>&1 || warn "launchctl could not load $iu_label"
      done
      ok "Updater: launchd agents (nightly $UPDATE_TIME, Update-now check every 5 min; log $DIR/updater.log)." ;;
    none) warn "No automatic updater installed. Update with: sh $DIR/cairn.sh update" ;;
  esac
}

# Remove every kind of updater this instance may have had (best effort).
remove_updater() {
  if has systemctl; then
    for ru_scope in system user; do
      if [ "$ru_scope" = "system" ]; then
        is_root || continue
        ru_dir="/etc/systemd/system"
      else
        ru_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      fi
      if [ -f "$ru_dir/$NAME-update.timer" ] || [ -f "$ru_dir/$NAME-update-check.timer" ]; then
        if [ "$ru_scope" = "user" ]; then ru_sc="--user"; else ru_sc=""; fi
        # shellcheck disable=SC2086 # ru_sc is empty or one flag
        systemctl $ru_sc disable --now "$NAME-update.timer" "$NAME-update-check.timer" >/dev/null 2>&1 || true
        rm -f "$ru_dir/$NAME-update.service" "$ru_dir/$NAME-update.timer" \
          "$ru_dir/$NAME-update-check.service" "$ru_dir/$NAME-update-check.timer"
        # shellcheck disable=SC2086
        systemctl $ru_sc daemon-reload >/dev/null 2>&1 || true
        [ "${1:-}" = "quiet" ] || ok "Removed the systemd updater timers."
      fi
    done
  fi
  if has crontab && crontab -l 2>/dev/null | grep -qF "$(cron_marker)"; then
    { crontab -l 2>/dev/null | grep -vF "$(cron_marker)" || true; } | crontab - || true
    [ "${1:-}" = "quiet" ] || ok "Removed the cron updater entries."
  fi
  if [ "$PLATFORM" = "macos" ]; then
    for ru_label in "$(launchd_label update)" "$(launchd_label update-check)"; do
      ru_plist="$HOME/Library/LaunchAgents/$ru_label.plist"
      if [ -f "$ru_plist" ]; then
        launchctl unload -w "$ru_plist" >/dev/null 2>&1 || true
        rm -f "$ru_plist"
        [ "${1:-}" = "quiet" ] || ok "Removed launchd agent $ru_label."
      fi
    done
  fi
}

# ----------------------------------------------------------------------------- tailscale

ts_dns_name() {
  tailscale status --json 2>/dev/null | grep -o '"DNSName": *"[^"]*"' | head -n 1 | cut -d'"' -f4 | sed 's/\.$//' || true
}

ts_run() { # tailscale CLI, falling back to sudo (Linux needs root unless an operator is set)
  if tailscale "$@" >/dev/null 2>&1; then return 0; fi
  if ! is_root && has sudo; then sudo tailscale "$@" >/dev/null 2>&1 && return 0; fi
  return 1
}

ts_serves_us() { tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; }

setup_tailscale() {
  TS_URL=""
  TS_NOTE=""
  if ! has tailscale; then
    TS_NOTE="Tailscale is not installed here. Install it (https://tailscale.com/download), run 'sudo tailscale up', then re-run this installer with --https=tailscale."
    warn "$TS_NOTE"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    TS_NOTE="Tailscale is installed but not connected. Run 'sudo tailscale up', then re-run this installer with --https=tailscale."
    warn "$TS_NOTE"
    return 0
  fi
  if ts_serves_us; then
    ok "Tailscale Serve already points https at Cairn."
  else
    st_status=$(tailscale serve status 2>/dev/null || true)
    if [ -n "$st_status" ] && ! printf '%s' "$st_status" | grep -qi "no serve config"; then
      warn "Tailscale Serve already has a configuration on this machine:"
      printf '%s\n' "$st_status" >&2
      if ! confirm "Point https://<this machine>/ at Cairn instead (replaces the handler for /)?" "n"; then
        TS_NOTE="Skipped Tailscale Serve. To do it later: tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
        warn "$TS_NOTE"
        return 0
      fi
    fi
    info "Enabling Tailscale Serve (tailnet-only HTTPS; nothing is exposed to the internet)..."
    if ts_run serve --bg --https=443 "http://127.0.0.1:$PORT"; then
      ok "Tailscale Serve enabled."
    else
      TS_NOTE="Could not enable Tailscale Serve. Your tailnet admin may need to turn on MagicDNS + HTTPS certificates (https://login.tailscale.com/admin/dns); then run: sudo tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
      warn "$TS_NOTE"
      return 0
    fi
  fi
  st_dns=$(ts_dns_name)
  if [ -n "$st_dns" ]; then TS_URL="https://$st_dns/"; fi
}

teardown_tailscale() {
  if has tailscale && ts_serves_us; then
    if ts_run serve --https=443 off; then ok "Turned off Tailscale Serve for Cairn."; else warn "Could not turn off Tailscale Serve; run: sudo tailscale serve --https=443 off"; fi
  fi
}

# ----------------------------------------------------------------------------- install

print_plan() {
  step "Cairn install plan"
  say "  Machine:     $PLATFORM/$ARCH"
  say "  Directory:   $DIR"
  say "  Instance:    $NAME (container '$NAME', volumes ${NAME}_cairn-data / ${NAME}_cairn-home / ${NAME}_cairn-tools)"
  say "  Image:       $IMAGE"
  case "$EXPOSURE" in
    local) say "  Reach it:    loopback only, http://127.0.0.1:$PORT (SSH tunnel from elsewhere)" ;;
    lan) say "  Reach it:    your LAN, http://<this machine>:$PORT (plain HTTP; token required)" ;;
    tailscale) say "  Reach it:    your tailnet, https://<this machine>.<tailnet>.ts.net/ (Tailscale Serve, private)" ;;
    caddy) say "  Reach it:    the internet, https://$DOMAIN/ (Caddy, ports 80 + 443; token required)" ;;
  esac
  say "  Timezone:    $TZ_VALUE"
  say "  Token:       $([ "$TOKEN_STATE" = kept ] && printf 'keeping the existing one' || printf 'a new random token')"
  case "$UPDATER" in
    none) say "  Updates:     manual ($DIR/cairn.sh update)" ;;
    *) say "  Updates:     automatic via $UPDATER, nightly at $UPDATE_TIME + within 5 min of \"Update now\"" ;;
  esac
  tel_plan_line
}

cmd_install() {
  compute_config
  if [ "$OPT_DRY_RUN" = 1 ]; then
    choose_updater
    print_plan
    say ""
    say "Dry run: nothing was changed. These files would be written:"
    render_env redacted | print_file "$ENV_FILE (mode 600)"
    render_compose | print_file "$DIR/docker-compose.yml"
    if [ "$EXPOSURE" = "caddy" ]; then render_caddyfile | print_file "$DIR/Caddyfile"; fi
    say ""
    say "Updater ($UPDATER):"
    print_updater_files
    say ""
    say "Then: $( [ "$OPT_NO_START" = 1 ] && printf 'nothing is started (--no-start)' || printf 'compose up -d, wait for /api/health, install the updater')."
    return 0
  fi

  has curl || die "curl is required (it is how this installer checks Cairn's health)."
  if [ "$PLATFORM" = "linux" ] && [ -r /proc/meminfo ]; then
    ci_mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    if [ "${ci_mem:-0}" -gt 0 ] && [ "$ci_mem" -lt 900 ]; then
      warn "Only ${ci_mem} MB of RAM. Cairn needs about 1 GB; add swap if it gets killed."
    fi
  fi
  if [ "$OPT_NO_START" != 1 ]; then
    # No container engine is the likeliest stop on this path, and it comes before the plan.
    tel_arm engine
    ensure_engine
    tel_disarm
    ENGINE="$CLI"
    if c_exists; then
      ci_proj=$(container_project)
      if [ "$ci_proj" != "$NAME" ]; then
        die "A container named '$NAME' already exists and was not created by this installer (project '${ci_proj:-none}'). Remove it first, or install a separate instance with --name=other --port=other."
      fi
    elif health_ok; then
      die "Something already answers Cairn's health check on port $PORT. Pick another port with --port=."
    fi
    if [ "$EXPOSURE" = "caddy" ] && [ "$ENGINE" = "podman" ] && ! is_root; then
      warn "Rootless Podman cannot listen on ports 80/443 by default. Run the installer with sudo, or allow it once:"
      warn "  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80   (persist it in /etc/sysctl.d/)"
    fi
  fi
  choose_updater
  print_plan
  confirm "Install Cairn with these settings?" "y" || die "Cancelled; nothing was changed."
  tel_chose download

  step "Writing configuration"
  write_config
  if [ "$OPT_NO_START" = 1 ]; then
    say ""
    ok "Configuration written (--no-start). Start it with: sh $DIR/cairn.sh install"
    tel_done
    return 0
  fi

  TEL_STEP="other"
  acquire_lock || die "An update is running right now; try again in a few minutes."
  step "Starting Cairn"
  info "Pulling the image and starting the container (the first pull can take a few minutes)..."
  TEL_STEP="start"
  compose up -d --remove-orphans || die "Starting Cairn failed. See: cd $DIR && $COMPOSE -p $NAME logs --tail=80"
  info "Waiting for Cairn to report healthy (up to ${HEALTH_TIMEOUT}s)..."
  TEL_STEP="health"
  wait_health || die "Cairn did not become healthy in ${HEALTH_TIMEOUT}s. See: cd $DIR && $COMPOSE -p $NAME logs --tail=80 cairn"
  ci_version=$(health_version)
  ok "Cairn ${ci_version:+v$ci_version }is healthy."

  TS_URL=""; TS_NOTE=""; LINGER_NOTE=""
  TEL_STEP="other"
  if [ "$EXPOSURE" = "tailscale" ]; then step "Private HTTPS (Tailscale Serve)"; setup_tailscale
  elif [ "$E_EXPOSURE" = "tailscale" ]; then teardown_tailscale; fi

  step "Automatic updates"
  TEL_STEP="updater"
  install_updater
  if [ -z "$(state_get last_result)" ]; then
    record_result current install "installed" "$ci_version" ""
  fi
  publish_status
  print_summary "$ci_version"
  tel_done
}

print_summary() {
  step "${C_GREEN}Cairn is running${1:+ (v$1)}."
  say ""
  say "  ${C_BOLD}Open it${C_RESET}"
  case "$EXPOSURE" in
    local)
      say "    On this machine:  http://127.0.0.1:$PORT"
      if [ "$PLATFORM" = "linux" ]; then
        say "    From your laptop: ssh -N -L $PORT:127.0.0.1:$PORT $(id -un)@<this-server>   then open http://localhost:$PORT"
        say "    For your phone, re-run with --https=tailscale (private) or --https=caddy --domain=... (public)."
      fi ;;
    lan)
      say "    On your network:  http://$(lan_ip):$PORT"
      say "    Plain HTTP: the app works, but phones only install it offline-capable over HTTPS (--https=tailscale)." ;;
    tailscale)
      if [ -n "$TS_URL" ]; then say "    On your tailnet:  $TS_URL   (phone: install the Tailscale app and sign in)"
      else say "    Tailscale Serve is not set up yet: ${TS_NOTE:-see above}"; fi
      say "    On this machine:  http://127.0.0.1:$PORT" ;;
    caddy)
      say "    Public URL:       https://$DOMAIN/"
      say "    (DNS for $DOMAIN must point at this server and ports 80 + 443 must be open; the"
      say "     certificate arrives within a minute of the first visit. Logs: $COMPOSE -p $NAME logs caddy)" ;;
  esac
  say ""
  signin_block "http://127.0.0.1:$PORT" "$(local_link_origin)" "$TOKEN" "$ENV_FILE (CAIRN_AUTH_TOKEN)" 1 "$DIR"
  say ""
  say "  ${C_BOLD}Coaching${C_RESET}"
  say "    Settings -> Agents -> Connect signs in to Claude, Codex, Grok or Antigravity right in the app."
  say ""
  say "  ${C_BOLD}Updates${C_RESET}"
  case "$UPDATER" in
    none) say "    Manual: sh $DIR/cairn.sh update" ;;
    *)
      say "    Automatic: each night at $UPDATE_TIME, and within 5 minutes of Settings -> \"Update now\"."
      say "    A release that does not come up healthy is rolled back to the previous one by itself." ;;
  esac
  if [ -n "${LINGER_NOTE:-}" ]; then say "    Note: $LINGER_NOTE"; fi
  say "    Now: sh $DIR/cairn.sh update      Status: sh $DIR/cairn.sh status"
  say "    Sign in again later (a fresh one-time link): sh $DIR/cairn.sh open"
  say ""
  say "  ${C_BOLD}Data and uninstall${C_RESET}"
  say "    Your data lives in the volumes ${NAME}_cairn-data and ${NAME}_cairn-home (backups: docs/OPERATIONS.md)."
  say "    Uninstall: sh $DIR/cairn.sh uninstall   (keeps your data; add --purge to delete it)"
  say ""
  recovery_block "$TOKEN" "$ENV_FILE (CAIRN_AUTH_TOKEN)"
  say ""
}

# ----------------------------------------------------------------------------- update

require_install() {
  if ! { [ -f "$ENV_FILE" ] && [ -f "$DIR/docker-compose.yml" ]; }; then
    die "No Cairn install found in $DIR. Install first, or point at it with --dir=."
  fi
  grep -q "$MARKER" "$DIR/docker-compose.yml" || die "$DIR/docker-compose.yml was not written by this installer."
}

trim_log() {
  tl_log="$DIR/updater.log"
  if [ -f "$tl_log" ] && [ "$(wc -c <"$tl_log" | tr -d ' ')" -gt 1048576 ]; then
    tail -n 2000 "$tl_log" | write_file "$tl_log" 600
  fi
}

acquire_lock() {
  LOCK_DIR="$DIR/.update.lock"
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" >"$LOCK_DIR/pid"; LOCK_HELD=1; return 0; fi
  al_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$al_pid" ] && kill -0 "$al_pid" 2>/dev/null; then return 1; fi
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" >"$LOCK_DIR/pid"; LOCK_HELD=1; return 0; fi
  return 1
}

release_lock() {
  if [ "${LOCK_HELD:-0}" = 1 ]; then rm -rf "$LOCK_DIR"; LOCK_HELD=0; fi
}

# Best-effort consistent SQLite snapshot through the app's own export (VACUUM INTO),
# so a release whose migration misbehaves can be restored by hand. Keeps the last 3.
snapshot_db() {
  [ -n "$TOKEN" ] || return 0
  sd_dir="$DIR/backups"
  mkdir -p "$sd_dir"
  chmod 700 "$sd_dir"
  sd_out="$sd_dir/pre-update-$(date -u '+%Y%m%dT%H%M%SZ').db"
  TMP_FILES="$TMP_FILES $sd_out.part"
  # The token travels on stdin (-K -), never in argv where other users could see it.
  if printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
    | curl -fsS --max-time 900 -K - -o "$sd_out.part" "http://127.0.0.1:$PORT/api/export/db" 2>/dev/null; then
    mv -f "$sd_out.part" "$sd_out"
    chmod 600 "$sd_out"
    info "Saved a pre-update database snapshot: $sd_out"
    # shellcheck disable=SC2012 # names are ours: pre-update-<UTC stamp>.db
    ls -1t "$sd_dir"/pre-update-*.db 2>/dev/null | tail -n +4 | while IFS= read -r sd_old; do rm -f "$sd_old"; done
  else
    rm -f "$sd_out.part"
    warn "Could not take a pre-update snapshot (continuing; back up from Settings -> Data if unsure)."
  fi
}

# Sets UPDATE_RESULT (updated|current|rolled_back|failed) and UPDATE_DETAIL.
# Never called in a conditional, so `set -e` stays meaningful inside it.
run_update() {
  UPDATE_RESULT="failed"; UPDATE_DETAIL=""
  ROLLBACK_REF="localhost/cairn-rollback:$NAME"
  ru_prev_version=$(health_version)
  UPDATE_PREV_VERSION="$ru_prev_version"
  UPDATE_VERSION="$ru_prev_version"
  ru_old_id=$(running_image_id)
  if [ "$1" = "nightly" ] && c_exists && ! c_running; then
    # Someone stopped it on purpose (restart: unless-stopped); a timer must not revive it.
    UPDATE_RESULT="current"
    UPDATE_DETAIL="Cairn is stopped, so it was left alone; updates resume once it runs again"
    info "$UPDATE_DETAIL."
    return 0
  fi
  info "Checking for a new Cairn release ($IMAGE)..."
  if ! compose pull; then
    UPDATE_DETAIL="could not pull the image (network or registry problem)"
    return 0
  fi
  ru_new_id=$(image_id "$IMAGE")
  if [ -z "$ru_new_id" ]; then UPDATE_DETAIL="image $IMAGE missing after pull"; return 0; fi

  if [ "$ru_new_id" = "$ru_old_id" ] && c_running; then
    UPDATE_RESULT="current"; UPDATE_DETAIL="already on the latest release"
    ok "Already up to date${ru_prev_version:+ (v$ru_prev_version)}."
    return 0
  fi
  ru_held=$(state_get held_back_image)
  if [ "$ru_new_id" = "$ru_held" ] && [ "$OPT_FORCE" != 1 ] && c_running; then
    UPDATE_RESULT="current"
    UPDATE_DETAIL="the newest release was rolled back earlier after failing its health check; it is held back until a newer one ships (or run update --force)"
    # The pull moved the local tag onto the held-back image; point it back at the
    # running one so a later `compose up` (a re-run of the installer) keeps it.
    if [ -n "$ru_old_id" ]; then "$CLI" tag "$ru_old_id" "$IMAGE" >/dev/null 2>&1 || true; fi
    warn "$UPDATE_DETAIL"
    return 0
  fi

  if c_running && health_ok; then snapshot_db; fi
  ru_prev_rollback=$(image_id "$ROLLBACK_REF")
  if [ -n "$ru_old_id" ]; then
    "$CLI" tag "$ru_old_id" "$ROLLBACK_REF" >/dev/null 2>&1 || warn "Could not tag the current image for rollback."
  fi

  info "Starting the new release..."
  if compose up -d --force-recreate cairn && compose up -d && wait_health; then
    UPDATE_RESULT="updated"
    UPDATE_VERSION=$(health_version)
    UPDATE_DETAIL="updated${ru_prev_version:+ from v$ru_prev_version}${UPDATE_VERSION:+ to v$UPDATE_VERSION}"
    state_set held_back_image ""
    if [ -n "$ru_prev_rollback" ] && [ "$ru_prev_rollback" != "$ru_old_id" ] && [ "$ru_prev_rollback" != "$ru_new_id" ]; then
      "$CLI" rmi "$ru_prev_rollback" >/dev/null 2>&1 || true
    fi
    ok "Cairn $UPDATE_DETAIL."
    return 0
  fi

  warn "The new release did not become healthy within ${HEALTH_TIMEOUT}s; rolling back."
  state_set held_back_image "$ru_new_id"
  if [ -z "$ru_old_id" ]; then
    UPDATE_DETAIL="new release unhealthy and there was no previous image to roll back to"
    return 0
  fi
  "$CLI" tag "$ROLLBACK_REF" "$IMAGE" >/dev/null 2>&1 || true
  if compose up -d --force-recreate cairn && wait_health; then
    UPDATE_RESULT="rolled_back"
    UPDATE_VERSION=$(health_version)
    UPDATE_DETAIL="the new release failed its health check; back on${UPDATE_VERSION:+ v$UPDATE_VERSION}"
    warn "Rolled back: $UPDATE_DETAIL."
  else
    UPDATE_DETAIL="the new release failed its health check and the rollback did not come up healthy either"
    warn "$UPDATE_DETAIL. See: cd $DIR && $COMPOSE -p $NAME logs --tail=80 cairn"
  fi
}

cmd_update() {
  require_install
  compute_config
  UPDATER="${E_UPDATER:-none}"
  TOKEN="$E_TOKEN"
  if [ "$OPT_DRY_RUN" = 1 ]; then
    say "Dry run: would pull $IMAGE, restart $NAME only if the image changed, wait up to ${HEALTH_TIMEOUT}s for /api/health and roll back if unhealthy."
    return 0
  fi
  [ "$STAMP" = 1 ] && trim_log
  if [ "$OPT_NIGHTLY" = 1 ]; then cu_trigger="nightly"; elif [ "$OPT_IF_REQUESTED" = 1 ]; then cu_trigger="requested"; else cu_trigger="manual"; fi
  if ! resolve_engine || [ -z "$COMPOSE" ]; then
    [ "$OPT_IF_REQUESTED" = 1 ] && exit 0 # engine down: stay quiet every 5 minutes
    record_result failed "$cu_trigger" "container engine unavailable: $ENGINE_WHY" "$(state_get version)" ""
    printf '%s\n' "$(status_json)" | write_file "$DIR/updater-status.json" 600
    die "Container engine unavailable: $ENGINE_WHY"
  fi
  if ! acquire_lock; then
    [ "$OPT_IF_REQUESTED" = 1 ] || warn "Another update is already running."
    exit 0
  fi
  if [ "$OPT_IF_REQUESTED" = 1 ]; then
    c_running || exit 0
    if ! "$CLI" exec "$NAME" test -f "$TRIGGER_FILE" >/dev/null 2>&1; then
      publish_status # heartbeat: lets Settings show the updater is alive
      exit 0
    fi
    info "Update requested from the app."
  fi
  run_update "$cu_trigger"
  if [ "$UPDATE_RESULT" = "updated" ]; then cu_prev="$UPDATE_PREV_VERSION"; else cu_prev=""; fi
  record_result "$UPDATE_RESULT" "$cu_trigger" "$UPDATE_DETAIL" "$UPDATE_VERSION" "$cu_prev"
  if [ "$cu_trigger" = "requested" ]; then
    "$CLI" exec "$NAME" rm -f "$TRIGGER_FILE" >/dev/null 2>&1 || true
  fi
  publish_status
  release_lock
  [ "$UPDATE_RESULT" != "failed" ] || exit 1
}

# ----------------------------------------------------------------------------- status

cmd_status() {
  require_install
  compute_config
  UPDATER="${E_UPDATER:-none}"
  step "Cairn ($NAME) in $DIR"
  if resolve_engine && [ -n "$COMPOSE" ]; then
    say "  Engine:     $CLI ($COMPOSE)"
    if c_running; then
      cs_version=$(health_version)
      if health_ok; then cs_health="healthy"; else cs_health="not answering /api/health"; fi
      say "  Container:  running, $cs_health${cs_version:+, v$cs_version}"
    elif c_exists; then
      say "  Container:  stopped (start: cd $DIR && $COMPOSE -p $NAME up -d)"
    else
      say "  Container:  not created (run: sh $DIR/cairn.sh install)"
    fi
  else
    say "  Engine:     unavailable ($ENGINE_WHY)"
  fi
  case "$EXPOSURE" in
    local) say "  Reach it:   http://127.0.0.1:$PORT (loopback only)" ;;
    lan) say "  Reach it:   http://$(lan_ip):$PORT (LAN)" ;;
    tailscale)
      cs_dns=""; if has tailscale; then cs_dns=$(ts_dns_name); fi
      if has tailscale && ts_serves_us; then say "  Reach it:   https://${cs_dns:-<this machine>.<tailnet>.ts.net}/ (Tailscale Serve)"
      else say "  Reach it:   Tailscale Serve is NOT active; re-run: sh $DIR/cairn.sh install --https=tailscale"; fi ;;
    caddy) say "  Reach it:   https://$DOMAIN/ (Caddy)" ;;
  esac
  say "  Token:      in $ENV_FILE (CAIRN_AUTH_TOKEN; not shown)"
  case "$UPDATER" in
    systemd | systemd-user)
      say "  Updater:    $UPDATER timers (nightly $UPDATE_TIME, Update-now check every 5 min)"
      systemctl_scope list-timers "$NAME-update*" --no-pager 2>/dev/null | sed 's/^/              /' || true ;;
    cron) say "  Updater:    cron (nightly $UPDATE_TIME); $(crontab -l 2>/dev/null | grep -cF "$(cron_marker)" || true) entries installed" ;;
    launchd) say "  Updater:    launchd (nightly $UPDATE_TIME, Update-now check every 5 min)" ;;
    *) say "  Updater:    none (manual: sh $DIR/cairn.sh update)" ;;
  esac
  cs_last=$(state_get last_result)
  if [ -n "$cs_last" ]; then
    say "  Last run:   $(state_get last_run): $cs_last ($(state_get last_trigger)) $(state_get detail)"
  else
    say "  Last run:   never"
  fi
  if [ -d "$DIR/backups" ]; then
    # shellcheck disable=SC2012
    cs_snap=$(ls -1t "$DIR"/backups/pre-update-*.db 2>/dev/null | head -n 1 || true)
    if [ -n "$cs_snap" ]; then say "  Snapshot:   $cs_snap"; fi
  fi
}

# ----------------------------------------------------------------------------- uninstall

cmd_uninstall() {
  # After a plain uninstall only .env (and backups) remain; --purge must still work.
  if ! grep -q '^## Cairn instance settings' "$ENV_FILE" 2>/dev/null; then
    die "No installer-managed Cairn found in $DIR (point at it with --dir=)."
  fi
  compute_config
  UPDATER="${E_UPDATER:-none}"
  if [ "$OPT_PURGE" = 1 ]; then
    if [ -n "$OPT_CONFIRM_PURGE" ]; then
      [ "$OPT_CONFIRM_PURGE" = "$NAME" ] || die "--confirm-purge must be the instance name '$NAME'."
    elif has_tty; then
      warn "--purge permanently deletes ALL of this Cairn's data: the database (training, nutrition,"
      warn "health records), agent logins, certificates and $ENV_FILE. This cannot be undone."
      printf '%s  ? %sType the instance name (%s) to delete everything: ' "$C_YELLOW" "$C_RESET" "$NAME" >/dev/tty
      cu_typed=""
      read -r cu_typed </dev/tty || cu_typed=""
      [ "$cu_typed" = "$NAME" ] || die "Not confirmed; nothing was removed."
    else
      die "--purge deletes all data and needs explicit confirmation: run it in a terminal, or add --confirm-purge=$NAME."
    fi
  fi
  if [ "$OPT_DRY_RUN" = 1 ]; then
    say "Dry run: would remove the updater, stop and remove the $NAME containers, delete docker-compose.yml, Caddyfile and cairn.sh in $DIR"
    if [ "$OPT_PURGE" = 1 ]; then say "and DELETE the volumes ${NAME}_cairn-data, ${NAME}_cairn-home, ${NAME}_cairn-tools, .env and backups."
    else say "and keep the data volumes, .env (token + settings key) and backups."; fi
    return 0
  fi
  if [ "$OPT_PURGE" != 1 ]; then
    confirm "Remove Cairn ($NAME) from $DIR? Your data volumes and .env are kept." "n" || die "Cancelled; nothing was removed."
  fi

  step "Removing Cairn ($NAME)"
  remove_updater
  teardown_tailscale
  if resolve_engine && [ -n "$COMPOSE" ] && [ -f "$DIR/docker-compose.yml" ]; then
    if [ "$OPT_PURGE" = 1 ]; then
      compose down --volumes --remove-orphans || warn "compose down reported an error."
    else
      compose down --remove-orphans || warn "compose down reported an error."
    fi
    "$CLI" rmi "localhost/cairn-rollback:$NAME" >/dev/null 2>&1 || true
    ok "Stopped and removed the containers."
  elif [ -n "${CLI:-}" ]; then
    # Compose file already gone (an earlier uninstall): act on the known names.
    "$CLI" rm -f "$NAME" "$NAME-caddy" >/dev/null 2>&1 || true
    if [ "$OPT_PURGE" = 1 ]; then
      for cu_vol in cairn-data cairn-home cairn-tools caddy-data caddy-config; do
        "$CLI" volume rm "${NAME}_$cu_vol" >/dev/null 2>&1 || true
      done
      ok "Removed the ${NAME}_* data volumes."
    fi
  else
    warn "No container engine reachable ($ENGINE_WHY); containers were not touched."
  fi
  rm -f "$DIR/docker-compose.yml" "$DIR/Caddyfile" "$DIR/updater-status.json" "$DIR/updater.state" "$DIR/updater.log"
  rm -rf "$DIR/.update.lock"
  if [ "$OPT_PURGE" = 1 ]; then
    rm -f "$ENV_FILE"
    rm -rf "$DIR/backups"
    rm -f "$DIR/cairn.sh"
    rmdir "$DIR" 2>/dev/null || warn "$DIR still has files you added; left in place."
    ok "Cairn and all of its data are gone."
  else
    rm -f "$DIR/cairn.sh"
    ok "Cairn is uninstalled. Kept:"
    say "    - volumes ${NAME}_cairn-data (database) and ${NAME}_cairn-home (agent logins)"
    say "    - $ENV_FILE (token + the key that decrypts saved connector secrets)"
    if [ -d "$DIR/backups" ]; then say "    - $DIR/backups (pre-update snapshots)"; fi
    say "  Reinstall with the same command and --dir=$DIR to pick everything up again."
    say "  Delete the data for good: curl -fsSL $DEFAULT_SCRIPT_URL | sh -s -- uninstall --purge --dir=$DIR"
    say "  (or remove the volumes yourself with '${CLI:-docker} volume rm ${NAME}_cairn-data ${NAME}_cairn-home ${NAME}_cairn-tools')."
  fi
}

# ----------------------------------------------------------------------------- sign-in

# Contract with the app: POST <origin>/api/auth/pairing-codes with the access token as
# a Bearer header answers {"code":"XXXX-XXXX","expires_at":...}; opening
# <origin>/#pair=<code> signs that browser in. An older image answers 404.

# pair_mint API_ORIGIN TOKEN SCRATCH_DIR -> PAIR_CODE (empty when none), PAIR_HTTP.
pair_mint() {
  PAIR_CODE=""
  PAIR_HTTP="000"
  [ -n "$2" ] || return 0
  pm_body="$3/.pairing-code.$$"
  TMP_FILES="$TMP_FILES $pm_body"
  # The token travels to curl on stdin (-K -), never in argv.
  PAIR_HTTP=$( (
    umask 077
    printf 'header = "Authorization: Bearer %s"\n' "$2" \
      | curl -sS --max-time 20 -K - -X POST -H 'Content-Type: application/json' -d '{}' \
        -o "$pm_body" -w '%{http_code}' "$1/api/auth/pairing-codes"
  ) 2>/dev/null || true)
  valid_re "$PAIR_HTTP" '^[0-9]{3}$' || PAIR_HTTP="000"
  case "$PAIR_HTTP" in
    200 | 201)
      pm_code=$(sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9-]*\)".*/\1/p' "$pm_body" 2>/dev/null | head -n 1 || true)
      if valid_re "$pm_code" '^[A-Za-z0-9-]{4,64}$'; then PAIR_CODE="$pm_code"; fi ;;
  esac
  rm -f "$pm_body"
}

# Open a URL in this machine's browser when there is one (macOS, or a Linux desktop).
open_browser() {
  [ "$OPT_NO_BROWSER" = 1 ] && return 1
  if [ "$PLATFORM" = "macos" ]; then
    has open && open "$1" </dev/null >/dev/null 2>&1 && return 0
    return 1
  fi
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && has xdg-open; then
    xdg-open "$1" </dev/null >/dev/null 2>&1 && return 0
  fi
  return 1
}

token_text() {
  if [ "${IS_TTY:-0}" = 1 ]; then printf '%s' "$1"; else printf '(not printed: this output is not a terminal)'; fi
}

# signin_block API_ORIGIN LINK_ORIGIN TOKEN WHERE_STORED SHOW_TOKEN(1|0) SCRATCH_DIR
# Mints a one-time code, opens <link origin>/#pair=<code> and prints the link either
# way. With no code (an older image: 404) it falls back to the access token, printed
# only to a terminal (SHOW_TOKEN=1) and only once.
signin_block() {
  pair_mint "$1" "$3" "$6"
  SIGNIN_SHOWED_TOKEN=0
  say "  ${C_BOLD}Sign in${C_RESET}"
  if [ -n "$PAIR_CODE" ]; then
    sb_url="$2/#pair=$PAIR_CODE"
    if open_browser "$sb_url"; then
      say "    Opened Cairn in your browser, already signed in. The one-time link:"
    else
      say "    Open this link to sign in (it works once and expires soon):"
    fi
    say "    $sb_url"
  else
    say "    Open: $2"
    case "$PAIR_HTTP" in
      404) say "    (This Cairn release has no one-time sign-in link yet.)" ;;
      000) say "    (Could not reach Cairn to create a one-time sign-in link.)" ;;
      *) say "    (Could not create a one-time sign-in link: HTTP $PAIR_HTTP.)" ;;
    esac
    if [ "$5" = 1 ]; then
      say "    Sign in with your access token: $(token_text "$3")"
      say "    It is also your recovery key: keep it somewhere safe. It is stored in $4."
      SIGNIN_SHOWED_TOKEN=1
    else
      say "    Sign in with your access token; it is stored in $4."
    fi
  fi
  say "    Pair your phone: Settings -> Devices -> Pair a device (a one-time code)."
}

# recovery_block TOKEN WHERE_STORED: the token once, at the end, as the recovery key.
recovery_block() {
  say "  ${C_BOLD}Your recovery key${C_RESET}"
  if [ "${SIGNIN_SHOWED_TOKEN:-0}" = 1 ]; then
    say "    The access token shown above. Stored in $2."
  else
    say "    $(token_text "$1")"
    say "    This is your access token. Keep it somewhere safe: it signs any device in if you"
    say "    lose access. It is stored in $2."
  fi
}

# The origin a person opens for this local install (the API is always reached on loopback).
local_link_origin() {
  case "$EXPOSURE" in
    caddy) printf 'https://%s' "$DOMAIN" ;;
    tailscale)
      if [ -n "${TS_URL:-}" ]; then printf '%s' "${TS_URL%/}"; else printf 'http://127.0.0.1:%s' "$PORT"; fi ;;
    lan)
      llo_ip=$(lan_ip)
      case "$llo_ip" in "<"*) llo_ip="127.0.0.1" ;; esac
      printf 'http://%s:%s' "$llo_ip" "$PORT" ;;
    *) printf 'http://127.0.0.1:%s' "$PORT" ;;
  esac
}

# ----------------------------------------------------------------------------- open + logs (this machine)

cmd_open() {
  require_install
  compute_config
  [ -n "$E_TOKEN" ] || die "No access token in $ENV_FILE."
  health_ok || die "Cairn is not answering on http://127.0.0.1:$PORT. Check: sh $DIR/cairn.sh status"
  TS_URL=""
  if [ "$EXPOSURE" = "tailscale" ] && has tailscale && ts_serves_us; then
    co_dns=$(ts_dns_name)
    if [ -n "$co_dns" ]; then TS_URL="https://$co_dns/"; fi
  fi
  signin_block "http://127.0.0.1:$PORT" "$(local_link_origin)" "$E_TOKEN" "$ENV_FILE (CAIRN_AUTH_TOKEN)" 0 "$DIR"
}

cmd_logs() {
  require_install
  compute_config
  if ! { resolve_engine && [ -n "$COMPOSE" ]; }; then die "Container engine unavailable: $ENGINE_WHY"; fi
  compose logs --tail=100 cairn
}

# ----------------------------------------------------------------------------- target

rw_home() { printf '%s/.cairn/railway' "$HOME"; }

# Which kind of install this run is about: --target; else what this copy of cairn.sh
# manages; else what this-machine-only flags imply; else what already exists; else ask.
resolve_target() {
  TARGET="$OPT_TARGET"
  SELF_RW_DIR=""
  case "$0" in
    cairn.sh | */cairn.sh)
      rt_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || rt_self=""
      if [ -n "$rt_self" ] && grep -q "$MARKER" "$rt_self/railway.state" 2>/dev/null; then
        SELF_RW_DIR="$rt_self"
        [ -n "$TARGET" ] || TARGET="railway"
      elif [ -n "$rt_self" ] && grep -q "$MARKER" "$rt_self/docker-compose.yml" 2>/dev/null; then
        [ -n "$TARGET" ] || TARGET="local"
      fi ;;
  esac
  [ -z "$TARGET" ] || return 0
  if [ "$OPT_LOCAL_ONLY" = 1 ]; then TARGET="local"; return 0; fi
  rt_name="${OPT_NAME:-cairn}"
  if is_root; then rt_dir="/opt/$rt_name"; else rt_dir="$HOME/$rt_name"; fi
  rt_local=0
  rt_rw=0
  if grep -q '^## Cairn instance settings' "$rt_dir/.env" 2>/dev/null; then rt_local=1; fi
  if grep -q "$MARKER" "$(rw_home)/$rt_name/railway.state" 2>/dev/null; then rt_rw=1; fi
  case "$rt_local$rt_rw" in
    10) TARGET="local"; return 0 ;;
    01) TARGET="railway"; return 0 ;;
    00) if [ "$CMD" != "install" ]; then TARGET="local"; return 0; fi ;;
  esac
  choose_target
}

# Where Cairn can live: one line per hosting provider, "target|label|blurb". The chooser,
# --target and the no-terminal hint all read this table. A new host adds a line here, a
# <target>_main function (install, status, open, update, logs, uninstall) and a
# deploy/<target>/ directory: see deploy/README.md, "Adding a hosting provider".
PROVIDERS="railway|In the cloud on Railway|about \$5/month, nothing to keep running
local|On this computer or server|free, private, needs to stay on"

is_provider() { printf '%s\n' "$PROVIDERS" | cut -d'|' -f1 | grep -qx "$1"; }
provider_names() { printf '%s\n' "$PROVIDERS" | cut -d'|' -f1 | tr '\n' ' ' | sed 's/ $//'; }

# provider_menu [hint]: the numbered choices; with "hint", each with its non-interactive command.
provider_menu() {
  printf '%s\n' "$PROVIDERS" | {
    pm_i=0
    while IFS='|' read -r pm_target pm_label pm_blurb; do
      pm_i=$((pm_i + 1))
      printf '  %s) %-26s (%s)\n' "$pm_i" "$pm_label" "$pm_blurb"
      if [ "${1:-}" = "hint" ]; then printf '       curl -fsSL %s | sh -s -- --target=%s --yes\n' "$ONE_LINER_URL" "$pm_target"; fi
    done
  }
}

choose_target() {
  if ! has_tty; then
    {
      say "Where should Cairn live? There is no terminal to ask, so re-run with one of:"
      say ""
      provider_menu hint
      say ""
      say "More options: --help, or https://github.com/zilet/cairn/blob/main/docs/INSTALL.md"
    } >&2
    exit 2
  fi
  ct_count=$(printf '%s\n' "$PROVIDERS" | grep -c .)
  ct_tries=0
  while [ "$ct_tries" -lt 3 ]; do
    {
      printf '\n%sWhere should Cairn live?%s\n' "$C_BOLD" "$C_RESET"
      provider_menu
      printf '%s  ? %sChoose 1-%s: ' "$C_YELLOW" "$C_RESET" "$ct_count"
    } >/dev/tty
    ct_ans=""
    read -r ct_ans </dev/tty || ct_ans=""
    ct_ans=$(printf '%s' "$ct_ans" | tr '[:upper:]' '[:lower:]')
    case "$ct_ans" in
      "" | *[!0-9]*) ;;
      *) ct_ans=$(printf '%s\n' "$PROVIDERS" | sed -n "${ct_ans}p" | cut -d'|' -f1) ;;
    esac
    if [ -n "$ct_ans" ] && is_provider "$ct_ans"; then TARGET="$ct_ans"; return 0; fi
    ct_tries=$((ct_tries + 1))
  done
  die "No choice made. Re-run with --target=<$(provider_names | sed 's/ /|/g')>."
}

# ----------------------------------------------------------------------------- railway

# A small JSON flattener (no jq on most machines): one line per scalar member of every
# object, "<object serial>\t<key>\t<value>". Nested containers print as <obj>/<arr>.
# Object serials follow document order, so the first matching object has the lowest.
json_flat() {
  awk '
    function emit(v) { if (sp > 0 && typ[sp] == "o") printf "%s\t%s\t%s\n", oid[sp], ckey[sp], v }
    function flush() { if (bare != "") { emit(bare); bare = "" } }
    { doc = doc $0 "\n" }
    END {
      sp = 0; serial = 0; instr = 0; esc = 0; bare = ""
      n = length(doc)
      for (i = 1; i <= n; i++) {
        c = substr(doc, i, 1)
        if (instr) {
          if (esc) { str = str c; esc = 0 }
          else if (c == "\\") { str = str c; esc = 1 }
          else if (c == "\"") {
            instr = 0
            if (sp > 0 && typ[sp] == "o" && want[sp] == "k") ckey[sp] = str
            else emit(str)
          } else str = str c
          continue
        }
        if (c == "\"") { instr = 1; str = ""; continue }
        if (c == "{") {
          flush(); if (sp > 0 && typ[sp] == "o") emit("<obj>")
          sp++; typ[sp] = "o"; serial++; oid[sp] = serial; want[sp] = "k"; ckey[sp] = ""
          continue
        }
        if (c == "[") { flush(); if (sp > 0 && typ[sp] == "o") emit("<arr>"); sp++; typ[sp] = "a"; continue }
        if (c == "}" || c == "]") { flush(); if (sp > 0) sp--; continue }
        if (c == ":") { if (sp > 0) want[sp] = "v"; continue }
        if (c == ",") { flush(); if (sp > 0 && typ[sp] == "o") want[sp] = "k"; continue }
        if (c == " " || c == "\t" || c == "\n" || c == "\r") { flush(); continue }
        bare = bare c
      }
      flush()
    }'
}

# json_project_ids NAME < `railway list --json`: ids of live projects (objects that carry
# "environments") named NAME, one per line. A deleted project stays in the list with a
# "deletedAt" until Railway removes it (about 48 hours); it is never one of ours to reuse.
json_project_ids() {
  json_flat | awk -F '\t' -v want="$1" '
    $2 == "id" { id[$1] = $3 }
    $2 == "name" { nm[$1] = $3 }
    $2 == "environments" { proj[$1] = 1 }
    $2 == "deletedAt" && $3 != "null" && $3 != "" { gone[$1] = 1 }
    END { for (o in proj) if (nm[o] == want && id[o] != "" && !(o in gone)) print id[o] }'
}

# json_has_name NAME < any JSON: succeeds when some object has "name": NAME.
json_has_name() {
  json_flat | awk -F '\t' -v want="$1" '$2 == "name" && $3 == want { found = 1 } END { exit found ? 0 : 1 }'
}

# json_deployment [ID] < `railway deployment list --json`: "<id> <status>" of deployment
# ID, or of the first (newest) deployment.
json_deployment() {
  json_flat | awk -F '\t' -v want="${1:-}" '
    $2 == "id" { id[$1] = $3 }
    $2 == "status" && $3 ~ /^[A-Z_]+$/ { st[$1] = $3 }
    { if ($1 + 0 > max) max = $1 + 0 }
    END {
      for (o = 1; o <= max; o++) if ((o in st) && id[o] != "" && (want == "" || id[o] == want)) { print id[o] " " st[o]; exit }
    }'
}

# json_first_id < JSON: the first "id" member of any object (e.g. a redeploy answer).
json_first_id() {
  json_flat | awk -F '\t' '$2 == "id" && $3 ~ /^[A-Za-z0-9-]+$/ { print $3; exit }'
}

# Run the Railway CLI from the state directory (it keeps its project link per
# directory) with stdin closed: under `curl | sh` stdin is this script, and a prompt
# must fail instead of eating it or hanging.
rw() { (cd "$RW_DIR" && railway "$@" </dev/null); }

# rw_cap ARGS...: run, keep stdout in RW_OUT and stderr in RW_ERR; returns the status.
rw_cap() {
  rc_err="$RW_DIR/.railway-stderr.$$"
  TMP_FILES="$TMP_FILES $rc_err"
  rc_status=0
  RW_OUT=$(rw "$@" 2>"$rc_err") || rc_status=$?
  RW_ERR=$(cat "$rc_err" 2>/dev/null || true)
  rm -f "$rc_err"
  return "$rc_status"
}

# rw_must WHAT ARGS...: rw_cap or die with the CLI's own message.
rw_must() {
  rm_what="$1"
  shift
  if ! rw_cap "$@"; then
    [ -z "$RW_ERR" ] || printf '%s\n' "$RW_ERR" | redact_stream >&2
    die "Railway: could not $rm_what (railway $1 ...)."
  fi
}

# Drop any line that carries one of this install's secrets. Pure shell: the secret
# never lands in another process's argv.
redact_stream() {
  while IFS= read -r rs_line || [ -n "$rs_line" ]; do
    if [ -n "${RW_TOKEN:-}" ]; then case "$rs_line" in *"$RW_TOKEN"*) continue ;; esac; fi
    if [ -n "${RW_SECRET:-}" ]; then case "$rs_line" in *"$RW_SECRET"*) continue ;; esac; fi
    printf '%s\n' "$rs_line"
  done
}

rw_state_get() { env_get "$1" "$RW_STATE"; }

rw_state_write() {
  {
    say "# Cairn on Railway, written by the installer. $MARKER"
    say "# No secrets here: the access token lives in Railway (service -> Variables)."
    say "CAIRN_TARGET=railway"
    say "RW_PROJECT_ID=$RW_PROJECT_ID"
    say "RW_PROJECT_NAME=$RW_PROJECT"
    say "RW_SERVICE=$RW_SERVICE"
    say "RW_ENVIRONMENT=$RW_ENV"
    say "RW_DOMAIN=$RW_DOMAIN"
    say "RW_IMAGE=$IMAGE"
    say "RW_AUTOUPDATES_SET=$RW_AU_SET"
  } | write_file "$RW_STATE" 600
}

rw_setup_paths() {
  NAME="${OPT_NAME:-cairn}"
  valid_re "$NAME" '^[a-z0-9][a-z0-9_-]{0,40}$' || die "Invalid instance name '$NAME'."
  if [ -n "$SELF_RW_DIR" ]; then RW_DIR="$SELF_RW_DIR"; else RW_DIR="$(rw_home)/$NAME"; fi
  valid_re "$RW_DIR" '^/[A-Za-z0-9._/@+-]+$' \
    || die "The state directory must be an absolute path without spaces: '$RW_DIR' (it is \$HOME/.cairn/railway/<name>)."
  RW_STATE="$RW_DIR/railway.state"
  DIR="$RW_DIR"
  RW_PROJECT_ID=$(rw_state_get RW_PROJECT_ID)
  RW_PROJECT=$(rw_state_get RW_PROJECT_NAME)
  RW_SERVICE=$(rw_state_get RW_SERVICE)
  RW_ENV=$(rw_state_get RW_ENVIRONMENT)
  RW_DOMAIN=$(rw_state_get RW_DOMAIN)
  RW_AU_SET=$(rw_state_get RW_AUTOUPDATES_SET)
  RW_AU=""
  # A different --railway-project-name than the recorded one is decided once signed in:
  # fine when the recorded project is gone, refused while it still exists (rw_ensure_project).
  RW_PROJECT_RECORDED=""
  if [ -n "$OPT_RW_PROJECT" ] && [ -n "$RW_PROJECT" ] && [ "$OPT_RW_PROJECT" != "$RW_PROJECT" ]; then
    RW_PROJECT_RECORDED="$RW_PROJECT"
  fi
  RW_PROJECT="${OPT_RW_PROJECT:-${RW_PROJECT:-$NAME}}"
  RW_SERVICE="${RW_SERVICE:-$NAME}"
  RW_ENV="${RW_ENV:-production}"
  IMAGE="${OPT_IMAGE:-$(rw_state_get RW_IMAGE)}"
  IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  RW_DEPLOY_TIMEOUT="${CAIRN_RAILWAY_DEPLOY_TIMEOUT:-600}"
  RW_POLL="${CAIRN_RAILWAY_POLL_SECONDS:-10}"
  RW_TOKEN=""
  RW_SECRET=""
}

# Image auto updates, the same for an install and the template: Railway redeploys the service
# when a new image is pushed under the tag (type "patch"), only inside the window: every day of
# the week, 02:00-06:00 UTC (Railway's Night window).
RW_TPL_UPDATE_START=2
RW_TPL_UPDATE_END=6
RW_TPL_UPDATE_WINDOW="Night, 02:00-06:00 UTC"
# One environment patch through `railway api` (the CLI has no flag for auto updates). Deploys
# are skipped: the installer deploys on its own right after.
# shellcheck disable=SC2016 # GraphQL variables, not shell expansions
RW_PATCH_MUTATION='mutation($env: String!, $patch: EnvironmentConfig) { environmentPatchCommit(environmentId: $env, patch: $patch, skipDeploys: true, commitMessage: "Cairn installer") }'

# The source.autoUpdates value Railway's environment config takes.
rw_autoupdates_json() {
  printf '{"type":"patch","schedule":['
  rau_day=0
  while [ "$rau_day" -le 6 ]; do
    [ "$rau_day" = 0 ] || printf ','
    printf '{"day":%s,"startHour":%s,"endHour":%s}' "$rau_day" "$RW_TPL_UPDATE_START" "$RW_TPL_UPDATE_END"
    rau_day=$((rau_day + 1))
  done
  printf ']}'
}

# Non-secret service variables (the token and the settings key go on stdin).
RW_PLAIN_VARS="CAIRN_SINGLE_VOLUME=1 CAIRN_REQUIRE_AUTH=1 CAIRN_BLANK_PROFILE=1 CAIRN_PLATFORM=railway CAIRN_MAX_AGENT_PROCS=1 PORT=8787 CAIRN_FEEDBACK_URL=https://feedback.cairn.fit"

rw_ensure_cli() {
  if has railway; then return 0; fi
  for rec_dir in "${RAILWAY_BIN_DIR:-}" "$HOME/.railway/bin"; do
    if [ -n "$rec_dir" ] && [ -x "$rec_dir/railway" ]; then PATH="$rec_dir:$PATH"; export PATH; return 0; fi
  done
  warn "The Railway CLI (railway) is not installed. The installer uses it to set up your Railway project."
  if [ "$PLATFORM" = "macos" ] && has brew; then
    if confirm "Install it with Homebrew (brew install railway)?" "y"; then
      brew install railway </dev/null || warn "brew install railway failed."
      has railway && { ok "Installed the Railway CLI."; return 0; }
    fi
  elif has npm; then
    if confirm "Install it with npm (npm i -g @railway/cli)?" "y"; then
      npm i -g @railway/cli </dev/null || warn "npm i -g @railway/cli failed (a global npm install may need sudo)."
      has railway && { ok "Installed the Railway CLI."; return 0; }
    fi
  fi
  # Railway's official install script, only with explicit consent, saved to a file
  # first and run from there (never piped into a shell).
  consent_script "Install it with Railway's official install script (https://railway.com/install.sh, into ~/.railway/bin)?" "$OPT_INSTALL_RAILWAY_CLI" "--install-railway-cli" \
    "curl -fsSL https://railway.com/install.sh | sh" \
    || die "The Railway CLI is required for --target=railway. Install it (https://docs.railway.com/guides/cli) and re-run."
  has curl || die "curl is required to download Railway's install script."
  rec_tmp=$(mktemp "${TMPDIR:-/tmp}/railway-install.XXXXXX")
  TMP_FILES="$TMP_FILES $rec_tmp"
  info "Downloading https://railway.com/install.sh ..."
  curl -fsSL --proto '=https' --tlsv1.2 https://railway.com/install.sh -o "$rec_tmp" \
    || die "Could not download https://railway.com/install.sh"
  if has bash; then rec_sh="bash"; else rec_sh="sh"; fi
  if [ "$OPT_YES" = 1 ] || ! has_tty; then
    "$rec_sh" "$rec_tmp" --yes </dev/null || die "Railway's install script failed; see its output above."
  else
    "$rec_sh" "$rec_tmp" </dev/tty || die "Railway's install script failed; see its output above."
  fi
  for rec_dir in "${RAILWAY_BIN_DIR:-}" "$HOME/.railway/bin"; do
    if [ -n "$rec_dir" ] && [ -x "$rec_dir/railway" ]; then PATH="$rec_dir:$PATH"; export PATH; fi
  done
  has railway || die "The Railway CLI was installed but is not on PATH. Open a new terminal and re-run."
  ok "Installed the Railway CLI."
}

# Offline feature probe: the commands below need a recent CLI.
rw_check_cli() {
  rw variable set --help 2>/dev/null | grep -q -- '--stdin' \
    || die "Your Railway CLI is too old (no 'railway variable set --stdin'). Update it (railway upgrade, brew upgrade railway, or npm i -g @railway/cli) and re-run."
  if rw redeploy --help 2>/dev/null | grep -q -- '--from-source'; then RW_FROM_SOURCE="--from-source"; else RW_FROM_SOURCE=""; fi
}

rw_ensure_login() {
  if rw whoami >/dev/null 2>&1; then return 0; fi
  if ! has_tty; then
    die "Not signed in to Railway and there is no terminal for the browser sign-in. Run 'railway login' in a terminal (or set RAILWAY_API_TOKEN), then re-run."
  fi
  info "Signing in to Railway: your browser opens; sign in or create an account, then come back here."
  (cd "$RW_DIR" && railway login </dev/tty) || die "Railway sign-in did not finish. Run 'railway login', then re-run."
  rw whoami >/dev/null 2>&1 || die "Still not signed in to Railway. Run 'railway login', then re-run."
}

# Variables currently on the service, KEY=VALUE per line, kept in memory only.
rw_load_vars() {
  RW_KV=""
  RW_VARS_OK=0
  if rw_cap variable list --service "$RW_SERVICE" --environment "$RW_ENV" --kv; then RW_KV="$RW_OUT"; RW_VARS_OK=1; fi
  RW_OUT=""
}
rw_var() { printf '%s\n' "$RW_KV" | sed -n "s/^$1=//p" | tail -n 1; }

rw_find_project() {
  rw_must "list your projects" list --json
  RW_FOUND=$(printf '%s\n' "$RW_OUT" | json_project_ids "$RW_PROJECT")
}

# The name is taken and not to be reused: ask for another (a free "<name>-N" offered),
# or, with no terminal, say how to pass one.
rw_pick_project_name() {
  if ! has_tty || [ "$OPT_YES" = 1 ]; then
    die "A Railway project named '$RW_PROJECT' already exists. Re-run with another name, e.g. curl -fsSL $ONE_LINER_URL | sh -s -- --railway-project-name=$RW_PROJECT-2"
  fi
  pp_base="$RW_PROJECT"
  while :; do
    pp_n=2
    while :; do
      RW_PROJECT="$pp_base-$pp_n"
      rw_find_project
      [ -n "$RW_FOUND" ] || break
      pp_n=$((pp_n + 1))
    done
    pp_suggest="$RW_PROJECT"
    printf '%s  ? %sName for a new Railway project [%s]: ' "$C_YELLOW" "$C_RESET" "$pp_suggest" >/dev/tty
    pp_ans=""
    read -r pp_ans </dev/tty || pp_ans=""
    RW_PROJECT="${pp_ans:-$pp_suggest}"
    case "$RW_PROJECT" in
      *[!A-Za-z0-9._-]* | "" | -*) warn "Use letters, digits, '.', '_' or '-'."; continue ;;
    esac
    if [ "${#RW_PROJECT}" -gt 60 ]; then warn "Keep it under 60 characters."; continue; fi
    rw_find_project
    if [ -n "$RW_FOUND" ]; then warn "'$RW_PROJECT' is taken too."; pp_base="$RW_PROJECT"; continue; fi
    RW_FOUND=""
    return 0
  done
}

rw_ensure_project() {
  if [ -n "${RW_PROJECT_RECORDED:-}" ] && [ -n "$RW_PROJECT_ID" ]; then
    ep_want="$RW_PROJECT"
    RW_PROJECT="$RW_PROJECT_RECORDED"
    rw_find_project
    if printf '%s\n' "$RW_FOUND" | grep -qx "$RW_PROJECT_ID"; then
      die "$RW_DIR already manages the Railway project '$RW_PROJECT', which still exists. For a second install add --name=<other>, e.g. curl -fsSL $ONE_LINER_URL | sh -s -- --name=$ep_want --railway-project-name=$ep_want"
    fi
    RW_PROJECT="$ep_want"
  fi
  rw_find_project
  if [ -n "$RW_PROJECT_ID" ]; then
    if printf '%s\n' "$RW_FOUND" | grep -qx "$RW_PROJECT_ID"; then
      ok "Railway project: $RW_PROJECT (already set up by this installer)."
      return 0
    fi
    warn "The Railway project recorded in $RW_STATE is gone; creating a new one."
    RW_PROJECT_ID=""
    # The image an earlier run recorded belonged to that project; a new one starts on the release.
    if [ -z "$OPT_IMAGE" ] && [ "$IMAGE" != "$DEFAULT_IMAGE" ]; then
      info "Using $DEFAULT_IMAGE (the recorded $IMAGE went with the old project; --image= picks another)."
      IMAGE="$DEFAULT_IMAGE"
    fi
  fi
  rep_count=$(printf '%s\n' "$RW_FOUND" | grep -c . || true)
  if [ "$rep_count" = 1 ] \
    && confirm "A Railway project named '$RW_PROJECT' already exists. Set Cairn up in it?" "n"; then
    RW_PROJECT_ID="$RW_FOUND"
    ok "Railway project: $RW_PROJECT (existing)."
    return 0
  fi
  if [ "$rep_count" -gt 0 ]; then
    [ "$rep_count" = 1 ] || warn "You have $rep_count Railway projects named '$RW_PROJECT'."
    rw_pick_project_name
  fi
  info "Creating the Railway project '$RW_PROJECT'..."
  if [ -n "$OPT_RW_WORKSPACE" ]; then
    rw_cap init --name "$RW_PROJECT" --workspace "$OPT_RW_WORKSPACE" --json || true
  else
    rw_cap init --name "$RW_PROJECT" --json || true
  fi
  # `init` can fail after the project was created (e.g. writing its local config),
  # so the list is the truth.
  rw_find_project
  RW_PROJECT_ID=$(printf '%s\n' "$RW_FOUND" | head -n 1)
  if [ -z "$RW_PROJECT_ID" ]; then
    [ -z "$RW_ERR" ] || printf '%s\n' "$RW_ERR" >&2
    case "$RW_ERR" in
      *orkspace*) die "Railway could not create the project. If you have more than one workspace, add --railway-workspace=<workspace name or ID>." ;;
    esac
    die "Railway could not create the project '$RW_PROJECT' (see above)."
  fi
  ok "Created the Railway project '$RW_PROJECT'."
}

rw_ensure_service() {
  rw_must "link the project" link --project "$RW_PROJECT_ID" --environment "$RW_ENV"
  rw_state_write
  rw_cap service list --json || true
  if printf '%s\n' "$RW_OUT" | json_has_name "$RW_SERVICE"; then
    ok "Service: $RW_SERVICE (exists)."
  else
    info "Adding the service '$RW_SERVICE' from $IMAGE..."
    set -- add --image "$IMAGE" --service "$RW_SERVICE"
    for rs_kv in $RW_PLAIN_VARS; do set -- "$@" --variables "$rs_kv"; done
    rw_must "add the service" "$@" --json
    ok "Added the service '$RW_SERVICE'."
  fi
  rw_must "link the service" service link "$RW_SERVICE"
}

rw_ensure_volume() {
  rw_cap volume list --json || true
  case "$RW_OUT" in
    *'"/data"'*) ok "Volume at /data (exists)." ; return 0 ;;
  esac
  info "Attaching a volume at /data (your database, uploads and AI sign-ins live there)..."
  rw_must "attach the volume" volume add --mount-path /data --json
  ok "Volume attached at /data."
}

rw_ensure_vars() {
  rw_load_vars
  # A failed list says nothing about which keys exist: generating secrets now could replace
  # the real token (signing everyone out) or the settings key (stored secrets unreadable).
  [ "$RW_VARS_OK" = 1 ] \
    || die "Railway: could not read the service variables${RW_ERR:+ ($RW_ERR)}. Nothing was changed; re-run in a minute."
  set --
  for rv_kv in $RW_PLAIN_VARS; do
    rv_key="${rv_kv%%=*}"
    case "$rv_key" in
      # Always enforced: a Railway URL is public, the volume is the only disk.
      CAIRN_REQUIRE_AUTH | CAIRN_SINGLE_VOLUME | CAIRN_PLATFORM | PORT)
        [ "$(rw_var "$rv_key")" = "${rv_kv#*=}" ] || set -- "$@" "$rv_kv" ;;
      *) [ -n "$(rw_var "$rv_key")" ] || set -- "$@" "$rv_kv" ;;
    esac
  done
  if [ $# -gt 0 ]; then
    rw_must "set the service variables" variable set "$@" --service "$RW_SERVICE" --environment "$RW_ENV" --skip-deploys --json
  fi
  RW_TOKEN=$(rw_var CAIRN_AUTH_TOKEN)
  RW_SECRET=$(rw_var CAIRN_SETTINGS_SECRET_KEY)
  RW_TOKEN_STATE="kept"
  if [ -z "$RW_TOKEN" ]; then
    RW_TOKEN=$(rand_hex 32)
    RW_TOKEN_STATE="new"
    # printf is a shell builtin: the value reaches the CLI on stdin, never in argv.
    printf '%s' "$RW_TOKEN" | (cd "$RW_DIR" && railway variable set CAIRN_AUTH_TOKEN --stdin --service "$RW_SERVICE" --environment "$RW_ENV" --skip-deploys --json) >/dev/null \
      || die "Railway: could not set CAIRN_AUTH_TOKEN."
  fi
  if [ -z "$RW_SECRET" ]; then
    RW_SECRET=$(rand_hex 32)
    printf '%s' "$RW_SECRET" | (cd "$RW_DIR" && railway variable set CAIRN_SETTINGS_SECRET_KEY --stdin --service "$RW_SERVICE" --environment "$RW_ENV" --skip-deploys --json) >/dev/null \
      || die "Railway: could not set CAIRN_SETTINGS_SECRET_KEY."
  fi
  RW_KV=""
  ok "Variables set (access token: $( [ "$RW_TOKEN_STATE" = kept ] && printf 'kept the existing one' || printf 'a new random one'))."
}

# RW_AU_TYPE: the service's image auto-update type in Railway ("" when never set, "disabled",
# "patch", ...); returns 1 when it cannot be read. Also leaves RW_SVC_ID and RW_ENV_ID.
rw_read_autoupdates() {
  RW_AU_TYPE=""
  rw_cap service list --json || return 1
  RW_SVC_ID=$(printf '%s\n' "$RW_OUT" | json_named_id "$RW_SERVICE")
  rw_cap environment list --json || return 1
  RW_ENV_ID=$(printf '%s\n' "$RW_OUT" | json_named_id "$RW_ENV")
  [ -n "$RW_SVC_ID" ] && [ -n "$RW_ENV_ID" ] || return 1
  rw_cap environment config --environment "$RW_ENV" --json || return 1
  RW_AU_TYPE=$(printf '%s\n' "$RW_OUT" | json_paths | awk -F '\t' -v want="services.$RW_SVC_ID.source.autoUpdates.type" '$1 == want { print $2; exit }')
  RW_OUT=""
  return 0
}

# Switch Railway's image auto updates on (RW_AU: on | kept | off | manual). Idempotent: an
# existing setting is kept, and once this installer has switched them on, "disabled" is the
# person's own choice and stays. Never fails the install: on any error it says how by hand.
rw_ensure_autoupdates() {
  RW_AU="manual"
  if ! rw api --help >/dev/null 2>&1; then
    warn "This Railway CLI has no 'railway api', so automatic updates stay off for now (see the summary)."
    return 0
  fi
  if ! rw_read_autoupdates; then
    warn "Could not read the service's update settings from Railway; switch automatic updates on by hand (see the summary)."
    return 0
  fi
  case "$RW_AU_TYPE" in
    disabled | "")
      if [ "$RW_AU_SET" = 1 ]; then
        RW_AU="off"
        ok "Automatic updates: off in Railway, as you set them (left alone)."
        return 0
      fi ;;
    *)
      RW_AU="kept"
      ok "Automatic updates: on ($RW_AU_TYPE, as set in Railway)."
      return 0 ;;
  esac
  rea_file="$RW_DIR/autoupdates.json"
  TMP_FILES="$TMP_FILES $rea_file"
  printf '{"env":%s,"patch":{"services":{%s:{"source":{"autoUpdates":%s}}}}}\n' \
    "$(json_str "$RW_ENV_ID")" "$(json_str "$RW_SVC_ID")" "$(rw_autoupdates_json)" | write_file "$rea_file" 600
  if ! rw_cap api "$RW_PATCH_MUTATION" --variables "@$rea_file"; then
    rm -f "$rea_file"
    warn "Railway did not accept the automatic-update setting${RW_ERR:+ ($(printf '%s' "$RW_ERR" | head -n 1))}; switch it on by hand (see the summary)."
    return 0
  fi
  rm -f "$rea_file"
  # Read it back: only a setting Railway shows is reported as on.
  if rw_read_autoupdates && [ "$RW_AU_TYPE" = "patch" ]; then
    RW_AU="on"
    RW_AU_SET=1
    rw_state_write
    ok "Automatic updates: on, in the $RW_TPL_UPDATE_WINDOW window."
  else
    warn "Railway took the automatic-update setting but does not show it yet; check it with: sh $RW_DIR/cairn.sh status"
  fi
}

rw_pick_domain() { printf '%s\n' "$1" | grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.up\.railway\.app' | head -n 1 || true; }

rw_ensure_domain() {
  rw_cap domain list --service "$RW_SERVICE" --environment "$RW_ENV" --json || true
  RW_DOMAIN=$(rw_pick_domain "$RW_OUT")
  if [ -z "$RW_DOMAIN" ]; then
    info "Creating a public https://<name>.up.railway.app address..."
    rw_must "create a domain" domain --port 8787 --service "$RW_SERVICE" --environment "$RW_ENV" --json
    RW_DOMAIN=$(rw_pick_domain "$RW_OUT")
    [ -n "$RW_DOMAIN" ] || die "Railway created a domain but the installer could not read it. See: railway domain list --service $RW_SERVICE"
  fi
  rw_state_write
  ok "Address: https://$RW_DOMAIN"
}

# Deploy (redeploy from the image source) and follow it to SUCCESS, FAILED or CRASHED.
rw_deploy() {
  info "Deploying $IMAGE (pulls the newest image)..."
  RW_PREV_DEPLOY=""
  if rw_cap deployment list --service "$RW_SERVICE" --environment "$RW_ENV" --limit 5 --json; then
    rd_prev=$(printf '%s\n' "$RW_OUT" | json_deployment "")
    RW_PREV_DEPLOY="${rd_prev%% *}"
  fi
  if [ -n "$RW_FROM_SOURCE" ]; then
    rw_cap redeploy --service "$RW_SERVICE" --environment "$RW_ENV" --from-source --yes --json \
      || rw_must "start a deployment" redeploy --service "$RW_SERVICE" --environment "$RW_ENV" --yes --json
  else
    rw_must "start a deployment" redeploy --service "$RW_SERVICE" --environment "$RW_ENV" --yes --json
  fi
  RW_DEPLOY_ID=$(printf '%s\n' "$RW_OUT" | json_first_id)
  rd_waited=0
  rd_status=""
  while :; do
    rd_status=""
    if rw_cap deployment list --service "$RW_SERVICE" --environment "$RW_ENV" --limit 5 --json; then
      rd_line=""
      if [ -n "$RW_DEPLOY_ID" ]; then rd_line=$(printf '%s\n' "$RW_OUT" | json_deployment "$RW_DEPLOY_ID"); fi
      if [ -z "$rd_line" ]; then
        # No usable id from the redeploy answer: follow the newest deployment, but never
        # the one that was newest before this deploy started.
        rd_line=$(printf '%s\n' "$RW_OUT" | json_deployment "")
        if [ -n "$rd_line" ] && [ "${rd_line%% *}" != "$RW_PREV_DEPLOY" ]; then RW_DEPLOY_ID="${rd_line%% *}"; else rd_line=""; fi
      fi
      if [ -n "$rd_line" ]; then rd_status="${rd_line#* }"; fi
    fi
    case "$rd_status" in
      SUCCESS)
        ok "Deployed."
        return 0 ;;
      FAILED | CRASHED)
        rw_show_failure "$rd_status"
        die "The deployment $rd_status. Fix what the log shows (or see https://github.com/zilet/cairn/blob/main/docs/INSTALL.md), then re-run; your project and data stay." ;;
      REMOVED | SKIPPED)
        # Replaced by a newer deployment: follow the newest one instead.
        RW_DEPLOY_ID="" ;;
    esac
    if [ "$rd_waited" -ge "$RW_DEPLOY_TIMEOUT" ]; then
      die "The deployment is still ${rd_status:-starting} after $((RW_DEPLOY_TIMEOUT / 60)) min. Check it with: sh $RW_DIR/cairn.sh status (or the Railway dashboard)."
    fi
    info "Deployment: ${rd_status:-starting} (${rd_waited}s)"
    sleep "$RW_POLL"
    rd_waited=$((rd_waited + RW_POLL))
  done
}

rw_show_failure() {
  warn "Railway reports the deployment $1. Last build and runtime log lines (lines with your secrets removed):"
  for rsf_kind in --build --deployment; do
    printf '\n  [railway logs %s]\n' "$rsf_kind" >&2
    rw logs --service "$RW_SERVICE" --environment "$RW_ENV" "$rsf_kind" --lines 30 ${RW_DEPLOY_ID:+"$RW_DEPLOY_ID"} 2>&1 \
      | redact_stream | tail -n 30 | sed 's/^/    /' >&2 || true
  done
}

rw_health_body() { curl -fsS --max-time 8 "https://$RW_DOMAIN/api/health" </dev/null 2>/dev/null || true; }

rw_wait_health() {
  rwh_waited=0
  while [ "$rwh_waited" -lt "$HEALTH_TIMEOUT" ]; do
    rwh_body=$(rw_health_body)
    case "$rwh_body" in *'"ok":true'*) RW_VERSION=$(printf '%s' "$rwh_body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'); return 0 ;; esac
    sleep 5
    rwh_waited=$((rwh_waited + 5))
  done
  return 1
}

rw_print_plan() {
  step "Cairn on Railway: plan"
  say "  Project:     $RW_PROJECT (created; if the name is taken, you choose to reuse it or name a new one)"
  say "  Service:     $RW_SERVICE, from $IMAGE, one volume at /data, a public https domain"
  say "  Variables:   $RW_PLAIN_VARS"
  say "               CAIRN_AUTH_TOKEN and CAIRN_SETTINGS_SECRET_KEY: 64 random hex chars each, sent on stdin"
  say "  Updates:     Railway Auto Updates switched on, $RW_TPL_UPDATE_WINDOW (kept as is when already set)"
  say "  Manage it:   $RW_DIR/cairn.sh (status, open, update, logs, uninstall)"
  say "  Cost:        about \$5/month on Railway's Hobby plan (check current pricing)"
  say "  Disk:        a trial volume is 0.5 GB, enough for one AI provider. Hobby gives 5 GB;"
  say "               after upgrading, grow it in Railway (the volume -> Live Resize)."
  tel_plan_line
}

rw_print_commands() {
  say ""
  say "Railway CLI commands, run from $RW_DIR (secrets travel on stdin, never in argv):"
  say "  railway whoami                       (railway login first when you are not signed in)"
  say "  railway list --json"
  say "  railway init --name $RW_PROJECT --json${OPT_RW_WORKSPACE:+ --workspace $OPT_RW_WORKSPACE}"
  say "  railway link --project <project id> --environment $RW_ENV"
  printf '  railway add --image %s --service %s' "$IMAGE" "$RW_SERVICE"
  for rpc_kv in $RW_PLAIN_VARS; do printf ' --variables %s' "$rpc_kv"; done
  printf ' --json\n'
  say "  railway service link $RW_SERVICE"
  say "  railway volume add --mount-path /data --json"
  say "  railway variable set CAIRN_AUTH_TOKEN --stdin --service $RW_SERVICE --environment $RW_ENV --skip-deploys"
  say "  railway variable set CAIRN_SETTINGS_SECRET_KEY --stdin --service $RW_SERVICE --environment $RW_ENV --skip-deploys"
  say "  railway service list --json; railway environment list --json"
  say "  railway environment config --environment $RW_ENV --json      (are auto updates set already?)"
  say "  railway api '<environmentPatchCommit>' --variables @autoupdates.json   (source.autoUpdates, only when not set)"
  say "  railway domain --port 8787 --service $RW_SERVICE --environment $RW_ENV --json"
  say "  railway redeploy --service $RW_SERVICE --environment $RW_ENV --from-source --yes --json"
  say "  railway deployment list --service $RW_SERVICE --environment $RW_ENV --limit 5 --json   (every ${RW_POLL}s, up to $((RW_DEPLOY_TIMEOUT / 60)) min)"
  say "  then GET https://<domain>/api/health, POST https://<domain>/api/auth/pairing-codes"
  say "  and open https://<domain>/#pair=<one-time code>"
}

rw_cmd_install() {
  if [ "$OPT_DRY_RUN" = 1 ]; then
    rw_print_plan
    rw_print_commands
    say ""
    say "Dry run: nothing was changed."
    return 0
  fi
  has curl || die "curl is required (it is how this installer checks Cairn's health)."
  rw_print_plan
  confirm "Set Cairn up on your Railway account with these settings?" "y" || die "Cancelled; nothing was changed."
  tel_chose railway_cli
  umask 077
  mkdir -p "$RW_DIR"
  chmod 700 "$RW_DIR" "$(rw_home)" 2>/dev/null || true

  step "Railway CLI"
  rw_ensure_cli
  rw_check_cli
  rw_ensure_login
  ok "Signed in to Railway."

  step "Setting up the Railway project"
  TEL_STEP="download"
  install_self
  TEL_STEP="railway_setup"
  rw_ensure_project
  rw_ensure_service
  rw_ensure_volume
  rw_ensure_vars
  rw_ensure_autoupdates
  rw_ensure_domain

  step "Deploying"
  TEL_STEP="railway_deploy"
  rw_deploy
  info "Waiting for https://$RW_DOMAIN to answer (up to ${HEALTH_TIMEOUT}s)..."
  TEL_STEP="health"
  rw_wait_health || die "Railway says the deployment succeeded, but https://$RW_DOMAIN/api/health is not answering yet. Try again in a minute: sh $RW_DIR/cairn.sh status"
  ok "Cairn ${RW_VERSION:+v$RW_VERSION }is healthy."
  rw_summary
  tel_done
}

rw_where_token() { printf 'Railway (project %s -> service %s -> Variables -> CAIRN_AUTH_TOKEN)' "$RW_PROJECT" "$RW_SERVICE"; }

rw_summary() {
  step "${C_GREEN}Cairn is running on Railway${RW_VERSION:+ (v$RW_VERSION)}."
  say ""
  say "  ${C_BOLD}Your Cairn${C_RESET}"
  say "    https://$RW_DOMAIN"
  say ""
  signin_block "https://$RW_DOMAIN" "https://$RW_DOMAIN" "$RW_TOKEN" "$(rw_where_token)" 1 "$RW_DIR"
  say ""
  say "  ${C_BOLD}Coaching${C_RESET}"
  say "    Settings -> Agents -> Connect signs in to Claude, Codex, Grok or Antigravity right in the app."
  say ""
  say "  ${C_BOLD}Updates${C_RESET}"
  case "$RW_AU" in
    on | kept) say "    Automatic: Railway installs each new release in the $RW_TPL_UPDATE_WINDOW window (Railway Auto Updates)." ;;
    off) say "    Automatic updates are off in Railway, as you set them (service $RW_SERVICE -> Settings -> Source -> Auto Updates)." ;;
    *) say "    Turn on automatic updates once in Railway: service $RW_SERVICE -> Settings -> Source -> Auto Updates (pick the Night window)." ;;
  esac
  say "    Or update now: sh $RW_DIR/cairn.sh update"
  say ""
  say "  ${C_BOLD}Manage it${C_RESET}"
  say "    sh $RW_DIR/cairn.sh status | open | update | logs | uninstall"
  say "    Your data lives on the Railway volume at /data. Backups: Settings -> Data in the app."
  say ""
  recovery_block "$RW_TOKEN" "$(rw_where_token)"
  say ""
}

rw_require_install() {
  [ -n "$RW_PROJECT_ID" ] || die "No Railway install found in $RW_DIR (install with --target=railway, or pick it with --name=)."
  has railway || rw_ensure_cli
}

rw_health_line() {
  rhl_body=$(rw_health_body)
  case "$rhl_body" in
    *'"ok":true'*) printf 'healthy%s' "$(printf '%s' "$rhl_body" | sed -n 's/.*"version":"\([^"]*\)".*/, v\1/p')" ;;
    *) printf 'not answering /api/health' ;;
  esac
}

rw_cmd_status() {
  rw_require_install
  step "Cairn ($RW_SERVICE) on Railway"
  say "  Project:    $RW_PROJECT ($RW_PROJECT_ID), environment $RW_ENV"
  say "  URL:        ${RW_DOMAIN:+https://$RW_DOMAIN}"
  if rw_cap deployment list --service "$RW_SERVICE" --environment "$RW_ENV" --limit 5 --json; then
    rcs_line=$(printf '%s\n' "$RW_OUT" | json_deployment "")
    say "  Deployment: ${rcs_line#* } (${rcs_line%% *})"
  else
    say "  Deployment: unknown (railway: $(printf '%s' "$RW_ERR" | head -n 1))"
  fi
  if [ -n "$RW_DOMAIN" ]; then say "  Health:     $(rw_health_line)"; fi
  say "  Token:      in $(rw_where_token); not shown"
  if rw_read_autoupdates; then
    case "$RW_AU_TYPE" in
      "" | disabled) rcs_au="automatic updates off (service -> Settings -> Source -> Auto Updates; re-running the installer switches them on unless you turned them off)" ;;
      *) rcs_au="automatic ($RW_AU_TYPE, Railway Auto Updates)" ;;
    esac
  else
    rcs_au="unknown (railway: $(printf '%s' "$RW_ERR" | head -n 1))"
  fi
  say "  Updates:    $rcs_au; now: sh $RW_DIR/cairn.sh update"
}

rw_cmd_open() {
  rw_require_install
  [ -n "$RW_DOMAIN" ] || die "No domain recorded for this install; re-run the installer."
  rw_load_vars
  RW_TOKEN=$(rw_var CAIRN_AUTH_TOKEN)
  RW_KV=""
  [ -n "$RW_TOKEN" ] || die "Could not read CAIRN_AUTH_TOKEN from Railway (railway variable list). Are you signed in? Try: railway whoami"
  signin_block "https://$RW_DOMAIN" "https://$RW_DOMAIN" "$RW_TOKEN" "$(rw_where_token)" 0 "$RW_DIR"
}

rw_cmd_update() {
  rw_require_install
  rw_check_cli
  if [ "$OPT_DRY_RUN" = 1 ]; then
    say "Dry run: would run 'railway redeploy --service $RW_SERVICE --from-source --yes' in $RW_DIR, follow the deployment and wait for https://$RW_DOMAIN/api/health."
    return 0
  fi
  rw_load_vars
  RW_TOKEN=$(rw_var CAIRN_AUTH_TOKEN)
  RW_SECRET=$(rw_var CAIRN_SETTINGS_SECRET_KEY)
  RW_KV=""
  rw_deploy
  rw_wait_health || die "The new deployment is not answering https://$RW_DOMAIN/api/health yet. Check: sh $RW_DIR/cairn.sh status"
  ok "Cairn ${RW_VERSION:+v$RW_VERSION }is running at https://$RW_DOMAIN"
}

rw_cmd_logs() {
  rw_require_install
  rw_load_vars
  RW_TOKEN=$(rw_var CAIRN_AUTH_TOKEN)
  RW_SECRET=$(rw_var CAIRN_SETTINGS_SECRET_KEY)
  RW_KV=""
  rw logs --service "$RW_SERVICE" --environment "$RW_ENV" --lines 100 2>&1 | redact_stream
}

rw_cmd_uninstall() {
  rw_require_install
  if [ -n "$OPT_CONFIRM_PURGE" ]; then
    [ "$OPT_CONFIRM_PURGE" = "$RW_PROJECT" ] || die "--confirm-purge must be the Railway project name '$RW_PROJECT'."
  elif has_tty; then
    warn "This deletes the Railway project '$RW_PROJECT' with its service and volume: ALL of this Cairn's"
    warn "data (training, nutrition, health records, AI sign-ins). It cannot be undone."
    printf '%s  ? %sType the project name (%s) to delete it: ' "$C_YELLOW" "$C_RESET" "$RW_PROJECT" >/dev/tty
    rcu_typed=""
    read -r rcu_typed </dev/tty || rcu_typed=""
    [ "$rcu_typed" = "$RW_PROJECT" ] || die "Not confirmed; nothing was deleted."
  else
    die "Deleting the Railway project needs confirmation: run it in a terminal, or add --confirm-purge=$RW_PROJECT."
  fi
  if [ "$OPT_DRY_RUN" = 1 ]; then
    say "Dry run: would run 'railway delete --project $RW_PROJECT_ID --yes' and remove $RW_DIR."
    return 0
  fi
  step "Deleting the Railway project '$RW_PROJECT'"
  if ! rw_cap delete --project "$RW_PROJECT_ID" --yes --json; then
    [ -z "$RW_ERR" ] || printf '%s\n' "$RW_ERR" >&2
    die "Railway did not delete the project. With two-factor sign-in, run in a terminal: railway delete --project $RW_PROJECT_ID"
  fi
  rw unlink --yes >/dev/null 2>&1 || true
  rm -f "$RW_STATE" "$RW_DIR/cairn.sh"
  rmdir "$RW_DIR" 2>/dev/null || true
  ok "Railway accepted the deletion of '$RW_PROJECT'; it finishes on their side shortly."
}

# ----------------------------------------------------------------------------- railway template

# The "Deploy on Railway" template, declared in deploy/railway/template.json and kept in step
# with it here (test/installScript.test.js fails when the two drift). Anyone can build it into
# their own Railway workspace with `railway-template`; nothing depends on one account.
RW_TPL_NAME="Cairn"
RW_TPL_CATEGORY="AI/ML"
RW_TPL_DESCRIPTION="Your own self-hosted coach for training, nutrition and longevity."
RW_TPL_SERVICE="cairn"
RW_TPL_MOUNT="/data"
RW_TPL_HEALTHCHECK="/api/health"
RW_TPL_PORT="8787"
# Never a value: Railway's per-deployer template function, filled in separately for every
# deployer, so no two Cairns share a token or a settings key.
RW_SECRET_VARS="CAIRN_AUTH_TOKEN CAIRN_SETTINGS_SECRET_KEY"
# shellcheck disable=SC2016 # a literal Railway function, not a shell expansion
RW_SECRET_FN='${{secret(48)}}'
RW_TPL_SPEC_URL="https://github.com/zilet/cairn/blob/main/deploy/railway/template.json"
RW_TPL_OVERVIEW_URL="https://raw.githubusercontent.com/zilet/cairn/main/deploy/railway/overview.md"

# json_paths < JSON: one line per scalar, "<dotted.path>\t<value>" (array members keep
# their array's path). Enough to check a template's serializedConfig without jq.
json_paths() {
  awk '
    function prefix(   p, i) { p = ""; for (i = 1; i <= sp; i++) if (typ[i] == "o") p = p ckey[i] "."; return p }
    function emit(v) { if (sp > 0 && typ[sp] == "o") printf "%s\t%s\n", substr(prefix(), 1, length(prefix()) - 1), v }
    function flush() { if (bare != "") { emit(bare); bare = "" } }
    { doc = doc $0 "\n" }
    END {
      sp = 0; instr = 0; esc = 0; bare = ""
      n = length(doc)
      for (i = 1; i <= n; i++) {
        c = substr(doc, i, 1)
        if (instr) {
          if (esc) { str = str c; esc = 0 }
          else if (c == "\\") { str = str c; esc = 1 }
          else if (c == "\"") {
            instr = 0
            if (sp > 0 && typ[sp] == "o" && want[sp] == "k") ckey[sp] = str
            else emit(str)
          } else str = str c
          continue
        }
        if (c == "\"") { instr = 1; str = ""; continue }
        if (c == "{") { flush(); sp++; typ[sp] = "o"; want[sp] = "k"; ckey[sp] = ""; continue }
        if (c == "[") { flush(); sp++; typ[sp] = "a"; continue }
        if (c == "}" || c == "]") { flush(); if (sp > 0) sp--; continue }
        if (c == ":") { if (sp > 0) want[sp] = "v"; continue }
        if (c == ",") { flush(); if (sp > 0 && typ[sp] == "o") want[sp] = "k"; continue }
        if (c == " " || c == "\t" || c == "\n" || c == "\r") { flush(); continue }
        bare = bare c
      }
      flush()
    }'
}

# json_named_id NAME < JSON: the "id" of the first object whose "name" is NAME.
json_named_id() {
  json_flat | awk -F '\t' -v want="$1" '
    $2 == "id" { id[$1] = $3 }
    $2 == "name" && $3 == want { hit[$1] = 1 }
    { if ($1 + 0 > max) max = $1 + 0 }
    END { for (o = 1; o <= max; o++) if ((o in hit) && id[o] != "") { print id[o]; exit } }'
}

# json_member KEY < JSON: the first string/number member KEY anywhere.
json_member() { json_flat | awk -F '\t' -v want="$1" '$2 == want && $3 != "<obj>" && $3 != "<arr>" { print $3; exit }'; }

# rw_tpl_get REGEX: the value at the first path matching ^REGEX$ in RW_TPL_PATHS.
# (The pattern travels in the environment: awk -v would eat its backslashes.)
rw_tpl_get() { printf '%s\n' "$RW_TPL_PATHS" | RTG_RE="^$1\$" awk -F '\t' '$1 ~ ENVIRON["RTG_RE"] { print $2; exit }'; }

# The environment patch that configures the scratch service the way the spec says. A plain
# value travels as its own generator too: Railway's template generate copies a variable's
# generator (or a ${{reference}}) as the template default and drops plain values.
rw_tpl_patch() { # environment-id service-id
  printf '{"env":%s,"patch":{"services":{%s:{' "$(json_str "$1")" "$(json_str "$2")"
  printf '"source":{"image":%s,"autoUpdates":%s},' "$(json_str "$IMAGE")" "$(rw_autoupdates_json)"
  printf '"deploy":{"healthcheckPath":%s},"variables":{' "$(json_str "$RW_TPL_HEALTHCHECK")"
  rtp_sep=""
  for rtp_key in $RW_SECRET_VARS; do
    printf '%s%s:{"value":%s}' "$rtp_sep" "$(json_str "$rtp_key")" "$(json_str "$RW_SECRET_FN")"
    rtp_sep=","
  done
  for rtp_kv in $RW_PLAIN_VARS; do
    printf '%s%s:{"value":%s,"generator":%s}' "$rtp_sep" "$(json_str "${rtp_kv%%=*}")" "$(json_str "${rtp_kv#*=}")" "$(json_str "${rtp_kv#*=}")"
  done
  printf '}}}}}\n'
}

# shellcheck disable=SC2016
RW_TPL_QUERY='query($id: String, $code: String) { template(id: $id, code: $code) { id code name status serializedConfig } }'

rw_tpl_print_plan() {
  step "Cairn's Railway template: plan"
  if [ -n "$OPT_TEMPLATE" ]; then
    say "  Template:    the existing draft $OPT_TEMPLATE, checked against the spec"
  else
    say "  Workspace:   ${OPT_RW_WORKSPACE:-the one your Railway CLI is signed in to}"
    say "  Builds:      a scratch project '$RW_TPL_PROJECT' (deleted again at the end, also on failure),"
    say "               then an unpublished template draft from it, named '$RW_TPL_PROJECT'"
    say "  Service:     $RW_TPL_SERVICE from $IMAGE, a volume at $RW_TPL_MOUNT, a public domain on port $RW_TPL_PORT,"
    say "               health check $RW_TPL_HEALTHCHECK, image auto updates ($RW_TPL_UPDATE_WINDOW)"
    say "  Variables:   $RW_PLAIN_VARS"
    for rtpp_key in $RW_SECRET_VARS; do
      say "               $rtpp_key=$RW_SECRET_FN (Railway's per-deployer secret function, never a value)"
    done
  fi
  if [ "$OPT_PUBLISH" = 1 ]; then
    say "  Publish:     to Railway's marketplace as category $RW_TPL_CATEGORY, \"$RW_TPL_DESCRIPTION\","
    say "               with the overview in deploy/railway/overview.md; asked [y/N] first (or --yes)"
  else
    say "  Publish:     no; the draft stays private (add --publish to publish it)"
  fi
  say "  Spec:        $RW_TPL_SPEC_URL"
}

rw_tpl_print_commands() {
  say ""
  say "Railway CLI commands, run from a temporary directory:"
  say "  railway whoami"
  say "  railway list --json"
  say "  railway init --name $RW_TPL_PROJECT --json${OPT_RW_WORKSPACE:+ --workspace $OPT_RW_WORKSPACE}"
  say "  railway link --project <scratch project id> --environment production"
  say "  railway add --service $RW_TPL_SERVICE --json"
  say "  railway service link $RW_TPL_SERVICE"
  say "  railway volume add --mount-path $RW_TPL_MOUNT --json"
  say "  railway domain --port $RW_TPL_PORT --service $RW_TPL_SERVICE --json"
  say "  railway environment list --json"
  say "  railway api '<environmentPatchCommit>' --variables @patch.json   (image, health check, auto updates, variables)"
  say "  railway templates create --project <scratch project id> --environment production --json"
  say "  railway api '<template serializedConfig>' --raw-var id=<template id>   (the check)"
  say "  railway delete --project <scratch project id> --yes --json"
  if [ "$OPT_PUBLISH" = 1 ]; then
    say "  railway templates publish <template id> --category $RW_TPL_CATEGORY --description \"$RW_TPL_DESCRIPTION\" --readme-file overview.md --json"
  fi
}

# Delete what this run created and has not handed over: the scratch project always, a
# draft only while it is unchecked. Runs from the EXIT trap too, so it never dies.
rw_tpl_cleanup() {
  if [ -n "${RW_TPL_UNVERIFIED:-}" ]; then
    rtc_id="$RW_TPL_UNVERIFIED"
    RW_TPL_UNVERIFIED=""
    if rw_cap templates delete "$rtc_id" --yes --json; then
      ok "Deleted the unchecked template draft $rtc_id."
    else
      warn "Could not delete the unchecked template draft $rtc_id. Delete it yourself: railway templates delete $rtc_id"
    fi
  fi
  if [ -n "${RW_SCRATCH_ID:-}" ]; then
    rtc_id="$RW_SCRATCH_ID"
    RW_SCRATCH_ID=""
    if rw_cap delete --project "$rtc_id" --yes --json; then
      ok "Deleted the scratch project '$RW_TPL_PROJECT' ($rtc_id); Railway finishes removing it on its side."
    else
      warn "Could not delete the scratch project '$RW_TPL_PROJECT' ($rtc_id). Delete it yourself: railway delete --project $rtc_id"
    fi
    rw unlink --yes >/dev/null 2>&1 || true
  fi
  if [ -n "${RW_TPL_WORKDIR:-}" ]; then
    rm -rf "$RW_TPL_WORKDIR" 2>/dev/null || true
    RW_TPL_WORKDIR=""
  fi
}

# RW_TPL_IDS: ids of the projects named RW_TPL_PROJECT, one per line.
rw_tpl_named_projects() {
  rw_must "list your projects" list --json
  RW_TPL_IDS=$(printf '%s\n' "$RW_OUT" | json_project_ids "$RW_TPL_PROJECT")
}

# Build the scratch project from the spec and turn it into a template draft.
rw_tpl_build() {
  rw_tpl_named_projects
  rtb_before="$RW_TPL_IDS"
  info "Creating the scratch project '$RW_TPL_PROJECT'..."
  if [ -n "$OPT_RW_WORKSPACE" ]; then
    rw_cap init --name "$RW_TPL_PROJECT" --workspace "$OPT_RW_WORKSPACE" --json || true
  else
    rw_cap init --name "$RW_TPL_PROJECT" --json || true
  fi
  rtb_init_err="$RW_ERR"
  # The project this run created is the one that was not there before: a project of the
  # same name that already existed is never touched, let alone deleted.
  rtb_new=""
  rtb_count=0
  rw_tpl_named_projects
  for rtb_id in $RW_TPL_IDS; do
    printf '%s\n' "$rtb_before" | grep -qx "$rtb_id" && continue
    rtb_new="$rtb_id"
    rtb_count=$((rtb_count + 1))
  done
  if [ "$rtb_count" != 1 ]; then
    [ -z "$rtb_init_err" ] || printf '%s\n' "$rtb_init_err" >&2
    [ "$rtb_count" = 0 ] || die "Found $rtb_count new projects named '$RW_TPL_PROJECT' and cannot tell which is the scratch one; delete them in Railway and re-run."
    case "$rtb_init_err" in
      *orkspace*) die "Railway could not create the scratch project. If you have more than one workspace, add --workspace=<workspace name or ID>." ;;
    esac
    die "Railway could not create the scratch project '$RW_TPL_PROJECT' (see above)."
  fi
  RW_SCRATCH_ID="$rtb_new"
  ok "Scratch project: $RW_TPL_PROJECT ($RW_SCRATCH_ID)."
  rw_must "link the scratch project" link --project "$RW_SCRATCH_ID" --environment production
  rw_must "add the service" add --service "$RW_TPL_SERVICE" --json
  rtb_svc=$(printf '%s\n' "$RW_OUT" | json_first_id)
  [ -n "$rtb_svc" ] || die "Railway added the service but the installer could not read its id."
  rw_must "link the service" service link "$RW_TPL_SERVICE"
  rw_must "attach the volume" volume add --mount-path "$RW_TPL_MOUNT" --json
  rw_must "create a domain" domain --port "$RW_TPL_PORT" --service "$RW_TPL_SERVICE" --json
  rw_must "read the environment" environment list --json
  rtb_env=$(printf '%s\n' "$RW_OUT" | json_named_id production)
  [ -n "$rtb_env" ] || die "Railway: could not find the scratch project's production environment."
  rw_tpl_patch "$rtb_env" "$rtb_svc" | write_file "$RW_TPL_WORKDIR/patch.json" 600
  rw_must "configure the service" api "$RW_PATCH_MUTATION" --variables "@$RW_TPL_WORKDIR/patch.json"
  ok "Service '$RW_TPL_SERVICE' configured from the spec (no deployment)."
  info "Creating the template draft..."
  rw_must "create the template draft" templates create --project "$RW_SCRATCH_ID" --environment production --json
  RW_TPL_ID=$(printf '%s\n' "$RW_OUT" | json_member id)
  RW_TPL_CODE=$(printf '%s\n' "$RW_OUT" | json_member code)
  [ -n "$RW_TPL_ID" ] || die "Railway created a template draft but the installer could not read its id. Check Templates in your workspace settings."
  RW_TPL_UNVERIFIED="$RW_TPL_ID"
  ok "Template draft: $RW_TPL_CODE ($RW_TPL_ID)."
}

# Read the draft back and compare it with the spec. A secret variable whose default is
# anything but the secret function is a hard stop: the draft is deleted, never published.
# Everything else that is missing is a step for Railway's template editor (RW_TPL_TODO).
rw_tpl_verify() { # id-or-code
  case "$1" in
    *-*-*-*-*) rw_must "read the template draft" api "$RW_TPL_QUERY" --raw-var "id=$1" ;;
    *) rw_must "read the template draft" api "$RW_TPL_QUERY" --raw-var "code=$1" ;;
  esac
  RW_TPL_PATHS=$(printf '%s\n' "$RW_OUT" | json_paths)
  RW_TPL_ID=$(rw_tpl_get 'data\.template\.id')
  RW_TPL_CODE=$(rw_tpl_get 'data\.template\.code')
  RW_TPL_STATUS=$(rw_tpl_get 'data\.template\.status')
  [ -n "$RW_TPL_ID" ] && [ -n "$RW_TPL_CODE" ] || die "Railway returned no template for '$1'."
  rtv_svc='data\.template\.serializedConfig\.services\.[^.]+'
  RW_TPL_TODO=""
  rtv_bad=""
  for rtv_key in $RW_SECRET_VARS; do
    rtv_val=$(rw_tpl_get "$rtv_svc\\.variables\\.$rtv_key\\.defaultValue")
    if [ "$rtv_val" = "$RW_SECRET_FN" ]; then
      ok "$rtv_key: $RW_SECRET_FN (a separate secret for every deployer)."
    elif [ -z "$rtv_val" ]; then
      RW_TPL_TODO="$RW_TPL_TODO${NL}Variable $rtv_key: set it to $RW_SECRET_FN (the function itself, never a value)."
    else
      rtv_bad="$rtv_bad $rtv_key"
    fi
  done
  if [ -n "$rtv_bad" ]; then
    warn "The draft carries a fixed value for:$rtv_bad. Every deployer would share it."
    die "Refusing this draft${RW_TPL_UNVERIFIED:+; it is deleted}. Each secret must be $RW_SECRET_FN in the template editor."
  fi
  for rtv_kv in $RW_PLAIN_VARS; do
    rtv_key="${rtv_kv%%=*}"
    [ "$(rw_tpl_get "$rtv_svc\\.variables\\.$rtv_key\\.defaultValue")" = "${rtv_kv#*=}" ] \
      || RW_TPL_TODO="$RW_TPL_TODO${NL}Variable $rtv_key: set it to ${rtv_kv#*=}."
  done
  rtv_extra=$(printf '%s\n' "$RW_TPL_PATHS" | sed -n "s/^data\\.template\\.serializedConfig\\.services\\.[^.]*\\.variables\\.\\([A-Za-z0-9_]*\\)\\..*/\\1/p" | sort -u)
  for rtv_key in $rtv_extra; do
    case " $RW_SECRET_VARS $(printf '%s\n' "$RW_PLAIN_VARS" | sed 's/=[^ ]*//g') " in
      *" $rtv_key "*) ;;
      *) RW_TPL_TODO="$RW_TPL_TODO${NL}Variable $rtv_key is not in the spec: delete it." ;;
    esac
  done
  rtv_desc=0
  for rtv_key in $RW_SECRET_VARS $(printf '%s\n' "$RW_PLAIN_VARS" | sed 's/=[^ ]*//g'); do
    [ -n "$(rw_tpl_get "$rtv_svc\\.variables\\.$rtv_key\\.description")" ] || rtv_desc=$((rtv_desc + 1))
  done
  [ "$rtv_desc" = 0 ] || RW_TPL_TODO="$RW_TPL_TODO${NL}Variable descriptions ($rtv_desc missing): copy each one from $RW_TPL_SPEC_URL"
  [ "$(rw_tpl_get "$rtv_svc\\.name")" = "$RW_TPL_SERVICE" ] || RW_TPL_TODO="$RW_TPL_TODO${NL}Service name: $RW_TPL_SERVICE."
  [ "$(rw_tpl_get "$rtv_svc\\.source\\.image")" = "$IMAGE" ] || RW_TPL_TODO="$RW_TPL_TODO${NL}Service source: the Docker image $IMAGE."
  [ "$(rw_tpl_get "$rtv_svc\\.deploy\\.healthcheckPath")" = "$RW_TPL_HEALTHCHECK" ] \
    || RW_TPL_TODO="$RW_TPL_TODO${NL}Settings -> Deploy -> Healthcheck Path: $RW_TPL_HEALTHCHECK."
  [ "$(rw_tpl_get "$rtv_svc\\.volumeMounts\\.[^.]+\\.mountPath")" = "$RW_TPL_MOUNT" ] \
    || RW_TPL_TODO="$RW_TPL_TODO${NL}A volume mounted at $RW_TPL_MOUNT."
  [ "$(rw_tpl_get "$rtv_svc\\.networking\\.serviceDomains\\.[^.]+\\.port")" = "$RW_TPL_PORT" ] \
    || RW_TPL_TODO="$RW_TPL_TODO${NL}Settings -> Networking: a public domain on port $RW_TPL_PORT."
  case "$(rw_tpl_get "$rtv_svc\\.source\\.autoUpdates\\.type")" in
    "" | disabled) RW_TPL_TODO="$RW_TPL_TODO${NL}Settings -> Source -> Auto Updates: on, maintenance window $RW_TPL_UPDATE_WINDOW." ;;
  esac
  RW_TPL_UNVERIFIED=""
  RW_TPL_PATHS=""
}

# The overview markdown: deploy/railway/overview.md beside this script in a checkout,
# else the copy on main.
rw_tpl_overview() {
  rto_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || rto_dir=""
  if [ -n "$rto_dir" ] && [ -s "$rto_dir/railway/overview.md" ]; then
    RW_TPL_OVERVIEW="$rto_dir/railway/overview.md"
    return 0
  fi
  has curl || die "curl is required to fetch the template overview ($RW_TPL_OVERVIEW_URL)."
  RW_TPL_OVERVIEW="$RW_TPL_WORKDIR/overview.md"
  info "Fetching the overview: $RW_TPL_OVERVIEW_URL"
  curl -fsSL --proto '=https' --tlsv1.2 "$RW_TPL_OVERVIEW_URL" -o "$RW_TPL_OVERVIEW" </dev/null \
    || die "Could not download $RW_TPL_OVERVIEW_URL"
  grep -q 'Cairn' "$RW_TPL_OVERVIEW" || die "$RW_TPL_OVERVIEW_URL does not look like Cairn's template overview."
}

rw_tpl_report() {
  step "Template draft ready${RW_TPL_STATUS:+ ($RW_TPL_STATUS)}"
  say "  Code:     $RW_TPL_CODE"
  say "  Editor:   https://railway.com/workspace/templates/$RW_TPL_ID"
  say "  Deploy:   https://railway.com/deploy/$RW_TPL_CODE   (for everyone once published)"
  if [ -n "$RW_TPL_TODO" ]; then
    say ""
    say "  Left for Railway's template editor (the Editor link above), then Save:"
    printf '%s\n' "$RW_TPL_TODO" | sed '/^$/d; s/^/    - /'
  fi
}

rw_tpl_publish() {
  if [ -n "$RW_TPL_TODO" ] && [ "$OPT_FORCE" != 1 ]; then
    say ""
    say "Not publishing yet: finish the editor steps above, then publish the checked draft with:"
    say "  sh $(rw_tpl_self) railway-template --publish --template=$RW_TPL_CODE"
    say "(--force publishes without them.)"
    return 0
  fi
  rw_tpl_overview
  step "Publish: plan"
  say "  Template:    $RW_TPL_CODE ($RW_TPL_ID), now ${RW_TPL_STATUS:-UNPUBLISHED}"
  say "  Category:    $RW_TPL_CATEGORY"
  say "  Description: $RW_TPL_DESCRIPTION"
  say "  Overview:    $RW_TPL_OVERVIEW"
  say "  Result:      public in Railway's marketplace, under your workspace:"
  say "               https://railway.com/deploy/$RW_TPL_CODE"
  if [ -n "$RW_TPL_TODO" ]; then say "  Missing:     the editor steps listed above (--force)"; fi
  confirm "Publish this template to Railway's marketplace?" "n" || {
    say "Not published. The draft stays private: https://railway.com/workspace/templates/$RW_TPL_ID"
    return 0
  }
  rw_must "publish the template" templates publish "$RW_TPL_ID" --category "$RW_TPL_CATEGORY" \
    --description "$RW_TPL_DESCRIPTION" --readme-file "$RW_TPL_OVERVIEW" --json
  # Publishing can give the template a new, shorter code (Railway named ours "cairn"):
  # the draft's code then 404s, so the link comes from the publish answer.
  rp_code=$(printf '%s\n' "$RW_OUT" | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
  [ -z "$rp_code" ] || RW_TPL_CODE="$rp_code"
  ok "Published: https://railway.com/deploy/$RW_TPL_CODE"
  say "  Point the project site's /railway redirect at that link to make it the README button."
}

rw_tpl_self() {
  case "$0" in */install.sh | install.sh | */cairn.sh | cairn.sh) printf '%s' "$0" ;; *) printf 'install.sh' ;; esac
}

rw_tpl_main() {
  IMAGE="${OPT_IMAGE:-$DEFAULT_IMAGE}"
  RW_TPL_PROJECT="${OPT_RW_PROJECT:-$RW_TPL_NAME}"
  RW_SCRATCH_ID=""; RW_TPL_UNVERIFIED=""; RW_TPL_WORKDIR=""; RW_TPL_ID=""; RW_TPL_CODE=""; RW_TPL_STATUS=""
  RW_TPL_TODO=""; RW_TOKEN=""; RW_SECRET=""
  rw_tpl_print_plan
  if [ "$OPT_DRY_RUN" = 1 ]; then
    rw_tpl_print_commands
    say ""
    say "Dry run: nothing was changed."
    return 0
  fi
  if [ -z "$OPT_TEMPLATE" ]; then
    confirm "Build the template draft in your Railway workspace?" "y" || die "Cancelled; nothing was changed."
  fi
  RW_TPL_WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/cairn-railway-template.XXXXXX") || die "Could not create a temporary directory."
  RW_DIR="$RW_TPL_WORKDIR"
  rw_ensure_cli
  if ! rw templates create --help >/dev/null 2>&1 || ! rw api --help >/dev/null 2>&1; then
    die "Your Railway CLI is too old (no 'railway templates create' / 'railway api'). Update it (railway upgrade, brew upgrade railway, or npm i -g @railway/cli) and re-run."
  fi
  rw_ensure_login
  ok "Signed in to Railway: $(rw whoami 2>/dev/null | head -n 1)"
  if [ -n "$OPT_TEMPLATE" ]; then
    rw_tpl_verify "$OPT_TEMPLATE"
  else
    step "Building the template"
    rw_tpl_build
    rw_tpl_verify "$RW_TPL_ID"
    step "Cleaning up"
    rw_tpl_cleanup
  fi
  rw_tpl_report
  if [ "$OPT_PUBLISH" = 1 ]; then rw_tpl_publish; fi
  rw_tpl_cleanup
}

railway_main() {
  rw_setup_paths
  case "$CMD" in
    install) rw_cmd_install ;;
    status) rw_cmd_status ;;
    open) rw_cmd_open ;;
    update) rw_cmd_update ;;
    logs) rw_cmd_logs ;;
    uninstall) rw_cmd_uninstall ;;
  esac
}

# ----------------------------------------------------------------------------- main

cleanup() {
  rw_tpl_cleanup
  release_lock
  for cl_f in $TMP_FILES; do rm -f "$cl_f"; done
}

main() {
  RERUN_ARGS="$*" # echoed back in the "re-run with --yes" hints
  TMP_FILES=""
  LOCK_HELD=0
  setup_colors
  parse_args "$@"
  validate_opts
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  detect_platform
  if [ "$CMD" = "railway-template" ]; then
    rw_tpl_main
    return 0
  fi
  resolve_target
  "${TARGET}_main"
}

# This machine (docker/podman compose), the provider named "local" in PROVIDERS.
local_main() {
  resolve_dir
  load_existing
  case "$CMD" in
    install) cmd_install ;;
    update) cmd_update ;;
    status) cmd_status ;;
    open) cmd_open ;;
    logs) cmd_logs ;;
    uninstall) cmd_uninstall ;;
  esac
}

main "$@"
