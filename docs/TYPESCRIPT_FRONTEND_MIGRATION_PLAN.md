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
- `/app/<tab>/<section>` deep links exist through `public/js/route-state.js`, typed app-shell route modules, `public/js/settings-screen.js`, `src/server.ts`, and `public/sw.js`.
- The public app-shell script graph is now guarded by `scripts/check-public-scripts.mjs`, preventing classic-script top-level redeclaration failures like the `CHAT_IMAGE_MAX_BYTES` deployment break.
- Critical extracted helpers and shell slices are now TypeScript sources: app core state, app download helper, app service-worker recovery bootstrap, app route bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, API, SWR, routes, date/html/format/markdown helpers, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity rows, the shared save bar, Today agenda/training helpers, planned-cardio helpers, Progress component/chart/history/endurance/run-plan/volume/energy/calendar/muscle-trajectory/DEXA-targeting/performance/program-adjustment/test-week/program-summary/program-block helpers, Health document helpers, Settings helpers, the Settings screen shell, Chat helpers, and Health helpers.
- `src/contracts/client.ts`, `src/contracts/client-api.ts`, `src/contracts/client-api-coverage.ts`, and `src/contracts/client-compat.ts` establish shared backend-to-client payload contracts, API path coverage, explicit temporary unknown waivers, and compile-time backend assignability checks.
- PWA cache alignment is guarded by `scripts/check-sw-cache.mjs`.

### Gaps

- The client source of truth is still mostly `public/js/*.js`, but all extracted helper files now have TypeScript source: `src/client/app/state.ts`, `src/client/app/download.ts`, `src/client/app/sw-recovery.ts`, `src/client/app/router.ts`, `src/client/app/route-sync.ts`, `src/client/app/render-dispatch.ts`, `src/client/app/tabs.ts`, `src/client/app/onboarding.ts`, `src/client/app/startup.ts`, `src/client/app/job-reconnectors.ts`, `src/client/app/mobile-viewport.ts`, `src/client/app/service-worker.ts`, `src/client/app/discipline-primer.ts`, `src/client/route-state.ts`, `src/client/date-utils.ts`, `src/client/html-utils.ts`, `src/client/markdown-client.ts`, `src/client/format-utils.ts`, `src/client/api-client.ts`, `src/client/pwa-install-coach.ts`, `src/client/rest-timer.ts`, `src/client/coaching-focus-client.ts`, `src/client/today-activity-client.ts`, `src/client/save-bar.ts`, `src/client/swr-cache.ts`, `src/client/today-agenda-client.ts`, `src/client/today-training-client.ts`, `src/client/cardio-plan-client.ts`, `src/client/progress-endurance-client.ts`, `src/client/progress-components-client.ts`, `src/client/progress-chart-client.ts`, `src/client/progress-history-client.ts`, `src/client/progress-run-plan-client.ts`, `src/client/progress-volume-client.ts`, `src/client/progress-energy-client.ts`, `src/client/progress-calendar-client.ts`, `src/client/progress-muscle-trajectory-client.ts`, `src/client/progress-dexa-targeting-client.ts`, `src/client/progress-performance-client.ts`, `src/client/progress-program-adjustments-client.ts`, `src/client/progress-test-week-client.ts`, `src/client/progress-program-summary-client.ts`, `src/client/progress-program-block-client.ts`, `src/client/health-docs-client.ts`, `src/client/settings-routes.ts`, `src/client/settings-client.ts`, `src/client/settings-screen.ts`, `src/client/chat-client.ts`, and `src/client/health-client.ts` emit their stable `public/js` files through `scripts/build-client.mjs`. `public/js/10-boot.js` is now only the final startup shim.
- The largest and riskiest UI files are not typechecked: `03-today.js`, `07-me-health.js`, `05-progress.js`, `02-ui.js`, `09-plan-chat.js`, `06-coach-meals.js`, and `08-me-records.js`. `04-capture.js` is now generated from `src/client/capture.ts`; Settings screen rendering is generated from `src/client/settings-screen.ts`.
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

