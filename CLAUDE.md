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

- **Node 24 is the floor, Node 26 is what ships** — `node:sqlite` is unflagged from 24; the Docker
  image, the release workflow and the primary CI lane run 26. No native build step.
- **ESM with explicit `.js` import extensions** (`tsconfig` is `NodeNext`). Importing a sibling `.ts`
  module is written `from "./repo.js"`, never `"./repo"`.
- **Every string rendered into `innerHTML` goes through `escHtml`/`escAttr`.** The only exceptions
  are the two SVG libraries (`art.js`, `cairn-body-figure.js`), whose output is authored geometry and
  never interpolates caller text.

## The traps that actually bite

**`AgentBusyError` (`code: agent_busy`) means the host had no CLI spawn permit — never a bad job.**
Every agent spawn goes through one process-wide semaphore (`CAIRN_MAX_AGENT_PROCS`, `src/agents.ts`);
a runner that catches this must defer-and-retry, never fail the row or rotate to the next agent.
Details: `docs/ARCHITECTURE.md` "The process-wide agent spawn cap".

**Chat's DATA block must not travel in argv.** Linux `MAX_ARG_STRLEN` is 32 × page size (512 KiB on
a 16K-page Pi 5, 128 KiB on 4K-page hosts). A chat prompt that inlines there throws `E2BIG` at spawn
in ~5 ms and every rotated agent "process failed". `buildAgentLaunch` keeps small prompts on `{prompt}`
and delivers oversized ones via stdin / `--prompt-file`. Never raise the inline cap
to "whatever fit last time".

**Schema changes are two-step.** For a brand-new table, add a `CREATE TABLE IF NOT EXISTS` in
`src/db.ts` and you're done. For a **column on an existing table** do BOTH: (1) add it to that table's
create block in `db.ts` so fresh DBs get it, and (2) append an entry with the next integer `version`
and an idempotent try/catch `ALTER TABLE … ADD COLUMN` to the range file covering it — `v001-050.ts` /
`v051-100.ts` / `v101-150.ts` under `src/migrations/`, helpers in `migrations/helpers.ts`, `migrate.ts`
only the runner, frozen snapshots in `migrations/frozen/` never edited or reformatted. `npm run
schema:check` (in `npm run verify`) fails half a two-step. **No down-migrations** — back up first, and
never hardcode the schema version in docs; the range files own it.

**The service-worker cache version is DERIVED — never hand-bump it.** `public/sw.js` ships the
placeholder `const CACHE = "cairn-shell-dev"`; `src/swVersion.ts` serves `/sw.js` with that literal
replaced by `cairn-<hash>`, a content hash over every asset the worker precaches. So a changed shell
always ships a new cache name and an unchanged one never re-downloads. What you MUST still do by
hand: **add every new static asset to `CORE_ASSETS` in `public/sw.js`** — an asset missing there is
neither cached offline nor covered by the hash. Do not rename the placeholder (the substitution is
an exact match, and `scripts/check-sw-cache.mjs` asserts it). **Art URLs carry `v=`; never strip it**
— the SW cache-first layer keys on the full URL and evicts older `v` for the same `kind+q`.

**`index.html` does not load every bundle.** A bundle marked `lazy: "<name>"` in `BUNDLES`
(`scripts/build-client.mjs`) — today only `bundle-05-me-health`, the Stand/Me/Records surfaces — is
injected on first navigation by `ensureBundle("<name>")` (`src/client/app/lazy-bundles.ts`) and is
still precached. So an eager bundle may reference a lazy bundle's globals ONLY from inside a
function that runs after that navigation, never at top level.

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
malformed JSON. And **prompt builders and coaching ops import concrete `src/repo/<module>.js`, never
the `src/repo.ts` barrel** (contract test) — the barrel is for routes and MCP.

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

**Structured output is enforced where a `src/coachOps/*` call site passes `RunOpts.schema`; every other
op is prose-only.** Every field a consumer READS must be named in the schema (an unnamed field is
silently dropped by constrained decoding, not preserved by `additionalProperties: true`), and a
schema is inert while streaming or for `stub` — the prose `OUTPUT CONTRACT` stays the floor
everywhere. Details: `docs/ARCHITECTURE.md`'s "Enforced structured output" section.

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
`src/repo/*` (barrelled by `src/repo.ts`), with prompt builders in `src/prompt/*` (barrelled by
`src/prompt.ts`) and client-facing DTOs in `src/contracts/*`. MCP ⊆ REST, near-mirror wrappers.

