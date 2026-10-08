# Install Cairn with one command

One command gives you your own private Cairn that keeps itself up to date:

```bash
curl -fsSL https://cairn.fit/install | sh
```

It asks one question:

```text
Where should Cairn live?
  1) In the cloud on Railway    (about $5/month, nothing to keep running)
  2) On this computer or server (free, private, needs to stay on)
```

Both end the same way: the installer opens Cairn in your browser **already signed in**, prints the
link it used, and shows your recovery key once. Pair your phone from **Settings → Devices → Pair a device** (a
one-time code); your access token is your recovery key.

The installer is a single POSIX `sh` script, [`deploy/install.sh`](../deploy/install.sh). The
`cairn.fit/install` address serves that file from `main`; it is the same file as
`https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh`, so either URL works in every
command on this page. It runs the published image (`ghcr.io/zilet/cairn:latest`, which moves only on
tagged releases).

**Who it's for:** anyone who wants their own Cairn without cloning the repo or editing Compose
files. If you build from source or run a custom Compose setup, use [SHARING.md](SHARING.md) and
[DEPLOYMENT.md](DEPLOYMENT.md) instead. A side-by-side comparison is in [HOSTING.md](HOSTING.md).

## The command

| Situation | Run |
|---|---|
| Ask me (Railway or this machine) | `curl -fsSL https://cairn.fit/install \| sh` |
| Railway, no question | `curl -fsSL https://cairn.fit/install \| sh -s -- --target=railway` |
| This machine, no question | `curl -fsSL https://cairn.fit/install \| sh -s -- --target=local` |
| A fresh VPS where you are root (or want system-wide timers) | `curl -fsSL https://cairn.fit/install \| sudo sh -s -- --target=local` |
| This machine, with options | `curl -fsSL https://cairn.fit/install \| sh -s -- --yes --https=tailscale` |
| No terminal (cloud-init, CI) | add `--target=…` and `--yes`. With no terminal and no `--target`, the installer prints both choices with the exact flags and exits with an error. |

Any this-machine option (`--dir`, `--port`, `--https`, `--lan`, `--tz`, `--updater`, `--no-start`)
implies `--target=local`. A re-run on a machine that already has one kind of install picks that
kind without asking.

You'd rather read it before running it? Download it, read it, then run the same file:

```bash
curl -fsSLO https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh
less install.sh
sh install.sh --target=railway --dry-run   # prints the Railway CLI commands it would run
sh install.sh --target=local --dry-run     # prints every file and timer it would write
sh install.sh
```

## Options for both