Status: in progress. First slices complete: app core state, app download helper, app service-worker recovery bootstrap, app router bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, route-state, date helpers, HTML escaping helpers, markdown rendering, display-format helpers, the shared API/auth/offline client, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity-row rendering, the shared save bar, the SWR cache layer, the Today agenda renderer, the Today training renderer, the planned-cardio renderer helpers, the Progress component/chart/endurance/DEXA/performance/program-adjustment/test-week helpers, the Settings route/render helpers, the Settings screen shell, the Chat helper, and the Health helper now have `src/client/**/*.ts` authored sources, emit stable `public/js/*.js` filenames through `scripts/build-client.mjs`, and are guarded by `npm run client:verify`.

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
- [x] Move the chat markdown renderer to TypeScript source while preserving global `mdToHtml` compatibility and link-scheme guardrails.
- [x] Move the shared API/auth/offline client to TypeScript source while preserving the `public/js/api-client.js` script contract.
- [x] Move the shared download helper to TypeScript source while preserving global `downloadFile` compatibility.
- [x] Move the app core state/bootstrap globals to TypeScript source while preserving the `public/js/01-core.js` script contract.
- [x] Move PWA install guidance to TypeScript source while preserving Today and Settings compatibility.
- [x] Move the rest timer to TypeScript source while preserving `startRest` / `stopRest` compatibility for Today set logging.
- [x] Move shared Today activity-row rendering to TypeScript source while preserving `actEntryHtml` / `updateActEntry` compatibility for Today, capture, and Health.
- [x] Move the shared floating save bar to TypeScript source while preserving global `mountSaveBar` / `hideSaveBar` compatibility.
- [x] Move app route apply/current/sync logic to TypeScript source while preserving `10-boot.js` compatibility.
- [x] Move the app route-sync compatibility wrappers to TypeScript source while preserving screen-level global route helpers.
- [x] Move tab render dispatch to TypeScript source while preserving global `renderTab` compatibility.
- [x] Move tab transition, skeleton, warm-cache, and tabbar-click control to TypeScript source while preserving global `switchTab`/`activateTab` compatibility.
- [x] Move first-run onboarding to TypeScript source while preserving the modal flow, discipline persistence, cache clears, and startup call.
- [x] Move boot-time job reconnection registration to TypeScript source while preserving the `registerJobReconnector` compatibility seam.
- [x] Move mobile visual-viewport and soft-keyboard guards to TypeScript source while preserving the `10-boot.js` compatibility call.
- [x] Move service-worker lifecycle registration and controller-change reload policy to TypeScript source.
- [x] Move boot-time discipline/endurance profile priming to TypeScript source while preserving first-paint defaults.
- [x] Move the app startup sequence to TypeScript source while preserving direct routes, popstate, onboarding, art refresh, job reconnect, and mobile guard order.
- [x] Move the SWR cache client to TypeScript source while preserving the `public/js/swr-cache.js` script contract.
- [x] Move the Today agenda renderer to TypeScript source while preserving the `public/js/today-agenda-client.js` script contract.
- [x] Move the Today training renderer to TypeScript source while preserving the `public/js/today-training-client.js` script contract.
- [x] Move the planned-cardio label/prescription helpers to TypeScript source while preserving the `public/js/cardio-plan-client.js` script contract.
- [x] Move the Settings route/render helpers to TypeScript source while preserving the `public/js/settings-routes.js` and `public/js/settings-client.js` script contracts.
- [x] Move the Settings screen shell to TypeScript source while preserving `public/js/settings-screen.js`, Settings deep links, and the stable final `10-boot.js` startup shim.
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

Status: in progress. The first component slices added `src/client/ui-components.ts` / `public/js/ui-components.js`, a tiny pure `CairnUi` primitive for escaped attributes, action buttons, empty states, text chips, loading states, segmented navigation, and job captions. Health marker empty-state markup, Today training variation chips, the legacy `loadingState()` / `segBar()` wrappers, and shared agent-job caption slots now use it, and VM tests guard hostile-string escaping, boolean/invalid attributes, stable button type/status semantics, active segment slider markup, job reconnect selector markup, index script order, component dependencies, and service-worker cache coverage. The first interactive shared UI helper, `src/client/save-bar.ts` / `public/js/save-bar.js`, now owns the floating unsaved-changes bar used by Settings, Plan, Profile, and Meals while preserving the old global API.

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
- [x] Move the central loading-state path through the component primitive.
- [x] Move the central segmented sub-nav path through the component primitive.
- [x] Move repeated agent-job caption slots through the component primitive.
- [x] Keep data fetching out of components.
- [x] Add tests that hostile strings are escaped in component output.
- [x] Add tests that component classes and stable attributes remain present where screens depend on them.
- [x] Move repeated loading, segmented-control, chip, job-status, and meal detail-sheet chip markup into typed component helpers.
- [x] Move the shared floating save bar into a typed DOM mount helper.
- [ ] Add ARIA-focused component tests as the next interactive primitives move over.

Gate:

- component VM tests
- client typecheck
- browser smoke for one migrated screen

### Wave 4 - Helper And Domain Client Migration

