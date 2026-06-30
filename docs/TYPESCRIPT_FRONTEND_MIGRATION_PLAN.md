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
- `/app/<tab>/<section>` deep links exist through the shared `src/contracts/client-routes.ts` route definition contract, `public/js/route-state.js`, typed app-shell route modules, `public/js/settings-screen.js`, `src/server.ts`, and `public/sw.js`.
- The public app-shell script graph is now guarded by `scripts/check-public-scripts.mjs`, preventing classic-script top-level redeclaration failures like the `CHAT_IMAGE_MAX_BYTES` deployment break.
- Critical extracted helpers and shell slices are now TypeScript sources: app core state, the shared UI shell, the shared agent-job client, the shared chat-turn stream client, the shared chat-history overlay client, app download helper, app service-worker recovery bootstrap, app route bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, API, SWR, routes, date/html/format/markdown helpers, Exercise detail helpers, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity rows, the shared save bar, Today agenda/training/Brief/session-suggest/session-status/program-adjustment/Lately helpers, planned-cardio helpers, cardio sync freshness and execution helpers, proposal/result and Coach proposal-list helpers, Progress component/chart/history/endurance/run-plan/volume/energy/check-in/calendar/muscle-trajectory/DEXA-targeting/performance/program-adjustment/test-week/program-summary/program-block helpers, the Progress screen, Plan editor helpers, Plan Endurance helpers, Day Fuel review helpers, Meal Plan row/day/history/shell/prefs/recipe helpers, the Coach/Meals/Food screen, Health document, Records tab shell/list, Read recovery/priority rails, Standing, picture/review, marker chart/row, connected-brain directive rendering/execution, and Learned timeline helpers, Food note helpers, Memory row helpers, Life timeline helpers, Family render helpers, the Me health screen, the Me records/life/family screen, Settings helpers, the Settings screen shell, Chat shell/header/history/fuel helpers, the served Chat screen, and Health helpers.
- `src/contracts/client.ts`, `src/contracts/client-routes.ts`, `src/contracts/client-api.ts`, `src/contracts/client-api-coverage.ts`, and `src/contracts/client-compat.ts` establish shared backend-to-client route/payload contracts, API path coverage, explicit temporary unknown waivers, and compile-time backend assignability checks.
- `tsconfig.json` excludes `src/client/**/*.ts`; the Node service build owns server/shared code, while `tsconfig.client.build.json` owns browser TypeScript. `src/contracts/client-shell-globals.d.ts` remains legacy ambient compatibility for any root-build-only checks and is intentionally excluded from `tsconfig.client.build.json` to avoid duplicate definitions while generated classic scripts still share global names.
- PWA cache alignment is guarded by `scripts/check-sw-cache.mjs`.
- Generated client scripts are now locally scoped by `scripts/build-client.mjs` and expose only their intentional compatibility API on `window`, reducing stale-service-worker mixed-script failures and repeated classic-script execution failures during deploy transitions.
- Mobile Chat input and keyboard behavior is now guarded by the typed `src/client/app/mobile-viewport.ts` slice plus focused `09-plan-chat.js` event handling: geometry, not stale focus, drives keyboard state; stale iOS textarea focus is released after keyboard dismissal; send-button touch input stays focused and sends on pointer-up; touch Enter remains a newline; and `test/chatKeyboardUi.test.js` / `test/clientMobileViewport.test.js` cover the contract.

### Gaps

