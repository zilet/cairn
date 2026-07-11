#!/usr/bin/env sh
set -eu

# Compatibility wrapper kept as the stable Docker/app entrypoint. The actual
# installer is Node so every command is an argv array (never shell interpolation)
# and the bundled agents.json remains the single source of package pins, URLs and
# checksums.
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
manager="${CAIRN_AGENT_CLI_MANAGER:-}"
if [ -z "$manager" ]; then
  if [ -f /usr/local/lib/cairn/install-agent-cli.mjs ]; then
    manager=/usr/local/lib/cairn/install-agent-cli.mjs
  else
    manager="$here/install-agent-cli.mjs"
  fi
fi

exec node "$manager" "$@"
