import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentCliUpdateStatus, startAgentCliUpdate } from "../dist/agentCliUpdates.js";

async function waitForUpdate() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = getAgentCliUpdateStatus();
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("agent CLI update did not finish");
}

test("agent CLI updater sanitizes env and redacts captured output tails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-update-"));
  const dataDir = path.join(dir, "data");
  const script = path.join(dir, "update.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    "if [ \"$(pwd -P)\" = \"$EXPECTED_UPDATE_CWD\" ]; then echo \"cwd_safe=1\"; else echo \"cwd_safe=0\"; fi",
    "echo \"token=$CAIRN_AUTH_TOKEN\"",
    "echo \"data_dir=$DATA_DIR\"",
    "echo \"db_path=$DB_PATH\"",
    "echo \"literal token secret-token-abc\"",
    "echo \"literal garmin garmin-secret\" >&2",
  ].join("\n"));
  fs.chmodSync(script, 0o755);

  const prevScript = process.env.AGENT_CLI_UPDATE_SCRIPT;
  const prevDataDir = process.env.DATA_DIR;
  const prevDbPath = process.env.DB_PATH;
  const prevExpectedCwd = process.env.EXPECTED_UPDATE_CWD;
  const prevToken = process.env.CAIRN_AUTH_TOKEN;
  const prevGarmin = process.env.GARMIN_PASSWORD;
  process.env.AGENT_CLI_UPDATE_SCRIPT = script;
  process.env.DATA_DIR = dataDir;
  process.env.DB_PATH = path.join(dataDir, "cairn.db");
  const expectedUpdateCwd = path.join(dataDir, ".agent-workspaces", "update");
  fs.mkdirSync(expectedUpdateCwd, { recursive: true });
  process.env.EXPECTED_UPDATE_CWD = fs.realpathSync(expectedUpdateCwd);
  process.env.CAIRN_AUTH_TOKEN = "secret-token-abc";
  process.env.GARMIN_PASSWORD = "garmin-secret";
  try {
    startAgentCliUpdate("test");
    const status = await waitForUpdate();
    assert.equal(status.status, "succeeded");
    assert.match(status.stdout_tail, /cwd_safe=1/m, "updater should run in the isolated update workspace");
    assert.match(status.stdout_tail, /token=$/m, "secret env should not reach updater");
    assert.match(status.stdout_tail, /data_dir=$/m, "DATA_DIR should not reach updater env");
    assert.match(status.stdout_tail, /db_path=$/m, "DB_PATH should not reach updater env");
    assert.doesNotMatch(status.stdout_tail, /secret-token-abc/);
    assert.doesNotMatch(status.stderr_tail, /garmin-secret/);
    assert.match(`${status.stdout_tail}\n${status.stderr_tail}`, /\[redacted\]/);
  } finally {
    if (prevScript === undefined) delete process.env.AGENT_CLI_UPDATE_SCRIPT; else process.env.AGENT_CLI_UPDATE_SCRIPT = prevScript;
    if (prevDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDataDir;
    if (prevDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prevDbPath;
    if (prevExpectedCwd === undefined) delete process.env.EXPECTED_UPDATE_CWD; else process.env.EXPECTED_UPDATE_CWD = prevExpectedCwd;
    if (prevToken === undefined) delete process.env.CAIRN_AUTH_TOKEN; else process.env.CAIRN_AUTH_TOKEN = prevToken;
    if (prevGarmin === undefined) delete process.env.GARMIN_PASSWORD; else process.env.GARMIN_PASSWORD = prevGarmin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
