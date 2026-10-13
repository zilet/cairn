// Test runner for Cairn's verification harness.
//
// Creates fresh throwaway temp DBs BEFORE any module that imports src/db.js is
// loaded, so tests never touch the real data/cairn.db. Tests import the compiled
// dist/*.js (built by the `pretest` script), so the hot path is just node:test.
//
// Scheduling: N worker SLOTS, each owning one temp DATA_DIR/DB_PATH, pull test
// files off ONE shared queue — a slot that finishes a file takes the next one, so
// a slow file never strands a static shard behind it. The queue is ordered
// longest-first (LPT) from the per-file durations the previous run recorded
// (node_modules/.cache/cairn-test/timings.json, never committed), falling back to a
// static estimate for a file with no recorded time (a fresh clone, CI). Every file runs
// in its own `node --test` process, serially within its slot, exactly as before;
// only the ORDER and the slot a file lands in change, and correctness does not
// depend on either (see test/_isolate.mjs).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineAgentsConfig } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// Reset the whole DB before every test (see test/_isolate.mjs) so a slot's
// shared DB can't leak state between the files that land in it — making the
// suite correct regardless of file order or worker count.
const isolateImport = pathToFileURL(path.join(here, "_isolate.mjs")).href;

const args = process.argv.slice(2);
const selectedFiles = [];
let requestedWorkers = Number(process.env.CAIRN_TEST_WORKERS || process.env.TEST_WORKERS || 0);
let reporter = process.env.CAIRN_TEST_REPORTER || "";

for (const arg of args) {
  if (arg.startsWith("--workers=")) {
    requestedWorkers = Number(arg.slice("--workers=".length));
  } else if (arg.startsWith("--reporter=")) {
    reporter = arg.slice("--reporter=".length);
  } else {
    selectedFiles.push(path.resolve(root, arg));
  }
}

const allTestFiles = readdirSync(here)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(here, f));

// Explicit file args are a fast local focus path:
//   node test/run.mjs test/dayRead.test.js
const testFiles = selectedFiles.length ? selectedFiles : allTestFiles;
const cpuCount = typeof availableParallelism === "function" ? availableParallelism() : 4;
// Leave a core for the orchestrator and the OS. The cap is measured, not guessed: on a
// 14-core (10 performance + 4 efficiency) machine, 8 → 10 → 12 workers took the suite from
// ~39 s to ~36 s to ~33 s, and 13–14 were no faster. It scales down cleanly on
// small CI (a 4-core runner → 3 slots, a 2-core box → 1). Correctness is
// worker-count-independent (see test/_isolate.mjs), so this knob is purely about speed.
const WORKER_CAP = 12;
const defaultWorkers = Math.min(WORKER_CAP, Math.max(1, cpuCount - 1), testFiles.length);
const workers = Math.max(
  1,
  Math.min(
    testFiles.length,
    Number.isFinite(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : defaultWorkers
  )
);
// A per-file process reports to a buffer we print only for a failing file (or for every
// file when one slot runs the suite serially), so `spec` costs nothing on a green run and
// reads well on a red one.
reporter ||= "spec";
const printEveryFile = workers === 1 || process.env.CAIRN_TEST_VERBOSE === "1";

// --- Duration-aware ordering -------------------------------------------------------------
// Durations measured by the previous run, keyed by the path relative to the repo. Kept
// under node_modules/.cache (git-ignored, dropped by `npm ci`), overridable for CI caching.
const timingsFile =
  process.env.CAIRN_TEST_TIMINGS || path.join(root, "node_modules", ".cache", "cairn-test", "timings.json");

function readTimings() {
  try {
    const parsed = JSON.parse(readFileSync(timingsFile, "utf8"));
    return parsed && typeof parsed.files === "object" && parsed.files ? parsed.files : {};
  } catch {
    return {};
  }
}

const relOf = (file) => path.relative(root, file).split(path.sep).join("/");
const previous = readTimings();
// No recorded time (a fresh clone, CI): estimate. Measured over this suite, a file's size
// barely predicts its cost (r ≈ 0.1) but the child processes it starts do — the installer
// tests spawn the POSIX installer dozens of times each — so count the calls that start one.
// Crude, but in a replay of measured durations it schedules within ~1 s of perfect at 12
// workers, and at 3–4 workers (CI) the dynamic queue alone is already near the ideal.
const PROCESS_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork|run)\(/g;
function estimateMs(file) {
  const known = previous[relOf(file)];
  if (Number.isFinite(known) && known > 0) return known;
  let source = "";
  try {
    source = readFileSync(file, "utf8");
  } catch {}
  return 200 + source.length / 512 + (source.match(PROCESS_CALL)?.length ?? 0) * 100;
}
const queue = testFiles
  .map((file, index) => ({ file, index, estimate: estimateMs(file) }))
  .sort((a, b) => b.estimate - a.estimate || a.index - b.index);

// The suite is offline, exactly like CI (which has no agent CLI installed). A developer
// machine does have them, and anything that picks an agent — an activity's enrichment
// job, a Brief read asked for fresh — would probe every CLI in agents.json and could run
// one for real (network, a login, a bill). Each slot gets a copy of agents.json whose
// real CLIs point at commands that do not exist, so they read "not installed" everywhere;
// names, args and capabilities are untouched, and the offline `stub` stays as it is.
// A test that needs its own agent table still sets AGENTS_CONFIG itself.
function envFor(dir) {
  return {
    ...process.env,
    DATA_DIR: dir,
    DB_PATH: path.join(dir, "cairn-test.db"),
    AGENTS_CONFIG: offlineAgentsConfig(dir),
    // Belt-and-suspenders: make sure no real connector/agent creds leak into a run.
    GEMINI_API_KEY: "",
    GOOGLE_AI_KEY: "",
    GARMIN_USERNAME: "",
    GARMIN_PASSWORD: "",
    // Model ids are env-overridable, and artModelDefaults asserts the compiled-in
    // DEFAULTS. Without this, a developer who exports either variable fails the
    // suite on a config difference rather than a regression.
    GEMINI_TEXT_MODEL: "",
    GEMINI_IMAGE_MODEL: "",
    // The art pipeline's optional per-kind knobs, for the same reason: a
    // developer who exports one of these must not change what the art tests
    // assert. Each art test sets what it needs before importing dist/art.js.
    GEMINI_EXERCISE_IMAGE_MODEL: "",
    ART_EXERCISE_STYLE_REFS: "",
    ART_IMAGE_COST_USD: "",
    ART_EXERCISE_IMAGE_COST_USD: "",
    // The starter picture pack ships real figures once a maintainer builds it; a
    // test that asserts "an exercise miss queues a generation" must not start
    // hitting it. Tests that exercise the pack point this at their own fixture dir.
    CAIRN_STARTER_ART_DIR: path.join(dir, "starter-art-none"),
    // Offline and deterministic: the background exercise-guide import never runs.
    CAIRN_GUIDE_AUTO_IMPORT: "0",
    // Feedback defaults to the project's hosted service; "" means no service, so no
    // test (and no scheduler tick) can POST feedback or a usage ping for real.
    CAIRN_FEEDBACK_URL: "",
  };
}

// Default (process) isolation on purpose: under `--test-isolation=none` a file that
// throws at top level AFTER its first test() exits 0 with every later test silently
// unregistered. One extra process start per file is the price of a crash failing.
function runFile(file, env) {
  const start = performance.now();
  const child = spawn(process.execPath, ["--import", isolateImport, "--test", `--test-reporter=${reporter}`, file], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (status, signal) => {
      resolve({ file, status: status ?? 1, signal, output, durationMs: Math.round(performance.now() - start) });
    });
  });
}