| Option | What it does |
|---|---|
| `--target=railway\|local` | Where Cairn lives. Asked when you leave it out. |
| `-y`, `--yes` | Answer yes to prompts. Required when there is no terminal. It does **not** consent to running a downloaded install script (see the next two flags). |
| `--install-docker` | Allow the installer to run Docker's install script (`curl -fsSL https://get.docker.com \| sh`) when Linux has no container engine. Without it, `--yes` prints that command and exits non-zero; an interactive run asks. |
| `--install-railway-cli` | Allow the installer to run Railway's install script (`curl -fsSL https://railway.com/install.sh \| sh`) when the Railway CLI is missing and Homebrew/npm can't install it. Same rule as above. |
| `--name=NAME` | Instance name. Default `cairn`. Here: the Compose project, container, volumes and timers. On Railway: the service name and the folder `~/.cairn/railway/NAME`. |
| `--image=REF` | Image to run. For example, `ghcr.io/zilet/cairn:v2.1` follows only 2.1.x patch releases. |
| `--no-browser` | Print the one-time sign-in link instead of opening a browser. |
| `--no-telemetry` | Send no anonymous install counts (see [Install counting](#install-counting)). Same as `DO_NOT_TRACK=1` or `CAIRN_NO_TELEMETRY=1`. |
| `--dry-run` | Print what would happen. Changes nothing, sends nothing and prints no secret. |

## Signing in

At the end, the installer asks the running Cairn for a one-time pairing code and opens
`<your Cairn>/#pair=<code>` in this machine's browser (with `open` on a Mac, `xdg-open` on a Linux
desktop). On a server with no browser it prints the link instead: open it on your computer. The code
works once and expires soon.

- **Your phone:** in Cairn, **Settings → Devices → Pair a device** shows a one-time code as a QR code. Scan it
  with the phone's camera, open the link, then add Cairn to the home screen.
- **Later, or another computer:** `cairn.sh open` mints a fresh code and opens the browser again.
- **Your recovery key** is the access token. The installer prints it once, at the end, and only to
  an interactive terminal, never into a log. Keep it somewhere safe. It is stored in Railway
  (service → **Variables** → `CAIRN_AUTH_TOKEN`) or in `<dir>/.env` on your own machine.
- **An older Cairn release** without one-time codes answers 404. The installer then opens the
  address and tells you to sign in with your access token instead.

The token reaches Cairn in a request header that curl reads from stdin, never from its command
line.

## Choice 1: Railway

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --target=railway
```

Railway runs the server on your own Railway account. About $5/month on the Hobby plan is the
recommended choice (the free tier can pause the service and is tight on memory); check Railway's
current pricing. What you agree to by keeping data there is in
[HOSTING.md](HOSTING.md#1-railway).

What it does, in order:

1. **The Railway CLI.** If `railway` is missing, it installs it with `brew install railway` on a Mac
   with Homebrew, else `npm i -g @railway/cli` when npm exists. If neither works, it offers
   Railway's official install script (`https://railway.com/install.sh`, into `~/.railway/bin`),
   only with your consent (an interactive yes or `--install-railway-cli`; `--yes` alone is not enough), saved to a file and run from there.
2. **Sign-in.** `railway whoami`; if you are not signed in, `railway login` opens your browser. With
   no terminal it stops and asks you to run `railway login` first (or set `RAILWAY_API_TOKEN`).
3. **The project.** It creates a project named after the instance (`cairn` by default), or the name you pass with
   `--railway-project-name=`. If a project with that name exists, it asks whether to use it (`--yes`
   counts as yes). Say no and it asks for a new name, offering the next free one (`cairn-2`); with no
   terminal, pass `--railway-project-name=`. A project Railway is still deleting (it keeps one about 48 hours, with a
   `deletedAt`) does not count. With several workspaces, add `--railway-workspace=<name or ID>`.
4. **The service.** One service from `ghcr.io/zilet/cairn:latest`, one volume at `/data`, and
   these variables: `CAIRN_SINGLE_VOLUME=1`, `CAIRN_REQUIRE_AUTH=1`, `CAIRN_BLANK_PROFILE=1`,
   `CAIRN_PLATFORM=railway`, `CAIRN_MAX_AGENT_PROCS=1`, `PORT=8787`,
   `CAIRN_FEEDBACK_URL=https://feedback.cairn.fit`. It generates
   `CAIRN_AUTH_TOKEN` and `CAIRN_SETTINGS_SECRET_KEY` (64 hex characters each) and sends them with
   `railway variable set KEY --stdin`, never on a command line.
5. **Automatic updates.** It switches on Railway's Image Auto Updates for the service (new
   releases install in the Night window, 02:00–06:00 UTC), with one environment patch through
   `railway api`, and reads the setting back. A service that already has a setting keeps it, and
   once the installer has switched them on, turning them off in Railway is your choice: a re-run
   leaves it off. If the patch fails, the install goes on and the summary says how to switch them on
   by hand.
6. **The address.** A public `https://<name>.up.railway.app` domain on port 8787.
7. **The deployment.** One redeploy from the image, then it checks the deployment every 10 seconds
   for up to 10 minutes. If Railway reports `FAILED` or `CRASHED`, it prints the last 30 build and
   runtime log lines, drops any line that contains your token or key, and stops. Your project stays;
   fix the cause and run the same command again.
8. **Health, then sign-in.** It waits for `https://<domain>/api/health` and opens Cairn signed in.