- The client source of truth is still partly `public/js/*.js`, but all extracted helper files now have TypeScript source: `src/client/app/state.ts`, `src/client/ui-shell.ts`, `src/client/agent-job-client.ts`, `src/client/chat-turn-client.ts`, `src/client/chat-history-client.ts`, `src/client/app/download.ts`, `src/client/app/sw-recovery.ts`, `src/client/app/router.ts`, `src/client/app/route-sync.ts`, `src/client/app/render-dispatch.ts`, `src/client/app/tabs.ts`, `src/client/app/onboarding.ts`, `src/client/app/startup.ts`, `src/client/app/job-reconnectors.ts`, `src/client/app/mobile-viewport.ts`, `src/client/app/service-worker.ts`, `src/client/app/discipline-primer.ts`, `src/client/route-state.ts`, `src/client/date-utils.ts`, `src/client/html-utils.ts`, `src/client/markdown-client.ts`, `src/client/exercise-detail-client.ts`, `src/client/format-utils.ts`, `src/client/api-client.ts`, `src/client/pwa-install-coach.ts`, `src/client/rest-timer.ts`, `src/client/coaching-focus-client.ts`, `src/client/today-activity-client.ts`, `src/client/save-bar.ts`, `src/client/swr-cache.ts`, `src/client/today-agenda-client.ts`, `src/client/today-training-client.ts`, `src/client/today-brief-client.ts`, `src/client/today-session-suggest-client.ts`, `src/client/today-session-status-client.ts`, `src/client/today-cards-client.ts`, `src/client/today-program-adjustments-client.ts`, `src/client/today-lately-client.ts`, `src/client/cardio-plan-client.ts`, `src/client/cardio-sync-client.ts`, `src/client/proposal-client.ts`, `src/client/progress-endurance-client.ts`, `src/client/progress-components-client.ts`, `src/client/progress-chart-client.ts`, `src/client/progress-history-client.ts`, `src/client/progress-run-plan-client.ts`, `src/client/progress-volume-client.ts`, `src/client/progress-energy-client.ts`, `src/client/progress-calendar-client.ts`, `src/client/progress-muscle-trajectory-client.ts`, `src/client/progress-dexa-targeting-client.ts`, `src/client/progress-performance-client.ts`, `src/client/progress-program-adjustments-client.ts`, `src/client/progress-test-week-client.ts`, `src/client/progress-program-summary-client.ts`, `src/client/progress-program-block-client.ts`, `src/client/progress-screen.ts`, `src/client/plan-editor-client.ts`, `src/client/plan-endurance-client.ts`, `src/client/day-fuel-client.ts`, `src/client/meal-plan-client.ts`, `src/client/meal-recipe-client.ts`, `src/client/coach-meals-screen.ts`, `src/client/food-note-client.ts`, `src/client/health-docs-client.ts`, `src/client/health-read-client.ts`, `src/client/health-standing-client.ts`, `src/client/health-picture-client.ts`, `src/client/health-markers-client.ts`, `src/client/health-directives-client.ts`, `src/client/health-directives-loader-client.ts`, `src/client/health-learned-client.ts`, `src/client/health-records-client.ts`, `src/client/memory-client.ts`, `src/client/life-client.ts`, `src/client/family-client.ts`, `src/client/me-health-screen.ts`, `src/client/me-records-screen.ts`, `src/client/settings-routes.ts`, `src/client/settings-client.ts`, `src/client/settings-data-client.ts`, `src/client/settings-screen.ts`, `src/client/chat-client.ts`, `src/client/chat-screen.ts`, and `src/client/health-client.ts` emit their stable `public/js` files through `scripts/build-client.mjs`. `public/js/10-boot.js` is now only the final startup shim.
- `03-today.js` is now generated from `src/client/today-screen.ts` with a strict client TypeScript check, locally scoped output, and an explicit compatibility bridge for only `renderToday`, `reshapeToday`, `postExerciseMode`, `collapseEl`, `reconnectSessionSuggest`, and `reconnectDayReadOverride`. `09-plan-chat.js` is generated from `src/client/chat-screen.ts`; Plan editor and Plan Endurance orchestration live in typed sources. `02-ui.js` is generated from `src/client/ui-shell.ts`; `04-capture.js` is generated from `src/client/capture.ts`; `05-progress.js` is generated from `src/client/progress-screen.ts`; `06-coach-meals.js` is generated from `src/client/coach-meals-screen.ts`; `07-me-health.js` is generated from `src/client/me-health-screen.ts`; `08-me-records.js` is generated from `src/client/me-records-screen.ts`; Settings screen rendering is generated from `src/client/settings-screen.ts`. Health directive markup and execution are split: `health-directives-client.ts` owns pure rendering, while `health-directives-loader-client.ts` owns `/directives`, `/evidence/summary`, evidence toggles, done/dismiss, and derive-refresh wiring so direct `/app/me/health/read` routes do not depend on screen-local functions from another bundle. Do not edit generated `public/js` files directly; run `npm run client:check`, `npm run client:build`, `node scripts/check-client-build-output.mjs`, `npm run public:check`, and `node scripts/check-sw-cache.mjs` after browser changes.
- Only `public/js/10-boot.js` remains classified as handwritten app-shell JavaScript, and it is intentionally a two-line startup shim. Every larger first-party app-shell script should stay generated from `src/client/**/*.ts`.
- The app is still a classic-script graph. Boot order and exported global names remain part of correctness, but generated TypeScript output no longer leaks top-level `const`/`let` bindings into the shared page scope.
- `tsconfig.client.json` now only provides transitional global declarations, while `tsconfig.client.build.json` typechecks the browser source under `src/client/**/*.ts`. Remaining work is shrinking large typed screen modules into smaller responsibility modules, not keeping public JS as source.
- The PWA API seam now has a shared coverage registry: current `public/js` `api()` calls must match a typed contract path or a named temporary waiver. Some response DTOs are still intentionally broad envelopes until the owning screen migrates from classic JS.
- HTML rendering is distributed across large screen files. Escaping discipline exists, and the first typed component primitive now lives in `src/client/ui-components.ts` as a pure browser-global compatibility module with ARIA-focused VM coverage, but most repeated markup still needs to move behind narrow component props.
- Domain entry points under `src/domain/*` are additive barrels; many routes and services still import the compatibility `repo.js` barrel. Nutrition, Health Metrics, Training Log, and Person Context REST/MCP adapters now import their domain entry points directly as the first Wave 7 adapter cleanup slices.
- `CoachContextEnvelope` exists, with memory, outcome learnings, and the conductor result now typed through shared repo DTOs. `CoachingFocusInput` now uses local minimal DTOs and the conductor module is free of `any`; many other coach-context fields are still `unknown` or broad records.
- Docker now runs the client build in the builder stage and overlays generated `public/js` into the runtime image from that builder, so source-build and Pi Docker deploys do not serve stale committed browser output.

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
- Transition decision: generated `public/js` output stays committed for reviewability and non-Docker source runs, while Docker runtime images already copy generated `public/js` from the builder stage.

Current Docker contract for generated frontend output:

- builder stage copies package manifests, server/client tsconfigs, `scripts/build-client.mjs`, and `src/`.
- builder runs `npm run build`, which emits generated browser scripts into `/app/public/js`.
- runtime copies `dist/` from the builder, copies static `public/` from source, then overlays generated `public/js` from the builder.
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

Status: built-server smoke now asserts `/app/today`, `/app/me/health/read`, `/app/chat?session=...`, and `/app/settings/data` return the app shell with the boot script and manifest. Browser route smoke remains the final cache/navigation check for user-facing route changes.

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

Status: in progress. First slices complete: app core state, the shared UI shell, the shared agent-job client, app download helper, app service-worker recovery bootstrap, app router bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, route-state, date helpers, HTML escaping helpers, markdown rendering, Exercise detail explanation helpers, display-format helpers, the shared API/auth/offline client, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity-row rendering, the shared save bar, the SWR cache layer, the Today agenda renderer, the Today training renderer, the Today Brief/focus renderer, the Today session-suggestion renderer, the Today session-status renderer, the Today exercise/cardio card renderer, the Today program-adjustment renderer, the served Today screen, the planned-cardio renderer helpers, the cardio sync freshness helpers, the proposal/result and Coach proposal-list helpers, the Progress component/chart/endurance/energy/check-in/screen/DEXA/performance/program-adjustment/test-week helpers, the Plan editor helper, the Plan Endurance helper, the Day Fuel review helper, the Meal Plan row/day/history/shell/prefs/recipe helper, the Settings route/render helpers, the Settings Data helper, the Settings screen shell, the Chat shell/header/history/fuel helper, the Food note helper, the Health helper, the Health Read recovery/priority renderer, the Health Records tab shell/list renderer, the Health Standing renderer, the Health picture/review renderer, the Health marker chart/row renderer, the Health connected-brain directive renderer/loader, the Health Learned timeline helper, the Memory row helper, the Life timeline helper, the Family render helper, the Me health screen, and the Me records/life/family screen now have `src/client/**/*.ts` authored sources, emit stable `public/js/*.js` filenames through `scripts/build-client.mjs`, and are guarded by `npm run client:verify`.

