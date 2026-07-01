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
- Critical extracted helpers and shell slices are now TypeScript sources: app core state, the shared UI shell, header/date/segment controls, the shared DOM motion helper, the shared agent-job client, the shared chat-turn record client, the shared chat-turn stream client, the shared chat-history overlay client, app download helper, app service-worker recovery bootstrap, app route bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, API, SWR, routes, date/html/format/markdown helpers, Exercise detail helpers, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity rows, the shared save bar, Today agenda/rail/training/adapted-progression controller/add-exercise controller/Brief/session-suggest renderer/session-suggest controller/session-status/session-feedback/session-logging controller/program-adjustment/week-ahead/context/Lately helpers, Today compatibility bridges, planned-cardio helpers, cardio sync freshness and execution helpers, proposal/result and Coach proposal-list/run/apply helpers, Progress component/chart/history/endurance/run-plan/volume/energy/check-in/calendar/muscle-trajectory/DEXA-targeting/performance/program-adjustment/test-week/program-summary/program-block/trend-weight helpers, the Progress screen, Plan editor helpers, Plan Endurance helpers, Day Fuel review helpers, Meal Plan row/day/history/shell/prefs/recipe helpers, Meal Recipe sheet/job controller, Meal Swap row-actions/controller helpers, the Coach/Meals/Food screen, Health document, Records tab shell/list/share controllers, Read recovery/priority/synthesis rails, Standing, picture/review renderer/controller, marker chart/row, marker ordering, connected-brain directive rendering/execution, and Learned timeline helpers, Food note helpers, Memory row helpers, Life timeline helpers, Family render helpers, the Me health screen, controller-dependency factories, and inner-tab controller, the Me records/life/family screen, Settings helpers, the Settings screen shell and Sources/Automation controller, Chat shell/header/history/fuel helpers, the served Chat screen, and Health helpers.
- Latest modularity waves add typed ownership for progressive art (`art-controller`), shared UI feedback/loading (`ui-feedback-client`), shared transient actions (`ui-actions-client`), shared header/date controls (`ui-header-client`), shared segmented navigation and discipline tab visibility (`ui-segments-client`), shared view-transition behavior (`ui-view-transitions-client`), Today rail slot hydration (`today-rail-loaders-client`), Today side loaders (`today-side-loaders`), Today plan/session preparation (`today-plan-session-preparation`), Today primary data/SWR loading (`today-data-loader`), Today main shell (`today-main-shell-client`), Today plan-surface primitives and renderer (`today-plan-surface-client`, `today-plan-surface-renderer`), Today post-render DOM wiring (`today-post-render-wiring`), Today dependency assembly (`today-dependencies`), Today compatibility bridges and screen runtime adapters (`today-compatibility-bridges`, `today-screen-runtime-deps`, `today-screen-runtime`), Today Brief orchestration, DOM actions, and override job handling (`today-brief-controller`, `today-brief-actions-client`, `today-brief-override-client`), Today weekly compass/pace rendering (`today-compass-client`), Today session feedback and skip/off-plan wiring (`today-session-feedback-client`, `today-session-skip-client`), Capture voice and weekly/insight reads (`capture-voice-client`, `capture-read-date-client`, `capture-read-cards-client`, `capture-read-jobs-client`, `capture-reads-client`), Health marker ordering/evidence plus Read/Standing/Markers orchestration (`health-marker-order-client`, `health-evidence-client`, `health-standing-primitives-client`, `health-read-controller`, `health-standing-controller`, `health-markers-controller`), Health Read synthesis job/rendering and supplement input/delete wiring (`health-read-synthesis-client`, `health-read-supplements-client`), Health document upload, document actions, and Share tab orchestration (`health-doc-upload-controller`, `health-doc-actions-controller`, `health-share-controller`), Me Profile form rendering (`me-profile-form-client`), Me Health log rendering (`me-health-log-renderer`), Me Health inner-tab routing, screen composition, controller-dependency factories, and public dependency assembly (`me-health-tabs-controller`, `me-health-screen-composition`, `me-health-controller-deps`, `me-health-dependencies`), Exercise detail data/explanation/render/action ownership (`exercise-detail-data-client`, `exercise-detail-explanation-client`, `exercise-detail-render-client`, `exercise-detail-actions-client`), Chat message rendering, Chat turn record parsing/draft storage, Chat turn EventSource monitoring, Chat stream markdown state, Chat layout measurement/autosize, Chat header orchestration, starter chips, fuel-context gating, earlier-history expansion, composer-focus recovery, and composer wiring (`chat-message-client`, `chat-turn-records-client`, `chat-turn-monitor-client`, `chat-turn-stream-state-client`, `chat-layout-client`, `chat-header-controller`, `chat-starter-chips-client`, `chat-fuel-context-client`, `chat-earlier-history-client`, `chat-composer-focus-client`, `chat-composer-controller`), durable agent-job record parsing (`agent-job-records-client`), Agent Login model/assets/modal/session ownership (`agent-login-model-client`, `agent-login-assets-client`, `agent-login-modal-client`, `agent-login-session-client`), Meal row/day primitives, Meals planner job state/actions, and swap flows plus swap data/row-action normalization (`meal-row-client`, `meal-planner-jobs-client`, `meal-planner-actions-controller`, `meal-planner-controller`, `meal-swap-controller`, `meal-swap-data-client`, `meal-swap-row-actions-controller`), Plan editor rendering/form/orchestration (`plan-editor-client`, `plan-editor-form-client`, `plan-editor-controller`), Plan Endurance model/render ownership (`plan-endurance-model`), Progress data normalization, line-chart geometry/drawing/scrub interaction, route dependency adapters, trend/weight rendering, History model/render/controller, and Program orchestration (`progress-data-client`, `progress-line-chart-model`, `progress-chart-drawing-client`, `progress-chart-scrub-client`, `progress-history-model-client`, `progress-history-render-client`, `progress-route-deps-client`, `progress-trend-weight-client`, `progress-program-controller`), Coach proposal run/apply/reconnect orchestration (`coach-proposal-controller`), Settings surface data/render helpers, Sources/Automation orchestration, and Agents orchestration (`settings-surface-client`, `settings-sources-automation-controller`, `settings-agents-controller`), Capture provenance (`capture-provenance-client`), Me memory (`me-memory-controller`), and Me Life form/timeline action ownership (`life-form-helpers`, `life-timeline-actions`, `life-controller`).
- Latest checkpoint: Today plan/session logic is split into a deterministic model helper (`today-plan-session-model`) for selected-day fallback, set grouping, cardio matching, item partitioning, pending off-plan pruning, and prefill choice; an async data helper (`today-plan-session-data-client`) for last-set cache reads, adaptive prescription loading, and cardio context loading; and the stable preparer compatibility API (`today-plan-session-preparation`) for orchestration.
- `src/contracts/client.ts`, `src/contracts/client-routes.ts`, `src/contracts/client-api.ts`, `src/contracts/client-api-coverage.ts`, and `src/contracts/client-compat.ts` establish shared backend-to-client route/payload contracts, API path coverage, broad-response waiver enforcement, and compile-time backend assignability checks. The current client path registry has no temporary unknown waivers, `CLIENT_API_BROAD_RESPONSE_WAIVERS` is empty, and the exact `ClientApiResponses` route map no longer assigns specific routes to `ClientJsonObject` / `ClientJsonArray`. Deterministic DTO coverage is complete for the current client-facing deterministic surfaces, including training-brain reads, program block lifecycle responses, offline guideline references, and injury-impact reads.
- `tsconfig.json` excludes `src/client/**/*.ts`; the Node service build owns server/shared code, while `tsconfig.client.build.json` owns browser TypeScript. `src/contracts/client-shell-globals.d.ts` remains legacy ambient compatibility for any root-build-only checks and is intentionally excluded from `tsconfig.client.build.json` to avoid duplicate definitions while generated classic scripts still share global names.
- PWA cache alignment is guarded by `scripts/check-sw-cache.mjs`.
- Generated client scripts are now locally scoped by `scripts/build-client.mjs` and expose only their intentional compatibility API on `window`, reducing stale-service-worker mixed-script failures and repeated classic-script execution failures during deploy transitions.
- Mobile Chat input and keyboard behavior is now guarded by the typed `src/client/app/mobile-viewport.ts` slice plus focused `src/client/chat-attachment-client.ts` and `09-plan-chat.js` event handling: geometry, not stale focus, drives keyboard state; stale iOS textarea focus is released after keyboard dismissal; native file-picker return remeasures through keyboard settling and no longer blocks the next textarea tap when `kb-open` was set during document capture; send-button touch input stays focused and sends on pointer-up; touch Enter remains a newline; and `test/chatKeyboardUi.test.js` / `test/chatPhotoUi.test.js` / `test/clientMobileViewport.test.js` cover the contract.

### Gaps

