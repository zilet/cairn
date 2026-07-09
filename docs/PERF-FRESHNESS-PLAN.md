# Performance & Freshness Plan — signal-driven caching, wake-up readiness, perceived speed

_Drafted 2026-07-09 from a four-agent audit (Brief/Today freshness, server compute/caching, streaming/perceived-perf, add-exercise flow). Every finding below was traced to file:line and the two most load-bearing claims were independently re-verified in source._

## North star

Today (and every read surface) should be **recomputed when a brain signal lands, then served from cache** — never continuously recalculated, and never computed synchronously on the request path at wake-up. Perceived speed follows the chat precedent: durable background work, instant cached paint, streamed prose where there is prose.

## Verified findings (condensed)

1. **Day-read invalidation is delete-only.** `invalidateDayRead()` (`src/repo/day-read.ts:488`) is called from ~15 signal write paths (sets, sessions, activities, Garmin sync, daily metrics, check-ins, directives, plan/profile/health writes) but nothing recomputes after the delete — the next `/api/today-read` pays a synchronous agent run (90s leash, `src/agents.ts:649`). The 4am precompute (`src/scheduler.ts:330`) is routinely busted by a pre-wake Garmin sync.
2. **A warm PWA never rolls over at midnight.** `state.logDate` is set once (`src/client/app/state.ts:18`); the only `visibilitychange`/`pageshow` handlers re-measure the viewport (`src/client/app/mobile-viewport.ts:126-128`). A resumed app shows yesterday's Brief/date.
3. **Live bug:** `health-picture-controller.ts:94-116` still does a blocking POST to `/health/review` and reads `res.review`, but under default `bg_ops_enabled` the route returns `{ok, job}` (`src/routes/connected-brain.ts:92`) → the UI always shows "the review didn't come back" while the job completes invisibly. Only agentic caller never migrated to `runOp`.
4. **`logWeight` is the one signal that doesn't invalidate the day-read.**
5. **`getProgramState()` (~100–200 sync SQLite queries) is recomputed 2–5× per page render** — handlers don't thread `opts.programState` (`src/routes/program.ts:197-221`), and `getTrajectory` calls it bare (`src/repo/trajectory.ts:217`) inside every `getCoachContext` build (second full compute). `getWeeklyStats` runs up to 6×/render (2× inside `healthStanding`, `standing.ts:523-576`; 3× in `today-agenda`). `getProgress` (`src/repo/sessions.ts:907`) is the unbounded hot primitive under the N+1.
6. **No cross-request cache exists for any deterministic training read.** The proven template is `src/repo/marker-cache.ts` (write-counter + SQL row-count/max-id backstop + test reset).
7. **Add-exercise is inert:** a reps off-plan exercise isn't persisted until its first logged set; there is **no `'exercise'` enrichment kind** (`src/enrich.ts:33`); the ⓘ modal dead-ends "No data yet" pre-log; the art prompt is name-only (`src/art.ts:59`) with muscle/equipment context dropped (`src/routes/art.ts:13-14`); "Ask coach" exists only inside the found:true modal.
8. **Perceived perf:** the durable job pattern already covers 13 op kinds, but the job bus has no `delta` event (phase captions only, `src/agentJobs.ts:35-38`). Cold Today entry is ~6 serial round-trips (`today-plan-session-preparation.ts:161-187`); the plan surface has no warm instant-paint (only the Brief does); Progress→Endurance has zero caching; health-doc enrichment polls 4s×100; 9 render-blocking script tags without `defer` (~1.5MB); Stand/Train snapshots are sessionStorage-only.

## Phase 1 — four parallel tracks (isolated worktrees off local `main`)

### Track A — Freshness kernel (`perf/track-a-freshness`) · Opus
Goal: wake up to a fresh, instant Today; kill the false review error.
- **A1. Recompute-on-invalidate.** Inside `invalidateDayRead()` keep the delete, then schedule a **debounced, coalesced, fire-and-forget** background `precomputeDayRead(today)` (~60s debounce so a 20-set session triggers one recompute). Only for the device-zone "today" (reuse `warmToday`/`client-tz` machinery). Must never throw or block the write path. If no agent is configured/reachable, do **not** re-cache a floor read — leave the miss so the next fetch still tries the agent (preserves current semantics + offline test determinism).
- **A2. `logWeight` → `invalidateDayRead()`** like its sibling signals.
- **A3. Client midnight/resume rollover.** App-level `visibilitychange`+`pageshow` handler (beside, not inside, `mobile-viewport.ts`) plus a midnight timer: recompute `localISO()`; if it differs from `state.logDate` **and** the user hasn't manually picked a date (`state.dayPicked`), advance the date and re-render the active tab (Today at minimum). Brief's localStorage date-guard then does the rest.
- **A4. Migrate the health-review caller to `runOp`** mirroring the health-synthesis caller (`stand-screen.ts:1029` pattern), including `registerJobReconnector` so a reload mid-review reattaches.
- Tests: recompute-on-signal debounce (fake timers ok), no-agent no-op, logWeight invalidation, rollover date-advance unit(s), review-runOp wiring.

