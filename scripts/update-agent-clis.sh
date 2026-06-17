#!/usr/bin/env sh
set -eu

log() {
  printf '%s\n' "$*"
}

report_bin() {
  name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    log "ok: $name -> $("$name" --version 2>/dev/null || "$name" -v 2>/dev/null || echo installed)"
  else
    log "warn: '$name' is not on PATH after install"
  fi
}

link_bin() {
  name="$1"
  src="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$src" ]; then
    src="$(find "${HOME:-/home/app}" /root /opt /usr/local -name "$name" -type f -perm -u+x 2>/dev/null | head -1 || true)"
  fi
  src="$(readlink -f "$src" 2>/dev/null || echo "$src")"
  if [ -n "$src" ] && [ -f "$src" ]; then
    rm -f "/usr/local/bin/$name"
    cp -f "$src" "/usr/local/bin/$name"
    chmod +x "/usr/local/bin/$name"
  fi
  if [ -f "/usr/local/bin/$name" ]; then
    log "ok: $name -> $(/usr/local/bin/"$name" --version 2>/dev/null || /usr/local/bin/"$name" -v 2>/dev/null || echo installed)"
  else
    log "warn: '$name' is not a real binary in /usr/local/bin after install"
  fi
}

run_installer() {
  name="$1"
  url="$2"
  timeout_s="${AGENT_INSTALL_TIMEOUT_SECONDS:-300}"
  log "updating $name via installer"
  if command -v timeout >/dev/null 2>&1; then
    if timeout "$timeout_s" sh -c "curl -fsSL '$url' | bash"; then
      link_bin "$name"
    else
      log "warn: $name installer exited nonzero or timed out"
    fi
  else
    if sh -c "curl -fsSL '$url' | bash"; then
      link_bin "$name"
    else
      log "warn: $name installer exited nonzero or timed out"
    fi
  fi
}

if [ "${UPDATE_CLAUDE:-1}" = "1" ]; then
  log "updating claude"
  npm i -g @anthropic-ai/claude-code@latest
  report_bin claude
fi

if [ "${UPDATE_CODEX:-1}" = "1" ]; then
  log "updating codex"
  npm i -g @openai/codex@latest --include=optional
  report_bin codex
fi

if [ "${UPDATE_ANTIGRAVITY:-1}" = "1" ]; then
  run_installer agy "https://antigravity.google/cli/install.sh"
fi

if [ "${UPDATE_GROK:-1}" = "1" ]; then
  run_installer grok "https://x.ai/cli/install.sh"
fi

log "agent CLI update complete"
