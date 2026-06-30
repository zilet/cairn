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
  { source: "src/client/format-utils.ts", output: "public/js/format-utils.js" },
  { source: "src/client/api-client.ts", output: "public/js/api-client.js" },
  { source: "src/client/app/download.ts", output: "public/js/app-download.js" },
  { source: "src/client/app/state.ts", output: "public/js/01-core.js" },
  { source: "src/client/today-activity-client.ts", output: "public/js/today-activity-client.js" },
  { source: "src/client/save-bar.ts", output: "public/js/save-bar.js" },
  { source: "src/client/swr-cache.ts", output: "public/js/swr-cache.js" },
  { source: "src/client/today-agenda-client.ts", output: "public/js/today-agenda-client.js" },
  { source: "src/client/today-training-client.ts", output: "public/js/today-training-client.js" },
  { source: "src/client/cardio-plan-client.ts", output: "public/js/cardio-plan-client.js" },
  { source: "src/client/capture.ts", output: "public/js/04-capture.js" },
  { source: "src/client/settings-routes.ts", output: "public/js/settings-routes.js" },
  { source: "src/client/settings-client.ts", output: "public/js/settings-client.js" },
  { source: "src/client/settings-screen.ts", output: "public/js/settings-screen.js" },
  { source: "src/client/chat-client.ts", output: "public/js/chat-client.js" },
  { source: "src/client/health-client.ts", output: "public/js/health-client.js" },
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
    writeFileSync(outputPath, result.outputText.trimEnd() + "\n");
  }

  console.log(`✓ built client output (${CLIENT_OUTPUTS.length} file${CLIENT_OUTPUTS.length === 1 ? "" : "s"})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  buildClient();
}
