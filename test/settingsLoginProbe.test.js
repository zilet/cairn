// GET /api/settings never waits on a cold CLI login probe. settingsResponse →
// getAgentConfig → agentConfigured ran each provider's status command with spawnSync
// (up to a 20 s leash apiece) on a cold cache, and the welcome's boot waits on that body.
// A cold read now answers `configured: null` + `login_checking: true` while ONE
// background probe per agent fills the cache; the next read has the verdict.
//
// The fixture agent is this very Node binary, held at a GATE: its probe cannot answer
// until the test opens the gate, so "the read answered before the probe" is a fact of
// the fixture, not a race against a clock. (It used to sleep 3 s per probe, four times:
// 12.7 s of waiting.) No real CLI is ever probed or spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./_seed.js";
import {
  agentVersion,
  commandPresent,
  invalidateAgentConfigured,
  refreshAgentConfigured,
  refreshAgentVersion,
  refreshCommandPresent,
  settleAgentLoginChecks,
} from "../dist/agents.js";
import { getAgentConfig } from "../dist/repo/settings.js";
import { operatorRouter, SETTINGS_LOGIN_WAIT_MS, settingsResponse } from "../dist/routes/operator.js";

// A read that answers "at once" does so in milliseconds; this bound only has to sit
// well below the probe's own leash on a loaded machine.
const PROMPT_MS = 2_000;
// The probe's fallback deadline: a gate nobody opens never leaves a process behind.
const GATE_GIVE_UP_MS = 15_000;

// A Node snippet that prints `line` once `gatePath` exists (polling every 10 ms).
function gated(gatePath, line) {
  return (
    `const fs = require("fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gatePath)})) ` +
    `{ clearInterval(t); console.log(${JSON.stringify(line)}); } }, 10); ` +
    `setTimeout(() => process.exit(1), ${GATE_GIVE_UP_MS}).unref?.();`
  );
}
function makeGate(dir) {
  const gatePath = path.join(dir, "gate-open");
  return { gatePath, open: () => fs.writeFileSync(gatePath, "") };
}

async function withSlowLoginAgent(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-login-probe-"));
  const gate = makeGate(dir);
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
        status_check: ["-e", gated(gate.gatePath, JSON.stringify({ loggedIn: true }))],
      },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  try {
    return await fn(gate);
  } finally {
    // Let any probe still running land before the config it read goes away.
    gate.open();
    await settleAgentLoginChecks(GATE_GIVE_UP_MS);
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
  await withSlowLoginAgent(async (gate) => {
    const started = Date.now();
    const cold = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    assert.ok(Date.now() - started < PROMPT_MS, `answered in ${Date.now() - started} ms, not after the probe`);
    assert.equal(cold.present, true);
    assert.equal(cold.configured, null, "unknown while it is read, never a guess");
    assert.equal(cold.login_checking, true);
    assert.equal(cold.signed_in, false, "signed in stays a positive verdict only");

    gate.open();
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
    assert.ok(Date.now() - started < PROMPT_MS, "the aggregate-primed body never spawns synchronously");
    assert.equal(body.agents.find((row) => row.name === "claude").login_checking, true);

    invalidateAgentConfigured();
    started = Date.now();
    const sent = await new Promise((resolve) => getSettingsRoute()({}, { json: (value) => resolve(value) }));
    const elapsed = Date.now() - started;
    // The route gives a cold probe its designed grace (SETTINGS_LOGIN_WAIT_MS), then replies
    // "checking" — the held probe proves the reply never waited for the verdict.
    assert.ok(
      elapsed < SETTINGS_LOGIN_WAIT_MS + PROMPT_MS,
      `GET /settings replied in ${elapsed} ms, while the probe was held`
    );
    const row = sent.agents.find((agent) => agent.name === "claude");
    assert.equal(row.login_checking, true);
    assert.equal(row.configured, null);
  });
});

test("a warm cache answers at once with the verdict and nothing checking", async () => {
  await withSlowLoginAgent(async (gate) => {
    gate.open();
    await refreshAgentConfigured("claude");
    const sent = await new Promise((resolve) => getSettingsRoute()({}, { json: (value) => resolve(value) }));
    const row = sent.agents.find((agent) => agent.name === "claude");
    assert.equal(row.configured, true);
    assert.equal(row.login_checking, false);
  });
});

