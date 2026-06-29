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
  { source: "src/client/format-utils.ts", output: "public/js/format-utils.js" },
  { source: "src/client/api-client.ts", output: "public/js/api-client.js" },
  { source: "src/client/swr-cache.ts", output: "public/js/swr-cache.js" },
  { source: "src/client/today-agenda-client.ts", output: "public/js/today-agenda-client.js" },
  { source: "src/client/today-training-client.ts", output: "public/js/today-training-client.js" },
  { source: "src/client/settings-routes.ts", output: "public/js/settings-routes.js" },
  { source: "src/client/settings-client.ts", output: "public/js/settings-client.js" },
  { source: "src/client/chat-client.ts", output: "public/js/chat-client.js" },
  { source: "src/client/route-state.ts", output: "public/js/route-state.js" },
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
