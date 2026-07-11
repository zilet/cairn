# syntax=docker/dockerfile:1.7.0

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- builder: compile TypeScript ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package*.json tsconfig.json tsconfig.client.build.json ./
# BuildKit cache mount keeps ~/.npm warm across rebuilds (big win on the Pi).
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
COPY scripts/build-client.mjs ./scripts/build-client.mjs
COPY src ./src
# The bundling step concatenates every generated client output PLUS the one
# hand-written classic shim, public/js/10-boot.js — the only public/ file the
# builder needs from git (everything else in public/js is regenerated from src/client).
COPY public/js/10-boot.js ./public/js/10-boot.js
# NO tsbuildcache mount here. tsc is `incremental` with tsBuildInfoFile under
# .tsbuildcache/. A persisted cache mount would carry that .tsbuildinfo across
# builds while `dist/` (in the image layer) starts fresh each time — so tsc,
# trusting the stale buildinfo, skips re-emitting "unchanged" files and ships a
# PARTIAL dist/ (missing e.g. dist/repo/exercises.js → runtime crash loop). A
# clean, full emit every build is deterministic and only costs ~5s of tsc.
RUN npm run build

# ---- production dependencies ----
# Keep package-lock.json in an install-only stage. The runtime needs package.json
# for the source-build version fallback, but it does not need the lockfile.
FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# All CLI logins persist under HOME, which is a mounted volume at runtime.
ENV HOME=/home/app
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git unzip util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --home-dir /home/app --uid 10001 --shell /bin/sh app

RUN mkdir -p /usr/local/lib/cairn
COPY scripts/install-agent-cli.mjs /usr/local/lib/cairn/install-agent-cli.mjs
COPY scripts/update-agent-clis.sh /usr/local/bin/cairn-update-agent-clis
COPY scripts/docker-entrypoint.sh /usr/local/bin/cairn-entrypoint
RUN chmod +x /usr/local/bin/cairn-update-agent-clis /usr/local/bin/cairn-entrypoint

COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/dist ./dist
# Copy only the static runtime shell, then overlay generated browser output from
# the builder. An accidentally-added public README/map/source file cannot enter
# the image through a broad directory copy.
COPY public/art.js public/favicon.ico public/index.html public/manifest.json public/styles.css public/sw.js ./public/
COPY public/icons ./public/icons
COPY public/vendor ./public/vendor
COPY --from=builder /app/public/cairn-body-figure.js ./public/cairn-body-figure.js
COPY --from=builder /app/public/js ./public/js
COPY seed-art ./seed-art
COPY agents.json ./

# Hand the writable areas to the unprivileged `app` user. Coaching CLIs are NOT
# baked into the image: Settings installs only selected tools under the mounted
# /home/app/.cairn-tools directory, alongside their persistent login state.
RUN mkdir -p /data \
 && chown -R app:app /app /data /home/app

# The exact release version, passed from the git tag by the release workflow so
# the in-app update check is precise even on the rolling :latest tag. Empty on a
# local/source build — version.ts then falls back to package.json. A non-version
# value (e.g. a branch name on a dispatch build) is ignored by version.ts.
ARG CAIRN_VERSION=""
ARG CAIRN_BUILD_SHA=""
LABEL org.opencontainers.image.revision=${CAIRN_BUILD_SHA}

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    CAIRN_VERSION=${CAIRN_VERSION} \
    CAIRN_BUILD_SHA=${CAIRN_BUILD_SHA} \
    CAIRN_CLI_ROOT=/home/app/.cairn-tools \
    CAIRN_AGENT_CLI_MANIFEST=/app/agents.json \
    CAIRN_AGENT_CLI_MANAGER=/usr/local/lib/cairn/install-agent-cli.mjs \
    AGENT_CLI_UPDATE_SCRIPT=/usr/local/bin/cairn-update-agent-clis \
    NPM_CONFIG_PREFIX=/home/app/.cairn-tools \
    NPM_CONFIG_CACHE=/home/app/.cairn-tools/.npm-cache \
    PATH="/home/app/.cairn-tools/bin:/home/app/.local/bin:/home/app/.grok/bin:/home/app/.antigravity-ide/antigravity-ide/bin:/usr/local/bin:${PATH}"

VOLUME ["/data", "/home/app", "/home/app/.cairn-tools"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/health || exit 1

# Starts as root only to fix volume ownership, then drops to the `app` user.
ENTRYPOINT ["cairn-entrypoint"]
CMD ["node", "dist/server.js"]