- The frontend source of truth now lives under `src/client/**/*.ts`, emitted through `scripts/build-client.mjs` into stable `public/js` filenames. `public/js/10-boot.js` is the only handwritten app-shell shim; live route-console smoke is green on the preserved `/app/*` paths, and `npm run smoke:browser` now provides an opt-in Chrome/CDP route/global smoke with preserved path-URL assertions, section-state assertions, Today add/off-plan exercise through real set logging, Today planned-cardio skip/restore, synced-cardio overriding a skipped planned-cardio card, Chat attachment focus recovery, Chat send/stream/reconnect through an offline streaming fixture, Settings Data local controls, Progress and Plan segmented navigation, and Health Read-to-Markers/Records navigation. The current verified shell has 214 generated browser outputs, 216 boot scripts, and 220 core service-worker assets. Remaining frontend work is shrinking the largest typed controllers, retiring broad globals/state where practical, and adding targeted real-browser coverage only where DOM/device/SSE behavior cannot be trusted from unit tests.
- `03-today.js` is now generated from `src/client/today-screen.ts` with a strict client TypeScript check, locally scoped output, and an explicit compatibility bridge for only `renderToday`, `reshapeToday`, `postExerciseMode`, `reconnectSessionSuggest`, and `reconnectDayReadOverride`. Today add/off-plan exercise form wiring now lives in `src/client/today-add-exercise-controller.ts`, side-slot async loading lives in `src/client/today-side-loaders.ts`, Today plan/session data preparation lives in `src/client/today-plan-session-preparation.ts`, primary cache/SWR loading lives in `src/client/today-data-loader.ts`, main Brief/capture/week wrapper markup lives in `src/client/today-main-shell-client.ts`, plan-surface primitives live in `src/client/today-plan-surface-client.ts`, the plan/logging surface renderer lives in `src/client/today-plan-surface-renderer.ts`, Today post-render DOM/event wiring lives in `src/client/today-post-render-wiring.ts`, dependency adapter assembly lives in `src/client/today-dependencies.ts`, Brief orchestration lives in `src/client/today-brief-controller.ts`, Brief DOM actions live in `src/client/today-brief-actions-client.ts`, Brief override jobs live in `src/client/today-brief-override-client.ts`, and session-suggestion/session-logging behavior lives in `src/client/today-session-suggest-controller.ts`, `src/client/today-session-controller.ts`, and `src/client/today-session-skip-client.ts`. `09-plan-chat.js` is generated from `src/client/chat-screen.ts`; `src/client/chat-message-client.ts` owns day dividers, bubbles, copy affordances, and draft/apply controls, `src/client/chat-turn-records-client.ts` owns turn/event normalization, draft persistence, and phase captions, `src/client/chat-turn-stream-state-client.ts` owns streamed markdown text state/render scheduling, `src/client/chat-layout-client.ts` owns jump/autosize/viewport layout helpers, `src/client/chat-header-controller.ts` owns history/fresh-start/archive/distill pill orchestration, `src/client/chat-starter-chips-client.ts` owns empty-chat starter chips, `src/client/chat-fuel-context-client.ts` owns food-intent fuel strip gating/state, `src/client/chat-earlier-history-client.ts` owns earlier-history expansion behavior, `src/client/chat-composer-focus-client.ts` owns post-picker focus recovery, and `src/client/chat-composer-controller.ts` owns attachment preview state, paste/change handlers, send-button/Enter behavior, draft restore, and the composer call into focus recovery. Plan editor rendering/state helpers live in `src/client/plan-editor-client.ts`, form reads/save payload assembly live in `src/client/plan-editor-form-client.ts`, Plan editor orchestration lives in `src/client/plan-editor-controller.ts`, Plan Endurance orchestration lives in `src/client/plan-endurance-client.ts`, and Plan Endurance pure model/render helpers live in `src/client/plan-endurance-model.ts`. `02-ui.js` is generated from `src/client/ui-shell.ts`, with shared feedback/loading delegated to `src/client/ui-feedback-client.ts`, shared transient actions delegated to `src/client/ui-actions-client.ts`, shared view-transition abort handling delegated to `src/client/ui-view-transitions-client.ts`, progressive art delegated to `src/client/art-controller.ts`, generic full-screen detail overlay mechanics delegated to `src/client/detail-overlay-client.ts`, and shared collapse/expand delegated to `src/client/ui-motion-client.ts`. Exercise detail modal data, explanation hydration, rendering, and actions now live in `src/client/exercise-detail-data-client.ts`, `src/client/exercise-detail-explanation-client.ts`, `src/client/exercise-detail-render-client.ts`, and `src/client/exercise-detail-actions-client.ts`, with `src/client/exercise-detail-controller.ts` reduced to orchestration. `04-capture.js` is generated from `src/client/capture.ts`, with voice capture delegated to `src/client/capture-voice-client.ts`, provenance delegated to `src/client/capture-provenance-client.ts`, and weekly/insight reads delegated to `src/client/capture-read-date-client.ts`, `src/client/capture-read-cards-client.ts`, `src/client/capture-read-jobs-client.ts`, and `src/client/capture-reads-client.ts`. `05-progress.js`, `06-coach-meals.js`, `07-me-health.js`, `08-me-records.js`, Settings, and Health helper surfaces are all TypeScript-authored generated outputs; Progress payload normalization, line-chart geometry/drawing/scrub interactions, History model/render/controller, Health Standing primitives, Health Read, supplements, Markers, document-upload, Me Profile form rendering, Me Health log rendering, Me Health inner-tab routing, Me Health dependency assembly, meal-row/day primitives, and Me Life form/timeline action ownership now live in focused helpers/controllers. Do not edit generated `public/js` files directly; run `npm run client:check`, `npm run client:build`, `node scripts/check-client-build-output.mjs`, `npm run public:check`, and `node scripts/check-sw-cache.mjs` after browser changes; run `npm run smoke:browser` before release when Chrome is available.
- Only `public/js/10-boot.js` remains classified as handwritten app-shell JavaScript, and it is intentionally a two-line startup shim. Every larger first-party app-shell script should stay generated from `src/client/**/*.ts`.
- The app is still a classic-script graph. Boot order and exported global names remain part of correctness, but generated TypeScript output no longer leaks top-level `const`/`let` bindings into the shared page scope.
- `tsconfig.client.json` now only provides transitional global declarations, while `tsconfig.client.build.json` typechecks the browser source under `src/client/**/*.ts`. Remaining work is shrinking large typed screen modules into smaller responsibility modules and reducing the transitional global surface, not keeping public JS as source.
- The PWA API seam now has a shared coverage registry: source and generated client `api()`, `cachedApi()`, `enqueueJob()`, SWR `path`, and durable-job `path` literals must match a typed contract path or a named temporary waiver. There are currently no unknown waivers and no broad exact-response waivers. Remaining broadness lives in a few internal/dynamic shapes, not in the exact route response registry.
- HTML rendering is distributed across large screen files. Escaping discipline exists, and the first typed component primitive now lives in `src/client/ui-components.ts` as a pure browser-global compatibility module with ARIA-focused VM coverage, but most repeated markup still needs to move behind narrow component props.
- Domain entry points under `src/domain/*` are additive barrels; REST and MCP surface adapters now import domain entry points directly instead of the compatibility `repo.js` barrel. `src/repo.ts` remains as the public back-compat barrel for code outside the cleaned adapter layer.
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

Status: in progress. First slices complete: app core state, the shared UI shell, the shared DOM motion helper, the shared agent-job client, app download helper, app service-worker recovery bootstrap, app router bridge, app route-sync wrapper, app render dispatcher, app tab controller, app onboarding, app startup, app job reconnectors, app mobile viewport guards, app service-worker lifecycle, app discipline primer, route-state, date helpers, HTML escaping helpers, markdown rendering, Exercise detail explanation helpers, display-format helpers, the shared API/auth/offline client, shared transient UI actions, PWA install guidance, the rest timer, the coaching-focus renderer/router, Today activity-row rendering, the shared save bar, the SWR cache layer, the Today agenda renderer, the Today rail controller, the Today training renderer, the Today adapted-progression refresh controller, the Today add/off-plan exercise controller, the Today Brief/focus renderer, the Today Brief override controller, the Today plan/session preparation helper, the Today post-render wiring helper, the Today session-suggestion renderer/controller, the Today session-status renderer, the Today session-feedback helper, the Today session skip/off-plan helper, the Today exercise/cardio card renderer, the Today program-adjustment renderer, the served Today screen, the planned-cardio renderer helpers, the cardio sync freshness helpers, the proposal/result and Coach proposal-list helpers, the Progress component/chart/endurance/energy/check-in/screen/DEXA/performance/program-adjustment/test-week helpers, the Plan editor helper, the Plan Endurance helper, the Day Fuel review helper/controller, the Meal Plan row/day/history/shell/prefs/recipe helper, the Meal Recipe sheet/job controller, the Settings route/render helpers, the Settings Data helper/controller, the Settings Agents render helper, the Settings screen shell, the Chat shell/header/history/fuel helper, the Chat stream-state helper, the Food note helper, the Health helper, the Health Read recovery/priority renderer, the Health Read synthesis helper, the Health Read supplement helper, the Health Records tab shell/list renderer/controller, the Health Standing renderer, the Health picture/review renderer/controller, the Health marker chart/row renderer, the Health connected-brain directive rendering/loader, the Health Learned timeline helper, the Memory row helper, the Life timeline helper, the Family render helper, the Me health screen/log renderer/inner-tab controller/dependency factories, and the Me records/life/family screen now have `src/client/**/*.ts` authored sources, emit stable `public/js/*.js` filenames through `scripts/build-client.mjs`, and are guarded by `npm run client:verify`.

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
- [x] Move the Today agenda rail controller to TypeScript source while preserving salience-loader ordering, generic-card routing, script order, and PWA cache alignment.
- [x] Move the Today training renderer to TypeScript source while preserving the `public/js/today-training-client.js` script contract.
- [x] Move the Today adapted-progression refresh controller to TypeScript source while preserving set-logging refresh behavior, script order, and PWA cache alignment.
- [x] Move the Today add/off-plan exercise controller to TypeScript source while preserving datalist loading, skipped-card restoration, typed-card protection, last-set prefill, pending off-plan state, script order, and PWA cache alignment.
- [x] Move the Today Brief and focus-bar renderer to TypeScript source while preserving the `public/js/today-brief-client.js` script contract.
- [x] Move the Today session-suggestion renderer and lifecycle controller to TypeScript source while preserving the `public/js/today-session-suggest-client.js`, `public/js/today-session-suggest-controller.js`, and `reconnectSessionSuggest` script contracts.
- [x] Move the Today session-status renderer to TypeScript source while preserving `setsTonnage`, set-chip, completion-card, skip-line, and feedback markup compatibility.
- [x] Move the Today session/logging controller to TypeScript source while preserving set logging, delete wiring, skip/undo, off-plan removal, feedback save/edit, finish/reopen, rest start, progression invalidation, script order, and PWA cache alignment.
- [x] Move the Today post-render wiring to TypeScript source while preserving quick log, planned-cardio prefill, cardio sync, progression apply, Brief upgrade/provenance, rail dispatch, focus controls, date controls, script order, and PWA cache alignment.
- [x] Move the Today program-adjustment rail renderer to TypeScript source while preserving expansion selectors, chat prefill requests, script order, and PWA cache alignment.
- [x] Move the planned-cardio label/prescription helpers to TypeScript source while preserving the `public/js/cardio-plan-client.js` script contract.
- [x] Move Garmin/cardio sync freshness helpers to TypeScript source while preserving the public `cardioSyncLine` global.
- [x] Move shared proposal/result helpers to TypeScript source while preserving direct globals used by Today, Chat, Plan Endurance, and Meals.
- [x] Move the Coach proposal list/card renderer to TypeScript source while preserving apply/discard selectors, just-applied clamp notes, fold behavior, script order, and PWA cache alignment.
- [x] Move the Plan editor day/item renderers and blank item defaults to TypeScript source while preserving editor selectors, save-bar behavior, script order, and PWA cache alignment.
- [x] Move the Settings route/render helpers to TypeScript source while preserving the `public/js/settings-routes.js` and `public/js/settings-client.js` script contracts.
- [x] Move the Settings Data tab orchestration into `src/client/settings-data-controller.ts` while preserving update checks, backup downloads, setup reset, phone-access wiring, script order, deep links, and PWA cache alignment.
- [x] Move the Settings Agents pure slice/card render helpers to TypeScript source while preserving Settings route pruning, lazy agent detail/model fetches, save-bar mutation, and the `public/js/settings-screen.js` compatibility surface.
- [x] Move the Settings Agents polling/detail/save/update controller to `src/client/settings-agents-controller.ts` while preserving route pruning, login handoff, CLI update checks, script order, and PWA cache alignment.
- [x] Move the Settings screen shell to TypeScript source while preserving `public/js/settings-screen.js`, Settings deep links, and the stable final `10-boot.js` startup shim.
- [x] Move the Chat shell/header/starter/history/fuel helpers to TypeScript source while preserving the `public/js/chat-client.js` script contract and leaving stream/send wiring in `09-plan-chat.js`.
- [x] Move the Plan Endurance ramp/preset/draft-card renderer to TypeScript source while preserving the `public/js/plan-endurance-client.js` script contract.
- [x] Move the Day Fuel review renderer to TypeScript source while preserving `MEAL_LABEL` and `dayFuelHtml` compatibility.
- [x] Move the Meal Plan row/day/history renderer to TypeScript source while preserving log/swap/reorder selectors, accept/discard selectors, history folds, script order, and PWA cache alignment.
- [x] Move the Meal Recipe sheet lifecycle, recipe runOp options, cache invalidation, and reconnect controller to TypeScript source while preserving `closeMealSheet` / `reconnectRecipe` compatibility globals and the stable `06-coach-meals.js` screen surface.
- [x] Move the Meal Plan planner shell, preference card, current-plan selection, context derivation, and shopping chips to TypeScript source while preserving save-bar, keep/discard, draft, shopping, and deep-link behavior.
- [x] Move the Meal recipe CTA/result/loading renderer to TypeScript source while preserving bottom-sheet lifecycle, runOp/reconnect, cache invalidation, script order, and PWA cache alignment.
- [x] Move the Food note parser/renderer to TypeScript source while preserving the `public/js/food-note-client.js` script contract.
- [x] Move the Health helper to TypeScript source while preserving the `public/js/health-client.js` script contract.
- [x] Move the Health Read recovery and priority-marker renderer to TypeScript source while preserving `CairnHealthRead`, recovery phrasing, no-score marker wording, script order, and PWA cache alignment.
- [x] Move the Health Records tab shell/list renderer and lifecycle controller to TypeScript source while preserving upload IDs, document list composition, document mutation behavior, script order, and PWA cache alignment.
- [x] Move the Health Standing renderer to TypeScript source while preserving `CairnHealthStanding`, age-band comparison, BP/body-composition cards, script order, and PWA cache alignment.
- [x] Move the Health picture/review renderer to TypeScript source while preserving `CairnHealthPicture`, Health read CTAs, script order, and PWA cache alignment.
- [x] Move the Health picture/review controller to TypeScript source while preserving shared Records cache coordination, in-flight review state, persisted zero-document routing, script order, and PWA cache alignment.
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