Purpose: make TypeScript the source of truth without changing behavior.

Teams:

- Build Agent: add client build/check tsconfigs and scripts.
- Docker Agent: keep Dockerfile/source deploys aligned so generated `public/js` remains builder-owned in runtime images.
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
- [x] Move the Exercise Detail explanation helper to TypeScript source while preserving the `02-ui.js` modal behavior and API hydration path.
- [x] Move the shared API/auth/offline client to TypeScript source while preserving the `public/js/api-client.js` script contract.
- [x] Move the shared download helper to TypeScript source while preserving global `downloadFile` compatibility.
- [x] Move the app core state/bootstrap globals to TypeScript source while preserving the `public/js/01-core.js` script contract.
- [x] Move the shared UI shell to TypeScript source while preserving the `public/js/02-ui.js` script contract.
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
- [x] Move durable agent-job enqueue/stream/reconnect/runOp helpers to TypeScript source while preserving `registerJobReconnector`, `enqueueJob`, `openJobStream`, `jobReconnect`, `teardownJobs`, and `runOp` globals for existing screens.
- [x] Move mobile visual-viewport and soft-keyboard guards to TypeScript source while preserving the `10-boot.js` compatibility call.
- [x] Move service-worker lifecycle registration and controller-change reload policy to TypeScript source.
- [x] Move boot-time discipline/endurance profile priming to TypeScript source while preserving first-paint defaults.
- [x] Move the app startup sequence to TypeScript source while preserving direct routes, popstate, onboarding, art refresh, job reconnect, and mobile guard order.
- [x] Move the SWR cache client to TypeScript source while preserving the `public/js/swr-cache.js` script contract.
- [x] Move the Today agenda renderer to TypeScript source while preserving the `public/js/today-agenda-client.js` script contract.
- [x] Move the Today training renderer to TypeScript source while preserving the `public/js/today-training-client.js` script contract.
- [x] Move the Today Brief and focus-bar renderer to TypeScript source while preserving the `public/js/today-brief-client.js` script contract.
- [x] Move the Today session-suggestion renderer to TypeScript source while preserving the `public/js/today-session-suggest-client.js` script contract.
- [x] Move the Today session-status renderer to TypeScript source while preserving `setsTonnage`, set-chip, completion-card, skip-line, and feedback markup compatibility.
- [x] Move the Today program-adjustment rail renderer to TypeScript source while preserving expansion selectors, chat prefill requests, script order, and PWA cache alignment.
- [x] Move the planned-cardio label/prescription helpers to TypeScript source while preserving the `public/js/cardio-plan-client.js` script contract.
- [x] Move Garmin/cardio sync freshness helpers to TypeScript source while preserving the public `cardioSyncLine` global.
- [x] Move shared proposal/result helpers to TypeScript source while preserving direct globals used by Today, Chat, Plan Endurance, and Meals.
- [x] Move the Coach proposal list/card renderer to TypeScript source while preserving apply/discard selectors, just-applied clamp notes, fold behavior, script order, and PWA cache alignment.
- [x] Move the Plan editor day/item renderers and blank item defaults to TypeScript source while preserving editor selectors, save-bar behavior, script order, and PWA cache alignment.
- [x] Move the Settings route/render helpers to TypeScript source while preserving the `public/js/settings-routes.js` and `public/js/settings-client.js` script contracts.
- [x] Move the Settings screen shell to TypeScript source while preserving `public/js/settings-screen.js`, Settings deep links, and the stable final `10-boot.js` startup shim.
- [x] Move the Chat shell/header/starter/history/fuel helpers to TypeScript source while preserving the `public/js/chat-client.js` script contract and leaving stream/send wiring in `09-plan-chat.js`.
- [x] Move the Plan Endurance ramp/preset/draft-card renderer to TypeScript source while preserving the `public/js/plan-endurance-client.js` script contract.
- [x] Move the Day Fuel review renderer to TypeScript source while preserving `MEAL_LABEL` and `dayFuelHtml` compatibility.
- [x] Move the Meal Plan row/day/history renderer to TypeScript source while preserving log/swap/reorder selectors, accept/discard selectors, history folds, script order, and PWA cache alignment.
- [x] Move the Meal Plan planner shell, preference card, current-plan selection, context derivation, and shopping chips to TypeScript source while preserving save-bar, keep/discard, draft, shopping, and deep-link behavior.
- [x] Move the Meal recipe CTA/result/loading renderer to TypeScript source while preserving bottom-sheet lifecycle, runOp/reconnect, cache invalidation, script order, and PWA cache alignment.
- [x] Move the Food note parser/renderer to TypeScript source while preserving the `public/js/food-note-client.js` script contract and direct food-detail globals.
- [x] Move the Health helper to TypeScript source while preserving the `public/js/health-client.js` script contract.
- [x] Move the Health Read recovery and priority-marker renderer to TypeScript source while preserving `CairnHealthRead`, recovery phrasing, no-score marker wording, script order, and PWA cache alignment.
- [x] Move the Health Records tab shell/list renderer to TypeScript source while preserving upload IDs, document list composition, script order, and PWA cache alignment.
- [x] Move the Health Standing renderer to TypeScript source while preserving `CairnHealthStanding`, age-band comparison, BP/body-composition cards, script order, and PWA cache alignment.
- [x] Move the Health picture/review renderer to TypeScript source while preserving `CairnHealthPicture`, Health read CTAs, script order, and PWA cache alignment.
- [x] Move the Health marker chart/row renderer to TypeScript source while preserving `CairnHealthMarkers`, marker expand/scrub behavior, script order, and PWA cache alignment.
- [x] Move the Health connected-brain directive renderer and loader to TypeScript source while preserving `CairnHealthDirectives`, `CairnHealthDirectiveLoader`, evidence affordances, research nudges, direct Health Read routes, script order, and PWA cache alignment.
- [x] Move the Health Learned timeline renderer to TypeScript source while preserving the `public/js/health-learned-client.js` script contract.
- [x] Move the Memory row renderer to TypeScript source while preserving the `public/js/memory-client.js` script contract.
- [x] Move the Life timeline renderer to TypeScript source while preserving the `public/js/life-client.js` script contract.
- [x] Move the Family card/swatch renderer to TypeScript source while preserving the `public/js/family-client.js` script contract.
- [x] Harden extracted helper internals against stale-cache mixed-script loads by keeping old screen-local names out of top-level generated scope.
- [x] Keep the build manifest import side-effect free so freshness checks snapshot current output before rebuilding.
- [x] Update Docker build inputs so `npm run build` can run the client build in the builder stage.
- [x] Update Docker runtime copy path so generated `public/js` from the builder overwrites source `public/js` in runtime images.
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

