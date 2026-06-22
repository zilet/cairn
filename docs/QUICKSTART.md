# Quick Start

Cairn ships as one published Docker image. **Start at the top — it's a single command.** Read on
only if you want to configure it, build from source, or run it somewhere other than this machine.

> **No install at all?** Open Cairn in a free cloud sandbox right from your browser —
> [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/zilet/cairn)
> — it boots a real Cairn with demo data, nothing on your machine. Great for a first look; see
> [`docs/SANDBOX.md`](SANDBOX.md) for Gitpod / Daytona and how to keep data. Self-host (below) when
> you want it on your phone for daily use.

## 1 · Run it — 30 seconds, no clone

Pull the published multi-arch image (amd64 + arm64) and run it. No source, no compose file, no Node
on the host:

```bash
docker run -d --name cairn -p 127.0.0.1:8787:8787 \
  -v cairn-data:/data -v cairn-home:/home/app \
  --restart unless-stopped ghcr.io/zilet/cairn:latest
```

Open **http://localhost:8787** — you land on the Brief. That's the whole install.

This binds Cairn to this computer only. Widen to your LAN, for example
`-p 8787:8787`, only on a private network and with `CAIRN_AUTH_TOKEN` set.

- **Your data survives updates.** `cairn-data` holds the SQLite DB and `cairn-home` holds your CLI
  logins. To update: `docker pull ghcr.io/zilet/cairn:latest`, then `docker rm -f cairn` and re-run
  the command — both volumes persist.
