# Cairn Frontend TypeScript Migration Plan

This plan starts from the verified baseline commit `ca2055a` (`chore: stabilize modular Cairn architecture`). The previous maintenance plan got Cairn to a safer modular foundation: REST and MCP are grouped, core PWA helpers are typechecked, route-state exists, public script globals are guarded, and `npm run verify` is green. This plan is the next level: make the frontend a real TypeScript codebase with shared contracts, a small typed component system, preserved app routes, and a stronger typed seam for the agentic coaching brain.

## Goal

Move Cairn to a clean, dependency-light TypeScript frontend while preserving the existing vanilla PWA, self-hosted deploy path, service-worker cache contract, REST/MCP parity, and product constitution:

- calm by default
- one connected brain
- suggestion, not a gate
- no scores or pressure
- pull, never push
- the athlete drives

No frontend framework. No extra runtime dependencies by default. No `v1`/`v2` file names. Files are named for the responsibility they own.

## Current State

### Strengths

- `npm run verify` is the aggregate gate and currently passes.
- `src/api.ts` is now mostly a REST registry; route behavior lives in focused `src/routes/*` modules.
- `src/mcp.ts` is now mostly an MCP registry/adapter; tool registration lives in focused `src/surfaces/mcp/*` modules.
- `docs:check` and `test/surfaceParity.test.js` guard REST/MCP/docs parity.
- `/app/<tab>/<section>` deep links exist through `public/js/route-state.js`, `public/js/10-boot.js`, `src/server.ts`, and `public/sw.js`.
- The public app-shell script graph is now guarded by `scripts/check-public-scripts.mjs`, preventing classic-script top-level redeclaration failures like the `CHAT_IMAGE_MAX_BYTES` deployment break.
- Critical extracted helpers are now TypeScript sources: API, SWR, routes, date/html/format helpers, Today agenda/training helpers, Settings helpers, Chat helpers, and Health helpers.
- `src/contracts/client.ts`, `src/contracts/client-api.ts`, `src/contracts/client-api-coverage.ts`, and `src/contracts/client-compat.ts` establish shared backend-to-client payload contracts, API path coverage, explicit temporary unknown waivers, and compile-time backend assignability checks.
- PWA cache alignment is guarded by `scripts/check-sw-cache.mjs`.

### Gaps

- The client source of truth is still mostly `public/js/*.js`, but all extracted helper files now have TypeScript source: `src/client/route-state.ts`, `src/client/date-utils.ts`, `src/client/html-utils.ts`, `src/client/format-utils.ts`, `src/client/api-client.ts`, `src/client/swr-cache.ts`, `src/client/today-agenda-client.ts`, `src/client/today-training-client.ts`, `src/client/settings-routes.ts`, `src/client/settings-client.ts`, `src/client/chat-client.ts`, and `src/client/health-client.ts` emit their stable `public/js` files through `scripts/build-client.mjs`.
- The largest and riskiest UI files are not typechecked: `03-today.js`, `07-me-health.js`, `05-progress.js`, `02-ui.js`, `09-plan-chat.js`, `06-coach-meals.js`, `10-boot.js`, `08-me-records.js`, and `04-capture.js`.
- The app is still a classic-script graph. Boot order and global names remain part of correctness.
- `tsconfig.client.json` now only provides transitional global declarations; the extracted helpers are typechecked from `src/client/**/*.ts`, while the large screen files are still classic JS.
- The PWA API seam now has a shared coverage registry: current `public/js` `api()` calls must match a typed contract path or a named temporary waiver. Some response DTOs are still intentionally broad envelopes until the owning screen migrates from classic JS.
- HTML rendering is distributed across large screen files. Escaping discipline exists, and the first typed component primitive now lives in `src/client/ui-components.ts` as a pure browser-global compatibility module, but most repeated markup still needs to move behind narrow component props.
- Domain entry points under `src/domain/*` are additive barrels; most routes and services still import the compatibility `repo.js` barrel.
- `CoachContextEnvelope` exists, but many fields are still `unknown` or broad records. `CoachingFocusInput` still uses `any` heavily.
- Docker currently builds backend TypeScript in a builder stage but copies `public/` directly from source into the runtime image. A generated frontend build must update this path deliberately.

