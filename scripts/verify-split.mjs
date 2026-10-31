#!/usr/bin/env node
// `npm run verify` with its test suite split across several machines at once.
//
//   CAIRN_SPLIT_LAUNCH="<prefix>" node scripts/verify-split.mjs [--shards=2]
//
// Shard 1 runs the whole `npm run verify` (every check, the build, its slice of the tests);
// every other shard runs only verify's `tests` lane and the build lanes it waits on. The launch prefix is whatever
// puts a command on another machine and brings its exit code and written files back (a
// remote runner, `ssh host --`, a container wrapper); with none, the shards run here side by
// side, which only proves the split. Each shard runs `test/run.mjs
// --shard=<i>/<n>`: the runner balances the slices over the recorded durations, so the
// shards finish together and between them run every test file exactly once. Afterwards
// the per-shard timings each one wrote back are merged into the main timings file, so the
// next split is balanced by this run.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shardArg = process.argv.find((arg) => arg.startsWith("--shards="));
const count = Number(shardArg ? shardArg.slice("--shards=".length) : process.env.CAIRN_SPLIT_SHARDS || 2);
if (!Number.isInteger(count) || count < 1) {
  console.error(`--shards must be a positive integer (got ${shardArg ?? count})`);
  process.exit(2);
}
const launch = (process.env.CAIRN_SPLIT_LAUNCH || "").trim();
const timingsFile = process.env.CAIRN_TEST_TIMINGS || path.join(root, ".tsbuildcache", "cairn-test-timings.json");
const shardTimings = (index) => `${timingsFile.replace(/\.json$/, "")}.shard-${index}-of-${count}.json`;

// Leftovers from an earlier split would merge as this run's numbers.
for (let index = 1; index <= count; index++) rmSync(shardTimings(index), { force: true });

function runShard(index) {
  const only = index === 1 ? "" : " CAIRN_VERIFY_ONLY=tests";
  const line = `${launch ? `${launch} ` : ""}env CAIRN_TEST_SHARD=${index}/${count}${only} npm run verify`;
  const start = performance.now();
  const child = spawn("sh", ["-c", line], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${index}/${count}]`;
  let output = "";
  let said;
  const spoke = new Promise((resolve) => {
    said = resolve;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (/\S/.test(chunk)) said();
    });
  }
  const done = new Promise((resolve) => {
    child.on("close", (status, signal) =>
      resolve({ index, tag, line, status: status ?? 1, signal, output, seconds: (performance.now() - start) / 1000 })
    );
  });
  return { spoke, done };
}

function readFiles(file) {
  try {
    const files = JSON.parse(readFileSync(file, "utf8"))?.files;
    return files && typeof files === "object" ? files : null;
  } catch {
    return null;
  }
}

// Every shard back: their union IS a full run, so it replaces the main file (a deleted test
// falls out). A shard missing its file (it died early) leaves its files' old numbers.
function mergeShardTimings() {
  const shards = Array.from({ length: count }, (_, i) => readFiles(shardTimings(i + 1)));
  const complete = shards.every(Boolean);
  const merged = complete ? {} : { ...(readFiles(timingsFile) ?? {}) };
  for (const files of shards) Object.assign(merged, files ?? {});
  if (!Object.keys(merged).length) return "no timings came back";
  const tmp = `${timingsFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 2, files: merged })}\n`);
  renameSync(tmp, timingsFile);
  for (let index = 1; index <= count; index++) rmSync(shardTimings(index), { force: true });
  return `${Object.keys(merged).length} file timings merged${complete ? "" : " (some shards sent none)"}`;
}

console.log(`Verifying on ${count} shard(s)${launch ? ` via: ${launch}` : " here (no CAIRN_SPLIT_LAUNCH)"}...`);
const started = performance.now();
// Each shard starts once the one before it has said something (its launcher placed it) or
// after STAGGER_MS: a launcher that places by current load then sees the earlier shard
// running and puts the next one elsewhere, where starting together would stack them on
// the same idle machine. It costs a few seconds of the first shard's head start.
const STAGGER_MS = Number(process.env.CAIRN_SPLIT_STAGGER_MS ?? 15_000);
const running = [];
for (let index = 1; index <= count; index++) {
  const shard = runShard(index);
  running.push(shard.done);
  if (index < count && STAGGER_MS > 0) await Promise.race([shard.spoke, shard.done, delay(STAGGER_MS)]);
}
const results = await Promise.all(running);
const wall = (performance.now() - started) / 1000;
const merge = existsSync(path.dirname(timingsFile)) ? mergeShardTimings() : "no timings dir";

for (const result of results) {
  if (result.status === 0) {
    // On green, the last lines carry the useful summary (lanes, file counts, slowest).
    const tail = result.output.trimEnd().split("\n").slice(-12);
    console.log(`\n✓ ${result.tag} ${result.seconds.toFixed(1)}s  ${result.line}\n${tail.map((l) => `  ${l}`).join("\n")}`);
  } else {
    console.error(`\n✗ ${result.tag} failed (${result.signal || `exit ${result.status}`}) after ${result.seconds.toFixed(1)}s  ${result.line}`);
    process.stderr.write(result.output);
  }
}
const failed = results.filter((r) => r.status !== 0);
console.log(`\n${failed.length ? "✗" : "✓"} ${count} shard(s) in ${wall.toFixed(1)}s; ${merge}`);
process.exit(failed.length ? 1 : 0);