Status: complete for extracted helpers. `date-utils`, `html-utils`, `markdown-client`, `format-utils`, `api-client`, `app-sw-recovery`, `pwa-install-coach`, `rest-timer`, `coaching-focus-client`, `today-activity-client`, `swr-cache`, `today-agenda-client`, `today-training-client`, `cardio-plan-client`, `progress-endurance-client`, `progress-components-client`, `progress-chart-client`, `progress-history-client`, `progress-run-plan-client`, `progress-volume-client`, `progress-energy-client`, `progress-calendar-client`, `progress-muscle-trajectory-client`, `progress-dexa-targeting-client`, `progress-performance-client`, `progress-program-adjustments-client`, `progress-test-week-client`, `progress-program-summary-client`, `progress-program-block-client`, `health-docs-client`, `settings-routes`, `settings-client`, `chat-client`, and `health-client` are now TypeScript-authored browser-global compatibility outputs. `app-sw-recovery` owns the earliest service-worker update registration so stale script caches can recover before brittle feature code executes. `markdown-client` owns chat markdown rendering and URL scheme allowlisting. `pwa-install-coach` owns the calm install guidance used by Today and Settings. `rest-timer` owns the bottom rest bar used after set logging. `coaching-focus-client` owns the conductor card/thread rendering plus delegated domain routing into preserved app paths. `today-activity-client` owns shared activity-row art phrase mapping, row markup, and enrichment updates used by Today, capture, and Health. `cardio-plan-client` owns planned-cardio label, sport, interval, and prescription wording used by Today, Progress, and Plan. `progress-endurance-client` owns the compact program-endurance block, pace trend wording, HR-zone bar, and sport-specific PR cards used inside Progress. `progress-components-client` owns the Progress hero, local date label, and empty-state primitives. `progress-chart-client` owns the Progress chart palette, alpha helpers, and interactive line-chart renderer. `progress-history-client` owns the History session card renderer and shared edit-field number coercion. `progress-run-plan-client` owns weekly run-plan cards, endurance goal cards, compliance wording, and coach-lead lines for Progress. `progress-volume-client` owns the volume balance read, canonical missing-pattern wording, and chip rendering for Progress. `progress-energy-client` owns Energy Balance kcal formatting, confidence wording, and the deterministic expenditure read. `progress-calendar-client` owns the Calendar month-grid renderer. `progress-muscle-trajectory-client` owns the muscle-group trajectory verdict, row/card rendering, and async loading. `progress-dexa-targeting-client` owns DEXA targeting rendering and async loading shared by Progress and Health Standing. `progress-performance-client` owns the Performance standing capacity benchmark, lever suppression, imbalance, retest, and variety rendering. `progress-program-adjustments-client` owns the "what changed & why" digest renderer and loader. `progress-test-week-client` owns the Program re-test invitation banner and loader. `progress-program-summary-client` owns the Program lift, volume, mesocycle, and adaptation summary renderers. `progress-program-block-client` owns the Program block card and controls. `health-docs-client` owns analyzed health-document card parsing/rendering shared by Health and Records. `health-client` now also owns pure marker display helpers for number/date/span/trend wording, with `07-me-health.js` delegating through the typed compatibility surface. The first screen migration slice is also complete: `04-capture.js` is emitted from `src/client/capture.ts`.

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

Status: in progress. The first shell slice added `src/client/app/state.ts` / `public/js/01-core.js` for typed `$`, `view`, `headerTitle`, and `state` initialization. The download slice added `src/client/app/download.ts` / `public/js/app-download.js`, preserving the global export/download helper used by Settings and Health Records outside boot. The first router slice added `src/client/app/router.ts` / `public/js/app-router.js`, so parsed route application, current route serialization, and browser history sync are typed. The route-sync slice added `src/client/app/route-sync.ts` / `public/js/app-route-sync.js`, moving the screen-facing `routeApi`/`applyRouteState`/`currentRouteState`/`syncRouteFromState` wrappers out of boot while preserving global compatibility. The render-dispatch slice added `src/client/app/render-dispatch.ts` / `public/js/app-render-dispatch.js`, moving header cleanup, one-shot Plan jump routing, Progress handler fallback, and global `renderTab` compatibility out of boot. The tab slice added `src/client/app/tabs.ts` / `public/js/app-tabs.js`, moving default Progress landing, skeleton-first tab transitions, warm-cache skeleton skipping, tabbar click registration, and global `switchTab`/`activateTab` compatibility out of boot. The onboarding slice added `src/client/app/onboarding.ts` / `public/js/app-onboarding.js`, preserving the first-run modal, discipline/profile persistence, settings fallback, cache clears, and Today re-entry outside boot. The first jobs slice added `src/client/app/job-reconnectors.ts` / `public/js/app-job-reconnectors.js`, preserving the exact boot-time agent-job reconnect registration order while keeping `10-boot.js` last. The mobile viewport slice added `src/client/app/mobile-viewport.ts` / `public/js/app-mobile-viewport.js`, keeping iOS visual-viewport and soft-keyboard correction behavior outside the boot file. The service-worker slice added `src/client/app/service-worker.ts` / `public/js/app-service-worker.js`, preserving the controller-change reload policy in typed source. The discipline-primer slice added `src/client/app/discipline-primer.ts` / `public/js/app-discipline-primer.js`, preserving first-paint endurance defaults for direct Progress/Plan landings. The startup slice added `src/client/app/startup.ts` / `public/js/app-startup.js`, preserving direct route activation, legacy query canonicalization, popstate routing, onboarding, art refresh, deferred job reconnect, and mobile guard order behind a single boot call. The Settings shell slice added `src/client/settings-screen.ts` / `public/js/settings-screen.js`, moving the last large Settings render body out of `10-boot.js`; `10-boot.js` is now only the stable final startup shim. VM tests now guard app-state initialization, download behavior, route apply/current/sync behavior, route-sync wrappers, render dispatch, tab transitions, onboarding, reconnect registration order, viewport keyboard geometry, service-worker reload behavior, discipline primer warm/cold profile paths, and startup sequencing, and engineering contracts guard script/cache placement.