Status: complete for the current exact route registry. The contract slice added `src/contracts/client-api.ts` for shared PWA response DTOs, `src/contracts/client-api-coverage.ts` for every current client API/SWR/job path, backend assignability checks for Settings/Profile/Goal/Plan/Exercise/Health-document payloads, and a typed `listExercises()` row so SQLite row leakage is not the public contract. The coverage gate now scans `src/client/**/*.ts` and generated `public/js` for direct API calls, `cachedApi`, `enqueueJob`, SWR path literals, and durable job path literals; the current unknown-waiver list and `CLIENT_API_BROAD_RESPONSE_WAIVERS` are both empty. The exact `ClientApiResponses` map no longer assigns specific routes to `ClientJsonObject` / `ClientJsonArray`, and deterministic client DTO coverage is complete for the current deterministic surfaces, including `/run-zones`, `/run-plan`, `/muscle-trajectory`, `/test-week`, `/dexa-targeting`, `/program/balance`, `/program/adjustments`, `/program/blocks`, `/program/blocks/active`, `/guidelines`, and `/injury-impacts`.

Purpose: remove `unknown` from the PWA API seam.

Teams:

- API Contract Agent: inventory every `api("/...")` call in the PWA and add DTOs for the high-use endpoints.
- Backend Assignability Agent: add compile-time compatibility assertions from repo/domain return types to DTOs.
- Route Contract Agent: move route state literals into shared contracts consumed by client and tests.
- MCP Parity Agent: ensure contract work does not break REST/MCP naming or docs parity.

Tasks:

- [x] Expand `ClientApiResponses` by screen, not randomly.
- [x] Add DTOs for Settings, Profile, Plan, Today, Program, Progress, Health, Records, Chat, Jobs, and Proposals.
- [x] Replace broad `unknown` in extracted helpers with DTO-backed shapes for the current exact route registry.
- [x] Keep payload DTOs client-safe and free of DB row leakage where the UI should not care.
- [x] Add engineering contracts that fail when new PWA `api()`, `cachedApi()`, SWR, or durable-job paths lack an explicit DTO or an intentional `unknown` waiver.
- [x] Remove temporary unknown waivers for the current client path set.
- [x] Add owned broad-response waivers so `ClientJsonObject` / `ClientJsonArray` debt cannot grow silently.
- [x] Add backend assignability checks for shared DTOs where repo return types are already exported cleanly.
- [x] Narrow deterministic training-brain DTOs for run zones, weekly run plan, muscle trajectory, test-week cadence, DEXA targeting, program balance, and program adjustments.
- [x] Narrow program block lifecycle DTOs and wire the Progress block helper to the shared block contract.
- [x] Narrow the offline guideline reference DTO used by connected-brain evidence surfaces.
- [x] Narrow the injury-impact DTO used by active injury Life cards and personal-context surfaces.
- [x] Keep exact route responses narrow enough that no broad-response waiver is currently needed.
- [ ] Continue narrowing dynamic fallback/internal payload shapes as large screen controllers are split.

Gate:

- `npm run typecheck:client`
- backend `tsc`
- focused client contract tests
- `npm run verify`

### Wave 3 - Typed Component Core

Status: in progress. The first component slices added `src/client/ui-components.ts` / `public/js/ui-components.js`, a tiny pure `CairnUi` primitive for escaped attributes, action buttons, empty states, text chips, loading states, segmented navigation, and job captions. Health marker empty-state markup, Today training variation chips, the legacy `loadingState()` / `segBar()` wrappers, and shared agent-job caption slots now use it, and VM tests guard hostile-string escaping, boolean/invalid attributes, ARIA boolean rendering, segmented-control group/pressed semantics, polite loading/empty/job status semantics, stable button type/status semantics, active segment slider markup, job reconnect selector markup, index script order, component dependencies, and service-worker cache coverage. Shared UI feedback helpers now live outside route screens: `src/client/ui-feedback-client.ts` / `public/js/ui-feedback-client.js` owns `btnBusy`, `loadingState`, `thinkingCaption`, skeletons, count-ups, `stagger`, and reduced-motion checks. The first interactive shared UI helpers now live outside route screens: `src/client/save-bar.ts` / `public/js/save-bar.js` owns the floating unsaved-changes bar used by Settings, Plan, Profile, and Meals, and `src/client/ui-motion-client.ts` / `public/js/ui-motion-client.js` owns shared collapse/expand DOM motion used by Today, Capture, Progress, and Health directive cards while preserving the old global API.

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
- [x] Move shared feedback/loading primitives into `src/client/ui-feedback-client.ts` while preserving `btnBusy`, `loadingState`, `thinkingCaption`, skeleton, count-up, and reduced-motion compatibility globals.
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

Status: complete for helper and served-screen source migration. `date-utils`, `html-utils`, `markdown-client`, `exercise-detail-client`, `format-utils`, `api-client`, `ui-feedback-client`, `ui-motion-client`, `detail-overlay-client`, `agent-login-client`, `agent-job-client`, `chat-turn-client`, `chat-history-client`, `chat-attachment-client`, `chat-composer-focus-client`, `chat-composer-controller`, `chat-header-controller`, `app-sw-recovery`, `pwa-install-coach`, `rest-timer`, `coaching-focus-client`, `today-activity-client`, `swr-cache`, `today-agenda-client`, `today-rail-controller`, `today-training-client`, `today-brief-client`, `today-brief-controller`, `today-brief-actions-client`, `today-session-suggest-client`, `today-session-suggest-controller`, `today-session-status-client`, `today-session-feedback-client`, `today-session-controller`, `today-program-adjustments-client`, `today-week-ahead-client`, `today-context-client`, `today-garmin-reconciliation-client`, `today-data-loader`, `today-dependencies`, `cardio-plan-client`, `cardio-sync-client`, `proposal-client`, `progress-endurance-client`, `progress-components-client`, `progress-chart-client`, `progress-chart-scrub-client`, `progress-history-client`, `progress-run-plan-client`, `progress-route-deps-client`, `progress-endurance-controller`, `progress-volume-client`, `progress-energy-client`, `progress-energy-surface-client`, `progress-calendar-client`, `progress-muscle-trajectory-client`, `progress-dexa-targeting-client`, `progress-performance-client`, `progress-program-adjustments-client`, `progress-test-week-client`, `progress-program-summary-client`, `progress-program-block-client`, `progress-program-controller`, `plan-editor-client`, `plan-editor-controller`, `plan-endurance-client`, `plan-endurance-model`, `day-fuel-client`, `day-fuel-controller`, `meal-row-client`, `meal-plan-client`, `meal-recipe-client`, `meal-recipe-controller`, `meal-swap-data-client`, `meal-planner-controller`, `meal-swap-controller`, `coach-meals-screen`, `food-note-client`, `food-detail-controller`, `me-profile-controller`, `health-docs-client`, `health-read-client`, `health-read-synthesis-client`, `health-read-controller`, `health-standing-client`, `health-standing-controller`, `health-picture-client`, `health-picture-controller`, `health-markers-client`, `health-markers-controller`, `health-directives-client`, `health-directives-loader-client`, `health-learned-client`, `health-records-client`, `health-doc-upload-controller`, `memory-client`, `life-client`, `life-controller`, `family-client`, `family-controller`, `me-health-screen`, `me-records-screen`, `settings-routes`, `settings-client`, `settings-data-client`, `settings-data-controller`, `settings-agents-client`, `settings-agents-controller`, `settings-screen`, `chat-client`, `chat-message-client`, `ui-shell`, and `health-client` are now TypeScript-authored browser-global compatibility outputs. `app-sw-recovery` owns the earliest service-worker update registration so stale script caches can recover before brittle feature code executes. `ui-feedback-client` owns shared busy/loading/thinking/skeleton/count-up primitives while preserving old compatibility globals. Agent Login is now split across model/assets/modal/session helpers while `agent-login-client` preserves the `openAgentLoginModal` compatibility function used by Settings. `agent-job-client` owns durable agent-job enqueueing, SSE streaming, reconnect, teardown, and `runOp` / `registerJobReconnector` compatibility for Today, Capture, Progress, Meals, Health, Chat, and boot. Helpers that were split out of old screen files keep their internals private-scoped when an old screen may still define the same names from cache. The latest reduction waves leave the served compatibility filenames stable while moving runtime ownership into focused TypeScript modules: Today Brief, Today dependency assembly, Today data loading, Today session feedback, Plan Endurance model rendering, Meal row/day rendering, Health Standing, Health Read synthesis, Health Markers, Health Doc Upload, Meal Swap data normalization, Meal Swap, Progress chart scrub behavior, Progress route dependencies, Progress Program, Plan Editor, Settings Agents, Chat header/composer focus/composer controller, Me Life, Family workflow, and shared UI feedback all have their own source, generated output, VM/contracts coverage, and service-worker wiring.