Every Railway command runs from `~/.cairn/railway/<name>/` (mode 700), where the CLI keeps its
project link. That folder holds `railway.state` (project ID, service, domain; no secrets) and a copy
of the installer as `cairn.sh`. Re-running the install command is safe: it finds the same project,
service, volume and domain, and keeps the token and the key.

The exact Railway CLI sequence, which `--target=railway --dry-run` also prints:

```text
railway whoami                (railway login when not signed in)
railway list --json
railway init --name cairn --json
railway link --project <project id> --environment production
railway add --image ghcr.io/zilet/cairn:latest --service cairn --variables CAIRN_SINGLE_VOLUME=1 … --json
railway service link cairn
railway volume add --mount-path /data --json
railway variable set CAIRN_AUTH_TOKEN --stdin --service cairn --environment production --skip-deploys
railway variable set CAIRN_SETTINGS_SECRET_KEY --stdin --service cairn --environment production --skip-deploys
railway service list --json; railway environment list --json
railway environment config --environment production --json      (are auto updates set already?)
railway api '<environmentPatchCommit>' --variables @autoupdates.json   (source.autoUpdates, only when not set)
railway domain --port 8787 --service cairn --environment production --json
railway redeploy --service cairn --environment production --from-source --yes --json
railway deployment list --service cairn --environment production --limit 5 --json
```

### Managing a Railway install

```bash
sh ~/.cairn/railway/cairn/cairn.sh status      # project, deployment state, health and version
sh ~/.cairn/railway/cairn/cairn.sh open        # open Cairn signed in (a fresh one-time code)
sh ~/.cairn/railway/cairn/cairn.sh update      # railway redeploy --from-source: pulls the newest :latest
sh ~/.cairn/railway/cairn/cairn.sh logs        # the last 100 log lines (lines with secrets dropped)
sh ~/.cairn/railway/cairn/cairn.sh uninstall   # delete the Railway project; asks you to type its name
```

`open` and `logs` read the token from Railway (`railway variable list --kv`) into memory only; they
never print it. Without a terminal, `uninstall` needs `--confirm-purge=<project name>`. It runs
`railway delete --project <id> --yes`; an account with two-factor sign-in has to run that command
itself in a terminal. Deleting the project deletes its volume, and with it all of this Cairn's data.

**Updates.** Railway's Image Auto Updates redeploy the service when a new `:latest` is published,
inside the maintenance window. The installer switches them on in the Night window (02:00–06:00
UTC); `cairn.sh status` shows the setting, and the service's **Settings → Source → Auto Updates**
changes it. `cairn.sh update` updates right away. Cairn writes its own restore
point to `/data/backups/` before a release changes the database.

### Building the Railway template (maintainers and forks)

`sh deploy/install.sh railway-template` builds the "Deploy on Railway" template from
[`deploy/railway/template.json`](../deploy/railway/template.json) into the workspace your Railway CLI
is signed in to, as a private draft, through a scratch project it deletes again. `--publish` publishes
a checked draft after a `[y/N]`; `--dry-run` prints the plan. The secrets are always Railway's
per-deployer `${{secret(48)}}`, never a value. Details and the editor steps Railway leaves you:
[`deploy/railway/README.md`](../deploy/railway/README.md).

## Choice 2: this computer or server

Both choices start fresh: Cairn opens into the welcome with no example athlete (`CAIRN_BLANK_PROFILE=1`, written on the first install only). A plain `docker run` seeds an example athlete instead.

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --target=local
```

It runs on any 64-bit Linux machine: a rented VPS (Hetzner, DigitalOcean, Linode and the like), a
Raspberry Pi, or a home server. It also runs on a Mac for local use. It runs the image with Docker
or Podman, generates an access token, starts Cairn, waits for it to report healthy, installs a small
updater and opens Cairn signed in.

What it does, in order:

1. It checks the machine. It needs a 64-bit OS (amd64 or arm64). 32-bit ARM, including a 32-bit
   userland on a 64-bit kernel, is refused with a clear message.
2. It finds Docker or Podman. On Linux with neither, it offers to install Docker with Docker's
   official script (`https://get.docker.com`) and only proceeds with your consent (an interactive yes or `--install-docker`; `--yes` alone is not enough: it prints the command and exits). On a
   Mac it asks you to install Docker Desktop, OrbStack or Podman and stops.
