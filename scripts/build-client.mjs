#!/usr/bin/env node
// Compile dependency-free browser client slices from src/client into stable
// public/js filenames. This is intentionally explicit during migration: no
// bundler, no runtime deps, and no surprise asset names for the service worker.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import ts from "typescript";
import { buildStyles } from "./build-styles.mjs";
import { writeLazyRouteTable } from "./lazy-route-preload.mjs";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");

export const CLIENT_OUTPUTS = [
  { source: "src/client/date-utils.ts", output: "public/js/date-utils.js" },
  { source: "src/client/html-utils.ts", output: "public/js/html-utils.js" },
  { source: "src/client/markdown-client.ts", output: "public/js/markdown-client.js" },
  { source: "src/client/ui-components.ts", output: "public/js/ui-components.js" },
  { source: "src/client/ui-reads.ts", output: "public/js/ui-reads.js" },
  { source: "src/client/ui-stone-model.ts", output: "public/js/ui-stone-model.js" },
  { source: "src/client/ui-stone.ts", output: "public/js/ui-stone.js" },
  { source: "src/client/ui-feedback-client.ts", output: "public/js/ui-feedback-client.js" },
  { source: "src/client/ui-actions-client.ts", output: "public/js/ui-actions-client.js" },
  { source: "src/client/ui-sheet.ts", output: "public/js/ui-sheet.js" },
  { source: "src/client/ui-chart.ts", output: "public/js/ui-chart.js" },
  { source: "src/client/decision-undo-client.ts", output: "public/js/decision-undo-client.js" },
  { source: "src/client/decision-undo-controller.ts", output: "public/js/decision-undo-controller.js" },
  { source: "src/client/ui-view-transitions-client.ts", output: "public/js/ui-view-transitions-client.js" },
  { source: "src/client/exercise-detail-client.ts", output: "public/js/exercise-detail-client.js" },
  { source: "src/client/format-utils.ts", output: "public/js/format-utils.js" },
  { source: "src/client/ui-format.ts", output: "public/js/ui-format.js" },
  { source: "src/client/client-diagnostics.ts", output: "public/js/client-diagnostics.js" },
  { source: "src/client/token-sheet.ts", output: "public/js/token-sheet.js" },
  { source: "src/client/api-cache.ts", output: "public/js/api-cache.js" },
  { source: "src/client/api-reach.ts", output: "public/js/api-reach.js" },
  { source: "src/client/api-auth.ts", output: "public/js/api-auth.js" },
  { source: "src/client/api-core.ts", output: "public/js/api-core.js" },
  { source: "src/client/api-signals.ts", output: "public/js/api-signals.js" },
  { source: "src/client/outbox-queue.ts", output: "public/js/outbox-queue.js" },
  { source: "src/client/outbox-runtime.ts", output: "public/js/outbox-runtime.js" },
  { source: "src/client/outbox-replay.ts", output: "public/js/outbox-replay.js" },
  { source: "src/client/outbox-session.ts", output: "public/js/outbox-session.js" },
  { source: "src/client/outbox.ts", output: "public/js/outbox.js" },
  { source: "src/client/outbox-ui.ts", output: "public/js/outbox-ui.js" },
  { source: "src/client/offline-state-client.ts", output: "public/js/offline-state-client.js" },
  { source: "src/client/app/download.ts", output: "public/js/app-download.js" },
  { source: "src/client/app/update-gate.ts", output: "public/js/app-update-gate.js" },
  { source: "src/client/app/sw-recovery.ts", output: "public/js/app-sw-recovery.js" },
  { source: "src/client/app/state.ts", output: "public/js/01-core.js" },
  { source: "src/client/cairn-body-figure.ts", output: "public/cairn-body-figure.js" },
  { source: "src/client/art-memory-client.ts", output: "public/js/art-memory-client.js" },
  { source: "src/client/art-inflight-client.ts", output: "public/js/art-inflight-client.js" },
  { source: "src/client/art-controller.ts", output: "public/js/art-controller.js" },
  { source: "src/client/ui-header-client.ts", output: "public/js/ui-header-client.js" },
  { source: "src/client/train-nav-client.ts", output: "public/js/train-nav-client.js" },
  { source: "src/client/ui-segments-client.ts", output: "public/js/ui-segments-client.js" },
  { source: "src/client/ui-shell.ts", output: "public/js/02-ui.js" },
  { source: "src/client/detail-overlay-client.ts", output: "public/js/detail-overlay-client.js" },
  { source: "src/client/ui-motion-client.ts", output: "public/js/ui-motion-client.js" },
  { source: "src/client/exercise-detail-data-client.ts", output: "public/js/exercise-detail-data-client.js" },
  { source: "src/client/exercise-detail-explanation-client.ts", output: "public/js/exercise-detail-explanation-client.js" },
  { source: "src/client/exercise-guide-client.ts", output: "public/js/exercise-guide-client.js" },
  { source: "src/client/exercise-detail-render-client.ts", output: "public/js/exercise-detail-render-client.js" },
  { source: "src/client/exercise-detail-actions-client.ts", output: "public/js/exercise-detail-actions-client.js" },
  { source: "src/client/exercise-detail-controller.ts", output: "public/js/exercise-detail-controller.js" },
  { source: "src/client/agent-login-model-client.ts", output: "public/js/agent-login-model-client.js" },
  { source: "src/client/agent-login-assets-client.ts", output: "public/js/agent-login-assets-client.js" },
  { source: "src/client/agent-login-modal-client.ts", output: "public/js/agent-login-modal-client.js" },
  { source: "src/client/agent-login-session-client.ts", output: "public/js/agent-login-session-client.js" },
  { source: "src/client/agent-login-panel-client.ts", output: "public/js/agent-login-panel-client.js" },
  { source: "src/client/agent-login-client.ts", output: "public/js/agent-login-client.js" },
  { source: "src/client/welcome-model.ts", output: "public/js/welcome-model.js" },
  { source: "src/client/welcome-client.ts", output: "public/js/welcome-client.js" },
  { source: "src/client/welcome-connect-controller.ts", output: "public/js/welcome-connect-controller.js" },
  { source: "src/client/welcome-meet-controller.ts", output: "public/js/welcome-meet-controller.js" },
  { source: "src/client/welcome-screen.ts", output: "public/js/welcome-screen.js" },
  { source: "src/client/agent-job-records-client.ts", output: "public/js/agent-job-records-client.js" },
  { source: "src/client/agent-job-client.ts", output: "public/js/agent-job-client.js" },
  { source: "src/client/pwa-install-coach.ts", output: "public/js/pwa-install-coach.js" },
  { source: "src/client/rest-timer.ts", output: "public/js/rest-timer.js" },
  { source: "src/client/coaching-focus-render-client.ts", output: "public/js/coaching-focus-render-client.js" },
  { source: "src/client/coaching-focus-client.ts", output: "public/js/coaching-focus-client.js" },
  { source: "src/client/today-activity-client.ts", output: "public/js/today-activity-client.js" },
  { source: "src/client/save-bar.ts", output: "public/js/save-bar.js" },
  { source: "src/client/swr-cache.ts", output: "public/js/swr-cache.js" },
  { source: "src/client/write-invalidation-client.ts", output: "public/js/write-invalidation-client.js" },
  { source: "src/client/today-agenda-client.ts", output: "public/js/today-agenda-client.js" },
  { source: "src/client/today-rail-loaders-client.ts", output: "public/js/today-rail-loaders-client.js" },
  { source: "src/client/changes-line-client.ts", output: "public/js/changes-line-client.js" },
  { source: "src/client/changes-line-controller.ts", output: "public/js/changes-line-controller.js" },
  { source: "src/client/today-fuel-glance-client.ts", output: "public/js/today-fuel-glance-client.js" },
  { source: "src/client/today-worth-client.ts", output: "public/js/today-worth-client.js" },
  { source: "src/client/day-open-client.ts", output: "public/js/day-open-client.js" },
  { source: "src/client/coach-link-client.ts", output: "public/js/coach-link-client.js" },
  { source: "src/client/day-detail-model.ts", output: "public/js/day-detail-model.js" },
  { source: "src/client/day-glance-model.ts", output: "public/js/day-glance-model.js" },
  { source: "src/client/day-detail-run-client.ts", output: "public/js/day-detail-run-client.js" },
  { source: "src/client/day-detail-client.ts", output: "public/js/day-detail-client.js" },
  { source: "src/client/day-glance-view.ts", output: "public/js/day-glance-view.js" },
  { source: "src/client/day-detail-controller.ts", output: "public/js/day-detail-controller.js" },
  { source: "src/client/day-record-client.ts", output: "public/js/day-record-client.js" },
  { source: "src/client/drill-controller.ts", output: "public/js/drill-controller.js" },
  { source: "src/client/milestone-row-model.ts", output: "public/js/milestone-row-model.js" },
  { source: "src/client/milestone-row-client.ts", output: "public/js/milestone-row-client.js" },
  { source: "src/client/goal-row-model.ts", output: "public/js/goal-row-model.js" },
  { source: "src/client/goal-row-client.ts", output: "public/js/goal-row-client.js" },
  { source: "src/client/frame-line-client.ts", output: "public/js/frame-line-client.js" },
  { source: "src/client/week-model.ts", output: "public/js/week-model.js" },
  { source: "src/client/week-strip-client.ts", output: "public/js/week-strip-client.js" },
  { source: "src/client/today-rail-controller.ts", output: "public/js/today-rail-controller.js" },
  { source: "src/client/today-plan-selection-client.ts", output: "public/js/today-plan-selection-client.js" },
  { source: "src/client/today-training-client.ts", output: "public/js/today-training-client.js" },
  { source: "src/client/today-progression-controller.ts", output: "public/js/today-progression-controller.js" },
  { source: "src/client/today-add-exercise-controller.ts", output: "public/js/today-add-exercise-controller.js" },
  { source: "src/client/today-brief-voice-client.ts", output: "public/js/today-brief-voice-client.js" },
  { source: "src/client/today-brief-run-leg-client.ts", output: "public/js/today-brief-run-leg-client.js" },
  { source: "src/client/today-brief-client.ts", output: "public/js/today-brief-client.js" },
  { source: "src/client/today-brief-signals-client.ts", output: "public/js/today-brief-signals-client.js" },
  { source: "src/client/today-brief-override-client.ts", output: "public/js/today-brief-override-client.js" },
  { source: "src/client/today-brief-actions-client.ts", output: "public/js/today-brief-actions-client.js" },
  { source: "src/client/today-brief-cache-client.ts", output: "public/js/today-brief-cache-client.js" },
  { source: "src/client/today-brief-controller.ts", output: "public/js/today-brief-controller.js" },
  { source: "src/client/cardio-plan-client.ts", output: "public/js/cardio-plan-client.js" },
  { source: "src/client/cardio-sync-client.ts", output: "public/js/cardio-sync-client.js" },
  { source: "src/client/today-lately-client.ts", output: "public/js/today-lately-client.js" },
  { source: "src/client/proposal-client.ts", output: "public/js/proposal-client.js" },
  { source: "src/client/today-session-suggest-client.ts", output: "public/js/today-session-suggest-client.js" },
  { source: "src/client/today-session-suggest-controller.ts", output: "public/js/today-session-suggest-controller.js" },
  { source: "src/client/today-session-ask-sheet.ts", output: "public/js/today-session-ask-sheet.js" },
  { source: "src/client/today-session-status-client.ts", output: "public/js/today-session-status-client.js" },
  { source: "src/client/today-session-feedback-client.ts", output: "public/js/today-session-feedback-client.js" },
  { source: "src/client/session-primer-client.ts", output: "public/js/session-primer-client.js" },
  { source: "src/client/today-session-skip-client.ts", output: "public/js/today-session-skip-client.js" },
  { source: "src/client/today-session-set-model.ts", output: "public/js/today-session-set-model.js" },
  { source: "src/client/today-session-set-actions.ts", output: "public/js/today-session-set-actions.js" },
  { source: "src/client/today-session-controller.ts", output: "public/js/today-session-controller.js" },
  { source: "src/client/today-session-launch-client.ts", output: "public/js/today-session-launch-client.js" },
  { source: "src/client/today-cards-client.ts", output: "public/js/today-cards-client.js" },
  { source: "src/client/today-program-adjustments-client.ts", output: "public/js/today-program-adjustments-client.js" },
  { source: "src/client/today-week-ahead-client.ts", output: "public/js/today-week-ahead-client.js" },
  { source: "src/client/today-context-client.ts", output: "public/js/today-context-client.js" },
  { source: "src/client/today-compass-client.ts", output: "public/js/today-compass-client.js" },
  { source: "src/client/today-garmin-reconciliation-client.ts", output: "public/js/today-garmin-reconciliation-client.js" },
  { source: "src/client/today-side-loaders.ts", output: "public/js/today-side-loaders.js" },
  { source: "src/client/today-plan-session-model.ts", output: "public/js/today-plan-session-model.js" },
  { source: "src/client/today-plan-session-data-client.ts", output: "public/js/today-plan-session-data-client.js" },
  { source: "src/client/today-plan-session-preparation.ts", output: "public/js/today-plan-session-preparation.js" },
  { source: "src/client/today-data-loader.ts", output: "public/js/today-data-loader.js" },
  { source: "src/client/today-slot-hold.ts", output: "public/js/today-slot-hold.js" },
  { source: "src/client/today-prefetch.ts", output: "public/js/today-prefetch.js" },
  { source: "src/client/today-main-shell-client.ts", output: "public/js/today-main-shell-client.js" },
  { source: "src/client/today-plan-surface-client.ts", output: "public/js/today-plan-surface-client.js" },
  { source: "src/client/today-plan-surface-renderer.ts", output: "public/js/today-plan-surface-renderer.js" },
  { source: "src/client/today-render-state-client.ts", output: "public/js/today-render-state-client.js" },
  { source: "src/client/today-post-render-wiring.ts", output: "public/js/today-post-render-wiring.js" },
  { source: "src/client/today-dependencies.ts", output: "public/js/today-dependencies.js" },
  { source: "src/client/today-compatibility-bridges.ts", output: "public/js/today-compatibility-bridges.js" },
  { source: "src/client/today-screen-runtime-deps.ts", output: "public/js/today-screen-runtime-deps.js" },
  { source: "src/client/today-screen-runtime.ts", output: "public/js/today-screen-runtime.js" },
  { source: "src/client/session-snapshot-client.ts", output: "public/js/session-snapshot-client.js" },
  { source: "src/client/today-path-client.ts", output: "public/js/today-path-client.js" },
  { source: "src/client/today-path-controller.ts", output: "public/js/today-path-controller.js" },
  { source: "src/client/today-ahead-mount.ts", output: "public/js/today-ahead-mount.js" },
  { source: "src/client/today-digest-client.ts", output: "public/js/today-digest-client.js" },
  { source: "src/client/today-week-client.ts", output: "public/js/today-week-client.js" },
  { source: "src/client/today-horizon-client.ts", output: "public/js/today-horizon-client.js" },
  { source: "src/client/today-ahead-controller.ts", output: "public/js/today-ahead-controller.js" },
  { source: "src/client/today-strip-client.ts", output: "public/js/today-strip-client.js" },
  { source: "src/client/today-strip-controller.ts", output: "public/js/today-strip-controller.js" },
  { source: "src/client/today-push-client.ts", output: "public/js/today-push-client.js" },
  { source: "src/client/today-push-controller.ts", output: "public/js/today-push-controller.js" },
  { source: "src/client/today-screen.ts", output: "public/js/03-today.js" },
  { source: "src/client/progress-data-client.ts", output: "public/js/progress-data-client.js" },
  { source: "src/client/endurance-format-client.ts", output: "public/js/endurance-format-client.js" },
  { source: "src/client/progress-endurance-client.ts", output: "public/js/progress-endurance-client.js" },
  { source: "src/client/progress-components-client.ts", output: "public/js/progress-components-client.js" },
  { source: "src/client/progress-line-chart-model.ts", output: "public/js/progress-line-chart-model.js" },
  { source: "src/client/progress-chart-scrub-client.ts", output: "public/js/progress-chart-scrub-client.js" },
  { source: "src/client/progress-chart-drawing-client.ts", output: "public/js/progress-chart-drawing-client.js" },
  { source: "src/client/progress-chart-client.ts", output: "public/js/progress-chart-client.js" },
  { source: "src/client/progress-trend-weight-client.ts", output: "public/js/progress-trend-weight-client.js" },
  { source: "src/client/progress-history-model-client.ts", output: "public/js/progress-history-model-client.js" },
  { source: "src/client/progress-history-render-client.ts", output: "public/js/progress-history-render-client.js" },
  { source: "src/client/progress-history-client.ts", output: "public/js/progress-history-client.js" },
  { source: "src/client/progress-run-plan-client.ts", output: "public/js/progress-run-plan-client.js" },
  { source: "src/client/progress-route-deps-client.ts", output: "public/js/progress-route-deps-client.js" },
  { source: "src/client/train-fan-in-client.ts", output: "public/js/train-fan-in-client.js" },
  { source: "src/client/progress-endurance-controller.ts", output: "public/js/progress-endurance-controller.js" },
  { source: "src/client/progress-volume-client.ts", output: "public/js/progress-volume-client.js" },
  { source: "src/client/progress-energy-client.ts", output: "public/js/progress-energy-client.js" },
  { source: "src/client/progress-energy-surface-client.ts", output: "public/js/progress-energy-surface-client.js" },
  { source: "src/client/progress-intake-client.ts", output: "public/js/progress-intake-client.js" },
  { source: "src/client/progress-calendar-client.ts", output: "public/js/progress-calendar-client.js" },
  { source: "src/client/progress-muscle-trajectory-client.ts", output: "public/js/progress-muscle-trajectory-client.js" },
  { source: "src/client/progress-dexa-targeting-client.ts", output: "public/js/progress-dexa-targeting-client.js" },
  { source: "src/client/progress-performance-client.ts", output: "public/js/progress-performance-client.js" },
  { source: "src/client/progress-program-adjustments-client.ts", output: "public/js/progress-program-adjustments-client.js" },
  { source: "src/client/progress-test-week-client.ts", output: "public/js/progress-test-week-client.js" },
  { source: "src/client/progress-program-summary-client.ts", output: "public/js/progress-program-summary-client.js" },
  { source: "src/client/progress-program-block-client.ts", output: "public/js/progress-program-block-client.js" },
  { source: "src/client/program-week-model.ts", output: "public/js/program-week-model.js" },
  { source: "src/client/program-week-client.ts", output: "public/js/program-week-client.js" },
  { source: "src/client/program-week-controller.ts", output: "public/js/program-week-controller.js" },
  { source: "src/client/progress-exercise-suggestions-client.ts", output: "public/js/progress-exercise-suggestions-client.js" },
  { source: "src/client/progress-program-controller.ts", output: "public/js/progress-program-controller.js" },
  { source: "src/client/journey-progress-client.ts", output: "public/js/journey-progress-client.js" },
  { source: "src/client/journey-timeline-client.ts", output: "public/js/journey-timeline-client.js" },
  { source: "src/client/progress-overview-snapshot-client.ts", output: "public/js/progress-overview-snapshot-client.js" },
  { source: "src/client/train-focus-card-client.ts", output: "public/js/train-focus-card-client.js" },
  { source: "src/client/progress-overview-client.ts", output: "public/js/progress-overview-client.js" },
  // v2 wave 5 slots (stream A pre-registered them; B fills You, the stack, the stone detail).
  { source: "src/client/cairn-stack-model.ts", output: "public/js/cairn-stack-model.js" },
  { source: "src/client/cairn-stack-client.ts", output: "public/js/cairn-stack-client.js" },
  { source: "src/client/cairn-stack-controller.ts", output: "public/js/cairn-stack-controller.js" },
  { source: "src/client/stone-detail-model.ts", output: "public/js/stone-detail-model.js" },
  { source: "src/client/stone-detail-client.ts", output: "public/js/stone-detail-client.js" },
  { source: "src/client/stone-detail-controller.ts", output: "public/js/stone-detail-controller.js" },
  { source: "src/client/you-screen.ts", output: "public/js/you-screen.js" },
  { source: "src/client/body-metrics-client.ts", output: "public/js/body-metrics-client.js" },
  { source: "src/client/health-fan-in-client.ts", output: "public/js/health-fan-in-client.js" },
  { source: "src/client/stand-screen.ts", output: "public/js/stand-screen.js" },
  { source: "src/client/progress-volume-route-client.ts", output: "public/js/progress-volume-route-client.js" },
  { source: "src/client/progress-screen.ts", output: "public/js/05-progress.js" },
  { source: "src/client/capture-provenance-client.ts", output: "public/js/capture-provenance-client.js" },
  { source: "src/client/capture-read-date-client.ts", output: "public/js/capture-read-date-client.js" },
  { source: "src/client/capture-read-cards-client.ts", output: "public/js/capture-read-cards-client.js" },
  { source: "src/client/capture-read-jobs-client.ts", output: "public/js/capture-read-jobs-client.js" },
  { source: "src/client/capture-reads-client.ts", output: "public/js/capture-reads-client.js" },
  { source: "src/client/capture-voice-client.ts", output: "public/js/capture-voice-client.js" },
  { source: "src/client/capture-checkin-client.ts", output: "public/js/capture-checkin-client.js" },
  { source: "src/client/capture.ts", output: "public/js/04-capture.js" },
  { source: "src/client/settings-routes.ts", output: "public/js/settings-routes.js" },
  { source: "src/client/settings-client.ts", output: "public/js/settings-client.js" },
  { source: "src/client/settings-surface-model.ts", output: "public/js/settings-surface-model.js" },
  { source: "src/client/settings-surface-client.ts", output: "public/js/settings-surface-client.js" },
  { source: "src/client/settings-drive-client.ts", output: "public/js/settings-drive-client.js" },
  { source: "src/client/settings-drive-controller.ts", output: "public/js/settings-drive-controller.js" },
  { source: "src/client/settings-data-client.ts", output: "public/js/settings-data-client.js" },
  { source: "src/client/settings-update-client.ts", output: "public/js/settings-update-client.js" },
  { source: "src/client/settings-pairing-view.ts", output: "public/js/settings-pairing-view.js" },
  { source: "src/client/settings-pairing-client.ts", output: "public/js/settings-pairing-client.js" },
  { source: "src/client/settings-mcp-client.ts", output: "public/js/settings-mcp-client.js" },
  { source: "src/client/auth-passkey-client.ts", output: "public/js/auth-passkey-client.js" },
  { source: "src/client/auth-signin-client.ts", output: "public/js/auth-signin-client.js" },
  { source: "src/client/settings-feedback-client.ts", output: "public/js/settings-feedback-client.js" },
  { source: "src/client/settings-data-controller.ts", output: "public/js/settings-data-controller.js" },
  { source: "src/client/settings-agents-client.ts", output: "public/js/settings-agents-client.js" },
  { source: "src/client/settings-agents-controller.ts", output: "public/js/settings-agents-controller.js" },
  { source: "src/client/settings-sources-automation-controller.ts", output: "public/js/settings-sources-automation-controller.js" },
  { source: "src/client/settings-screen.ts", output: "public/js/settings-screen.js" },
  { source: "src/client/capture-macros-client.ts", output: "public/js/capture-macros-client.js" },
  { source: "src/client/chat-client.ts", output: "public/js/chat-client.js" },
  { source: "src/client/chat-attachment-client.ts", output: "public/js/chat-attachment-client.js" },
  { source: "src/client/chat-composer-focus-client.ts", output: "public/js/chat-composer-focus-client.js" },
  { source: "src/client/food-composer-model.ts", output: "public/js/food-composer-model.js" },
  { source: "src/client/food-composer-client.ts", output: "public/js/food-composer-client.js" },
  { source: "src/client/food-composer-chips-controller.ts", output: "public/js/food-composer-chips-controller.js" },
  { source: "src/client/food-composer-turn-controller.ts", output: "public/js/food-composer-turn-controller.js" },
  { source: "src/client/food-composer-controller.ts", output: "public/js/food-composer-controller.js" },
  { source: "src/client/chat-composer-controller.ts", output: "public/js/chat-composer-controller.js" },
  { source: "src/client/chat-speaker-client.ts", output: "public/js/chat-speaker-client.js" },
  { source: "src/client/chat-message-client.ts", output: "public/js/chat-message-client.js" },
  { source: "src/client/chat-turn-records-client.ts", output: "public/js/chat-turn-records-client.js" },
  { source: "src/client/chat-turn-stream-state-client.ts", output: "public/js/chat-turn-stream-state-client.js" },
  { source: "src/client/chat-layout-client.ts", output: "public/js/chat-layout-client.js" },
  { source: "src/client/chat-turn-monitor-client.ts", output: "public/js/chat-turn-monitor-client.js" },
  { source: "src/client/chat-turn-client.ts", output: "public/js/chat-turn-client.js" },
  { source: "src/client/chat-history-client.ts", output: "public/js/chat-history-client.js" },
  { source: "src/client/chat-header-controller.ts", output: "public/js/chat-header-controller.js" },
  { source: "src/client/chat-starter-chips-client.ts", output: "public/js/chat-starter-chips-client.js" },
  { source: "src/client/chat-fuel-context-client.ts", output: "public/js/chat-fuel-context-client.js" },
  { source: "src/client/chat-earlier-history-client.ts", output: "public/js/chat-earlier-history-client.js" },
  { source: "src/client/plan-endurance-model.ts", output: "public/js/plan-endurance-model.js" },
  { source: "src/client/plan-week-client.ts", output: "public/js/plan-week-client.js" },
  { source: "src/client/plan-endurance-client.ts", output: "public/js/plan-endurance-client.js" },
  { source: "src/client/plan-endurance-briefing-client.ts", output: "public/js/plan-endurance-briefing-client.js" },
  { source: "src/client/race-week-model.ts", output: "public/js/race-week-model.js" },
  { source: "src/client/race-week-runs-model.ts", output: "public/js/race-week-runs-model.js" },
  { source: "src/client/race-ladder-model.ts", output: "public/js/race-ladder-model.js" },
  { source: "src/client/race-view-model.ts", output: "public/js/race-view-model.js" },
  { source: "src/client/race-estimate-client.ts", output: "public/js/race-estimate-client.js" },
  { source: "src/client/race-ladder-client.ts", output: "public/js/race-ladder-client.js" },
  { source: "src/client/race-view-client.ts", output: "public/js/race-view-client.js" },
  { source: "src/client/race-view-controller.ts", output: "public/js/race-view-controller.js" },
  // v2 wave 5 slots (stream A pre-registered them; C fills Horizon, D the ripple card).
  { source: "src/client/horizon-model.ts", output: "public/js/horizon-model.js" },
  { source: "src/client/horizon-labs-model.ts", output: "public/js/horizon-labs-model.js" },
  { source: "src/client/horizon-week-client.ts", output: "public/js/horizon-week-client.js" },
  { source: "src/client/horizon-week-controller.ts", output: "public/js/horizon-week-controller.js" },
  { source: "src/client/horizon-terrain-client.ts", output: "public/js/horizon-terrain-client.js" },
  { source: "src/client/horizon-chart-client.ts", output: "public/js/horizon-chart-client.js" },
  { source: "src/client/horizon-client.ts", output: "public/js/horizon-client.js" },
  { source: "src/client/horizon-controller.ts", output: "public/js/horizon-controller.js" },
  { source: "src/client/horizon-screen.ts", output: "public/js/horizon-screen.js" },
  { source: "src/client/ripple-card-model.ts", output: "public/js/ripple-card-model.js" },
  { source: "src/client/ripple-card-client.ts", output: "public/js/ripple-card-client.js" },
  { source: "src/client/ripple-card-controller.ts", output: "public/js/ripple-card-controller.js" },
  { source: "src/client/plan-editor-client.ts", output: "public/js/plan-editor-client.js" },
  { source: "src/client/plan-editor-form-client.ts", output: "public/js/plan-editor-form-client.js" },
  { source: "src/client/plan-head-client.ts", output: "public/js/plan-head-client.js" },
  { source: "src/client/plan-editor-controller.ts", output: "public/js/plan-editor-controller.js" },
  { source: "src/client/chat-screen.ts", output: "public/js/09-plan-chat.js" },
  { source: "src/client/meal-fuel-context-client.ts", output: "public/js/meal-fuel-context-client.js" },
  { source: "src/client/meal-row-client.ts", output: "public/js/meal-row-client.js" },
  { source: "src/client/meal-plan-upcoming-client.ts", output: "public/js/meal-plan-upcoming-client.js" },
  { source: "src/client/meal-plan-client.ts", output: "public/js/meal-plan-client.js" },
  { source: "src/client/meal-planner-jobs-client.ts", output: "public/js/meal-planner-jobs-client.js" },
  { source: "src/client/meal-recipe-client.ts", output: "public/js/meal-recipe-client.js" },
  { source: "src/client/meal-recipe-controller.ts", output: "public/js/meal-recipe-controller.js" },
  { source: "src/client/meal-swap-data-client.ts", output: "public/js/meal-swap-data-client.js" },
  { source: "src/client/meal-swap-row-actions-controller.ts", output: "public/js/meal-swap-row-actions-controller.js" },
  { source: "src/client/meal-swap-controller.ts", output: "public/js/meal-swap-controller.js" },
  { source: "src/client/meal-planner-actions-controller.ts", output: "public/js/meal-planner-actions-controller.js" },
  { source: "src/client/meal-planner-controller.ts", output: "public/js/meal-planner-controller.js" },
  { source: "src/client/meal-journal-client.ts", output: "public/js/meal-journal-client.js" },
  { source: "src/client/meal-menu-card-client.ts", output: "public/js/meal-menu-card-client.js" },
  { source: "src/client/meal-menu-card-controller.ts", output: "public/js/meal-menu-card-controller.js" },
  { source: "src/client/coach-proposal-controller.ts", output: "public/js/coach-proposal-controller.js" },
  { source: "src/client/coach-meals-screen.ts", output: "public/js/06-coach-meals.js" },
  { source: "src/client/coach-changes-screen.ts", output: "public/js/coach-changes-screen.js" },
  { source: "src/client/food-note-client.ts", output: "public/js/food-note-client.js" },
  { source: "src/client/meal-card-model.ts", output: "public/js/meal-card-model.js" },
  { source: "src/client/meal-card-client.ts", output: "public/js/meal-card-client.js" },
  { source: "src/client/meal-card-controller.ts", output: "public/js/meal-card-controller.js" },
  { source: "src/client/food-detail-controller.ts", output: "public/js/food-detail-controller.js" },
  { source: "src/client/me-profile-form-client.ts", output: "public/js/me-profile-form-client.js" },
  { source: "src/client/me-profile-controller.ts", output: "public/js/me-profile-controller.js" },
  { source: "src/client/me-health-log-renderer.ts", output: "public/js/me-health-log-renderer.js" },
  { source: "src/client/me-health-tabs-controller.ts", output: "public/js/me-health-tabs-controller.js" },
  { source: "src/client/me-health-controller-deps.ts", output: "public/js/me-health-controller-deps.js" },
  { source: "src/client/me-health-dependencies.ts", output: "public/js/me-health-dependencies.js" },
  { source: "src/client/health-evidence-client.ts", output: "public/js/health-evidence-client.js" },
  { source: "src/client/health-marker-order-client.ts", output: "public/js/health-marker-order-client.js" },
  { source: "src/client/health-client.ts", output: "public/js/health-client.js" },
  { source: "src/client/health-read-client.ts", output: "public/js/health-read-client.js" },
  { source: "src/client/health-standing-primitives-client.ts", output: "public/js/health-standing-primitives-client.js" },
  { source: "src/client/health-standing-client.ts", output: "public/js/health-standing-client.js" },
  { source: "src/client/health-standing-controller.ts", output: "public/js/health-standing-controller.js" },
  { source: "src/client/health-risk-client.ts", output: "public/js/health-risk-client.js" },
  { source: "src/client/health-risk-controller.ts", output: "public/js/health-risk-controller.js" },
  { source: "src/client/health-picture-client.ts", output: "public/js/health-picture-client.js" },
  { source: "src/client/health-picture-controller.ts", output: "public/js/health-picture-controller.js" },
  { source: "src/client/health-markers-client.ts", output: "public/js/health-markers-client.js" },
  { source: "src/client/health-markers-controller.ts", output: "public/js/health-markers-controller.js" },
  { source: "src/client/marker-row-client.ts", output: "public/js/marker-row-client.js" },
  { source: "src/client/records-slot.ts", output: "public/js/records-slot.js" },
  { source: "src/client/records-search-model.ts", output: "public/js/records-search-model.js" },
  { source: "src/client/records-search-client.ts", output: "public/js/records-search-client.js" },
  { source: "src/client/records-search-controller.ts", output: "public/js/records-search-controller.js" },
  { source: "src/client/evidence-wanted-client.ts", output: "public/js/evidence-wanted-client.js" },
  { source: "src/client/evidence-wanted-controller.ts", output: "public/js/evidence-wanted-controller.js" },
  { source: "src/client/health-directives-client.ts", output: "public/js/health-directives-client.js" },
  { source: "src/client/health-directives-loader-client.ts", output: "public/js/health-directives-loader-client.js" },
  { source: "src/client/health-read-synthesis-client.ts", output: "public/js/health-read-synthesis-client.js" },
  { source: "src/client/health-read-supplements-client.ts", output: "public/js/health-read-supplements-client.js" },
  { source: "src/client/health-read-controller.ts", output: "public/js/health-read-controller.js" },
  { source: "src/client/health-learned-client.ts", output: "public/js/health-learned-client.js" },
  { source: "src/client/health-beliefs-client.ts", output: "public/js/health-beliefs-client.js" },
  { source: "src/client/health-beliefs-loader-client.ts", output: "public/js/health-beliefs-loader-client.js" },
  { source: "src/client/health-checkup-client.ts", output: "public/js/health-checkup-client.js" },
  { source: "src/client/health-records-client.ts", output: "public/js/health-records-client.js" },
  { source: "src/client/imaging-upload-model.ts", output: "public/js/imaging-upload-model.js" },
  { source: "src/client/dicom-viewer-model.ts", output: "public/js/dicom-viewer-model.js" },
  { source: "src/client/dicom-viewer-controller.ts", output: "public/js/dicom-viewer-controller.js" },
  { source: "src/client/imaging-client.ts", output: "public/js/imaging-client.js" },
  { source: "src/client/health-doc-upload-controller.ts", output: "public/js/health-doc-upload-controller.js" },
  { source: "src/client/health-doc-date-actions-client.ts", output: "public/js/health-doc-date-actions-client.js" },
  { source: "src/client/health-doc-lifecycle-actions-client.ts", output: "public/js/health-doc-lifecycle-actions-client.js" },
  { source: "src/client/health-doc-actions-controller.ts", output: "public/js/health-doc-actions-controller.js" },
  { source: "src/client/me-records-health-doc-controller.ts", output: "public/js/me-records-health-doc-controller.js" },
  { source: "src/client/packet-builder-model.ts", output: "public/js/packet-builder-model.js" },
  { source: "src/client/packet-builder-client.ts", output: "public/js/packet-builder-client.js" },
  { source: "src/client/packet-builder-controller.ts", output: "public/js/packet-builder-controller.js" },
  { source: "src/client/visit-questions-client.ts", output: "public/js/visit-questions-client.js" },
  { source: "src/client/visit-questions-controller.ts", output: "public/js/visit-questions-controller.js" },
  { source: "src/client/health-share-controller.ts", output: "public/js/health-share-controller.js" },
  { source: "src/client/memory-client.ts", output: "public/js/memory-client.js" },
  { source: "src/client/me-memory-controller.ts", output: "public/js/me-memory-controller.js" },
  { source: "src/client/life-client.ts", output: "public/js/life-client.js" },
  { source: "src/client/life-form-helpers.ts", output: "public/js/life-form-helpers.js" },
  { source: "src/client/life-timeline-actions.ts", output: "public/js/life-timeline-actions.js" },
  { source: "src/client/life-controller.ts", output: "public/js/life-controller.js" },
  { source: "src/client/family-client.ts", output: "public/js/family-client.js" },
  { source: "src/client/family-controller.ts", output: "public/js/family-controller.js" },
  { source: "src/client/me-health-screen-composition.ts", output: "public/js/me-health-screen-composition.js" },
  { source: "src/client/me-health-screen.ts", output: "public/js/07-me-health.js" },
  { source: "src/client/me-records-screen.ts", output: "public/js/08-me-records.js" },
  { source: "src/client/health-docs-client.ts", output: "public/js/health-docs-client.js" },
  { source: "src/client/route-state.ts", output: "public/js/route-state.js" },
  { source: "src/client/app/lazy-bundles.ts", output: "public/js/app-lazy-bundles.js" },
  { source: "src/client/app/moved-note.ts", output: "public/js/app-moved-note.js" },
  { source: "src/client/app/router.ts", output: "public/js/app-router.js" },
  { source: "src/client/app/route-sync.ts", output: "public/js/app-route-sync.js" },
  { source: "src/client/app/render-dispatch.ts", output: "public/js/app-render-dispatch.js" },
  { source: "src/client/app/tabs.ts", output: "public/js/app-tabs.js" },
  { source: "src/client/app/job-reconnectors.ts", output: "public/js/app-job-reconnectors.js" },
  { source: "src/client/app/mobile-viewport.ts", output: "public/js/app-mobile-viewport.js" },
  { source: "src/client/app/day-rollover.ts", output: "public/js/app-day-rollover.js" },
  { source: "src/client/app/wake-lock.ts", output: "public/js/app-wake-lock.js" },
  { source: "src/client/app/service-worker.ts", output: "public/js/app-service-worker.js" },
  { source: "src/client/app/discipline-primer.ts", output: "public/js/app-discipline-primer.js" },
  { source: "src/client/app/onboarding.ts", output: "public/js/app-onboarding.js" },
  { source: "src/client/app/startup.ts", output: "public/js/app-startup.js" },
  { source: "src/client/changes-feed-client.ts", output: "public/js/changes-feed-client.js" },
  { source: "src/client/changes-feed-controller.ts", output: "public/js/changes-feed-controller.js" },
  { source: "src/client/ask-card-client.ts", output: "public/js/ask-card-client.js" },
  { source: "src/client/ask-card-controller.ts", output: "public/js/ask-card-controller.js" },
  { source: "src/client/fuel-today-model.ts", output: "public/js/fuel-today-model.js" },
  { source: "src/client/fuel-today-client.ts", output: "public/js/fuel-today-client.js" },
  { source: "src/client/fuel-today-controller.ts", output: "public/js/fuel-today-controller.js" },
  { source: "src/client/fuel-meals-client.ts", output: "public/js/fuel-meals-client.js" },
  { source: "src/client/fuel-meals-controller.ts", output: "public/js/fuel-meals-controller.js" },
  { source: "src/client/fuel-log-client.ts", output: "public/js/fuel-log-client.js" },
  { source: "src/client/fuel-log-controller.ts", output: "public/js/fuel-log-controller.js" },
  { source: "src/client/idea-card-client.ts", output: "public/js/idea-card-client.js" },
  { source: "src/client/idea-card-controller.ts", output: "public/js/idea-card-controller.js" },
  { source: "src/client/fuel-deps.ts", output: "public/js/fuel-deps.js" },
  { source: "src/client/app-identity-model.ts", output: "public/js/app-identity-model.js" },
  { source: "src/client/app-identity-client.ts", output: "public/js/app-identity-client.js" },
  { source: "src/client/app-identity-controller.ts", output: "public/js/app-identity-controller.js" },
];