Status: in progress. The first component slices added `src/client/ui-components.ts` / `public/js/ui-components.js`, a tiny pure `CairnUi` primitive for escaped attributes, action buttons, empty states, text chips, loading states, segmented navigation, and job captions. Health marker empty-state markup, Today training variation chips, the legacy `loadingState()` / `segBar()` wrappers, and shared agent-job caption slots now use it, and VM tests guard hostile-string escaping, boolean/invalid attributes, ARIA boolean rendering, segmented-control group/pressed semantics, polite loading/empty/job status semantics, stable button type/status semantics, active segment slider markup, job reconnect selector markup, index script order, component dependencies, and service-worker cache coverage. The first interactive shared UI helper, `src/client/save-bar.ts` / `public/js/save-bar.js`, now owns the floating unsaved-changes bar used by Settings, Plan, Profile, and Meals while preserving the old global API.

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
- [x] Add ARIA-focused component tests as the next interactive primitives move over.

Gate:

- component VM tests
- client typecheck
- browser smoke for one migrated screen

### Wave 4 - Helper And Domain Client Migration

Status: complete for extracted helpers. `date-utils`, `html-utils`, `markdown-client`, `exercise-detail-client`, `format-utils`, `api-client`, `agent-job-client`, `chat-turn-client`, `chat-history-client`, `app-sw-recovery`, `pwa-install-coach`, `rest-timer`, `coaching-focus-client`, `today-activity-client`, `swr-cache`, `today-agenda-client`, `today-training-client`, `today-brief-client`, `today-session-suggest-client`, `today-session-status-client`, `today-program-adjustments-client`, `cardio-plan-client`, `cardio-sync-client`, `proposal-client`, `progress-endurance-client`, `progress-components-client`, `progress-chart-client`, `progress-history-client`, `progress-run-plan-client`, `progress-volume-client`, `progress-energy-client`, `progress-calendar-client`, `progress-muscle-trajectory-client`, `progress-dexa-targeting-client`, `progress-performance-client`, `progress-program-adjustments-client`, `progress-test-week-client`, `progress-program-summary-client`, `progress-program-block-client`, `plan-editor-client`, `plan-endurance-client`, `day-fuel-client`, `meal-plan-client`, `meal-recipe-client`, `coach-meals-screen`, `food-note-client`, `health-docs-client`, `health-read-client`, `health-standing-client`, `health-picture-client`, `health-markers-client`, `health-directives-client`, `health-directives-loader-client`, `health-learned-client`, `health-records-client`, `memory-client`, `life-client`, `family-client`, `me-health-screen`, `me-records-screen`, `settings-routes`, `settings-client`, `chat-client`, `ui-shell`, and `health-client` are now TypeScript-authored browser-global compatibility outputs. `app-sw-recovery` owns the earliest service-worker update registration so stale script caches can recover before brittle feature code executes. `agent-job-client` owns durable agent-job enqueueing, SSE streaming, reconnect, teardown, and `runOp` / `registerJobReconnector` compatibility for Today, Capture, Progress, Meals, Health, Chat, and boot. Helpers that were split out of old screen files keep their internals private-scoped when an old screen may still define the same names from cache. `markdown-client` owns chat markdown rendering and URL scheme allowlisting. `exercise-detail-client` owns deterministic exercise form explanations, escaped explanation markup, and conservative explanation-payload validation while `ui-shell` owns the served `02-ui.js` modal fetch, art, count-up, manage buttons, hydration wiring, detail overlays, segmented nav, and agent-login terminal. `chat-client` owns chat photo-upload constants, fuel-surface gating, history rows, shell/header/starter/date-divider/earlier-bar micro-markup, and fresh-start pill markup; `chat-turn-client` owns chat draft storage, pending/streaming assistant bubbles, Stop/cancel, SSE reconnect, live markdown delta rendering, jump-to-latest, autosizing, and chat viewport measurement; `chat-history-client` owns the read-only history/search overlay and deep-linked archived sessions while `09-plan-chat.js` keeps image compression, paste/send, message rendering, Plan editor/endurance wiring, and tab behavior. `pwa-install-coach` owns the calm install guidance used by Today and Settings. `rest-timer` owns the bottom rest bar used after set logging. `coaching-focus-client` owns the conductor card/thread rendering plus delegated domain routing into preserved app paths. `today-activity-client` owns shared activity-row art phrase mapping, row markup, and enrichment updates used by Today, capture, and Health. `today-brief-client` owns the Today Brief, steer chips, offline notice, focus-bar markup, and signal summary while `03-today.js` keeps fetch/cache/job/session wiring. `today-session-suggest-client` owns the agentic session suggestion card, item rows, loading/fail states, and free-text composer while `03-today.js` keeps reconnect/log-these wiring. `today-session-status-client` owns set-chip, tonnage, completion-card, skip-line, and feedback markup while `03-today.js` keeps session finish/reopen, skip undo, and feedback persistence wiring. `today-program-adjustments-client` owns the Today "what changed" rail card, expansion selectors, and chat-prefill request wording while `03-today.js` keeps API loading and tab navigation. `cardio-plan-client` owns planned-cardio label, sport, interval, and prescription wording used by Today, Progress, and Plan. `cardio-sync-client` owns Garmin/cardio freshness wording and preserves the `cardioSyncLine` compatibility global used by Today, Progress, and Plan. `proposal-client` owns proposal status, apply-result, clamp, verified-floor, strength-change, run-target, open-draft helpers, and the Coach proposal list/card HTML used across Today, Chat, Plan Endurance, and Meals. `progress-endurance-client` owns the compact program-endurance block, pace trend wording, HR-zone bar, and sport-specific PR cards used inside Progress. `progress-components-client` owns the Progress hero, local date label, and empty-state primitives. `progress-chart-client` owns the Progress chart palette, alpha helpers, and interactive line-chart renderer. `progress-history-client` owns the History session card renderer and shared edit-field number coercion. `progress-run-plan-client` owns weekly run-plan cards, endurance goal cards, compliance wording, and coach-lead lines for Progress. `progress-volume-client` owns the volume balance read, canonical missing-pattern wording, and chip rendering for Progress. `progress-energy-client` owns Energy Balance kcal formatting, confidence wording, and the deterministic expenditure read. `progress-calendar-client` owns the Calendar month-grid renderer. `progress-muscle-trajectory-client` owns the muscle-group trajectory verdict, row/card rendering, and async loading. `progress-dexa-targeting-client` owns DEXA targeting rendering and async loading shared by Progress and Health Standing. `progress-performance-client` owns the Performance standing capacity benchmark, lever suppression, imbalance, retest, and variety rendering. `progress-program-adjustments-client` owns the "what changed & why" digest renderer and loader. `progress-test-week-client` owns the Program re-test invitation banner and loader. `progress-program-summary-client` owns the Program lift, volume, mesocycle, and adaptation summary renderers. `progress-program-block-client` owns the Program block card and controls. `plan-editor-client` owns the Plan editor day/card/item HTML and blank item defaults while `09-plan-chat.js` keeps SWR loading, save-bar wiring, event listeners, and persistence. `plan-endurance-client` owns the Plan Endurance ramp, presets, and drafted-run card. `day-fuel-client` owns the Day Fuel review renderer and `MEAL_LABEL` compatibility constant used by Plan Meals. `meal-plan-client` owns meal-plan row, day, history-card, and slot derivation markup while `coach-meals-screen` keeps SWR loading, accept/discard, log/swap/reorder, recipe, and persistence wiring. `food-note-client` owns food-note parsing, macro wording, and note-card rendering while preserving the direct food-detail globals. `health-docs-client` owns analyzed health-document card parsing/rendering shared by Health and Records. `health-read-client` owns the Health Read recovery summary and priority-marker rails while the typed Me Health screen keeps SWR/data loading and tab navigation wiring. `health-directives-client` owns pure connected-brain directive markup; `health-directives-loader-client` owns the `/directives` + `/evidence/summary` hydration path, evidence disclosure, done/dismiss writes, and derive-refresh button. `me-health-screen` owns the served `07-me-health.js` screen file: Profile save flow, Me/Health nested route state, health synthesis jobs, Health Read loaders, BP sheet, supplements, Memory, and shared `_hPic` coordination with Records. `health-records-client` owns the Health Records upload shell and document-list composition while `08-me-records.js` keeps file handling, API calls, polling, deletion, and deep-link scrolling. `health-standing-client` owns the Health Standing age-band comparison, BP/body-composition cards, dimensions, and lever markup while `me-health-screen` keeps data loading and interaction wiring. `health-learned-client` owns the Learned timeline grouping/card renderer for the pull-only memory and outcome-learning view. `memory-client` owns Me Memory kind options and row rendering. `life-client` owns the Me Life timeline kind, field, impact, and event-card renderers. `family-client` owns the Me Family roster card, color, age, initials, and swatch renderers. `health-client` owns pure marker display helpers, health-record upload constants/MIME inference, hero art, evidence list/map helpers, and directive-card support primitives. The first screen migration slice is also complete: `04-capture.js` is emitted from `src/client/capture.ts`.