## Target Architecture

### Source Layout

Target source tree:

```text
src/client/
  app/
    boot.ts
    router.ts
    state.ts
    jobs.ts
    service-worker.ts
  api/
    client.ts
    swr.ts
    contracts.ts
  ui/
    html.ts
    components/
      buttons.ts
      cards.ts
      segmented-control.ts
      loading.ts
      sheets.ts
      coach-focus.ts
  screens/
    today/
    plan/
    progress/
    chat/
    me/
    settings/
  domain/
    training/
    nutrition/
    health/
    person/
    brain/
```

Generated/served output remains under stable URLs:

```text
public/js/
  app.js
  chunks-or-modules-by-responsibility.js
```

During migration, existing filenames may remain as compatibility output names. Once the module entry is stable, `public/index.html` should move toward one app-shell module entry, not a fragile list of classic scripts.

### Build Path

Add a real client build without extra runtime dependencies:

- `tsconfig.client.build.json`: compile `src/client/**/*.ts` to browser JS.
- `npm run client:build`: emits JS to `public/js`.
- `npm run client:check`: no-emit typecheck for the client tree.
- `npm run build`: runs `client:check`, `client:build`, and backend `tsc`.
- `npm run verify`: runs client check/build freshness, public script/cache checks, backend build, launch checks, and tests.
- Transition decision: generated `public/js` output stays committed until the Docker runtime copies generated `public/` from the builder stage and source deploys can rely on `npm run build` before serving.

Docker must be updated when generated frontend output becomes authoritative:

- builder stage copies `public/`, `src/client/`, `src/contracts/`, and client tsconfig.
- builder runs `npm run build`.
- runtime copies `dist/` and generated `public/` from the builder stage.
- source-build docs and Pi deploy stay aligned with this path.

### Module Strategy

Use native browser ES modules, not a bundler, unless a later gate proves that native modules cannot satisfy the app shape.

Migration rule:

- New TypeScript modules export named functions.
- Compatibility bridges may assign to `window.Cairn*` while old classic consumers remain.
- Every compatibility bridge has a named owner and a removal wave.
- No new implicit globals.
- `public/index.html`, `public/sw.js`, and the build manifest change in the same commit whenever script output changes.

### Component System

Keep the PWA vanilla, but stop hand-rolling the same HTML patterns everywhere.

Component rules:

- Components are typed pure functions or tiny DOM mount helpers.
- Component props are explicit and narrow.
- Components use shared `escHtml`, `escAttr`, and safe URL helpers.
- Components do not fetch data.
- Components do not mutate global state.
- Components are grouped by responsibility, not by visual novelty.
- Cards remain small, calm, and work-focused. No nested cards.

Initial component families:

- `ActionButton`, `IconButton`, `GhostButton`
- `SegmentedControl`
- `InfoCard`, `EvidenceCard`, `CoachFocusCard`
- `LoadingState`, `InlineStatus`, `JobProgress`
- `EmptyState`
- `DetailSheet`
- `MetricRow`, `MacroRow`, `TrainingPrescriptionRow`

### Shared Contracts

Shared contracts should live where both backend and frontend can use them without dragging runtime code into the browser.

Target rules:

- `src/contracts/*` owns API payloads, route state, shared enum literals, and client-safe DTOs.
- Backend repo/domain return types are assignable to client DTOs through compile-time tests.
- PWA API calls use typed route keys instead of ad hoc strings where practical.
- Contract files do not import DB, Express, MCP, agents, or other server runtime modules.

### Routing Preservation

These routes are non-negotiable:

