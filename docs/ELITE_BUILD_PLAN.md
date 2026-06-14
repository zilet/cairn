# Cairn — Elite Build Plan

> **Goal (`/goal`):** an elite agentic medical / health / fitness / wellbeing system with elite UI/UX.
> Smart, **predictive**, **knowledgeable / self-researching**, **reacts as data changes**, **self-stores and updates memory**.
> Every change holds Cairn's constitution (`docs/VISION.md`): calm, suggestion-not-a-gate, **no numeric scores**, pull-never-push, health findings informational-not-medical-advice.

This plan turns the comprehensive review into an orchestrated, parallel, worktree-isolated build. It is the **coordination contract**: stream owners must honor the shared assignments below to keep merges clean.

---

## Orchestration model

- Integration branch: **`elite-build`** (off `main`). Each stream runs in its own git **worktree** branch, commits there, and is merged back into `elite-build` in meaningful groups by the orchestrator.
- A **comprehensive quality review** + **build check** runs before `elite-build` → `main`.
- Streams must **only edit files they own** (matrix below). Shared/append-only files (`db.ts`, `migrate.ts`, `api.ts`, `mcp.ts`, `prompt.ts`, `repo.ts`) are edited additively — add new functions/routes/tables/columns, do not rewrite unrelated regions.
- **Docs are owned by the orchestrator** (housekeeping pass). Streams DO NOT edit `CLAUDE.md`, `docs/VISION.md`, `docs/OPERATIONS.md`, this file. Stream 5 owns `public/` incl. the `sw.js` cache bump.

### Shared resource assignments (collision avoidance)

| Resource | Owner | Value |
|---|---|---|
| Migration **v27** | Stream 2 (memory) | `memory` columns: `updated_at`, `superseded_by`, `confidence`, `last_referenced_at` |
| Migration **v28** | Stream 4 (research) | `settings.research_enabled` column |
| Migration **v29** | Stream 1 (runtime) | `settings.proactive_enabled` column (only if needed) |
| New table `agent_runs` | Stream 1 | `CREATE TABLE IF NOT EXISTS` in `db.ts` (no migration) |
| New table `suggestions` | Stream 2 | `CREATE TABLE IF NOT EXISTS` in `db.ts` (no migration) |
| New table `evidence_cache` | Stream 4 | `CREATE TABLE IF NOT EXISTS` in `db.ts` (no migration) |
| `src/research.ts` (new file) | Stream 4 | — |
| `public/sw.js` cache bump | Stream 5 | `cairn-v48` → `cairn-v49` |

If a stream needs a migration version beyond its assignment, STOP and flag the orchestrator — never pick an arbitrary number.

### Shared API contracts (so Stream 5 can build against endpoints before they exist in its worktree)

- `GET /api/agent-stats` → `{ runs, ok_rate, by_agent:[{agent,ok,fail,p50_ms}], recent:[…] }` (Stream 1)
- Proactive insights/weekly-read appear in existing `GET /api/insights` (Stream 1 precompute writes them).
- Memory: chat `actions[]` gains `update_memory {id, content}` and `supersede_memory {id, reason, replacement?}`; `GET /api/memory` rows gain `updated_at`/`superseded_by` (Stream 2). Superseded rows are hidden from `listMemory` by default.
- Forecast fields: `GET /api/markers/priority` markers gain `trend.projection` (plain-language string, no number-as-score) and `forecast:{eta_text, direction}`; `GET /api/nutrition/expenditure` gains `projected_goal_date`/`projection_text`; `GET /api/recovery` gains `baseline:{sleep,hrv,rhr}` + `delta` (Stream 3).
- Research: `GET/PUT /api/settings` gains `research_enabled`; health reviews/directives carry verified `citation` + `source_url` (Stream 4). Optional `POST /api/research` `{question}` → cached evidence.
- Provenance: directives expose enough for Stream 5 to render a causal line ("tilted toward fish — ApoB high · why") on meal/session cards — reuse `directivesForCoach`/`GET /api/directives`.