3. It shows the plan and asks once.
4. It writes `docker-compose.yml`, `.env` and `cairn.sh` into the install directory, then runs
   `compose up -d` and waits for `GET /api/health`.
5. It sets up the exposure you chose (see below) and installs the updater.
6. It opens Cairn signed in (a one-time code minted on `http://127.0.0.1:<port>`; the link uses
   your public or tailnet address when you chose one) and prints how updates work, how to
   uninstall, and your recovery key.

Re-running the command is safe. It never regenerates the token or the settings key, and it never
touches your data volumes. Lines you added to `.env` yourself are kept. Re-running with different
flags is how you reconfigure.

## Options for this machine

| Option | What it does |
|---|---|
| `--dir=PATH` | Install directory. Default `~/cairn`, or `/opt/cairn` as root. |
| `--port=PORT` | Host port. Default `8787`. |
| `--https=tailscale` | Private HTTPS on your tailnet through Tailscale Serve. |
| `--https=caddy --domain=D` | Public HTTPS on your own domain through a Caddy container (ports 80 and 443). Add `--email=E` for certificate notices. |
| `--lan` | Listen on all interfaces with plain HTTP for your home network. |
| `--local` | Go back to loopback only. This undoes `--lan` and `--https`. |
| `--tz=ZONE` | Timezone, for example `Europe/Berlin`. Default: the host's own. |
| `--updater=KIND` | `auto` (default), `systemd`, `cron`, `launchd` or `none`. `--no-updater` is the same as `none`. |
| `--no-start` | Write the configuration but start nothing. |
| `--dry-run` | Print the planned `.env` (secrets redacted), Compose file, Caddyfile and timers. Changes nothing. |

The same script handles the commands after install. It is kept at `<dir>/cairn.sh`:

```bash
sh ~/cairn/cairn.sh status       # container health, URL, updater schedule, last update result
sh ~/cairn/cairn.sh open         # open Cairn signed in (a fresh one-time code)
sh ~/cairn/cairn.sh update       # update now (same path the timer runs)
sh ~/cairn/cairn.sh logs         # the last 100 lines of the container log
sh ~/cairn/cairn.sh install --https=tailscale   # reconfigure
sh ~/cairn/cairn.sh uninstall    # remove; keeps your data
```

## Reaching it: pick an exposure

By default Cairn listens only on `127.0.0.1`. Whatever you pick, the installer always generates a
long random token and sets `CAIRN_REQUIRE_AUTH=1`, so the server refuses to start without one.

