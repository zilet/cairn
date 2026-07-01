# Cairn Engineering Maintenance Plan

This is the execution plan for making Cairn easier to maintain long term while preserving the product constitution in `docs/VISION.md`: calm by default, you drive, no scores, no pressure, and one connected brain.

The plan is staged as waves. Each wave can be run by multiple agent teams in parallel, but a wave is not complete until its shared quality gate is green. The guiding rule is simple: improve quality first, strengthen gates second, then migrate frontend TypeScript in a no-fluff way that protects the existing vanilla PWA.

This tracker records the verified maintenance baseline. The next-stage full frontend TypeScript and component-system migration is tracked in `docs/TYPESCRIPT_FRONTEND_MIGRATION_PLAN.md`.

## Status Tracker

| Wave | Status | Gate |
| --- | --- | --- |
| Wave 0 - Baseline recovery | Complete | `npm run verify` green |
| Wave 1 - Quality contracts | Complete | deterministic tests cover drift-prone contracts |
| Wave 2 - Route and screen identity | Complete | deep links round-trip to tabs, subviews, dates, selected records, and chat sessions |
| Wave 3 - Backend module grouping | Complete | REST/MCP/docs parity still green after domain extraction |
| Wave 4 - Frontend TypeScript foundation | Complete | client typecheck runs with no new framework and no unnecessary dependencies |
| Wave 5 - High-risk frontend migration | Mostly complete | generated browser source now lives under `src/client`; live route-console smoke is green; large screen-controller modules still need shrinking |
| Wave 6 - Brain and memory hardening | In progress | typed conductor/memory/chat-action spine and deterministic DTO coverage are in place; remaining coach-context slices still need narrower DTOs |
| Wave 7 - Final consolidation | In progress | `npm run verify` green; built/Pi HTTP app-shell smoke exists; live Chrome route-console smoke is green; final automated browser workflow lane is still pending |

## Non-Negotiables

- Keep Cairn self-hosted, private, and dependency-light.
- Do not add a frontend framework.
- Do not add runtime dependencies unless a gate cannot be made reliable without one.
- Keep the existing vanilla PWA feel and design contract.
- Preserve the propose -> review -> apply loop for plan-affecting or clinical behavior.
- Keep REST and MCP additive mirrors over the same domain logic.
- Every public UI route must remain bookmarkable or gain a stable replacement route.
- Any `public/` behavior change must account for the service-worker cache contract.

## Wave 0 - Baseline Recovery

Goal: restore confidence before changing architecture.

Agent teams:

- Test Gate Agent: run `npm run verify`, isolate failures, and fix time-sensitive or brittle tests.
- Drift Agent: search for rolling-window tests with fixed absolute dates and move them to stable relative fixtures or injectable clocks.
- Contract Agent: confirm docs, action pins, launch safety, and service-worker checks still pass after fixes.

Tasks:

- [x] Fix the current endurance-marker test drift caused by hard-coded March 2026 fixture dates falling outside the rolling 120-day window.
- [x] Add a small guard pattern for future rolling-window tests: use relative fixture dates or an injected clock.
- [x] Run the focused failing test.
- [x] Run `npm run verify`.

Gate:

- `npm run verify` is green.

## Wave 1 - Quality Contracts

Goal: make drift harder before reorganizing modules.

Agent teams:

- Time/Window Agent: identify deterministic reads that use `Date.now()` or local date helpers, and ensure tests do not silently age out.
- API Shape Agent: identify major REST payloads consumed by the PWA and define shared contracts for them.
- Safety Agent: preserve health, auth, upload, and agent-execution invariants.

Tasks:

