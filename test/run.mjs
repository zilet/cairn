// Test runner for Cairn's verification harness.
//
// Creates fresh throwaway temp DBs BEFORE any module that imports src/db.js is
// loaded, so tests never touch the real data/cairn.db. Tests import the compiled
// dist/*.js (built by the `pretest` script), so the hot path is just node:test.
import { availableParallelism } from "node:os";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

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
const defaultWorkers = Math.min(4, Math.max(1, cpuCount), testFiles.length);
const workers = Math.max(
  1,
  Math.min(
    testFiles.length,
    Number.isFinite(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : defaultWorkers
  )
);
reporter ||= workers === 1 ? "spec" : "dot";

function envFor(dir) {
  return {
    ...process.env,
    DATA_DIR: dir,
    DB_PATH: path.join(dir, "cairn-test.db"),
    // Belt-and-suspenders: make sure no real connector/agent creds leak into a run.
    GEMINI_API_KEY: "",
    GOOGLE_AI_KEY: "",
    GARMIN_USERNAME: "",
    GARMIN_PASSWORD: "",
  };
}

function partition(files, count) {
  const shards = Array.from({ length: count }, () => []);
  files.forEach((file, index) => shards[index % count].push(file));
  return shards.filter((shard) => shard.length);
}

function runShard(files, index, total) {
  const dir = mkdtempSync(path.join(tmpdir(), `cairn-test-${index + 1}-`));
  const start = performance.now();
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", `--test-reporter=${reporter}`, ...files], {
    cwd: root,
    env: envFor(dir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve) => {
    child.on("close", (status, signal) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      resolve({
        files,
        index,
        status: status ?? 1,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - start),
        total,
      });
    });
  });
}

const shards = partition(testFiles, workers);
if (workers > 1) {
  console.log(`Running ${testFiles.length} test files across ${shards.length} isolated DB workers...`);
}

const results = await Promise.all(shards.map((files, index) => runShard(files, index, shards.length)));
const failures = results.filter((result) => result.status !== 0);

for (const result of results.toSorted((a, b) => a.index - b.index)) {
  if (failures.length || workers === 1) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } else {
    console.log(
      `✓ worker ${result.index + 1}/${result.total}: ${result.files.length} file(s), ${(result.durationMs / 1000).toFixed(1)}s`
    );
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`✗ worker ${failure.index + 1}/${failure.total} failed with ${failure.signal || failure.status}`);
  }
  process.exit(1);
}
