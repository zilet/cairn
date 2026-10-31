// An agent CLI's whole process group goes with it.
//
// A coding CLI starts helpers of its own (MCP servers, shells, tool runners). Killing only
// the CLI on a timeout or a Stop left those running on the host, and a CLI that exited
// normally could leave them behind too. Each fixture here backgrounds a long sleep and
// writes its pid, so what is asserted is a real grandchild's fate, not a mock's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../dist/agents.js";

const skipOnWindows = process.platform === "win32" ? "process groups are POSIX-only" : false;

function agentDef(script) {
  return {
    command: "sh",
    args: ["-c", script],
    input: "arg",
    description: "Fixture agent that leaves a grandchild behind.",
    env_required: [],
    login: null,
    status_check: null,
    auth_state: null,
    models_list: null,
    model_flag: ["--model", "{model}"],
    capabilities: { model: false, reasoning: [], execution_profile_noop: true },
    reasoning_flag: null,
  };
}

async function withAgents(build, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-group-kill-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(build(pidFile), null, 2));
  const prior = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  try {
    return await fn(pidFile);
  } finally {
    if (prior === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The grandchild is reparented and reaped once killed; give the kernel a moment.
async function gone(pid, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

async function grandchildPid(pidFile) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
    if (text) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture never wrote its grandchild pid");
}

test("a timed-out agent takes the helpers it started with it", { skip: skipOnWindows }, async () => {
  await withAgents(
    (pidFile) => ({ wedged: agentDef(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`) }),
    async (pidFile) => {
      const run = runAgent("wedged", "ignored prompt", { timeoutMs: 400 });
      const pid = await grandchildPid(pidFile);
      assert.ok(alive(pid), "the helper is running while the agent is");
      await assert.rejects(run, /timed out/);
      assert.ok(await gone(pid), "the timeout killed the helper, not only the CLI");
    }
  );
});

test("a Stop takes the helpers too", { skip: skipOnWindows }, async () => {
  await withAgents(
    (pidFile) => ({ wedged: agentDef(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`) }),
    async (pidFile) => {
      const controller = new AbortController();
      const run = runAgent("wedged", "ignored prompt", { timeoutMs: 10_000, signal: controller.signal });
      const pid = await grandchildPid(pidFile);
      controller.abort();
      await assert.rejects(run, /canceled/);
      assert.ok(await gone(pid), "the Stop killed the helper");
    }
  );
});

test("a CLI that exits cleanly leaves nothing of its own behind", { skip: skipOnWindows }, async () => {
  await withAgents(
    (pidFile) => ({
      tidy: agentDef(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; printf '%s' '{"ok":true}'`),
    }),
    async (pidFile) => {
      const result = await runAgent("tidy", "ignored prompt", { timeoutMs: 10_000 });
      assert.deepEqual(result.parsed, { ok: true }, "the answer still lands");
      const pid = await grandchildPid(pidFile);
      assert.ok(await gone(pid), "the group was swept once the CLI closed");
    }
  );
});