// Ordered concatenation manifest. index.html loads a handful of bundles instead
// of ~216 individual <script>s (a big cold-start win: far fewer request round
// trips). Each bundle is the in-order concatenation of the already-built,
// IIFE-wrapped individual outputs above, so global scope and load order are
// unchanged. The CONCATENATION OF EVERY EAGER BUNDLE'S `inputs`, IN THIS ARRAY
// ORDER, REPRODUCES THE CANONICAL <script> SEQUENCE EXACTLY — this manifest is the
// authoritative encoding of that order; the lazy bundles run after boot. Every CLIENT_OUTPUTS output (plus the
// hand-written classic shim public/js/10-boot.js) appears in exactly one bundle.
//
// A bundle carrying `lazy: "<name>"` is NOT loaded by index.html: it is injected
// on demand by ensureBundle("<name>") (src/client/app/lazy-bundles.ts), so its
// globals must never be referenced EAGERLY from an earlier bundle — only from
// inside a function that runs after the destination has navigated.
//
// Each lazy entry names the `views` it renders (a route's `tab`, or `tab:section`
// where Plan splits across homes) — the same choice render-dispatch.ts makes, held to
// it by test/lazyRoutePreload.test.js. The build derives index.html's cold deep-link
// preload table from it (scripts/lazy-route-preload.mjs), so a deep link starts its
// lazy bundle's download alongside the eager set instead of after it.
//
// Lazy bundles may DEPEND on each other (LAZY_BUNDLE_DEPS in lazy-bundles.ts):
// ensureBundle("horizon") also loads train. A lazy bundle never references another
// lazy bundle at load time either, so their execution order does not matter.
//
// Splitting was once DECLINED here (defer already unblocked first paint, and a
// reshape risked the load-order hazard). The athlete's per-screen load-time ask
// reopened it: the eager shell was ~360 KB brotli, and every open parsed Train,
// Horizon, Ask and Settings before the Brief could settle. Only Today, You, Fuel,
// capture and the shell stay eager now; the rest is injected on first navigation
// and warmed on idle after first paint (prefetchLazyBundles), so a tab switch
// still never waits on the network. Every lazy bundle stays in the service
// worker's CORE_ASSETS, so a cold offline deep link resolves from the precache.
// Before moving a module between eager and lazy, run a cross-bundle reference
// check: an eager module may reach a lazy global only inside a function that
// runs after ensureBundle/withBundle for its bundle.
export const BUNDLES = [
  {
    output: "public/js/bundle-01-core.js",
    label: "foundations (utils, api, core state, ui shell)",
    inputs: [
      "public/js/date-utils.js",
      "public/js/html-utils.js",
      "public/js/ui-components.js",
      "public/js/ui-reads.js",
      "public/js/ui-feedback-client.js",
      "public/js/ui-actions-client.js",
      "public/js/ui-sheet.js",
      "public/js/ui-chart.js",
      "public/js/decision-undo-client.js",
      "public/js/decision-undo-controller.js",
      "public/js/ui-view-transitions-client.js",
      "public/js/exercise-detail-client.js",
      "public/js/format-utils.js",
      "public/js/ui-format.js",
      "public/js/client-diagnostics.js",
      "public/js/token-sheet.js",
      "public/js/api-cache.js",
      "public/js/api-reach.js",
      "public/js/api-auth.js",
      "public/js/api-core.js",
      "public/js/api-signals.js",
      "public/js/outbox-queue.js",
      "public/js/outbox-runtime.js",
      "public/js/outbox-replay.js",
      "public/js/outbox-session.js",
      "public/js/outbox.js",
      "public/js/outbox-ui.js",
      "public/js/app-download.js",
      "public/js/offline-state-client.js",
      "public/js/app-update-gate.js",
      "public/js/app-sw-recovery.js",
      "public/js/01-core.js",
      "public/js/art-memory-client.js",
      "public/js/art-inflight-client.js",
      "public/js/art-controller.js",
      "public/js/pwa-install-coach.js",
      "public/js/ui-header-client.js",
      "public/js/train-nav-client.js",
      "public/js/ui-segments-client.js",
      "public/js/02-ui.js",
      "public/js/app-identity-model.js",
      "public/js/app-identity-client.js",
      "public/js/app-identity-controller.js",
    ],
  },  {
    output: "public/js/bundle-02-today.js",
    label: "Today screen + You landing",
    inputs: [
      "public/js/detail-overlay-client.js",
      "public/js/ui-motion-client.js",
      "public/js/exercise-detail-data-client.js",
      "public/js/exercise-detail-explanation-client.js",
      "public/js/exercise-guide-client.js",
      "public/js/exercise-detail-render-client.js",
      "public/js/exercise-detail-actions-client.js",
      "public/js/exercise-detail-controller.js",
      "public/js/agent-job-records-client.js",
      "public/js/agent-job-client.js",
      "public/js/rest-timer.js",
      "public/js/coaching-focus-render-client.js",
      "public/js/coaching-focus-client.js",
      "public/js/today-activity-client.js",
      "public/js/save-bar.js",
      "public/js/swr-cache.js",
      "public/js/write-invalidation-client.js",
      "public/js/today-agenda-client.js",
      "public/js/today-rail-loaders-client.js",
      "public/js/changes-line-client.js",
      "public/js/changes-line-controller.js",
      // The stone renderer: its only callers (cairn stack, stone detail) live here.
      "public/js/ui-stone-model.js",
      "public/js/ui-stone.js",
      "public/js/today-fuel-glance-client.js",
      "public/js/today-worth-client.js",
      "public/js/today-path-client.js",
      "public/js/today-path-controller.js",
      "public/js/today-ahead-mount.js",
      "public/js/today-rail-controller.js",
      "public/js/today-plan-selection-client.js",
      "public/js/today-training-client.js",
      "public/js/today-progression-controller.js",
      "public/js/today-add-exercise-controller.js",
      "public/js/today-brief-voice-client.js",
      "public/js/today-brief-run-leg-client.js",
      "public/js/today-brief-client.js",
      "public/js/today-brief-signals-client.js",
      "public/js/today-brief-override-client.js",
      "public/js/today-brief-actions-client.js",
      "public/js/today-brief-cache-client.js",
      "public/js/today-brief-controller.js",
      "public/js/cardio-sync-client.js",
      "public/js/today-lately-client.js",
      "public/js/proposal-client.js",
      "public/js/today-session-suggest-client.js",
      "public/js/today-session-suggest-controller.js",
      "public/js/today-session-ask-sheet.js",
      "public/js/today-session-status-client.js",
      "public/js/today-session-feedback-client.js",
      "public/js/session-primer-client.js",
      "public/js/today-session-skip-client.js",
      "public/js/today-session-set-model.js",
      "public/js/today-session-set-actions.js",
      "public/js/today-session-controller.js",
      "public/js/today-session-launch-client.js",
      "public/js/today-cards-client.js",
      "public/js/today-context-client.js",
      "public/js/today-compass-client.js",
      "public/js/today-garmin-reconciliation-client.js",
      "public/js/today-side-loaders.js",
      "public/js/today-plan-session-model.js",
      "public/js/today-plan-session-data-client.js",
      "public/js/today-plan-session-preparation.js",
      "public/js/today-data-loader.js",
      "public/js/today-slot-hold.js",
      "public/js/today-prefetch.js",
      "public/js/today-main-shell-client.js",
      "public/js/today-plan-surface-client.js",
      "public/js/today-plan-surface-renderer.js",
      "public/js/today-render-state-client.js",
      "public/js/today-post-render-wiring.js",
      "public/js/today-dependencies.js",
      "public/js/today-compatibility-bridges.js",
      "public/js/today-screen-runtime-deps.js",
      "public/js/today-screen-runtime.js",
      "public/js/session-snapshot-client.js",
      // Today is Home (v2 wave 7): the one delegated `data-open-day` opener. EAGER and
      // tiny; the page, the drill controller and the views are the lazy "calendar" bundle.
      "public/js/day-open-client.js",
      // The coach link (EAGER, tiny): is a coach connected, Today's one line and Ask's
      // connect card. The welcome it opens is the lazy "welcome" bundle.
      "public/js/coach-link-client.js",
      // Train's energy read (and the hero it paints with) stays EAGER: Fuel paints
      // it (#energyCard) and it owns the nutrition_checkin job reconnector, which
      // must register at boot.
      "public/js/progress-components-client.js",
      "public/js/progress-energy-client.js",
      "public/js/progress-energy-surface-client.js",
      // The Train overview's last-known read stays EAGER: it registers the "@train"
      // write-invalidation snapshot, whose localStorage copy a write must clear even
      // before the lazy train bundle has loaded.
      "public/js/progress-overview-snapshot-client.js",
      "public/js/03-today.js",
      // v2 wave 5: the You landing, the cairn-stack and the stone detail. EAGER on
      // purpose: You paints as fast as Today and never waits on me-health.
      "public/js/cairn-stack-model.js",
      "public/js/cairn-stack-client.js",
      "public/js/cairn-stack-controller.js",
      "public/js/stone-detail-model.js",
      "public/js/stone-detail-client.js",
      "public/js/stone-detail-controller.js",
      "public/js/you-screen.js",
    ],
  },  {
    output: "public/js/bundle-03-capture.js",
    label: "capture",
    inputs: [
      "public/js/capture-provenance-client.js",
      "public/js/capture-read-date-client.js",
      "public/js/capture-read-cards-client.js",
      "public/js/capture-read-jobs-client.js",
      "public/js/capture-reads-client.js",
      "public/js/capture-voice-client.js",
      "public/js/capture-checkin-client.js",
      "public/js/04-capture.js",
    ],
  },  {
    output: "public/js/bundle-04-coach-meals.js",
    label: "coach proposals + Fuel",
    inputs: [
      "public/js/coach-proposal-controller.js",
      "public/js/06-coach-meals.js",
      // Food-note formatting + the food detail sheet USED to head bundle-05.
      // They are food, not health: the Fuel surface (this bundle) and
      // ui-shell (bundle-01) call them from the Plan/Today surfaces, which must
      // keep working without the lazily-loaded Me/Health bundle. Moving them
      // here keeps the canonical <script> order byte-for-byte — bundle-04 runs
      // immediately before bundle-05, and these were its first two entries.
      "public/js/food-note-client.js",
      // The meal card (v2 wave 2): the food detail sheet mounts it from inside a
      // function, and Fuel reaches it the same way.
      "public/js/meal-card-model.js",
      "public/js/meal-card-client.js",
      "public/js/meal-card-controller.js",
      "public/js/food-detail-controller.js",
      // Plan → Food, the Fuel surface (v2 wave 2). renderFoodJournal mounts these
      // only from inside a function, so they may follow the screen too.
      "public/js/fuel-today-model.js",
      "public/js/fuel-today-client.js",
      "public/js/fuel-today-controller.js",
      "public/js/fuel-meals-client.js",
      "public/js/fuel-meals-controller.js",
      "public/js/fuel-log-client.js",
      "public/js/fuel-log-controller.js",
      "public/js/idea-card-client.js",
      "public/js/idea-card-controller.js",
      "public/js/fuel-deps.js",
      // The food composer (Today → Fuel logging) and the three chat primitives it
      // mounts USED to open the chat bundle. Fuel is eager and Ask is lazy, so they
      // ride here, at the tail of the bundle that ran immediately before them —
      // the canonical order of everything that stays eager is unchanged. The
      // photo-compression constants they read (chat-client) ride the ask bundle:
      // compressImage awaits it on the first photo.
      "public/js/chat-attachment-client.js",
      "public/js/chat-composer-focus-client.js",
      "public/js/food-composer-model.js",
      "public/js/food-composer-client.js",
      "public/js/food-composer-chips-controller.js",
      "public/js/food-composer-turn-controller.js",
      "public/js/food-composer-controller.js",
      "public/js/chat-layout-client.js",
    ],
  },  {
    output: "public/js/bundle-05-me-health.js",
    label: "Me / Health / Records",
    // LAZY: index.html does not load this one. ~470 KB of classic script that
    // only the Stand and Me destinations need; src/client/app/lazy-bundles.ts
    // injects it on the first navigation to either, keyed by this name. It stays
    // in the service worker's CORE_ASSETS so an installed PWA precaches it and
    // the first offline visit to Stand still works.
    lazy: "me-health",
    views: ["stand", "me"],
    inputs: [
      "public/js/health-docs-client.js",
      "public/js/me-profile-form-client.js",
      "public/js/me-profile-controller.js",
      "public/js/me-health-log-renderer.js",
      "public/js/me-health-tabs-controller.js",
      "public/js/me-health-controller-deps.js",
      "public/js/me-health-dependencies.js",
      "public/js/me-health-screen-composition.js",
      "public/js/07-me-health.js",
      "public/js/health-evidence-client.js",
      "public/js/health-marker-order-client.js",
      "public/js/health-client.js",
      "public/js/health-read-client.js",
      "public/js/health-standing-primitives-client.js",
      "public/js/health-standing-client.js",
      "public/js/health-standing-controller.js",
      "public/js/health-risk-client.js",
      "public/js/health-risk-controller.js",
      "public/js/health-picture-client.js",
      "public/js/health-picture-controller.js",
      "public/js/health-markers-client.js",
      "public/js/health-markers-controller.js",
      "public/js/marker-row-client.js",
      "public/js/records-slot.js",
      "public/js/records-search-model.js",
      "public/js/records-search-client.js",
      "public/js/records-search-controller.js",
      "public/js/evidence-wanted-client.js",
      "public/js/evidence-wanted-controller.js",
      "public/js/health-fan-in-client.js",
      "public/js/stand-screen.js",
      "public/js/health-directives-client.js",
      "public/js/health-directives-loader-client.js",
      "public/js/health-read-synthesis-client.js",
      "public/js/health-read-supplements-client.js",
      "public/js/health-read-controller.js",
      "public/js/health-learned-client.js",
      "public/js/health-beliefs-client.js",
      "public/js/health-beliefs-loader-client.js",
      "public/js/health-checkup-client.js",
      "public/js/health-records-client.js",
      "public/js/imaging-upload-model.js",
      "public/js/dicom-viewer-model.js",
      "public/js/dicom-viewer-controller.js",
      "public/js/imaging-client.js",
      "public/js/health-doc-upload-controller.js",
      "public/js/health-doc-date-actions-client.js",
      "public/js/health-doc-lifecycle-actions-client.js",
      "public/js/health-doc-actions-controller.js",
      "public/js/me-records-health-doc-controller.js",
      "public/js/packet-builder-model.js",
      "public/js/packet-builder-client.js",
      "public/js/packet-builder-controller.js",
      "public/js/visit-questions-client.js",
      "public/js/visit-questions-controller.js",
      "public/js/health-share-controller.js",
      "public/js/memory-client.js",
      "public/js/me-memory-controller.js",
      "public/js/life-client.js",
      "public/js/life-form-helpers.js",
      "public/js/life-timeline-actions.js",
      "public/js/life-controller.js",
      "public/js/family-client.js",
      "public/js/family-controller.js",
      "public/js/08-me-records.js",
    ],
  },  {
    output: "public/js/bundle-07-boot.js",
    label: "app router + boot",
    inputs: [
      "public/js/route-state.js",
      "public/js/app-lazy-bundles.js",
      "public/js/app-moved-note.js",
      "public/js/app-router.js",
      "public/js/app-route-sync.js",
      "public/js/app-render-dispatch.js",
      "public/js/app-tabs.js",
      "public/js/app-job-reconnectors.js",
      "public/js/app-mobile-viewport.js",
      "public/js/app-day-rollover.js",
      "public/js/app-wake-lock.js",
      "public/js/app-service-worker.js",
      "public/js/app-discipline-primer.js",
      "public/js/app-onboarding.js",
      "public/js/app-startup.js",
      "public/js/10-boot.js",
    ],
  },  {
    output: "public/js/bundle-08-train.js",
    label: "Train (Progress views, plan editor, body metrics)",
    // LAZY: every Train view (overview, 1RM, volume, program, sessions, energy,
    // intake, endurance, weight, measurements, calendar), the plan editor and its
    // week strip, the journey reads Horizon also paints, and the body-metrics
    // figure Health reuses. Horizon and me-health list it as a dependency.
    lazy: "train",
    views: ["progress", "plan:edit"],
    inputs: [
      // Run/strength plan-item helpers: only the plan editor and the run plan read them.
      "public/js/cardio-plan-client.js",
      "public/js/progress-data-client.js",
      "public/js/endurance-format-client.js",
      "public/js/progress-endurance-client.js",
      "public/js/progress-line-chart-model.js",
      "public/js/progress-chart-scrub-client.js",
      "public/js/progress-chart-drawing-client.js",
      "public/js/progress-chart-client.js",
      "public/js/progress-trend-weight-client.js",
      "public/js/progress-history-model-client.js",
      "public/js/progress-history-render-client.js",
      "public/js/progress-history-client.js",
      "public/js/progress-run-plan-client.js",
      "public/js/progress-route-deps-client.js",
      "public/js/train-fan-in-client.js",
      "public/js/progress-endurance-controller.js",
      "public/js/progress-volume-client.js",
      "public/js/progress-intake-client.js",
      "public/js/progress-calendar-client.js",
      "public/js/progress-muscle-trajectory-client.js",
      "public/js/progress-dexa-targeting-client.js",
      "public/js/progress-performance-client.js",
      "public/js/progress-program-adjustments-client.js",
      "public/js/progress-test-week-client.js",
      "public/js/progress-program-summary-client.js",
      "public/js/progress-program-block-client.js",
      "public/js/program-week-model.js",
      "public/js/program-week-client.js",
      "public/js/program-week-controller.js",
      "public/js/progress-exercise-suggestions-client.js",
      "public/js/progress-program-controller.js",
      "public/js/journey-progress-client.js",
      "public/js/journey-timeline-client.js",
      "public/js/train-focus-card-client.js",
      "public/js/progress-overview-client.js",
      "public/js/plan-week-client.js",
      "public/js/body-metrics-client.js",
      "public/js/progress-volume-route-client.js",
      "public/js/05-progress.js",
      "public/js/plan-editor-client.js",
      "public/js/plan-editor-form-client.js",
      "public/js/plan-head-client.js",
      "public/js/plan-editor-controller.js",
    ],
  },
  {
    output: "public/js/bundle-09-horizon.js",
    label: "Horizon (timeline, race view, endurance plan)",
    // LAZY: the Horizon landing and the race / endurance plan view. Depends on
    // train (the journey reads, the run-plan cards, the plan week strip).
    lazy: "horizon",
    views: ["horizon", "plan:endurance"],
    inputs: [
      "public/js/plan-endurance-model.js",
      "public/js/plan-endurance-client.js",
      "public/js/plan-endurance-briefing-client.js",
      "public/js/race-week-model.js",
      "public/js/race-week-runs-model.js",
      "public/js/race-ladder-model.js",
      "public/js/race-view-model.js",
      "public/js/race-estimate-client.js",
      "public/js/race-ladder-client.js",
      "public/js/race-view-client.js",
      "public/js/race-view-controller.js",
      "public/js/horizon-model.js",
      "public/js/horizon-labs-model.js",
      "public/js/horizon-terrain-client.js",
      "public/js/horizon-chart-client.js",
      "public/js/horizon-week-client.js",
      "public/js/horizon-week-controller.js",
      "public/js/horizon-client.js",
      "public/js/horizon-controller.js",
      "public/js/horizon-screen.js",
    ],
  },
  {
    output: "public/js/bundle-10-ask.js",
    label: "Ask (chat thread + what-if ripple card)",
    // LAZY: the Ask thread. The food composer and the chat primitives it shares
    // with Fuel stay eager in bundle-04.
    lazy: "ask",
    views: ["chat", "plan:coach"],
    inputs: [
      // The reply renderer: only the thread reads markdown.
      "public/js/markdown-client.js",
      "public/js/capture-macros-client.js",
      "public/js/chat-client.js",
      // Ask → Changes (the calm asks + the history-first feed with Undo, and the
      // screen itself: renderCoach, dispatched through lazy("ask")/withLatestRender).
      "public/js/changes-feed-client.js",
      "public/js/changes-feed-controller.js",
      "public/js/ask-card-client.js",
      "public/js/ask-card-controller.js",
      "public/js/coach-changes-screen.js",
      "public/js/chat-composer-controller.js",
      "public/js/chat-speaker-client.js",
      "public/js/chat-message-client.js",
      "public/js/chat-turn-records-client.js",
      "public/js/chat-turn-stream-state-client.js",
      "public/js/chat-turn-monitor-client.js",
      "public/js/chat-turn-client.js",
      "public/js/chat-history-client.js",
      "public/js/chat-header-controller.js",
      "public/js/chat-starter-chips-client.js",
      "public/js/chat-fuel-context-client.js",
      "public/js/chat-earlier-history-client.js",
      "public/js/ripple-card-model.js",
      "public/js/ripple-card-client.js",
      "public/js/ripple-card-controller.js",
      "public/js/09-plan-chat.js",
    ],
  },
  {
    output: "public/js/bundle-15-welcome.js",
    label: "The first-run welcome + the AI sign-in panel",
    // LAZY: the full-screen welcome (/app/welcome — Hello, Connect, Meet) and the
    // friendly AI sign-in it shares with Settings → Agents "Connect". It renders over
    // the app rather than as a view, so no route dispatches to it: it is opened by the
    // boot decision (app/onboarding.ts), Today's coach line and Ask's connect card,
    // all through CairnCoachLink.openWelcome. Listed before Settings, which depends on
    // it, so the sign-in modules keep their place ahead of the Settings screen.
    lazy: "welcome",
    routeless: true,
    inputs: [
      "public/js/agent-login-model-client.js",
      "public/js/agent-login-assets-client.js",
      "public/js/agent-login-modal-client.js",
      "public/js/agent-login-session-client.js",
      "public/js/agent-login-panel-client.js",
      "public/js/agent-login-client.js",
      "public/js/welcome-model.js",
      "public/js/welcome-client.js",
      "public/js/welcome-connect-controller.js",
      "public/js/welcome-meet-controller.js",
      "public/js/welcome-screen.js",
    ],
  },
  {
    output: "public/js/bundle-11-settings.js",
    label: "Settings",
    // LAZY: the Settings surfaces. Route matching reads the section keys from
    // CairnRoutes (always eager), never from SET_SEG, so a cold deep link resolves.
    lazy: "settings",
    views: ["settings"],
    inputs: [
      // The AI sign-in (the friendly panel, its session and the Connect modal) rides
      // the welcome bundle, which Settings depends on (LAZY_BUNDLE_DEPS).
      "public/js/settings-routes.js",
      "public/js/settings-client.js",
      "public/js/settings-surface-model.js",
      "public/js/settings-surface-client.js",
      "public/js/settings-drive-client.js",
      "public/js/settings-drive-controller.js",
      "public/js/settings-data-client.js",
      "public/js/settings-update-client.js",
      "public/js/settings-pairing-view.js",
      "public/js/settings-pairing-client.js",
      "public/js/settings-mcp-client.js",
      "public/js/settings-feedback-client.js",
      "public/js/settings-data-controller.js",
      "public/js/settings-agents-client.js",
      "public/js/settings-agents-controller.js",
      "public/js/settings-sources-automation-controller.js",
      "public/js/settings-screen.js",
    ],
  },
  {
    output: "public/js/bundle-12-calendar.js",
    label: "The calendar (a day's page, peek and views; the drill controller)",
    // LAZY: any day that is not today, read-only (v2 wave 7, "Today is Home"), at its
    // home-free page /app/day/<date>. The opener (day-open-client, eager in bundle-02)
    // injects this on the first open. It carries the ONE day view family (chip, row,
    // compact, full) and the ONE drill controller (CairnDrill): Today's "What's ahead"
    // strip draws its chips and peeks a day (today-ahead depends on calendar), and
    // Train's Program draws its movement rows and week rows (train depends on calendar).
    // It also carries the shared time objects (docs/IA.md "Component architecture"): the
    // week's model and its shape strip, the milestone row and the goal row (Horizon's
    // Week and Season both draw them), and the frame line (Week's hero, To the race's).
    lazy: "calendar",
    views: ["day"],
    inputs: [
      "public/js/day-detail-model.js",
      "public/js/day-glance-model.js",
      "public/js/day-detail-run-client.js",
      "public/js/day-detail-client.js",
      "public/js/day-glance-view.js",
      "public/js/day-detail-controller.js",
      "public/js/day-record-client.js",
      "public/js/drill-controller.js",
      "public/js/milestone-row-model.js",
      "public/js/milestone-row-client.js",
      "public/js/goal-row-model.js",
      "public/js/goal-row-client.js",
      "public/js/frame-line-client.js",
      "public/js/week-model.js",
      "public/js/week-strip-client.js",
    ],
  },
  {
    output: "public/js/bundle-13-meals.js",
    label: "Meal planner (the week menu, Fuel's menu card, swaps, recipes, past weeks)",
    // LAZY: the weekly meal plan is ideation. Its own route is the week menu
    // (/app/today/menu, plan:meals); Fuel (eager) mounts the "This week's menu" card
    // and paints its past-weeks fold through withBundle("meals"); the meal_plan /
    // meal_swap / recipe reconnectors register when this lands.
    lazy: "meals",
    views: ["plan:meals"],
    inputs: [
      "public/js/meal-fuel-context-client.js",
      "public/js/meal-row-client.js",
      "public/js/meal-plan-upcoming-client.js",
      "public/js/meal-plan-client.js",
      "public/js/meal-planner-jobs-client.js",
      "public/js/meal-recipe-client.js",
      "public/js/meal-recipe-controller.js",
      "public/js/meal-swap-data-client.js",
      "public/js/meal-swap-row-actions-controller.js",
      "public/js/meal-swap-controller.js",
      "public/js/meal-planner-actions-controller.js",
      "public/js/meal-planner-controller.js",
      "public/js/meal-journal-client.js",
      "public/js/meal-menu-card-client.js",
      "public/js/meal-menu-card-controller.js",
    ],
  },
  {
    output: "public/js/bundle-14-today-ahead.js",
    label: "Today below the Brief (the overnight digest, the week, Coming up, the new connection)",
    // LAZY: the redesigned Today's async lower half. today-screen (eager) paints the
    // frame and its empty slots, then mounts these through withBundle("today-ahead");
    // warmed first on idle, precached. Route-less: it renders inside Today's own view.
    lazy: "today-ahead",
    views: [],
    routeless: true,
    inputs: [
      // The rail's week-ahead and program-adjustments cards: Today's column carries both
      // stories now (the week strip, the digest), so their renderers wait here.
      "public/js/today-program-adjustments-client.js",
      "public/js/today-week-ahead-client.js",
      "public/js/today-digest-client.js",
      "public/js/today-week-client.js",
      "public/js/today-horizon-client.js",
      "public/js/today-ahead-controller.js",
      "public/js/today-strip-client.js",
      "public/js/today-strip-controller.js",
      "public/js/today-push-client.js",
      "public/js/today-push-controller.js",
    ],
  },
  {
    output: "public/js/bundle-16-auth.js",
    label: "Sign-in (passkey, pairing code, access token) and the passkey ceremonies",
    // LAZY: only a signed-out device or Settings → Devices ever needs it. The
    // eager door (token-sheet.ts) injects it on a 401; Settings injects it on "Add a passkey". Never
    // warmed on idle — a signed-in device has no use for it — but precached.
    lazy: "auth",
    views: [],
    routeless: true,
    inputs: ["public/js/auth-passkey-client.js", "public/js/auth-signin-client.js"],
  },
];