Latest wave delta: `src/client/today-screen.ts` now owns the served `/js/03-today.js` Today screen output behind strict client TypeScript, with Garmin reconciliation delegated to `src/client/today-garmin-reconciliation-client.ts`. `src/client/health-directives-loader-client.ts` closes the direct Health Read route dependency on directive loader globals. `src/client/chat-screen.ts` owns the served `/js/09-plan-chat.js` Chat screen output, with image compression/upload preview and native file-picker focus recovery delegated to `src/client/chat-attachment-client.ts`; Chat still preserves paste/send, message rendering, fuel-surface gating, proposal apply buttons, session-history links, and mobile input behavior behind strict client TypeScript. Agent Login moved out of `ui-shell.ts`; its model/assets/modal/session responsibilities now live in focused helpers while `agent-login-client.ts` preserves `openAgentLoginModal`. `src/client/today-lately-client.ts` owns Garmin reaction and Lately row/detail/movement rendering, while `03-today.js` keeps `/recent-training` loading and expansion wiring. `src/client/cardio-sync-client.ts` also owns the shared HR-zone palette and `wireCardioSync` compatibility global used by Today, Progress, and Plan. `src/client/today-cards-client.ts` now owns the Today exercise/cardio card renderer, timed-mode detection, synced-cardio done state, and cardio-effort matching. `src/client/today-render-state-client.ts` owns the high-level Today display-mode derivation (`showPlan`, `showDone`, focus eligibility, logged-set/Garmin/reveal state), keeping `today-screen.ts` closer to data orchestration and markup assembly. `src/client/today-brief-actions-client.ts` owns Today Brief DOM actions (steer chips, redirects, reset-to-today, offline-dismiss, and why-disclosure wiring), leaving `today-brief-controller.ts` focused on load/render/orchestration. `src/client/today-dependencies.ts` owns lazy Today dependency adapter assembly for side-loaders, plan surface rendering, Brief/session/rail/progression/add-exercise/data/post-render controllers, dropping `today-screen.ts` without changing the served route or reading late-loaded globals during script load. `src/client/plan-endurance-model.ts` owns Plan Endurance phase/ramp/preset selection, draft-card HTML, record coercion, and run-row normalization, leaving `plan-endurance-client.ts` focused on DOM lifecycle and API orchestration. Progress chart geometry, drawing primitives, scrub wiring, and lifecycle are now split across `progress-line-chart-model`, `progress-chart-drawing-client`, `progress-chart-scrub-client`, and `progress-chart-client`. `src/client/meal-row-client.ts` owns meal row/day primitives and planner context helpers, dropping `meal-plan-client.ts` below the large-file list. `src/client/health-marker-order-client.ts` owns marker ordering/ranking and LDL group-note helpers, dropping `health-client.ts` to 123 lines while preserving `CairnHealthClient`. `src/client/health-share-controller.ts` owns the Health Share tab render/wiring, and the later `src/client/family-controller.ts` split drops `me-records-screen.ts` to 151 lines while preserving `/app/me/health/share` and `/app/me/family`. `src/client/ui-header-client.ts` owns Today header/date-picker and condensed-header behavior, leaving `ui-shell.ts` as a compatibility delegate. `CairnMeHealthDependencies.context(...)` centralizes Me Health dependency-context assembly; this is an intentional ownership tradeoff that makes the screen caller thin while leaving the dependency module as the explicit composition point.

Latest Progress/Coach/Settings split: `src/client/progress-trend-weight-client.ts` owns Progress trend/weight helper rendering and drops `progress-screen.ts` to 256 lines; `src/client/coach-proposal-controller.ts` owns Coach proposal run/apply/reconnect wiring and drops `coach-meals-screen.ts` to 200 lines while preserving `applyProposalById` and `reconnectProposal`; `src/client/settings-sources-automation-controller.ts` owns Settings Sources/Automation rendering and toggles, dropping `settings-screen.ts` to 229 lines.

Latest UI/Today/Me/Meals split: `src/client/ui-segments-client.ts` owns segmented-nav fitting, Progress/Plan handler registries, and discipline/endurance-tab visibility, dropping `ui-shell.ts` to 292 lines; `src/client/today-compatibility-bridges.ts` owns Today's legacy compatibility bridge calls for Brief/session/progression/add-exercise/side-loader wrappers, dropping `today-screen.ts` to 670 lines while preserving `renderToday` and the old global bridge names; `src/client/me-health-controller-deps.ts` owns Me Health controller-specific dependency factories, dropping `me-health-dependencies.ts` to 230 lines; `src/client/meal-swap-row-actions-controller.ts` owns Meal Swap row logging, panel toggles, hint chips, Enter-submit, movement, and sheet-opening wiring, dropping `meal-swap-controller.ts` to 228 lines.

Latest runtime/composition split: `src/client/today-screen-runtime.ts` owns Today's API/SWR/legacy-wrapper facade while `src/client/today-screen-runtime-deps.ts` owns the large Today dependency adapter map, dropping `today-screen-runtime.ts` to 358 lines and keeping `today-screen.ts` at 390 lines focused on render orchestration; `src/client/me-health-screen-composition.ts` owns Me/Health section routing and controller delegation, dropping `me-health-screen.ts` to 325 lines as a compatibility facade; `src/client/chat-turn-monitor-client.ts` owns Chat turn EventSource lifecycle and reconnect advancement, dropping `chat-turn-client.ts` to 258 lines; `src/client/agent-job-records-client.ts` owns durable job record/SSE parsing, dropping `agent-job-client.ts` to 251 lines.

Latest multi-agent reduction split: Agent Login is now a thin `openAgentLoginModal` entrypoint over `agent-login-model-client`, `agent-login-assets-client`, `agent-login-modal-client`, and `agent-login-session-client` (36-line entrypoint); Capture weekly/insight reads are split into date labels, card rendering, quiet generation/reconnect jobs, and a 98-line composition controller; Progress charts now separate geometry, drawing primitives, scrub wiring, and canvas lifecycle (`progress-line-chart-model`, `progress-chart-drawing-client`, `progress-chart-scrub-client`, `progress-chart-client`), Progress History now separates model, render, and controller (`progress-history-model-client`, `progress-history-render-client`, `progress-history-client`), Today rail slot hydration now lives in `today-rail-loaders-client` while `today-rail-controller` stays a dispatch/generic-card controller, Today plan/session deterministic model plus async data now live in `today-plan-session-model` and `today-plan-session-data-client` while `today-plan-session-preparation` stays the orchestration API, and Family add/list/edit/delete workflow now lives in `family-controller` while `08-me-records` stays the route bridge. The public shell now has 214 generated browser outputs, 216 boot scripts, 220 core service-worker assets, and `public/sw.js` cache `cairn-v394`.

Latest Today rail split: `src/client/today-rail-controller.ts` owns agenda fetch, loader dispatch, generic agenda-card routing, and dismiss wiring; `src/client/today-rail-loaders-client.ts` owns fuel, week-ahead, program-adjustment, recent-activity, and Garmin reconciliation slot hydration.

Latest Today context split: `src/client/today-context-client.ts` owns near-term context filtering, countdown wording, goal-line markup, and health-focus banner markup while `src/client/today-screen.ts` keeps `/context-events`, `/health/synthesis`, and route navigation wiring.

Purpose: move already-extracted helper JS into real TS modules.

Latest Meal Plan split: `meal-plan-client` now also owns the planner shell, preference card, current-plan selection, context derivation, and shopping-chip markup; `meal-planner-jobs-client` owns meal-plan draft job/cache state, verification memory, generic reconnect status handling, and the old `reconnectMealPlan` global; `meal-planner-actions-controller` owns history accept/discard, preferences save-bar wiring, keep/discard, draft button, and shopping persistence; `meal-planner-controller` is now only the compatibility facade used by `06-coach-meals.js` and existing collaborators.

Latest Meal Recipe split: `meal-recipe-client` owns the bottom-sheet recipe CTA, recipe result HTML, and loading caption markup while `meal-recipe-controller` owns sheet lifecycle, recipe runOp/reconnect, cache invalidation, close/reconnect compatibility globals, and result settling. `06-coach-meals.js` now only opens the controller from meal rows.

Latest Coach/Meals screen migration: `src/client/coach-meals-screen.ts` now owns the served `/js/06-coach-meals.js` screen file, preserving Coach proposals, meal-plan draft/accept/discard, Plan Meals SWR, preferences, log/swap/reorder, recipe bottom sheet, Plan Food day-fuel edit/delete, and durable job reconnectors behind strict client TypeScript.

Latest Progress Energy split: `progress-energy-client` owns the Energy Balance hero/card and nutrition check-in loading/ok/fail/advisory proposal markup; `progress-energy-surface-client` owns the reusable DOM painting, durable nutrition check-in runOp/reconnect, count-up, dismissal, and Plan navigation wiring shared by Progress and Plan Food. `05-progress.js` keeps only the route/SWR shell.

Latest Progress Endurance split: `src/client/progress-endurance-controller.ts` now owns the Endurance route's endpoint fan-out, stale-token guard, empty-state/full-read painting, Garmin sync rerender hook, and `#endBody` DOM ownership while `src/client/progress-screen.ts` keeps only the compatibility wrapper and dependency adapter for the preserved `renderEndurance` route handler.

Latest Progress data split: `src/client/progress-data-client.ts` owns shared Progress API payload normalization (`record`, typed rows, string, number) behind the `CairnProgressData` browser-global helper. `src/client/progress-screen.ts` now keeps route/SWR orchestration and DOM painting while delegating coercion through that helper.

Latest Progress route dependency split: `src/client/progress-route-deps-client.ts` owns the shared Progress controller dependency adapters for Endurance and Program: route segment HTML, skeletons, segment wiring, token freshness, shared UI helpers, API/job/cache hooks, and render-self callbacks. `05-progress.js` keeps the route handlers and delegates controller deps through `CairnProgressRouteDeps`.

Latest route-preservation fix: Chrome direct-link smoke caught `/app/progress/energy` falling back to Progress History because the typed route parser already accepted `energy` but the classic `PROGRESS_SEG` registry did not. The segment registry, handler map, `ClientProgressSection`, app-router test, and engineering contract now keep Progress Energy linkable.

Latest Progress screen migration: `src/client/progress-screen.ts` now owns the served `/js/05-progress.js` screen file, preserving History, 1RM, Weight, Volume, Endurance, Calendar, Energy route/SWR shell, Program, program evolution, and exercise-name tidy wiring behind strict client TypeScript.

Latest Me Profile split: `src/client/me-profile-form-client.ts` owns Profile form HTML plus profile record normalization, goal-mode derivation, and parsed endurance-goal state. `src/client/me-profile-controller.ts` now keeps the Profile fetch/render/save/wiring flow, discipline/endurance goal persistence, save-bar dirty state, cache invalidation, and the race-date guard. `src/client/me-health-tabs-controller.ts` owns Health inner-tab segment normalization, activation, route sync, picker-preserving Records jumps, and tab dispatch. `src/client/me-health-screen.ts` keeps typed dependency adapters for Profile, tabs, Memory, Health Read loaders, health synthesis jobs, BP sheet, supplements, Health Picture controller coordination, script order, and PWA cache alignment.

Latest Health Picture split: `src/client/health-picture-controller.ts` now owns the shared Health/Records picture cache, in-flight review run, failed-review message, persisted zero-document routing hint, and `#hPicture` paint/load/review wiring while `src/client/me-health-screen.ts` keeps only compatibility wrappers and its Health Read dependency adapter.