// The same law for the presence and version probes: each was a `<cmd> --version`
// spawnSync (4 s and 5 s leashes) inside the settings read on a cold cache. The fixture
// CLI here prints its version only once the gate opens; the read answers presence from a
// PATH lookup at once and the version once the background probe has landed.
test("a slow --version never holds the settings read: present at once, the version after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-version-probe-"));
  const gate = makeGate(dir);
  const cli = path.join(dir, "slow-cli");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { ${gated(gate.gatePath, "slow-cli 9.8.7")} }\n`
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
    assert.ok(elapsed < PROMPT_MS, `answered in ${elapsed} ms, not after the --version probe`);
    assert.equal(cold.present, true, "the PATH lookup answers presence without a spawn");
    assert.equal(cold.version, null, "no version until the probe prints one");

    gate.open();
    const [present, version] = await Promise.all([refreshCommandPresent(cli), refreshAgentVersion("claude")]);
    assert.equal(present, true);
    assert.equal(version, "9.8.7");
    const warm = getAgentConfig({ loginProbe: "peek" }).find((row) => row.name === "claude");
    assert.equal(warm.present, true);
    assert.equal(warm.version, "9.8.7");
  } finally {
    gate.open();
    await settleAgentLoginChecks(GATE_GIVE_UP_MS);
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

function routeHandler(routePath) {
  const layer = operatorRouter.stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} is on the operator router`);
  return layer.route.stack[0].handle;
}

// GET /agents was the one agent read still on the synchronous probe: a cold (or due-for-
// retry) login status command ran with spawnSync inside the request, up to its 20 s leash.
test("GET /agents answers before a slow login probe, with the same row shape", async () => {
  await withSlowLoginAgent(async (gate) => {
    const started = Date.now();
    const sent = await new Promise((resolve, reject) =>
      routeHandler("/agents")({}, { json: (value) => resolve(value) }, reject)
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < SETTINGS_LOGIN_WAIT_MS + PROMPT_MS, `GET /agents replied in ${elapsed} ms`);
    assert.ok(Array.isArray(sent), "still the bare agent list");
    const row = sent.find((agent) => agent.name === "claude");
    assert.equal(row.login_checking, true);
    assert.equal(row.configured, null);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(getAgentConfig({ loginProbe: "peek" })[0]).sort());

    gate.open();
    await refreshAgentConfigured("claude");
    const warm = await new Promise((resolve, reject) =>
      routeHandler("/agents")({}, { json: (value) => resolve(value) }, reject)
    );
    assert.equal(warm.find((agent) => agent.name === "claude").configured, true);
  });
});

// A CLI fixture that counts its `--version` launches and prints only once the gate opens.
function countingVersionCli(dir, gate) {
  const counter = path.join(dir, "version-calls");
  const cli = path.join(dir, "counting-cli");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); ${gated(gate.gatePath, "counting-cli 4.5.6")} }\n`
  );
  fs.chmodSync(cli, 0o755);
  return { cli, calls: () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0) };
}

async function withCountingCli(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-version-count-"));
  const gate = makeGate(dir);
  const fixture = countingVersionCli(dir, gate);
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ claude: { command: fixture.cli, args: [], input: "arg", description: "fixture", env_required: [] } })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  try {
    return await fn({ ...fixture, gate });
  } finally {
    gate.open();
    await settleAgentLoginChecks(GATE_GIVE_UP_MS);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("GET /agents/:name/info reads the version off the event loop, and the CLI launches --version once", async () => {
  await withCountingCli(async ({ gate, calls }) => {
    const started = Date.now();
    const pending = new Promise((resolve, reject) =>
      routeHandler("/agents/:name/info")({ params: { name: "claude" } }, { json: (value) => resolve(value) }, reject)
    );
    assert.ok(Date.now() - started < PROMPT_MS, "the handler returned without waiting on the gated --version");
    // The event loop is free while the probe waits on its gate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.open();
    const info = await pending;
    assert.equal(info.ok, true);
    assert.equal(info.version, "4.5.6");
    assert.equal(info.model_current, null, "no catalog declared, no default model");
    assert.equal(calls(), 1, "presence and version shared ONE --version launch");
    // Warm: nothing launches again.
    await new Promise((resolve, reject) =>
      routeHandler("/agents/:name/info")({ params: { name: "claude" } }, { json: (value) => resolve(value) }, reject)
    );
    assert.equal(calls(), 1);
  });
});

test("the presence probe's print is the version: one --version per CLI until invalidated", async () => {
  await withCountingCli(async ({ cli, gate, calls }) => {
    gate.open();
    assert.equal(commandPresent(cli), true);
    assert.equal(agentVersion("claude"), "4.5.6");
    assert.equal(calls(), 1, "the sync presence probe answered the version too");
    // A login / update invalidates every probe cache — the version is read afresh.
    invalidateAgentConfigured("claude");
    assert.equal(agentVersion("claude"), "4.5.6");
    assert.equal(calls(), 2, "invalidation still clears the shared print");
    assert.equal(agentVersion("claude"), "4.5.6");
    assert.equal(calls(), 2);
  });
});
