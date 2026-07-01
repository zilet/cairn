#!/usr/bin/env node
// Compile dependency-free browser client slices from src/client into stable
// public/js filenames. This is intentionally explicit during migration: no
// bundler, no runtime deps, and no surprise asset names for the service worker.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");

export const CLIENT_OUTPUTS = [
  { source: "src/client/date-utils.ts", output: "public/js/date-utils.js" },
  { source: "src/client/html-utils.ts", output: "public/js/html-utils.js" },
  { source: "src/client/markdown-client.ts", output: "public/js/markdown-client.js" },
  { source: "src/client/ui-components.ts", output: "public/js/ui-components.js" },
  { source: "src/client/ui-feedback-client.ts", output: "public/js/ui-feedback-client.js" },
  { source: "src/client/exercise-detail-client.ts", output: "public/js/exercise-detail-client.js" },
  { source: "src/client/format-utils.ts", output: "public/js/format-utils.js" },
  { source: "src/client/api-client.ts", output: "public/js/api-client.js" },
  { source: "src/client/app/download.ts", output: "public/js/app-download.js" },
  { source: "src/client/app/sw-recovery.ts", output: "public/js/app-sw-recovery.js" },
  { source: "src/client/app/state.ts", output: "public/js/01-core.js" },
  { source: "src/client/art-controller.ts", output: "public/js/art-controller.js" },
  { source: "src/client/ui-shell.ts", output: "public/js/02-ui.js" },
  { source: "src/client/detail-overlay-client.ts", output: "public/js/detail-overlay-client.js" },
  { source: "src/client/ui-motion-client.ts", output: "public/js/ui-motion-client.js" },
  { source: "src/client/exercise-detail-controller.ts", output: "public/js/exercise-detail-controller.js" },
  { source: "src/client/agent-login-client.ts", output: "public/js/agent-login-client.js" },
  { source: "src/client/agent-job-client.ts", output: "public/js/agent-job-client.js" },
  { source: "src/client/pwa-install-coach.ts", output: "public/js/pwa-install-coach.js" },
  { source: "src/client/rest-timer.ts", output: "public/js/rest-timer.js" },
  { source: "src/client/coaching-focus-client.ts", output: "public/js/coaching-focus-client.js" },
  { source: "src/client/today-activity-client.ts", output: "public/js/today-activity-client.js" },
  { source: "src/client/save-bar.ts", output: "public/js/save-bar.js" },
  { source: "src/client/swr-cache.ts", output: "public/js/swr-cache.js" },
  { source: "src/client/today-agenda-client.ts", output: "public/js/today-agenda-client.js" },
  { source: "src/client/today-rail-controller.ts", output: "public/js/today-rail-controller.js" },
  { source: "src/client/today-plan-selection-client.ts", output: "public/js/today-plan-selection-client.js" },
  { source: "src/client/today-training-client.ts", output: "public/js/today-training-client.js" },
  { source: "src/client/today-progression-controller.ts", output: "public/js/today-progression-controller.js" },
  { source: "src/client/today-add-exercise-controller.ts", output: "public/js/today-add-exercise-controller.js" },
  { source: "src/client/today-brief-client.ts", output: "public/js/today-brief-client.js" },
  { source: "src/client/today-brief-controller.ts", output: "public/js/today-brief-controller.js" },
  { source: "src/client/cardio-plan-client.ts", output: "public/js/cardio-plan-client.js" },
  { source: "src/client/cardio-sync-client.ts", output: "public/js/cardio-sync-client.js" },
  { source: "src/client/today-lately-client.ts", output: "public/js/today-lately-client.js" },
  { source: "src/client/proposal-client.ts", output: "public/js/proposal-client.js" },
  { source: "src/client/today-session-suggest-client.ts", output: "public/js/today-session-suggest-client.js" },
  { source: "src/client/today-session-suggest-controller.ts", output: "public/js/today-session-suggest-controller.js" },
  { source: "src/client/today-session-status-client.ts", output: "public/js/today-session-status-client.js" },
  { source: "src/client/today-session-controller.ts", output: "public/js/today-session-controller.js" },
  { source: "src/client/today-cards-client.ts", output: "public/js/today-cards-client.js" },
  { source: "src/client/today-program-adjustments-client.ts", output: "public/js/today-program-adjustments-client.js" },
  { source: "src/client/today-week-ahead-client.ts", output: "public/js/today-week-ahead-client.js" },
  { source: "src/client/today-context-client.ts", output: "public/js/today-context-client.js" },
  { source: "src/client/today-garmin-reconciliation-client.ts", output: "public/js/today-garmin-reconciliation-client.js" },
  { source: "src/client/today-side-loaders.ts", output: "public/js/today-side-loaders.js" },
  { source: "src/client/today-screen.ts", output: "public/js/03-today.js" },
  { source: "src/client/progress-endurance-client.ts", output: "public/js/progress-endurance-client.js" },
  { source: "src/client/progress-components-client.ts", output: "public/js/progress-components-client.js" },
  { source: "src/client/progress-chart-client.ts", output: "public/js/progress-chart-client.js" },
  { source: "src/client/progress-history-client.ts", output: "public/js/progress-history-client.js" },
  { source: "src/client/progress-run-plan-client.ts", output: "public/js/progress-run-plan-client.js" },
  { source: "src/client/progress-endurance-controller.ts", output: "public/js/progress-endurance-controller.js" },
  { source: "src/client/progress-volume-client.ts", output: "public/js/progress-volume-client.js" },
  { source: "src/client/progress-energy-client.ts", output: "public/js/progress-energy-client.js" },
  { source: "src/client/progress-energy-surface-client.ts", output: "public/js/progress-energy-surface-client.js" },
  { source: "src/client/progress-calendar-client.ts", output: "public/js/progress-calendar-client.js" },
  { source: "src/client/progress-muscle-trajectory-client.ts", output: "public/js/progress-muscle-trajectory-client.js" },
  { source: "src/client/progress-dexa-targeting-client.ts", output: "public/js/progress-dexa-targeting-client.js" },
  { source: "src/client/progress-performance-client.ts", output: "public/js/progress-performance-client.js" },
  { source: "src/client/progress-program-adjustments-client.ts", output: "public/js/progress-program-adjustments-client.js" },
  { source: "src/client/progress-test-week-client.ts", output: "public/js/progress-test-week-client.js" },
  { source: "src/client/progress-program-summary-client.ts", output: "public/js/progress-program-summary-client.js" },
  { source: "src/client/progress-program-block-client.ts", output: "public/js/progress-program-block-client.js" },
  { source: "src/client/progress-program-controller.ts", output: "public/js/progress-program-controller.js" },
  { source: "src/client/progress-screen.ts", output: "public/js/05-progress.js" },
  { source: "src/client/capture-provenance-client.ts", output: "public/js/capture-provenance-client.js" },
  { source: "src/client/capture-reads-client.ts", output: "public/js/capture-reads-client.js" },
  { source: "src/client/capture.ts", output: "public/js/04-capture.js" },
  { source: "src/client/settings-routes.ts", output: "public/js/settings-routes.js" },
  { source: "src/client/settings-client.ts", output: "public/js/settings-client.js" },
  { source: "src/client/settings-data-client.ts", output: "public/js/settings-data-client.js" },
  { source: "src/client/settings-data-controller.ts", output: "public/js/settings-data-controller.js" },
  { source: "src/client/settings-agents-client.ts", output: "public/js/settings-agents-client.js" },
  { source: "src/client/settings-agents-controller.ts", output: "public/js/settings-agents-controller.js" },
  { source: "src/client/settings-screen.ts", output: "public/js/settings-screen.js" },
  { source: "src/client/chat-client.ts", output: "public/js/chat-client.js" },
  { source: "src/client/chat-attachment-client.ts", output: "public/js/chat-attachment-client.js" },
  { source: "src/client/chat-composer-focus-client.ts", output: "public/js/chat-composer-focus-client.js" },
  { source: "src/client/chat-message-client.ts", output: "public/js/chat-message-client.js" },
  { source: "src/client/chat-turn-client.ts", output: "public/js/chat-turn-client.js" },
  { source: "src/client/chat-history-client.ts", output: "public/js/chat-history-client.js" },
  { source: "src/client/chat-header-controller.ts", output: "public/js/chat-header-controller.js" },
  { source: "src/client/plan-endurance-client.ts", output: "public/js/plan-endurance-client.js" },
  { source: "src/client/plan-editor-client.ts", output: "public/js/plan-editor-client.js" },
  { source: "src/client/plan-editor-controller.ts", output: "public/js/plan-editor-controller.js" },
  { source: "src/client/chat-screen.ts", output: "public/js/09-plan-chat.js" },
  { source: "src/client/day-fuel-client.ts", output: "public/js/day-fuel-client.js" },
  { source: "src/client/day-fuel-controller.ts", output: "public/js/day-fuel-controller.js" },
  { source: "src/client/meal-plan-client.ts", output: "public/js/meal-plan-client.js" },
  { source: "src/client/meal-recipe-client.ts", output: "public/js/meal-recipe-client.js" },
  { source: "src/client/meal-recipe-controller.ts", output: "public/js/meal-recipe-controller.js" },
  { source: "src/client/meal-swap-controller.ts", output: "public/js/meal-swap-controller.js" },
  { source: "src/client/meal-planner-controller.ts", output: "public/js/meal-planner-controller.js" },
  { source: "src/client/coach-meals-screen.ts", output: "public/js/06-coach-meals.js" },
  { source: "src/client/food-note-client.ts", output: "public/js/food-note-client.js" },
  { source: "src/client/food-detail-controller.ts", output: "public/js/food-detail-controller.js" },
  { source: "src/client/me-profile-controller.ts", output: "public/js/me-profile-controller.js" },
  { source: "src/client/health-client.ts", output: "public/js/health-client.js" },
  { source: "src/client/health-read-client.ts", output: "public/js/health-read-client.js" },
  { source: "src/client/health-standing-client.ts", output: "public/js/health-standing-client.js" },
  { source: "src/client/health-standing-controller.ts", output: "public/js/health-standing-controller.js" },
  { source: "src/client/health-picture-client.ts", output: "public/js/health-picture-client.js" },
  { source: "src/client/health-picture-controller.ts", output: "public/js/health-picture-controller.js" },
  { source: "src/client/health-markers-client.ts", output: "public/js/health-markers-client.js" },
  { source: "src/client/health-markers-controller.ts", output: "public/js/health-markers-controller.js" },
  { source: "src/client/health-directives-client.ts", output: "public/js/health-directives-client.js" },
  { source: "src/client/health-directives-loader-client.ts", output: "public/js/health-directives-loader-client.js" },
  { source: "src/client/health-read-controller.ts", output: "public/js/health-read-controller.js" },
  { source: "src/client/health-learned-client.ts", output: "public/js/health-learned-client.js" },
  { source: "src/client/health-records-client.ts", output: "public/js/health-records-client.js" },
  { source: "src/client/health-doc-upload-controller.ts", output: "public/js/health-doc-upload-controller.js" },
  { source: "src/client/me-records-health-doc-controller.ts", output: "public/js/me-records-health-doc-controller.js" },
  { source: "src/client/memory-client.ts", output: "public/js/memory-client.js" },
  { source: "src/client/me-memory-controller.ts", output: "public/js/me-memory-controller.js" },
  { source: "src/client/life-client.ts", output: "public/js/life-client.js" },
  { source: "src/client/family-client.ts", output: "public/js/family-client.js" },
  { source: "src/client/me-health-screen.ts", output: "public/js/07-me-health.js" },
  { source: "src/client/me-records-screen.ts", output: "public/js/08-me-records.js" },
  { source: "src/client/health-docs-client.ts", output: "public/js/health-docs-client.js" },
  { source: "src/client/route-state.ts", output: "public/js/route-state.js" },
  { source: "src/client/app/router.ts", output: "public/js/app-router.js" },
  { source: "src/client/app/route-sync.ts", output: "public/js/app-route-sync.js" },
  { source: "src/client/app/render-dispatch.ts", output: "public/js/app-render-dispatch.js" },
  { source: "src/client/app/tabs.ts", output: "public/js/app-tabs.js" },
  { source: "src/client/app/job-reconnectors.ts", output: "public/js/app-job-reconnectors.js" },
  { source: "src/client/app/mobile-viewport.ts", output: "public/js/app-mobile-viewport.js" },
  { source: "src/client/app/service-worker.ts", output: "public/js/app-service-worker.js" },
  { source: "src/client/app/discipline-primer.ts", output: "public/js/app-discipline-primer.js" },
  { source: "src/client/app/onboarding.ts", output: "public/js/app-onboarding.js" },
  { source: "src/client/app/startup.ts", output: "public/js/app-startup.js" },
];

const compilerOptions = {
  alwaysStrict: false,
  ignoreDeprecations: "6.0",
  module: ts.ModuleKind.None,
  moduleDetection: ts.ModuleDetectionKind.Legacy,
  removeComments: false,
  target: ts.ScriptTarget.ES2022,
};

function wrapClassicScript(source) {
  return `(() => {\n${source.trimEnd()}\n})();\n`;
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  buildClient();
}
