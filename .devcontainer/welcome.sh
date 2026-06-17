#!/usr/bin/env bash
# Printed each time the sandbox container starts (postStartCommand).
# Also starts the Cairn dev server so the PWA is up immediately.

BOLD="\033[1m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}Cairn sandbox is ready.${RESET}"
echo ""
echo -e "  PWA  →  ${CYAN}http://localhost:8787${RESET}"
echo -e "  API  →  ${CYAN}http://localhost:8787/api/health${RESET}"
echo -e "  MCP  →  ${CYAN}http://localhost:8787/mcp${RESET}  (Streamable HTTP)"
echo ""
echo -e "${YELLOW}Coaching agent options:${RESET}"
echo "  • Set GEMINI_API_KEY or XAI_API_KEY as a sandbox/Codespace secret"
echo "    and the matching agent becomes available in Settings."
echo "  • Or use the built-in offline stub (no key needed) — select"
echo "    'stub' under Settings → Agent to smoke-test the propose/apply loop."
echo "  • Interactive OAuth logins (claude/codex/antigravity) are possible"
echo "    but OAuth tokens won't survive a sandbox rebuild — prefer API keys."
echo ""
echo -e "${YELLOW}Optional auth:${RESET}"
echo "  Set CAIRN_AUTH_TOKEN as a secret if this sandbox URL is public."
echo ""

# Start the dev server in the background so the terminal stays interactive.
# Logs go to /tmp/cairn-dev.log; 'tail -f /tmp/cairn-dev.log' to watch.
if ! curl -fsS http://localhost:8787/api/health >/dev/null 2>&1; then
  echo "Starting Cairn dev server (logs: /tmp/cairn-dev.log)..."
  nohup npm run dev > /tmp/cairn-dev.log 2>&1 &
  echo "  PID $! — run 'tail -f /tmp/cairn-dev.log' to follow logs."
else
  echo "Cairn is already running on port 8787."
fi
echo ""