Latest wave delta: `src/client/today-screen.ts` now owns the served `/js/03-today.js` Today screen output behind strict client TypeScript, and `src/client/health-directives-loader-client.ts` closes the direct Health Read route dependency on directive loader globals. `src/client/chat-screen.ts` owns the served `/js/09-plan-chat.js` Chat screen output, preserving image compression/upload, paste/send, message rendering, fuel-surface gating, proposal apply buttons, session-history links, and mobile input focus recovery behind strict client TypeScript. `src/client/today-lately-client.ts` owns Garmin reaction and Lately row/detail/movement rendering, while `03-today.js` keeps `/recent-training` loading and expansion wiring. `src/client/cardio-sync-client.ts` also owns the shared HR-zone palette and `wireCardioSync` compatibility global used by Today, Progress, and Plan. `src/client/today-cards-client.ts` now owns the Today exercise/cardio card renderer, timed-mode detection, synced-cardio done state, and cardio-effort matching, leaving `today-screen.ts` to own data and event wiring.

Purpose: move already-extracted helper JS into real TS modules.

Latest Meal Plan split: `meal-plan-client` now also owns the planner shell, preference card, current-plan selection, context derivation, and shopping-chip markup while `06-coach-meals.js` keeps SWR loading, save-bar wiring, keep/discard, log/swap/reorder, local shopping persistence, and API writes.

Latest Meal Recipe split: `meal-recipe-client` owns the bottom-sheet recipe CTA, recipe result HTML, and loading caption markup while `06-coach-meals.js` keeps sheet lifecycle, runOp/reconnect, cache invalidation, and persistence wiring.

Latest Coach/Meals screen migration: `src/client/coach-meals-screen.ts` now owns the served `/js/06-coach-meals.js` screen file, preserving Coach proposals, meal-plan draft/accept/discard, Plan Meals SWR, preferences, log/swap/reorder, recipe bottom sheet, Plan Food day-fuel edit/delete, and durable job reconnectors behind strict client TypeScript.

Latest Progress Energy split: `progress-energy-client` owns the Energy Balance hero/card and nutrition check-in loading/ok/fail/advisory proposal markup while `05-progress.js` keeps SWR loading, runOp/reconnect, count-up, dismissal, and Plan navigation wiring.

Latest route-preservation fix: Chrome direct-link smoke caught `/app/progress/energy` falling back to Progress History because the typed route parser already accepted `energy` but the classic `PROGRESS_SEG` registry did not. The segment registry, handler map, `ClientProgressSection`, app-router test, and engineering contract now keep Progress Energy linkable.

Latest Progress screen migration: `src/client/progress-screen.ts` now owns the served `/js/05-progress.js` screen file, preserving History, 1RM, Weight, Volume, Endurance, Calendar, Energy, Program, nutrition-check-in reconnects, program evolution, and exercise-name tidy wiring behind strict client TypeScript.

Latest Me Health screen migration: `src/client/me-health-screen.ts` now owns the served `/js/07-me-health.js` screen file, preserving Profile save, Me/Health nested route state, Health Read loaders, health synthesis jobs, BP sheet, supplements, Memory, `_hPic` Records coordination, script order, and PWA cache alignment behind strict client TypeScript.

