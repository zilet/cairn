#!/usr/bin/env bash
#
# container-tool.sh — resolve which container engine and Compose front-end this
# machine actually has. Source it from a bash script:
#
#   . "$(dirname "$0")/scripts/container-tool.sh"
#   resolve_container_tool || die "no container engine"
#   $COMPOSE up -d --build
#
# Sets:
#   CONTAINER_CLI   docker | podman | container      (Apple's native container CLI)
#   COMPOSE         "docker compose" | "docker-compose" | "podman compose" |
#                   "podman-compose" | ""            (empty = engine but no Compose)
#   CONTAINER_TOOL_WHY   one human-readable line saying what was picked and why
#
# Override with CAIRN_CONTAINER_TOOL=docker|podman|container. Detection is by
# BINARY, never by shell alias: `alias docker=podman` in an interactive zsh is
# invisible to a script, so a Mac that moved to Podman would otherwise report
# "docker found" in one shell and "docker missing" in another. A found engine
# must also answer `info` (its daemon / machine is up) to count as available.
#
# Bash 3.2 compatible (macOS ships 3.2): no associative arrays, no ${var,,}.

_ctool_has() { command -v "$1" >/dev/null 2>&1; }

_ctool_engine_up() {
  case "$1" in
    docker) docker info >/dev/null 2>&1 ;;
    podman) podman info >/dev/null 2>&1 ;;
    container) container system status >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

_ctool_compose_for() {
  case "$1" in
    docker)
      if docker compose version >/dev/null 2>&1; then echo "docker compose"
      elif _ctool_has docker-compose; then echo "docker-compose"
      fi ;;
    podman)
      # `podman compose` is a thin shim that needs a provider (docker-compose or
      # podman-compose) on PATH; `version` fails loudly when none is installed.
      if podman compose version >/dev/null 2>&1; then echo "podman compose"
      elif _ctool_has podman-compose; then echo "podman-compose"
      elif _ctool_has docker-compose; then echo "docker-compose"
      fi ;;
    container)
      # Apple's container CLI has no Compose front-end.
      ;;
  esac
}

# resolve_container_tool [--require-compose]
#   returns 0 when an engine was found (and Compose too, if required), 1 otherwise.
resolve_container_tool() {
  local need_compose=0 candidate candidates
  [ "${1:-}" = "--require-compose" ] && need_compose=1
  CONTAINER_CLI=""
  COMPOSE=""
  CONTAINER_TOOL_WHY=""
  if [ -n "${CAIRN_CONTAINER_TOOL:-}" ]; then
    candidates="$CAIRN_CONTAINER_TOOL"
  else
    candidates="docker podman container"
  fi
  for candidate in $candidates; do
    _ctool_has "$candidate" || continue
    if ! _ctool_engine_up "$candidate"; then
      CONTAINER_TOOL_WHY="$candidate is installed but its engine is not running"
      continue
    fi
    CONTAINER_CLI="$candidate"
    COMPOSE="$(_ctool_compose_for "$candidate")"
    break
  done
  if [ -z "$CONTAINER_CLI" ]; then
    [ -n "$CONTAINER_TOOL_WHY" ] || CONTAINER_TOOL_WHY="no container engine found (looked for: $candidates)"
    return 1
  fi
  if [ -n "$COMPOSE" ]; then
    CONTAINER_TOOL_WHY="using $CONTAINER_CLI with '$COMPOSE'"
  else
    CONTAINER_TOOL_WHY="using $CONTAINER_CLI (no Compose front-end found)"
    [ "$need_compose" = "1" ] && return 1
  fi
  return 0
}

# compose_install_hint — one line telling the reader how to get Compose for the
# engine that was found.
compose_install_hint() {
  case "${CONTAINER_CLI:-}" in
    docker) echo "Install the Compose plugin: https://docs.docker.com/compose/install/ (Debian/Ubuntu: sudo apt-get install docker-compose-plugin)" ;;
    podman) echo "Install a Compose provider for Podman: 'pip install podman-compose' or a docker-compose binary on PATH" ;;
    container) echo "Apple's container CLI has no Compose; use Podman or Docker for the Compose path, or run the image directly with 'container run'" ;;
    *) echo "Install Docker (https://docs.docker.com/engine/install/) or Podman (https://podman.io)" ;;
  esac
}