---

## Streams

### Stream 1 — Agent Runtime & Proactivity (`runtime`)
**Why:** the loop is single-shot, fragile, unobservable; proactivity is one brittle cron.
**Scope:**
1. `agents.ts` — harden `extractJson` (balanced-brace scan respecting string literals + truncation salvage of last balanced `}`); one-shot JSON-repair retry in `runAgentWithFallback` (same agent re-prompted "re-emit ONLY valid JSON" before falling through); per-call **circuit breaker** (decaying in-memory failure count, skip/shorten-timeout an agent that just failed N times); **interactive vs background timeouts** (e.g. 90s interactive, 300s background — add an opts arg).
2. Telemetry — `agent_runs` table (op, agent, ok, parsed, latency_ms, tried_json, created_at); `recordAgentRun`/`getAgentStats` in `repo.ts`; write one row per `runChosen`/`runAgentWithFallback`/day-read. `GET /api/agent-stats` + MCP `get_agent_stats`.
3. Proactivity in `scheduler.ts` — nightly quiet **insight** + weekly **weekly_read** precompute (store via `generateInsight`, never notify); **scheduled nutrition check-in** draft on cadence; make the weekly coach draft **miss-tolerant** (fire if slot passed and not run since, not exact hour equality). Gate proactivity behind `settings.proactive_enabled` (default on) — migration **v29** only if you add the column.
**Owns:** `src/agents.ts`, `src/scheduler.ts`, `src/coachOps.ts` (telemetry wraps only), `src/dayread.ts` (telemetry). **Additive** in `src/db.ts` (agent_runs table), `src/repo.ts` (recordAgentRun/getAgentStats + proactive helpers), `src/api.ts` + `src/mcp.ts` (agent-stats endpoint/tool).

### Stream 2 — Self-Updating Memory (`memory`)
**Why:** the headline gap vs the goal. Memory is a flat append-only log; exact-match dedup; recency-window retrieval; never updates or supersedes; no outcome learning. The v26 directive-feedback engine already proves the team can build conflict-aware self-updating memory — generalize it.
**Scope:**
1. Schema (migration **v27**): `memory.updated_at`, `memory.superseded_by` (id, nullable), `memory.confidence` (real, default 1), `memory.last_referenced_at`. Mirror into the `CREATE TABLE` in `db.ts`.
2. `addMemory` — **semantic dedup** (reuse the Jaccard `normInsight`/overlap used by `isDuplicateInsight`): near-duplicate → update existing row's content/`updated_at`/bump confidence instead of inserting.
3. **Retrieval ranking** — new `memoryForCoach()` that always includes load-bearing kinds (`constraint`/`injury`/`preference`/`decision`) + recent observations, hides superseded rows; feed it into `getCoachContext` instead of raw `listMemory(40)`.
4. **Supersession** — `supersedeMemory(id, replacementContent?)`; chat actions `update_memory`/`supersede_memory` (api + mcp); chat prompt sees memory ids and may emit them.
5. **Consolidation pass** — quiet periodic op (`coachOps.ts` + a `buildMemoryConsolidationPrompt`) that merges near-duplicates, supersedes contradictions, promotes recurring observations to preferences. Scheduled from `scheduler.ts` (coordinate cadence note with Stream 1; additive).
6. **Grow `about_me` from memory** — op that rewrites `about_me` as a coherent person-model from typed memory + family + check-ins (user still curates; per constitution).
7. **Outcome learning** — `suggestions` table (new) recording what the Brief/session-suggest/nutrition-checkin proposed; a reconciliation op compares suggestion→actual (logged sets, weight trend, autoregulation) and writes durable learnings; surface via `getCoachContext`.
**Owns:** memory region of `src/repo.ts`, new memory/outcome ops. **Additive** in `src/db.ts` (memory cols + suggestions table), `src/migrate.ts` (v27), `src/prompt.ts` (chat/distill memory-action grammar + consolidation + about-me prompts), `src/api.ts` + `src/mcp.ts` (memory actions/endpoints), `src/coachOps.ts` (consolidation/about-me/outcome ops), `src/scheduler.ts` (schedule consolidation — append only).

