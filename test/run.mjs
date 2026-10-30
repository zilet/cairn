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
// (.tsbuildcache/cairn-test-timings.json, never committed), falling back to a
// static estimate for a file with no recorded time (a fresh clone, CI). Every file runs
// in its own `node --test` process, serially within its slot; only the ORDER and the
// slot a file lands in change, and correctness does not depend on either (see
// test/_isolate.mjs).
//
// Guardrails — every test file runs inside limits, so one runaway cannot take the
// machine down (a single file once grew to 29 GB). Each is an env knob:
//   CAIRN_TEST_HEAP_MB=1536        V8 heap cap per test process (--max-old-space-size), and
//                                  through NODE_OPTIONS for any node process a test starts.
//   CAIRN_TEST_RSS_MB=2048         resident-memory budget for a file's whole process group,
//                                  sampled every 250 ms (ps; /proc on Linux). Over it, the
//                                  group is killed and the file fails "exceeded memory budget".
//   CAIRN_TEST_FILE_TIMEOUT_MS     wall-clock limit per file. Default: 4× the file's recorded
//                                  duration, at least 60 s, at most 120 s (120 s with no
//                                  record). On expiry the whole process group is killed
//                                  (grandchildren too) and the file fails "timed out".
//   CAIRN_TEST_WORKERS             worker count. Default: min(12, cores − 1), and never more
//                                  than available memory × 0.6 / CAIRN_TEST_WORKER_MB (default:
//                                  1.5× the heaviest file's recorded peak RSS, 512 MB to the
//                                  heap cap) — the line it prints says which bound won.
//   CAIRN_TEST_WARN_MS=5000        a file past either line is marked "over budget" in the
//   CAIRN_TEST_WARN_RSS_MB=600     summary of a full run (a warning; it does not fail).
// A bare `node --test` bypasses all of this (and the per-test DB wipe): use this runner.
//
// Measurement: each run records every file's duration and peak RSS (the larger of the
// process group's sampled peak and each node process's own maxRSS at exit). A full run
// prints the five slowest and five heaviest files and anything over budget.
//
// Selection: `--changed[=<ref>]` (npm run test:changed) runs only the files a change can
// affect — see test/_select.mjs. `--list` prints the files it would run and exits.
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, freemem, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineAgentsConfig } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// Reset the whole DB before every test (see test/_isolate.mjs) so a slot's
// shared DB can't leak state between the files that land in it — making the
// suite correct regardless of file order or worker count.
const isolateImport = pathToFileURL(path.join(here, "_isolate.mjs")).href;

const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const HEAP_MB = envNumber("CAIRN_TEST_HEAP_MB", 1536);
const RSS_MB = envNumber("CAIRN_TEST_RSS_MB", 2048);
const FIXED_TIMEOUT_MS = envNumber("CAIRN_TEST_FILE_TIMEOUT_MS", 0);
const WARN_MS = envNumber("CAIRN_TEST_WARN_MS", 5000);
const WARN_RSS_MB = envNumber("CAIRN_TEST_WARN_RSS_MB", 600);
const TIMEOUT_FLOOR_MS = 60_000;
const TIMEOUT_CEILING_MS = 120_000;
const SAMPLE_MS = 250;

const args = process.argv.slice(2);
const selectedFiles = [];
let requestedWorkers = Number(process.env.CAIRN_TEST_WORKERS || process.env.TEST_WORKERS || 0);
let reporter = process.env.CAIRN_TEST_REPORTER || "";
let changedRef = null;
let listOnly = false;

for (const arg of args) {
  if (arg.startsWith("--workers=")) {
    requestedWorkers = Number(arg.slice("--workers=".length));
  } else if (arg.startsWith("--reporter=")) {
    reporter = arg.slice("--reporter=".length);
  } else if (arg === "--changed" || arg.startsWith("--changed=")) {
    changedRef = arg.includes("=") ? arg.slice("--changed=".length) : "";
  } else if (arg === "--list") {
    listOnly = true;
  } else {
    selectedFiles.push(path.resolve(root, arg));
  }
}

const allTestFiles = readdirSync(here)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(here, f));
const relOf = (file) => path.relative(root, file).split(path.sep).join("/");

// Explicit file args are a fast local focus path:
//   node test/run.mjs test/dayRead.test.js
let testFiles = selectedFiles.length ? selectedFiles : allTestFiles;
const fullRun = !selectedFiles.length && changedRef === null;

