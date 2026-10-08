# Cairn — Operations & Update Playbook

Practical reference for deploying, updating, migrating, backing up, and restoring Cairn on a
Docker host. Cairn is single-user and ships with no auth by default; set `CAIRN_AUTH_TOKEN`
(and `CAIRN_REQUIRE_AUTH=1` to fail closed at boot) whenever the port is reachable beyond
loopback — a LAN, a tailnet, or a public proxy. Otherwise keep it on localhost, a LAN,
Tailscale/VPN, or another trusted private network. See `SECURITY.md` for the full posture.

> Every `docker` / `docker compose` command in this doc works unchanged with Podman
> (`podman` / `podman compose`) — see the container-engine note in
> [`DEPLOYMENT.md`](DEPLOYMENT.md). Commands below are not individually rewritten for both.

---

## Architecture of state

Persistent state and optional tools live in three named Docker volumes. Nothing important lives in the container
image itself.

| Volume | Mounted at | Contents |
|---|---|---|
| `cairn-data` | `/data` | `cairn.db` + `-wal` + `-shm` (SQLite WAL files) |
| `cairn-home` | `/home/app` | Provider login directories, plus the V8 compile cache (`.cache/node-compile-cache`, regenerable) |
| `cairn-tools` | `/home/app/.cairn-tools` | Optional provider binaries; regenerable, omitted from backups |

**Single-volume mode (`CAIRN_SINGLE_VOLUME=1`).** Hosting platforms (such as Railway) give a
service exactly one persistent volume. With this flag the entrypoint keeps the home state under
`/data/home` instead: `HOME`, `CAIRN_CLI_ROOT`, `NPM_CONFIG_PREFIX`, `NPM_CONFIG_CACHE`,
`NODE_COMPILE_CACHE`, and the `PATH` entries that pointed at `/home/app` are all rewritten to that
location before the app starts. This works whether the container starts as root (the usual case:
it chowns, then drops to `app`) or already runs as a non-root uid (then `/data` must be writable by
it). The database (`/data/cairn.db`), `uploads/`, `art/`, `backups/` and the other `DATA_DIR`
entries sit beside `home/` without overlap. **In this mode a backup of `/data` also contains the
provider CLI logins**, so treat it as a secret. A platform shell bypasses the entrypoint, so sign
in to a provider from Settings → Agents → Connect, or run the CLI as `app` with
`HOME=/data/home` set. Templates and the sizing note: [`HOSTING.md`](HOSTING.md).

For local dev, the DB lives at `./data/cairn.db` (relative to the project root). The path is
controlled by `DATA_DIR` (directory) or `DB_PATH` (explicit file override) — see `.env.example`.

Provider CLIs are optional runtime tools and are not baked into the image. **Settings → Agents →
Install** writes the selected tool to `cairn-tools`; Connect writes login state to `cairn-home`.
Both survive image replacement, but only login state needs backup. The shell equivalent is:

```bash
docker compose exec -u app cairn cairn-update-agent-clis claude codex
```

Each installed agent card exposes Update. Optional interval updates use `AGENT_CLI_AUTO_UPDATE=1`
and update installed tools only; missing providers remain absent.

### Connecting (and re-connecting) agents