Latest UI shell migration: `src/client/ui-shell.ts` now owns the served `/js/02-ui.js` file, preserving header date controls, toast/delete pattern, segmented nav, transitions, skeleton/loading states, detail overlays, enrichment polling, food/exercise detail bridges, script order, and PWA cache alignment behind strict client TypeScript. Progressive art lives in `src/client/art-controller.ts`, and the agent-login terminal lives in `src/client/agent-login-client.ts`.

Latest Me records screen migration: `src/client/me-records-health-doc-controller.ts` now owns Records list loading, upload handoff, and deep-link scrolling, while `src/client/health-doc-actions-controller.ts` owns per-document row behavior: date edit/save/cancel, re-analysis polling, collapse toggles, delete, picture-cache decrement, marker refreshes, and row rewiring. `src/client/family-controller.ts` now owns Family roster add/list/edit/delete workflow and `src/client/me-records-screen.ts` remains the served `/js/08-me-records.js` route bridge for Health Markers/Records/Share/Learned tab bridges, Life timeline delegation, and Family delegation.

Latest agent-job client split: `src/client/agent-job-client.ts` now owns the generated `/js/agent-job-client.js` durable job runner. It preserves `registerJobReconnector`, `enqueueJob`, `openJobStream`, `jobReconnect`, `teardownJobs`, and `runOp` globals while removing that ownership from `/js/09-plan-chat.js`. The script loads after `02-ui.js` and before every job consumer plus `app-job-reconnectors.js`, directly guarding the stale/mixed-script deployment failure class where reconnectors ran before the job API existed.

Latest chat-turn client split: `src/client/chat-turn-client.ts` now owns the generated `/js/chat-turn-client.js` durable chat-turn queue/stream client. It preserves chat draft storage, pending/streaming assistant bubbles, Stop/cancel, SSE reconnect, and live markdown delta rendering while removing that state from `/js/09-plan-chat.js`.

Latest chat-layout client split: `src/client/chat-layout-client.ts` owns the generated `/js/chat-layout-client.js` chat jump-to-latest wiring, composer autosize, and viewport measurement helper. `src/client/chat-turn-client.ts` still bridges `wireChatJump`, `autosizeChatInput`, and `measureChatTop` as legacy globals for the served Chat screen and app viewport hooks.

Latest chat-history client split: `src/client/chat-history-client.ts` owns the generated `/js/chat-history-client.js` read-only history/search overlay. It preserves conversation search, archived-session deep links, route sync for `session`, and static readonly conversation rendering; the served Chat screen now lives in `src/client/chat-screen.ts`.

Teams:

- Utility Agent: dates, formatting, HTML helpers.
- Data Agent: API client, SWR cache, route state.
- Domain Helper Agent: Today training/agenda, Chat, Health, Settings helpers.
- Compatibility Agent: preserve `window.Cairn*` assignments until all classic consumers are migrated.

Tasks:

- [x] Move each extracted `public/js/*-client.js` helper to `src/client/.../*.ts`.
- [x] Emit the same public JS filename or a documented module replacement.
- [x] Replace JSDoc typedef imports with real TypeScript imports where module output is safe.
- [x] Keep tests at the source level and, where useful, against emitted JS.

Gate:

- generated output freshness check
- `npm run client:check`
- helper VM tests
- `npm run verify`

### Wave 5 - Shell, Router, Jobs, And Service Worker

Status: in progress. The first shell slice added `src/client/app/state.ts` / `public/js/01-core.js` for typed `$`, `view`, `headerTitle`, and `state` initialization. The shared UI shell slice added `src/client/ui-shell.ts` / `public/js/02-ui.js`, preserving header date controls, toast/delete pattern, segmented nav registries, transitions, skeleton/loading states, detail overlays, enrichment polling, and food/exercise detail bridges in typed source. The agent-login slice added `src/client/agent-login-client.ts` / `public/js/agent-login-client.js`, preserving the xterm WebSocket login terminal and `openAgentLoginModal` compatibility function outside the shared UI shell. The shared agent-job slice added `src/client/agent-job-client.ts` / `public/js/agent-job-client.js`, preserving durable job enqueueing, SSE progress, reconnect, teardown, and `runOp` globals outside the Chat screen. The shared chat-turn slice added `src/client/chat-turn-client.ts` / `public/js/chat-turn-client.js`, preserving durable chat-turn queueing, live markdown streaming, cancel/stop, reconnect, autosize, jump-to-latest, and viewport measurement outside the remaining Plan/Chat screen. The shared chat-history slice added `src/client/chat-history-client.ts` / `public/js/chat-history-client.js`, preserving conversation search, archived session deep links, and route sync outside the remaining Plan/Chat screen. The download slice added `src/client/app/download.ts` / `public/js/app-download.js`, preserving the global export/download helper used by Settings and Health Records outside boot. The route contract slice added `src/contracts/client-routes.ts`, so app tab/section literals now come from one shared contract consumed by `ClientRoute`, `CairnRoutes`, `app-router`, and `app-tabs`. The first router slice added `src/client/app/router.ts` / `public/js/app-router.js`, so parsed route application, current route serialization, and browser history sync are typed. The route-sync slice added `src/client/app/route-sync.ts` / `public/js/app-route-sync.js`, moving the screen-facing `routeApi`/`applyRouteState`/`currentRouteState`/`syncRouteFromState` wrappers out of boot while preserving global compatibility. The render-dispatch slice added `src/client/app/render-dispatch.ts` / `public/js/app-render-dispatch.js`, moving header cleanup, one-shot Plan jump routing, Progress handler fallback, and global `renderTab` compatibility out of boot. The tab slice added `src/client/app/tabs.ts` / `public/js/app-tabs.js`, moving default Progress landing, skeleton-first tab transitions, warm-cache skeleton skipping, tabbar click registration, and global `switchTab`/`activateTab` compatibility out of boot. The onboarding slice added `src/client/app/onboarding.ts` / `public/js/app-onboarding.js`, preserving the first-run modal, discipline/profile persistence, settings fallback, cache clears, and Today re-entry outside boot. The boot-time jobs slice added `src/client/app/job-reconnectors.ts` / `public/js/app-job-reconnectors.js`, preserving the exact boot-time agent-job reconnect registration order while keeping `10-boot.js` last. The mobile viewport slice added `src/client/app/mobile-viewport.ts` / `public/js/app-mobile-viewport.js`, keeping iOS visual-viewport and soft-keyboard correction behavior outside the boot file. The service-worker slice added `src/client/app/service-worker.ts` / `public/js/app-service-worker.js`, preserving the controller-change reload policy in typed source. The discipline-primer slice added `src/client/app/discipline-primer.ts` / `public/js/app-discipline-primer.js`, preserving first-paint endurance defaults for direct Progress/Plan landings. The startup slice added `src/client/app/startup.ts` / `public/js/app-startup.js`, preserving direct route activation, legacy query canonicalization, popstate routing, onboarding, art refresh, deferred job reconnect, and mobile guard order behind a single boot call. The Settings shell slice added `src/client/settings-screen.ts` / `public/js/settings-screen.js`, moving the last large Settings render body out of `10-boot.js`; `src/client/settings-data-client.ts` owns the Settings Data Phone/PWA access card and token-helper wiring, `src/client/settings-data-controller.ts` owns Data-tab update/export/setup orchestration, and `src/client/settings-agents-client.ts` now owns pure Settings Agents slice/card markup while the screen keeps state, route pruning, API polling, and wiring. `10-boot.js` is now only the stable final startup shim. VM tests now guard app-state initialization, download behavior, route apply/current/sync behavior, route-sync wrappers, render dispatch, tab transitions, onboarding, reconnect registration order, viewport keyboard geometry, service-worker reload behavior, discipline primer warm/cold profile paths, Settings Data rendering/wiring, Settings Agents rendering, and startup sequencing, and engineering contracts guard script/cache placement.

Latest mobile Chat input hardening: `src/client/app/mobile-viewport.ts` now treats `visualViewport` geometry as the durable keyboard signal, uses a short touch/focus intent bridge only while the keyboard is opening, clamps bottom inset correction to zero or greater, clears stale chat textarea focus after iOS dismisses the keyboard, and listens for `cairn:keyboard-settle`. `src/client/chat-attachment-client.ts` owns the native file-picker return path: it drops stale focus when the soft keyboard is hidden, dispatches the keyboard-settle grace event, and remeasures through the post-picker viewport animation. The remaining `09-plan-chat.js` send/composer wiring prevents touch `pointerdown` blur, sends on `pointerup`, keeps mobile Enter as newline, and remeasures the composer through the normal keyboard animation.

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
- [x] Move the shared UI shell (`02-ui.js`) to `src/client/ui-shell.ts` while preserving mutable globals, segment registries, detail overlays, art compatibility consumers, enrichment polling, script order, and PWA cache alignment. The agent-login modal is now owned by `src/client/agent-login-client.ts`.
- [x] Move progressive art readiness and `artImg` rendering into `src/client/art-controller.ts` while preserving `art`, `artImg`, `primeArtManifest`, and `artEnabled` compatibility globals, script order, and PWA cache alignment.
- [x] Move route apply/current/sync shell logic behind a typed compatibility module.
- [x] Move durable agent-job enqueue/stream/reconnect/teardown/runOp behind a typed compatibility module.
- [x] Make job reconnector registration order explicit and tested.
- [x] Cover mobile Chat keyboard/input contracts in focused tests while browser smoke remains the final device check. The file-picker path now has contracts around `chatAttachmentResetFocusAfterNativePicker`, `chatAttachmentSettleAfterNativePicker`, `cairn:keyboard-settle`, and the mobile viewport chat-focus grace window.
- Keep `registerJobReconnector`, `teardownJobs`, and chat teardown paths covered by a browser smoke.

Gate:

- route tests
- job/reconnect tests
- Chrome smoke for direct links and tab switching
- `npm run verify`
- `npm run smoke` / `npm run smoke:built` with canonical `/app/*` deep-link assertions

### Wave 6 - Screen Migration By Domain

