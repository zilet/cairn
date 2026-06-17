# syntax=docker/dockerfile:1

# ---- builder: compile TypeScript ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
# BuildKit cache mount keeps ~/.npm warm across rebuilds (big win on the Pi).
RUN --mount=type=cache,target=/root/.npm npm ci
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
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

# Bake in coaching CLIs. claude/codex (npm) are reliable and land in /usr/local/bin.
# antigravity/grok use Google/xAI shell installers (beta; verify arm64 on the Pi).
# Binaries are moved OUT of HOME so the home volume mount doesn't hide them.
ARG INSTALL_CLAUDE=1
ARG INSTALL_CODEX=1
ARG INSTALL_ANTIGRAVITY=1
ARG INSTALL_GROK=1
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

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    AGENT_CLI_UPDATE_SCRIPT=/usr/local/bin/cairn-update-agent-clis \
    PATH="/usr/local/bin:${PATH}"

VOLUME ["/data", "/home/app"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/health || exit 1

# Starts as root only to fix volume ownership, then drops to the `app` user.
ENTRYPOINT ["cairn-entrypoint"]
CMD ["node", "dist/server.js"]