So: **business logic belongs in `domain`/`repo`/`prompt`.** Adding a capability usually means the
matching `src/routes/*` router AND `src/surfaces/mcp/*` module plus the underlying domain/repo
function — never `api.ts`/`mcp.ts` themselves, which are just registries.

Multi-step **agentic** operations both surfaces run (session-suggest, nutrition check-in, meal swap,
recipe, health review, insight generate) live in **`src/coachOps/*`** (`shared`, `training`, `nutrition`,
`health`, `memory`, barrelled by `src/coachOps.ts`) — each returns a plain `{ok, …}` a route wraps in
`res.json(...)` and an MCP tool in `asText(...)`. Shared `runChosen(agent, prompt)`: `src/runChosen.ts`.
Put new agentic orchestration in `coachOps/*`, not duplicated in the surfaces.

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

**The CLIs are autonomous agents; Cairn's prompts are not tasks.** Every spawn goes through
`applyToolPolicy` (`src/agents.ts`), which leads the prompt with `NO_TOOLS_PREAMBLE` unless the prompt
hands the CLI uploaded files or the call site passed `tools:"provider"` (research, a current-research
chat turn). Without it grok explores its cwd with tools until the timeout and agy trips a headless
permission auto-deny — no CLI flag fixes that reliably (verified live; see `docs/ARCHITECTURE.md`
"Tool policy"). Opt an op into provider tools at its call site, never by softening the preamble.

**Autonomy is server policy, not model discretion** (Amendment 1 in `docs/VISION.md`).
`decideAutonomyTier()` (`src/brain/autonomy.ts`, driven by `settings.lead_mode`) picks among observe
/ quiet_apply / announce / ask / clinician; bounded reversible changes land at natural boundaries,
structural ones announce, goal-identity and anything clinical always ask. Every material decision is
recorded in `brain_decisions` with falsifiable expectations and server-owned one-tap Undo. The
clinician floor is deterministic IN BOTH DIRECTIONS — a conductor cannot self-attest it away, and
cannot self-attest INTO it either (`clinicianFloorHolds`, `src/brain/autonomy.ts`: a specialist's
`autonomy_ceiling:'clinician'` or a conductor's `risk_class:'clinical'` over a non-clinical change
tightens to an ask at most). An act-now health finding gates only a revision that acts on what it
governs — same domain and named area, or the revision names the marker (`clinicalAutonomyFromRevision`,
`src/domain/brain/conference-conflicts.ts`) — so a lipid finding never clinician-gates a squat hold.
See `docs/ELITE-BRAIN-IMPLEMENTATION.md`.

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

- **A held draft's dead premise retires it, never re-asks it.** A swap/removal draft whose target
  movement has left the plan is retired (`retire_reason:"premise_gone"`) by
  `retireDraftsWithDeadPremise()` ahead of the thaw/adoption loop — ungated by `lead_mode`. Details in
  `docs/ARCHITECTURE.md`.
- **Weight encoding**: negative `weight`/`target_weight` = assisted movement (`-30` = 30 lb assist);
  `null` = bodyweight. The PWA and prompts rely on this.
- **Timed exercises** (`exercises.mode = 'timed'`): sets log `duration_sec` (reps null), plans
  prescribe `target_seconds`; a loaded carry/hold also carries a weight — seconds progress to a
  ceiling first, then one load step with the seconds reset, never both (`docs/ARCHITECTURE.md`
  "Loaded timed work"). A timed item never takes reps.
- Est-1RM is Epley on the best set per day.
- **Sensor age and acute muscle fatigue each have exactly one source of truth**: `src/repo/sensor-freshness.ts`
  (a stale wearable reading behaves as absent, never as current) and `hybrid-load.ts`'s `acuteGate()`
  (the one "is this muscle recovering" question — call it, never re-derive a window). Details in
  `docs/ARCHITECTURE.md`.
