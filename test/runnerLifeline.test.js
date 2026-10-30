// test/run.mjs starts every file as the leader of its own process group, so a runner
// killed outright (SIGKILL, which no handler catches) must not orphan the groups it was
// running. The leader's lifeline (test/_isolate.mjs) notices the runner is gone and takes
// its whole group down — the file's process and whatever it started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function until(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

test("a SIGKILLed runner takes no test process group with it, and leaves none behind", {
  skip: process.platform === "win32",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-lifeline-"));
  const pidsFile = path.join(dir, "pids.txt");
  const fixture = path.join(dir, "lifeline-fixture.test.js");
  fs.writeFileSync(
    fixture,
    `import { test } from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("hangs with a child", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(pidsFile)}, [process.ppid, process.pid, child.pid].join(" "));
  await new Promise(() => {});
});
`
  );
  // NODE_TEST_CONTEXT would make the nested runner's `node --test` believe it is a child.
  const env = {
    ...process.env,
    CAIRN_TEST_TIMINGS: path.join(dir, "timings.json"),
    CAIRN_TEST_FILE_TIMEOUT_MS: "60000",
  };
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, [path.join(root, "test", "run.mjs"), "--workers=1", fixture], {
    cwd: root,
    env,
    stdio: "ignore",
    detached: true,
  });
  let pids = [];
  try {
    assert.ok(
      await until(() => fs.existsSync(pidsFile) && fs.readFileSync(pidsFile, "utf8").trim(), 20_000),
      "the fixture started"
    );
    pids = fs.readFileSync(pidsFile, "utf8").trim().split(" ").map(Number);
    assert.ok(pids.every(alive), "leader, file process and its sleep are running");

    process.kill(runner.pid, "SIGKILL");
    assert.ok(
      await until(() => !pids.some(alive), 5_000),
      `still alive after the runner died: ${pids.filter(alive).join(", ")}`
    );
  } finally {
    // Only what this test started: the runner and the fixture's processes.
    for (const pid of [runner.pid, ...pids]) {
      if (pid && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