- [x] Add local-day regression tests for expenditure, next-best-step, program balance, and acute muscle-load reads.
- [x] Thread one explicit local day through the high-risk coach-context reads that were deriving their own UTC "today".
- [x] Add tests or helpers for rolling-window fixtures in health, endurance, recovery, update checks, and Today agenda.
- [x] Introduce typed contract files for first high-risk payloads without changing runtime behavior.
- [x] Anchor routed Today agenda weekly producers to the requested date so `/app/today?date=...` does not borrow the live week.
- [x] Keep docs generation and surface parity checks authoritative.
- [x] Keep `npm run verify` as the minimum merge gate.

Gate:

- Test fixtures are date-stable.
- No contract test depends on the real calendar unless the test explicitly controls it.
- `npm run verify` is green.

## Wave 2 - Route And Screen Identity

Goal: make Cairn linkable without turning it into a routed SPA framework.

Why this matters: Cairn has useful sub-surfaces, but a user should be able to link directly to Today for a date, Plan Coach, Plan Meals daily fuel, Progress Program, Me Standing, Health Markers, a health record, a chat session, or Settings Data.

Agent teams:

- Router Agent: design the minimal client route model.
- UI State Agent: map existing `state.tab`, sub-segment fields, selected dates, and detail sheets into stable URLs.
- Compatibility Agent: preserve old tab-only behavior and avoid breaking existing links.
- Test Agent: add route round-trip tests.

Route shape:

- Canonical path form: `/app/<tab>/<section?>`.
- Query state for lightweight selections: `?date=YYYY-MM-DD`, `?id=123`, `?jump=coach`.
- Legacy hash fallback may be accepted, but canonical links should be path based.
- Server fallback should serve `public/index.html` for PWA routes while leaving `/api/*`, `/mcp`, static assets, report/export paths, and auth exceptions intact.

Examples:

- `/app/today?date=2026-06-29`
- `/app/plan/coach`
- `/app/plan/meals?date=2026-06-29`
- `/app/progress/program`
- `/app/me/standing`
- `/app/me/health/markers`
- `/app/me/health/records?id=42`
- `/app/chat?session=chat_17`
- `/app/settings/data`

Tasks:

- [x] Define a small route parser and serializer in the client shell.
- [x] Update tab/subview activation to read from and write to the URL for core tabs and nested segments.
- [x] Add browser-history handling for back/forward.
- [x] Add server fallback tests to ensure PWA routes return the app shell.
- [x] Add client contract tests for route parse/serialize round trips.
- [x] Ensure service-worker navigation fallback handles `/app/*`.
- [x] Update PWA shortcuts to canonical `/app/*` routes.
- [x] Promote chat history sessions from `archived_at` lookup to a stable shareable session id before treating `/app/chat?session=...` as complete.

Gate:

- Deep links restore the intended tab, section, date, selected health record, and archived chat session.
- Existing root `/` behavior still opens Today.
- API, MCP, exports, report, uploads, and static asset paths are untouched.

## Wave 3 - Backend Module Grouping

Goal: reduce registry and barrel pressure while preserving the current external API.

Agent teams:

- Training Domain Agent: group plan, sessions, exercises, progression, program-state, performance, run progression, and muscle trajectory.
- Health Domain Agent: group health documents, markers, lab units, propagation, symptom links, DEXA, synthesis, report, guidelines, and evidence.
- Person Domain Agent: group profile, memory, family, context events, reaction model, trajectory, and next step.
- Surfaces Agent: extract REST and MCP registrations into domain surface modules.
- Parity Agent: update docs generation and surface parity checks whenever mounted modules move.

Target structure:

- `src/domain/training/*`
- `src/domain/health/*`
- `src/domain/nutrition/*`
- `src/domain/person/*`
- `src/brain/*`
- `src/surfaces/rest/*`
- `src/surfaces/mcp/*`
- `src/infra/*`

Tasks:

