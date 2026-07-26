# CLAUDE.md

Guidance for agents working in this repo. `AGENTS.md` symlinks here, so every agent loads this file
every session.

> **Keep this file lean.** It is a map of non-obvious constraints, not an encyclopedia. Do not inline
> API/tool inventories, changelogs, or per-round history — link out instead. When you want to add
> detail, add it to `docs/ARCHITECTURE.md` (or the right doc below) and leave a pointer here.

## What Cairn is

A self-hosted, connected, day-reading wellness OS for training / nutrition / longevity with an
agentic coaching loop. It opens to a calm **Brief** that reads your whole picture and *suggests* what
kind of day today should be, propagates flagged lab findings across every domain they touch (the
"connected brain"), runs adaptive nutrition, learns who you are, and surfaces quiet cross-domain
insights one at a time.

One Node service (`src/server.ts`) serves four surfaces from one process: a vanilla PWA (`/`), a REST
API (`/api/*`), an MCP server (`/mcp`, Streamable HTTP), and a background scheduler. Storage is
SQLite via Node's built-in `node:sqlite`.

**`docs/VISION.md` is the constitution** — calm, suggestion-not-a-gate, no-scores, pull-never-push.
Read it before shaping product behavior. (Its progress log is maintained separately; don't edit it as
code housekeeping.)

## Commands

```bash
npm run dev      # tsx watch on src/server.ts -> http://localhost:8787 (auto-seeds on first boot)
npm run build    # typecheck client + transpile src/client -> public/js + tsc -> dist/
npm start        # node dist/server.js (run build first)
npm test         # node:test harness, sharded; pretest builds dist/
npm run migrate  # print current user_version, apply pending migrations
npm run reset    # delete data/cairn.db* and re-seed
```

Full deploy / migration / backup / restore playbook: `docs/OPERATIONS.md`. Docker image details and
release flow: `docs/SHARING.md`.

## Hard requirements

- **Node 24 is mandatory** — that's where `node:sqlite` is unflagged. No native build step.
- **ESM with explicit `.js` import extensions** (`tsconfig` is `NodeNext`). Importing a sibling `.ts`
  module is written `from "./repo.js"`, never `"./repo"`.
- **Every string rendered into `innerHTML` goes through `escHtml`/`escAttr`.** The only exceptions
  are the two SVG libraries (`art.js`, `cairn-body-figure.js`), whose output is authored geometry and
  never interpolates caller text.

## The traps that actually bite

**Schema changes are two-step.** For a brand-new table, add a `CREATE TABLE IF NOT EXISTS` in
`src/db.ts` and you're done. To add a **column to an existing table** you must do BOTH: (1) add it to
the matching `CREATE TABLE IF NOT EXISTS` in `db.ts` so fresh DBs get it, and (2) append an entry to
`MIGRATIONS` in `src/migrate.ts` with the next integer `version` and an idempotent `up(db)` doing the
`ALTER TABLE … ADD COLUMN` inside a try/catch. `runMigrations(db)` runs at the bottom of `db.ts` on
every boot. **Down-migrations do not exist** — back up before deploying schema changes. Never
hardcode the current schema version in docs; `src/migrate.ts` is the source of truth.

**Any change under `public/` MUST bump the `CACHE` constant in `public/sw.js` in the same commit** —
otherwise installed PWA clients serve the stale assets forever. New static assets must also be added
to the precache `ASSETS` list. (The worker `skipWaiting()`s and the client reloads once on
`controllerchange`, so a deploy goes live on next open — but only if the version bump made the
browser fetch the new worker at all.)

**`public/js/*.js` is generated** from `src/client/**/*.ts` by `npm run client:build`; the only
hand-written file there is the `10-boot.js` shim. Never hand-edit generated output. The client
modules share ONE global scope in load order, so a top-level eager cross-module reference must use a
lazy `() => fn()` thunk — function hoisting does not cross `<script>` boundaries.

**There are two TypeScript compilers, on different majors, and `npx tsc` is NOT the one that
builds.** The `typescript` dependency is aliased to `@typescript/typescript6`, so bare `npx tsc`
resolves to **TS 6**. `npm run tsc` is `node node_modules/typescript-7/bin/tsc` — **TS 7** — and that
is what `npm run build` and `npm run typecheck:client` use. Typecheck with **`npm run tsc -- --noEmit`**;
a clean `npx tsc` proves nothing about whether the build passes.

**`npm run format` hardcodes `--write .`** (the whole repo, which is not biome-clean at rest). To
format only what you touched, run `./node_modules/.bin/biome format --write <files>` directly.
`npm run lint` is lint rules only. Note that per-file is *scoped*, not *safe*: biome reflows the
WHOLE file, and many files here are dirty at rest, so a two-line edit can land as a 600-line diff of
untouched code. Check `git diff --numstat <file>` after formatting; if the reflow dwarfs the edit,
restore the file and hand-match the surrounding style.