const results = [];
let next = 0;

async function runSlot(slot) {
  const dir = mkdtempSync(path.join(tmpdir(), `cairn-test-${slot + 1}-`));
  const env = envFor(dir);
  let busyMs = 0;
  let files = 0;
  try {
    while (next < queue.length) {
      const { file } = queue[next++];
      const result = await runFile(file, env);
      busyMs += result.durationMs;
      files += 1;
      if (printEveryFile) {
        process.stdout.write(result.output);
      } else if (result.status !== 0) {
        process.stdout.write(`\n✗ ${relOf(file)} (${result.signal || `exit ${result.status}`})\n${result.output}`);
      } else {
        process.stdout.write(".");
      }
      result.output = "";
      results.push(result);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return { slot, files, busyMs };
}

function writeTimings() {
  // Merge, so a focused run (explicit file args) refines a few entries without dropping the
  // rest; a file that no longer exists falls out on the next full run.
  const merged = selectedFiles.length ? { ...previous } : {};
  for (const result of results) merged[relOf(result.file)] = result.durationMs;
  try {
    mkdirSync(path.dirname(timingsFile), { recursive: true });
    const tmp = `${timingsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, files: merged })}\n`);
    renameSync(tmp, timingsFile);
  } catch {
    // A read-only checkout just falls back to the static estimate next time.
  }
}

const started = performance.now();
if (workers > 1) {
  console.log(`Running ${testFiles.length} test files on ${workers} isolated DB workers (longest first)...`);
}
const slots = await Promise.all(Array.from({ length: workers }, (_, slot) => runSlot(slot)));
const wallMs = performance.now() - started;
writeTimings();

const failures = results.filter((result) => result.status !== 0);
if (!printEveryFile) process.stdout.write("\n");
const busiest = Math.max(...slots.map((s) => s.busyMs));
const idlest = Math.min(...slots.map((s) => s.busyMs));
console.log(
  `${failures.length ? "✗" : "✓"} ${results.length} file(s) on ${workers} worker(s) in ${(wallMs / 1000).toFixed(1)}s` +
    ` (worker busy ${(idlest / 1000).toFixed(1)}–${(busiest / 1000).toFixed(1)}s)`
);
if (process.env.CAIRN_TEST_SLOWEST) {
  const count = Number(process.env.CAIRN_TEST_SLOWEST) || 15;
  for (const r of results.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, count)) {
    console.log(`  ${(r.durationMs / 1000).toFixed(2)}s  ${relOf(r.file)}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} test file(s) failed:`);
  for (const failure of failures.toSorted((a, b) => relOf(a.file).localeCompare(relOf(b.file)))) {
    console.error(`  ✗ ${relOf(failure.file)} (${failure.signal || `exit ${failure.status}`})`);
  }
  process.exit(1);
}