const compilerOptions = {
  alwaysStrict: false,
  ignoreDeprecations: "6.0",
  module: ts.ModuleKind.None,
  moduleDetection: ts.ModuleDetectionKind.Legacy,
  // Comments are ~29% of the shipped bundle bytes and buy the browser nothing: the
  // source of truth is src/client/**.ts, which keeps every one of them. Each bundle
  // still carries the generated header and the `// ==== file ====` separators, which
  // this script writes AFTER transpiling, so provenance in the served file survives.
  removeComments: true,
  target: ts.ScriptTarget.ES2022,
};

function wrapClassicScript(source) {
  return `(() => {\n${source.trimEnd()}\n})();\n`;
}

function bundleHeader(label) {
  return (
    "// GENERATED by scripts/build-client.mjs — do not edit.\n" +
    "// Ordered concatenation of individual public/js modules (see the BUNDLES\n" +
    "// manifest). The classic <script> load order is preserved exactly and each\n" +
    "// constituent stays IIFE-wrapped, so global scope is unchanged.\n" +
    `// Bundle: ${label}\n`
  );
}

/**
 * Drop the leading indentation of every line that does not start inside a template
 * or string literal. The transpiler emits 4-space nesting that is ~7% of a bundle's
 * brotli bytes and buys the browser nothing. Only whitespace BETWEEN tokens is
 * removed and every newline stays, so tokenization and automatic semicolon
 * insertion are unchanged; a line that begins inside a multi-line template literal
 * (the HTML templates) is left byte-for-byte, so no rendered string changes.
 * Applied to the served bundles only — the per-module outputs the tests read keep
 * their formatting.
 */
