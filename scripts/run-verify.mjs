#!/usr/bin/env node
import { spawn } from "node:child_process";

// One dependency graph, not phases: every lane starts the moment the lanes it reads from
// have passed, so the tests wait only on the build, never on lint or the docs check.
// Each lane names what it waits on (`after`):
//  - the stylesheet check reads the COMMITTED public/styles.css, which the client build
//    rewrites, so the client build waits on it (else a stale commit reads as current);
//  - the client build is check-client-build-output, which runs build-client.mjs itself and
//    holds the committed index.html's preload table against what it produced (the second
//    build `npm run build` used to add is gone, and so is the second `client:check` that
//    typecheck:client used to repeat);
//  - the server compile and both client typechecks read only sources and run from the start;
//  - every post-build check, and the tests, wait on the outputs they read.
// CAIRN_TEST_SHARD passes straight through to the tests (scripts/verify-split.mjs).
const lanes = [
  { name: "docs", steps: [["npm", "run", "docs:check"]] },
  { name: "actions", steps: [["npm", "run", "actions:check"]] },
  { name: "launch safety", steps: [["npm", "run", "launch:check"]] },
  { name: "schema two-step", steps: [["npm", "run", "schema:check"]] },
  { name: "lint", steps: [["npm", "run", "lint"]] },
  { name: "client style ratchet", steps: [["node", "scripts/check-client-style.mjs"]] },
  { name: "design token ratchet", steps: [["node", "scripts/check-design-tokens.mjs"]] },
  { name: "stylesheet partials", steps: [["node", "scripts/build-styles.mjs", "--check"]] },
  { name: "client contract", steps: [["npm", "run", "tsc", "--", "-p", "tsconfig.client.json"]] },
  { name: "client build types", steps: [["npm", "run", "client:check"]] },
  {
    name: "client build",
    after: ["stylesheet partials"],
    steps: [["node", "scripts/check-client-build-output.mjs"]],
  },
  { name: "server build", steps: [["npm", "run", "tsc", "--"]] },
  { name: "public scripts", after: ["client build"], steps: [["npm", "run", "public:check"]] },
  { name: "service worker cache", after: ["client build"], steps: [["node", "scripts/check-sw-cache.mjs"]] },
  { name: "bundle byte budget", after: ["client build"], steps: [["node", "scripts/check-bundle-budget.mjs"]] },
  { name: "tests", after: ["client build", "server build"], steps: [["npm", "run", "test:built"]] },
];

// The per-route perf budget drives a real Chrome on a throttled profile, so it is opt-in
// (CAIRN_PERF=1) and runs alone after the rest: sharing the CPU with the test shards
// would only add noise to its report-only timings.
const perfLane = { name: "perf budget", steps: [["node", "scripts/check-perf.mjs"]] };

function runStep(argv) {
  const [cmd, ...args] = argv;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ argv, status: status ?? 1, signal, stdout, stderr });
    });
  });
}

async function runJob(job) {
  const start = performance.now();
  const output = [];
  for (const step of job.steps) {
    const result = await runStep(step);
    output.push(result);
    if (result.status !== 0) {
      return { job, status: result.status, signal: result.signal, output, durationMs: Math.round(performance.now() - start) };
    }
  }
  return { job, status: 0, signal: null, output, durationMs: Math.round(performance.now() - start) };
}

function report(result) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`✓ ${result.job.name} (${seconds}s)`);
    return;
  }
  console.error(`\n✗ ${result.job.name} failed after ${seconds}s`);
  for (const step of result.output) {
    console.error(`$ ${step.argv.join(" ")}`);
    process.stdout.write(step.stdout);
    process.stderr.write(step.stderr);
  }
}

// A lane whose prerequisite failed does not run (its inputs are not trustworthy); every
// independent lane still finishes, so one run reports every failure it can.
async function runGraph(jobs) {
  const started = performance.now();
  const pending = new Map();
  const start = (job) => {
    if (!pending.has(job.name)) {
      pending.set(
        job.name,
        (async () => {
          const deps = await Promise.all((job.after ?? []).map((name) => start(jobs.find((j) => j.name === name))));
          const blocked = deps.find((dep) => dep.status !== 0);
          if (blocked) return { job, status: 1, skipped: blocked.job.name, output: [], durationMs: 0 };
          const result = await runJob(job);
          report(result);
          return result;
        })()
      );
    }
    return pending.get(job.name);
  };
  console.log(`Running ${jobs.length} verification lanes, each as soon as its inputs are ready...`);
  const results = await Promise.all(jobs.map(start));
  const skipped = results.filter((result) => result.skipped);
  for (const result of skipped) console.error(`- ${result.job.name} not run: ${result.skipped} failed`);
  const failed = results.filter((result) => result.status !== 0 && !result.skipped);
  console.log(`${failed.length ? "✗" : "✓"} verify lanes in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  if (failed.length) process.exit(1);
}

// CAIRN_VERIFY_ONLY=<lane>[,<lane>] runs just those lanes and what they wait on — the
// split verify's other shards run `tests` this way, building on the same graph.
function onlyLanes(names) {
  const wanted = new Set();
  const add = (name) => {
    const lane = lanes.find((l) => l.name === name);
    if (!lane) {
      console.error(`CAIRN_VERIFY_ONLY: no lane named "${name}" (lanes: ${lanes.map((l) => l.name).join(", ")})`);
      process.exit(2);
    }
    if (wanted.has(lane)) return;
    wanted.add(lane);
    for (const dep of lane.after ?? []) add(dep);
  };
  for (const name of names) add(name);
  return lanes.filter((lane) => wanted.has(lane));
}

const only = (process.env.CAIRN_VERIFY_ONLY || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
await runGraph(only.length ? onlyLanes(only) : lanes);
if (only.length) process.exit(0);
if (process.env.CAIRN_PERF === "1") await runGraph([perfLane]);
else console.log("- perf budget skipped (needs Chrome; set CAIRN_PERF=1 to run it)");
