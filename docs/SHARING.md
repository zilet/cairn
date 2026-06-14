# Sharing Cairn

Cairn is easiest to share as a prebuilt Docker image plus a small Compose file.
The image contains the app, Node 24, and the supported CLI runners. It does not
contain user credentials or a shared AI subscription.

## What Users Need

- Docker with Compose.
- A private place to run it: localhost, a home server, a Raspberry Pi, Tailscale,
  VPN, or another trusted network.
- Optional subscriptions/logins for Claude Code, Codex, Antigravity, or Grok.

Cairn has no built-in user authentication. Do not expose it directly to the
public internet.

## Install From A Published Image

Download the release compose file:

```bash
mkdir cairn
cd cairn
curl -LO https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml
docker compose up -d
```

The compose file attached to a release already points at that release's GHCR
image tag.

Then open:

```text
http://localhost:8787
```

For a server on your LAN or tailnet, replace `localhost` with that host name or
private IP.

## Timezone

The release compose defaults to:

```env
TZ=America/New_York
```

The weekly auto-coach scheduler uses the container's local time. Users in another
timezone should create a `.env` next to `docker-compose.yml`, for example:

```env
TZ=Europe/Belgrade
```

## Persistent State

Cairn uses two named Docker volumes:

| Volume | Mounted at | Contents |
|---|---|---|
| `cairn-data` | `/data` | SQLite DB, uploads, generated art cache |
| `cairn-home` | `/home/app` | CLI login state such as `~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok` |

Updating the image does not remove either volume.

## CLI Logins

Each user logs into their own provider accounts inside the container:

```bash
docker compose exec -it cairn claude
docker compose exec -it cairn codex login
docker compose exec -it cairn agy
docker compose exec -it cairn grok
```

The app also has an offline `stub` agent for smoke tests.

## Updating CLI Tools

The image installs the latest supported CLIs when it is built. On a long-running
host, update them from Settings -> Agents -> Update CLI tools, or run:

```bash
docker compose exec cairn cairn-update-agent-clis
```

Automatic CLI updates are available but opt-in:

```env
AGENT_CLI_AUTO_UPDATE=1
AGENT_CLI_AUTO_UPDATE_INTERVAL_HOURS=168
```

Only enable automatic updates on a trusted local or tailnet deployment because it
runs vendor installer scripts inside the container.

## Publishing Images

The GitHub Actions workflow builds and pushes images to GitHub Container Registry
when a `v*` tag is pushed:

```bash
git tag v0.2.0
git push origin v0.2.0
```

It publishes:

```text
ghcr.io/zilet/cairn:v0.2.0
ghcr.io/zilet/cairn:latest
```

For a public repository, make sure the package visibility in GitHub Container
Registry is public if users should pull without authentication.