- [x] Add additive domain entry points under `src/domain/*` so future callers can import by product domain.
- [x] Keep `src/repo.ts` as a compatibility barrel until all callers are migrated.
- [x] Extract REST routes by domain without changing route paths.
  - [x] Move chat send/history/session/reset/turn-stream REST routes into `src/routes/chat.ts` while preserving `/api/chat*` paths.
  - [x] Move durable agent-job REST routes into `src/routes/agent-jobs.ts` while preserving `/api/agent-jobs*` paths.
  - [x] Move day-coach REST routes into `src/routes/day-coach.ts` while preserving `/api/today-read*`, `/api/session-suggest`, and `/api/week-ahead`.
  - [x] Move system health/version/update REST routes into `src/routes/system.ts` while preserving `/api/health`, `/api/version`, `/api/update-status`, and `/api/update-check`.
  - [x] Move profile, goal, bodyweight, blood-pressure, and check-in REST routes into `src/routes/person.ts` while preserving their `/api/*` paths.
  - [x] Move generated-art REST routes into `src/routes/art.ts` while preserving `/api/art*` paths and cache/miss semantics.
  - [x] Move operator/settings REST routes into `src/routes/operator.ts` while preserving `/api/agents*`, `/api/agent-clis/update`, `/api/settings`, and `/api/agent-stats`.
  - [x] Move personal context, injury-impact, family, supplement, and onboarding REST routes into `src/routes/person-context.ts` while preserving `/api/context-events*`, `/api/injury-impacts`, `/api/family*`, `/api/supplements*`, and `/api/onboard`.
  - [x] Move Garmin ingest/reconcile REST routes into `src/routes/garmin.ts` while preserving `/api/garmin*` paths and lazy sync/enrichment imports.
  - [x] Move export and clinician-report REST routes into `src/routes/exports.ts` while preserving `/api/export*`, `/api/health-export`, and `/api/health-report*` response headers and filenames.
  - [x] Move source-agnostic daily metrics and recovery REST routes into `src/routes/health-metrics.ts` while preserving `/api/health-metrics` and `/api/recovery`.
  - [x] Move memory, about-me growth, suggestion reconciliation, and learning REST routes into `src/routes/memory-learning.ts` while preserving `/api/memory*`, `/api/profile/grow-about-me`, `/api/suggestions*`, and `/api/learnings`.
  - [x] Move nutrition, meal-plan, food-note, frequent-food, and chat-image REST routes into `src/routes/nutrition.ts` while preserving `/api/coach/mealplan`, `/api/nutrition*`, `/api/mealplans*`, `/api/meal-plans*`, `/api/food-notes*`, `/api/frequent-foods`, and `/api/chat-images*`.
  - [x] Move plan editing, exercise CRUD/detail, exercise reconciliation, and variation REST routes into `src/routes/plan-exercises.ts` while preserving `/api/plan*`, `/api/exercises*`, `/api/exercise*`, and `/api/program/variations`.
  - [x] Move session, set, activity, cardio, stats, volume, and calendar REST routes into `src/routes/training-log.ts` while preserving `/api/sessions*`, `/api/sets*`, `/api/activities*`, `/api/progress*`, `/api/recent-training`, `/api/stats`, `/api/endurance-prs`, `/api/run-compliance`, `/api/cardio`, `/api/endurance-goal`, `/api/volume`, and `/api/calendar`.
  - [x] Move program proposal, evolution, progression, performance, run-plan, muscle-trajectory, and DEXA-targeting REST routes into `src/routes/program.ts` while preserving `/api/agent/run`, `/api/program*`, `/api/proposals*`, `/api/program-state`, `/api/performance`, `/api/run-plan`, `/api/run-zones`, `/api/muscle-trajectory`, `/api/test-week`, and `/api/dexa-targeting`.
  - [x] Move connected-brain, health synthesis, marker/directive, research/evidence, next-step, and insight REST routes into `src/routes/connected-brain.ts` while preserving `/api/health*`, `/api/markers*`, `/api/reaction-model`, `/api/trajectory`, `/api/context-effect`, `/api/next-step*`, `/api/coaching-focus`, `/api/directives*`, `/api/symptom-links`, `/api/research`, `/api/evidence*`, and `/api/insights*`.