**Prompts do not get the whole coach context.** Every `DATA:` block is built by
`promptData(ctx, "<site>")` (`src/prompt/context-projection.ts`), a declarative per-site key
allowlist. `getCoachContext()` itself is untouched, so routes, MCP tools and the read-tool loop still
see everything — but adding a key there does NOT make it reach any prompt until you add it to that
site, and a new prompt registers a site rather than interpolating `JSON.stringify(ctx)` (which
silently restores a ~2× payload). Never trim by slicing the serialized string; that hands the agent
malformed JSON.

**`dayRead()`'s optional args each override only their OWN input** — only `unifiedState` scopes the
whole signal state; omit it and the state builds RICH via `dayPlanningSignalState()`, the same builder
`getCoachContext()` uses, so the Brief and the coach prompt can no longer see different states.
**Agent-authored `headline`/`why` are held to the deterministic vocabulary's own rules**:
`isValidDayReadAgentResult` (`src/dayread.ts`) rejects them via `violatesReadingGrammar()`
(`src/repo/day-read.ts`) — leaked engineering vocabulary, a score, or gate language ("you must") fails.

**Agentic endpoints return `{ok:false, error, tried}` at HTTP 200** — a designed failure signal, not
an HTTP error. And single-row `?date=` / `last-set` lookups return **`200 + null`** on absence, not
404, because the PWA's `api()` helper resolves to the body regardless of status, so a 404 error
object would read as a truthy hit.

**Tests wipe the DB before every single test.** `test/run.mjs` shards files across workers (each with
its own throwaway temp `DATA_DIR`/`DB_PATH`) and injects `test/_isolate.mjs` via `--import` — a root
`beforeEach` that wipes the whole DB. So correctness is independent of file order and shard count,
and a bare `node --test` invocation SKIPS that wipe. The suite is deterministic and offline: no agent
CLI, no network. The `stub` agent in `agents.json` is the offline smoke path for propose/apply.

When verifying by hand, run **one file per invocation with its own `mktemp -d`**. Passing several
files to a single `node --test` with one `DB_PATH` runs them as *parallel* child processes against
one SQLite file; the loser throws `database is locked` at the WAL pragma during module load and the
whole file reports failed with no test-level detail. That is a phantom, not a regression —
`test/run.mjs` avoids it by giving each worker its own temp dir and running files serially within a
worker.

## Architecture: two protocol surfaces over one shared layer

REST endpoints are **defined** in the ~20 routers under `src/routes/*.ts` (`src/api.ts` only *mounts*
them). MCP tools are **defined** in `src/surfaces/mcp/*.ts` (`src/mcp.ts` only *registers* them).
Both call the same layer beneath: use-case services in `src/domain/*` and data/domain modules in
`src/repo/*` (barrelled by `src/repo.ts`), with prompts in `src/prompt.ts` and client-facing DTOs in
`src/contracts/*`. MCP ⊆ REST, and the two surfaces stay near-mirror wrappers.

So: **business logic belongs in `domain`/`repo`/`prompt`.** Adding a capability usually means the
matching `src/routes/*` router AND `src/surfaces/mcp/*` module plus the underlying domain/repo
function — never `api.ts`/`mcp.ts` themselves, which are just registries.

Multi-step **agentic** operations both surfaces run (session-suggest, nutrition check-in, meal swap,
recipe, health review, insight generate) live in **`src/coachOps.ts`**, each returning a plain
`{ok, …}` that a route wraps in `res.json(...)` and an MCP tool wraps in `asText(...)`. The shared
`runChosen(agent, prompt)` lives in `src/runChosen.ts`. Put new agentic orchestration in `coachOps`,
not duplicated in the surfaces.

Generated, authoritative inventories: **`docs/API.md`** (endpoints) and **`docs/MCP-TOOLS.md`**
(tools), both from `npm run docs:index`. Subsystem depth — repo functions, prompt builders, chat
turns, streaming, art, scheduler, enrichment, PWA surfaces — is in **`docs/ARCHITECTURE.md`**.

## The coaching loop (propose → apply)

`src/prompt.ts` builds a prompt embedding `getCoachContext()` plus a strict JSON output contract →
`src/agents.ts` `runAgent()` spawns an **external CLI subprocess** (Claude Code, Codex, Antigravity,
Grok, or `stub`) defined in `agents.json`, and `extractJson()` pulls the JSON out of stdout → the
result is stored as a **`draft`** row (`plan_proposals` / `meal_plans`). **An agent never applies its
own change.** `applyProposal()` walks `parsed.changes[]` via `updateTarget()` and refuses to re-apply
an already-applied proposal; a `parsed.days` payload instead routes to `replacePlan()`, and a
`kind:'nutrition_target'` payload is advisory (acknowledgement only, no plan to mutate).