### Stream 3 — Predictive Brain & Medical Depth (`brain`)
**Why:** forecasts nothing; drops the load signals it already pulls; 16-marker lookup with no cross-marker reasoning.
**Scope:**
1. **Forecasting** — replace the two-point `trend` (`getMarkerHistory`) with a least-squares slope + plain-language projection ("trending toward optimal, ~6 weeks out" — words, never a score); feed a projected-crossing signal into `prioritizeMarkers` so a marker *heading* out of optimal ranks above a stably-borderline one.
2. **Acute-vs-chronic baselines** — `getRecoverySummary` returns `{recent (7d), baseline (30d), delta}` for sleep/HRV/RHR; surface Garmin `acute_load`, `training_readiness`, `fitness_age` into `getGarminCoachSummary` aggregates + `renderConnectedBrain` recovery line (data already captured, currently dropped).
3. **Goal-pace projection** — `computeGoalCheck` adds `projected_goal_date`/`projection_text`.
4. **Predictive deload anticipation** — `dayRead` uses the acute-load/HRV-trend baseline to anticipate fatigue *before* 3 hard days ("two more hard days and you'll want a reset").
5. **Medical depth** — expand `OPTIMAL_ZONES` + `MARKER_MAPPINGS` (Lp(a) once-in-life flag, thyroid/TSH+free T3/T4, B12/folate, magnesium, testosterone/estradiol, eGFR/creatinine with supplement caps, ALT/AST pair). Add **cross-marker synthesis** in `deriveDirectives` (ApoB+Lp(a)+hs-CRP → one elevated-cardiovascular read; ferritin+Hgb+MCV → anemia-pattern). Fix the **vitamin-D unconditional directive** (add `ctx.side==="low"` guard).
**Owns:** marker/recovery/directive/dayRead/nutrition-math regions of `src/repo.ts`, `src/dayread.ts`. **Additive** in `src/prompt.ts` (`renderConnectedBrain`, `buildDayReadPrompt`, `buildHealthReviewPrompt`), `src/garmin.ts` (surface acute_load if needed), `src/api.ts` + `src/mcp.ts` (new response fields only — no new routes needed). **No schema** (markers live in JSON). Coordinate `getCoachContext` edits with Stream 2 (different keys).

### Stream 4 — Research & Grounding (`research`)
**Why:** "does its own research" is unbuilt; citations unverified (hallucination risk on a medical system); embedded knowledge frozen/stale.
**Scope:**
1. **Host-side research op** — new `src/research.ts`: `researchEvidence(question, markers)` runs a dedicated agentic call (configured CLI, which has web access) with a research-grounding prompt requiring a `sources[]` array (title + URL); results cached.
2. **`evidence_cache` table** (new) — `(id, topic, marker, claim, source_title, source_url, body, confidence, retrieved_at)`, with a TTL re-research helper.
3. **Citation verification** — in `runHealthReview`/`applyReviewDirectives`, a directive's `citation` must match an `evidence_cache` row or a guideline-body allowlist; else downgrade to `uncertain:true` and strip the unverifiable string. `deriveDirectives` reads fresh `evidence_cache` rows where present instead of frozen strings.
4. **Supplement / interaction safety gate** — before any directive that suggests a supplement (D3/iron/B-complex/creatine/magnesium), a `safetyGate()` keyed off the user's markers (iron+normal/high ferritin, D3 dose+existing level, creatine+low eGFR) downgrades/annotates unsafe suggestions.
5. **Setting** — `settings.research_enabled` (migration **v28**, default off; informational-not-medical framing preserved). Optional `POST /api/research`.
**Owns:** `src/research.ts` (new), evidence/safety region of `src/repo.ts`. **Additive** in `src/db.ts` (evidence_cache + settings col), `src/migrate.ts` (v28), `src/prompt.ts` (health-review grounding + a research prompt), `src/coachOps.ts` (wire research into review), `src/api.ts` + `src/mcp.ts` (settings + optional research endpoint), `agents.json` (optional tool flags for the claude agent — additive).

