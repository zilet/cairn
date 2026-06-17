// Test runner for Cairn's verification harness.
//
// Creates ONE fresh throwaway temp DB for the whole `node --test` run and points
// the app's DATA_DIR / DB_PATH at it BEFORE any module that imports src/db.js is
// loaded, so tests never touch the real data/cairn.db. The temp dir is removed on
// exit. Tests import the compiled dist/*.js (built by the `pretest` script), so
// there is no extra TypeScript toolchain in the test path — just node:test.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Explicit list of test files (everything matching *.test.js in this dir). We
// pass them by name rather than the directory so node:test runs each file in its
// own context but shares the one temp DB this process set up.
const testFiles = readdirSync(here)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(here, f));

// A unique temp directory per invocation — guarantees a clean, empty SQLite DB
// that boots through the full migration ladder. NEVER the repo's real data dir.
const dir = mkdtempSync(path.join(tmpdir(), "cairn-test-"));

const env = {
  ...process.env,
  DATA_DIR: dir,
  DB_PATH: path.join(dir, "cairn-test.db"),
  // Belt-and-suspenders: make sure no real connector/agent creds leak into a run.
  GEMINI_API_KEY: "",
  GOOGLE_AI_KEY: "",
  GARMIN_USERNAME: "",
  GARMIN_PASSWORD: "",
};

let code = 1;
try {
  const res = spawnSync(
    process.execPath,
    // --test-concurrency=1 runs the files SERIALLY. Every file imports dist/db.js
    // and opens the SAME shared temp SQLite DB; running them in parallel processes
    // would contend on the WAL lock during migration/writes. Serial keeps it
    // deterministic and offline.
    ["--test", "--test-concurrency=1", "--test-reporter=spec", ...testFiles],
    { cwd: root, env, stdio: "inherit" }
  );
  code = res.status ?? 1;
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(code);
