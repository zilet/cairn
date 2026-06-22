#!/usr/bin/env bash
# quickstart.sh -- get Cairn running in ~30 seconds.
# Prefers Docker (no Node required on the host); falls back to local Node 24.
# Usage: ./quickstart.sh [--dev]  (--dev forces npm run dev instead of npm start)
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

HEALTH_URL="http://localhost:8787/api/health"
PORT=8787
TIMEOUT=120  # seconds to wait for the server to become ready

wait_for_health() {
  local elapsed=0
  local interval=2
  printf "  Waiting for Cairn at %s " "$HEALTH_URL"
  while ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
    sleep "$interval"
    elapsed=$(( elapsed + interval ))
    printf "."
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
      printf "\n"
      die "Server did not become healthy within ${TIMEOUT}s. Check logs for errors."
    fi
  done
  printf "\n"
}

print_success_banner() {
  printf "\n"
  printf "${GREEN}${BOLD}+-------------------------------------------------------+${RESET}\n"
  printf "${GREEN}${BOLD}|  Cairn is running!                                    |${RESET}\n"
  printf "${GREEN}${BOLD}+-------------------------------------------------------+${RESET}\n"
  printf "\n"
  printf "  Open ${BOLD}http://localhost:${PORT}${RESET} in your browser.\n"
  printf "  You will land on the Brief -- your calm daily read.\n"
  printf "\n"
  printf "${YELLOW}${BOLD}  Next: connect one agent for full coaching${RESET}\n"
  printf "\n"
  if [ "${USE_DOCKER:-0}" = "1" ]; then
    printf "  A) Claude Code (Anthropic Pro/Max):\n"
    printf "       docker compose exec -u app -it cairn claude\n"
    printf "\n"
    printf "  B) Codex (ChatGPT):\n"
    printf "       docker compose exec -u app -it cairn codex login\n"
    printf "\n"
    printf "  C) Grok (SuperGrok / X Premium+):\n"
    printf "       docker compose exec -u app -it cairn grok -p hello\n"
    printf "\n"
    printf "  D) Antigravity / Google (Google account):\n"
    printf "       docker compose exec -u app -it cairn agy\n"
    printf "\n"
    printf "  E) stub -- offline, no key, great for exploring:\n"
    printf "       Settings -> Agents -> enable stub\n"
  else
    printf "  A) Claude Code: run 'claude' once to log in, then Settings -> Agents.\n"
    printf "  B) stub (offline, no key): Settings -> Agents -> enable stub.\n"
  fi
  printf "\n"
  printf "  ${CYAN}The Brief, logging, and the plan work with no agent at all.\n"
  printf "  Chat, coaching drafts, and meal plans need one agent.${RESET}\n"
  printf "\n"
  print_phone_access_instructions
  printf "  Full walkthrough: docs/QUICKSTART.md\n"
  printf "\n"
}

print_phone_access_instructions() {
  printf "\n"
  printf "${BOLD}Use it on your phone (private, via Tailscale Serve)${RESET}\n"
  printf "  One step sets up a private HTTPS URL and prints your exact phone link:\n"
  printf "       ${CYAN}PORT=${PORT} ./scripts/setup-phone.sh${RESET}\n"
  printf "  It uses Tailscale Serve — tailnet-only, nothing on the public internet —\n"
  printf "  then it's Share → Add to Home Screen on your phone.\n"
  printf "  Manual steps + exposure caveats: docs/DEPLOYMENT.md, SECURITY.md.\n"
  printf "\n"
  printf "  ${CYAN}The Brief, logging, and plan work immediately — no phone setup or agent required.${RESET}\n"
}

setup_env() {
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      info "Created .env from .env.example -- edit it to set TZ, API keys, etc."
    else
      warn ".env.example not found; skipping .env creation."
    fi
  else
    info ".env already exists -- leaving it unchanged."
  fi
}

try_docker() {
  banner "Cairn quickstart -- Docker path"

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  COMPOSE=""
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    warn "Docker is installed but neither 'docker compose' nor 'docker-compose' is available."
    return 1
  fi

  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    success "Cairn is already running at http://localhost:${PORT}."
    USE_DOCKER=1
    print_success_banner
    exit 0
  fi

  setup_env

  banner "Heads up before the first build"
  info "The first Docker build bakes the coaching CLIs into the image -- expect ~3-6 minutes."
  info "Later rebuilds are fast (BuildKit caches the layers)."
  info "The beta 'agy' (Antigravity) and 'grok' installers can fail on some architectures"
  info "(e.g. Raspberry Pi / arm64). That's fine -- claude and codex still work, and you can"
  info "set INSTALL_ANTIGRAVITY/INSTALL_GROK to \"0\" in docker-compose.yml to skip them."
  info ""
  info "Building and starting Cairn with Docker..."
  $COMPOSE up -d --build

  USE_DOCKER=1
  wait_for_health
  success "Cairn is healthy."
  print_success_banner
}

try_node() {
  local force_dev="${1:-0}"

  banner "Cairn quickstart -- local Node path"

  if ! command -v node >/dev/null 2>&1; then
    die "Node is not installed. Install Node 24 from https://nodejs.org and re-run, or install Docker."
  fi

  local node_major
  node_major=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$node_major" -lt 24 ]; then
    die "Node ${node_major} detected. Cairn requires Node 24 (node:sqlite is only unflagged in Node 24+). Install from https://nodejs.org or: nvm install 24 && nvm use 24"
  fi

  success "Node $(node --version) found."

  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    success "Cairn is already running at http://localhost:${PORT}."
    print_success_banner
    exit 0
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port ${PORT} is already in use by another process. Stop it first, or change PORT in .env."
  fi

  setup_env

  info "Installing dependencies..."
  npm install

  if [ "$force_dev" = "1" ]; then
    info "Starting Cairn in dev mode (npm run dev)..."
    npm run dev &
  else
    info "Building Cairn (npm run build)..."
    npm run build
    info "Starting Cairn (npm start)..."
    npm start &
  fi

  wait_for_health
  success "Cairn is healthy."
  print_success_banner
}

DEV_MODE=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=1 ;;
    -h|--help)
      printf "Usage: %s [--dev]\n" "$0"
      printf "  --dev   Use npm run dev on the Node path (tsx watch, no build step)\n"
      exit 0
      ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
    try_docker
  else
    warn "Docker is installed but Compose is not available; falling back to local Node."
    try_node "$DEV_MODE"
  fi
else
  try_node "$DEV_MODE"
fi