### Track B — Server compute & the training-data version cache (`perf/track-b-server`) · Opus
Goal: one `getProgramState` per request, deterministic reads memoized with exact invalidation.
- **B1. Thread the instance.** Pass the already-computed `programState` through the program/performance/trajectory/muscle-trajectory/test-week route + MCP handlers (`opts.programState` already exists) and give `getTrajectory` a `programState` param so `getCoachContext` (`coach.ts:599` vs `trajectory.ts:217`) computes it once.
- **B2. Kill intra-call redundancy.** `healthStanding` computes weekly-stats/weight/BP/body-comp twice (`standing.ts:523-527` vs `:565-576`); `today-agenda` calls `getWeeklyStats` 3× (`:233,292,328`). Compute once, share.
- **B3. `bumpTrainingDataVersion()`** — a process-wide counter mirroring `marker-cache.ts` exactly (counter + SQL row-count/max-id backstop against restores/imports + a test-reset hook wired into `test/_isolate.mjs` like `resetMarkerHistoryCache`). Bump from: `logSetByName`/`finishSession`/session edit, `logWeight`, activity/Garmin writes, plan edits, block advance, check-in/daily-metrics, profile. Memoize on it: `getProgramState`, `getWeeklyStats`, `estimateExpenditure` (also keyed on latest food-note), optionally `healthStanding`/`performanceStanding` (composite training+marker version). Serve `structuredClone`s.
- **B4. `getProgress` scan** — evaluate; est-1RM/PR need all-time history, so likely keep full scan but ensure it's only hit through the memo. Bound only if provably safe.
- Tests: memo hit/miss on version bump, backstop catches out-of-band writes, golden outputs unchanged vs uncached path.

### Track C — Exercise enrichment (`perf/track-c-exercise`) · Opus
Goal: adding an exercise triggers the agentic brain — proper naming, instructions, good art, ask-coach.
- **C1. Persist at add.** The reps-mode off-plan add (`today-add-exercise-controller.ts:157`) calls `POST /api/exercises` like the timed path already does (`:192`), so the row exists immediately.
- **C2. New `enrich.ts` kind `'exercise'`** (serial queue, status machine, `recoverPendingEnrich`, skip-when-no-agent — all existing patterns). Job: canonicalize/dedup the name (reuse `cleanExerciseName`/`planExerciseAliases`/`classifyMuscleGroup`), fill muscle group/mode/cues, **warm the explanation** (`explainExercise` → `ai_cache`), and **pregenerate art** under a context-aware phrase.
- **C3. Exercise-aware art prompt.** Add a muscle-group/equipment-aware variant to `stylePrompt("exercise", …)` (`art.ts:55-59`); thread context from the enrich job via `pregenerate` (`art.ts:397`) so niche names render the actual movement.
- **C4. Affordances.** `missingExerciseDetailHtml` (`exercise-detail-render-client.ts:27`) gets a "generating your guide…" state + Ask-coach; the session card ⓘ works pre-log; reuse the `gotoChatWith` prefill (`exercise-detail-actions-client.ts:32`).
- Regenerate `docs/API.md`/`docs/MCP-TOOLS.md` if any endpoint/tool signature changes (`npm run docs:index`).
- Tests: enrich kind status flow offline (stub agent), add-time persistence, alias dedup, art-prompt variant unit.

### Track D — Instant UI (`perf/track-d-ui`) · Sonnet
Goal: no gratuitous spinner, no serial waterfall, cold start unblocked.
- **D1. Collapse the cold-Today waterfall:** `Promise.all` the independent waves in `today-plan-session-preparation.ts:161-187` (last-sets + prescriptions; cardio+settings off the blocking path).
- **D2. Plan-surface warm instant-paint:** snapshot the Today plan surface like Stand (`cairn.stand.v1`) / Train (`cairn.train.v1`) so warm re-entry paints instantly and revalidates quietly; don't refetch `/program/progression` on the blocking path when SWR is warm.
- **D3. Progress→Endurance snapshot/SWR** (copy the Train-overview pattern; it currently full-spinners every entry, `progress-endurance-controller.ts:43-79`).
- **D4. `defer` the 9 bundle script tags** in `public/index.html` (order among defer scripts is preserved; keep `/art.js` + body-figure before the bundles; verify boot with the IIFE shared-global model).
- **D5. Stand/Train snapshots → localStorage** (with a schema-version guard + size cap) so they survive cold launch like the Brief.
- Constraint: client-only; no server changes. Tests: existing suite + `npm run smoke:browser` if runnable locally.