Latest UI shell migration: `src/client/ui-shell.ts` now owns the served `/js/02-ui.js` file, preserving header date controls, toast/delete pattern, segmented nav, transitions, skeleton/loading states, progressive art, detail overlays, enrichment polling, food/exercise detail bridges, agent-login terminal, script order, and PWA cache alignment behind strict client TypeScript.

Latest Me records screen migration: `src/client/me-records-screen.ts` now owns the served `/js/08-me-records.js` screen file, preserving Health Markers/Records/Share/Learned tab bridges, evidence toggles, health-document upload/date/rescan/delete/poll wiring, Life timeline add/edit/delete, and Family roster add/edit/delete wiring behind strict client TypeScript.

Latest agent-job client split: `src/client/agent-job-client.ts` now owns the generated `/js/agent-job-client.js` durable job runner. It preserves `registerJobReconnector`, `enqueueJob`, `openJobStream`, `jobReconnect`, `teardownJobs`, and `runOp` globals while removing that ownership from `/js/09-plan-chat.js`. The script loads after `02-ui.js` and before every job consumer plus `app-job-reconnectors.js`, directly guarding the stale/mixed-script deployment failure class where reconnectors ran before the job API existed.

Latest chat-turn client split: `src/client/chat-turn-client.ts` now owns the generated `/js/chat-turn-client.js` durable chat-turn queue/stream client. It preserves chat draft storage, pending/streaming assistant bubbles, Stop/cancel, SSE reconnect, live markdown delta rendering, jump-to-latest, autosizing, and chat viewport measurement while removing that state from `/js/09-plan-chat.js`.

Latest chat-history client split: `src/client/chat-history-client.ts` owns the generated `/js/chat-history-client.js` read-only history/search overlay. It preserves conversation search, archived-session deep links, route sync for `session`, and static readonly conversation rendering; the served Chat screen now lives in `src/client/chat-screen.ts`.

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

Status: in progress. The first shell slice added `src/client/app/state.ts` / `public/js/01-core.js` for typed `$`, `view`, `headerTitle`, and `state` initialization. The shared UI shell slice added `src/client/ui-shell.ts` / `public/js/02-ui.js`, preserving header date controls, toast/delete pattern, segmented nav registries, transitions, skeleton/loading states, progressive art, detail overlays, enrichment polling, food/exercise detail bridges, and agent-login terminal behavior in typed source. The shared agent-job slice added `src/client/agent-job-client.ts` / `public/js/agent-job-client.js`, preserving durable job enqueueing, SSE progress, reconnect, teardown, and `runOp` globals outside the Chat screen. The shared chat-turn slice added `src/client/chat-turn-client.ts` / `public/js/chat-turn-client.js`, preserving durable chat-turn queueing, live markdown streaming, cancel/stop, reconnect, autosize, jump-to-latest, and viewport measurement outside the remaining Plan/Chat screen. The shared chat-history slice added `src/client/chat-history-client.ts` / `public/js/chat-history-client.js`, preserving conversation search, archived session deep links, and route sync outside the remaining Plan/Chat screen. The download slice added `src/client/app/download.ts` / `public/js/app-download.js`, preserving the global export/download helper used by Settings and Health Records outside boot. The route contract slice added `src/contracts/client-routes.ts`, so app tab/section literals now come from one shared contract consumed by `ClientRoute`, `CairnRoutes`, `app-router`, and `app-tabs`. The first router slice added `src/client/app/router.ts` / `public/js/app-router.js`, so parsed route application, current route serialization, and browser history sync are typed. The route-sync slice added `src/client/app/route-sync.ts` / `public/js/app-route-sync.js`, moving the screen-facing `routeApi`/`applyRouteState`/`currentRouteState`/`syncRouteFromState` wrappers out of boot while preserving global compatibility. The render-dispatch slice added `src/client/app/render-dispatch.ts` / `public/js/app-render-dispatch.js`, moving header cleanup, one-shot Plan jump routing, Progress handler fallback, and global `renderTab` compatibility out of boot. The tab slice added `src/client/app/tabs.ts` / `public/js/app-tabs.js`, moving default Progress landing, skeleton-first tab transitions, warm-cache skeleton skipping, tabbar click registration, and global `switchTab`/`activateTab` compatibility out of boot. The onboarding slice added `src/client/app/onboarding.ts` / `public/js/app-onboarding.js`, preserving the first-run modal, discipline/profile persistence, settings fallback, cache clears, and Today re-entry outside boot. The boot-time jobs slice added `src/client/app/job-reconnectors.ts` / `public/js/app-job-reconnectors.js`, preserving the exact boot-time agent-job reconnect registration order while keeping `10-boot.js` last. The mobile viewport slice added `src/client/app/mobile-viewport.ts` / `public/js/app-mobile-viewport.js`, keeping iOS visual-viewport and soft-keyboard correction behavior outside the boot file. The service-worker slice added `src/client/app/service-worker.ts` / `public/js/app-service-worker.js`, preserving the controller-change reload policy in typed source. The discipline-primer slice added `src/client/app/discipline-primer.ts` / `public/js/app-discipline-primer.js`, preserving first-paint endurance defaults for direct Progress/Plan landings. The startup slice added `src/client/app/startup.ts` / `public/js/app-startup.js`, preserving direct route activation, legacy query canonicalization, popstate routing, onboarding, art refresh, deferred job reconnect, and mobile guard order behind a single boot call. The Settings shell slice added `src/client/settings-screen.ts` / `public/js/settings-screen.js`, moving the last large Settings render body out of `10-boot.js`; `src/client/settings-data-client.ts` now owns the Settings Data Phone/PWA access card and token-helper wiring. `10-boot.js` is now only the stable final startup shim. VM tests now guard app-state initialization, download behavior, route apply/current/sync behavior, route-sync wrappers, render dispatch, tab transitions, onboarding, reconnect registration order, viewport keyboard geometry, service-worker reload behavior, discipline primer warm/cold profile paths, Settings Data rendering/wiring, and startup sequencing, and engineering contracts guard script/cache placement.