Purpose: type the app shell before migrating whole screens.

Teams:

- Shell Agent: migrate app state, boot, tab activation, view transitions, onboarding, and service-worker lifecycle.
- Router Agent: own parse/apply/current route state and browser history.
- Jobs Agent: type job reconnector registry, chat-turn reconnect, agent-job reconnect, teardown behavior.
- Mobile Agent: preserve chat keyboard/visual viewport behavior.
- Browser Smoke Agent: own Chrome route, cache, tab-switch, mobile-width checks.

Tasks:

- [x] Move `10-boot.js` behavior into typed source in smaller modules and leave only the stable startup shim.
- [ ] Replace scattered route literals with shared route definitions.
- [ ] Type `state` and retire broad global declarations.
- [x] Type the initial app state/bootstrap globals without changing the `01-core.js` served filename.
- [x] Move route apply/current/sync shell logic behind a typed compatibility module.
- [x] Make job reconnector registration order explicit and tested.
- Keep `registerJobReconnector`, `teardownJobs`, and chat teardown paths covered by a browser smoke.

Gate:

- route tests
- job/reconnect tests
- Chrome smoke for direct links and tab switching
- `npm run verify`
- `npm run smoke`

### Wave 6 - Screen Migration By Domain

Status: in progress. The Today team's capture/provenance/insight script now has TypeScript source in `src/client/capture.ts`, preserving the served `/js/04-capture.js` filename and its classic-script globals for `03-today.js`, meals, and job reconnectors. Shared activity-row rendering now lives in `src/client/today-activity-client.ts`, reducing `04-capture.js` and Health activity history dependence on `03-today.js`. The Progress program summary and program-block helpers now live in `src/client/progress-program-summary-client.ts` and `src/client/progress-program-block-client.ts`, reducing the remaining `05-progress.js` Program surface.

Purpose: convert large screens without losing behavior.

Teams and file ownership:

- Today Team: `03-today` and `04-capture`.
- Plan/Nutrition Team: plan editor, meals, food journal, meal plans, recipes, proposals.
- Progress/Training Team: `05-progress`, sessions, volume, program, performance, endurance.
- Health/Records Team: `07-me-health`, `08-me-records`, health read, markers, docs, learned timeline.
- Chat Team: `09-plan-chat`, streaming, markdown, image upload, history, session links.
- Settings Team: Settings screen shell now typed; remaining ownership is deeper slice/component splitting, agent login modal integration, update card, and data/export polish.

Tasks:

- Split each screen into render, state, data, components, and wiring modules.
- Keep each module small enough to review without context overload.
- Move screen-local HTML rows into typed components when repeated or safety-sensitive.
- Do not rewrite behavior during conversion unless a test exposes a bug.
- Preserve current route and cache behavior for every screen.
- [x] Move `04-capture.js` to TypeScript-authored source while preserving output filename, script order, and browser-global compatibility.
- [x] Move shared activity-row rendering out of `03-today.js` while preserving Today, quick-log, and Health history behavior.
- [x] Move the Progress Program lift/volume/mesocycle/adaptation summary renderers out of `05-progress.js` while preserving output filename order and calm wording.
- [x] Move the Progress program-block card/controls out of `05-progress.js` while preserving Program routing, script order, and PWA cache alignment.
- [x] Move Progress Endurance pace, zone, and sport-best render helpers into `src/client/progress-endurance-client.ts` while preserving the existing output file.
- [x] Move the Progress History session-card renderer and edit-field number coercion into `src/client/progress-history-client.ts` while preserving meals' `numOrNull` compatibility.
- [x] Move the Progress interactive line chart renderer into `src/client/progress-chart-client.ts` while preserving canvas scrub behavior.

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
