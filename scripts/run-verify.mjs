#!/usr/bin/env node
import { spawn } from "node:child_process";

const jobs = [
  { name: "docs", steps: [["npm", "run", "docs:check"]] },
  { name: "actions", steps: [["npm", "run", "actions:check"]] },
  { name: "client types", steps: [["npm", "run", "typecheck:client"]] },
  { name: "public scripts", steps: [["npm", "run", "public:check"]] },
  { name: "service worker cache", steps: [["node", "scripts/check-sw-cache.mjs"]] },
  { name: "launch safety", steps: [["npm", "run", "launch:check"]] },
  {
    name: "server build + tests",
    steps: [
      ["npm", "run", "build"],
      ["npm", "run", "test:built"],
    ],
  },
];

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

console.log(`Running ${jobs.length} verification lanes in parallel...`);
const results = await Promise.all(jobs.map(runJob));
const failures = results.filter((result) => result.status !== 0);

for (const result of results) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`✓ ${result.job.name} (${seconds}s)`);
  }
}

if (failures.length) {
  for (const result of failures) {
    console.error(`\n✗ ${result.job.name} failed after ${(result.durationMs / 1000).toFixed(1)}s`);
    for (const step of result.output) {
      console.error(`$ ${step.argv.join(" ")}`);
      process.stdout.write(step.stdout);
      process.stderr.write(step.stderr);
    }
  }
  process.exit(1);
}