Latest mobile Chat input hardening: `src/client/app/mobile-viewport.ts` now treats `visualViewport` geometry as the durable keyboard signal, uses a short touch/focus intent bridge only while the keyboard is opening, clamps bottom inset correction to zero or greater, clears stale chat textarea focus after iOS dismisses the keyboard, and listens for `cairn:keyboard-settle`. The remaining `09-plan-chat.js` send/composer wiring prevents touch `pointerdown` blur, sends on `pointerup`, keeps mobile Enter as newline, and remeasures the composer through the full keyboard animation.

Purpose: type the app shell before migrating whole screens.

Teams:

- Shell Agent: migrate app state, boot, tab activation, view transitions, onboarding, and service-worker lifecycle.
- Router Agent: own parse/apply/current route state and browser history.
- Jobs Agent: type job reconnector registry, chat-turn reconnect, agent-job reconnect, teardown behavior.
- Mobile Agent: preserve chat keyboard/visual viewport behavior.
- Browser Smoke Agent: own Chrome route, cache, tab-switch, mobile-width checks.

Tasks:

- [x] Move `10-boot.js` behavior into typed source in smaller modules and leave only the stable startup shim.
- [x] Replace scattered route literals with shared route definitions.
- [ ] Type `state` and retire broad global declarations.
- [x] Type the initial app state/bootstrap globals without changing the `01-core.js` served filename.
- [x] Move the shared UI shell (`02-ui.js`) to `src/client/ui-shell.ts` while preserving mutable globals, segment registries, detail overlays, progressive art, enrichment polling, agent-login modal, script order, and PWA cache alignment.
- [x] Move route apply/current/sync shell logic behind a typed compatibility module.
- [x] Move durable agent-job enqueue/stream/reconnect/teardown/runOp behind a typed compatibility module.
- [x] Make job reconnector registration order explicit and tested.
- [x] Cover mobile Chat keyboard/input contracts in focused tests while browser smoke remains the final device check.
- Keep `registerJobReconnector`, `teardownJobs`, and chat teardown paths covered by a browser smoke.

Gate:

- route tests
- job/reconnect tests
- Chrome smoke for direct links and tab switching
- `npm run verify`
- `npm run smoke` / `npm run smoke:built` with canonical `/app/*` deep-link assertions

### Wave 6 - Screen Migration By Domain

Status: in progress. The Today team's capture/provenance/insight script now has TypeScript source in `src/client/capture.ts`, preserving the served `/js/04-capture.js` filename and its classic-script globals for `03-today.js`, meals, and job reconnectors. Shared activity-row rendering now lives in `src/client/today-activity-client.ts`, reducing `04-capture.js` and Health activity history dependence on `03-today.js`. The Today Brief and focus-bar renderer now lives in `src/client/today-brief-client.ts`, reducing the remaining `03-today.js` day-read surface while preserving fetch/cache/job wiring. The Today session-suggestion renderer now lives in `src/client/today-session-suggest-client.ts`, reducing the remaining `03-today.js` agentic suggestion surface while preserving runOp/reconnect/log-these behavior. The Today session-status renderer now lives in `src/client/today-session-status-client.ts`, reducing the remaining `03-today.js` completion/feedback/skip micro-markup while preserving finish/reopen, skip undo, and feedback persistence wiring. The Today exercise/cardio card renderer now lives in `src/client/today-cards-client.ts`, reducing the remaining `03-today.js` logging-card markup while preserving selectors, timed-mode detection, synced-cardio done cards, cardio matching, script order, and PWA cache alignment. The Today program-adjustment rail renderer now lives in `src/client/today-program-adjustments-client.ts`, reducing the remaining `03-today.js` "what changed" card markup while preserving API loading, expansion state, chat prefill, and plan navigation wiring. The Progress screen now has TypeScript source in `src/client/progress-screen.ts`, preserving the served `/js/05-progress.js` filename and delegating rich render pieces to the typed Progress helper modules. The Plan Coach/Meals/Food screen now has TypeScript source in `src/client/coach-meals-screen.ts`, preserving the served `/js/06-coach-meals.js` filename and delegating rich render pieces to the typed proposal, day-fuel, meal-plan, and meal-recipe helper modules. The Me Health screen now has TypeScript source in `src/client/me-health-screen.ts`, preserving the served `/js/07-me-health.js` filename and delegating rich render pieces to the typed Health and Memory helper modules. The Me records/life/family screen now has TypeScript source in `src/client/me-records-screen.ts`, preserving the served `/js/08-me-records.js` filename and delegating rich render pieces to the typed Health, Life, and Family helper modules.