CLI logins live in the `cairn-home` volume (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok`). The
easiest way to (re-)authenticate after install or a token expiry is **in the app — Settings →
Agents → Connect**: it opens a browser terminal and runs the provider's sign-in *as the server
user*, so the credential lands where the agent reads it (no `-u app` to remember). From a shell it's
one `docker exec` per provider — always `-u app`, or the login is written as root and the server
can't see it:

```bash
docker exec -u app -it cairn claude auth login   # Claude Code
docker exec -u app -it cairn codex login --device-auth  # Codex
docker exec -u app -it cairn agy                 # Antigravity (Google)
docker exec -u app -it cairn grok login --device-auth   # Grok (or set XAI_API_KEY)
```

An agent that isn't logged in is automatically excluded from the auto-rotation (Settings shows it as
**Installed** rather than **✓ Connected**), so a half-configured host degrades cleanly instead of
failing requests.

---

## Local dev vs prod parity

```bash
# Local (no Docker)
npm run dev          # build browser JS from src/client, then tsx watch; http://localhost:8787
npm run styles:watch # rebuild public/styles.css on every src/styles/ save (run beside dev)

# Override DB location for testing
DB_PATH=/tmp/test.db npm run dev

# Prod (Docker)
docker compose up -d --build
# DB at /data/cairn.db inside the cairn-data volume
```

The code path is identical. The only difference is `DATA_DIR`: `./data` locally, `/data` in
Docker (set by the Dockerfile `ENV` directive and the volume mount).
For source-built Docker images, the Docker builder runs `npm run build`; that typechecks and
generates the browser client, then the runtime image overlays generated `public/js` from the
builder over the static `public/` tree. Generated `public/js` is ignored by git, so source deploys
compile from `src/client` instead of relying on committed transpiled browser files.
The Docker build context is an explicit allowlist: application source, build configuration, static
PWA inputs, agent configuration, and the offline seed-art pack only. Repository documentation,
tests, media, local agent instructions (`CLAUDE.md` / `AGENTS.md`), and operator files are never
sent to the builder. The final `/app` contains only `dist`, production `node_modules`, `public`,
`seed-art`, `agents.json`, and `package.json`. Compose mounts durable state at `/data` and
`/home/app`, plus regenerable tools at `/home/app/.cairn-tools`; the host checkout is never mounted.
Docker defaults to `TZ=America/New_York`. The PWA reports its current IANA timezone and Cairn remembers
the last valid zone for weekly reviews, nightly maintenance, Brief precompute, and boundary application.
Set `TZ` in `.env` as a sensible fallback for a new install before any device has connected. If weekly
background work must run before the first PWA request, that fallback frames the configured day and hour.
For example, use `TZ=Europe/London`.

### Bounding concurrent CLI subprocesses

Every coaching CLI spawn (chat, agent jobs, enrichment, the proactive pass, day-read precompute and
refresh) shares one process-wide semaphore so a resource-constrained host — a Pi 5's 8 GB / 4 cores —
never runs more agent subprocesses at once than it can serve well. `CAIRN_MAX_AGENT_PROCS` (default
`2`) sets the background cap; an interactive run (a chat turn, an athlete's own new read) may take one
additional reserved permit above it. Raise it on a more capable host, or leave it if requests start
returning "the coach is busy" (`AgentBusyError`, `code: agent_busy`) more than expected — that error
is a transient deferral, not a failure, and the affected job/turn retries on its own. Details:
`docs/ARCHITECTURE.md` "The process-wide agent spawn cap".

---

## Knowing when to update

Cairn tells you when a newer release exists — you never have to watch the repo. A quiet
daily background check (in the scheduler) asks the public **GitHub Releases API** for the
latest tag, compares it to the running version, and caches the result. It is **pull, never
push**: nothing notifies you; the answer waits in **Settings → Data → Cairn version**, which
shows the running version, "up to date" or "vX.Y.Z is available", a **What's new** link, and
the copy-paste **How to update** commands. A **Check now** button forces an immediate check.

The check is on by default and is one toggle to disable ("Check for new Cairn releases").
It sends nothing but an anonymous request — no instance id, no telemetry — and when off,
Cairn makes no outbound update request at all. The running version is also exposed at
`GET /api/health` and `GET /api/version`, and the full status at `GET /api/update-status`
(MCP `get_update_status` / `check_for_update`). Knobs:

- `CAIRN_VERSION` — the release workflow bakes the exact tag into the image so the check is
  precise even on the `:latest` tag; on a source build it falls back to `package.json`.
- `CAIRN_UPDATE_REPO` — `owner/repo` to check against (defaults to the upstream repo); set
  this on a fork that cuts its own releases.

### How a release reaches this host ("Update now")

The same card says, in one sentence, how updates happen where Cairn runs, and offers a calm
**Update now** button when the host can act on a tap (`POST /api/update/apply`, MCP
`apply_update`; the status carries `platform`, `update_method`, `can_apply`, `update_how`):

| `update_method` | When | What Update now does |
|---|---|---|
| `automatic` | Railway | Nothing to do — the host installs new releases in its maintenance window. |
| `deploy_hook` | `CAIRN_DEPLOY_HOOK_URL` set | Generic option for a host that offers a redeploy webhook: POSTs the hook; the host rebuilds from the latest release. |
| `trigger_file` | the one-line installer (`CAIRN_UPDATE_METHOD=trigger-file`) | Writes `${DATA_DIR}/.cairn-update-requested` (`{requested_at}`); the host updater removes it, updates, and reports in `${DATA_DIR}/.cairn-updater.json` (`{installed,last_run,last_result,version}` — flagged stale after 3 days). |
| `manual` | plain Docker or a source checkout | No button; the card shows the commands above. |

- `CAIRN_PLATFORM` — `railway` \| `installer` \| `docker`. Unset, Cairn detects
  Railway (`RAILWAY_ENVIRONMENT_ID`/`RAILWAY_PROJECT_ID`),
  else `docker` when `/.dockerenv` exists, else `source`.
- `CAIRN_DEPLOY_HOOK_URL` — the host's deploy hook (https only; anything else is ignored). It is
  a credential: it never leaves the server, in any status, error or log line.
- `CAIRN_UPDATE_METHOD=trigger-file` — use the data-folder trigger file regardless of platform.

### Signing devices in (sessions, pairing codes, passkeys)

With `CAIRN_AUTH_TOKEN` set, a browser signs in **once** and then carries its own HttpOnly
`cairn_session` cookie (180 days, sliding; `Secure` whenever the request arrived over HTTPS). The
master token never lives on a device. Ways in, from the sign-in screen:

- **Passkey** — Face ID / fingerprint, offered once after a device's first sign-in and under
  **Settings → Devices**. Needs an `https://` address (or `localhost`).
- **Pairing code** — **Settings → Devices → Pair a device** on a signed-in device mints a one-time
  code (`XXXX-XXXX`, ten minutes, works once) and shows it as a QR of
  `https://<your-cairn>/#pair=XXXX-XXXX` plus the code in text. The code rides the URL *fragment*,
  which no server or proxy ever logs, and the shell exchanges it for that device's own session.
  Wrong codes are rate limited per address, and ten misses anywhere close pairing for 15 minutes.
- **Access token** — the recovery path: paste `CAIRN_AUTH_TOKEN` itself.

**Links that leave the app.** A report, a record's file or a download opens on a two-minute signed
link (`?sig=`, one path, GET only), so the Safari tab an iOS Home Screen app opens it in needs no
sign-in of its own. A calendar subscription (Train → Plan → Subscribe) carries its own long-lived,
read-only link that opens `plan.ics` and nothing else; **Settings → Devices → Reset calendar link**
retires it (subscribed calendars stop updating until re-subscribed).

API clients keep sending `Authorization: Bearer <CAIRN_AUTH_TOKEN>`; an AI app should rather get
its own access (next section). A script can mint a pairing code the same way:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CAIRN_AUTH_TOKEN" https://<your-cairn>/api/auth/pairing-codes
# → {"code":"ABCD-EFGH","expires_at":"…"}; open https://<your-cairn>/#pair=ABCD-EFGH on the device
```

**First device without a terminal.** While the token is set and nobody has signed in yet (no
device, no passkey), every boot mints a one-hour first-sign-in code and logs one line — the only
log line that ever carries a code: `First sign-in: open https://<domain>/#pair=XXXX-XXXX (expires in
60 min, works once)` (the domain comes from `RAILWAY_PUBLIC_DOMAIN`; elsewhere it says "your Cairn
address"). Once any device or passkey exists, the access token has signed anything in, or the
install has already been set up (an upgrade from a build before device sign-in), nothing is logged
(and no code is minted). That line reaches whatever reads the service's logs — a platform log
viewer, a log drain, a log shipper — so it is a live credential for its hour; set
`CAIRN_FIRST_SIGNIN_LOG=0` to never mint or print it (then sign in with the access token).

The sign-in screen also says where the token lives. Until anyone has signed in, the public
`/api/health` carries a small `first_visit` object (the platform, a Railway link to the service's
Variables tab, whether the log line above is on) and the screen shows a "First time here?" note from
it. It never carries a token or a code.

**Retired:** the older `/?pair=<token>` link (it put the master token in a URL). It no longer signs
anything in: the shell strips it from the address bar at once, never sends or stores it, and the
sign-in screen says "That sign-in link is retired — use a pairing code or your access token." If an
old link with your token was ever shared or bookmarked, rotate the token (below). A token an older
build stored in the browser is still swapped for a session cookie once on the next open, then
deleted from the device.

**Recovery.**

- *Lost every device:* open Cairn, choose **Use your access token**, paste `CAIRN_AUTH_TOKEN` from
  your host's settings (Railway → Variables, or the `.env` next to your install).
- *Lost one device:* **Settings → Devices → Sign out** on it. Every passkey that device could still
  hold goes too — bound to it, added by it, or last used to sign it in (a synced passkey lives on
  every device of its account) — and the confirm sheet names them first. **Sign out other devices**
  ends every session but the one you are holding and removes every passkey not tied to this device
  (including one added with the access token alone). A device signed out is never brought back:
  signing that browser in again makes a new device row.
- *Rotate the master token = evict everyone:* change `CAIRN_AUTH_TOKEN` in the environment and
  redeploy/restart. The database remembers a salted fingerprint of the token it last booted with
  (never the token); the first boot with a different value signs EVERY device out and deletes
  every passkey, pending pairing code and the calendar subscription link — each was minted on the
  old token's authority — and logs one line:
  `Access token changed — every device was signed out; sign in again.` Sign each browser in again
  with the new token (or a pairing code from the first one you sign in), add passkeys again, give
  API/MCP clients the new value, and re-subscribe calendars (Train → Plan → Subscribe). Apple Health
  connections are separate credentials: reset them in Settings if they may have leaked too.
  Connected AI apps (MCP keys and sign-ins, below) are disconnected by the rotation as well.

### Behind a reverse proxy

A signed-in browser's writes must come from the address Cairn itself sees: the request's `Origin`
(else `Referer`) host is compared with its `Host` header — and with `X-Forwarded-Host` too, but only
when the proxy hop is trusted. A proxy that rewrites `Host` to the upstream (`localhost:8787`) makes
every save fail `403 origin_mismatch` (the app says so instead of saving). Either:

- **preserve `Host`** — nginx: `proxy_set_header Host $host;` (Caddy and Traefik pass it by default), or
- **trust the proxy** — `CAIRN_TRUST_PROXY=1` (the number of proxy hops in front of Cairn; Railway is
  detected automatically). Then `X-Forwarded-Host` and `X-Forwarded-Proto` count, and per-IP limits
  key on the client address in `X-Forwarded-For` rather than the proxy's.

Without a trusted hop, every visitor shares the proxy's address for rate limits and pairing-code
lockouts; the first request that arrives carrying `X-Forwarded-For` logs one warning saying so. Only
set `CAIRN_TRUST_PROXY` when a proxy really sits in front: a client that reaches the port directly
could otherwise pick its own address.

### Connect an AI app (MCP)

Cairn's MCP endpoint is `https://<your-cairn>/mcp` (Streamable HTTP). With `CAIRN_AUTH_TOKEN` set,
each AI app gets its **own** access, listed under **Settings → Devices → Connected AI apps** with
when it was last used and a **Disconnect**. None of it opens `/api`, and signing devices out never
touches it.

