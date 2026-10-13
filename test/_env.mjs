// The offline floor every test process stands on. test/run.mjs hands each worker a
// throwaway DATA_DIR/DB_PATH and an offline AGENTS_CONFIG; `test/_offline.mjs` (imported
// by `_isolate.mjs` and `_seed.js`) gives a process started WITHOUT the runner
// (`node --test file`, `node --import ./test/_isolate.mjs --test file`) the same floor.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A copy of agents.json whose real CLIs point at commands that do not exist, so they
// read "not installed" everywhere; names, args and capabilities are untouched, and the
// offline `stub` stays as it is.
export function offlineAgentsConfig(dir) {
  const agents = JSON.parse(readFileSync(path.join(root, "agents.json"), "utf8"));
  for (const [name, def] of Object.entries(agents)) {
    if (name !== "stub" && def && typeof def === "object") def.command = `cairn-test-offline-${name}`;
  }
  const file = path.join(dir, "agents.offline.json");
  writeFileSync(file, JSON.stringify(agents));
  return file;
}

// Fill in only what the environment left unset: a throwaway DATA_DIR, a DB inside it,
// and the offline agents table. Never touches a value the runner or a test already set.
export function applyOfflineDefaults(env = process.env) {
  if (!env.DATA_DIR) env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cairn-test-bare-"));
  if (!env.DB_PATH) env.DB_PATH = path.join(env.DATA_DIR, "cairn-test.db");
  if (!env.AGENTS_CONFIG) env.AGENTS_CONFIG = offlineAgentsConfig(env.DATA_DIR);
}
