# Contributing to Cairn

Thanks for your interest in Cairn — a self-hosted, single-user training /
nutrition / health coaching app (Node + TypeScript, a REST API + MCP server + a
dependency-free vanilla PWA, all from one process, with SQLite via
`node:sqlite`). This guide distills the conventions that keep the codebase
coherent. Please skim it before opening a PR.

## Before you change product behavior

The product north-star / constitution — the "calm, suggestion-not-a-gate,
no-scores, pull-never-push" rules every feature is held to — lives in
[`docs/VISION.md`](docs/VISION.md). **Read it before changing how the product
behaves.** (Its progress log is maintained separately; don't edit it as part of
code housekeeping.)

## Getting started

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for a five-minute first run. For deployment on a
home server or tailnet, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

```bash
npm install
npm run dev      # tsx watch on src/server.ts -> http://localhost:8787 (auto-seeds on first boot)
npm run build    # tsc -> dist/
npm test         # build + offline node:test suite
npm run reset    # delete data/cairn.db* and re-seed a fresh DB
```

## Hard requirements

- **Node 24 is mandatory.** That's where `node:sqlite` is unflagged. There's no
  native build step — don't add one.
- **ESM with explicit `.js` import extensions** (the `tsconfig` is `NodeNext`).
  When you import a sibling `.ts` module, write `from "./repo.js"`, **not**
  `"./repo"`. Match this in every new file.

## Architecture: two surfaces over one repo layer

The most important structural fact: **`src/api.ts` (REST) and `src/mcp.ts` (MCP)
are both thin, parallel adapters over the same `src/repo.ts`.** (`repo.ts` is now
a barrel that re-exports the domain modules under `src/repo/` — add new logic to the
matching module, exported through the barrel.) Business logic
belongs in `repo.ts` (or `src/prompt.ts` for prompt construction) — the two
surfaces should stay near-mirror wrappers.

> When you add a capability, expect to touch **all three**: `repo.ts` (the
> logic) plus both `api.ts` and `mcp.ts` (the wrappers). Keep them in sync.

### Where does my change go?

