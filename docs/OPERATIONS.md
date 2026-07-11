# Cairn — Operations & Update Playbook

Practical reference for deploying, updating, migrating, backing up, and restoring Cairn on a
Docker host. Cairn is single-user and has no built-in auth; keep it on localhost, a LAN,
Tailscale/VPN, or another trusted private network.

---

## Architecture of state

Persistent state and optional tools live in three named Docker volumes. Nothing important lives in the container
image itself.

| Volume | Mounted at | Contents |
|---|---|---|
| `cairn-data` | `/data` | `cairn.db` + `-wal` + `-shm` (SQLite WAL files) |
| `cairn-home` | `/home/app` | Provider login directories |
| `cairn-tools` | `/home/app/.cairn-tools` | Optional provider binaries; regenerable, omitted from backups |

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
Docker defaults to `TZ=America/New_York`. Set `TZ` in `.env` to the user's local timezone if weekly
auto-coach is enabled; the scheduler uses container-local `getDay()` / `getHours()` for the
configured day and hour. For Belgrade, use `TZ=Europe/Belgrade`.

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

## How migrations work

`src/migrate.ts` exports:

- `MIGRATIONS` — an ordered array of `{ version: number, name: string, up(db) }` objects.
- `runMigrations(db)` — reads `PRAGMA user_version`, runs every entry whose `version` is
  greater, then sets `user_version` to the highest applied version.

The authoritative, ordered list lives in `src/migrate.ts` (`MIGRATIONS`) — kept there rather than
duplicated here so it can't drift. As of this writing the schema is at **user_version 49**; run
`npm run migrate` to print the current version and apply any pending ones.

Every migration is additive and idempotent — an `ALTER TABLE … ADD COLUMN` wrapped in try/catch (so
re-running is a no-op), plus a couple of `CREATE INDEX IF NOT EXISTS`. None backfill or drop data, so
existing rows need no manual step — just deploy and let boot apply them. Brand-new tables
(`health_documents`, `context_events`, `checkins`, `daily_metrics`, `family_members`,
`health_directives`, `insights`, and the `art_*` cache tables) are created via
`CREATE TABLE IF NOT EXISTS` on boot, so they need no migration entry. Down-migrations are not
supported — **back up before deploying a schema change** (see Backups below).

**Uploaded files.** Health-document uploads (bloodwork/DEXA/etc.) are written to `data/uploads/`
inside the mounted `cairn-data` volume — so they survive rebuilds and are captured by the same
volume backup as the DB. The JSON export (`/api/export`) includes the
parsed markers + summaries but NOT the raw binaries; rely on the volume backup for the files.
`data/art/` (generated artwork PNGs, see `src/art.ts`) is a regenerable cache — safe to exclude
from backups; missing images are simply re-generated on demand.

`runMigrations` is called automatically on every boot (end of `src/db.ts`). It can also be
run manually:

```bash
npm run migrate         # against the local ./data/cairn.db
DB_PATH=/tmp/copy.db npm run migrate   # against a copy, for testing
```

### How to add a schema change

1. Open `src/migrate.ts`. Append a new entry to `MIGRATIONS` with the next integer version:

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
   freshly seeded DBs get it from the start.

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
# Full JSON snapshot (all tables serialised)
curl -fsS http://localhost:8787/api/export -o cairn-export.json
npm run backup     # same, saves to ./cairn-export.json

# Clean SQLite file via VACUUM INTO (best for restore)
curl -fsS http://localhost:8787/api/export/db -o cairn-snapshot.db
```

The VACUUM INTO snapshot is a single consistent file with the WAL checkpointed in — safe to
copy without stopping the container.

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
  (the unflagged Node 24 built-in); bun does not provide it, so the app and its tests can
  only run under Node.
- **pnpm** — marginal. ~11 direct deps; install is not a bottleneck, and switching only
  churns the lockfile with no offsetting win. Keep npm + `package-lock.json`.

The real wins were structural, not tooling swaps: the suite wipes the DB before every
test (`test/_isolate.mjs`, injected via `--import`) so correctness is independent of
worker count and file order, and the worker default scales with cores (`min(8, cores-1)`).

One gotcha: the `npm run format` script hardcodes `biome format --write .` (the whole
repo, which is not biome-clean at rest) — to format only the files you touched, run
`./node_modules/.bin/biome format --write <files>` directly.