export function stripIndentation(source, fileName = "bundle.js") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  const literalKinds = new Set([
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.StringLiteral,
  ]);
  const ranges = [];
  const visit = (node) => {
    if (literalKinds.has(node.kind)) ranges.push([node.getStart(sf), node.end]);
    else if (ts.isTemplateSpan(node)) ranges.push([node.literal.getStart(sf), node.literal.end]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  let r = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    while (r < ranges.length && ranges[r][1] <= at) r++;
    // Protected when this line starts strictly inside a literal (after its opening quote/backtick).
    const inside = r < ranges.length && ranges[r][0] < at && at < ranges[r][1];
    out += (inside ? line : line.replace(/^[ \t]+/, "")) + (i < lines.length - 1 ? "\n" : "");
    at += line.length + 1;
  }
  return out;
}

// Concatenate the already-built individual outputs, in manifest order, into the
// handful of bundle files index.html actually loads. Reads what buildClient()
// just wrote, so this must run AFTER the per-file emit.
export function buildBundles() {
  for (const bundle of BUNDLES) {
    const chunks = bundle.inputs.map((input) => {
      const body = stripIndentation(readFileSync(path.join(root, input), "utf8"), input).trimEnd();
      return `// ==== ${input} ====\n${body}`;
    });
    const content = `${bundleHeader(bundle.label)}\n${chunks.join("\n;\n")}\n`;
    const outputPath = path.join(root, bundle.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content);
  }
  console.log(`✓ built client bundles (${BUNDLES.length} bundle${BUNDLES.length === 1 ? "" : "s"})`);
}