- `/`
- `/app/today?date=YYYY-MM-DD`
- `/app/plan/<section>?date=YYYY-MM-DD`
- `/app/progress/<section>`
- `/app/me/<section>`
- `/app/me/health/<section>?id=<id>`
- `/app/chat?session=<session_id>`
- `/app/settings/<section>`

The server fallback remains narrow: `/app/*` returns the app shell; `/api/*`, `/mcp`, static assets, uploads, reports, and exports keep their current behavior.

Every router or boot change must include:

- route parse/serialize tests
- server fallback tests
- service-worker navigation fallback check
- browser route smoke for direct deep links
- back/forward behavior smoke when tab state changes

## Multi-Agent Execution Waves

Each wave can use parallel agents, but file ownership must be explicit. No two agents should edit the same high-risk file at the same time unless an integration lead owns the merge.

### Wave 0 - Baseline Lock

Status: complete.

Owner: Integration Lead.

Evidence:

- baseline commit `ca2055a`
- `npm run verify` green
- `npm run smoke` green
- Chrome route smoke clean

Gate:

- tracked worktree clean before Wave 1 starts

### Wave 1 - Client Build Foundation

Status: in progress. First slices complete: route-state, date helpers, HTML escaping helpers, display-format helpers, the shared API/auth/offline client, the SWR cache layer, the Today agenda renderer, the Today training renderer, the Settings route/render helpers, the Chat helper, and the Health helper now have `src/client/*.ts` authored sources, emit stable `public/js/*.js` filenames through `scripts/build-client.mjs`, and are guarded by `npm run client:verify`.

Purpose: make TypeScript the source of truth without changing behavior.

Teams:

- Build Agent: add client build/check tsconfigs and scripts.
- Docker Agent: update Dockerfile so generated `public/` output is copied from the builder when client build output becomes authoritative.
- Cache Agent: keep `public/index.html`, generated JS, and `public/sw.js` aligned.
- Deploy Agent: update source-build, Docker, and Pi deploy docs/scripts as needed.

Tasks:

- [x] Add `src/client/` with one tiny generated output slice first.
- [x] Add `tsconfig.client.build.json`.
- [x] Add `npm run client:build` and `npm run client:check`.
- [x] Decide and document whether generated JS is committed during the transition.
- [x] Add a generated-output freshness check if generated JS remains committed.
- [x] Move the first browser-global utility helpers (`date-utils`, `html-utils`, `format-utils`) to TypeScript source while preserving stable script filenames.
- [x] Move the shared API/auth/offline client to TypeScript source while preserving the `public/js/api-client.js` script contract.
- [x] Move the SWR cache client to TypeScript source while preserving the `public/js/swr-cache.js` script contract.
- [x] Move the Today agenda renderer to TypeScript source while preserving the `public/js/today-agenda-client.js` script contract.
- [x] Move the Today training renderer to TypeScript source while preserving the `public/js/today-training-client.js` script contract.
- [x] Move the Settings route/render helpers to TypeScript source while preserving the `public/js/settings-routes.js` and `public/js/settings-client.js` script contracts.
- [x] Move the Chat helper to TypeScript source while preserving the `public/js/chat-client.js` script contract.
- [x] Move the Health helper to TypeScript source while preserving the `public/js/health-client.js` script contract.
- [x] Keep the build manifest import side-effect free so freshness checks snapshot current output before rebuilding.
- [x] Update Docker build inputs so `npm run build` can run the client build in the builder stage.
- [ ] Update Docker runtime copy path once generated `public/js` output is no longer committed.
- Keep old app behavior byte-for-byte or behavior-equivalent for the first slice.

Gate:

- `npm run client:check`
- `npm run client:build`
- `npm run verify`
- direct browser load of `/app/today`

### Wave 2 - Contract Expansion