### Shared constraints (all tracks)
- Branch from **local `main`** (`a0504843`); work only in your assigned worktree.
- Repo conventions per `CLAUDE.md`: ESM with explicit `.js` import extensions; client source of truth is `src/client/**` (never hand-edit `public/js/*`); `escHtml`/`escAttr` for anything rendered into `innerHTML`; migrations pattern for any schema change.
- **Do NOT bump `public/sw.js` `CACHE`** — the orchestrator bumps once at integration to avoid four-way conflicts.
- Full `npm test` green in your worktree before reporting; the orchestrator (Fable) independently re-verifies, reviews every diff, and merges sequentially.

## Phase 2 — BUILT (2026-07-09, four parallel tracks, merged E last)
- **E. Stream prose into cards** (`perf2/track-e-stream`) — SHIPPED. `delta` events on the job bus (ephemeral, bus-only); the four prose-bearing ops (health synthesis, session-suggest, nutrition check-in, weekly read) reshaped to a shared prose-first reply contract (`prompt/shared.ts` sentinels + `renderStreamingContract` + `extractMarkedJson`); `runChosenStreaming` (streams only when the first agent is stream-capable, falls back to the untouched one-shot rotation on any failure); `jobStreamFilter.ts` buffers until the reply marker so tool narration never reaches a card (no reset event needed); `runOp({stream:true})` paints escaped prose + caret into the anchor, done-render swaps in place.
- **F. Enrichment status → SSE** (`perf2/track-f-sse`) — SHIPPED. Status-transition bus (`enrichBus.ts`, a leaf module wired into the repo status setters — the choke point every `enrichment_status` write crosses); `GET /api/{activities,food-notes,health-docs}/:id/stream` (shared `routes/enrich-stream.ts`, snapshot → transitions → close on terminal, on the query-token auth allowlist); `pollEnrichment` is SSE-first with the unchanged poll loop as fallback; the Fuel "estimating…" badge clears in place when a food estimate lands.
- **G. Synthesis drift-staleness** (`perf2/track-g-drift`) — SHIPPED. `saveHealthSynthesis` stamps a `drift_sig` (directive content keys — not ids, which churn on re-derive; latest review id; session count with a +7 threshold; bucketed 21-day weight trend with a ±0.75 lb/wk dead-band; active-injury id set); `getHealthSynthesisView` reads stale on `new_labs` (unchanged) OR meaningful `drift`, with an additive `stale_reason`. Legacy/unreadable signatures compare as "can't tell → not stale".
- **H. `api()` hardening** (`perf2/track-h-api`) — SHIPPED. In-flight GET dedupe (entry keyed on the fetch settling, so the 401 never-settling auth-prompt promise can't wedge a path); ~1.5s micro-TTL cache for exactly `/settings` `/profile` `/stats` `/coaching-focus`, invalidated by any non-GET; 20s timeout on GETs only (never uploads), skipped when the caller brings its own signal; non-GETs never coalesce (outbox replay untouched).
- **Code-splitting bundle-02-today / bundle-05-me-health — evaluated, DECLINED.** Phase 1's `defer` already removed the bundles from the parse-blocking path; a bundle reshape re-enters the shell-reshape breakage class (smoke assertions, Dockerfile COPY, deploy health check) for a marginal win under the IIFE shared-global load-order model. Revisit only if profiling shows main-thread parse cost mattering on target hardware.
- Build note: `npm run format` hardcodes `biome format --write .` (whole repo, which is NOT biome-clean at rest) — scope formatting with `./node_modules/.bin/biome format --write <files>` directly.

## Orchestration & review protocol
- Implementation: Track A/B/C on Opus, Track D on Sonnet, in parallel, each in its own git worktree + branch.
- Review: Fable reviews each track's full diff, independently runs the suite in the worktree, requests fixes, then merges tracks one at a time into `main` (order: A → B → C → D), resolving overlaps (e.g. `sessions.ts` is touched by A2 and B3) and bumping `sw.js` `CACHE` once with the final client-asset state.
- Verification gate before deploy: `npm run verify:full` on merged `main`.

## Done alongside this plan (2026-07-09)
- Agent CLI pins bumped: Claude Code → 2.1.205, Codex → 0.143.0 (Dockerfile, `scripts/update-agent-clis.sh`, `docs/DEPLOYMENT.md`); Antigravity/Grok installer SHA256 pins verified unchanged; npm deps all current for the Node-24 line; `npm audit` clean.