if (changedRef !== null) {
  const { changedFiles, selectTests } = await import("./_select.mjs");
  let pick;
  try {
    const { files, base } = changedFiles(root, changedRef || undefined);
    pick = selectTests({ root, changed: files, testFiles });
    pick.reason = `${pick.reason}; against ${base}`;
  } catch (error) {
    pick = {
      selected: testFiles,
      full: true,
      reason: `full suite: git could not list changes (${error.message})`,
      graphMs: 0,
    };
  }
  console.log(
    `${pick.selected.length} of ${testFiles.length} files selected (${pick.reason})` +
      (pick.graphMs ? ` [graph ${Math.round(pick.graphMs)} ms]` : "")
  );
  testFiles = pick.selected;
  if (!testFiles.length) process.exit(0);
}
if (listOnly) {
  for (const file of testFiles) console.log(relOf(file));
  process.exit(0);
}

// --- Duration-aware ordering -------------------------------------------------------------
// Durations (and peak RSS) measured by the previous run, keyed by the path relative to the
// repo. Kept in .tsbuildcache/ (ignored, beside the incremental tsc caches) so `npm ci`
// keeps it, overridable for CI caching. Version 1 stored `{ files: { path: ms } }`; version 2 stores
// `{ files: { path: { ms, rssMb } } }`. Both read.
const timingsFile = process.env.CAIRN_TEST_TIMINGS || path.join(root, ".tsbuildcache", "cairn-test-timings.json");

function readTimings() {
  try {
    const parsed = JSON.parse(readFileSync(timingsFile, "utf8"));
    const files = parsed && typeof parsed.files === "object" && parsed.files ? parsed.files : {};
    const out = {};
    for (const [file, value] of Object.entries(files)) {
      if (typeof value === "number") out[file] = { ms: value, rssMb: null };
      else if (value && Number.isFinite(value.ms)) out[file] = { ms: value.ms, rssMb: value.rssMb ?? null };
    }
    return out;
  } catch {
    return {};
  }
}

const previous = readTimings();

// --- Worker count: cores, then memory -----------------------------------------------------
const cpuCount = typeof availableParallelism === "function" ? availableParallelism() : 4;
// Leave a core for the orchestrator and the OS. The cap is measured, not guessed: on a
// 14-core (10 performance + 4 efficiency) machine, 8 → 10 → 12 workers took the suite from
// ~39 s to ~36 s to ~33 s, and 13–14 were no faster. It scales down cleanly on
// small CI (a 4-core runner → 3 slots, a 2-core box → 1). Correctness is
// worker-count-independent (see test/_isolate.mjs), so this knob is purely about speed.
const WORKER_CAP = 12;
const cpuWorkers = Math.min(WORKER_CAP, Math.max(1, cpuCount - 1));
// Memory: never start more workers than 60% of what is available can hold at the expected
// peak per worker — the heaviest file the last run measured, with 50% headroom (512 MB at
// least, the heap cap at most; 1 GB before anything is recorded). Reserving the full heap
// cap per worker instead held a 16 GB runner to 3 workers (165 s against 101 s on 9) for a
// suite whose heaviest file peaks near 450 MB; a runaway is the RSS budget's job, not the
// worker count's. process.availableMemory() is the reclaimable-inclusive and cgroup-aware
// number (a container's limit, macOS's inactive pages); os.freemem() alone counts only
// never-used pages on macOS and reads a third low there.
const heaviestMb = Math.max(0, ...Object.values(previous).map((t) => t.rssMb ?? 0));
const WORKER_MB = envNumber(
  "CAIRN_TEST_WORKER_MB",
  heaviestMb ? Math.min(HEAP_MB, Math.max(512, Math.round(heaviestMb * 1.5))) : Math.min(HEAP_MB, 1024)
);
const availableBytes =
  typeof process.availableMemory === "function" ? Math.max(0, process.availableMemory()) || freemem() : freemem();
