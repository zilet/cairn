// test/run.mjs starts each file as its own process — `node --import test/_isolate.mjs
// <file>`, no `node --test` parent — so the verdicts the parent used to give have to come
// from the file's process itself. These pin them against real nested runs: a file sees
// the environment a `--test` child saw, every way a file can go wrong still fails it, and
// the closing line counts the tests that ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "test", "run.mjs");

function runFixtures(sources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-direct-"));
  try {
    const files = Object.entries(sources).map(([name, source]) => {
      const file = path.join(dir, `${name}.test.js`);
      fs.writeFileSync(file, source);
      return file;
    });
    // The nested runner must not inherit this file's NODE_TEST_CONTEXT (run.mjs drops it
    // for its files anyway); its own timings stay out of the checkout's.
    const env = { ...process.env, CAIRN_TEST_TIMINGS: path.join(dir, "timings.json"), CAIRN_TEST_VERBOSE: "" };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, "--workers=2", ...files], { cwd: root, env, encoding: "utf8" });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a file sees what a node --test child saw, and its parent is the runner", () => {
  const { status, out } = runFixtures({
    context: `import { test } from "node:test";
import assert from "node:assert/strict";
test("context", () => {
  assert.equal(process.env.NODE_TEST_CONTEXT, "child-v8");
  assert.equal(String(process.ppid), process.env.CAIRN_TEST_RUNNER_PID);
});
test("second", () => {});
`,
  });
  assert.equal(status, 0, out);
  assert.match(out, /^ {2}2 tests: 2 pass$/m, "the closing line sums the reporter's counts");
});

test("a failed test, a late top-level throw and an early clean exit each fail their file", () => {
  const { status, out } = runFixtures({
    failing: `import { test } from "node:test";
test("passes", () => {});
test("fails", () => { throw new Error("no"); });
`,
    late: `import { test } from "node:test";
test("registered", () => {});
throw new Error("after the first test");
`,
    early: `import { test } from "node:test";
test("still running", async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
setTimeout(() => process.exit(0), 20);
`,
    clean: `import { test } from "node:test";
test("fine", () => {});
`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /3 test file\(s\) failed/);
  assert.match(out, /✗ .*failing\.test\.js \(exit 1\)/);
  assert.match(out, /✗ .*late\.test\.js \(exit \d+\)/);
  assert.match(out, /✗ .*early\.test\.js \(exited 0 without the reporter's test summary\)/);
  assert.doesNotMatch(out, /✗ .*clean\.test\.js/);
});