- [x] Extract MCP tool registration by domain without changing tool names.
  - [x] Add modular MCP registration infrastructure and move update-status/check-update tools into `src/surfaces/mcp/system.ts` without changing tool names.
  - [x] Move chat history/search/reset MCP tools into `src/surfaces/mcp/chat.ts` without changing tool names.
  - [x] Move day-read, session-suggestion, and week-ahead MCP tools into `src/surfaces/mcp/day-coach.ts` without changing tool names.
  - [x] Move Garmin connector/source/sync/reconciliation MCP tools into `src/surfaces/mcp/garmin.ts` without changing tool names.
  - [x] Move recovery MCP tools into `src/surfaces/mcp/health-metrics.ts` without changing tool names.
  - [x] Move memory, about-me growth, suggestion audit, and outcome reconciliation MCP tools into `src/surfaces/mcp/memory-learning.ts` without changing tool names.
  - [x] Move connected-brain, health synthesis, directives, evidence, research, and next-step MCP tools into `src/surfaces/mcp/connected-brain.ts` without changing tool names.
  - [x] Move Today agenda, learned timeline, guidelines, and quiet-insight MCP tools into `src/surfaces/mcp/daily-driver.ts` without changing tool names.
  - [x] Move health-record MCP capture tools into `src/surfaces/mcp/health-records.ts` without changing tool names.
  - [x] Move nutrition, meal-plan, recipe, and food-note MCP tools into `src/surfaces/mcp/nutrition.ts` without changing tool names.
  - [x] Move agent/operator, Settings, art-stats, and agent-stats MCP tools into `src/surfaces/mcp/operator.ts` without changing tool names.
  - [x] Move profile, bodyweight, blood-pressure, check-in, and daily-metric MCP tools into `src/surfaces/mcp/person.ts` without changing tool names.
  - [x] Move personal context, family, supplement, injury-impact, and onboarding MCP tools into `src/surfaces/mcp/person-context.ts` without changing tool names.
  - [x] Move plan, plan-day, exercise catalog, exercise merge/reconcile, and variation MCP tools into `src/surfaces/mcp/plan-exercises.ts` without changing tool names.
  - [x] Move program-state, progression, periodization block, run-plan, DEXA-targeting, muscle-trajectory, and proposal MCP tools into `src/surfaces/mcp/program.ts` without changing tool names.
  - [x] Move set logging, training history, activity, volume, calendar, skip, and session-feedback MCP tools into `src/surfaces/mcp/training-log.ts` without changing tool names.
  - [x] Move weekly stats, cardio readouts, endurance PRs/compliance, and endurance-goal MCP tools into `src/surfaces/mcp/training-status.ts` without changing tool names.
  - [x] Keep `src/mcp.ts` as a registry/HTTP adapter only; contract now rejects direct root `server.tool(...)` definitions.
- [x] Update `scripts/gen-docs.mjs` and `test/surfaceParity.test.js` as route modules move.
- [x] Keep migrations and DB schema centralized unless there is a clear reason to split helpers only.

Gate:

- No REST path changes.
- No MCP tool name changes.
- Generated docs unchanged except for source-order-neutral regeneration.
- `npm run verify` green.

## Wave 4 - Frontend TypeScript Foundation

Goal: get frontend type safety without product churn.

Agent teams:

- Client Build Agent: add a minimal TypeScript client check/build path.
- Contract Agent: share domain payload types from server to client.
- Global Cleanup Agent: replace implicit globals with explicit module exports/imports gradually.
- Cache Agent: ensure generated client output and service-worker cache versioning stay correct.

Rules:

- No frontend framework.
- No bundler unless plain `tsc` cannot satisfy the current app shape.
- Prefer `tsc` with `module: ESNext` or browser-compatible output.
- No new runtime dependencies by default.
- Keep generated JS paths stable during migration where possible.