- **The Claude app, ChatGPT, or any app with "Add custom connector":** paste
  `https://<your-cairn>/mcp`. The app registers itself, opens Cairn in your browser, you sign in if
  asked (passkey, pairing code or the token, as above) and tap **Allow**. That is OAuth 2.1 with
  PKCE: the app holds a one-hour access token and a rotating refresh token, both bound to `/mcp`.
  It needs an `https://` address (or `localhost`); behind a TLS proxy, set `CAIRN_TRUST_PROXY` so
  Cairn sees the https scheme (Railway is detected automatically).
- **Claude Code, or a client configured by file:** **New key for an app** shows a key once
  (`cairn_mcp_…`) with copy-ready setup and a **Test connection**:

  ```bash
  claude mcp add --transport http cairn https://<your-cairn>/mcp --header "Authorization: Bearer cairn_mcp_…"
  ```

  Other clients take the same URL and header in their `mcpServers` JSON. Keys are stored only as a
  hash; a lost key is disconnected and replaced, never recovered.

The master token still opens `/mcp` too, but a per-app key or a sign-in is the better habit: one
app can be cut off without changing anything else. With sign-in off, `/mcp` is open to anything that
can reach the port, and none of this applies.

### Feedback and the opt-in usage ping

- `CAIRN_FEEDBACK_URL` — base URL of the feedback service (`POST {base}/v1/feedback`, and
  `POST {base}/v1/ping` for the opt-in ping). Unset, it is the project's own service,
  `https://feedback.cairn.fit` (`DEFAULT_FEEDBACK_URL` in `src/feedback.ts`; source in
  `services/feedback/`). Point it at your own deployment, or set it to `""` for none: **Send
  feedback** then sends nothing and opens a prefilled GitHub issue for you to review and submit
  yourself, and the usage ping stays inert. Every compose file passes it through
  (`${CAIRN_FEEDBACK_URL-…}`, so an explicit empty value in `.env` reaches the app). What each one
  sends is in `docs/OBSERVABILITY.md` ("Feedback and the usage ping"); every outbound connection is
  in `docs/HOSTING.md` ("What leaves your install").