- **"Last night" is the night dated the READ DAY; `d-1` is trend only.** Sleep rows are dated by the
  WAKE day, so a row dated `d-1` is the night before last. Every one-night claim —
  `signals.last_night`, the "Last night's sleep" evidence row, the acute short-night rule, the
  push-drive wearable path, the `sleep_night_*` observation, `sleepDebtRead`'s short-night arm —
  gates on `LAST_NIGHT_MAX_AGE_DAYS` = 0 / `isLastNight()` (`src/repo/sensor-freshness.ts`). The
  WINDOW claims (`avg_sleep_min`, `sleep_trend`, the chronic-sleep watch and its "a recent night
  exists" anchor) keep `SENSOR_MAX_AGE_DAYS.sleep` = 2. A morning with no night of its own says
  nothing about sleep — never a night before last wearing last night's words. One READINESS reading
  is the same law (`isReadDayReadiness`): a `d-1` row is yesterday's post-workout last sync. HRV
  and resting HR exist only on worn nights, so their caution BRAKES only when its reading is last
  night's; an older one rides as context (`advice_only`, `signal-state.ts`).
- **Logged intake is evidence only when the day reads complete** — `classifyIntakeDay`
  (`src/repo/intake-window.ts`) is the one credibility rule: a morning→evening span carrying at
  least `SPANNING_DAY_MIN_KCAL`, or, when NOTHING on the day could be placed in time, a whole day
  declared at once (`UNPLACEABLE_DAY_MIN_KCAL` of *untimed* calories — one placed meal disqualifies
  that arm). A partial or unlogged day is ABSENT, never "low". Never infer under-eating from
  missing logs; and during an affirmed cut a protective raise stops at **measured** maintenance
  (`capProtectiveRaise`, `src/repo/cut-target.ts`) — protection buys maintenance, never a surplus,
  and a `formula_estimate` anchor is not a measurement, so it can only ever hold the target.
- **A trip is a confounder, and rest already taken is the recovery dose.** A subdued `sleep_feel`/
  `soreness` dated inside a `trip` context event never proves fuel persistence (`travelWindowDates`,
  `src/repo/underfueling.ts` — recorded as `…:travel-confounded`, never silently dropped), and
  `REST_SPAN_CREDIT_DAYS` = 3 untrained days ending yesterday cap the recovery package's training
  consequence at `hold_aggression` (the calorie step stands; the control loop mints a recovery WEEK only
  when the read says `reduce`). The quiet-day escalation voice breaks its streak on a trip day.
- **Sessions are keyed by date** — `getOrCreateSession` reuses today's session, so logged sets
  accumulate into one session per day.
- **Stated run days are structured and anchor the run engine** — `endurance_schedule`
  (`profile.endurance_schedule_json`) is the athlete's named weekdays for easy/quality/long runs;
  `weeklyRunPlan` and `flexibleTrainingAgenda` honor those dows and never spill a suggestion onto
  an unscheduled day. A named day still fires when the hard session sits out — it becomes easy; the
  supporting-constrained drop to two runs applies only with no stated calendar. A logged run on an
  unscheduled day still counts (the log is truth). **Stated
  LIFTING weekdays are the same fact for strength** — `strength_schedule`
  (`profile.strength_schedule_json`, `{days:[{dow}]}`, no `kind`): when set, `weekdayPlanDayMap`
  (`src/repo/plan-selection.ts`) lays the plan's strength days onto exactly those weekdays and an
  unstated weekday never gets one; `week_layout.lift_days`/`run_days` and the prompt's STATED
  LIFTING DAYS line are how the agent checks itself. **The map OUTRANKS the session anchor** —
  `selectAdaptivePlanDay` consults it FIRST and the last logged session only sets the ring's phase
  (consulted after, it is inert: an anchor always resolves for an athlete with history), and
  **plan-day count need not equal lift-day count** — a short strength pool repeats inside the week
  so every named weekday still lifts, a surplus rotates across weeks onto the named weekdays only,
  and the scorer then adapts among strength days alone. **Never said is not the end of it** —
  `strengthScheduleRead()` (`src/repo/strength-schedule.ts`) falls back to the weekdays a real
  strength session landed on in 3 of the last 6 weeks (the race-build ride law), labelled
  `source:"observed"` everywhere it is spoken; an explicitly EMPTIED stated schedule stays silent
  rather than reopening the log. Chat is the only setter UI — there is no settings form, by design.
- **The race build is a read OVER the run engine, never a second engine** — `raceBuild()`
  (`src/repo/race-build.ts`) walks `raceRamp()` Monday by Monday for the ladder, so a week's km is
  always the engine's own next step; its `kind` follows the engine's arrival count in CALENDAR
  weeks to race week (`weeks_to_race_week`: peak → taper → race, never peak into race week). A
  reset is recovery, not lost ground, and a long run taken well is held, never re-climbed to
  (`RESET_TAKEN_FRACTION`, `demonstratedLongKm`). Finish estimates prefer the watch's
  predictor (≤3 weeks old, Riegel-adjusted) over a Riegel off a training run, and every comparison
  is a `fits`/`stretch`/`beyond_horizon` FIT, never a grade. The weekly ride is a PATTERN read off
  the log (3 of 6 weeks) — no new field. Details in `docs/ARCHITECTURE.md`.
- **Today's lift has ONE server line** — `todayStrengthLine()` (`src/repo/today-strength-line.ts`): plan
  day NAME, state off the log, a rest/easy read as a caveat (never a replacement title). The Brief,
  Session header, week strip and Train overview print it verbatim; never derive a today state in a
  renderer. Details in `docs/ARCHITECTURE.md`.
- **Plan days hold STRENGTH only; runs and rest are the calendar's** (migration 110). A run is never a
  plan item (`savePlanDay` strips it, `replacePlan` drops a day with nothing to lift) and a rest day is
  never a plan row (`day_type:'rest'` is refused). Runs come from the stated run days + `weeklyRunPlan`
  / the agenda; a non-lifting weekday is a run or rest day (`calendarDayRead`, plan-selection) and
  `selectAdaptivePlanDay` answers it with `day_number:null`. An empty editor scaffold is never
  startable. Details in `docs/ARCHITECTURE.md`.
- **Garmin strength is a session, not an activity.** `upsertGarminActivity` deliberately skips the
  generic `activities` row for a strength type (no duplicate). `reconcileGarminStrength()` does the
  deterministic merge (physiology onto `sessions.garmin_json`, link, delete stale row) *always*, even
  with no agent; the narrative + missing-exercise logging is the agentic layer on the enrichment
  queue, guarded so hand-logged sets are never overwritten and re-syncs stay idempotent.
  **Strength also travels OUT**: a finished Cairn session is written back as that day's Garmin
  exercise sets (`src/garminExport.ts`, non-agentic `garmin_export` enrich kind, FIT enums from
  `src/repo/garmin-exercise-map.ts` — never invented), onto the watch's own activity when there is
  one; a Garmin-owned day (`cairn_sets_authoritative === false`) stays inbound-only. See
  `docs/GARMIN.md`.
- **Autoregulation feedback** (`sessions.soreness`/`performance`/`joint_pain`) and subjective
  `checkins` are optional signals that INFORM coach selection — they never override progressive
  overload, never auto-change the plan, and their absence never forces a rest read. **A completed
  log outranks a felt rating, PER LIFT**: `sessionLogContradictsLowRating` (`src/repo/session-dose-log.ts`)
  is a majority test — lifts met/exceeded must at least match the ones that fell short (a skip counts
  short), an incomplete log additionally needs ≥1 lift genuinely `exceeded`, and any lift that landed
  under its own stored full-load reference kills the contradiction outright whatever the counts say.
  A low `felt_fatigue` constraint this earns closes early (within its 7-day window) the moment a later
  completed session contradicts it too (`autoregBrake`, `src/repo/progression.ts`). Readiness bands live in
  `src/repo/readiness-bands.ts` (`LOW_READINESS` 35 = subdued/easy; `REST_GRADE_READINESS` 20
  inclusive = its own REST rule, softenable only to easy movement) — never hardcode a readiness
  threshold. And `trainedWithoutHarm` is `harmEvidenceOnDay(date) == null`: a hard-cardio day, a
  new-longest run (`longestRunNovelty`), or a bad next morning (rest-grade readiness, or last
  night's HRV/RHR past the athlete's OWN band — charged once per episode, at onset) is harm — a run-only day is never "unrated therefore fine", but a hard-cardio
  day is CLEARED when the next morning positively vouches (fresh readiness ≥ `SUPPORTIVE_READINESS`
  and no brake firing; absent data never vouches). "Morning readiness" comes from the ledger's own
  snapshot for that morning, since the stored Garmin value is the day's LAST sync and so is
  post-workout on any day the athlete trained; the morning read itself is the last predictive
  `brain_decisions` row before the first logged training of the date, never the midnight recompute.
  Check-in `energy`/
  `sleep_feel` still brake at ≤2 and support at ≥4, but a `3` is genuinely NEUTRAL (it still emits an
  observation, so a tapped-in athlete never reads as untracked) — never round it to a brake or a
  support vote. Chat can write the same check-in via the `log_checkin` action
  (`src/chatActions.ts`), 1–5 scales only, and a free-text note there is routed through symptom
  capture only when the athlete's own words carry symptom intent — never automatically.
- **Deload-due is earned by loaded weeks and a log-confirmed shortfall, never the calendar.**
  `classifyLoadedWeeks` (`src/repo/program-state.ts`, feeding the `mesocycle` state) classifies a
  week as loaded only against the median of the loaded weeks before it; a light week breaks the
  streak. `deload-due` comes only from a six-week loaded streak, or four weeks plus a shortfall the
  log confirms plus physiology — never from a weeks-since count. Ratings and notes are supporting
  copy; an applied recovery week only resets the count; a block in weeks 1–2 or its own
  deload/realization phase never reads deload-due.
- **Assist is a sign, and the sign is guarded at log time.** A positive weight typed onto a
  negative-history lift within 1.5× the recent assist band is stored negative (`assistSignContext`,
  `src/repo/sessions.ts`; Garmin imports opt out). An exercise's NAME is never a sign — only its
  history is. `recentWorkingWeight` ranks less assist and more reps as harder.
- **The daily envelope's up direction is `reach`, a separate field — never a sixth posture.**
  `SignalPosture` is a five-value safety ladder. `reach.level='push'` licenses ONE challenge top set
  on the first eligible compound (`src/repo/daily-composition.ts`), computed from the LOGGED working
  weight, never a plan target, and only on a lift the progression engine is moving and did recently;
  composition reports back so the persisted envelope never promises a reach that is not on a card.
  `item.reach` persists only for server-derived items. A hold keeps the progression's own target,
  never an older log, and `earned_floor` is the only composition raise — see `docs/ARCHITECTURE.md`
  "Composition never moves the prescription".
- **Consecutive loading days are a caveat, never a brake of their own** — `daily_decision_v7`,
  `src/repo/day-read.ts`/`daily-decision.ts`. Details in `docs/ARCHITECTURE.md`.
- **The rest trade is carried by the CALENDAR; the ring is never touched** — `tradeRestDay`,
  `src/domain/brain/rest-trade.ts`. Details in `docs/ARCHITECTURE.md`.
- **Day-read prose is a variant set, never one literal.** A stable input fires a stable rule every
  morning, so a single sentence per rule printed verbatim for weeks. Rules carry their own athlete-
  facing `reasons` (`src/repo/brain/day-read-rules.ts`), and every athlete-facing string — outcome
  reason, the read's `why`, the server-policy clamp reason — rotates through `pickDayVariant(date)`.
  Add a phrasing to the set; do not add a literal. Details in `docs/ARCHITECTURE.md`.
- **ONE WORDING PER MORNING PER IDENTITY.** The read's identity is
  `dayReadProseIdentity(date, baseline)` — `(date, kind, decision.rule_code, focus)`, always from the
  DETERMINISTIC baseline, persisted as `prose_identity`. A recompute landing on the same identity keeps
  the cached `headline`/`why` and refreshes only `signals` / `input_fingerprint` / `computed_at`
  (`pinnedDayReadProse`, above the agent call in `computeDayRead`); the agent is asked only on an
  identity change, the athlete's explicit new read, or floor prose (the self-heal path). A bare
  `input_fingerprint` move is NOT material truth in `readToday` — every sync moves it — and the 04:00
  precompute warms the floor only (`precomputeDayReadFloor`) until a sleep row is dated that day, so no
  sentence is written about a night that has not synced. **`invalidateDayRead` marks an agent row
  STALE, it does not delete it** — `getCachedDayRead(date)` hides a stale row, only the reconciling
  paths pass `{ includeStale: true }`; `discardDayRead` is the real delete (reset, a cleared
  directive). A cache-miss open serves the floor and never awaits an agent. Details in
  `docs/ARCHITECTURE.md`.
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
- **Marker grouping**: `MARKER_GROUPS` (in `src/repo/propagation-data.ts`) matches longest-first, and its **array
  order is the display order** — conventional clinical lab-review order, mirrored by the doctor
  export and the in-app catalog. Full ordering rules and the non-clinical-marker filter live in
  `docs/ARCHITECTURE.md`.
- **Marker staleness is per-class, not one number** — `src/repo/marker-validity.ts`; extend the
  table there, never hardcode an age threshold. Details in `docs/ARCHITECTURE.md`.
- **Directives never change anything by themselves.** A flagged marker propagates into
  `health_directives` via `deriveDirectives()`; sources `'markers'` (deterministic) and
  `'health_review'` (agent-emitted) coexist and each clears/rewrites only its own rows. One
  exception to the churn-free diff reconcile: a materially-WORSE trigger from a strictly newer
  draw resurfaces its directive as a fresh row (`resurfaceWorseningDirectives`,
  `resurfaced_from_id`) — news gets a row, never an invisible in-place edit. Directives
  are informational, not medical advice; `uncertain`/uncited ones are a softer nudge. The user flips
  `active|resolved|dismissed`.

- **A painless structural condition is a movement consideration, never an injury.**
  `profile.movement_considerations_json` shapes plan prompts only; filing "mild scoliosis" as an
  `injury` event hard-gates the main lifts forever. Nothing protective may read it. Details in
  `docs/ARCHITECTURE.md`.

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
  there, never re-declare the JSON in another prompt. A stated time may infer an unstated meal label
  (21:00 → dinner); the reverse must never happen. `eaten_at` is rendered to the athlete, so a time
  synthesized from a label would be indistinguishable from one they actually said — the label's hour
  orders a day at read time only, and is never stored.

- **Dose comparability is a per-lift question, not a per-session one** — `dose_evidence`/
  `dose_context.comparable` (`progression.ts`), and `training_drive='push'`'s bounded mechanical
  authority. Details in `docs/ARCHITECTURE.md`.
- **Work done is evidence — a prescription is a suggestion, the log is the truth** —
  `performed_at_full_load` (`src/repo/outcome-comparability.ts`). Details in `docs/ARCHITECTURE.md`.
- **Cut pressure has three shapes, and only two veto an earned promotion** — `CutPressure`
  (`progression.ts`): `hold` never vetoes, `reduce` vetoes unless `near_goal`, `sliding` always
  vetoes, `fast_loss` never vetoes a load step. Details in `docs/ARCHITECTURE.md`.
- **RIR is optional, and its absence is not weakness** — with no RIR logged, capping the prescribed
  rep range on every working set IS the strength signal (`program-state.ts`/`progression-voice.ts`).
  Details in `docs/ARCHITECTURE.md`.
- **Exercise names are resolved through `resolveExerciseName` (`src/repo/exercise-canon.ts`); never
  compare raw `exercises.name`.** One ladder (exact → one alias hop → key → a unique expanded key),
  read by every consumer AND by the `findOrCreateExercise` write chokepoint, so a spelling can never
  split one lift into two histories. Its `key` is the persisted `movement_key` shape — never widen
  it. **A stored name is retitled only through `renameExercise`**: casing lands everywhere at once,
  a same-lift respelling may land from an agent, a rewording is PARKED on `suggested_name` for a
  person's yes/no (never dropped, never forced), and "keep" is remembered on `refused_name`.
  Details in `docs/ARCHITECTURE.md` "Exercise identity: one resolver".
- **The exercise-guide matcher only auto-links a UNIQUE hit**; an implement-only match instead parks
  as a suggestion for a human yes/no, and a hand-confirmed link or refusal both survive re-import.
  Details in `docs/ARCHITECTURE.md`.
- **The session/meal-plan verify pass's numeric floors are computed server-side, not asked of a
  model.** `src/repo/verify-floors.ts` precheck WINS over an agent `ok:true` — a breach it still
  finds is `unresolved` on the outcome, never shipped as clean — and the agent turn is skipped
  entirely when nothing needs judgement. Details in `docs/ARCHITECTURE.md`.

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
which case one global guard in `src/auth.ts` gates `/api` and `/mcp`, exempting only `/api/health`
(any method), `GET /api/apple-health/config`, and `POST /api/apple-health/pairing/exchange` — plus
the static PWA shell, which stays ungated so it can render a token prompt. The PWA sends
`X-Cairn-Token` (or `?token=` on direct resource URLs via
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
