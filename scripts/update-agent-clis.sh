#!/usr/bin/env sh
set -eu

log() {
  printf '%s\n' "$*"
}

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
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

verify_sha256() {
  file="$1"
  expected="$2"
  actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    set -- $(sha256sum "$file")
    actual="$1"
  elif command -v shasum >/dev/null 2>&1; then
    set -- $(shasum -a 256 "$file")
    actual="$1"
  else
    log "warn: cannot verify installer checksum; neither sha256sum nor shasum is available"
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    log "warn: installer checksum mismatch; expected $expected but got $actual"
    return 1
  fi
}

run_installer() {
  name="$1"
  url="$2"
  sha256="${3:-}"
  allow_unverified="${4:-0}"
  timeout_s="${AGENT_INSTALL_TIMEOUT_SECONDS:-300}"
  log "updating $name via installer"

  if [ -z "$sha256" ] && ! truthy "$allow_unverified"; then
    log "warn: skipping $name installer without a matching *_INSTALL_SHA256; set AGENT_INSTALL_ALLOW_UNVERIFIED=1 to opt in"
    return 0
  fi

  tmp="${TMPDIR:-/tmp}/cairn-${name}-installer.$$"
  if command -v mktemp >/dev/null 2>&1; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/cairn-${name}-installer.XXXXXX")"
  fi
  if ! curl -fsSL "$url" -o "$tmp"; then
    rm -f "$tmp"
    log "warn: $name installer download failed"
    return 0
  fi
  chmod 0700 "$tmp"

  if [ -n "$sha256" ]; then
    if ! verify_sha256 "$tmp" "$sha256"; then
      rm -f "$tmp"
      log "warn: refusing to run $name installer"
      return 0
    fi
  else
    log "warn: running $name installer without checksum because unverified installers were explicitly enabled"
  fi

  if command -v timeout >/dev/null 2>&1; then
    if timeout "$timeout_s" bash "$tmp"; then
      link_bin "$name"
    else
      log "warn: $name installer exited nonzero or timed out"
    fi
  else
    if bash "$tmp"; then
      link_bin "$name"
    else
      log "warn: $name installer exited nonzero or timed out"
    fi
  fi
  rm -f "$tmp"
}

install_npm_cli() {
  name="$1"
  package="$2"
  version="$3"
  shift 3

  if [ -z "$version" ]; then
    log "warn: refusing empty npm package version for $name ($package)"
    return 0
  fi

  case "$version" in
    latest|next|beta|alpha|canary|nightly)
      if ! truthy "${AGENT_CLI_ALLOW_MOVING_TAGS:-0}"; then
        log "warn: refusing moving npm tag for $name ($package@$version); set AGENT_CLI_ALLOW_MOVING_TAGS=1 to opt in"
        return 0
      fi
      ;;
  esac

  log "updating $name via npm package $package@$version"
  npm i -g "$package@$version" "$@"
  report_bin "$name"
}

if [ "${UPDATE_CLAUDE:-1}" = "1" ]; then
  install_npm_cli claude @anthropic-ai/claude-code "${CLAUDE_CODE_VERSION:-2.1.195}"
fi

if [ "${UPDATE_CODEX:-1}" = "1" ]; then
  install_npm_cli codex @openai/codex "${CODEX_CLI_VERSION:-0.142.3}" --include=optional
fi

if [ "${UPDATE_ANTIGRAVITY:-1}" = "1" ]; then
  run_installer agy \
    "${ANTIGRAVITY_INSTALL_URL:-https://antigravity.google/cli/install.sh}" \
    "${ANTIGRAVITY_INSTALL_SHA256:-}" \
    "${ANTIGRAVITY_INSTALL_ALLOW_UNVERIFIED:-${AGENT_INSTALL_ALLOW_UNVERIFIED:-0}}"
fi

if [ "${UPDATE_GROK:-1}" = "1" ]; then
  run_installer grok \
    "${GROK_INSTALL_URL:-https://x.ai/cli/install.sh}" \
    "${GROK_INSTALL_SHA256:-}" \
    "${GROK_INSTALL_ALLOW_UNVERIFIED:-${AGENT_INSTALL_ALLOW_UNVERIFIED:-0}}"
fi

log "agent CLI update complete"