**Autonomy is server policy, not model discretion** (Amendment 1 in `docs/VISION.md`).
`decideAutonomyTier()` (`src/brain/autonomy.ts`, driven by `settings.lead_mode`) picks among observe
/ quiet_apply / announce / ask / clinician; bounded reversible changes land at natural boundaries,
structural ones announce, goal-identity and anything clinical always ask. Every material decision is
recorded in `brain_decisions` with falsifiable expectations and server-owned one-tap Undo. The
clinician floor is deterministic — a conductor cannot self-attest it away. See
`docs/ELITE-BRAIN-IMPLEMENTATION.md`.

**Agent selection.** Callers name an agent or pass `agent:"auto"` / omit it. Auto uses
`repo.pickAgentOrder()` (strategy in `settings`: `round_robin` default / `random` / `priority`) and
`agents.runAgentWithFallback()`, which tries agents in order until one returns parseable JSON — so a
dead CLI login or timeout falls through transparently. `agents.json` defines each backend (command,
args, input mode, env); which are enabled/ordered and the strategy live in `settings`, editable at
runtime with no redeploy. Health ingestion deliberately opts out of the rotation (see
`docs/ARCHITECTURE.md`).

**Model and effort are server policy, not the CLI's default.** `TASK_POLICY` in
`src/repo/settings.ts` picks *which* agent runs an op; its sibling `TASK_EXECUTION_PROFILES` picks
*how* — keyed by the same `taskForOp` class. Profiles are provider-neutral (`fast`/`deep`) and map to
a CLI model **alias** via `model_classes` in `agents.json`, so they track model generations without a
code change; a provider that declares no `model_classes` (codex/antigravity/grok) keeps its own model
and takes only the effort. Resolution happens once at spawn time through `RunOpts.profile`, so
`runChosen` callers need no per-call-site wiring, and the interactive timeout scales with the
requested effort rather than a flat cap. Chat is deliberately absent from the table — its adaptive
lane (`src/chatRouting.ts`) stays authoritative. Never pin a dated model ID; pin the alias.

**Chat is a durable, non-blocking turn**, not a request/response: `POST /api/chat` enqueues and
returns immediately; a serial worker runs it, streaming token deltas over SSE when the agent supports
it. The reply is prose-first — the model writes `===CAIRN_REPLY===`, the athlete-facing prose, then
optionally `===CAIRN_ACTIONS===` + `{"actions":[…]}`. Everything before the reply marker is dropped
(autonomous CLIs narrate their tool steps as text, which must never reach the bubble). Details:
`docs/ARCHITECTURE.md`, `src/chatTurns.ts`.

## Domain gotchas

- **Weight encoding**: negative `weight`/`target_weight` = assisted movement (`-30` = 30 lb assist);
  `null` = bodyweight. The PWA and prompts rely on this.
- **Timed exercises** (`exercises.mode = 'timed'`): sets log `duration_sec` (weight/reps may be
  null), plans prescribe `target_seconds`, progression is in seconds — never load. Proposal
  `changes[]` may carry `target_seconds` instead of `target_weight`.
- Est-1RM is Epley on the best set per day.
- **Sessions are keyed by date** — `getOrCreateSession` reuses today's session, so logged sets
  accumulate into one session per day.
- **Garmin strength is a session, not an activity.** `upsertGarminActivity` deliberately skips the
  generic `activities` row for a strength type (no duplicate). `reconcileGarminStrength()` does the
  deterministic merge (physiology onto `sessions.garmin_json`, link, delete stale row) *always*, even
  with no agent; the narrative + missing-exercise logging is the agentic layer on the enrichment
  queue, guarded so hand-logged sets are never overwritten and re-syncs stay idempotent.
- **Autoregulation feedback** (`sessions.soreness`/`performance`/`joint_pain`) and subjective
  `checkins` are optional signals that INFORM coach selection — they never override progressive
  overload, never auto-change the plan, and their absence never forces a rest read.
- **Day-read prose is a variant set, never one literal.** A stable input fires a stable rule every
  morning, so a single sentence per rule printed verbatim for weeks. Rules carry their own athlete-
  facing `reasons` (`src/repo/brain/day-read-rules.ts`), and every athlete-facing string — outcome
  reason, the read's `why`, the server-policy clamp reason — rotates through `pickDayVariant(date)`.
  Add a phrasing to the set; do not add a literal. Details in `docs/ARCHITECTURE.md`.