### Stream 5 — Elite UI/UX (`ui`)
**Why:** elite craft, but first paint blocks on agent calls (no skeletons), chat doesn't stream, no SW-update/offline UX, the connected-brain story is buried.
**Scope:**
1. **Skeleton-first paint** every tab (reuse `loadingState()`/`.hshimmer`); **non-blocking Brief** — render Today from the cached/deterministic read instantly, upgrade to the agentic read with the existing `.is-thinking` filament; never block paint on `agent:"auto"`.
2. **Chat progressive states** — phase captions (thinking → drafting) + faster perceived response; if a streaming endpoint is not feasible against the JSON-contract CLI, deliver the strongest non-streaming perceived-latency UX (optimistic, phased). (True token streaming is out of scope unless trivially safe.)
3. **PWA robustness** — SW `updatefound`/`waiting` listener + "Cairn updated — tap to refresh" toast (reuse `toast()`); `navigator.onLine` + fetch-failure hairline offline banner; bump `CACHE` to `cairn-v49`.
4. **Accessibility** — split the blanket `prefers-reduced-motion` rule (kill decorative, keep functional transitions); darken `--muted` to clear WCAG AA for label use; `aria-busy`/`role=status` on thinking states.
5. **Connected-brain provenance** — quiet causal line on meal/session cards ("tilted toward fish — ApoB came back high · why"), deep-linking the directive; surface the new forecast/agent-stats fields where appropriate (Settings agent-health card).
**Owns:** `public/app.js`, `public/styles.css`, `public/sw.js`, `public/index.html`. Build against the **shared API contracts** above; degrade gracefully if a field is absent (backend merges land alongside).

---

## Merge order & quality gates

1. Merge **Stream 1** (runtime/telemetry foundation) → `npx tsc --noEmit`.
2. Merge **Stream 3** (brain) → build check.
3. Merge **Stream 2** (memory) → build check; resolve `getCoachContext`/`scheduler.ts` overlaps.
4. Merge **Stream 4** (research) → build check.
5. Merge **Stream 5** (UI) — frontend, conflict-free with backend.
6. **Comprehensive quality review** (parallel reviewers: correctness/security, constitution-compliance, build+smoke with the `stub` agent).
7. **Housekeeping:** update `CLAUDE.md` (schema → v28/v29, new tables/endpoints/tools), `docs/VISION.md` progress log, `docs/OPERATIONS.md` if needed, confirm `sw.js` bump, `npm run build`.
8. Merge `elite-build` → `main`.

## Quality gates every stream must pass before "done"
- `npx tsc --noEmit` clean in the worktree.
- ESM `.js` import extensions; NodeNext.
- New columns added in **both** `db.ts` CREATE TABLE and `migrate.ts` (assigned version).
- Constitution honored: no numeric scores surfaced, suggestion-not-a-gate, pull-never-push, informational-not-medical.
- Graceful degradation (no agent / no key / feature disabled → calm no-op, never a crash).
- Commit work in the worktree with a clear message; do not edit files outside ownership; do not touch `CLAUDE.md`/`docs/*` (orchestrator housekeeping).

## Progress tracker
- [ ] Stream 1 runtime — spawned / merged
- [ ] Stream 2 memory — spawned / merged
- [ ] Stream 3 brain — spawned / merged
- [ ] Stream 4 research — spawned / merged
- [ ] Stream 5 ui — spawned / merged
- [ ] Quality review
- [ ] Housekeeping + docs
- [ ] elite-build → main