Tasks:

- [x] Add `tsconfig.client.json` or `tsconfig.client-check.json`.
- [x] Add `npm run typecheck:client`.
- [x] Add `npm run verify` integration after the first client slice is stable.
- [x] Create `src/client/contracts/*` or shared `src/contracts/*` for API payloads.
- [x] Convert/check the route parser first as the initial typed client slice.
- [x] Convert pure helpers next: dates, escaping, SWR key helpers, formatter helpers.
  - [x] Extract date/relative-label helpers into typed `public/js/date-utils.js` with no bundler and no runtime dependencies.
  - [x] Extract shared escaping helpers into typed `public/js/html-utils.js` with VM coverage.
  - [x] Extract shared training/endurance/nutrition formatters into typed `public/js/format-utils.js` with VM coverage.
  - [x] Extract the SWR cache/orchestration layer into typed `public/js/swr-cache.js` with storage and warm-render coverage.
- [x] Add route-aware response typing to the public `api()` and generic payload typing to SWR without changing runtime behavior or cache keys.
- [x] Keep legacy `public/js/*.js` working while migrated modules compile in place.

Gate:

- Client typecheck passes.
- No framework added.
- No runtime dependency added for TypeScript migration.
- App shell still loads and service-worker cache contract passes.

## Wave 5 - High-Risk Frontend Migration

Goal: type the code most likely to regress user-facing behavior.

Agent teams:

- Today Agent: migrate Today agenda, date handling, set logging, progression, cardio, and deep links.
- Chat Agent: migrate chat turns, streaming, job reconnection, image payloads, and markdown rendering.
- Health Agent: migrate Health Standing, records, markers, directives, and report links.
- Settings Agent: migrate settings route/task metadata and data/export/update surfaces.
- Browser Smoke Agent: verify mobile/desktop critical workflows where possible.

Tasks:

- [x] Migrate `01-core` API/SWR/state primitives.
  - [x] Extract API/auth/timezone/offline behavior into typed `public/js/api-client.js` with VM coverage and no runtime dependencies.
  - [x] Extract SWR cache, invalidation, and refresh hairline behavior into typed `public/js/swr-cache.js` with VM coverage.
- [x] Migrate the high-risk `03-today` behavior slices.
  - [x] Extract Today agenda ordering, generic rail cards, and fuel-card rendering into typed `public/js/today-agenda-client.js` with VM coverage.
  - [x] Extract adaptive prescription text, variation-chip rendering, cardio zone reads, cardio verb classification, and cardio log-phrase generation into typed `public/js/today-training-client.js` with VM coverage.
- [x] Migrate the high-risk `09-plan-chat` behavior slices.
  - [x] Extract chat image payload sizing, food-surface eligibility, fuel-card rendering, search highlighting, and history rows into typed `public/js/chat-client.js` with VM coverage.
  - [x] Extract chat image compression, preview payloads, and native file-picker focus/keyboard settling into typed `public/js/chat-attachment-client.js` with VM coverage.
- [x] Migrate the high-risk `07-me-health` and `08-me-records` behavior slices.
  - [x] Extract evidence URL allowlisting, evidence-list rendering, evidence-count mapping, marker empty-state rendering, clinical marker ordering, and LDL assay separation into typed `public/js/health-client.js` with VM coverage.
- [x] Migrate the high-risk `10-boot` shell/routing/settings slices after route contracts are stable.
  - [x] Extract Garmin sync status, agent health/activity, noticed learnings, agent state chips, and update-status rendering into typed `public/js/settings-client.js` with VM coverage.
- [x] Keep `escHtml`/`escAttr` discipline for extracted helper-generated HTML with VM escaping tests and an engineering contract that keeps typed helper scripts in `tsconfig.client.json`, `public/index.html`, and `public/sw.js`.
- [x] Keep generated browser source under `src/client/**/*.ts`, with `public/js` treated as build output except for the tiny `10-boot.js` shim.
- [x] Keep the exact client API route map narrow enough that `CLIENT_API_BROAD_RESPONSE_WAIVERS` is empty; deterministic DTO coverage is complete for the current deterministic client surfaces.
- [ ] Split large typed screen-controller modules into smaller render, data, state, and wiring modules.

