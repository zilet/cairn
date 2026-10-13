// GET /api/settings never waits on a cold CLI login probe. settingsResponse →
// getAgentConfig → agentConfigured ran each provider's status command with spawnSync
// (up to a 20 s leash apiece) on a cold cache, and the welcome's boot waits on that body.
// A cold read now answers `configured: null` + `login_checking: true` while ONE
// background probe per agent fills the cache; the next read has the verdict.
//
// The fixture agent is this very Node binary, told to take a few seconds to say it is
// signed in — no real CLI is ever probed or spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./_seed.js";
import {
  invalidateAgentConfigured,
  refreshAgentConfigured,
  refreshAgentVersion,
  refreshCommandPresent,
  settleAgentLoginChecks,
} from "../dist/agents.js";
import { getAgentConfig } from "../dist/repo/settings.js";
import { operatorRouter, settingsResponse } from "../dist/routes/operator.js";

const SLOW_MS = 3000;

async function withSlowLoginAgent(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-login-probe-"));
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      claude: {
        command: process.execPath,
        args: ["-e", "0"],
        input: "arg",
        description: "fixture",
        env_required: [],
        status_check: ["-e", `setTimeout(() => console.log(JSON.stringify({ loggedIn: true })), ${SLOW_MS})`],
      },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  try {
    return await fn();
  } finally {
    // Let any probe still running land before the config it read goes away.
    await settleAgentLoginChecks(SLOW_MS * 3);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function getSettingsRoute() {
  const layer = operatorRouter.stack.find((l) => l.route?.path === "/settings" && l.route.methods.get);
  assert.ok(layer, "GET /settings is on the operator router");
  return (req, res) => layer.route.stack[0].handle(req, res, () => {});
}

test("a cold login probe never holds the settings read: it says checking, then the verdict", async () => {
  await withSlowLoginAgent(async () => {
    const started = Date.now();
    const cold = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    assert.ok(Date.now() - started < SLOW_MS / 2, `answered in ${Date.now() - started} ms, not after the probe`);
    assert.equal(cold.present, true);
    assert.equal(cold.configured, null, "unknown while it is read, never a guess");
    assert.equal(cold.login_checking, true);
    assert.equal(cold.signed_in, false, "signed in stays a positive verdict only");

    assert.equal(await refreshAgentConfigured("claude"), true);
    const warm = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    assert.equal(warm.configured, true);
    assert.equal(warm.login_checking, false);
    assert.equal(warm.signed_in, true);
  });
});

test("the settings body and GET /settings answer before a slow probe finishes", async () => {
  await withSlowLoginAgent(async () => {
    let started = Date.now();
    const body = settingsResponse();
    assert.ok(Date.now() - started < SLOW_MS / 2, "the aggregate-primed body never spawns synchronously");
    assert.equal(body.agents.find((row) => row.name === "claude").login_checking, true);

    invalidateAgentConfigured();
    started = Date.now();
    const sent = await new Promise((resolve) => getSettingsRoute()({}, { json: (value) => resolve(value) }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < SLOW_MS - 500, `GET /settings replied in ${elapsed} ms, before the probe`);
    const row = sent.agents.find((agent) => agent.name === "claude");
    assert.equal(row.login_checking, true);
    assert.equal(row.configured, null);
  });
});

test("a warm cache answers at once with the verdict and nothing checking", async () => {
  await withSlowLoginAgent(async () => {
    await refreshAgentConfigured("claude");
    const sent = await new Promise((resolve) => getSettingsRoute()({}, { json: (value) => resolve(value) }));
    const row = sent.agents.find((agent) => agent.name === "claude");
    assert.equal(row.configured, true);
    assert.equal(row.login_checking, false);
  });
});

// The same law for the presence and version probes: each was a `<cmd> --version`
// spawnSync (4 s and 5 s leashes) inside the settings read on a cold cache. The fixture
// CLI here takes SLOW_MS to print its version; the read answers presence from a PATH
// lookup at once and the version once the background probe has landed.
test("a slow --version never holds the settings read: present at once, the version after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-version-probe-"));
  const cli = path.join(dir, "slow-cli");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nif (process.argv.includes("--version")) setTimeout(() => console.log("slow-cli 9.8.7"), ${SLOW_MS});\n`
  );
  fs.chmodSync(cli, 0o755);
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ claude: { command: cli, args: [], input: "arg", description: "fixture", env_required: [] } })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  try {
    const started = Date.now();
    const cold = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < SLOW_MS / 2, `answered in ${elapsed} ms, not after the --version probe`);
    assert.equal(cold.present, true, "the PATH lookup answers presence without a spawn");
    assert.equal(cold.version, null, "no version until the probe prints one");

    const [present, version] = await Promise.all([refreshCommandPresent(cli), refreshAgentVersion("claude")]);
    assert.equal(present, true);
    assert.equal(version, "9.8.7");
    const warm = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    assert.equal(warm.present, true);
    assert.equal(warm.version, "9.8.7");
  } finally {
    await settleAgentLoginChecks(SLOW_MS * 3);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a binary that is not there reads absent from the peek and the probe alike", async () => {
  const missing = path.join(os.tmpdir(), "cairn-no-such-cli-" + process.pid);
  invalidateAgentConfigured();
  assert.equal(await refreshCommandPresent(missing), false);
});
