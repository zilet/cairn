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

REST endpoints are **defined** in two dozen routers under `src/routes/*.ts` (`src/api.ts` only *mounts*
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
- **Sensor age and acute muscle fatigue each have exactly one source of truth**: `src/repo/sensor-freshness.ts`
  (a stale wearable reading behaves as absent, never as current) and `hybrid-load.ts`'s `acuteGate()`
  (the one "is this muscle recovering" question — call it, never re-derive a window). Details in
  `docs/ARCHITECTURE.md`.
- **Logged intake is evidence only when the day reads complete** — `classifyIntakeDay`
  (`src/repo/intake-window.ts`) is the one credibility rule: a morning→evening span carrying at
  least `SPANNING_DAY_MIN_KCAL`, or, when NOTHING on the day could be placed in time, a whole day
  declared at once (`UNPLACEABLE_DAY_MIN_KCAL` of *untimed* calories — one placed meal disqualifies
  that arm). A partial or unlogged day is ABSENT, never "low". Never infer under-eating from
  missing logs; and during an affirmed cut a protective raise stops at **measured** maintenance
  (`capProtectiveRaise`, `src/repo/cut-target.ts`) — protection buys maintenance, never a surplus,
  and a `formula_estimate` anchor is not a measurement, so it can only ever hold the target.
- **Sessions are keyed by date** — `getOrCreateSession` reuses today's session, so logged sets
  accumulate into one session per day.
- **Garmin strength is a session, not an activity.** `upsertGarminActivity` deliberately skips the
  generic `activities` row for a strength type (no duplicate). `reconcileGarminStrength()` does the
  deterministic merge (physiology onto `sessions.garmin_json`, link, delete stale row) *always*, even
  with no agent; the narrative + missing-exercise logging is the agentic layer on the enrichment
  queue, guarded so hand-logged sets are never overwritten and re-syncs stay idempotent.
- **Autoregulation feedback** (`sessions.soreness`/`performance`/`joint_pain`) and subjective
  `checkins` are optional signals that INFORM coach selection — they never override progressive
  overload, never auto-change the plan, and their absence never forces a rest read. **A completed
  log outranks a felt rating, PER LIFT**: `sessionLogContradictsLowRating` (`src/repo/session-dose-log.ts`)
  is a majority test — lifts met/exceeded must at least match the ones that fell short (a skip counts
  short), an incomplete log additionally needs ≥1 lift genuinely `exceeded`, and any lift that landed
  under its own stored full-load reference kills the contradiction outright whatever the counts say.
  A low `felt_fatigue` constraint this earns closes early (within its 7-day window) the moment a later
  completed session contradicts it too (`autoregBrake`, `signal-state.ts`). Readiness bands live in
  `src/repo/readiness-bands.ts` (`LOW_READINESS` 35 = subdued/easy; `REST_GRADE_READINESS` 20
  inclusive = its own REST rule, softenable only to easy movement) — never hardcode a readiness
  threshold. And `trainedWithoutHarm` is `harmEvidenceOnDay(date) == null`: a hard-cardio day, a
  new-longest run (`longestRunNovelty`), or a bad next morning (rest-grade readiness, low HRV
  status, elevated RHR) is harm — a run-only day is never "unrated therefore fine". Check-in `energy`/
  `sleep_feel` still brake at ≤2 and support at ≥4, but a `3` is genuinely NEUTRAL (it still emits an
  observation, so a tapped-in athlete never reads as untracked) — never round it to a brake or a
  support vote. Chat can write the same check-in via the `log_checkin` action
  (`src/chatActions.ts`), 1–5 scales only, and a free-text note there is routed through symptom
  capture only when the athlete's own words carry symptom intent — never automatically.
- **Deload-due is earned by loaded weeks and a log-confirmed shortfall, never the calendar.**
  `mesocycle()` (`src/repo/program-state.ts`) classifies a week as loaded only against the median of
  the loaded weeks before it (`classifyLoadedWeeks`); a light week breaks the streak. `deload-due`
  comes only from a six-week loaded streak, or four weeks plus a shortfall the log confirms plus
  physiology. Ratings and notes are supporting copy; an applied recovery week only resets the count;
  a block in weeks 1–2 or its own deload/realization phase never reads deload-due. Do not add a
  "weeks since" trigger back.
- **Assist is a sign, and the sign is guarded at log time.** A positive weight typed onto a
  negative-history lift within 1.5× the recent assist band is stored negative (`assistSignContext`,
  `src/repo/sessions.ts`; Garmin imports opt out). An exercise's NAME is never a sign — only its
  history is. `recentWorkingWeight` ranks less assist and more reps as harder.
- **The daily envelope's up direction is `reach`, a separate field — never a sixth posture.**
  `SignalPosture` is a five-value safety ladder. `reach.level='push'` licenses ONE challenge top set
  on the first eligible compound (`src/repo/daily-composition.ts`), computed from the LOGGED working
  weight, never a plan target; composition reports back so the persisted envelope never promises a
  reach that is not on a card. `item.reach` persists only for server-derived items.
- **Consecutive loading days are a caveat, never a brake of their own** (`daily_decision_v7`,
  `src/repo/day-read.ts`/`daily-decision.ts`). A day counts as loading when it is hard, or moderate
  STRENGTH work, or genuinely hard cardio (asked directly via `hardCardioDay` — an easy/moderate run
  never extends a strength-led athlete's streak, and the day's own grade is unchanged). Below the hard
  ceiling (5), an uncorroborated run rides only as `STACKED_DAYS_CAVEAT` on the train/easy read — the
  athlete still gets their day. `accumulated_load_rest` fires as REST only when a CURRENT signal
  corroborates (low readiness, low subjective, a recovery-week dose overrun, a fresh brake,
  `recovery_capacity` watch/constrained with fresh data, anything clinical today or a clinical hold
  starting tomorrow). At the ceiling with nothing corroborating and recovery still supportive, the
  read is EASY under the same code — not rest, and not another train day the drive preference can keep
  reopening. `supportiveCapacityBacksDay()` (exported from `day-read.ts`) is the ONE helper both the
  push-drive rest-answer rule and the envelope's `reach` resolver use for the wearable-corroboration
  path, so the two answers cannot drift. `train_anyway` from a rest morning holds the WORKING load
  (`intensity:'hold'`, never `'deload'` unless a phase/repeated-under independently says so) and its
  duration comes from the plan day's own estimate, not the quiet read's 20-minute clock.
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
- **One panel per draw date.** The same lab draw arrives more than once (a PDF and a zip of one
  export, a re-export, the CCDA pass and the agent reading one import). `dedupeHealthDocuments()`
  (`src/repo/health-dedupe.ts`) folds records on the same date whose shared readings AGREE into one
  survivor (source row > deterministic read > fullest), scoped to the upload after every ingest and
  whole-record via `POST /api/health-docs/dedupe` / `dedupe_health_records` (a dry run unless
  `apply:true`). Evidence must be discriminating — a shared weight/BMI/pulse never makes a match;
  records that merely share a date, or whose readings disagree, stay apart. Free-text observation rows
  ("Lab Interpretation") are never markers (`isNonAnalyteMarkerName`).
- **Marker grouping**: `MARKER_GROUPS` (in `propagation.ts`) matches longest-first, and its **array
  order is the display order** — conventional clinical lab-review order, mirrored by the doctor
  export and the in-app catalog. Full ordering rules and the non-clinical-marker filter live in
  `docs/ARCHITECTURE.md`.
- **Marker staleness is per-class, not one number.** `src/repo/marker-validity.ts` classifies every
  marker (`genetic` never age-doubted / `slow` / `standard` default / `fast`); horizons, cluster
  rules and the honor-vs-informational split all derive from it, and its `(label, bucket, band)`
  entries feed the derive signature — extend the table there, never hardcode an age threshold.
  Details in `docs/ARCHITECTURE.md`.
- **Directives never change anything by themselves.** A flagged marker propagates into
  `health_directives` via `deriveDirectives()`; sources `'markers'` (deterministic) and
  `'health_review'` (agent-emitted) coexist and each clears/rewrites only its own rows. One
  exception to the churn-free diff reconcile: a materially-WORSE trigger from a strictly newer
  draw resurfaces its directive as a fresh row (`resurfaceWorseningDirectives`,
  `resurfaced_from_id`) — news gets a row, never an invisible in-place edit. Directives
  are informational, not medical advice; `uncertain`/uncited ones are a softer nudge. The user flips
  `active|resolved|dismissed`.

- **Pain is REPORTED IN WORDS; the mini-UIs are gone on purpose.** `training_symptom_events.area_text`
  is a short display LABEL (pain-relevance runs substring regexes over it, so a paragraph there loads
  every lift) — the athlete's actual sentence lives verbatim in **`symptom_reports.text`**, written
  synchronously before anything is derived. Structure comes from ONE contract, `src/symptomCapture.ts`
  (mirrors `foodCapture.ts`), applied only through the existing lifecycle writers. `scope='systemic'`
  never drives movement relevance; `evidence='inferred'` (a quiet exposure read off a logged set at
  session finish) refreshes `freshness` but never `stated_freshness` — read `stated_freshness` for
  anything about acuity or outcome comparability. Details in `docs/ARCHITECTURE.md`.

- **Food capture has ONE contract and ONE direction of time inference.** `src/foodCapture.ts` owns
  the meal-estimate shape (ingredient rows with the quantity as a *field*, `nutrition_pattern` bands,
  `confidence`/`basis` provenance) for chat, note enrichment and the photo read alike — extend it
  there, never re-declare the JSON in a fourth prompt; three drifting copies are what left the chat
  path emitting no `nutrition_pattern` at all. A stated time may infer an unstated meal label
  (21:00 → dinner); the reverse must never happen. `eaten_at` is rendered to the athlete, so a time
  synthesized from a label would be indistinguishable from one they actually said — the label's hour
  orders a day at read time only, and is never stored.

- **Dose comparability is a per-lift question, not a per-session one.** Each `dose_evidence` entry
  carries its own `comparable` flag and reasons in `facts_json` — a shortfall blocks only the lift
  that fell short, an endurance day blocks only the muscles it actually loaded. `dose_context.comparable`
  is telemetry only; the progression engine reads the per-dose flags, never that session-level rollup
  — restoring the session-level reading is the regression to watch for. `settings.training_drive='push'`
  has bounded mechanical authority in progression (keeps an earned overload/vary/introduce step under
  a fuel hold AND its full set count under a fuel `reduce`, top set dropped in both) — but every
  promotion still needs `mayPromoteLoad` (an eligible finished dose, no VETOING cut pressure —
  `sliding`, or `reduce` off goal), and every safety floor ignores drive entirely. Details in
  `docs/ARCHITECTURE.md`.
- **Work done is evidence — a prescription is a suggestion, the log is the truth.** `performed_at_full_load`
  (`src/repo/outcome-comparability.ts`, `facts_json` schema 4) is computed per dose against the LOGGED
  working load — `recentWorkingWeight`/`recentWorkingSeconds` primary, the plan's `target_weight`/
  `target_seconds` only as a no-history fallback (never the forward prescription progression is about
  to write) — and drops `recovery_dose`/`travel` from that dose's non-comparable reasons; illness and a
  relevant symptom stay full safety floors regardless. The `recovery` flag itself is STRUCTURED, never a
  regex over stored envelope prose (`caps.intensity:"deload"` and the word "recovery" in rationale text
  are NOT a recovery window) — it comes only from an active/recheck `recovery_cycles` row, a stored
  `recovery_cycle` on the decision context, or an applied recovery-week stamp. Migration v97 repaired
  60 days of live rows a rest-day train-anyway envelope had mislabeled; schema-2 rows are read as-is,
  schema-3 comparable is re-derived live, schema-4 rows store the per-dose answer directly.
- **Cut pressure has three shapes, and only two veto an earned promotion.** `CutPressure` (`progression.ts`)
  splits `hold` (a soft fuel read — never vetoes), `reduce` (an outright lighter fuel dose — vetoes
  unless `near_goal`: `atOrNearGoal` (`src/repo/goal-proximity.ts`), within `NEAR_GOAL_REMAINING_LB`
  = 2.5 lb of a live lose-mode goal INCLUDING a goal already reached — where it also stops shrinking
  the plan at all, since the answer to underfueling at the destination is more food, not a smaller
  session), `sliding`
  (anchor lifts actually dropping, or this lift regressing/shortfall — ALWAYS vetoes), and `fast_loss`
  (losing faster than lean-safe but not sliding — never vetoes an earned load step, only parks the
  challenge top set/heavy single). `deep` is the `sliding || fast_loss` alias other readers still
  consult as "the cut is running hot"; promotion itself reads `sliding`/`fast_loss` directly.
- **RIR is optional, and its absence is not weakness.** The finish flow never asks for RIR, so most
  logged sets carry none. With no RIR logged, capping the prescribed rep range on every working set
  IS the strength signal (classic double progression) — the completeness gates require the cap, not a
  felt rating. A logged RIR still speaks in both directions: RIR ≤1 was a grind and holds the step;
  RIR ≥2 counts even below the ceiling. Card copy must not tell an athlete who never logs RIR to come
  back at "RIR 2+" — the RIR-flavored phrasing in `progression-voice.ts` is picked only when an RIR was
  actually logged; an athlete who never rates gets the same meaning spoken in reps.
- **The exercise-guide matcher only auto-links a UNIQUE hit**; an implement-only match instead parks
  as a suggestion for a human yes/no, and a hand-confirmed link or refusal both survive re-import.
  Details in `docs/ARCHITECTURE.md`.

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
| `docs/` (rest) | User-facing guides — quickstart, deployment, Garmin, Apple Health, households, sharing, sandbox, observability. |
