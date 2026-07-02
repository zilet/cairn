#!/usr/bin/env node
// Guard generated browser output while the client migrates to src/client/*.ts.
// The client build must be deterministic: if running it changes a tracked output,
// commit that output with the source change and bump public/sw.js when required.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLES, CLIENT_OUTPUTS } from "./build-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Guard both the per-file outputs AND the concatenated bundles index.html loads:
// each must exist and be byte-identical after a clean rebuild.
const outputs = [...CLIENT_OUTPUTS.map((item) => item.output), ...BUNDLES.map((bundle) => bundle.output)];

function readOutput(file) {
  const abs = path.join(root, file);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

for (const file of outputs) {
  if (!existsSync(path.join(root, file))) {
    console.error(`✗ client build output is missing: ${file}`);
    process.exit(1);
  }
}

const before = new Map(outputs.map((file) => [file, readOutput(file)]));
execFileSync(process.execPath, ["scripts/build-client.mjs"], { cwd: root, stdio: "inherit" });

const changed = outputs.filter((file) => before.get(file) !== readOutput(file));
if (changed.length) {
  console.error("✗ client build output was stale. Commit the generated output with the source change:");
  for (const file of changed) console.error(`    ${file}`);
  process.exit(1);
}

console.log(`✓ client build output is up to date (${outputs.length} file${outputs.length === 1 ? "" : "s"})`);