- **Any surface a PERSON reads goes through `spokenSignalVoice`; `summary`/`reason` are the machine
  register.** `SignalObservation.summary` and every dimension `reason` (`src/repo/signal-state.ts`)
  are third-person evidence prose for `renderSignalState`, the coach context and the provenance
  trail. The Brief's `why` AND the coaching-focus conductor's lead/parallel cards both speak through
  `spokenSignalVoice(ref, date, key)` instead — fix a voice problem there, never by rewriting
  `summary`/`reason` in place (that would silently change what the model is shown). Details in
  `docs/ARCHITECTURE.md`.
- **Optimal-zone ≠ lab range.** `OPTIMAL_ZONES` are evidence-anchored longevity target bands, which
  is not the lab's population reference interval — a value can read "in range" yet sit far from
  optimal. `prioritizeMarkers()` ranks by an INTERNAL `impact_score`; **never surface that number**.
  The UI shows in/out-of-optimal and direction only.
- **Marker grouping**: `MARKER_GROUPS` (in `propagation.ts`) matches longest-first, and its **array
  order is the display order** — conventional clinical lab-review order, mirrored by the doctor
  export and the in-app catalog. Full ordering rules and the non-clinical-marker filter live in
  `docs/ARCHITECTURE.md`.
- **Directives never change anything by themselves.** A flagged marker propagates into
  `health_directives` via `deriveDirectives()`; sources `'markers'` (deterministic) and
  `'health_review'` (agent-emitted) coexist and each clears/rewrites only its own rows. Directives
  are informational, not medical advice; `uncertain`/uncited ones are a softer nudge. The user flips
  `active|resolved|dismissed`.

- **Food capture has ONE contract and ONE direction of time inference.** `src/foodCapture.ts` owns
  the meal-estimate shape (ingredient rows with the quantity as a *field*, `nutrition_pattern` bands,
  `confidence`/`basis` provenance) for chat, note enrichment and the photo read alike — extend it
  there, never re-declare the JSON in a fourth prompt; three drifting copies are what left the chat
  path emitting no `nutrition_pattern` at all. A stated time may infer an unstated meal label
  (21:00 → dinner); the reverse must never happen. `eaten_at` is rendered to the athlete, so a time
  synthesized from a label would be indistinguishable from one they actually said — the label's hour
  orders a day at read time only, and is never stored.

## Product constraints (enforced in prompts AND UI)

- The Brief and every read is a **suggestion, never a gate or verdict** — the athlete drives.
- **No numeric scores anywhere.** No 0-100 grades, no metric walls.
- Insights and the weekly read are **pull, never push** — they wait in-app, never notify or nag. The
  generator emits ONE genuine connection or `{found:false}`, deduped against what it already said.
- Adaptive nutrition is **adherence-neutral**: a thin logging week lowers confidence, never blames.
  `change:false` is the calm, common answer.
- Health findings are informational, never medical advice.

## Security posture

Single-user, trusted-network by default: **no authentication unless `CAIRN_AUTH_TOKEN` is set**, in
which case one global guard in `src/auth.ts` gates `/api` and `/mcp` (exempting `GET /api/health` and
the static shell). The PWA sends `X-Cairn-Token` (or `?token=` on direct resource URLs via
`withToken()`); API/MCP clients use `Authorization: Bearer`. An optional per-IP rate limiter
(`CAIRN_RATE_LIMIT`) is wired *before* the auth guard so it also blunts token brute-force. Uploads
land in `data/uploads/` behind a raster-image/PDF mime allowlist (no SVG), and the 25 MB body limit is
scoped to the health-doc upload route only (1 MB elsewhere). The container runs as non-root `app`, so
one-off `docker compose exec` commands that must persist a CLI login need `-u app`.

## Docs map

| Doc | What it holds |
|---|---|
| `docs/VISION.md` | The constitution. Read before shaping product behavior. |
| `docs/ARCHITECTURE.md` | Subsystem depth: repo layer, prompts, chat/streaming, art, scheduler, enrichment, PWA surfaces. |
| `docs/API.md` · `docs/MCP-TOOLS.md` | Generated, authoritative endpoint and tool inventories. |
| `docs/DESIGN.md` | The "Atelier" visual contract — palette, class names, motion. Read before touching `styles.css` or view markup. |
| `docs/OPERATIONS.md` | Deploy, migrate, backup, restore, tooling notes. |
| `docs/ELITE-BRAIN-IMPLEMENTATION.md` | The decision ledger, evaluators, autonomy tiers. |
| `docs/ARCHITECTURE-HISTORY.md` | Append-only per-round schema/feature changelog. |