Status: in progress. The first contract slice added `src/contracts/client-api.ts` for shared PWA response DTOs, `src/contracts/client-api-coverage.ts` for every current `public/js` API call plus named temporary waivers, backend assignability checks for Settings/Profile/Goal/Plan/Exercise/Health-document payloads, and a typed `listExercises()` row so SQLite row leakage is not the public contract.

Purpose: remove `unknown` from the PWA API seam.

Teams:

- API Contract Agent: inventory every `api("/...")` call in the PWA and add DTOs for the high-use endpoints.
- Backend Assignability Agent: add compile-time compatibility assertions from repo/domain return types to DTOs.
- Route Contract Agent: move route state literals into shared contracts consumed by client and tests.
- MCP Parity Agent: ensure contract work does not break REST/MCP naming or docs parity.

Tasks:

- [x] Expand `ClientApiResponses` by screen, not randomly.
- [x] Add DTOs for Settings, Profile, Plan, Today, Program, Progress, Health, Records, Chat, Jobs, and Proposals.
- Replace broad `unknown` in extracted helpers with DTO-backed shapes.
- Keep payload DTOs client-safe and free of DB row leakage where the UI should not care.
- [x] Add engineering contracts that fail when new PWA `api()` paths lack an explicit DTO or an intentional `unknown` waiver.
- [x] Add backend assignability checks for shared DTOs where repo return types are already exported cleanly.
- [ ] Narrow the broad envelope DTOs as each large screen moves under `src/client/`.

Gate:

- `npm run typecheck:client`
- backend `tsc`
- focused client contract tests
- `npm run verify`

### Wave 3 - Typed Component Core

Status: in progress. The first component slices added `src/client/ui-components.ts` / `public/js/ui-components.js`, a tiny pure `CairnUi` primitive for escaped attributes, action buttons, empty states, and text chips. Health marker empty-state markup and Today training variation chips now use it, and VM tests guard hostile-string escaping, boolean/invalid attributes, stable button type, index script order, component dependencies, and service-worker cache coverage.

Purpose: create a small reusable UI grammar without adding a framework.

Teams:

- HTML Safety Agent: build typed `html`, escaping, safe URL, and bounded text helpers.
- Component Agent: implement first shared components.
- Design Contract Agent: protect calm visual language and avoid nested cards or marketing layouts.
- Test Agent: VM-test escaping, attributes, and component output.

Tasks:

- [x] Add the first shared typed UI primitive without a framework or runtime dependency.
- [x] Move one repeated/safety-sensitive empty-state path through the component primitive.
- [x] Move one repeated/safety-sensitive chip path through the component primitive.
- [x] Keep data fetching out of components.
- [x] Add tests that hostile strings are escaped in component output.
- [x] Add tests that component classes and stable attributes remain present where screens depend on them.
- [ ] Move repeated loading, segmented-control, chip, card, job-status, and detail-sheet markup into typed component helpers.
- [ ] Add ARIA-focused component tests as the next interactive primitives move over.

Gate:

- component VM tests
- client typecheck
- browser smoke for one migrated screen

### Wave 4 - Helper And Domain Client Migration

Status: complete for extracted helpers. `date-utils`, `html-utils`, `format-utils`, `api-client`, `swr-cache`, `today-agenda-client`, `today-training-client`, `settings-routes`, `settings-client`, `chat-client`, and `health-client` are now TypeScript-authored browser-global compatibility outputs. `health-client` now also owns pure marker display helpers for number/date/span/trend wording, with `07-me-health.js` delegating through the typed compatibility surface.

Purpose: move already-extracted helper JS into real TS modules.

Teams:

- Utility Agent: dates, formatting, HTML helpers.
- Data Agent: API client, SWR cache, route state.
- Domain Helper Agent: Today training/agenda, Chat, Health, Settings helpers.
- Compatibility Agent: preserve `window.Cairn*` assignments until all classic consumers are migrated.

Tasks:

- Move each extracted `public/js/*-client.js` helper to `src/client/.../*.ts`.
- Emit the same public JS filename or a documented module replacement.
- Replace JSDoc typedef imports with real TypeScript imports where module output is safe.
- Keep tests at the source level and, where useful, against emitted JS.

Gate:

- generated output freshness check
- `npm run client:check`
- helper VM tests
- `npm run verify`

### Wave 5 - Shell, Router, Jobs, And Service Worker

Status: in progress. The first jobs slice added `src/client/app/job-reconnectors.ts` / `public/js/app-job-reconnectors.js`, preserving the exact boot-time agent-job reconnect registration order while keeping `10-boot.js` last. A VM test now guards the order from `session_suggest` through `proposal`, and engineering contracts guard script/cache placement.

Purpose: type the app shell before migrating whole screens.

Teams:

- Shell Agent: migrate app state, boot, tab activation, view transitions, onboarding, and service-worker lifecycle.
- Router Agent: own parse/apply/current route state and browser history.
- Jobs Agent: type job reconnector registry, chat-turn reconnect, agent-job reconnect, teardown behavior.
- Mobile Agent: preserve chat keyboard/visual viewport behavior.
- Browser Smoke Agent: own Chrome route, cache, tab-switch, mobile-width checks.

Tasks:

- [ ] Move `10-boot.js` into typed source in smaller modules.
- [ ] Replace scattered route literals with shared route definitions.
- [ ] Type `state` and retire broad global declarations.
- [x] Make job reconnector registration order explicit and tested.
- Keep `registerJobReconnector`, `teardownJobs`, and chat teardown paths covered by a browser smoke.

Gate:

- route tests
- job/reconnect tests
- Chrome smoke for direct links and tab switching
- `npm run verify`
- `npm run smoke`

### Wave 6 - Screen Migration By Domain

Purpose: convert large screens without losing behavior.

Teams and file ownership:

- Today Team: `03-today` and `04-capture`.
- Plan/Nutrition Team: plan editor, meals, food journal, meal plans, recipes, proposals.
- Progress/Training Team: `05-progress`, sessions, volume, program, performance, endurance.
- Health/Records Team: `07-me-health`, `08-me-records`, health read, markers, docs, learned timeline.
- Chat Team: `09-plan-chat`, streaming, markdown, image upload, history, session links.
- Settings Team: settings slices, agent login modal integration, update card, data/export.

Tasks:

- Split each screen into render, state, data, components, and wiring modules.
- Keep each module small enough to review without context overload.
- Move screen-local HTML rows into typed components when repeated or safety-sensitive.
- Do not rewrite behavior during conversion unless a test exposes a bug.
- Preserve current route and cache behavior for every screen.

Gate per screen:

- screen-focused VM/unit tests
- browser smoke for that screen's critical workflow
- service-worker cache bump when public output changes
- `npm run verify`

### Wave 7 - Backend Domain Import Cleanup

Purpose: make server-side modularity real, not just grouped registries.

Teams:

- Training Domain Agent
- Nutrition Domain Agent
- Health Domain Agent
- Person/Memory Domain Agent
- Brain Domain Agent
- Surface Adapter Agent

Tasks:

- Replace broad `import * as repo from "../repo.js"` in route modules with domain imports where ownership is clear.
- Keep `src/repo.ts` as compatibility until references are low enough to remove safely.
- Avoid moving DB schema ownership out of `src/db.ts` unless the migration system is redesigned deliberately.
- Keep REST paths and MCP tool names unchanged.

Gate:

- `test/domainGrouping.test.js`
- `test/surfaceParity.test.js`
- `npm run docs:check`
- `npm run verify`

### Wave 8 - Agentic Brain And Memory Contract

Purpose: make the elite coach behavior easier to evolve safely.

Teams:

- Coach Context Agent: narrow `CoachContextEnvelope` fields from `unknown` to typed slices.
- Conductor Agent: narrow `CoachingFocusInput`, `FocusItem`, provenance, sequence, and retest contracts.
- Memory Agent: type durable memory, outcome learning, supersession, and person model reads.
- Prompt Contract Agent: make prompt renderers consume typed slices and preserve golden constitution rules.
- Safety/Evidence Agent: preserve health safety gates, citation verification, and contraindication behavior.

Tasks:

- Replace broad `unknown` and `any` fields incrementally with domain DTOs.
- Add typed provenance for recommendations: based on, source freshness, dismissed/superseded status, retest due.
- Separate "coach context DTO" from raw DB/repo rows.
- Preserve one-focus conductor behavior; do not add prompt sprawl.
- Add tests for no-score/no-gate/no-autopush leaks.

Gate:

- `test/coachContext.test.js`
- `test/coachingFocus.test.js`
- `test/nextStep.test.js`
- prompt golden tests
- health safety tests
- `npm run verify`

### Wave 9 - Final Consolidation And Release Readiness

Purpose: leave the repo clean, deployable, and easy to extend.

Teams:

- Verification Agent: full local validation.
- Browser Agent: Chrome desktop/mobile route smoke after service-worker cache refresh.
- Pi Deploy Agent: run the established deploy path after local gates.
- Docs Agent: update developer/build/deploy docs.
- Cleanup Agent: remove compatibility shims whose references are gone.

Tasks:

- `npm run verify`
- `npm run smoke`
- Chrome route smoke for every canonical route.
- Pi deploy smoke if requested.
- Confirm no direct edits to generated JS if source-of-truth TS is in place.
- Confirm no stale `window.Cairn*` compatibility bridges without owners.
- Confirm no new runtime dependencies.

Gate:

- tracked worktree clean or committed in coherent chunks
- app works from a cold browser cache and an installed PWA cache refresh
- source Docker build works
- route links remain stable

## Risk Register

| Risk | Why It Matters | Mitigation |
| --- | --- | --- |
| Docker serves stale generated JS | Current Dockerfile copies `public/` directly from source | Update builder/runtime copy path when client build output becomes authoritative |
| Service worker serves old app shell | Installed clients can keep stale JS | `check-sw-cache`, cache bump every public output change, browser cache-refresh smoke |
| ESM migration breaks globals | Current screens depend on classic script globals and boot order | Compatibility bridges with explicit owners; migrate shell before screens |
| Deep links regress | User wants linkable screens | Shared route contract, route tests, server fallback tests, Chrome direct-link smoke |
| Large file conversion hides behavior changes | Main screen files are 1k-3k lines | Slice by responsibility and keep conversion commits small |
| Component system becomes visual churn | Cairn must stay calm and work-focused | Components own repeated primitives only; no landing-page or decorative rewrite |
| Brain grows prompt sprawl | More typed data can still make worse coaching | Typed conductor DTO, bounded context, golden tests, one-focus rule |
| Health guidance safety regresses | Health/lab suggestions are high-stakes | Keep citation, safety gate, transient/stale directive tests in every brain wave |

## Completion Criteria

The migration is complete when:

- Every first-party PWA source module lives under `src/client/` or is explicitly classified as vendored/static.
- `public/js` is generated from TypeScript or checked for source/output freshness.
- `npm run typecheck:client` covers all first-party client code.
- No first-party client file relies on accidental global lexical sharing.
- `src/contracts/*` covers every PWA API call or explicitly documents a temporary unknown waiver.
- The component system owns repeated UI primitives with escaping and accessibility tests.
- `/app/*` deep links, root `/`, API, MCP, reports, exports, uploads, and service-worker navigation fallback are preserved.
- `npm run verify`, `npm run smoke`, and browser route smoke pass.
- No new runtime dependencies or frontend framework were added.
- The agentic brain keeps one sequenced focus, bounded memory, clear provenance, and suggestion-only behavior.