`src/repo.ts` is a **barrel** that re-exports the domain modules under `src/repo/`.
Put new data-access / domain logic in the matching module (don't grow the barrel):

| Area | Module |
|---|---|
| Exercises, the exercise guide | `src/repo/exercises.ts` |
| Plan editing, plan items, weekly runs | `src/repo/plan.ts` |
| Sessions, sets, autoregulation feedback | `src/repo/sessions.ts` |
| Profile, about-me, endurance goal, settings | `src/repo/profile.ts`, `src/repo/settings.ts` |
| Activities, bodyweight, Garmin rows | `src/repo/activities.ts` |
| Coach memory (self-updating store) | `src/repo/memory.ts` |
| Meal plans, recipes, expenditure | `src/repo/nutrition.ts` |
| Chat messages / turns history | `src/repo/chat.ts` |
| Health docs, markers, check-ins, family, context events | `src/repo/health.ts` |
| The connected brain (markers→directives propagation) | `src/repo/propagation.ts`, `src/repo/intelligence.ts` |
| Researched evidence / citations | `src/repo/evidence.ts` |
| `getCoachContext`, day-read assembly | `src/repo/coach.ts` |

Cross-cutting orchestration lives at the top of `src/`, not in `repo/`:

- **Prompt construction** → `src/prompt.ts` (every plan-shaping prompt; bound to the
  `docs/VISION.md` constitution).
- **Multi-step agentic ops both surfaces call** (session-suggest, nutrition check-in,
  meal swap, recipe, health review, insight) → `src/coachOps.ts`. The shared
  `runChosen(agent, prompt)` dispatch lives in `src/runChosen.ts`.
- **Agent subprocess plumbing** (spawn, JSON extraction, streaming, fallback, the
  in-app login bridge) → `src/agents.ts`, `src/agentLogin.ts`, `src/chatTurns.ts`.
- **Background work** → `src/enrich.ts` (free-text/health enrichment), `src/scheduler.ts`
  (proactive precompute), `src/garmin.ts` (sync).
- **Schema** → `src/db.ts` (tables) + `src/migrate.ts` (column migrations).

After adding a capability, regenerate the reference indexes and let the gates check
you wired it everywhere:

```bash
npm run docs:index   # refresh docs/API.md + docs/MCP-TOOLS.md
npm run verify       # build + test (incl. the MCP⊆REST parity check) + docs:check
```

## Database & migrations

The DB is a single shared `DatabaseSync` instance exported from `src/db.ts`; all
schema lives there as `CREATE TABLE IF NOT EXISTS`.

- **New table:** just add a `CREATE TABLE IF NOT EXISTS` to `src/db.ts`. No
  migration needed.
- **New column on an existing table:** two steps —
  1. Add the column to the matching `CREATE TABLE IF NOT EXISTS` in `src/db.ts`
     (so fresh DBs get it), **and**
  2. Append a new entry to the `MIGRATIONS` array in `src/migrate.ts` with the
     **next integer `version`** and an idempotent `up(db)` that runs the
     `ALTER TABLE … ADD COLUMN` inside a `try/catch` (so it's a no-op on DBs
     that already have the column).

`runMigrations(db)` runs automatically on every boot (it reads
`PRAGMA user_version`, applies pending migrations in order, then bumps the
version). You can also run it manually with `npm run migrate`.

**Down-migrations are not supported — back up before deploying schema changes.**

## The PWA cache version (don't forget this)

`public/` is dependency-free vanilla JS served by a cache-first service worker.

> **Any change to a file under `public/` MUST bump the `CACHE` version constant
> at the top of `public/sw.js` in the same commit.**

Skip this and installed PWA clients will keep serving stale assets forever — so CI
fails a PR that touches `public/` without bumping the cache (see the table above). The
visual contract (the "Atelier" design system) lives in `docs/DESIGN.md` — read it
before touching `styles.css` or view markup.

## Before you open a PR: `npm run verify`

One command runs everything CI will check on your PR:

```bash
npm run verify     # builds, runs the offline test suite, and checks generated docs are in sync
```

If it's green locally, the CI **Test** job should be green too. What CI enforces
(`.github/workflows/ci.yml`) — these are invariants that used to rely on a human
remembering:

| Check | What it catches | Fix |
|---|---|---|
| `npm test` | Logic/behavior regressions (builds `dist/` first) | Fix the failing test |
| `npm run docs:check` | `src/api.ts` / `src/mcp.ts` changed but the reference indexes weren't regenerated | `npm run docs:index` and commit `docs/API.md` + `docs/MCP-TOOLS.md` |
| `scripts/check-sw-cache.mjs` (PRs) | A file under `public/` changed but `public/sw.js`'s `CACHE` version wasn't bumped | Bump `const CACHE = "cairn-vNN"` in `public/sw.js` |

## Testing

There is a zero-dependency offline `node:test` suite. It builds first, runs
against throwaway temp databases, and does not call agent CLIs or the network:

```bash
npm test
```

Please make sure `npm test` passes before opening a PR. Keep this suite
**deterministic, offline, and fast** — it must not spawn a server or reach the
network.

### Testing platform-conditional code

A few code paths branch on `process.platform` (e.g. the in-app login PTY bridge in
`src/agentLogin.ts`, which spawns differently on Linux/Docker vs macOS). **Make the
branching logic a pure, platform-PARAMETERIZED function** (`ptyInvocationFor(platform,
…)`) and unit-test every platform's output from any host — don't gate the assertion on
`process.platform`. A macOS-only assertion left the Linux/Docker branch (the path that
actually ships) untested, and a regression in it passed local `npm test` yet failed the
Linux CI build. The pure function is the testable seam; the host-bound wrapper only adds
the runtime guards (e.g. "is python3 present").

For the agentic propose → apply coaching loop, the **`stub` agent** (defined in
`agents.json`) is the offline smoke-test path: it needs no API key and returns a
canned JSON proposal, so you can exercise the draft/apply flow without any
external CLI configured.

### HTTP smoke test (`npm run smoke`)

A separate, heavier smoke test boots the **built** server against a throwaway temp
DB and drives a few key REST flows end-to-end over HTTP (health, the deterministic
day-read, plan CRUD, set logging + session round-trip, export):

```bash
npm run smoke
```

It's intentionally **not** part of `npm test` (it spawns a server, so it's neither
as fast nor as hermetic). `presmoke` builds `dist/` first. It needs no API key —
every flow it asserts is deterministic and agent-independent — and it cleans up
the temp DB and the server process when it's done. Run it when you've touched the
API/PWA contract; it catches regressions the offline unit tests don't.

## Linting & formatting

[Biome](https://biomejs.dev) is configured (`biome.json`):

```bash
npm run lint     # biome lint .  (lint rules only, no writes)
npm run format   # biome format --write .  (formats in place)
```

A few notes so these stay useful rather than noisy:

- **The existing tree is not biome-formatted.** `npm run lint` will report
  formatter differences across most files — that's expected. **Do not run a
  tree-wide `npm run format`** in an unrelated PR; it would bury real changes and
  risk subtle breakage across the `public/js/` modules (formerly one ~10k-line
  `app.js`) and the `src/repo/` modules (formerly one large `repo.ts`).
  Format only the files your change touches.
- The config is tuned to **fit** the codebase, not fight it: 2-space indent, double
  quotes, semicolons, a 120-char line width, and a handful of lint rules turned off
  where the codebase uses a deliberate idiom (`noExplicitAny` — `as any` is used at
  trust boundaries on purpose; `noNonNullAssertion`; `useTemplate`;
  `useOptionalChain`). `public/sw.js` is excluded (its version constant is
  load-bearing); generated paths (`dist/`, `node_modules/`, `data/`) are ignored via
  `.gitignore`.
- Keep new code consistent with the surrounding style regardless — biome is an
  assist, not a gate.

## Pull requests

- Keep changes focused and proportionate.
- Match the existing style (`.js` import extensions, the repo-layer-first
  architecture, the migration procedure, the `sw.js` cache bump).
- Make sure `npm test` is green.
- Describe the user-facing behavior change and link `docs/VISION.md` reasoning
  when relevant.

Thanks again for contributing.