Status: source migration complete, modularization still in progress. The Today team's capture/provenance/insight script now has TypeScript source in `src/client/capture.ts`, preserving the served `/js/04-capture.js` filename and its classic-script globals for `03-today.js`, meals, and job reconnectors. Shared activity-row rendering now lives in `src/client/today-activity-client.ts`, reducing `04-capture.js` and Health activity history dependence on `03-today.js`. The Today Brief and focus-bar renderer now lives in `src/client/today-brief-client.ts`, reducing the remaining `03-today.js` day-read surface while preserving fetch/cache/job wiring. The Today session-suggestion renderer now lives in `src/client/today-session-suggest-client.ts`, and its request lifecycle/reconnect/log-these behavior now lives in `src/client/today-session-suggest-controller.ts`; `03-today.js` keeps only compatibility wrappers for the job reconnector and Today-owned dependencies. The Today add/off-plan exercise controller now lives in `src/client/today-add-exercise-controller.ts`, reducing the remaining `03-today.js` add-form, skipped-card restoration, typed-card protection, last-set prefill, and pending off-plan mutation surface while preserving explicit Today dependencies. The Today session-status renderer now lives in `src/client/today-session-status-client.ts`, reducing the remaining `03-today.js` completion/feedback/skip micro-markup. The Today session/logging controller now lives in `src/client/today-session-controller.ts`, reducing finish/reopen/history, feedback persistence, set logging/deletes, skip undo, off-plan removal, rest start, and progression invalidation from the remaining screen while preserving explicit Today dependencies. The Today exercise/cardio card renderer now lives in `src/client/today-cards-client.ts`, reducing the remaining `03-today.js` logging-card markup while preserving selectors, timed-mode detection, synced-cardio done cards, cardio matching, script order, and PWA cache alignment. The Today program-adjustment rail renderer now lives in `src/client/today-program-adjustments-client.ts`, reducing the remaining `03-today.js` "what changed" card markup while preserving API loading, expansion state, chat prefill, and plan navigation wiring. The Today context/goal/health rail renderer now lives in `src/client/today-context-client.ts`, reducing the remaining `03-today.js` Brief-adjacent chrome while preserving context-event loading, goal navigation, and Health Read routing. The Progress screen now has TypeScript source in `src/client/progress-screen.ts`, preserving the served `/js/05-progress.js` filename and delegating rich render pieces to the typed Progress helper modules. The Plan Coach/Meals/Food screen now has TypeScript source in `src/client/coach-meals-screen.ts`, preserving the served `/js/06-coach-meals.js` filename and delegating rich render pieces to the typed proposal, day-fuel renderer/controller, meal-plan, meal-recipe renderer, and meal-recipe controller modules. The Me Health screen now has TypeScript source in `src/client/me-health-screen.ts`, preserving the served `/js/07-me-health.js` filename and delegating rich render pieces to the typed Health and Memory helper modules. The Me records/life/family screen now has TypeScript source in `src/client/me-records-screen.ts`, preserving the served `/js/08-me-records.js` filename and delegating rich render pieces to the typed Health, Life, and Family helper modules. The remaining work is reducing the large controller files into smaller render/data/wiring modules and expanding browser smoke beyond route/global boot.

Latest multi-agent reduction wave: `src/client/today-side-loaders.ts` now owns Today side-slot loaders for Garmin wearable data, meal hints, context banners, draft proposal prompts, and Health focus routing; `src/client/today-data-loader.ts` owns Today's primary cache peeks, cold skeleton paint, `/plan`/session/stats/profile/exercise fetches, and guarded soft SWR repaint; `src/client/art-controller.ts` owns progressive artwork readiness, manifest priming, generated-photo error handling, and `artImg` compatibility outside the UI shell; `src/client/capture-reads-client.ts` owns Capture's weekly read and insight controller; `src/client/health-read-synthesis-client.ts` owns Health Read synthesis rendering, loading, and background job orchestration; `src/client/health-read-controller.ts` owns the remaining Health Read recovery, symptom-link, supplements, and priority-marker orchestration; `src/client/today-session-feedback-client.ts` owns Today session feedback render/save/edit wiring; `src/client/today-session-controller.ts` owns the remaining set logging, delete, skip, finish/reopen, rest, and progression invalidation behavior; `src/client/health-standing-controller.ts` owns Health Standing data loading, BP sheet orchestration, and body-composition refresh wiring; `src/client/health-markers-controller.ts` owns Health marker loading, expansion, selected-marker routing, chart refreshes, and share/report handoff; `src/client/health-doc-upload-controller.ts` owns Health document file/text intake and Health Picture cache invalidation; `src/client/chat-message-client.ts` owns Chat message rendering and apply controls; `src/client/chat-composer-focus-client.ts` owns native-picker focus recovery; `src/client/chat-composer-controller.ts` owns composer attachment, paste/change, send, draft, and focus-wiring orchestration; `src/client/meal-planner-controller.ts` owns the Meal Plan planner workflow; `src/client/meal-swap-data-client.ts` owns Meal Swap payload/result normalization and cache-key lookup; `src/client/meal-swap-controller.ts` owns swap request/reconnect/apply/discard behavior; `src/client/progress-route-deps-client.ts` owns shared Progress Endurance/Program dependency adapters; `src/client/progress-program-controller.ts` owns Progress Program loading, block/progression actions, and route state; `src/client/settings-agents-controller.ts` owns Settings Agents polling, model detail hydration, save-bar mutation, and CLI update wiring; `src/client/ui-feedback-client.ts` owns busy/loading/thinking/skeleton/count-up primitives; and `src/client/me-memory-controller.ts` owns Me Memory loading/editing.

Latest Today controller reduction: `src/client/today-week-ahead-client.ts` now owns the Week Ahead rail card renderer and keeps the Today screen responsible only for API fetch and slot replacement.

Latest Today Brief reduction: `src/client/today-brief-controller.ts` now owns day-read loading, cached Brief hydration, focus-mode refreshes, steer-chip actions, reshaping, and reconnect wiring while `src/client/today-screen.ts` supplies explicit dependencies and page composition.

Latest Settings controller reduction: `src/client/settings-data-controller.ts` now owns the Data tab's update-check toggle, check-now action, backup downloads, setup reset, lazy status hydration, and phone-access wiring; `src/client/settings-agents-client.ts` owns the Settings Agents slice and agent-card markup; `src/client/settings-agents-controller.ts` owns Agents polling, lazy detail/model hydration, save-bar mutation, CLI update checks, and login handoff; `src/client/settings-screen.ts` keeps the Settings shell and route pruning.

Latest Meals controller reduction: `src/client/meal-planner-jobs-client.ts` owns the Meal Plan draft/reconnect/cache/verified-proposal state, `src/client/meal-planner-actions-controller.ts` owns planner DOM actions, and `src/client/meal-planner-controller.ts` stays as a thin compatibility facade. `src/client/meal-recipe-controller.ts` owns the Meal Recipe bottom-sheet lifecycle, CTA wiring, recipe runOp options, cache invalidation, and reconnect behavior; `src/client/coach-meals-screen.ts` keeps plan-level Meals/Food orchestration.

Latest Today chrome reduction: `src/client/today-context-client.ts` now owns the Brief-adjacent context, goal, and health-focus rail helpers and keeps the Today screen responsible only for data loading and navigation side effects.

Latest Today add-exercise reduction: `src/client/today-add-exercise-controller.ts` now owns the add/off-plan exercise form, mode switching, exercise datalist hydration, skipped-card restoration, existing-card type protection, last-set prefill, and pending off-plan mutation while `src/client/today-screen.ts` only supplies explicit dependencies.

Latest Today session/logging reduction: `src/client/today-session-feedback-client.ts` now owns session feedback rendering, save, edit, dismiss, and returned-row merge behavior. `src/client/today-session-controller.ts` keeps set logging, delete wiring, skip/undo, off-plan removal, finish/reopen, rest start, and progression invalidation while `src/client/today-screen.ts` only supplies explicit dependencies and compatibility wrappers for existing collaborators.

Latest Today post-render wiring/data reduction: `src/client/today-post-render-wiring.ts` now owns quick-log wiring, planned-cardio capture prefill, cardio sync refresh hooks, progression-apply buttons, Brief upgrade/provenance wiring, side-loader dispatch, rail dispatch, focus enter/exit, back-to-today, and day-button controls while `src/client/today-data-loader.ts` owns primary Today data/SWR loading. `src/client/today-screen.ts` supplies explicit dependencies and page composition.

Latest UI shell detail reduction: `src/client/exercise-detail-controller.ts` now owns exercise guide wiring, exercise detail modal rendering, explanation hydration, mode switching, and delete actions; `src/client/food-detail-controller.ts` now owns food detail modal rendering, goal-context loading, art source selection, and food-note removal; `src/client/ui-feedback-client.ts` now owns feedback/loading primitives; and `src/client/ui-view-transitions-client.ts` owns view-transition abort filtering, nesting guards, skeleton swaps, and `viewEnter` animation restart behavior. `src/client/ui-shell.ts` keeps only compatibility wrappers, navigation/toast/delete patterns, and explicit dependency factories.

Latest Capture voice reduction: `src/client/capture-voice-client.ts` now owns Web Speech feature detection, the mic glyph, and the press-to-talk recognition lifecycle. `src/client/capture.ts` keeps the stable `MIC_GLYPH` / `setupVoiceCapture` compatibility globals and delegates voice setup through the helper loaded before `04-capture.js`.

Latest Health/Records reduction: `src/client/health-read-synthesis-client.ts` owns Health Read synthesis rendering/loading/job wiring, `src/client/health-standing-primitives-client.ts` owns Standing percentile/metric/BP/body-composition render primitives, `src/client/health-standing-controller.ts` owns Standing-specific data and BP orchestration, `src/client/health-markers-controller.ts` owns marker route state and chart wiring, and `src/client/health-doc-upload-controller.ts` owns document upload intake. `src/client/me-health-screen.ts` and `src/client/me-records-health-doc-controller.ts` keep cross-tab coordination and explicit dependencies instead of owning every sub-flow.

Latest mobile chat focus hardening: `src/client/app/mobile-viewport.ts` now separates actual keyboard geometry (`kb-geometry-open`) from tap/focus intent (`kb-open`), and `src/client/chat-screen.ts` uses geometry truth to recover stale focused textareas after native image-picker return. `src/client/chat-attachment-client.ts` no longer mutates keyboard classes; it drops stale picker focus and emits native-picker suppression metadata, while browser smoke and VM tests verify focus recovery through the viewport guard.

Latest reduction waves: Plan editor orchestration now lives in `src/client/plan-editor-controller.ts`, Chat header history/session controls live in `src/client/chat-header-controller.ts`, and Me Life timeline orchestration lives in `src/client/life-controller.ts`. The newest splits move Plan editor form reads and save-payload assembly into `src/client/plan-editor-form-client.ts`, Health evidence/directive rendering into `src/client/health-evidence-client.ts`, Health Standing primitives into `src/client/health-standing-primitives-client.ts`, Health Read synthesis rendering/job wiring into `src/client/health-read-synthesis-client.ts`, Health Read supplement input/delete into `src/client/health-read-supplements-client.ts`, Me Health log rendering into `src/client/me-health-log-renderer.ts`, Me Health inner-tab routing into `src/client/me-health-tabs-controller.ts`, Settings data/status/source/automation render helpers into `src/client/settings-surface-client.ts`, Today main shell into `src/client/today-main-shell-client.ts`, Today plan/session preparation into `src/client/today-plan-session-preparation.ts`, Today plan/session deterministic modeling into `src/client/today-plan-session-model.ts`, Today plan/session async data loading into `src/client/today-plan-session-data-client.ts`, Today post-render DOM wiring into `src/client/today-post-render-wiring.ts`, Today session feedback into `src/client/today-session-feedback-client.ts`, Today session skip/off-plan wiring into `src/client/today-session-skip-client.ts`, Today Brief override jobs into `src/client/today-brief-override-client.ts`, Today's weekly compass/pace-offer rendering into `src/client/today-compass-client.ts`, Chat turn record normalization/draft storage into `src/client/chat-turn-records-client.ts`, Chat stream markdown state into `src/client/chat-turn-stream-state-client.ts`, Chat layout behavior into `src/client/chat-layout-client.ts`, Progress line-chart geometry into `src/client/progress-line-chart-model.ts`, shared view-transition behavior into `src/client/ui-view-transitions-client.ts`, and shared toast/delete actions into `src/client/ui-actions-client.ts`. Browser workflow smoke also verifies planned-cardio skip/restore without losing `/app/today` and Chat send/stream/reconnect through the real composer/SSE path.