Gate:

- Client typecheck green.
- `npm run verify` green.
- Automated gates cover client typecheck, route deep links, public-script/cache contracts, built HTTP smoke, and Pi deploy app-shell smoke. A live Chrome route-console sweep now covers `/`, `/app/today`, `/app/plan/meals`, `/app/progress/energy`, `/app/me/standing`, `/app/me/health/read`, `/app/me/health/records`, `/app/chat`, and `/app/settings/data`. Full browser workflow smoke for Today log set/skip/cardio, Chat send/stream/reconnect, Health markers, and Settings Data remains a manual release check until a dedicated automated browser lane is added.

## Wave 6 - Brain And Memory Hardening

Goal: make the agentic brain more elite by strengthening deterministic context and memory, not by adding prompt sprawl.

Agent teams:

- Coach Context Agent: define a typed `CoachContext` contract with bounded slices.
- Memory Agent: improve the person model compiled from memory, outcomes, preferences, constraints, family, context, and reaction patterns.
- Evidence Agent: make recommendation provenance clearer: what data caused the suggestion, what changed, what can be dismissed, and what needs retest.
- Conductor Agent: keep the one-focus arbitration strong across today, week, block, and healthspan.
- Prompt Agent: ensure prompts consume typed slices and stay calm, grounded, and suggestion-only.

Tasks:

- [x] Define a `CoachContextEnvelope` with explicit bounded slices.
- [x] Add context/golden tests that lock the prompt envelope, bounded slices, superseded-memory exclusion, conductor internals, and conductor-first prompt ordering.
- [x] Strengthen outcome learning: suggestion -> actual -> durable learning -> future defaults.
- [x] Add evidence/provenance fields for next-step recommendations where useful.
- [x] Add evidence/provenance fields for conductor recommendations where useful.
- [x] Add a typed chat-action trust boundary so malformed model write actions are rejected before repo calls.
- [x] Keep memory user-curatable and self-updating; avoid append-only memory noise.

Gate:

- Coach context shape is typed.
- Prompt renderers compile against the typed context.
- Golden tests preserve no-score/no-gate/no-autopush rules.
- `npm run verify` green.

## Wave 7 - Final Consolidation

Goal: finish cleanly and leave a maintainable baseline.

Agent teams:

- Verification Agent: run full verification and smoke.
- Docs Agent: update docs that changed due to routing, modules, or TypeScript commands.
- Cleanup Agent: remove temporary compatibility shims only when references are gone.
- Release Agent: prepare coherent commits and release notes if requested.

Tasks:

- [x] Run `npm run verify`.
- [x] Run `npm run verify:full` where environment permits (`npm run smoke` rerun with loopback permission after sandbox `EPERM`).
- [x] Confirm no stale service-worker cache changes.
- [x] Confirm route/deep-link examples work.
- [x] Confirm `src/repo.ts` compatibility barrel is still intentional until all callers migrate.
- [x] Update this tracker to complete for the current maintenance baseline.

Gate:

- `npm run verify:full` green, or documented reason if smoke is environment-blocked.
- No unrelated refactors.
- No broken routes.
- No unnecessary dependencies.

## Execution Policy

- Work in small, reviewable commits by wave or domain.
- Use parallel agents only when their file ownership is clean.
- Do not let parallel teams edit the same high-risk files at the same time without a coordinator.
- Every wave starts from current `git status` and ends with current `git status`.
- If a public UI file changes, check the service-worker cache contract.
- If a route module moves, update docs generation and surface parity tests in the same change.
- If a test uses real time, make that dependence explicit and stable.
