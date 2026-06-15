# Sharing Cairn

Cairn is easiest to share as a prebuilt Docker image plus a small Compose file.
The image contains the app, Node 24, and the supported CLI runners. It does not
contain user credentials or a shared AI subscription.

## What Users Need

- Docker with Compose.
- A private place to run it: localhost, a home server, a Raspberry Pi, Tailscale,
  MagicDNS, WireGuard, a VPN, or another trusted network.
- Optional subscriptions/logins for Claude Code, Codex, Antigravity, or Grok.

Cairn has no built-in user authentication. Do not expose it directly to the
public internet. If another device can reach the port, set `CAIRN_AUTH_TOKEN`
or put an authenticated private-network layer in front of it.

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

## Ways To Run It

- **Occasional local container:** start Cairn on a laptop with
  `docker compose up -d`, use `http://localhost:8787`, and stop it when you are
  done.
- **Always-on home box / VM / Raspberry Pi:** keep the release compose running
  on a Docker host and access it from devices on the same LAN, VPN, or tailnet.
- **Tailscale / MagicDNS:** join the host to a tailnet and use its MagicDNS name
  from your phone or laptop. For an installable offline PWA, put HTTPS in front
  of Cairn with Tailscale Serve or another private reverse proxy.
- **Cloud VM:** bind the port to localhost or a private interface, then reach it
  through a VPN, tailnet, SSH tunnel, or an authenticated reverse proxy. Do not
  leave `8787` open to the public internet.

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
git tag v0.3.0
git push origin v0.3.0
```

It publishes:

```text
ghcr.io/zilet/cairn:v0.3.0
ghcr.io/zilet/cairn:latest
```

For a public repository, make sure the package visibility in GitHub Container
Registry is public if users should pull without authentication.

## Public Release Checklist

- Publish from a source tree that does not include private operator history.
  Personal deployment scripts, hostnames, backups, local videos, and private
  notes belong under `.local/`, which is ignored by Git and Docker.
- Keep `.env`, `data/`, SQLite files, exported archives, generated logs, and
  local backups out of Git. The committed `.gitignore` and `.dockerignore`
  already exclude those paths.
- Run `npm test` before tagging.
- Push a `v*` tag and wait for the release workflow to pass.
- Make the GitHub repository public only when intended.
- Make the GHCR package public if the release compose should work without a
  Docker login.
- Verify the anonymous path from a clean machine or fresh shell:
  download the release `docker-compose.yml`, run `docker compose up -d`, and
  confirm `http://localhost:8787/api/health` returns `{"ok":true}`.