Updated integration note: `03-today.js`, `02-ui.js`, `04-capture.js`, `07-me-health.js`, `08-me-records.js`, and `09-plan-chat.js` are still stable public compatibility filenames, but more runtime responsibility now lives in smaller generated modules loaded before those consumers. `public/js/10-boot.js` remains the tiny final startup shim; every other served client script should stay build-owned. Current top source-size targets are `today-screen.ts` (390 lines), `today-screen-runtime.ts` (358), `me-health-screen-composition.ts` (330), `me-health-screen.ts` (325), `ui-shell.ts` (292), `meal-recipe-controller.ts` (271), `health-read-client.ts` (268), `capture.ts` (266), `today-dependencies.ts` (259), `chat-turn-client.ts` (258), `progress-screen.ts` (256), `plan-editor-controller.ts` (256), `health-markers-client.ts` (256), `health-read-controller.ts` (252), and `agent-job-client.ts` (251). `meal-planner-controller.ts` is now a thin facade after planner job/action ownership moved into `meal-planner-jobs-client.ts` and `meal-planner-actions-controller.ts`; `today-rail-controller.ts` is now 180 lines after slot hydration moved into `today-rail-loaders-client.ts`; `today-plan-session-model.ts` is a 183-line deterministic model helper and `today-plan-session-data-client.ts` is a 133-line async data helper split out of the preparer, dropping `today-plan-session-preparation.ts` to 236 lines; `family-controller.ts` now owns the 236-line Family workflow and `me-records-screen.ts` is a 151-line route bridge. `agent-login-client.ts` is now a 36-line entrypoint, `capture-reads-client.ts` is now a 98-line composition controller, `progress-chart-client.ts` is now 128 lines, and `progress-history-client.ts` is now 130 lines after model/render/drawing ownership moved out. `today-dependencies.ts` remains a composition module; future work should split it only when a cohesive sub-context emerges, not by arbitrary line count. Future work should keep extracting cohesive controller/render/data modules from the remaining large files, not edit generated public output directly.

Purpose: convert large screens without losing behavior.

Teams and file ownership:

- Today Team: `03-today` and `04-capture`.
- Plan/Nutrition Team: plan editor, meals, food journal, meal plans, recipes, proposals.
- Progress/Training Team: `05-progress`, sessions, volume, program, performance, endurance.
- Health/Records Team: `07-me-health`, `08-me-records`, health read, markers, docs, learned timeline.
- Chat Team: `09-plan-chat`, streaming, markdown, image upload, history, session links.
- Settings Team: Settings screen shell and Agents slice/card rendering now typed; remaining ownership is deeper data/source/automation component splitting, agent login modal integration polish, update card, and data/export polish.

Tasks:

- Split each screen into render, state, data, components, and wiring modules.
- Keep each module small enough to review without context overload.
- Move screen-local HTML rows into typed components when repeated or safety-sensitive.
- Do not rewrite behavior during conversion unless a test exposes a bug.
- Preserve current route and cache behavior for every screen.
- [ ] Shrink the remaining large typed screen/controllers (`today-screen`, `today-screen-runtime`, `me-health-screen-composition`, `me-health-screen`, `meal-planner-controller`, `today-session-controller`, `today-plan-session-preparation`, `ui-shell`, `today-rail-controller`, `exercise-detail-controller`, `chat-screen`, `life-controller`, `meal-recipe-controller`, `health-read-client`, `capture`, `health-doc-actions-controller`, `today-dependencies`, `chat-turn-client`, `progress-screen`, `plan-editor-controller`, `health-markers-client`, `health-read-controller`, `agent-job-client`) into smaller responsibility modules. Latest slices moved Me Health inner-tab routing to `me-health-tabs-controller`, Me Health composition/controller delegation to `me-health-screen-composition`, Me Health dependency factories to `me-health-controller-deps`, Me Profile form rendering/normalization to `me-profile-form-client`, Chat turn records, EventSource monitoring, layout, and composer wiring to `chat-turn-records-client` / `chat-turn-monitor-client` / `chat-layout-client` / `chat-composer-controller`, durable job record parsing to `agent-job-records-client`, Progress data normalization, line-chart geometry/drawing/scrub wiring, route dependencies, History model/render/controller, and trend/weight rendering to `progress-data-client` / `progress-line-chart-model` / `progress-chart-drawing-client` / `progress-chart-scrub-client` / `progress-history-model-client` / `progress-history-render-client` / `progress-history-client` / `progress-route-deps-client` / `progress-trend-weight-client`, Agent Login model/assets/modal/session to `agent-login-model-client` / `agent-login-assets-client` / `agent-login-modal-client` / `agent-login-session-client`, Capture voice and read date/card/job/controller ownership to `capture-voice-client` / `capture-read-date-client` / `capture-read-cards-client` / `capture-read-jobs-client` / `capture-reads-client`, Today data loading, dependency assembly, main shell, plan-surface rendering, render-state derivation, compatibility bridges, runtime dependency adapters, and Brief DOM actions to `today-data-loader` / `today-dependencies` / `today-main-shell-client` / `today-plan-surface-renderer` / `today-render-state-client` / `today-compatibility-bridges` / `today-screen-runtime-deps` / `today-screen-runtime` / `today-brief-actions-client`, Plan Endurance model/render helpers to `plan-endurance-model`, Coach proposal wiring to `coach-proposal-controller`, Health marker ordering to `health-marker-order-client`, Health Standing primitives to `health-standing-primitives-client`, Records document actions, Health Share orchestration, and Family workflow to `health-doc-actions-controller` / `health-share-controller` / `family-controller`, Settings Sources/Automation orchestration to `settings-sources-automation-controller`, Plan editor form handling to `plan-editor-form-client`, app state shape to `src/contracts/client-state.ts`, UI header/date controls to `ui-header-client`, UI segment/discipline behavior to `ui-segments-client`, and UI transition behavior to `ui-view-transitions-client`.
- [x] Run a live route/cache browser smoke for preserved paths (`/`, `/app/today`, `/app/plan/food`, `/app/plan/meals`, `/app/progress/energy`, `/app/me/standing`, `/app/me/health/read`, `/app/me/health/records`, `/app/me/memory`, `/app/me/family`, `/app/chat`, `/app/settings/data`, `/app/settings/agents`) with console-error capture.
- [x] Add an opt-in automated browser route/global smoke lane (`npm run smoke:browser`) that boots the built server, launches Chrome/CDP with a fresh profile, loads preserved `/app/*` paths, fails on runtime/console/script/API load errors, and asserts critical app globals plus route section state.
- [x] Add the first dependency-free browser workflow smoke for Today add/off-plan exercise and Chat attachment focus recovery.
- [x] Extend browser workflow smoke so Today add/off-plan exercise logs a real set through the session controller and route smoke asserts preserved `/app/*` path URLs after hydration.
- [x] Expand the automated browser workflow lane for Today planned-cardio skip/restore. Current coverage includes Settings Data local controls, Progress and Plan segmented navigation, Health marker/records navigation, and planned-cardio restore on `/app/today`.
- [x] Expand the automated browser workflow lane for Chat send/stream/reconnect interactions. `npm run smoke:browser` now sends through the real composer, uses an offline streaming agent fixture, asserts a live assistant bubble, calls `chatReconnect`, and waits for terminal SSE completion plus an empty active-turn list.
- [x] Expand the automated browser workflow lane for synced-cardio override coverage. The smoke lane now skips a planned cardio card, posts a same-day synced Garmin-style activity, and verifies the planned card renders as done with the Garmin tag instead of remaining skipped.
- [x] Move `04-capture.js` to TypeScript-authored source while preserving output filename, script order, and browser-global compatibility.
- [x] Move the Capture provenance rail into `src/client/capture-provenance-client.ts` while preserving training/meal provenance wording, script order, and PWA cache alignment.
- [x] Move the Capture weekly read and insight controller into `src/client/capture-reads-client.ts` while preserving quiet generation gates, feedback/dismiss behavior, job reconnect, script order, and PWA cache alignment.
- [x] Move shared activity-row rendering out of `03-today.js` while preserving Today, quick-log, and Health history behavior.
- [x] Move the Today Brief/focus-bar renderer out of `03-today.js` while preserving steer chips, offline notices, focus mode, script order, and PWA cache alignment.
- [x] Move the Today Brief orchestration into `src/client/today-brief-controller.ts` while preserving cached day-read hydration, focus-mode refreshes, steer-chip actions, reshape/reconnect behavior, script order, and PWA cache alignment.
- [x] Move the Today adapted-progression refresh controller out of `03-today.js` while preserving per-lift refresh, banner count, adjustment digest refresh, script order, and PWA cache alignment.
- [x] Move the Today add/off-plan exercise controller out of `03-today.js` while preserving datalist hydration, skipped-card restoration, typed-card protection, last-set prefill, pending off-plan state, script order, and PWA cache alignment.
- [x] Move the Today session-suggestion renderer and lifecycle controller out of `03-today.js` while preserving runOp/reconnect/log-these behavior, script order, and PWA cache alignment.
- [x] Move the Today session-status renderer out of `03-today.js` while preserving set-chip, tonnage, completion, feedback, skip/undo, script order, and PWA cache alignment.
- [x] Move the Today session/logging controller out of `03-today.js` while preserving set logging, delete wiring, skip/undo, off-plan removal, feedback save/edit, finish/reopen, rest start, progression invalidation, script order, and PWA cache alignment.
- [x] Move the Today exercise/cardio card renderer out of `03-today.js` while preserving logging selectors, timed mode, synced cardio, cardio matching, script order, and PWA cache alignment.
- [x] Move the Today program-adjustment rail renderer out of `03-today.js` while preserving expansion selectors, chat prefill requests, plan navigation, script order, and PWA cache alignment.
- [x] Move the Today Garmin/Lately render helpers and shared cardio-sync execution out of `03-today.js` while preserving recent-training loading, expansion selectors, HR-zone colors, Progress/Plan sync buttons, script order, and PWA cache alignment.
- [x] Move the Today side loaders into `src/client/today-side-loaders.ts` while preserving Garmin wearable strip, meal-plan table hint, context banner, draft proposal prompt, Health focus routing, script order, and PWA cache alignment.
- [x] Move the Today post-render DOM wiring into `src/client/today-post-render-wiring.ts` while preserving quick log, planned-cardio prefill, cardio sync, progression apply, Brief upgrade/provenance, rail dispatch, focus controls, date controls, script order, and PWA cache alignment.
- [x] Finish the served Today screen migration by creating strict TypeScript source for `public/js/03-today.js` while preserving agenda/session/proposal/cardio/quick-log wiring, route behavior, script order, and PWA cache alignment.
- [x] Move the Progress Program lift/volume/mesocycle/adaptation summary renderers out of `05-progress.js` while preserving output filename order and calm wording.
- [x] Move the Progress program-block card/controls out of `05-progress.js` while preserving Program routing, script order, and PWA cache alignment.
- [x] Move Progress Program orchestration into `src/client/progress-program-controller.ts` while preserving Program route state, block loading/actions, progression proposal actions, adjustment refreshes, script order, and PWA cache alignment.
- [x] Move the Progress Energy card and nutrition check-in result renderers out of `05-progress.js`, then move the reusable Energy DOM/runOp/reconnect surface into `src/client/progress-energy-surface-client.ts` while preserving SWR loading, count-up, Plan navigation, script order, and PWA cache alignment.
- [x] Move the served Progress screen (`05-progress.js`) to `src/client/progress-screen.ts` while preserving the stable public filename, segment routing, SWR keys, background-job reconnectors, Program actions, script order, and PWA cache alignment.
- [x] Move the Plan editor day/card/item HTML and blank item defaults into `src/client/plan-editor-client.ts` while preserving edit/save behavior, selectors, script order, and PWA cache alignment.
- [x] Move Plan editor form reads and save-payload assembly into `src/client/plan-editor-form-client.ts` while preserving Plan routes, public script order, and PWA cache alignment.
- [x] Move the Coach proposal list/card HTML into `src/client/proposal-client.ts` while preserving apply/discard wiring, just-applied clamp notes, settled-history folding, script order, and PWA cache alignment.
- [x] Move the Meal Plan row/day/history HTML and slot derivation into `src/client/meal-plan-client.ts` while preserving log/swap/reorder selectors, accept/discard selectors, history folding, script order, and PWA cache alignment.
- [x] Move the Meal Plan planner shell, preference card, current-plan selection, context derivation, and shopping chips into `src/client/meal-plan-client.ts` while preserving save-bar wiring, keep/discard selectors, draft actions, shopping persistence selectors, route behavior, and PWA cache alignment.
- [x] Split the Meal Plan planner controller into `src/client/meal-planner-jobs-client.ts`, `src/client/meal-planner-actions-controller.ts`, and the thin `src/client/meal-planner-controller.ts` facade while preserving draft generation, preference persistence, shopping-list actions, save-bar flow, reconnect globals, route behavior, and PWA cache alignment.
- [x] Move Meal Swap orchestration into `src/client/meal-swap-controller.ts` while preserving swap runOp/reconnect, accept/discard behavior, meal-plan cache invalidation, script order, and PWA cache alignment.
- [x] Move the Meal recipe CTA/result/loading HTML into `src/client/meal-recipe-client.ts` while preserving the bottom-sheet recipe surface contract, script order, and PWA cache alignment.
- [x] Move the Meal recipe bottom-sheet lifecycle and recipe job controller into `src/client/meal-recipe-controller.ts` while preserving row opening, close/reconnect compatibility globals, SWR cache invalidation, script order, and PWA cache alignment.
- [x] Move the Exercise and Food detail modal flows into `src/client/exercise-detail-controller.ts` and `src/client/food-detail-controller.ts` while preserving guide clicks, explanation hydration, mode/delete actions, food art, food removal, legacy globals, script order, and PWA cache alignment.
- [x] Move the Me Profile form controller into `src/client/me-profile-controller.ts`, with form rendering/normalization split into `src/client/me-profile-form-client.ts`, while preserving Profile fetch/render/save, goal mode, discipline, endurance goal, race-date guard, save-bar dirty state, route integration, script order, and PWA cache alignment.
- [x] Move the served Coach/Meals/Food screen (`06-coach-meals.js`) to `src/client/coach-meals-screen.ts` while preserving Coach proposal drafts, meal-plan draft/accept/discard, Plan Meals preferences/log/swap/reorder/recipe, Plan Food day-fuel edit/delete, durable job reconnectors, script order, and PWA cache alignment.
- [x] Move the remaining served Chat screen surface in `09-plan-chat.js` to TypeScript source while preserving Chat send/paste/message rendering, mobile input handling, session-history links, job reconnectors, script order, and PWA cache alignment; image compression, preview payloads, and native file-picker settling now live in `src/client/chat-attachment-client.ts`.
- [x] Move Chat message rendering into `src/client/chat-message-client.ts` while preserving day dividers, bubble grouping, copy controls, image rendering, proposal apply controls, read-only history rendering, script order, and PWA cache alignment.
- [x] Move Chat composer focus recovery into `src/client/chat-composer-focus-client.ts` while preserving native image-picker return behavior, keyboard geometry separation, send-button focus handling, script order, and PWA cache alignment.
- [x] Move Chat composer wiring into `src/client/chat-composer-controller.ts` while preserving attachment preview, paste/change image attach, draft restore, send enqueue/optimistic bubble, mobile focus recovery, script order, and PWA cache alignment.
- [x] Harden mobile Chat native image-picker return so attachment reset only drops stale focus, the viewport guard owns keyboard classes, post-picker taps do not publish keyboard-open layout until real geometry opens, and the composer can accept a typed comment after attaching a photo.
- [x] Move Progress Endurance pace, zone, and sport-best render helpers into `src/client/progress-endurance-client.ts` while preserving the existing output file.
- [x] Move Progress Endurance route orchestration into `src/client/progress-endurance-controller.ts` while preserving `/app/progress/endurance`, `renderEndurance`, stale-token guards, Garmin sync rerendering, script order, and PWA cache alignment.
- [x] Move the Progress History session-card renderer and edit-field number coercion into `src/client/progress-history-client.ts` while preserving meals' `numOrNull` compatibility.
- [x] Move the Progress interactive line chart renderer into `src/client/progress-chart-client.ts` while preserving canvas scrub behavior.
- [x] Move the Health picture/review renderer into `src/client/health-picture-client.ts` while preserving Health Read state, build-review CTAs, script order, and PWA cache alignment.
- [x] Move the Health marker chart/row renderer into `src/client/health-markers-client.ts` while preserving marker expansion, scrub interaction, script order, and PWA cache alignment.
- [x] Move Health marker orchestration into `src/client/health-markers-controller.ts` while preserving marker loading, selected-marker route state, chart refreshes, share/report handoff, script order, and PWA cache alignment.
- [x] Move the Health connected-brain directive renderer and loader into `src/client/health-directives-client.ts` / `src/client/health-directives-loader-client.ts` while preserving evidence affordances, research nudges, direct Health Read routes, script order, and PWA cache alignment.
- [x] Move the Health Read recovery and priority-marker rails into `src/client/health-read-client.ts` while preserving recovery phrasing, no-score marker wording, Markers-tab navigation, script order, and PWA cache alignment.
- [x] Move Health Read orchestration into `src/client/health-read-controller.ts` while preserving synthesis refresh, symptom links, supplements, recovery, priority markers, pending Health scroll behavior, script order, and PWA cache alignment.
- [x] Move the Health Records upload shell and document-list composition into `src/client/health-records-client.ts` while preserving upload IDs, document-card composition, script order, and PWA cache alignment.
- [x] Move the Health Records document lifecycle into `src/client/me-records-health-doc-controller.ts` while preserving upload, date correction, re-analysis, polling, deletion, marker refreshes, Health Picture cache updates, deep-link scroll behavior, script order, and PWA cache alignment.
- [x] Move Health document upload intake into `src/client/health-doc-upload-controller.ts` while preserving file/text upload, payload validation, oversized-text guardrails, Health Picture cache refresh, script order, and PWA cache alignment.
- [x] Move the Health Standing renderer into `src/client/health-standing-client.ts` while preserving age-band comparison, BP/body-composition cards, DEXA slot, script order, and PWA cache alignment.
- [x] Move Health Standing orchestration into `src/client/health-standing-controller.ts` while preserving Standing load/error states, BP sheet wiring, body-composition card refresh, script order, and PWA cache alignment.
- [x] Move the Health Learned timeline HTML grouping into `src/client/health-learned-client.ts` while preserving Records routing, script order, and PWA cache alignment.
- [x] Move the served Me Health screen (`07-me-health.js`) to `src/client/me-health-screen.ts` while preserving Profile save, Memory, Health Read/Markers/Standing routing, health synthesis jobs, BP sheet, supplements, Health Picture controller coordination, script order, and PWA cache alignment.
- [x] Move Me Memory loading/editing into `src/client/me-memory-controller.ts` while preserving memory rows, edit/delete controls, kind filters, routing, script order, and PWA cache alignment.
- [x] Move the Me Life timeline render helpers into `src/client/life-client.ts` while preserving Life add/edit/delete behavior.
- [x] Move the Me Family card/swatch helpers into `src/client/family-client.ts` while preserving Family add/edit/delete behavior.
- [x] Move the served Me records/life/family screen (`08-me-records.js`) to `src/client/me-records-screen.ts` while preserving Health Markers/Records/Share/Learned bridges, evidence toggles, delegated health-doc lifecycle wiring, Life timeline wiring, Family roster wiring, script order, and PWA cache alignment.

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
- [x] Move Chat REST and MCP adapters off the `repo.js` compatibility barrel and onto `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Agent Job REST/background helpers off the `repo.js` compatibility barrel and onto `src/domain/person/index.ts`, guarded by `test/domainGrouping.test.js`.
- [x] Move Export REST routes off the `repo.js` compatibility barrel and onto health/training domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Add `src/domain/operator/index.ts` and move Operator/Art REST and MCP adapters off the `repo.js` compatibility barrel, guarded by `test/domainGrouping.test.js`.
- [x] Move Today/Daily Driver REST and MCP adapters off the `repo.js` compatibility barrel and onto brain/health/person domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Move Connected Brain REST and MCP adapters off the `repo.js` compatibility barrel and onto brain/health/person domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Move Program REST and MCP adapters off the `repo.js` compatibility barrel and onto training/brain/health domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Move Day Coach REST and MCP adapters off the `repo.js` compatibility barrel and onto brain/person domain entry points, guarded by `test/domainGrouping.test.js`.
- [x] Replace broad `import * as repo from "../repo.js"` in route modules with domain imports where ownership is clear.
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
- [x] Add a typed `ChatAction` union and trust-boundary normalizer so parsed model actions and direct `applyChatActions` calls reject malformed write actions before repo calls; keep prompt action names and executor switch cases aligned by engineering contract.
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
- `src/contracts/*` covers every PWA API call, keeps unknown and broad exact-response waiver lists empty unless a new temporary waiver is explicitly owned, and avoids exact route responses typed as `ClientJsonObject` / `ClientJsonArray`.
- The component system owns repeated UI primitives with escaping and accessibility tests.
- `/app/*` deep links, root `/`, API, MCP, reports, exports, uploads, and service-worker navigation fallback are preserved.
- `npm run verify`, `npm run smoke`, and browser route smoke pass.
- No new runtime dependencies or frontend framework were added.
- The agentic brain keeps one sequenced focus, bounded memory, clear provenance, and suggestion-only behavior.
