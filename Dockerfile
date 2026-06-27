# syntax=docker/dockerfile:1.7.0

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- builder: compile TypeScript ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
# BuildKit cache mount keeps ~/.npm warm across rebuilds (big win on the Pi).
RUN --mount=type=cache,target=/root/.npm npm ci
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# All CLI logins persist under HOME, which is a mounted volume at runtime.
ENV HOME=/home/app
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git unzip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --home-dir /home/app --uid 10001 --shell /bin/sh app

COPY scripts/update-agent-clis.sh /usr/local/bin/cairn-update-agent-clis
COPY scripts/docker-entrypoint.sh /usr/local/bin/cairn-entrypoint
RUN chmod +x /usr/local/bin/cairn-update-agent-clis /usr/local/bin/cairn-entrypoint

# Bake in coaching CLIs. claude/codex are npm installs pinned below.
# Antigravity/Grok use moving shell installers, so they are opt-in unless a
# checksum is supplied via the matching *_INSTALL_SHA256 build arg.
# Binaries are moved OUT of HOME so the home volume mount doesn't hide them.
ARG INSTALL_CLAUDE=1
ARG INSTALL_CODEX=1
ARG INSTALL_ANTIGRAVITY=0
ARG INSTALL_GROK=0
ARG CLAUDE_CODE_VERSION=2.1.195
ARG CODEX_CLI_VERSION=0.142.3
ARG ANTIGRAVITY_INSTALL_URL=https://antigravity.google/cli/install.sh
ARG ANTIGRAVITY_INSTALL_SHA256=
ARG GROK_INSTALL_URL=https://x.ai/cli/install.sh
ARG GROK_INSTALL_SHA256=
ARG AGENT_INSTALL_ALLOW_UNVERIFIED=0
ARG AGENT_CLI_CACHE_BUST=unset
# Cache mount on ~/.npm — don't `npm cache clean` here, it would wipe the mount.
# Set AGENT_CLI_CACHE_BUST=$(date +%s) when you want Docker to refresh this layer
# without doing a full --no-cache rebuild.
RUN --mount=type=cache,target=/root/.npm set -eux; \
    echo "agent cli cache bust: ${AGENT_CLI_CACHE_BUST}"; \
    UPDATE_CLAUDE="$INSTALL_CLAUDE" \
    UPDATE_CODEX="$INSTALL_CODEX" \
    UPDATE_ANTIGRAVITY="$INSTALL_ANTIGRAVITY" \
    UPDATE_GROK="$INSTALL_GROK" \
    CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
    CODEX_CLI_VERSION="$CODEX_CLI_VERSION" \
    ANTIGRAVITY_INSTALL_URL="$ANTIGRAVITY_INSTALL_URL" \
    ANTIGRAVITY_INSTALL_SHA256="$ANTIGRAVITY_INSTALL_SHA256" \
    GROK_INSTALL_URL="$GROK_INSTALL_URL" \
    GROK_INSTALL_SHA256="$GROK_INSTALL_SHA256" \
    AGENT_INSTALL_ALLOW_UNVERIFIED="$AGENT_INSTALL_ALLOW_UNVERIFIED" \
    AGENT_INSTALL_TIMEOUT_SECONDS=300 \
    cairn-update-agent-clis

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY agents.json ./

# Hand the writable areas to the unprivileged `app` user. /usr/local is baked into
# the image (not a volume), so chowning it here lets the app user self-update the
# CLIs at runtime; /data and /home/app are volumes and are chowned at boot by the
# entrypoint (which also fixes pre-existing root-owned volumes from older images).
RUN mkdir -p /data \
 && chown -R app:app /app /data /home/app /usr/local/lib/node_modules /usr/local/bin

# The exact release version, passed from the git tag by the release workflow so
# the in-app update check is precise even on the rolling :latest tag. Empty on a
# local/source build — version.ts then falls back to package.json. A non-version
# value (e.g. a branch name on a dispatch build) is ignored by version.ts.
ARG CAIRN_VERSION=""

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    CAIRN_VERSION=${CAIRN_VERSION} \
    AGENT_CLI_UPDATE_SCRIPT=/usr/local/bin/cairn-update-agent-clis \
    PATH="/usr/local/bin:${PATH}"

VOLUME ["/data", "/home/app"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/health || exit 1

# Starts as root only to fix volume ownership, then drops to the `app` user.
ENTRYPOINT ["cairn-entrypoint"]
CMD ["node", "dist/server.js"]
