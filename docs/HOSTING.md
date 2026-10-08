# Run Cairn without being an engineer

**One command, two choices.** Paste this into a terminal (Terminal on a Mac, or any Linux shell):

```bash
curl -fsSL https://cairn.fit/install | sh
```

It asks one question:

```text
Where should Cairn live?
  1) In the cloud on Railway    (about $5/month, nothing to keep running)
  2) On this computer or server (free, private, needs to stay on)
```

Either way, the installer opens Cairn in your browser already signed in. You pair your phone from
**Settings → Devices → Pair a device** (a one-time code), and your access token is your recovery key.

All options run the same published image (`ghcr.io/zilet/cairn:latest`). Your data stays on
**your** Railway account or **your** hardware. The Cairn project hosts nothing and never sees your
data; the few things that do leave an install are listed in
[What leaves your install](#what-leaves-your-install).

| | 1) Railway | 2) This computer or server | No terminal: the Railway button | Manual Docker |
|---|---|---|---|---|
| **Start** | The one command | The one command | One click in the browser | One `docker run` |
| **Who runs the server** | Railway, on your account | You | Railway, on your account | You |
| **Where your data lives** | One Railway volume at `/data` | Docker volumes on that machine | One Railway volume at `/data` | Docker volumes on your machine |
| **Updates** | Railway Auto Updates (switched on for you), or `cairn.sh update` | Automatic, nightly, with rollback | Railway Auto Updates | `docker pull` and re-run |
| **Rough cost** | About $5/month on the Hobby plan. Check current pricing | Free on hardware you own (or what the VPS costs) | Same as Railway | Free |
| **Sign-in** | Opens signed in; token required | Opens signed in; token required | Token from Railway's Variables tab | Optional token on a trusted network |
| **Guide** | [Below](#1-railway) | [`INSTALL.md`](INSTALL.md) | [Below](#no-terminal-the-railway-button) | [`QUICKSTART.md`](QUICKSTART.md) |

The `cairn.fit/install` address serves [`deploy/install.sh`](../deploy/install.sh) from `main`, the
same file as `https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh`. To read it
before running it: `curl -fsSLO https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh`,
then `sh install.sh --dry-run` prints every step and changes nothing.

## Before you start: what you still need

- **An AI subscription, if you want the coach to talk.** Chat, adaptive coaching and meal ideas run
  through a coding-agent CLI you already pay for: Claude (Claude Code), ChatGPT (Codex), Google
  (Antigravity) or xAI (Grok). After Cairn is running, open **Settings → Agents** in your browser,
  tap **Install** on your provider, then **Connect** and follow its sign-in. Nothing to type in a
  terminal.
- **Nothing else.** Logging, the plan, charts, lab markers and the Brief all work without an agent.
  Exercise pictures come built in: a starter set of figures for the common movements, and a simple
  stand-in figure for the rest. The free exercise how-to library downloads itself in the background
  shortly after the first start. A Gemini key in **Settings** is optional; it adds a custom figure for
  each movement the starter set doesn't cover.

## 1) Railway

The installer is the main way onto Railway. Choose **1** at the prompt, or skip the question:

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --target=railway
```

Railway's free tier may pause your service, and its memory can be too small for the AI coach, so
the Hobby plan (about $5/month) is the recommended choice. Check Railway's current pricing before
you approve. A trial volume is 0.5 GB, enough for one AI provider; Hobby allows 5 GB, which you
set on the volume with **Live Resize** after upgrading (see [How much disk](#how-much-disk)).

What the installer does, in order:

1. **Gets the Railway CLI** if it is missing: `brew install railway` on a Mac with Homebrew,
   otherwise `npm i -g @railway/cli`, and Railway's official install script only if you agree.
2. **Signs you in to Railway.** Your browser opens; sign in or create an account (email or GitHub
   both work; Cairn needs no access to your GitHub).
3. **Creates a project** named after the instance (`cairn` by default; `--name=` changes it, and
   `--railway-project-name=` picks any other name). If you
   already have a project with that name, it asks before using it.
4. **Adds one service** from the published image, **one volume** at `/data`, the settings Cairn
   needs, a generated access token and settings key (sent to Railway on stdin, never on a command
   line), and a public `https://<name>.up.railway.app` address.
5. **Deploys** and follows the deployment. If it fails, it prints the last log lines (with your
   secrets removed) and stops.
6. **Opens Cairn in your browser, already signed in,** and prints your recovery key once.

Then answer a few onboarding questions, connect your AI in **Settings → Agents**, and pair your
phone from **Settings → Devices → Pair a device**.

The installer keeps a small folder, `~/.cairn/railway/cairn/`, with the project link and a copy of
itself. It holds no secrets: the token stays in Railway. Use it to manage the install:

```bash
sh ~/.cairn/railway/cairn/cairn.sh status      # deployment state and health
sh ~/.cairn/railway/cairn/cairn.sh open        # open Cairn signed in (a fresh one-time code)
sh ~/.cairn/railway/cairn/cairn.sh update      # redeploy from the newest image now
sh ~/.cairn/railway/cairn/cairn.sh logs        # recent logs
sh ~/.cairn/railway/cairn/cairn.sh uninstall   # delete the Railway project (asks for its name)
```

**Updates.** The installer switches on Railway's Image Auto Updates for you: they follow `:latest`
and install new releases in the Night window (02:00–06:00 UTC), the same setting the template uses.
To change the window or turn them off, open the service in Railway, then **Settings → Source → Auto
Updates**; a re-run of the installer keeps what you chose. `cairn.sh status` shows the current
setting. A new release can take a few hours to be noticed. Railway's own volume backup
before an update is a Pro plan feature, so Cairn takes its own restore point first: just before a
release changes the database it writes a snapshot to `/data/backups/`. See
[Automatic pre-migration snapshots](OPERATIONS.md#automatic-pre-migration-snapshots) for how to use
it.

**Your data** lives on the volume at `/data`: the database, uploads, your AI provider sign-ins and
the installed AI tools.

**What you agree to.** Railway runs the server, so your health data sits on their infrastructure
under their [terms](https://railway.com/legal/terms): you keep ownership, and they get a license
limited to storing and running it for you. Deleting the account deletes it. If you would rather no
company holds that data, choose option 2 and run Cairn on hardware you own.

## No terminal? The Railway button

[![Deploy on Railway](https://railway.com/button.svg)](https://cairn.fit/railway)

The button builds the same setup as option 1 from Railway's website, with nothing to install. It is
a convenience, not a dependency: the template behind it is declared in the repo
([`deploy/railway/template.json`](../deploy/railway/template.json)), and anyone can rebuild it into
their own Railway workspace with one command, `sh deploy/install.sh railway-template` (see
[`deploy/railway/README.md`](../deploy/railway/README.md)). `https://cairn.fit/railway` is a counted
redirect that the site maintainer points at whichever published template is current, so the button's
link never changes.

1. **Deploy.** Click the button and create a Railway account. The template creates one service with
   one volume at `/data`, a generated sign-in token and the settings Cairn needs.
2. **Updates are on.** The template switches on Railway's Auto Updates in the Night window
   (02:00–06:00 UTC). To change that, open the service's **Settings → Source → Auto Updates**.
3. **Wait until it is healthy,** then open the Railway URL for the service.
4. **Sign in.** Cairn asks for a token. Paste the value of `CAIRN_AUTH_TOKEN`, which you find in
   Railway under the service, then **Variables**. That token is also your recovery key.
5. **Onboarding, AI, phone.** Answer a few questions, connect your AI in **Settings → Agents**, and
   pair your phone from **Settings → Devices → Pair a device**.

## 2) This computer or server

Choose **2** at the prompt, or skip the question:

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --target=local
```

This runs Cairn with Docker or Podman on a Mac, a home server, a Raspberry Pi or a rented Linux
server. The installer sets up Docker if a Linux box has none (after asking), starts Cairn, turns on
automatic nightly updates with rollback, and opens Cairn signed in. To reach it from your phone,
add `--https=tailscale` (private) or `--https=caddy --domain=…` (public). Every option and the
`cairn.sh` commands are in [`docs/INSTALL.md`](INSTALL.md).

## Manual Docker

If you already run Docker, it is one command, and your data lives in named volumes on your machine.
Start with [`docs/QUICKSTART.md`](QUICKSTART.md). For a private network setup with HTTPS (such as
Tailscale), see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md). For updates, backups and restores, see
[`docs/OPERATIONS.md`](OPERATIONS.md).

## Signing in

The installer opens Cairn already signed in. Pair your phone from **Settings → Devices → Pair a device** (a
one-time code): scan it with the phone's camera, open the link, and the phone is signed in. Then
add Cairn to your home screen. To sign in on another computer later, run `cairn.sh open` or pair it
the same way.

Your access token is your recovery key. The installer prints it once, at the end, only to a
terminal. It is also stored with the install: in Railway under the service's **Variables**
(`CAIRN_AUTH_TOKEN`), or in `<dir>/.env` on your own machine. If a Cairn release is older than
one-time sign-in links, the installer opens the address and you sign in with that token.

## Connect an AI app (MCP)

Claude, ChatGPT and other AI apps can read and update your Cairn through its MCP address,
`https://<your-cairn>/mcp`. Each app gets its own access that you can take back under
**Settings → Devices → Connected AI apps**.

- **Claude app or ChatGPT:** add a custom connector, paste `https://<your-cairn>/mcp`, sign in to
  Cairn when your browser asks, and tap **Allow**.
- **Claude Code:** in **Settings → Devices → Connected AI apps**, tap **New key for an app**, then
  run the command it shows:

  ```bash
  claude mcp add --transport http cairn https://<your-cairn>/mcp --header "Authorization: Bearer <key>"
  ```

Details: [`docs/OPERATIONS.md`](OPERATIONS.md) → "Connect an AI app (MCP)".

## How much RAM

**Recommendation: at least 1 GB of memory for AI coaching, with `CAIRN_MAX_AGENT_PROCS=1`.** The
Railway installer and template set `CAIRN_MAX_AGENT_PROCS=1`.

What we measured, and what we only estimated:

- **Measured: the Cairn server alone uses about 190–210 MB.** We ran a production build
  (`node dist/server.js`, Node 26, macOS arm64) with a throwaway data folder and no AI tool
  installed. With an empty profile it settled at about 186 MB resident memory after a minute. With
  the demo data loaded, including the background work Cairn does at startup, it reached about
  212 MB. We did not measure memory under page traffic or inside the Linux container.
- **Estimated: one AI tool while it runs uses about 200–400 MB.** The coaching CLIs (Claude Code,
  Codex and the others) are separate programs that Cairn starts for each coaching task. We did not
  measure them. This figure is an estimate for a Node-based CLI.
- **One at a time.** With `CAIRN_MAX_AGENT_PROCS=1`, AI templates run one at a time.
- **Peak.** At most one background task and one task you are
  actively waiting on (a chat reply) can be in flight at the same time. That makes the peak roughly
  0.2 + 2 × 0.4 ≈ 1 GB.

| Memory | What to expect |
|---|---|
| 512 MB | Fine for logging without AI. The AI coach is likely to be killed for running out of memory. |
| 1 GB | Works with `CAIRN_MAX_AGENT_PROCS=1`. Tight when two AI tasks overlap. |
| 2 GB or more | Comfortable. On a larger box you can raise `CAIRN_MAX_AGENT_PROCS`. |

Railway charges for the memory you actually use, so the cap mostly protects you from short spikes.

## How much disk

Each AI provider's tool is installed onto the volume, and they are not small. Measured install
sizes on Linux: Grok about 180 MB, Google (Antigravity) about 220 MB, Claude about 260 MB and
ChatGPT (Codex) about 400 MB. The database itself is small.

| Volume | What fits |
|---|---|
| 0.5 GB (Railway trial) | One AI provider, whichever you pick: even ChatGPT (Codex), the largest, installs on a fresh trial volume. A second one fails to install with "Your server's disk is nearly full". |
| 5 GB (Railway Hobby) | Every provider, with room for years of data. Recommended. |

Railway's trial gives a 0.5 GB volume. After upgrading to Hobby, the volume does not grow by itself:
open the project, click the volume, and use **Live Resize** to raise it (5 GB is plenty). The
service keeps running while it resizes.

When the disk does fill, Cairn says so in plain words wherever it happens (setting up a provider,
signing in, a coach reply), and **Settings → Agents → remove** takes a provider's tool off the volume
to free its space. Its sign-in is kept, so installing it again later needs no new login.

## Security

- **A hosted URL is public.** Anyone on the internet can reach a Railway address. That is
  why the installer and the template set `CAIRN_REQUIRE_AUTH=1`: Cairn refuses to start without a
  token, and every API call needs it. The platform provides HTTPS.
- **Treat the token like a password.** To change it, edit `CAIRN_AUTH_TOKEN` in the platform's
  variables and redeploy. Rotating the token evicts everyone: on the first boot with the new value
  Cairn signs every device out and removes every passkey and pending pairing code, and logs
  `Access token changed — every device was signed out; sign in again.` Sign in again on each device
  with the new token (then add passkeys again), and give API/MCP clients the new value. Details:
  [`docs/OPERATIONS.md`](OPERATIONS.md) → Recovery.
- **The first sign-in line reaches your logs.** Until anyone has signed in, each boot logs one
  line with a one-hour, single-use sign-in link. Anything that reads the service's logs (the
  platform's log viewer, a log drain) sees it. It stops for good once any device signs in; set
  `CAIRN_FIRST_SIGNIN_LOG=0` to never print it.
- **Leave `CAIRN_SETTINGS_SECRET_KEY` alone.** It encrypts integration passwords stored in Cairn,
  such as a Garmin password. If you change it, you have to enter those passwords again.
- **Backups contain your AI sign-ins.** In these one-volume setups, your AI provider sign-ins live on
  the same volume as your data (`/data/home`). Any copy of `/data` therefore includes them, so keep
  backups private.

## What leaves your install

Cairn has no server of its own that holds your data. This is the complete list of what an install
sends, and where. Anything not listed here does not leave.

**From the installer** ([`deploy/install.sh`](../deploy/install.sh)):

- **Fetching `https://cairn.fit/install`.** The project site serves the script and counts the
  download. Fetching the same file from `raw.githubusercontent.com` instead is not counted by the
  project.
- **Install counting, opt-out.** Two anonymous requests to `https://cairn.fit/install/event`: the
  plan was accepted (Railway or this machine), then done or failed at a fixed step. No IP is kept and
  nothing about you or the machine is sent. `--no-telemetry`, `DO_NOT_TRACK=1` or
  `CAIRN_NO_TELEMETRY=1` turns it off. Exactly what is sent: [`INSTALL.md`](INSTALL.md#install-counting).
- **Downloads.** The image from GHCR, the installer's own copy, and (only with your consent)
  Docker's or Railway's install script. The full list: [`INSTALL.md`](INSTALL.md#what-the-installer-downloads).
  On Railway, the Railway CLI talks to Railway with your Railway sign-in.
- **The Railway button** links to `https://cairn.fit/railway`, a counted redirect to the Railway
  template.

**From the running app:**

- **Your AI provider.** Coaching runs through the CLI you connect (Claude Code, Codex, Antigravity or
  Grok). Each coaching task sends the part of your data that task needs to that provider (Anthropic,
  OpenAI, Google or xAI), under your own subscription. With **research** on (Settings, on by
  default), the provider's own web tools may look up published evidence for a health finding. With no
  provider connected, nothing goes to any AI.
- **Installing or updating a provider's tool** downloads it from npm (Claude Code, Codex) or from
  the vendor's own URL (Antigravity, Grok), at the exact version and checksum pinned in
  `agents.json`.
- **The update check.** Once a day, one anonymous request to GitHub's Releases API
  (`api.github.com`) for the newest release: no install id, nothing about you. On by default;
  **Settings → Data → Check for new Cairn releases** turns it off. Installing an update pulls the
  image from GHCR (the this-machine updater does it on your machine; on Railway, Railway does).
- **The exercise how-to library.** Shortly after the first start, Cairn downloads the free exercise
  library from `raw.githubusercontent.com` (yuhonas/free-exercise-db), and later the photos for the
  exercises you open. It only downloads; it sends nothing. `CAIRN_GUIDE_AUTO_IMPORT=0` stops the
  background download.
- **A link you paste into chat.** Cairn fetches that page (up to three per message) so the coach can
  read it.
- **Gemini, only with your own key.** With `GEMINI_API_KEY` set, picture prompts go to Google's
  Gemini API: a short description of an exercise, an activity or a meal (its name, never
  your numbers). So does a meal photo you attach, to read the plate. The starter figures ship in the
  image; nothing is downloaded for them.
- **Garmin, only when you connect it.** Sync talks to Garmin Connect with your own sign-in, both ways
  (finished strength sessions go back to Garmin).
- **Feedback, only when you send it.** **Send feedback** delivers what you typed (kind, message, an
  optional contact), the Cairn version and platform, and a random install id to the project's
  feedback service at `https://feedback.cairn.fit` ([`services/feedback`](../services/feedback/)).
  Anonymous diagnostics (error counts and route names, never your data) are added only when you tick
  the box, and the sheet shows them first. Your contact stays in the service's own database, only for a
  reply: it is never put in a forwarded issue or notification. `CAIRN_FEEDBACK_URL` points it at your
  own deployment, or `CAIRN_FEEDBACK_URL=""` turns the service off; then **Send feedback** opens a
  prefilled GitHub issue in your own browser for you to review and submit.
- **The usage ping, opt-in.** Off by default (**Settings → Data → Share anonymous usage**). When on,
  once a week, five fields go to the same feedback service: a random install id, the Cairn version,
  the platform (such as `railway` or `docker`), the CPU architecture and the Node version.
- **Error reports stay home.** When something fails in the app (a welcome step included), your
  browser reports it to your own Cairn (`/api/telemetry/client`), as an error class and a route
  name, never your data. It leaves only inside a feedback message, and only when you tick "Include
  anonymous diagnostics".

Apple Health data only comes in (your phone sends it to your Cairn). Cairn sends no push
notifications, loads no web fonts or scripts from other sites, and has no analytics. Field-level
detail for feedback and the ping: [`OBSERVABILITY.md`](OBSERVABILITY.md#feedback-and-the-usage-ping).

## Backups and moving between options

- **Every option:** Cairn writes a restore point to `/data/backups/` just before an update changes
  the database (it keeps the newest three). You can also download a full database snapshot any
  time from **Settings → Data**.
- **Railway** offers volume backups, and on its Pro plan it backs up the volume before each
  automatic update. Cairn's own restore point above covers every plan.
- **Moving** from one option to another is a database snapshot carried across. The restore steps
  are in [`docs/OPERATIONS.md`](OPERATIONS.md#restore).

## For operators: what the Railway installer and template set

Both read the same values: the template is declared in
[`deploy/railway/template.json`](../deploy/railway/template.json), and the installer's copy is checked
against it by the test suite.

| Variable | Value | Why |
|---|---|---|
| `CAIRN_SINGLE_VOLUME` | `1` | The platform gives one volume, so sign-ins and AI tools live under `/data/home` beside the database |
| `CAIRN_REQUIRE_AUTH` | `1` | Refuse to boot without a token on a public URL |
| `CAIRN_AUTH_TOKEN` | generated | The sign-in token and recovery key (the template: `${{secret(48)}}`, a new one per deployer) |
| `CAIRN_SETTINGS_SECRET_KEY` | generated | Encrypts stored integration secrets (the template: `${{secret(48)}}`) |
| `CAIRN_BLANK_PROFILE` | `1` | Start empty into the welcome, with no example athlete (a plain `docker run` seeds one unless this is set) |
| `CAIRN_PLATFORM` | `railway` | Tells the app how it was deployed, so it can show the right update path |
| `CAIRN_MAX_AGENT_PROCS` | `1` | Bounds the memory used by AI tools |
| `PORT` | `8787` | Matches the image's health check and the platform's routing |
| `CAIRN_FEEDBACK_URL` | `https://feedback.cairn.fit` | Where Send feedback delivers; the app's default too, written out so it is visible and editable |

The installer generates the token and the key as 64 random hex characters each and sends them with
`railway variable set KEY --stdin`. Re-running it keeps both. The exact Railway CLI sequence it runs
is printed by `curl -fsSL https://cairn.fit/install | sh -s -- --target=railway --dry-run`.

**Using a terminal in single-volume mode.** A platform shell does not go through the entrypoint,
so `HOME` there still points at `/home/app`. Run AI sign-ins from **Settings → Agents → Connect**,
which uses the server's own environment. If you must use the shell, run the command as the `app`
user with `HOME=/data/home` set. Otherwise the sign-in lands where the server never looks.