const memoryWorkers = Math.max(1, Math.floor((availableBytes * 0.6) / (WORKER_MB * 2 ** 20)));
const requested = Number.isFinite(requestedWorkers) && requestedWorkers > 0 ? Math.trunc(requestedWorkers) : 0;
const workers = Math.max(1, Math.min(testFiles.length, requested || cpuWorkers, memoryWorkers));
const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);
const workerWhy =
  workers === testFiles.length && testFiles.length < Math.min(requested || cpuWorkers, memoryWorkers)
    ? "one per file"
    : memoryWorkers < (requested || cpuWorkers)
      ? `memory-bound: ${gb(availableBytes)} GB available × 0.6 / ${WORKER_MB} MB per worker; cores allow ${requested || cpuWorkers}`
      : requested
        ? `requested; memory allows ${memoryWorkers} at ${WORKER_MB} MB each`
        : `cores: ${cpuCount} − 1, cap ${WORKER_CAP}; memory allows ${memoryWorkers} at ${WORKER_MB} MB each`;

// A per-file process reports to a buffer we print only for a failing file (or for every
// file when one slot runs the suite serially), so `spec` costs nothing on a green run and
// reads well on a red one.
reporter ||= "spec";
const printEveryFile = workers === 1 || process.env.CAIRN_TEST_VERBOSE === "1";

// No recorded time (a fresh clone, CI): estimate. Measured over this suite, a file's size
// barely predicts its cost (r ≈ 0.1) but the child processes it starts do — the installer
// tests spawn the POSIX installer dozens of times each — so count the calls that start one.
// Crude, but in a replay of measured durations it schedules within ~1 s of perfect at 12
// workers, and at 3–4 workers (CI) the dynamic queue alone is already near the ideal.
const PROCESS_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|fork|run)\(/g;
function estimateMs(file) {
  const known = previous[relOf(file)]?.ms;
  if (Number.isFinite(known) && known > 0) return known;
  let source = "";
  try {
    source = readFileSync(file, "utf8");
  } catch {}
  return 200 + source.length / 512 + (source.match(PROCESS_CALL)?.length ?? 0) * 100;
}
function timeoutFor(file) {
  if (FIXED_TIMEOUT_MS) return FIXED_TIMEOUT_MS;
  const known = previous[relOf(file)]?.ms;
  if (!(Number.isFinite(known) && known > 0)) return TIMEOUT_CEILING_MS;
  return Math.min(TIMEOUT_CEILING_MS, Math.max(TIMEOUT_FLOOR_MS, 4 * known));
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
const heapFlag = `--max-old-space-size=${HEAP_MB}`;
function envFor(dir) {
  return {
    ...process.env,
    // Any node process a test starts inherits the heap cap too (a flag it passes itself wins).
    NODE_OPTIONS: [process.env.NODE_OPTIONS, heapFlag].filter(Boolean).join(" "),
    // Each node process in the file appends its own maxRSS here at exit (test/_isolate.mjs).
    CAIRN_TEST_RSS_FILE: path.join(dir, "max-rss.txt"),
    // The lifeline: the file's group leader kills its own group if this runner dies, even by
    // SIGKILL, which no handler here can catch (test/_isolate.mjs).
    CAIRN_TEST_RUNNER_PID: String(process.pid),
    // Where the runner cannot sample processes, the file's process guards itself and
    // leaves its verdict here (see groupSampling).
    ...(groupSampling
      ? {}
      : { CAIRN_TEST_RSS_GUARD_MB: String(RSS_MB), CAIRN_TEST_RSS_GUARD_FILE: path.join(dir, "rss-guard.txt") }),
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

// --- The RSS watchdog --------------------------------------------------------------------
// Every file runs as the leader of its own process group, so one sample of the process
// table gives each running file's total resident memory, grandchildren included.
const running = new Map(); // pgid → { peakKb, kill(reason) }
const pageKb = (() => {
  if (process.platform !== "linux") return 4;
  try {
    const pages = Number(readFileSync("/proc/self/statm", "utf8").split(" ")[1]);
    const kb = process.memoryUsage().rss / 1024 / pages;
    return 2 ** Math.round(Math.log2(kb));
  } catch {
    return 4;
  }
})();
// pgid → total RSS in KB, from /proc on Linux (no fork) or one `ps` elsewhere.
function sampleGroups() {
  if (process.platform === "linux" && existsSync("/proc/self/stat")) {
    const totals = new Map();
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const pgid = Number(fields[2]);
        if (!running.has(pgid)) continue;
        totals.set(pgid, (totals.get(pgid) ?? 0) + Number(fields[21]) * pageKb);
      } catch {}
    }
    return Promise.resolve(totals);
  }
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pgid=,rss="], { maxBuffer: 16 * 2 ** 20 }, (error, stdout) => {
      if (error) return reject(error);
      const totals = new Map();
      for (const line of stdout.split("\n")) {
        const [pgid, rss] = line.trim().split(/\s+/).map(Number);
        if (running.has(pgid)) totals.set(pgid, (totals.get(pgid) ?? 0) + rss);
      }
      resolve(totals);
    });
  });
}
// Can this process see other processes' memory? /proc on Linux; elsewhere `ps`, which an
// OS sandbox (an agent's, a fleet runner's) may refuse. Without it each test process
// watches its own RSS from a worker thread instead (test/_isolate.mjs) — a thread, so a
// main thread stuck in a synchronous runaway (a util.inspect over a circular graph) is
// still caught — and the runner reads the verdict it leaves. That covers the file's own
// process, not grandchildren; the heap cap and the timeout still cover everything.
const groupSampling = (() => {
  if (process.platform === "win32") return false;
  if (process.platform === "linux" && existsSync("/proc/self/stat")) return true;
  try {
    execFileSync("ps", ["-o", "rss=", "-p", String(process.pid)], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
let watchdogNote = groupSampling
  ? ""
  : "RSS watchdog: cannot sample other processes here (ps refused); each test process watches its own";
let sampling = false;
const sampler = !groupSampling
  ? null
  : setInterval(async () => {
      if (sampling || !running.size) return;
      sampling = true;
      try {
        const totals = await sampleGroups();
        for (const [pgid, kb] of totals) {
          const entry = running.get(pgid);
          if (!entry) continue;
          entry.peakKb = Math.max(entry.peakKb, kb);
          if (kb > RSS_MB * 1024) entry.kill(`exceeded memory budget (${Math.round(kb / 1024)} MB > ${RSS_MB} MB)`);
        }
      } catch (error) {
        // `ps` failed after the probe passed: the heap cap and the timeout still hold.
        clearInterval(sampler);
        watchdogNote = `RSS watchdog off: cannot sample processes (${String(error.message || error).split("\n")[0]})`;
      } finally {
        sampling = false;
      }
    }, SAMPLE_MS);
sampler?.unref();

function killGroup(child, signal = "SIGKILL") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
// The runner owns its children's groups: a Ctrl-C (which no longer reaches a detached
// group) or a kill takes every running file down with it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const entry of running.values()) entry.killNow();
    process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1));
  });
}
process.on("exit", () => {
  for (const entry of running.values()) entry.killNow();
});