export function buildClient() {
  for (const item of CLIENT_OUTPUTS) {
    const sourcePath = path.join(root, item.source);
    const outputPath = path.join(root, item.output);
    const source = readFileSync(sourcePath, "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions,
      fileName: item.source,
      reportDiagnostics: true,
    });
    const diagnostics = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (diagnostics.length) {
      const msg = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      });
      console.error(msg);
      process.exit(1);
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, wrapClassicScript(result.outputText));
  }

  console.log(`✓ built client output (${CLIENT_OUTPUTS.length} file${CLIENT_OUTPUTS.length === 1 ? "" : "s"})`);
  buildBundles();
  // Reads the per-module route-state / lazy-loader outputs, so it runs before any prune.
  writeLazyRouteTable(root, BUNDLES);
  pruneOrphanedOutputs();
  pruneBundleIntermediates();
  buildStyles();
  precompressAssets();
}

// ---------------------------------------------------------------------------
// Shipping: prune, then precompress. Both run AFTER bundling, on what is served.
// ---------------------------------------------------------------------------

/** The hand-written classic shim — a bundle INPUT that lives in git, never generated. */
const HANDWRITTEN_PUBLIC_JS = new Set(["public/js/10-boot.js"]);

/**
 * Generated output whose source is gone. Renaming or splitting a module leaves its
 * old public/js file (and .gz/.br siblings) behind in any checkout that built before
 * the change; the engineering-contract test then fails on it and the server still
 * serves it. Anything in public/js that this build does not emit and git does not own
 * is removed.
 */