- **Timezone:** add `-e TZ=Europe/Belgrade` (the weekly auto-coach uses the container's local time).
- **First paint is real with no agent.** The Brief, set logging, the plan editor, charts, and marker
  views all work immediately. The next step only adds the *conversational* layer.

Prefer an editable config file over a long command line? Use the
[compose file](#configure-with-a-compose-file) instead — still no clone.

## 2 · Add a coaching agent — optional, for chat & drafts

Chat, coaching drafts, and meal-plan generation need one external agent. The CLIs are already baked
into the image, so you never install anything — you just log into **one** provider.

**Easiest — log in from the app (no terminal).** Open **Settings → Agents**, pick a provider, and tap
**Connect**. A live terminal opens right in the browser and walks you through that CLI's sign-in
(claude / codex / antigravity / grok); follow the prompts — if a URL and a code appear, open the URL to
authorize. The login is written by the server process itself, so it lands in the right place
automatically and persists across restarts/updates. Once it shows **✓ Connected**, that agent joins the
rotation — and an agent you haven't connected is automatically kept out of it (so it never fails a
request). Each card also shows the CLI's version and the model it's currently using.

**Or from a terminal** (handy for scripting, or if you prefer): the container is named `cairn`, so it's
one `docker exec` per provider —

```bash
docker exec -u app -it cairn claude auth login   # Claude Code  — OAuth/device-code prompt
docker exec -u app -it cairn codex login         # Codex        — ChatGPT login
docker exec -u app -it cairn agy                 # Antigravity  — Google sign-in (paste the code quickly)
docker exec -u app -it cairn grok login          # Grok         — device login (or use XAI_API_KEY)
```

Always use `-u app` here — the server runs as that user, so a login written as root is invisible to it.
(The in-app **Connect** flow above avoids this gotcha entirely.)

- **No subscription handy?** The built-in **`stub`** agent returns a canned demo proposal so you can
  click through the propose→apply UI offline — it is not a coach; connect a real agent above for that.
- **Grok via API key** (instead of the interactive login): add `-e XAI_API_KEY=xai-…` to the
  `docker run` command and re-create the container.
- Running on Node, or want the streaming / auth-directory detail? See
  [Connect your first agent](#connect-your-first-agent).

### What works out of the box vs. what needs a coaching agent

Cairn is fully usable the moment it boots — no agent, no API key. A coaching agent adds the
conversational and generative layer, and the app stays useful while you set one up.

| Works out of the box (no agent) | Needs a logged-in coaching agent |
|---|---|
| The Brief (rest/easy/train suggestion) | The agentic Brief sentence on top |
| Logging, history, PRs, est-1RM | Coach **chat** |
| The plan editor | Plan & meal **drafting** (propose → review → apply) |
| Bodyweight chart, goal feasibility | Health-review **narrative** |
| Marker extraction & optimal-zone trends | Quiet **insights** / weekly read |
| Recovery view, deterministic TDEE | Recipe generation, single-meal swaps |

A **coaching agent** means one of the supported CLIs — **Claude Code**, **Codex**,
**Antigravity**, or **Grok** — installed on the host **and logged in** with your own account.
There is no shared key or built-in model; each provider needs its own CLI and login. The built-in
`stub` agent exercises the same propose/apply loop offline with no key.

## Going deeper

Everything above is all most people need. These are the options for configuring it, building from
source, or running it on Node — reach for them only when you want to.

### Configure with a compose file

Prefer a file you can edit over a long `docker run`? The release compose has `TZ`,
`CAIRN_AUTH_TOKEN`, the agent keys, and a loopback-safe port binding already wired up — still no
clone:

```bash
mkdir cairn && cd cairn
curl -LO https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml
docker compose up -d
```

Put `TZ` / `CAIRN_AUTH_TOKEN` / `XAI_API_KEY` / `GEMINI_API_KEY` in a `.env` next to it and re-run
`docker compose up -d`. Agent logins are identical — `docker exec -u app -it cairn …` (the
`docker compose exec …` form works too).

### Build from source (to develop or change the code)

```bash
git clone https://github.com/zilet/cairn.git
cd cairn
./quickstart.sh                 # guided: detects Docker or Node 24, seeds, prints the URL
```

`./quickstart.sh` creates `.env` from `.env.example`, starts Cairn, waits for `/api/health`, and
prints the URL. To drive Docker yourself instead of the script:

```bash
cp .env.example .env            # edit TZ at minimum
docker compose up -d --build    # first build bakes the CLIs in (~minutes); rebuilds are cached
```

### Run on Node, without Docker

**Requires Node 24** — Cairn uses `node:sqlite`, unflagged only in 24+:

```bash
git clone https://github.com/zilet/cairn.git
cd cairn
npm install
npm run dev                     # tsx watch — auto-seeds on first boot
```

Open **http://localhost:8787** (the DB lands at `./data/cairn.db`). For a production-style local run:
`npm run build && npm start`.

---

## Where to run it

Most people start by running Cairn on their **own computer** (laptop or desktop).  
Later they often move the same container to a small always-on machine:

- Raspberry Pi or mini-PC at home
- Cheap cloud VM (kept private)
- NAS, old desktop, etc.

| Goal | Start here |
|------|------------|
| Try it right now on this computer | [Run it](#1--run-it--30-seconds-no-clone) (one `docker run`) |
| Daily use from your phone | Same image + Tailscale (works on laptop first, then Pi/VM) |
| Always-on private box | Raspberry Pi section below or Small VM |
| Quick evaluation (no long-term host) | [`SANDBOX.md`](SANDBOX.md) |

**Tailscale is the winner** for reaching your phone cleanly with a proper installable PWA (HTTPS, works from anywhere on your tailnet, no port forwarding).

See the phone instructions that are printed after `quickstart.sh` or the release compose starts. The same steps apply whether you are running on your laptop today or a Pi/VM later.

---

## Moving to an always-on host (Pi, mini-PC, or small VM)

The fastest start is on whatever computer you're using right now. When you want Cairn
running 24/7 so your phone can reach it easily, move the exact same image to a small
always-on box.

### Raspberry Pi / similar

Use the helper script:

```bash
git clone https://github.com/zilet/cairn.git
cd cairn
./scripts/quickstart-rpi.sh
```

It handles Docker install (with your consent), arm64 notes, and swap guidance.

The phone path is the same as on a laptop: install Tailscale on the host and your phone,
run the `tailscale serve` line that the script prints, and add the HTTPS MagicDNS URL
to your home screen.

See the printed instructions after startup (or the "Phone & PWA access" card in Settings)
for the exact current command. The same Tailscale recipe works for a Pi, a mini-PC,
or a cheap cloud VM.

Recommended first `.env` edits for any always-on host:

```env
TZ=Europe/London
CAIRN_AUTH_TOKEN=long-random-string-if-other-devices-can-reach-it
```

Then `docker compose up -d`.

Backups, updates, and restore live in [`DEPLOYMENT.md`](DEPLOYMENT.md) and
[`OPERATIONS.md`](OPERATIONS.md).

---

## Small VM (private online box)

Use this when you want Cairn available away from home without maintaining hardware. A tiny Ubuntu
VM is enough for personal use; start with roughly **1-2 vCPU, 1-2 GB RAM, and 10+ GB disk**.

Keep the VM private:

- Join the VM and your devices to Tailscale/WireGuard.
- Do **not** open inbound firewall access to `8787` from the public internet.
- Set `CAIRN_AUTH_TOKEN` because a VM is usually reachable by more than one device.

Example from a fresh Ubuntu VM after SSH login:

```bash
# 1) Install Docker if the image does not include it already.
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker

# 2) Install Tailscale, then join your tailnet.
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 3) Run Cairn.
git clone https://github.com/zilet/cairn.git ~/cairn
cd ~/cairn
cp .env.example .env
```

Edit `.env`:

```env
TZ=America/New_York
CAIRN_AUTH_TOKEN=use-a-long-random-string
```

Start it:

```bash
docker compose up -d --build
docker compose logs --tail=60 cairn
```

Private access options:

```bash
# Browser from any signed-in tailnet device:
http://<vm-tailnet-name>:8787

# Installable/offline PWA over HTTPS:
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Then open `https://<vm-name>.<tailnet>.ts.net/`. If you prefer an SSH tunnel instead of Tailscale:

```bash
ssh -L 8787:127.0.0.1:8787 user@your-vm
```

Then open `http://localhost:8787` on your laptop.

---

## Open the Brief

Once Cairn is running (on your laptop, a Pi, or a VM):

1. Open **http://localhost:8787** (or the host's address) — you land on the **Today** tab and
   the Brief reads your day immediately. It is a real, calm suggestion (rest / easy / train)
   based on what it knows so far.
2. To put it on your phone, run **`./scripts/setup-phone.sh`** — it detects your exact private
   `https://…ts.net` URL via Tailscale Serve, enables it (with your consent), and prints the
   Add-to-Home-Screen steps. Settings → "Phone & PWA access" also shows the command and can
   generate a token.
3. Tap an override chip ("rough night", "give me an easy day") if you want to steer the Brief.
4. Log something (a set or bodyweight) so the charts start filling in with your data.
5. **Me → Profile** — replace the demo profile with your real weight, goal, etc.

**Phone / home screen app:** Tailscale **Serve** + "Add to Home Screen" is the supported path —
tailnet-only, a real offline-capable PWA, nothing on the public internet. The Brief and logging
work the moment Cairn is running; phone setup and agents are completely optional at first.

The plan editor, history, PRs, and connected brain (markers, recovery, directives) all work with
no agent. Chat and draft proposals need one.

### First 10 minutes

1. **Me -> Profile:** replace the seeded example profile with your real weight, goal, training
   age, and any constraints.
2. **Today:** log one set or one bodyweight entry so the charts have your first real point.
3. **Settings -> Agents:** enable `stub` if you want to see the draft/apply workflow with no login.
4. **Settings -> Export:** download a JSON or DB backup once you start entering real data.

After that, connect a real agent when you want chat, meal plans, and adaptive coaching drafts.

---

## Connect your first agent

Coaching drafts, chat, and meal plans need one external agent. Choose one:

| Agent | Auth |
|---|---|
| `claude` | Claude Code — Anthropic Pro/Max subscription (CLI **login**, not an env key) |
| `codex` | Codex — ChatGPT subscription (CLI **login**, not an env key) |
| `antigravity` | Antigravity (`agy`) — Google account (CLI **login**) |
| `grok` | Grok Build — SuperGrok / X Premium+ (headless coaching uses `XAI_API_KEY` in `.env`) |
| `stub` | Built-in offline stub — no key, no login, exercises the propose/apply loop |

> `claude`/`codex`/`antigravity` authenticate through the CLI's own subscription login directory —
> `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the environment are **not** the coaching path for them.
> Only **Grok headless** reliably uses an API key. `GEMINI_API_KEY` is for generated artwork only,
> not coaching.

**The easiest path is in the app.** **Settings → Agents → Connect** opens a terminal in the browser
and runs the sign-in for you — no `docker exec`, no `-u app` to remember (see
[step 2](#2--add-a-coaching-agent--optional-for-chat--drafts)). The sections below are the terminal /
Node / streaming reference, for scripting or when you prefer a shell.

### Docker: log in inside the container

The container is named `cairn` whether you started it with `docker run` or compose, so the same
`docker exec` command works either way. Each command opens that provider's sign-in flow (a URL +
code you complete in a browser); you log in **once** per provider and the `cairn-home` volume keeps
it across restarts and image updates. Always use `-u app` — the server runs as the `app` user, so
logins written as root are invisible to it.

```bash
docker exec -u app -it cairn claude auth login   # Claude Code — OAuth/device-code prompt
docker exec -u app -it cairn codex login         # Codex — ChatGPT login
docker exec -u app -it cairn agy                 # Antigravity (Google) — paste the code quickly (~30s)
docker exec -u app -it cairn grok login          # Grok — interactive login (or use XAI_API_KEY, below)
```

After logging in, enable that agent in **Settings → Agents** and tap **Draft plan update** to test
it. You only need **one** to unlock chat, drafts, and meal plans; add more later for the rotation.

> Started with the source checkout via `docker compose`? `docker compose exec -u app -it cairn …`
> is equivalent — but the `docker exec` form above works for both, so prefer it.

**Grok via API key instead of an interactive login.** Grok headless can read `XAI_API_KEY` rather
than the `grok` login. With the bare `docker run`, pass it on the command and re-run:

```bash
docker rm -f cairn
docker run -d --name cairn -p 127.0.0.1:8787:8787 \
  -v cairn-data:/data -v cairn-home:/home/app \
  -e XAI_API_KEY=xai-... \
  --restart unless-stopped ghcr.io/zilet/cairn:latest
```

With the compose path, put `XAI_API_KEY=…` in the `.env` next to `docker-compose.yml` instead and
`docker compose up -d`. (`GEMINI_API_KEY` for generated **artwork** — not coaching — is provided the
same way: `-e` on `docker run`, or `.env` for compose.)

### Local Node: log in on the host

The coaching CLIs run as the same user as `npm start`, so a normal login on the host suffices:

```bash
claude        # Anthropic OAuth / login
codex login   # ChatGPT
agy           # Google
```

### Enable and test the agent

Open **Settings → Agents**, enable your provider, and tap **Draft plan update**. The proposal
appears in **Plan → Coach** for review; tap Apply to accept it.

To try the offline stub without any login:

1. **Settings → Agents** → enable `stub`
2. Tap **Draft plan update** — it returns a canned proposal instantly.

### Agent streaming

| Agent | Chat streaming |
|---|---|
| `claude` | Token-by-token (live delta) |
| `grok` | Token-by-token (live delta) |
| `codex` | One-shot (complete message) |
| `antigravity` | One-shot headless |
| `stub` | Offline only |

Google is transitioning **Gemini CLI → Antigravity CLI**; Cairn uses `agy` for the Google path.

---

## Try the demo persona

Populate fictional data (great for screenshots and exploration):

```bash
docker exec -u app cairn npm run seed:demo
# or, from a source checkout running on Node:
npm run seed:demo
```

---

## Connect MCP (optional)

From a machine that can reach Cairn:

```bash
claude mcp add --transport http cairn http://localhost:8787/mcp
```

If `CAIRN_AUTH_TOKEN` is set, add `?token=…` or send `Authorization: Bearer …`.

---

## Security reminder

Cairn has **no built-in auth by default**. Run it on localhost, a LAN, or a private tailnet —
never expose port `8787` to the public internet without setting `CAIRN_AUTH_TOKEN` and HTTPS.
See [`SECURITY.md`](../SECURITY.md).

---

## Next steps

- [`DEPLOYMENT.md`](DEPLOYMENT.md) — Tailscale, HTTPS PWA install, backups
- [`OPERATIONS.md`](OPERATIONS.md) — updates, migrations, restore
- [`VISION.md`](VISION.md) — product constitution
- [`GARMIN.md`](GARMIN.md) — optional Garmin Connect sync