function readMaxRssKb(rssFile) {
  try {
    return Math.max(0, ...readFileSync(rssFile, "utf8").split("\n").filter(Boolean).map(Number));
  } catch {
    return 0;
  }
}

// Default (process) isolation on purpose: under `--test-isolation=none` a file that
// throws at top level AFTER its first test() exits 0 with every later test silently
// unregistered. One extra process start per file is the price of a crash failing.
function runFile(file, env) {
  const start = performance.now();
  try {
    writeFileSync(env.CAIRN_TEST_RSS_FILE, "");
    if (env.CAIRN_TEST_RSS_GUARD_FILE) writeFileSync(env.CAIRN_TEST_RSS_GUARD_FILE, "");
  } catch {}
  const child = spawn(
    process.execPath,
    [heapFlag, "--import", isolateImport, "--test", `--test-reporter=${reporter}`, file],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }
  );
  let output = "";
  let failure = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const entry = {
    peakKb: 0,
    kill(reason) {
      if (failure) return;
      failure = reason;
      killGroup(child);
    },
    killNow() {
      killGroup(child);
    },
  };
  if (child.pid) running.set(child.pid, entry);
  const limitMs = timeoutFor(file);
  const timer = setTimeout(() => entry.kill(`timed out after ${Math.round(limitMs / 1000)}s`), limitMs);
  return new Promise((resolve) => {
    // The host could not start the process at all (EAGAIN, ENOMEM): that file fails, the
    // run goes on. An error after a successful start still ends in "exit" below.
    child.on("error", (error) => {
      if (child.pid) return;
      clearTimeout(timer);
      failure ??= `could not start (${error.code || error.message})`;
      resolve({
        file,
        status: 1,
        signal: null,
        failure,
        output: `✗ ${relOf(file)}: ${failure}\n`,
        durationMs: Math.round(performance.now() - start),
        rssMb: null,
      });
    });
    // `exit`, not `close`: a grandchild that inherited the pipes must not hold the slot.
    // Whatever the file left behind in its group goes with it.
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      running.delete(child.pid);
      killGroup(child);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        const rssKb = Math.max(entry.peakKb, readMaxRssKb(env.CAIRN_TEST_RSS_FILE));
        if (!failure && env.CAIRN_TEST_RSS_GUARD_FILE) {
          let guarded = "";
          try {
            guarded = readFileSync(env.CAIRN_TEST_RSS_GUARD_FILE, "utf8").trim();
          } catch {}
          if (guarded) failure = `exceeded memory budget (${guarded} MB > ${RSS_MB} MB)`;
        }
        resolve({
          file,
          status: failure ? 1 : (status ?? 1),
          signal,
          failure,
          output: failure ? `${output}\n✗ ${relOf(file)}: ${failure}\n` : output,
          durationMs: Math.round(performance.now() - start),
          rssMb: rssKb ? Math.round(rssKb / 1024) : null,
        });
      };
      // Let the pipes drain what the process wrote before it exited ("close" follows once
      // they have; the group kill above released any grandchild still holding them).
      const guard = setTimeout(finish, 1000);
      child.once("close", finish);
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
        process.stdout.write(
          `\n✗ ${relOf(file)} (${result.failure || result.signal || `exit ${result.status}`})\n${result.output}`
        );
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
  const merged = fullRun ? {} : { ...previous };
  for (const result of results) {
    // A killed file's numbers describe the kill, not the file.
    if (result.failure) continue;
    merged[relOf(result.file)] = { ms: result.durationMs, rssMb: result.rssMb };
  }
  try {
    mkdirSync(path.dirname(timingsFile), { recursive: true });
    const tmp = `${timingsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 2, files: merged })}\n`);
    renameSync(tmp, timingsFile);
  } catch {
    // A read-only checkout just falls back to the static estimate next time.
  }
}