export function pruneOrphanedOutputs() {
  const dir = path.join(root, "public/js");
  if (!existsSync(dir)) return;
  const known = new Set([...CLIENT_OUTPUTS.map((item) => item.output), ...BUNDLES.map((bundle) => bundle.output)]);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const file = `public/js/${name}`;
    const base = file.replace(/\.(gz|br)$/, "");
    if (!base.endsWith(".js") || known.has(base) || HANDWRITTEN_PUBLIC_JS.has(base)) continue;
    rmSync(path.join(root, file));
    removed += 1;
  }
  if (removed) console.log(`✓ pruned ${removed} orphaned output${removed === 1 ? "" : "s"} from public/js`);
}

/**
 * Every per-module intermediate the bundler consumed. index.html loads only the
 * bundles, so after buildBundles() these are dead weight in the image and on the
 * deploy rsync — 236 files / ~2.2 MB of publicly reachable, unused JS.
 *
 * Off by default: the client test suite reads these per-module outputs directly
 * (`readFileSync("public/js/<module>.js")` in ~158 test files), so a local build
 * must keep them. Set CAIRN_PRUNE_CLIENT_INTERMEDIATES=1 for a build whose output
 * is shipped rather than tested — the Dockerfile builder stage does exactly that.
 */
export function pruneBundleIntermediates() {
  if (!/^(1|true|yes|on)$/i.test((process.env.CAIRN_PRUNE_CLIENT_INTERMEDIATES || "").trim())) return;
  const served = new Set(BUNDLES.map((bundle) => bundle.output));
  const removable = new Set();
  for (const bundle of BUNDLES) {
    for (const input of bundle.inputs) {
      if (!HANDWRITTEN_PUBLIC_JS.has(input) && !served.has(input)) removable.add(input);
    }
  }
  let removed = 0;
  for (const file of removable) {
    const target = path.join(root, file);
    if (!existsSync(target)) continue;
    rmSync(target);
    removed += 1;
  }
  console.log(`✓ pruned ${removed} bundled intermediate${removed === 1 ? "" : "s"} from public/js`);
}