Integration note for the current multi-agent wave: `03-today.js` is generated from `src/client/today-screen.ts`, and `09-plan-chat.js` is generated from `src/client/chat-screen.ts`. `public/js/10-boot.js` remains the tiny final startup shim; every other served client script should stay build-owned. The Plan editor and Plan Endurance orchestration are typechecked in `src/client/plan-editor-client.ts` and `src/client/plan-endurance-client.ts`; future Today work should continue by extracting smaller responsibility modules from `src/client/today-screen.ts`, not by editing the generated public output.

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
- [x] Move the Today Brief/focus-bar renderer out of `03-today.js` while preserving steer chips, offline notices, focus mode, script order, and PWA cache alignment.
- [x] Move the Today session-suggestion renderer out of `03-today.js` while preserving runOp/reconnect/log-these behavior, script order, and PWA cache alignment.
- [x] Move the Today session-status renderer out of `03-today.js` while preserving set-chip, tonnage, completion, feedback, skip/undo, script order, and PWA cache alignment.
- [x] Move the Today exercise/cardio card renderer out of `03-today.js` while preserving logging selectors, timed mode, synced cardio, cardio matching, script order, and PWA cache alignment.
- [x] Move the Today program-adjustment rail renderer out of `03-today.js` while preserving expansion selectors, chat prefill requests, plan navigation, script order, and PWA cache alignment.
- [x] Move the Today Garmin/Lately render helpers and shared cardio-sync execution out of `03-today.js` while preserving recent-training loading, expansion selectors, HR-zone colors, Progress/Plan sync buttons, script order, and PWA cache alignment.
- [x] Finish the served Today screen migration by creating strict TypeScript source for `public/js/03-today.js` while preserving agenda/session/proposal/cardio/quick-log wiring, route behavior, script order, and PWA cache alignment.
- [x] Move the Progress Program lift/volume/mesocycle/adaptation summary renderers out of `05-progress.js` while preserving output filename order and calm wording.
- [x] Move the Progress program-block card/controls out of `05-progress.js` while preserving Program routing, script order, and PWA cache alignment.
- [x] Move the Progress Energy card and nutrition check-in result renderers out of `05-progress.js` while preserving SWR loading, runOp/reconnect, count-up, Plan navigation, script order, and PWA cache alignment.
- [x] Move the served Progress screen (`05-progress.js`) to `src/client/progress-screen.ts` while preserving the stable public filename, segment routing, SWR keys, background-job reconnectors, Program actions, script order, and PWA cache alignment.
- [x] Move the Plan editor day/card/item HTML and blank item defaults into `src/client/plan-editor-client.ts` while preserving edit/save behavior, selectors, script order, and PWA cache alignment.
- [x] Move the Coach proposal list/card HTML into `src/client/proposal-client.ts` while preserving apply/discard wiring, just-applied clamp notes, settled-history folding, script order, and PWA cache alignment.
- [x] Move the Meal Plan row/day/history HTML and slot derivation into `src/client/meal-plan-client.ts` while preserving log/swap/reorder selectors, accept/discard selectors, history folding, script order, and PWA cache alignment.
- [x] Move the Meal Plan planner shell, preference card, current-plan selection, context derivation, and shopping chips into `src/client/meal-plan-client.ts` while preserving save-bar wiring, keep/discard selectors, draft actions, shopping persistence selectors, route behavior, and PWA cache alignment.
- [x] Move the Meal recipe CTA/result/loading HTML into `src/client/meal-recipe-client.ts` while preserving bottom-sheet lifecycle, recipe job reconnect, runOp result settling, script order, and PWA cache alignment.
- [x] Move the served Coach/Meals/Food screen (`06-coach-meals.js`) to `src/client/coach-meals-screen.ts` while preserving Coach proposal drafts, meal-plan draft/accept/discard, Plan Meals preferences/log/swap/reorder/recipe, Plan Food day-fuel edit/delete, durable job reconnectors, script order, and PWA cache alignment.
- [x] Move the remaining served Chat screen surface in `09-plan-chat.js` to TypeScript source while preserving Chat image/send/paste/message rendering, mobile input handling, session-history links, job reconnectors, script order, and PWA cache alignment.
- [x] Move Progress Endurance pace, zone, and sport-best render helpers into `src/client/progress-endurance-client.ts` while preserving the existing output file.
- [x] Move the Progress History session-card renderer and edit-field number coercion into `src/client/progress-history-client.ts` while preserving meals' `numOrNull` compatibility.
- [x] Move the Progress interactive line chart renderer into `src/client/progress-chart-client.ts` while preserving canvas scrub behavior.
- [x] Move the Health picture/review renderer into `src/client/health-picture-client.ts` while preserving Health Read state, build-review CTAs, script order, and PWA cache alignment.
- [x] Move the Health marker chart/row renderer into `src/client/health-markers-client.ts` while preserving marker expansion, scrub interaction, script order, and PWA cache alignment.
- [x] Move the Health connected-brain directive renderer and loader into `src/client/health-directives-client.ts` / `src/client/health-directives-loader-client.ts` while preserving evidence affordances, research nudges, direct Health Read routes, script order, and PWA cache alignment.
- [x] Move the Health Read recovery and priority-marker rails into `src/client/health-read-client.ts` while preserving recovery phrasing, no-score marker wording, Markers-tab navigation, script order, and PWA cache alignment.
- [x] Move the Health Records upload shell and document-list composition into `src/client/health-records-client.ts` while preserving upload IDs, document-card composition, deep-link scroll behavior, script order, and PWA cache alignment.
- [x] Move the Health Standing renderer into `src/client/health-standing-client.ts` while preserving age-band comparison, BP/body-composition cards, DEXA slot, script order, and PWA cache alignment.
- [x] Move the Health Learned timeline HTML grouping into `src/client/health-learned-client.ts` while preserving Records routing, script order, and PWA cache alignment.
- [x] Move the served Me Health screen (`07-me-health.js`) to `src/client/me-health-screen.ts` while preserving Profile save, Memory, Health Read/Markers/Standing routing, health synthesis jobs, BP sheet, supplements, `_hPic` Records coordination, script order, and PWA cache alignment.
- [x] Move the Me Life timeline render helpers into `src/client/life-client.ts` while preserving Life add/edit/delete behavior.
- [x] Move the Me Family card/swatch helpers into `src/client/family-client.ts` while preserving Family add/edit/delete behavior.
- [x] Move the served Me records/life/family screen (`08-me-records.js`) to `src/client/me-records-screen.ts` while preserving Health Markers/Records/Share/Learned bridges, evidence toggles, health-doc upload/date/rescan/delete/poll wiring, Life timeline wiring, Family roster wiring, script order, and PWA cache alignment.

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

- [x] Move Nutrition REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/nutrition/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Health Metrics REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/health/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Health Docs REST and Health Records MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/health/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Training Log REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/training/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Plan/Exercise REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/training/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Garmin REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/training/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Training Status MCP tools off the `repo.js` compatibility barrel and onto `src/domain/training/index.ts` / `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Person Context REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Person REST and MCP adapters off the `repo.js` compatibility barrel and onto person/health domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Move Memory/Learning REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Agent Job REST/background helpers off the `repo.js` compatibility barrel and onto `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Today/Daily Driver REST and MCP adapters off the `repo.js` compatibility barrel and onto brain/health/person domain entry points, guarded by `test/domainGrouping.test.js`.
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

- [x] Type the first memory/learning DTO spine: `MemoryRow`, `RecentLearning`, `MemorySupersedeResult`, `CoachContextEnvelope.memory`, `CoachContextEnvelope.learnings`, `CoachContextEnvelope.coaching_focus`, learned-timeline source projections, and the about-me memory prompt path.
- [x] Type the conductor input seam with local minimal DTOs and remove `any` from `src/repo/coaching-focus.ts` while preserving the one-focus/no-score/no-leverage contract.
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
| Docker serves stale generated JS | Runtime images must not depend on stale committed `public/js` | Docker builder runs `npm run build` and runtime overlays `/app/public/js` from the builder; keep deploy checks and Docker copy path aligned |
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
