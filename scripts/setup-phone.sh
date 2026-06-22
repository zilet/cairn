#!/usr/bin/env bash
# setup-phone.sh -- put Cairn on your phone, privately, in one step.
#
# Uses Tailscale **Serve** to publish Cairn on your tailnet's HTTPS MagicDNS name.
# This is tailnet-only: nothing is exposed to the public internet, only your own
# signed-in devices can reach it. The script detects your real phone URL for you
# and degrades gracefully -- if anything is missing it prints exactly what to do
# by hand and never leaves you worse off than the manual path.
#
# Usage:
#   ./scripts/setup-phone.sh            # detect + (with your consent) enable Serve
#   ./scripts/setup-phone.sh --yes      # enable Serve without the y/N prompt
#   ./scripts/setup-phone.sh --print    # only detect + print; never runs sudo
#   PORT=8787 ./scripts/setup-phone.sh  # override the local port (default 8787)
set -u

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()  { printf "${CYAN}  -> ${RESET}%s\n" "$*"; }
ok()    { printf "${GREEN}  ok ${RESET}%s\n" "$*"; }
warn()  { printf "${YELLOW}  !  ${RESET}%s\n" "$*"; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

PORT="${PORT:-8787}"
MODE="ask"   # ask | yes | print
for arg in "$@"; do
  case "$arg" in
    --yes|-y) MODE="yes" ;;
    --print)  MODE="print" ;;
    -h|--help)
      printf "Usage: %s [--yes|--print]   (PORT env overrides the local port)\n" "$0"; exit 0 ;;
    *) warn "Ignoring unknown argument: $arg" ;;
  esac
done

SERVE_CMD="sudo tailscale serve --bg --https=443 http://127.0.0.1:${PORT}"

print_manual() {
  step "Set it up by hand (same result)"
  printf "  1. Install Tailscale on this machine and your phone, sign in to both.\n"
  printf "       https://tailscale.com/download\n"
  printf "  2. On this machine run once:\n"
  printf "       ${CYAN}%s${RESET}\n" "$SERVE_CMD"
  printf "  3. Open your tailnet HTTPS URL on your phone:\n"
  printf "       ${BOLD}https://<this-host>.<your-tailnet>.ts.net/${RESET}\n"
  printf "  4. iOS Safari: Share -> Add to Home Screen   |   Android Chrome: menu -> Install app\n"
}

print_phone_steps() {
  local url="$1"
  step "Open this on your phone"
  printf "  ${BOLD}${GREEN}%s${RESET}\n" "$url"
  printf "\n"
  printf "  iOS Safari:    Share -> Add to Home Screen\n"
  printf "  Android Chrome: menu (3 dots) -> Install app / Add to Home screen\n"
  printf "\n"
  printf "  That installs a real offline-capable app on your home screen, reachable\n"
  printf "  ${CYAN}only${RESET} from your own signed-in tailnet devices -- never the public internet.\n"
  printf "\n"
  printf "  A shared token (CAIRN_AUTH_TOKEN) is optional on a private tailnet; set one\n"
  printf "  if other people share your tailnet. See SECURITY.md.\n"
}

# Best-effort MagicDNS name of THIS node (e.g. macbook.tailXXXX.ts.net).
detect_magicdns() {
  local name=""
  if command -v python3 >/dev/null 2>&1; then
    name=$(tailscale status --json 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print((d.get("Self") or {}).get("DNSName", "").rstrip("."))
except Exception:
    pass
' 2>/dev/null)
  fi
  if [ -z "$name" ]; then
    # Fallback without python/jq: Self precedes Peer in the JSON, so the first
    # DNSName is this node's. Tolerate the pretty-printed `"DNSName": "host."`.
    name=$(tailscale status --json 2>/dev/null \
      | grep -o '"DNSName": *"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')
  fi
  printf '%s' "$name"
}

step "Cairn -> phone setup (Tailscale Serve, private)"

# 1) Cairn reachable locally?
if ! curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  warn "Cairn does not look like it's running on http://localhost:${PORT}."
  info "Start it first (./quickstart.sh or docker compose up -d), then re-run this."
fi

# 2) Tailscale present?
if ! command -v tailscale >/dev/null 2>&1; then
  warn "The 'tailscale' command was not found on this machine."
  print_manual
  exit 0
fi

# 3) Logged in?
if ! tailscale status >/dev/null 2>&1; then
  warn "Tailscale is installed but not connected."
  info "Run:  ${CYAN}sudo tailscale up${RESET}  (sign in), then re-run this script."
  print_manual
  exit 0
fi
ok "Tailscale is connected."

# 4) Detect this node's HTTPS URL.
DNS_NAME="$(detect_magicdns)"
if [ -n "$DNS_NAME" ]; then
  PHONE_URL="https://${DNS_NAME}/"
  ok "Your phone URL will be: ${PHONE_URL}"
else
  PHONE_URL=""
  warn "Could not auto-detect your MagicDNS name (that's fine -- it still works)."
fi

# 5) Already serving on 443 -> our port?
if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
  ok "Tailscale Serve is already pointing 443 at Cairn."
  if [ -n "$PHONE_URL" ]; then print_phone_steps "$PHONE_URL"; else print_manual; fi
  exit 0
fi

# 6) Enable Serve (with consent), unless --print.
if [ "$MODE" = "print" ]; then
  step "Enable Tailscale Serve, then you're done"
  printf "  Run:\n       ${CYAN}%s${RESET}\n" "$SERVE_CMD"
  if [ -n "$PHONE_URL" ]; then print_phone_steps "$PHONE_URL"; else print_manual; fi
  exit 0
fi

if [ "$MODE" = "ask" ]; then
  if [ ! -t 0 ]; then
    info "Non-interactive shell -- printing the command instead of running it."
    printf "       ${CYAN}%s${RESET}\n" "$SERVE_CMD"
    if [ -n "$PHONE_URL" ]; then print_phone_steps "$PHONE_URL"; else print_manual; fi
    exit 0
  fi
  printf "\n  This will run (needs sudo):\n       ${CYAN}%s${RESET}\n" "$SERVE_CMD"
  printf "  Set up Tailscale Serve now? [y/N] "
  read -r reply
  case "$reply" in
    y|Y|yes|YES) : ;;
    *) info "Skipped. You can run the command above yourself any time."; exit 0 ;;
  esac
fi

step "Enabling Tailscale Serve..."
if eval "$SERVE_CMD"; then
  ok "Serve enabled."
  # Re-detect in case Serve only became resolvable now.
  [ -z "$PHONE_URL" ] && { DNS_NAME="$(detect_magicdns)"; [ -n "$DNS_NAME" ] && PHONE_URL="https://${DNS_NAME}/"; }
  if [ -n "$PHONE_URL" ]; then print_phone_steps "$PHONE_URL"; else
    warn "Serve is on, but I couldn't read your URL. Check: tailscale serve status"
    print_manual
  fi
else
  warn "Could not enable Serve automatically."
  info "Your tailnet admin may need to enable HTTPS/Serve in the Tailscale console first:"
  info "  https://login.tailscale.com/admin/dns  (enable MagicDNS + HTTPS certificates)"
  print_manual
fi
