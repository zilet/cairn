import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_SAFE_AGENT_ARG_BYTES,
  buildAgentLaunch,
  loadAgents,
  promptExceedsArgvLimit,
} from "../dist/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distAgentsUrl = pathToFileURL(path.join(root, "dist", "agents.js")).href;

const HUGE = `${"x".repeat(MAX_SAFE_AGENT_ARG_BYTES + 1024)} END`;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-large-prompt-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an oversized prompt is over the argv floor and a small one is not", () => {
  assert.equal(promptExceedsArgvLimit("hello"), false);
  assert.equal(promptExceedsArgvLimit(HUGE), true);
  assert.ok(MAX_SAFE_AGENT_ARG_BYTES < 128 * 1024);
});

test("agy overflow drops -p and puts the prompt on stdin as text", () => {
  const agents = loadAgents();
  const launch = buildAgentLaunch(agents.antigravity, agents.antigravity.args, HUGE);
  assert.equal(launch.via, "stdin_plain");
  assert.equal(launch.args.includes("-p"), false);
  assert.equal(launch.args.includes(HUGE), false);
  assert.ok(launch.args.includes("--input-format"));
  assert.equal(launch.stdin?.endsWith("END"), true);
});

test("bundled agents declare an overflow path and small prompts still inline", () => {
  const agents = loadAgents();
  for (const name of ["claude", "codex", "antigravity", "grok"]) {
    assert.ok(agents[name].large_prompt?.via, `${name} needs large_prompt.via`);
  }
  assert.equal(agents.claude.large_prompt.via, "stdin");
  assert.equal(agents.codex.large_prompt.via, "stdin_dash");
  assert.equal(agents.antigravity.large_prompt.via, "stdin_plain");
  assert.equal(agents.grok.large_prompt.via, "file");

  const claude = buildAgentLaunch(agents.claude, agents.claude.args, "probe");
  assert.equal(claude.via, "arg");
  assert.ok(claude.args.includes("probe"));
  assert.equal(claude.stdin, null);
});

test("claude-sized overflow keeps boolean -p and puts the prompt on stdin", () => {
  const agents = loadAgents();
  const launch = buildAgentLaunch(agents.claude, agents.claude.args, HUGE);
  assert.equal(launch.via, "stdin");
  assert.ok(launch.args.includes("-p"));
  assert.equal(launch.args.includes(HUGE), false);
  assert.ok(launch.stdin?.includes("END"));
  assert.ok(!launch.args.some((a) => a.length > MAX_SAFE_AGENT_ARG_BYTES));
});

test("codex overflow replaces the prompt slot with a stdin dash", () => {
  const agents = loadAgents();
  const launch = buildAgentLaunch(agents.codex, agents.codex.args, HUGE);
  assert.equal(launch.via, "stdin_dash");
  assert.ok(launch.args.includes("-"));
  assert.equal(launch.args.includes(HUGE), false);
  assert.equal(launch.stdin?.endsWith("END"), true);
});

test("grok overflow drops -p and points --prompt-file at a temp file", () => {
  const agents = loadAgents();
  const launch = buildAgentLaunch(agents.grok, agents.grok.args, HUGE);
  try {
    assert.equal(launch.via, "file");
    assert.equal(launch.args.includes("-p"), false);
    assert.ok(launch.args.includes("--prompt-file"));
    const file = launch.args[launch.args.indexOf("--prompt-file") + 1];
    assert.equal(fs.readFileSync(file, "utf8").endsWith("END"), true);
    assert.equal(launch.stdin, null);
  } finally {
    if (launch.promptDir) fs.rmSync(launch.promptDir, { recursive: true, force: true });
  }
});

test("runAgent delivers an oversized prompt on stdin instead of argv", () => withTempDir((dataDir) => {
  const configPath = path.join(dataDir, "agents.json");
  const probe = [
    "const fs = require('fs');",
    "const stdin = fs.readFileSync(0, 'utf8');",
    "const argv = process.argv.slice(1);",
    "process.stdout.write(JSON.stringify({",
    "  argvHasHuge: argv.some((a) => a.includes('END') && a.length > 1000),",
    "  stdinEnds: stdin.trim().endsWith('END'),",
    "  stdinLen: stdin.length",
    "}));",
  ].join("");
  fs.writeFileSync(configPath, JSON.stringify({
    overflow: {
      command: process.execPath,
      args: ["-e", probe, "--", "-p", "{prompt}"],
      input: "arg",
      env_required: [],
      large_prompt: { via: "stdin" },
    },
  }));
  const runner = [
    `import { runAgent } from ${JSON.stringify(distAgentsUrl)};`,
    `const res = await runAgent("overflow", ${JSON.stringify(HUGE)}, { timeoutMs: 5000 });`,
    "process.stdout.write(res.raw);",
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: root,
    env: { ...process.env, AGENTS_CONFIG: configPath, DATA_DIR: dataDir, DB_PATH: path.join(dataDir, "cairn.db") },
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.argvHasHuge, false);
  assert.equal(payload.stdinEnds, true);
  assert.ok(payload.stdinLen > MAX_SAFE_AGENT_ARG_BYTES);
}));
