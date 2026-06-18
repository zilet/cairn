# Sharing Cairn

Cairn is easiest to share as a prebuilt Docker image — a single `docker run`, no clone. The image
contains the app, Node 24, and the supported CLI runners. It does not contain user credentials or a
shared AI subscription.

## What Users Need

- Docker (Compose optional — the one-line `docker run` below does not need it).
- A private place to run it: localhost, a home server, a Raspberry Pi, Tailscale,
  MagicDNS, WireGuard, a VPN, or another trusted network.
- Optional subscriptions/logins for Claude Code, Codex, Antigravity, or Grok.

Cairn has no built-in user authentication. Do not expose it directly to the
public internet. If another device can reach the port, set `CAIRN_AUTH_TOKEN`
or put an authenticated private-network layer in front of it.

## Install From The Published Image (Recommended — No Clone)

A multi-arch image (amd64 + arm64) is published to GHCR with every tagged release, so most people
never touch the source. Shortest path — one `docker run`, no compose file:

```bash
docker run -d --name cairn -p 8787:8787 \
  -v cairn-data:/data -v cairn-home:/home/app \
  --restart unless-stopped ghcr.io/zilet/cairn:latest
```

Or use the release compose file (env vars + loopback-safe port binding already wired up):

```bash
mkdir cairn
cd cairn
curl -LO https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml
docker compose up -d
```

The compose file attached to a release already points at that release's GHCR image tag. Either way,
then open:

```text
http://localhost:8787
```

For a server on your LAN or tailnet, replace `localhost` with that host name or private IP.

> If anonymous `docker pull` ever returns `401`/`403`, the GHCR package visibility has regressed to
> private (the package's GHCR page → Package settings → Danger Zone → Change visibility) — use the
> build-from-source path below until it is public again. See the **Maintainer release checklist**.

## Install By Building From Source

Only needed to develop or change the code — it builds the image locally instead of pulling it:

```bash
git clone https://github.com/zilet/cairn.git
cd cairn
docker compose up -d --build
```

The first build bakes the coaching CLIs in and takes a few minutes; later rebuilds are fast. Then
open `http://localhost:8787`.

## Ways To Run It

- **Occasional local container:** start Cairn on a laptop with
  `docker compose up -d`, use `http://localhost:8787`, and stop it when you are
  done.
- **Always-on home box / VM / Raspberry Pi:** keep the release compose running
  on a Docker host and access it from devices on the same LAN, VPN, or tailnet.
- **Tailscale / MagicDNS:** join the host to a tailnet and use its MagicDNS name
  from your phone or laptop. For an installable offline PWA, put HTTPS in front
  of Cairn with Tailscale Serve or another private reverse proxy.
- **Cloud VM:** the release compose binds `8787` to **loopback only by default**
  (`127.0.0.1:8787:8787`), so a fresh VM is not exposed even with auth off. Reach
  it through Tailscale Serve (recommended), a VPN, an SSH tunnel, or an
  authenticated reverse proxy. Only widen the binding once `CAIRN_AUTH_TOKEN` is
  set — never leave `8787` open to the public internet.

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

Each user logs into their own provider accounts inside the container. The container is named
`cairn` whichever way you started it (`docker run` or compose), so `docker exec` works in both:

```bash
docker exec -u app -it cairn claude        # Claude Code — OAuth/device-code prompt
docker exec -u app -it cairn codex login   # Codex — ChatGPT login
docker exec -u app -it cairn agy           # Antigravity (Google) — paste the code quickly
docker exec -u app -it cairn grok          # Grok — interactive login (or set XAI_API_KEY)
```

Pick **one** to start; the login persists in the `cairn-home` volume. Always use `-u app` — a login
written as root is invisible to the server process. The app also has an offline `stub` agent for
smoke tests. (If you started Cairn via `docker compose`, `docker compose exec …` is equivalent.)

## Updating CLI Tools

The image installs the latest supported CLIs when it is built. On a long-running
host, update them from Settings -> Agents -> Update CLI tools, or run:

```bash
docker exec -u app cairn cairn-update-agent-clis
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
git tag v0.4.0
git push origin v0.4.0
```

It publishes:

```text
ghcr.io/zilet/cairn:v0.4.0
ghcr.io/zilet/cairn:latest
```

For a public repository, make sure the package visibility in GitHub Container
Registry is public if users should pull without authentication.

## Maintainer Release Checklist

Until these steps are done, **the prebuilt-image path 401s for strangers** — only the
build-from-source path works. This checklist is the owner's action; it cannot be done from
inside the codebase.

- Publish from a source tree that does not include private operator history.
  Personal deployment scripts, hostnames, backups, local videos, and private
  notes belong under `.local/`, which is ignored by Git and Docker.
- Keep `.env`, `data/`, SQLite files, exported archives, generated logs, and
  local backups out of Git. The committed `.gitignore` and `.dockerignore`
  already exclude those paths.
- Run `npm test` before tagging.
- Push a `v*` tag and wait for the release workflow to pass.
- **Make the GitHub repository public** (GitHub → repo → Settings → General →
  Danger Zone → Change visibility). This is a one-time owner action.
- **Make the GHCR package public** (GitHub → your packages → `cairn` → Package
  settings → Change visibility → Public) so the release compose can pull without
  a Docker login. A public repo does **not** automatically make the package
  public.
- **Re-verify the anonymous path** from a clean machine or a fresh shell with no
  GitHub/Docker credentials: download the release `docker-compose.yml`, run
  `docker compose up -d`, and confirm `http://localhost:8787/api/health` returns
  `{"ok":true}`. Only after this passes should the README/QUICKSTART
  prebuilt-image command be presented as the easy default.