## The Update / Deploy Flow

From a source checkout:

```bash
git pull
CAIRN_BUILD_SHA="$(git rev-parse HEAD)" docker compose up -d --build
```

The SHA is exposed separately from the release version by health/readiness and
operator diagnostics. See [`OBSERVABILITY.md`](OBSERVABILITY.md) for telemetry,
retention, privacy, performance aggregates, and smoke-process containment.

From a published image, update the image tag in `docker-compose.yml` or pull the latest tag:

```bash
docker compose pull
docker compose up -d
```

If the only thing you want is fresh selected agent CLIs:

```bash
docker compose exec -u app cairn cairn-update-agent-clis claude codex
```

Either way: on every boot `runMigrations()` (called at the bottom of `src/db.ts`) reads
`PRAGMA user_version` from the mounted DB and runs any migrations whose version number is
higher — then updates `user_version`. The container can restart safely at any time; the
volume holds the DB across image rebuilds.

Watch the logs to confirm migrations ran (or were skipped because the DB is already current):

```bash
docker compose logs -f cairn
```

### Did the installed app pick it up?

An installed PWA runs the shell its service worker precached, so a deploy is live on a phone
only once that worker has updated (it does so on the next open or resume, then reloads once).
To check a device, open **Settings → Data → Cairn version**: *Server build* is the running
server's `version@build_id`, and *This app's shell* is the cache name the device's worker holds.
Compare them with the server's own view:

```bash
curl -s http://<host>:8787/api/health   # build.build_id and shell
```

The build ids always agree (both come from the server); the shells agree once the installed app
has the new shell. Until then Settings says a newer shell lands the next time Cairn opens.

### Changing the app icon, name or theme color

An installed app keys its icon cache on the icon URL, so a new icon ships under new URLs. Every
icon URL carries one shared `.vN` suffix, and five places move together: the files in
`public/icons/`, `public/manifest.json` (icons and shortcuts), `public/index.html`
(apple-touch-icon and friends), the precache lists in `public/sw.js`, and `APP_IDENTITY_VERSION`
in `src/client/app-identity-model.ts`. Never edit the suffix by hand:

1. Replace the icon bytes in `public/icons/`, keeping the current `.vN` file names.
2. Run `node scripts/bump-icons.mjs` (add `--theme-color "#rrggbb"` and/or `--short-name "Name"`
   when those change alongside the icon; `--dry-run` shows what would move, `--check` only verifies the places
   agree). The long `name`/`description` in the manifest and `index.html` are edited by hand in the
   same commit.
3. `npm run build`, then commit the renamed icons together with the four rewritten files.

A theme-color change with no new icon bytes does not run `bump-icons`: its version bump asks iOS
installs to re-add for nothing. Edit the manifest's `theme_color`/`background_color` and the light
`theme-color` meta in `public/index.html` together by hand (the dark meta is the dark `--ground`),
then confirm with `node scripts/bump-icons.mjs --check`. `docs/DESIGN.md` "Dark" has the rule.

The manifest's `id`, `scope` and `start_url` never change, and neither do the `localStorage`
keys; `test/pwaInstallIdentity.test.js` pins all of it. Chrome and Android refresh the icon on
their own (the worker serves `/manifest.json` network-first). An iOS home-screen app keeps the
icon and name it was added with, so bumping `APP_IDENTITY_VERSION` turns on a one-time, optional
note in standalone iOS installs (only when nothing waits to sync) explaining that re-adding the app
refreshes them and listing what must be re-entered. Signing in is not on that list: a re-added
Home Screen app signs in on its own with a passkey or a pairing code (**Settings → Devices → Pair a
device** on another signed-in device).

### Rollback

Redeploy the previous image tag:

```bash
docker compose down
# edit docker-compose.yml image tag, or:
docker tag cairn:previous cairn:latest
docker compose up -d
```

Migrations are **forward-only**. If a schema change must be undone, restore a pre-upgrade
backup (see Backups below) rather than trying to reverse the migration.

