# Deployment Guide

Practical shapes for running Cairn on a network you trust: laptop, home server, VM, or
Raspberry Pi behind **Tailscale** (or another VPN). Cairn is single-user with no built-in
auth — see [`SECURITY.md`](../SECURITY.md).

**New here?** Run `./quickstart.sh` from the repo root — it detects Docker or Node and has you
running in ~30 seconds. For Raspberry Pi, use `./scripts/quickstart-rpi.sh` instead.

---

## Recommended posture

| Layer | Recommendation |
|---|---|
| **Network** | Tailscale tailnet, home LAN, or localhost — not a public IP |
| **Port** | `8787` published only to trusted interfaces |
| **Auth** | `CAIRN_AUTH_TOKEN` when any device beyond loopback can reach the port |
| **HTTPS** | Tailscale Serve or a private reverse proxy — required for installable/offline PWA |
| **Backups** | `cairn-data` + `cairn-home` volumes regularly |

---

## Shape 1 — Docker on any host (simplest)

```bash
docker compose up -d --build
```

Or use the [release compose](SHARING.md) without a source checkout.

Persistent state:

| Volume | Contents |
|---|---|
| `cairn-data` | SQLite DB, uploads, art cache |
| `cairn-home` | CLI logins (`~/.claude`, `~/.codex`, `~/.gemini`, …) |

Set timezone in `.env` so the weekly auto-coach fires at the right local hour:

```env
TZ=Europe/Belgrade
```

---

## Shape 2 — Tailscale / MagicDNS

1. Install [Tailscale](https://tailscale.com) on the Docker host and your phone/laptop.
2. Run Cairn with `docker compose up -d`.
3. Open `http://<hostname>:8787` using the node's MagicDNS name (e.g. `http://pi:8787`).

Every device on the tailnet can reach Cairn without port-forwarding or managing certificates
for basic HTTP use.

### HTTPS + installable PWA (recommended)

Browsers only register the service worker on secure origins. **Tailscale Serve** terminates
HTTPS on the node's MagicDNS name — **tailnet-only** (not Funnel; nothing hits the public
internet):

```bash
# On the host (once; admin may need to enable Serve in the tailnet console first)
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open **`https://<your-node>.<tailnet>.ts.net/`** from any signed-in device. On iOS:
Share → *Add to Home Screen* for a proper offline-capable PWA.

Turn off Serve:

```bash
sudo tailscale serve --https=443 off
```

Serve config survives reboots; compose keeps publishing `:8787` on the host.

### Optional shared token

In `.env` next to `docker-compose.yml`:

```env
CAIRN_AUTH_TOKEN=your-long-random-string
```

The PWA prompts once and stores the token. MCP/API clients send `Authorization: Bearer …`.

---

## Shape 3 — Raspberry Pi (always-on home box)

The Pi is a common always-on target. Host Node is often older than 24; **use Docker** so the
container bundles Node 24 and the coaching CLIs without upgrading the host.

The fastest path uses the dedicated setup script, which handles Docker install (with consent
prompt), arm64 detection, and low-memory/swap guidance:

```bash
git clone https://github.com/zilet/cairn.git ~/cairn
cd ~/cairn
./scripts/quickstart-rpi.sh
```

From there, the normal daily-driver setup is:

1. Install Tailscale on the Pi and on your phone/laptop.
2. Set `TZ` in `.env`.
3. Set `CAIRN_AUTH_TOKEN` in `.env` if any device beyond the Pi can reach Cairn.
4. Restart with `docker compose up -d`.
5. Put HTTPS in front with Tailscale Serve for an installable PWA.

Example `.env`:

```env
TZ=Europe/London
CAIRN_AUTH_TOKEN=use-a-long-random-string
```

Example HTTPS command:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open `https://<pi-name>.<tailnet>.ts.net/` from a signed-in device. On iOS, Share -> Add to
Home Screen installs the PWA.

Or manually:

```bash
# On the Pi (first time): install Docker via get.docker.com, add your user to docker group
git clone https://github.com/zilet/cairn.git ~/cairn
cd ~/cairn
cp .env.example .env   # edit TZ, optional CAIRN_AUTH_TOKEN
docker compose up -d --build
```

First build takes a few minutes (CLIs bake into the image). Later rebuilds are fast thanks to
BuildKit layer caching.

### Mac → Pi rsync deploy (optional pattern)

Some operators keep a private `deploy-rpi.sh` that rsyncs a dev checkout to the Pi over SSH
on the tailnet and rebuilds — no registry required. That script is intentionally **not** in
the public repo (lives under `.local/scripts/` in a personal checkout). The equivalent manual
steps:

```bash
rsync -av --exclude node_modules --exclude data --exclude .git ./ user@pi:~/cairn/
ssh user@pi 'cd cairn && docker compose up -d --build'
```

### Pi HTTPS