const started = performance.now();
const recorded = testFiles.filter((file) => previous[relOf(file)]).length;
console.log(
  `Running ${testFiles.length} test file(s) on ${workers} isolated DB worker(s) (${workerWhy}), longest first` +
    ` (${recorded === testFiles.length ? "all" : recorded} recorded)...`
);
const slots = await Promise.all(Array.from({ length: workers }, (_, slot) => runSlot(slot)));
const wallMs = performance.now() - started;
clearInterval(sampler);
writeTimings();

const failures = results.filter((result) => result.status !== 0);
if (!printEveryFile) process.stdout.write("\n");
const busiest = Math.max(...slots.map((s) => s.busyMs));
const idlest = Math.min(...slots.map((s) => s.busyMs));
console.log(
  `${failures.length ? "✗" : "✓"} ${results.length} file(s) on ${workers} worker(s) in ${(wallMs / 1000).toFixed(1)}s` +
    ` (worker busy ${(idlest / 1000).toFixed(1)}–${(busiest / 1000).toFixed(1)}s)`
);
if (watchdogNote) console.log(`  ${watchdogNote}`);

// What the run cost, file by file: always on a full run, on request otherwise.
const fmt = (r) =>
  `  ${(r.durationMs / 1000).toFixed(1).padStart(5)}s ${r.rssMb == null ? "    ?" : String(r.rssMb).padStart(5)} MB  ${relOf(r.file)}`;
const overBudget = (r) => r.durationMs > WARN_MS || (r.rssMb ?? 0) > WARN_RSS_MB;
const tailCount = Number(process.env.CAIRN_TEST_SLOWEST) || (fullRun ? 5 : 0);
if (tailCount && results.length) {
  const ok = results.filter((r) => !r.failure);
  console.log(`slowest:`);
  for (const r of ok.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, tailCount)) console.log(fmt(r));
  console.log(`heaviest:`);
  for (const r of ok.toSorted((a, b) => (b.rssMb ?? 0) - (a.rssMb ?? 0)).slice(0, tailCount)) console.log(fmt(r));
  const over = ok.filter(overBudget).toSorted((a, b) => b.durationMs - a.durationMs);
  if (over.length) {
    console.log(`over budget (> ${WARN_MS / 1000}s or > ${WARN_RSS_MB} MB): ${over.length}`);
    for (const r of over) console.log(fmt(r));
  }
}

if (failures.length) {
  console.error(`\n${failures.length} test file(s) failed:`);
  for (const failure of failures.toSorted((a, b) => relOf(a.file).localeCompare(relOf(b.file)))) {
    console.error(`  ✗ ${relOf(failure.file)} (${failure.failure || failure.signal || `exit ${failure.status}`})`);
  }
  process.exit(1);
}