/**
 * Assets index.html loads, each of which gets a `.br` and `.gz` sibling.
 * public/index.html and public/art.js are hand-authored and public/styles.css is
 * concatenated from src/styles/ by scripts/build-styles.mjs (not emitted by the
 * transpile step), but they are still part of the shell, so they are compressed
 * here too — this is the one place that knows what a deploy actually serves.
 */
export const PRECOMPRESS_EXTRA = [
  "public/index.html",
  "public/styles.css",
  "public/art.js",
  "public/cairn-body-figure.js",
  // The vendored terminal (Settings → Agents "Connect") is precached by the service
  // worker, so every install downloads it: ~280 KB raw, ~70 KB brotli.
  "public/vendor/xterm.js",
  "public/vendor/xterm.css",
  // The vendored QR encoder (Settings → Devices "Pair a device"), lazy-loaded and precached.
  "public/vendor/qrcode.js",
  // The vendored WebAuthn helper (sign in with / add a passkey), lazy-loaded and precached.
  "public/vendor/simplewebauthn-browser.js",
];

/**
 * Write the compressed representations ONCE per build, so the server never spends
 * Raspberry Pi CPU compressing the same 2.7 MB shell per request.
 * src/staticCompression.ts serves the sibling when Accept-Encoding allows;
 * express.static still serves the raw file to anything else, so a missing sibling
 * only ever costs bytes, never a 404.
 *
 * Missing inputs are skipped rather than fatal: a stage that compiles the client
 * without the hand-authored shell files present is still a valid build.
 */
export function precompressAssets() {
  const targets = [...BUNDLES.map((bundle) => bundle.output), ...PRECOMPRESS_EXTRA];
  let raw = 0;
  let gz = 0;
  let br = 0;
  let written = 0;
  for (const file of targets) {
    const source = path.join(root, file);
    if (!existsSync(source)) {
      console.log(`• precompress: skipped ${file} (not present in this build stage)`);
      continue;
    }
    const bytes = readFileSync(source);
    const gzipped = zlib.gzipSync(bytes, { level: zlib.constants.Z_BEST_COMPRESSION });
    const brotlied = zlib.brotliCompressSync(bytes, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    });
    writeFileSync(`${source}.gz`, gzipped);
    writeFileSync(`${source}.br`, brotlied);
    raw += bytes.length;
    gz += gzipped.length;
    br += brotlied.length;
    written += 1;
  }
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  const label = `${written} asset${written === 1 ? "" : "s"}`;
  console.log(`✓ precompressed ${label} (${kb(raw)} raw → ${kb(gz)} gzip → ${kb(br)} brotli)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  buildClient();
}