Same Tailscale Serve one-liner as Shape 2. Prefer the `https://…ts.net` URL over raw
`http://100.x.x.x:8787` for PWA install.

### Pi coaching login

Easiest is **in the app — Settings → Agents → Connect** (a terminal opens in the
browser and signs you in). From a shell on the Pi it's one `docker compose exec`:

```bash
ssh user@pi
cd cairn
docker compose exec -u app -it cairn claude auth login   # or: codex login · agy · grok login --device-auth
```

Always **`-u app`** for new logins — a login written as root is invisible to the
server process.

---

## Shape 4 — Cloud VM (private only)

Use a VM when you want Cairn reachable while away from home but do not want to maintain hardware.
Start small: **1-2 vCPU, 1-2 GB RAM, 10+ GB disk** is enough for a personal instance. Docker keeps
the Node 24 requirement inside the container.

Do **not** bind `8787` to a public cloud interface. Options:

- Run Tailscale on the VM; access via MagicDNS only
- Bind compose to loopback: `"127.0.0.1:8787:8787"` and SSH tunnel or Tailscale Serve
- Put an authenticated reverse proxy in front with `CAIRN_AUTH_TOKEN`

### Example: Ubuntu VM + Tailscale

After SSHing into a fresh Ubuntu VM:

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker

# Private network
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Cairn
git clone https://github.com/zilet/cairn.git ~/cairn
cd ~/cairn
cp .env.example .env
```

Edit `.env`:

```env
TZ=America/New_York
CAIRN_AUTH_TOKEN=use-a-long-random-string
```

Start and verify:

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/api/health
```

Access from a signed-in tailnet device:

```text
http://<vm-tailnet-name>:8787
```

For HTTPS/PWA install:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open:

```text
https://<vm-name>.<tailnet>.ts.net/
```

### Example: VM via SSH tunnel only

If you do not want a tailnet, keep the compose port bound to loopback and tunnel it:

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

Then from your laptop:

```bash
ssh -L 8787:127.0.0.1:8787 user@your-vm
```

Open `http://localhost:8787` locally. This is fine for desktop use, but the phone PWA is easier with
Tailscale Serve.

---

## Backups

### API export (while running)

```bash
curl -fsS http://localhost:8787/api/export    -o cairn-export.json
curl -fsS http://localhost:8787/api/export/db -o cairn-snapshot.db
```

Also available from **Settings** in the PWA.

A ready-to-cron wrapper that pulls both formats and rotates old copies ships in the
repo: [`scripts/backup-example.sh`](../scripts/backup-example.sh) — copy it, set
`CAIRN_URL` / `CAIRN_TOKEN` / `BACKUP_DIR` / `KEEP`, and schedule it.

### Volume backup (Docker host)

```bash
docker run --rm -v cairn-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/cairn-data-$(date +%F).tgz -C /data .
docker run --rm -v cairn-home:/home -v "$PWD":/backup busybox \
  tar czf /backup/cairn-home-$(date +%F).tgz -C /home .
```

### Cron example (weekly, on the Pi/host)

```bash
0 3 * * 0 curl -fsS -H "X-Cairn-Token: $TOKEN" https://pi.example.ts.net/api/export/db -o /backups/cairn-$(date +\%F).db
```

Restore steps: [`OPERATIONS.md`](OPERATIONS.md).

---

## Updates

```bash
git pull && docker compose up -d --build
```

Schema migrations run automatically on boot (`PRAGMA user_version`). CLI tools can be refreshed
without rebuilding:

```bash
docker compose exec -u app cairn cairn-update-agent-clis
```

Or **Settings → Agents → Update CLI tools**.

Force fresh CLI install on image rebuild:

```bash
AGENT_CLI_CACHE_BUST=$(date +%s) docker compose build cairn && docker compose up -d
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Health never green | `docker compose logs --tail=120 cairn` |
| Coaching uses stub only | No CLI logged in — Settings → Agents → Connect, or `docker compose exec -u app -it cairn claude auth login` |
| PWA won't install offline | Need HTTPS (Tailscale Serve) |
| Permission denied on docker | New SSH session after `usermod -aG docker`, or use `sudo` |
| Out of disk | `docker system prune -af` (named volumes untouched) |
| Wipe by accident | `docker compose down -v` **deletes** `cairn-data` and `cairn-home` |

---

## Related docs

- [`QUICKSTART.md`](QUICKSTART.md) — 30-second first run (one-command `./quickstart.sh`)
- [`../quickstart.sh`](../quickstart.sh) — auto-detects Docker or Node 24, starts and validates
- [`../scripts/quickstart-rpi.sh`](../scripts/quickstart-rpi.sh) — Raspberry Pi setup script
- [`OPERATIONS.md`](OPERATIONS.md) — migrations, restore, rollback
- [`SHARING.md`](SHARING.md) — GHCR release image
- [`GARMIN.md`](GARMIN.md) — optional wearable sync
