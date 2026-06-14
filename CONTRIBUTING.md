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

```bash
npm install
npm run dev      # tsx watch on src/server.ts -> http://localhost:8787 (auto-seeds on first boot)
npm run build    # tsc -> dist/   (this is also the typecheck gate)
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
are both thin, parallel adapters over the same `src/repo.ts`.** Business logic
belongs in `repo.ts` (or `src/prompt.ts` for prompt construction) — the two
surfaces should stay near-mirror wrappers.

> When you add a capability, expect to touch **all three**: `repo.ts` (the
> logic) plus both `api.ts` and `mcp.ts` (the wrappers). Keep them in sync.

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

Skip this and installed PWA clients will keep serving stale assets forever. The
visual contract (the "Atelier" design system) lives in `docs/DESIGN.md` — read
it before touching `styles.css` or view markup.

## Testing & the offline smoke test

There is **no test suite, linter, or formatter**. The typecheck gate is simply:

```bash
npm run build   # tsc; CI runs exactly this
```

Please make sure `npm run build` passes before opening a PR.

For the agentic propose → apply coaching loop, the **`stub` agent** (defined in
`agents.json`) is the offline smoke-test path: it needs no API key and returns a
canned JSON proposal, so you can exercise the draft/apply flow without any
external CLI configured.

## Pull requests

- Keep changes focused and proportionate.
- Match the existing style (`.js` import extensions, the repo-layer-first
  architecture, the migration procedure, the `sw.js` cache bump).
- Make sure `npm run build` is green.
- Describe the user-facing behavior change and link `docs/VISION.md` reasoning
  when relevant.

Thanks again for contributing.