| Choice | Who can reach it | Needs | Trade-offs |
|---|---|---|---|
| Default (loopback) | Only this machine | Nothing | Safest. On a remote server, reach it through an SSH tunnel: `ssh -N -L 8787:127.0.0.1:8787 you@server`, then open `http://localhost:8787`. Not usable from a phone. |
| `--https=tailscale` | Only devices signed in to your tailnet | [Tailscale](https://tailscale.com/download) on the server and on each device; MagicDNS and HTTPS certificates enabled for the tailnet | Private: nothing is exposed to the internet, and there is no domain or firewall work. Real HTTPS, so the phone gets the full installable, offline-capable app. Your phone must run the Tailscale app. |
| `--https=caddy --domain=…` | Anyone on the internet who has the token | A domain whose DNS A/AAAA record points at the server; ports 80 and 443 open | A normal public URL that works on any device with no VPN. Caddy obtains and renews the certificate on its own. The token is the only lock, so keep it private. Rootless Podman can't bind 80/443 by default; run the installer with `sudo` for this mode. |
| `--lan` | Anything on your local network | A trusted home network | Easy for a home server. Plain HTTP, so phones can open it but can't install it as an offline app. Don't use on a cloud VM. |

With Tailscale, the installer runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, the
same approach as [`scripts/setup-phone.sh`](../scripts/setup-phone.sh). If Tailscale is missing or
not connected, Cairn still starts and the installer tells you exactly what to run next. If Serve
already has another configuration on that machine, it asks before replacing it.

With Caddy, the Compose file gains a `caddy` service that proxies to Cairn over the Compose network.
Cairn's own port stays on loopback.

### Your phone

Sign in on a computer first (the installer does it for you; later, `cairn.sh open`). Then go to
**Settings → Devices → Pair a device**, which shows a one-time code as a QR code. Scan it with your phone and
add Cairn to the home screen. For the phone to install Cairn as an offline-capable app, reach it
over HTTPS (`--https=tailscale` or `--https=caddy`). See [Signing in](#signing-in).

## Where things live

| Path | What it is |
|---|---|
| `<dir>/docker-compose.yml` | Generated. Rewritten on every install run; put local changes in `docker-compose.override.yml`. |
| `<dir>/.env` | Mode `600`. Holds the token, `CAIRN_SETTINGS_SECRET_KEY` (it decrypts connector secrets saved in Settings, so never lose or change it), the timezone, the exposure, and any keys you add (for example `GEMINI_API_KEY`). |
| `<dir>/cairn.sh` | This installer, used by the updater and for `status`/`open`/`update`/`logs`/`uninstall`. |
| `<dir>/Caddyfile` | Only with `--https=caddy`. |
| `<dir>/backups/` | The last three automatic pre-update database snapshots. |
| `<dir>/updater-status.json`, `updater.state`, `updater.log` | Updater bookkeeping (`updater.log` with cron/launchd only; systemd logs to the journal). |
| Volume `<name>_cairn-data` | The SQLite database, uploads and art cache. This is your data. |
| Volume `<name>_cairn-home` | Agent CLI logins. |
| Volume `<name>_cairn-tools` | Optional agent CLI binaries (regenerable). |
| Volumes `<name>_caddy-data`, `<name>_caddy-config` | Caddy's certificates (Caddy mode). |

Schema migrations run automatically when a new image boots.

## Updates and rollback

The updater is the installed `cairn.sh update`. Two schedules run it:

- **Nightly**, at a random minute between 03:00 and 05:00 local time, chosen once at install.
- **Every 5 minutes**, a cheap check for an "Update now" request from the app. It only updates
  when one is waiting.

The scheduler depends on the machine. As root on Linux, it uses system systemd timers
(`<name>-update.timer`, `<name>-update-check.timer`). As a regular user on Linux, it uses
`systemctl --user` timers; run `sudo loginctl enable-linger $USER` so they keep running after you
log out (the installer tries this and tells you if it couldn't). Without systemd it falls back to
cron. On a Mac it uses launchd agents. To see what is scheduled:
`systemctl list-timers 'cairn-update*'` (add `--user` for a user install), or `crontab -l`.

Each run does the following:

1. It pulls the image and compares the image ID with the one the container runs. If nothing
   changed, it stops there and reports `current`. If you stopped Cairn yourself, the nightly run
   leaves it stopped.
2. It saves a consistent database snapshot through the app's own export (`/api/export/db`) into
   `<dir>/backups/`. The token goes to curl on stdin, never in a command line.
3. It tags the running image as `localhost/cairn-rollback:<name>`, recreates the container and
   waits up to 3 minutes for `/api/health`.
4. If the new release doesn't come up healthy, it re-tags the previous image, starts that again
   and reports `rolled_back`. That release is then **held back**: later runs skip it until a newer
   one ships, or until you run `cairn.sh update --force`.

Rollback restores the previous **image**. Schema migrations only move forward, so if a release's
migration itself misbehaved, restore the pre-update snapshot by following
[OPERATIONS.md → Restore](OPERATIONS.md#restore).

Logs: `journalctl -u cairn-update.service` (or `journalctl --user -u …`), or `<dir>/updater.log`
for cron and launchd.

### How the app and the updater talk

The contract between the app and the updater:

- The container gets `CAIRN_PLATFORM=installer` and `CAIRN_UPDATE_METHOD=trigger-file`.
- **Update now**: the app writes `/data/.cairn-update-requested` (JSON `{"requested_at": …}`) into
  the data volume. Within 5 minutes the updater sees it through
  `docker|podman exec <name> test -f …`, runs the update and deletes the file. A request counts as
  handled whatever the result; the result is in the status file.
- **Status**: the updater writes `/data/.cairn-updater.json` (the same JSON sits at
  `<dir>/updater-status.json`). The fields:
  - `installed`: always `true`.
  - `last_run`, `last_check`: ISO times. `last_check` is refreshed every 5-minute tick, as a
    heartbeat.
  - `last_result`: `updated`, `current`, `rolled_back` or `failed`.
  - `trigger`: `install`, `nightly`, `requested` or `manual`.
  - `version`, `previous_version`, `detail`, `scheduler`, `schedule`, `installer_version`.

## Backups

The pre-update snapshots are a safety net, not a backup strategy. For real backups (the SQLite
snapshot download, volume tarballs, restore) follow
[OPERATIONS.md → Backups & restore](OPERATIONS.md#backups--restore). The volume names to use are
`<name>_cairn-data` and `<name>_cairn-home`. Also keep a copy of `<dir>/.env`: without its
`CAIRN_SETTINGS_SECRET_KEY`, encrypted connector secrets in a restored database can't be read.

## More than one instance

Each person gets their own name, port and directory:

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --name=cairn-partner --port=8788 --dir=~/cairn-partner
```

On Railway, give the second one its own name and project:

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --target=railway --name=cairn-partner --railway-project-name=cairn-partner
```

See [HOUSEHOLDS.md](HOUSEHOLDS.md) for what a second instance means for logins and data.

## Uninstall

On Railway, `sh ~/.cairn/railway/cairn/cairn.sh uninstall` deletes the whole Railway project after
you type its name (see [Managing a Railway install](#managing-a-railway-install)). On this machine:

```bash
sh ~/cairn/cairn.sh uninstall
```

This removes the timers, any Tailscale Serve mapping it created, the containers and the generated
files. It **keeps** your data volumes, `.env` (token and settings key) and `backups/`. Re-running
the install command with the same `--dir` brings everything back.

To delete everything, including all of your data, run:

```bash
sh ~/cairn/cairn.sh uninstall --purge          # asks you to type the instance name
# without a terminal: ... uninstall --purge --yes --confirm-purge=cairn
```

After a plain uninstall, `cairn.sh` is gone. Use the one-liner instead:
`curl -fsSL https://cairn.fit/install | sh -s -- uninstall --purge --dir=~/cairn`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "permission denied on the Docker socket" | Add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log in again), or run the installer with `sudo`. |
| Docker was just installed and the run stopped | Your new `docker` group membership applies at your next login. Log out and back in (or run `newgrp docker`), then run the same command again. |
| "32-bit system detected" | Flash a 64-bit OS. On a Raspberry Pi 3/4/5, use the 64-bit Raspberry Pi OS. |
| Cairn didn't become healthy | `cd <dir> && docker compose -p <name> logs --tail=80 cairn`. Under 1 GB of RAM, add swap. |
| Tailscale Serve couldn't be enabled | Turn on MagicDNS and HTTPS certificates in the Tailscale admin console, then re-run with `--https=tailscale`. |
| Caddy has no certificate | Check that DNS points at the server, that ports 80 and 443 are open (for example `sudo ufw allow 80,443/tcp`), and run `docker compose -p <name> logs caddy`. |
| Updates stop when you log out | `sudo loginctl enable-linger $USER`, or reinstall as root. |
| Podman containers don't come back after reboot | The installer enables `podman-restart.service` when it can. Check `systemctl --user status podman-restart`. |
| "No terminal to ask: Where should Cairn live?" | Add `--target=railway` or `--target=local` (and `--yes`). |
| Railway: "Not signed in to Railway" | Run `railway login` in a terminal (or set `RAILWAY_API_TOKEN`), then run the same command again. |
| Railway: the project could not be created | With more than one workspace, add `--railway-workspace=<name or ID>`. |
| Railway: "could not read the service variables" | A passing Railway API error. Nothing was changed (the installer never makes new secrets without reading the old ones); re-run in a minute. |
| Railway: "Your Railway CLI is too old" | `railway upgrade`, `brew upgrade railway` or `npm i -g @railway/cli`, then re-run. |
| Railway: the deployment FAILED or CRASHED | Read the log lines the installer printed (or `cairn.sh logs`), fix the cause, then run the install command again. The project, volume and token stay. |
| Railway: uninstall says two-factor | Run `railway delete --project <id>` yourself in a terminal; `cairn.sh status` shows the ID. |
| The browser did not open | On a server there is no browser: open the printed `#pair=` link on your computer. It works once; `cairn.sh open` makes a new one. |

## What the installer downloads

The installer downloads these, all over HTTPS:

- Its own copy for `cairn.sh`. When you run it through `curl | sh` there is no file to copy, so it
  fetches `https://raw.githubusercontent.com/zilet/cairn/main/deploy/install.sh` and
  syntax-checks it. `CAIRN_INSTALL_SCRIPT_URL` overrides the URL, and it must be `https://`.
- Docker's install script from `https://get.docker.com`, only when Docker is missing on Linux and
  you agreed (interactively or with `--install-docker`). It is saved to a temporary file and run from there.
- For Railway, the Railway CLI when it is missing: through Homebrew or npm, or Railway's install
  script from `https://railway.com/install.sh`, only when you agreed (interactively or with `--install-railway-cli`), saved to a temporary file and
  run from there.
- Container images from GHCR (and `caddy:2-alpine` from Docker Hub in Caddy mode). On Railway,
  Railway pulls the image.

The updater never updates `cairn.sh` itself. To pick up a newer installer, run the one-line
command again.

## Install counting

So the project can tell whether installs work, an install sends `https://cairn.fit/install/event` two
anonymous GET requests: `chose` once you accept the plan, then `done` or `failed`. Each carries
four values and nothing else: the event, where Cairn goes (`railway` or `local`), a fixed step code
for a failure (`engine`, `download`, `start`, `health`, `updater`, `railway_cli`, `railway_setup`,
`railway_deploy` or `other`), and the installer version. Never a token, domain, project name, path,
host name or anything you typed. A machine with no container engine is counted as `failed` at
`engine` without a `chose`, because that check runs before the plan. The request waits at most three
seconds, prints nothing and can never fail the install. The plan says so on its `Counting:` line.

Only `install` counts: never `--dry-run`, `update`, `status`, `open`, `logs`, `uninstall` or the
nightly updater. To turn it off, use any of:

```bash
curl -fsSL https://cairn.fit/install | sh -s -- --no-telemetry
curl -fsSL https://cairn.fit/install | DO_NOT_TRACK=1 sh
curl -fsSL https://cairn.fit/install | CAIRN_NO_TELEMETRY=1 sh
```

Everything else Cairn and its installer send, and where: [What leaves your
install](HOSTING.md#what-leaves-your-install).

## Environment variables

Set these in front of `sh` (for example `curl -fsSL https://cairn.fit/install | DO_NOT_TRACK=1 sh`).

| Variable | What it does |
|---|---|
| `DO_NOT_TRACK`, `CAIRN_NO_TELEMETRY` | Any value other than empty or `0` turns [install counting](#install-counting) off. |
| `CAIRN_INSTALL_EVENT_URL` | Where install counts go (default `https://cairn.fit/install/event`). Must be `https://`; empty sends nothing. For testing a counter of your own. |
| `CAIRN_INSTALL_SCRIPT_URL` | Where a `curl \| sh` run fetches its own copy for `cairn.sh` (default the `main` copy on `raw.githubusercontent.com`). Must be `https://`. |
| `CAIRN_HEALTH_TIMEOUT` | Seconds to wait for Cairn's health check after starting it (default 180). |
| `CAIRN_RAILWAY_DEPLOY_TIMEOUT` | Seconds to follow a Railway deployment before giving up (default 600). |
| `CAIRN_CONTAINER_TOOL` | Use this container engine (`docker` or `podman`) instead of detecting one. |
