# Sharing Cairn

Cairn is easiest to share as a prebuilt Docker image — a single `docker run`, no clone. The lean
image contains Cairn, Node 24, and a verified per-provider installer manifest. It contains no
provider CLI, user credential, or shared AI subscription.

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
docker run -d --name cairn -p 127.0.0.1:8787:8787 \
  -v cairn-data:/data -v cairn-home:/home/app \
  -v cairn-tools:/home/app/.cairn-tools \
  --restart unless-stopped ghcr.io/zilet/cairn:latest
```

This default binds Cairn to loopback. Widen to your LAN, for example
`-p 8787:8787`, only behind a private network or VPN and with
`CAIRN_AUTH_TOKEN` set.

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

The build contains only Cairn and its runtime dependencies. Users install individual provider tools
from Settings if they need them. Then open `http://localhost:8787`. Source builds run `npm run build` inside Docker, including the
TypeScript browser-client build; the runtime image uses that generated `public/js` output rather
than any checked-in browser files.

## Ways To Run It

- **Occasional local container:** start Cairn on a laptop with
  `docker compose up -d`, use `http://localhost:8787`, and stop it when you are
  done.
- **Always-on home box / VM / Raspberry Pi:** keep the release compose running
  on a Docker host and access it from devices on the same LAN, VPN, or tailnet.
- **Household members:** run the same released image as a separate Compose
  project per person, with distinct volumes, tokens, and HTTPS origins. Follow
  [`HOUSEHOLDS.md`](HOUSEHOLDS.md); the in-app Family roster is context, not an account.
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

Cairn's background scheduler follows the last valid IANA timezone reported by the PWA. Users who want a
different first-boot fallback should create a `.env` next to `docker-compose.yml`, for example:

```env
TZ=Europe/London
```

## Persistent State

Cairn uses three named Docker volumes:

| Volume | Mounted at | Contents |
|---|---|---|
| `cairn-data` | `/data` | SQLite DB, uploads, generated art cache |
| `cairn-home` | `/home/app` | CLI login state such as `~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok` |
| `cairn-tools` | `/home/app/.cairn-tools` | Optional provider binaries; safe to recreate and reinstall |

Updating the image does not remove these volumes.

## CLI Logins

Each user logs into their own provider accounts. The simplest path is **in the app**: open
**Settings → Agents**, tap **Install**, then **Connect** — a terminal opens in the browser and runs that
CLI's sign-in (the server spawns the login as itself, so the token lands where it's read; no `-u app`
needed). The card shows **✓ Connected** when done, and an unconnected agent is automatically kept out of
the rotation.

For the default instance, a terminal login is one `docker exec` (household
instances use their configured `CAIRN_CONTAINER_NAME`):

```bash
docker exec -u app -it cairn claude auth login   # Claude Code — OAuth/device-code prompt
docker exec -u app -it cairn codex login --device-auth  # Codex — ChatGPT device login
docker exec -u app -it cairn agy                 # Antigravity (Google) — paste the code quickly
docker exec -u app -it cairn grok login --device-auth   # Grok — device login (or set XAI_API_KEY)
```

Pick **one** to start; the login persists in the `cairn-home` volume. Always use `-u app` here — a login
written as root is invisible to the server process. The app also has an offline `stub` agent for
smoke tests. (If you started Cairn via `docker compose`, `docker compose exec …` is equivalent.)

## Updating Cairn

Cairn checks for new releases for you. A quiet daily background check compares your running
version against the latest published release and surfaces the result under **Settings → Data
→ Cairn version** — "up to date" or "vX.Y.Z is available" with a *What's new* link and the
exact update commands. It is pull, never push: nothing notifies you, and it sends only an
anonymous request (no data leaves your instance). One toggle ("Check for new Cairn releases")
disables it entirely.

When an update is available, back up first (Settings → Data → **Download SQLite snapshot**),
then refresh the release Compose file, pull the new pinned image, and restart —
your `.env` and Docker volumes remain untouched, and schema migrations run automatically on boot:

```bash
curl -fsSLo docker-compose.yml.new \
  https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
docker compose pull
docker compose up -d
```

Started with the one-line `docker run`? Pull `ghcr.io/zilet/cairn:latest` and recreate the
container. Building from source? `git pull && docker compose up -d --build`.

## Updating CLI Tools

The image installs no provider CLI. Install or update one provider from its Settings → Agents card;
the exact package pin or verified vendor installer comes from the bundled manifest. Shell users name
the providers explicitly:

```bash
docker exec -u app cairn cairn-update-agent-clis claude codex
```

Automatic CLI updates are opt-in and refresh installed tools only:

```env
AGENT_CLI_AUTO_UPDATE=1
AGENT_CLI_AUTO_UPDATE_INTERVAL_HOURS=168
```

Only enable automatic updates on a trusted local or tailnet deployment because it
runs vendor installer scripts inside the container.

Antigravity and Grok installs fail closed if the downloaded vendor script no longer
matches the audited checksum. There is no unverified-install override.

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
- Run `npm run verify` before tagging.
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