---

## Upgrading from 2.0.x to 2.1.x

An in-place upgrade of the same image and volumes. Take a backup first, because migrations are
forward-only (see Backups below), then pull the new image and restart. The migrations (120–128; 2.1.2 adds 128) run
on boot. Two behaviours change:

- **Models are now the CLI's own default.** If you relied on Cairn picking sonnet, opus or fable,
  choose Everyday and Deep work models in **Settings → Agents** to keep them.
- **Feedback now defaults to `https://feedback.cairn.fit`** (only when you press Send). Set
  `CAIRN_FEEDBACK_URL=off` to turn the feedback service off; feedback then opens a GitHub issue.

---

## Upgrading from v1.x to v2.0.0

v2 is an in-place upgrade of the same app, image and data volumes. There is nothing to export or
re-enter, but take a backup first, because migrations are forward-only.

1. **Back up.** Follow [Backups & restore](#backups--restore): a `VACUUM INTO` snapshot is the
   cleanest restore source, and the volume-level backup also keeps CLI logins. Note the image tag
   you are running now (for example `ghcr.io/zilet/cairn:v1.9.1`) so you can go back to it.
2. **Update the image** as in [The Update / Deploy Flow](#the-update--deploy-flow), pinned to
   `ghcr.io/zilet/cairn:v2.0.0` (or `:latest`).
3. **Migrations run on their own** at boot (`runMigrations()`); there is no step to run by hand.
   v1.9.1 shipped through schema v113, and v2.0.0 adds six, all small:

   | Version | Name | Effect |
   |---|---|---|
   | 114 | `settings-meal-plan-auto-draft` | Adds `settings.meal_plan_auto_draft`, default off. |
   | 115 | `bodyweight-exact-double-submits` | Data repair: folds identical same-day weigh-ins entered within ten minutes. |
   | 116 | `food-note-person-edit-lock` | Adds `food_notes.person_edited_at`, so a person's edit is never overwritten by a late enrichment pass. |
   | 117 | `garmin-run-structure` | Adds run-structure columns to `garmin_activities` and fills them from data already stored. |
   | 118 | `garmin-laps-relabel` | Data repair: clears stored laps so the next Garmin sync refetches them correctly labelled. |
   | 119 | `exercise-input-profile` | Adds `exercises.input_profile` and `exercises.per_side`; existing exercises keep their derived behaviour. |

   Confirm in the logs (`docker compose logs cairn`) or with `npm run migrate`. There are no
   down-migrations.

**What changes for the person using it**

- **Navigation is five homes:** Today, Train, Horizon, Ask and You. Session, Fuel and any other
  day open from Today; the plan editor is Train's; the race view and goal line are Horizon's;
  Changes is in Ask. Every v1 link still works: `/app/<tab>/<section>` URLs are recognised and
  rewritten in place to their v2 form (for example `/app/plan/food` becomes `/app/today/fuel`,
  `/app/progress/weight` becomes `/app/train/weight`, `/app/plan/coach` becomes `/app/ask/changes`).
  The table is `src/contracts/client-routes.ts` and is pinned by `test/routeState.test.js`.
- **Meal-plan auto-drafts are off.** Cairn no longer drafts a weekly meal plan on its own; ideas
  arrive when asked for. To get the old behaviour back, turn on the automatic meal-plan drafts
  setting (`meal_plan_auto_draft`).
- **The team now decides and announces** kinds of change that used to wait for approval, with
  Undo in the Changes feed. Clinical, locked and irreversible changes still ask. Anything that was
  waiting at the upgrade is re-checked against the current plan first, never applied blindly.

**Installed apps update in place.** The manifest `id`, `scope` and `start_url`, and the browser
storage keys (including the token and any unsent outbox), are unchanged, so a phone with Cairn
installed picks up v2 on its next open and keeps everything. Chrome and Android also refresh the
new icon and name. An iOS home-screen app keeps the icon and name it was added with; re-adding it
refreshes them but starts with empty storage, so a standalone iOS install shows one optional
note about this. A re-added app signs in on its own with a passkey or a pairing code
(**Settings → Devices → Pair a device**); the access token never needs to go on the phone. See [Did the installed app pick it up?](#did-the-installed-app-pick-it-up) to verify.

**Rollback.** Stop the service, restore the pre-upgrade backup into the data volume
([Restore](#restore)), and start the previous image tag you noted in step 1. Do not run the old
image against a database that v2 has already migrated: the schema is ahead of what v1 expects.

---

## How migrations work

`src/migrate.ts` is the **runner**, not the ladder. It exports:

- `MIGRATIONS` — the ordered array of `{ version: number, name: string, up(db) }` entries,
  concatenated from the range files under `src/migrations/`.
- `runMigrations(db)` — reads `PRAGMA user_version`, runs every entry whose `version` is
  greater, then sets `user_version` to the highest applied version.

The entries themselves live in `src/migrations/v001-050.ts`, `src/migrations/v051-100.ts` and
`src/migrations/v101-150.ts` — **append a new migration to the range file that covers the next
version**. The entry shape and the `addColumn` / `hasTable` DDL helpers are in
`src/migrations/helpers.ts` (re-exported from `src/migrate.ts`, so an older import path still
works). `src/migrations/frozen/` holds byte-frozen copies of the transforms four data-repair
migrations need: a shipped repair must keep computing what it computed on the day it ran, so those
files are **never edited or reformatted** (biome ignores the directory).

The authoritative, ordered list and current version live in those range files — kept there rather
than duplicated here so they cannot drift. Run `npm run migrate` to print the current version and
apply any pending migrations.

Every migration is additive and idempotent — an `ALTER TABLE … ADD COLUMN` wrapped in try/catch (so
re-running is a no-op), plus a couple of `CREATE INDEX IF NOT EXISTS`. None backfill or drop data, so
existing rows need no manual step — just deploy and let boot apply them. Brand-new tables
(`health_documents`, `context_events`, `checkins`, `daily_metrics`, `family_members`,
`health_directives`, `insights`, `daily_session_compositions`, and the `art_*` cache tables) are created via
`CREATE TABLE IF NOT EXISTS` on boot, so they need no migration entry. Down-migrations are not
supported — **back up before deploying a schema change** (see Backups below). Boot also takes an
[automatic pre-migration snapshot](#automatic-pre-migration-snapshots) whenever a migration is
pending.

**Uploaded files.** Health-document uploads (bloodwork/DEXA/etc.) are written to `data/uploads/`
inside the mounted `cairn-data` volume — so they survive rebuilds and are captured by the same
volume backup as the DB. The JSON export (`/api/export`) includes data records, including active
and superseded daily-session composition history, plus parsed markers and summaries, but NOT raw
binaries. It is an export only: Cairn has no JSON-import or JSON-restore endpoint. Rely on the
SQLite snapshot or volume backup for restore, and on the volume backup for uploaded files.
`data/art/` (generated artwork PNGs, see `src/art.ts`) is a regenerable cache — safe to exclude
from backups; missing images are simply re-generated on demand.

`runMigrations` is called automatically on every boot (end of `src/db.ts`). It can also be
run manually:

```bash
npm run migrate         # against the local ./data/cairn.db
DB_PATH=/tmp/copy.db npm run migrate   # against a copy, for testing
```

### How to add a schema change

1. Open the range file covering the next integer version (`src/migrations/v101-150.ts` for
   versions 101-150). Append an entry with the next version:

   ```ts
   {
     version: 4,
     name: "my_new_column",
     up(db) {
       try {
         db.exec("ALTER TABLE some_table ADD COLUMN my_col TEXT");
       } catch {}   // swallows "duplicate column" on DBs that already have it
     },
   }
   ```

   Each `up` must be **additive and idempotent** — add columns or tables, never drop or
   rename without a data-preserving strategy.

2. Also add the column to the matching `CREATE TABLE IF NOT EXISTS` in `src/db.ts` so
   freshly seeded DBs get it from the start. This is the **two-step**, and `npm run schema:check`
   (`scripts/check-schema-two-step.mjs`, part of `npm run verify`) enforces it: it reads the
   migration files and `src/db.ts` statically and fails when a migrated column never reaches a
   create block, or when two branches claim the same version number.

3. Test locally against a **copy** of the prod DB before deploying:

   ```bash
   cp data/cairn.db /tmp/cairn-copy.db
   DB_PATH=/tmp/cairn-copy.db npm run migrate
   ```

4. Deploy with the normal `docker compose build && docker compose up -d` — migrations run
   automatically against the mounted volume.

Down-migrations are not supported. Back up before any schema change you may want to revert.

---

## Backups & restore

### App-level (recommended for schema changes)

The two export endpoints are available from the **Settings tab** in the PWA, via `curl`, or
via `npm run backup`:

```bash
# Portable JSON data export (curated application data; not a restore format)
curl -fsS http://localhost:8787/api/export -o cairn-export.json
npm run backup     # same, saves to ./cairn-export.json

# Clean SQLite file via VACUUM INTO (best for restore)
curl -fsS http://localhost:8787/api/export/db -o cairn-snapshot.db
```

The VACUUM INTO SQLite snapshot is the restore artifact: it is a single consistent file with the
WAL checkpointed in and is safe to copy without stopping the container. Private runtime secrets, including the key used to compare
DICOM patient identity without storing Patient ID, live only inside SQLite: they survive this DB
snapshot and volume backups but are intentionally excluded from the JSON export. Restore the
SQLite snapshot when DICOM studies must continue accepting later instances under the same private
identity.

### Volume-level (full backup including OAuth tokens)

Run this from the Docker host while the container is up:

```bash
docker run --rm \
  -v cairn-data:/data \
  -v "$PWD":/backup \
  busybox tar czf /backup/cairn-data-$(date +%F).tgz -C /data .
```

To back up both durable state volumes (`cairn-tools` is intentionally omitted):

```bash
for vol in cairn-data cairn-home; do
  docker run --rm -v "$vol":/src -v "$PWD":/backup \
    busybox tar czf /backup/"$vol"-$(date +%F).tgz -C /src .
done
```

### WAL note

If you copy the raw `.db` file directly (not via `VACUUM INTO` or the export endpoint),
**stop the container first** so the WAL is flushed:

```bash
docker compose stop
cp /var/lib/docker/volumes/cairn-data/_data/cairn.db ./cairn.db.bak
docker compose start
```

Prefer the VACUUM INTO snapshot (`/api/export/db`) which handles this automatically.

### SQLite connection settings

`src/db.ts` opens the one connection with `journal_mode=WAL`, `foreign_keys=ON`, and a tuning set
chosen for a single-writer app on slow flash (a Pi's SD card or USB SSD): `synchronous=NORMAL`,
`busy_timeout=5000`, `temp_store=MEMORY`, a 16 MB page cache and a 256 MB mmap window. In WAL mode
`synchronous=NORMAL` still guarantees the file can never be corrupted and a committed write
survives a process crash; only a hard power cut inside the fsync window can roll back the last
transaction or two — SQLite's own recommendation for WAL, and it removes one fsync per commit.
`busy_timeout` is what lets a one-off read-only query against the live file (or the test
harness's parallel processes) wait for the writer instead of failing with "database is locked".
None of these persist in the file; they are per-connection and re-applied on every boot.

### Automatic pre-migration snapshots

When boot finds pending migrations on an existing database (`user_version` above 0 and below the
ladder's top), it first writes a `VACUUM INTO` copy of the untouched file to
`${DATA_DIR}/backups/pre-migration-v<from>-to-v<to>-<timestamp>.db`
(`src/migrationSnapshot.ts`). It keeps the newest three files with that prefix and never touches
anything else in `backups/`. A fresh database, an up-to-date one and an in-memory one are never
copied, so an ordinary restart costs one PRAGMA read. If the snapshot cannot be written (for
example, a full disk), boot logs a warning and migrates anyway. Set
`CAIRN_REQUIRE_MIGRATION_SNAPSHOT=1` to refuse to migrate instead.

To roll back a bad upgrade, restore the snapshot and run the image tag you upgraded **from**. If
you start the restored file on the new image, boot just migrates it again.

```bash
docker compose stop
docker run --rm -v cairn-data:/data busybox ls -l /data/backups      # pick the file
docker run --rm -v cairn-data:/data busybox sh -c \
  "rm -f /data/cairn.db-wal /data/cairn.db-shm && cp /data/backups/pre-migration-v118-to-v119-<timestamp>.db /data/cairn.db"
# set the image tag back to the release you upgraded FROM, then:
docker compose up -d
```

On a hosting platform, use the platform's shell (or its volume-restore feature) to perform the
same copy, then redeploy the previous image tag.

### Restore

1. Stop the container:
   ```bash
   docker compose stop
   ```

2. Restore from a tar backup:
   ```bash
   docker run --rm \
     -v cairn-data:/data \
     -v "$PWD":/backup \
     busybox sh -c "cd /data && tar xzf /backup/cairn-data-YYYY-MM-DD.tgz"
   ```

   Or copy a `.db` snapshot directly into the volume. Delete any leftover WAL/SHM
   sidecar files first — a stale `-wal` from the *old* DB would be replayed against
   the restored file and corrupt it:
   ```bash
   docker run --rm \
     -v cairn-data:/data \
     -v "$PWD":/backup \
     busybox sh -c "rm -f /data/cairn.db-wal /data/cairn.db-shm && cp /backup/cairn-snapshot.db /data/cairn.db"
   ```

3. Start the container:
   ```bash
   docker compose start
   ```

`runMigrations()` will run on boot and bring the schema up to date if the restored DB is
from an older version.

## Build & test tooling — validated decisions

The dev loop's cost is the server `tsc` build, the per-file client transpile, the client
typecheck, and the test suite — all incremental (`.tsbuildcache/*`) and parallel
(`scripts/run-verify.mjs` runs independent gates in staged groups; `test/run.mjs` shards
test files across worker processes). Alternatives were evaluated empirically so the
question doesn't get re-litigated:

- **Turborepo / Nx** — not applicable. Cairn is a single npm package, not a monorepo, so
  there is no multi-package task graph to cache; the equivalent (parallel gates +
  incremental `tsc` + a sharded test runner) is hand-rolled here and dependency-free.
- **bun** as the runtime or test runner — impossible. Cairn is built on `node:sqlite`
  (the built-in unflagged from Node 24); bun does not provide it, so the app and its tests can
  only run under Node.
- **pnpm** — marginal. ~11 direct deps; install is not a bottleneck, and switching only
  churns the lockfile with no offsetting win. Keep npm + `package-lock.json`.

Runtime boot is also cheap by construction: the image sets `NODE_COMPILE_CACHE` under the
`cairn-home` volume, so a restart (deploy, watchdog, reboot) reuses the V8 bytecode compiled by
the previous run for the ~400 server modules instead of re-parsing them on a Pi core. The cache
is keyed by Node version and file content, so a new image simply misses once and rewarms, and an
unwritable directory makes Node run uncached rather than fail.

The real wins were structural, not tooling swaps: the suite wipes the DB before every
test (`test/_isolate.mjs`, injected via `--import`) so correctness is independent of
worker count and file order, and the worker default scales with cores (`min(8, cores-1)`).

**Per-route perf budget.** `npm run perf:check` (after `npm run build`) is the browser-side
twin of the bundle byte budget. It boots the built server on a throwaway data dir with the demo
seed and offline agents, then opens every home and leaf route in headless Chrome at a 390px
viewport with CPU 4x and slow 4G, cold (fresh browser context) and warm (the service worker
installed), three runs each. It **gates** only on measures that do not move with machine speed —
`/api` calls per load, zero duplicate GET URLs, serial request rounds (the dependency depth read
from request start/end order), CLS, the JS/CSS bytes a cold load transfers, and no visible
skeleton left once the route reads ready — against the median run and the checked-in
`scripts/perf-budget.json`. FCP, first content and ready are **reported** beside the proposed
per-group targets and only flagged past +30%. A route whose budget sits above its target is
listed as a miss on every run, so a loosened budget is never silent; raise one deliberately with
`node scripts/check-perf.mjs --update`. `--only today,ask`, `--runs 1` and `--json <file>`
narrow or keep a run. It needs Chrome (`CHROME_BIN` overrides discovery), so `npm run verify`
runs it only with `CAIRN_PERF=1`, and CI runs it as its own non-blocking job.

One gotcha: the `npm run format` script hardcodes `biome format --write .` (the whole
repo, which is not biome-clean at rest) — to format only the files you touched, run
`./node_modules/.bin/biome format --write <files>` directly.

## Scripts

Every script under `scripts/`, one line each (from its own header comment):

| Script | What it does |
|---|---|
| `benchmark-chat-routing.mjs` | Deterministic, offline policy benchmark for the pure adaptive-chat classifier. No CLI, network, database, or provider calls. |
| `bump-icons.mjs` | Moves the installed app's identity (icon set, optionally short name and theme color) to the next `.vN` in one step: renames `public/icons/*.vN.*` and rewrites `manifest.json`, `index.html`, `sw.js` and `APP_IDENTITY_VERSION` together; `--check` verifies they agree. |
| `build-client.mjs` | Compiles the dependency-free browser client slices from `src/client` into stable `public/js` filenames (no bundler, no runtime deps). |
| `backup-example.sh` | Template backup script for a running Cairn instance: pulls a JSON export and a `VACUUM INTO` SQLite snapshot, rotates old copies. Copy and adjust for cron. |
| `check-action-pins.mjs` | Verifies GitHub Actions workflow steps are pinned to commit SHAs, not moving tags. |
| `check-bundle-budget.mjs` | Per-bundle byte budget (raw and brotli, `public/styles.css` included) against the checked-in `scripts/bundle-budget.json`, run in `npm run verify` after the build; fails with the delta when a bundle grows past it. Two fixed eager ceilings (every script `index.html` loads — bundles, `art.js`, the body figure — ≤220 KB brotli, the stylesheet ≤70 KB) sit on top and are never raised by `--update`, which re-measures and rewrites the per-bundle budget for a deliberate raise; `--report` lists each bundle's largest inputs. |
| `check-perf.mjs` | Per-route load budget in headless Chrome (390px, CPU 4x, slow 4G, cold and warm) against `scripts/perf-budget.json`: gates `/api` calls, duplicate GETs, serial request rounds, CLS, cold JS/CSS bytes and leftover skeletons; reports FCP / first content / ready. `npm run perf:check`; in `npm run verify` only with `CAIRN_PERF=1`. |
| `check-client-build-output.mjs` | Guards that every served `public/js` bundle can be recreated from TypeScript sources in a fresh checkout (generated output is gitignored). |
| `check-launch-safety.mjs` | Guards the public quickstart docs from regressing to an internet-footgun: copy-paste `docker run` blocks must bind loopback unless deliberately widened. |
| `check-public-scripts.mjs` | Guards the classic browser app-shell script graph against global-scope hazards (duplicate top-level bindings across `<script>` tags). |
| `check-sw-cache.mjs` | CI guard for the app-shell precache contract: the `CACHE` placeholder is intact, `CORE_ASSETS` mirrors the bundle manifest, and `index.html` loads exactly the non-lazy bundles. The version itself is derived at serve time (`src/swVersion.ts`). |
| `container-tool.sh` | Shared shell function resolving which container engine (Docker, Podman, or Apple's `container`) and Compose front-end this machine has, by binary rather than shell alias. Sourced by `quickstart.sh`, `quickstart-rpi.sh`, and `setup-phone.sh`. |
| `docker-entrypoint.sh` | Container entrypoint: starts as root to fix mounted-volume ownership, then drops privileges to the unprivileged `app` user before running the main process. |
| `gen-docs.mjs` | Generates `docs/API.md` and `docs/MCP-TOOLS.md` straight from route/tool registrations in source, via `npm run docs:index`, so they never drift. |
| `gen-prevent-coefficients.mjs` | One-off generator that reads the validated AHA PREVENT (2023) coefficient artifact (gitignored, external) and emits the typed `src/repo/prevent-coefficients.ts`; betas are never hand-transcribed. |
| `install-agent-cli.mjs` | Installs or updates a pinned third-party coaching CLI (npm exact version, or a checksum-verified vendor script installer) — see `SECURITY.md`. |
| `quickstart-rpi.sh` | Guided Cairn setup for a Raspberry Pi (arm64); strongly recommends a container engine over direct Node, since the Pi's host Node is usually too old. |
| `run-verify.mjs` | Runs `npm run verify`'s independent gates (docs, actions, launch safety, and more) in parallel staged groups. |
| `setup-phone.sh` | Puts Cairn on your phone privately in one step via Tailscale Serve, degrading gracefully to manual instructions if anything is missing. |
| `smoke-browser.mjs` | Dependency-free browser smoke test for the generated PWA app shell via local Chrome + CDP; a release/manual gate, not part of `npm run verify`. |
| `smoke-server.mjs` | Shared helper module (server entrypoint, `withServer`, the offline agents table and the demo race seed) imported by `test/smoke.mjs`, `smoke-browser.mjs`, `capture-screens.mjs` and `check-perf.mjs`; not run directly. |
| `update-agent-clis.sh` | Stable `cairn-update-agent-clis` entrypoint wrapper that execs `install-agent-cli.mjs`, so every install/update command is an argv array with no shell interpolation. |
