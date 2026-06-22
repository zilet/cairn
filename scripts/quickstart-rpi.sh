#!/usr/bin/env bash
# scripts/quickstart-rpi.sh -- Cairn setup for Raspberry Pi (arm64).
# Designed for a Raspberry Pi 4/5 running Raspberry Pi OS or Ubuntu Server (64-bit).
# Strongly recommends Docker; direct Node is NOT recommended on the Pi because
# the host OS Node is usually too old (Cairn requires Node 24).
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

info()    { printf "${CYAN}  -> ${RESET}%s\n" "$*"; }
success() { printf "${GREEN}  ok ${RESET}%s\n" "$*"; }
warn()    { printf "${YELLOW}  !  ${RESET}%s\n" "$*"; }
die()     { printf "${RED}  err${RESET}%s\n" " $*" >&2; exit 1; }
banner()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }
ask()     { printf "${YELLOW}  ?  ${RESET}%s [y/N] " "$*"; }

HEALTH_URL="http://localhost:8787/api/health"
PORT=8787
TIMEOUT=180   # Pi builds are slower; allow more time

# ---------- arm64 check ----------

banner "Cairn quickstart -- Raspberry Pi"

ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  success "Architecture: $ARCH (arm64 -- good)."
elif [ "$ARCH" = "armv7l" ]; then
  warn "Architecture: armv7l (32-bit). Cairn's Node 24 image requires a 64-bit OS."
  warn "Flash a 64-bit Raspberry Pi OS (Bookworm) and re-run this script."
  die "Unsupported architecture: $ARCH"
else
  warn "Architecture detected: $ARCH. This script targets arm64 Pi; continuing anyway."
fi

# ---------- memory / swap check ----------

TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
TOTAL_MEM_MB=$(( TOTAL_MEM_KB / 1024 ))
if [ "$TOTAL_MEM_MB" -lt 1800 ]; then
  warn "Only ${TOTAL_MEM_MB} MB RAM detected."
  warn "Docker builds and TypeScript compilation can exhaust memory on low-RAM Pis."
  warn "If the build fails, add a swap file:"
  warn "  sudo dphys-swapfile swapoff"
  warn "  sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile"
  warn "  sudo dphys-swapfile setup && sudo dphys-swapfile swapon"
  warn "Then re-run this script."
fi

# ---------- Docker check / optional install ----------

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  ask "Install Docker via get.docker.com? (safe for Raspberry Pi OS / Ubuntu)"
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      info "Downloading and running the official Docker install script..."
      curl -fsSL https://get.docker.com | sh
      # Add current user to docker group so sudo is not needed
      if id -nG "$USER" | grep -qw docker; then
        success "User '$USER' is already in the docker group."
      else
        sudo usermod -aG docker "$USER"
        warn "Added '$USER' to the docker group. You may need to log out and back in,"
        warn "or run: newgrp docker"
        warn "Then re-run this script."
        exit 0
      fi
      ;;
    *)
      die "Docker is required. Install it from https://docs.docker.com/engine/install/ and re-run."
      ;;
  esac
fi

COMPOSE=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "docker compose plugin not found. Install it: sudo apt-get install docker-compose-plugin"
fi

success "Docker and Compose found: $($COMPOSE version --short 2>/dev/null || echo ok)."

# ---------- already running? ----------

if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  success "Cairn is already running at http://localhost:${PORT}."
  printf "  Access it on other devices via this Pi's hostname or IP:\n"
  HOSTNAME_LOCAL=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<pi-ip>")
  printf "    http://%s:%s\n" "$HOSTNAME_LOCAL" "$PORT"
  exit 0
fi

# ---------- .env setup ----------

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    info "Created .env from .env.example."
    info "IMPORTANT: Edit .env to set TZ to your local timezone, e.g.:"
    info "  TZ=Europe/London"
  else
    warn ".env.example not found; skipping .env creation."
  fi
else
  info ".env already exists -- leaving it unchanged."
fi

# ---------- persistent data reminder ----------

info "Data volumes:"
info "  cairn-data  -- SQLite DB, uploads, art cache (survives rebuilds)"
info "  cairn-home  -- CLI logins (~/.claude, ~/.codex, etc.)"
info "Back them up periodically with:"
info "  docker run --rm -v cairn-data:/data -v \"\$PWD\":/backup busybox tar czf /backup/cairn-data-\$(date +%F).tgz -C /data ."

# ---------- build and start ----------

info "Building Cairn image for arm64 (first run may take several minutes)..."
$COMPOSE up -d --build

# ---------- wait for health ----------

elapsed=0
interval=3
printf "  Waiting for Cairn at %s " "$HEALTH_URL"
while ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
  sleep "$interval"
  elapsed=$(( elapsed + interval ))
  printf "."
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    printf "\n"
    die "Server did not become healthy in ${TIMEOUT}s. Check: $COMPOSE logs --tail=60 cairn"
  fi
done
printf "\n"

success "Cairn is healthy."

# ---------- success banner ----------

HOSTNAME_LOCAL=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<pi-ip>")

printf "\n"
printf "${GREEN}${BOLD}+-------------------------------------------------------+${RESET}\n"
printf "${GREEN}${BOLD}|  Cairn is running on your Pi!                         |${RESET}\n"
printf "${GREEN}${BOLD}+-------------------------------------------------------+${RESET}\n"
printf "\n"
printf "  On this Pi:         http://localhost:${PORT}\n"
printf "  From other devices: http://%s:${PORT}\n" "$HOSTNAME_LOCAL"
printf "\n"
printf "  ${BOLD}Use it on your phone (private, via Tailscale Serve)${RESET}\n"
printf "  One step sets up a private HTTPS URL and prints your exact phone link:\n"
printf "       ${CYAN}PORT=${PORT} ./scripts/setup-phone.sh${RESET}\n"
printf "  Tailnet-only — nothing hits the public internet. Then on your phone:\n"
printf "  Share → Add to Home Screen. Manual steps + caveats: docs/DEPLOYMENT.md.\n"
printf "\n"
printf "${YELLOW}${BOLD}  Next: connect one coaching agent${RESET}\n"
printf "\n"
printf "  Easiest: in the app, Settings -> Agents -> Connect (sign in right there).\n"
printf "  Or log in inside the container (always use -u app):\n"
printf "\n"
printf "  A) Claude Code (Anthropic Pro/Max):\n"
printf "       $COMPOSE exec -u app -it cairn claude auth login\n"
printf "\n"
printf "  B) Codex (ChatGPT):\n"
printf "       $COMPOSE exec -u app -it cairn codex login\n"
printf "\n"
printf "  C) Grok (SuperGrok / X Premium+):\n"
printf "       $COMPOSE exec -u app -it cairn grok login --device-auth\n"
printf "\n"
printf "  D) Antigravity / Google:\n"
printf "       $COMPOSE exec -u app -it cairn agy\n"
printf "\n"
printf "  E) stub (offline, no key):\n"
printf "       Settings -> Agents -> enable stub\n"
printf "\n"
printf "  ${CYAN}The Brief, logging, and the plan work with no agent at all.\n"
printf "  Chat, coaching drafts, and meal plans need one agent.${RESET}\n"
printf "\n"
printf "  Full walkthrough: docs/DEPLOYMENT.md (Raspberry Pi section)\n"
printf "\n"
