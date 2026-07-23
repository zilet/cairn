import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizedAgentCapabilities, resolveAgentExecutionProfile } from "../dist/agents.js";
import { runChosenStreaming, runChosenWithCoachReads } from "../dist/runChosen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distAgentsUrl = pathToFileURL(path.join(root, "dist", "agents.js")).href;
const distRunChosenUrl = pathToFileURL(path.join(root, "dist", "runChosen.js")).href;

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-execution-profile-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function providerConfig() {
  const bundled = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
  const oneShotProbe = "process.stdout.write(JSON.stringify({argv:process.argv.slice(1)}));";
  const grokStreamProbe =
    "process.stdout.write(JSON.stringify({type:'text',data:JSON.stringify({argv:process.argv.slice(1)})})+'\\n');";
  const claudeStreamProbe =
    "process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:JSON.stringify({argv:process.argv.slice(1)})}}})+'\\n');";
  const out = {};
  for (const name of ["claude", "codex", "antigravity", "grok"]) {
    const def = bundled[name];
    out[name] = {
      ...def,
      command: process.execPath,
      args: ["-e", oneShotProbe, "--", ...def.args],
      ...(def.stream
        ? {
            stream: {
              ...def.stream,
              args: ["-e", name === "claude" ? claudeStreamProbe : grokStreamProbe, "--", ...def.stream.args],
            },
          }
        : {}),
    };
  }
  return out;
}

function expectedArgv(name, dataDir, prompt, withProfile) {
  const profile = withProfile
    ? name === "codex"
      ? ["--model", "model/test:1", "-c", "model_reasoning_effort=xhigh"]
      : [
          "--model",
          "model/test:1",
          name === "grok" ? "--reasoning-effort" : "--effort",
          name === "claude" ? "xhigh" : "high",
        ]
    : [];
  if (name === "claude") {
    return ["--add-dir", dataDir, "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config", ...profile, "-p", prompt];
  }
  if (name === "codex") {
    return [
      "exec",
      ...profile,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      dataDir,
      "--add-dir",
      dataDir,
      prompt,
      "--image",
      path.join(dataDir, "uploads", "plate.jpg"),
    ];
  }
  if (name === "antigravity") {
    return ["--add-dir", dataDir, ...profile, "-p", prompt, "--print-timeout", "5m"];
  }
  return ["--cwd", dataDir, ...profile, "-p", prompt];
}

test("execution profile helpers declare support, map xhigh, and make stub no-op explicit", () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
  assert.deepEqual(normalizedAgentCapabilities(bundled.claude), {
    model: true,
    reasoning: ["low", "medium", "high", "xhigh"],
    execution_profile_noop: false,
  });
  assert.deepEqual(resolveAgentExecutionProfile(bundled.claude, { model: "  model/test:1  ", reasoning: "xhigh" }), {
    requested: { model: "model/test:1", reasoning: "xhigh" },
    effective: { model: "model/test:1", reasoning: "xhigh" },
    adjustments: [],
    noop: false,
  });
  for (const name of ["antigravity", "grok"]) {
    const profile = resolveAgentExecutionProfile(bundled[name], { reasoning: "xhigh" });
    assert.equal(profile.requested.reasoning, "xhigh");
    assert.equal(profile.effective.reasoning, "high");
    assert.match(profile.adjustments[0], /mapped to provider maximum high/);
  }
  const stub = resolveAgentExecutionProfile(bundled.stub, { model: "ignored", reasoning: "high" });
  assert.deepEqual(stub.requested, { model: "ignored", reasoning: "high" });
  assert.deepEqual(stub.effective, {});
  assert.equal(stub.noop, true);
  assert.match(stub.adjustments[0], /offline stub/);
});

test("all provider one-shot argv templates expand exact profile flags and preserve unset/file/image/MCP ordering", () =>
  withTempDir((dataDir) => {
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
    const imagePath = path.join(dataDir, "uploads", "plate.jpg");
    fs.writeFileSync(imagePath, "fake image");
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify(providerConfig()));
    const prompt = `Review uploaded image ${imagePath}`;
    const mcpArgs = ["--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config"];
    const runner = [
      `import { runAgent, runAgentWithFallback } from ${JSON.stringify(distAgentsUrl)};`,
      `import { runChosen } from ${JSON.stringify(distRunChosenUrl)};`,
      `const prompt = ${JSON.stringify(prompt)};`,
      `const mcpConfigArgs = ${JSON.stringify(mcpArgs)};`,
      "const names = ['claude','codex','antigravity','grok'];",
      "const profile = { timeoutMs: 5000, model: 'model/test:1', reasoning: 'xhigh', mcpConfigArgs };",
      "const set = {}; const unset = {};",
      "for (const name of names) {",
      "  set[name] = (await runAgent(name, prompt, profile)).parsed.argv;",
      "  unset[name] = (await runAgent(name, prompt, { timeoutMs: 5000, mcpConfigArgs })).parsed.argv;",
      "}",
      "const fallback = (await runAgentWithFallback(['claude'], prompt, profile)).result.parsed.argv;",
      "const chosen = (await runChosen('claude', prompt, { ...profile, op: 'profile_test' })).result.parsed.argv;",
      "process.stdout.write('__CAIRN_PROFILE_RESULT__'+JSON.stringify({set,unset,fallback,chosen}));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: {
        ...process.env,
        AGENTS_CONFIG: configPath,
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "cairn.db"),
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const marker = "__CAIRN_PROFILE_RESULT__";
    const markerAt = res.stdout.lastIndexOf(marker);
    assert.ok(markerAt >= 0, res.stdout);
    const payload = JSON.parse(res.stdout.slice(markerAt + marker.length));
    for (const name of ["claude", "codex", "antigravity", "grok"]) {
      assert.deepEqual(payload.set[name], expectedArgv(name, dataDir, prompt, true), `${name} profile argv`);
      assert.deepEqual(payload.unset[name], expectedArgv(name, dataDir, prompt, false), `${name} unset argv`);
    }
    assert.deepEqual(payload.fallback, payload.set.claude, "fallback preserves model/reasoning");
    assert.deepEqual(payload.chosen, payload.set.claude, "runChosen preserves model/reasoning");
  }));

test("Claude and Grok streaming argv templates expand exact profile flags and unset parity", () =>
  withTempDir((dataDir) => {
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
    const imagePath = path.join(dataDir, "uploads", "plate.jpg");
    fs.writeFileSync(imagePath, "fake image");
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify(providerConfig()));
    const prompt = `Review uploaded image ${imagePath}`;
    const mcpArgs = ["--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config"];
    const runner = [
      `import { runAgentStreaming } from ${JSON.stringify(distAgentsUrl)};`,
      `const prompt = ${JSON.stringify(prompt)};`,
      `const mcpConfigArgs = ${JSON.stringify(mcpArgs)};`,
      "const set = {}; const unset = {};",
      "for (const name of ['claude','grok']) {",
      "  set[name] = (await runAgentStreaming(name, prompt, { timeoutMs: 5000, model: 'model/test:1', reasoning: 'xhigh', mcpConfigArgs })).parsed.argv;",
      "  unset[name] = (await runAgentStreaming(name, prompt, { timeoutMs: 5000, mcpConfigArgs })).parsed.argv;",
      "}",
      "process.stdout.write(JSON.stringify({set,unset}));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: {
        ...process.env,
        AGENTS_CONFIG: configPath,
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "cairn.db"),
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(payload.set.claude, [
      ...expectedArgv("claude", dataDir, prompt, true),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    assert.deepEqual(payload.unset.claude, [
      ...expectedArgv("claude", dataDir, prompt, false),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    assert.deepEqual(payload.set.grok, [
      ...expectedArgv("grok", dataDir, prompt, true),
      "--output-format",
      "streaming-json",
    ]);
    assert.deepEqual(payload.unset.grok, [
      ...expectedArgv("grok", dataDir, prompt, false),
      "--output-format",
      "streaming-json",
    ]);
  }));

test("runChosenStreaming and coach-read turns preserve model/reasoning metadata", async () => {
  let streamOpts;
  const streamedRaw = '===CAIRN_REPLY===\nReady.\n===CAIRN_ACTIONS===\n{"ok":true}';
  const streamed = await runChosenStreaming(
    "claude",
    "PROMPT",
    {
      op: "profile_test",
      model: "model/test:1",
      reasoning: "xhigh",
      mcpConfigArgs: ["--strict-mcp-config"],
      onDelta: () => {},
    },
    {
      resolveOrder: () => ["claude"],
      supportsStream: () => true,
      runStreaming: async (_name, _prompt, opts) => {
        streamOpts = opts;
        opts.onDelta?.(streamedRaw);
        return { code: 0, raw: streamedRaw, stderr: "", parsed: null, usage: {} };
      },
      runOneShot: async () => {
        throw new Error("must not fall back");
      },
    }
  );
  assert.deepEqual(streamed.result.parsed, { ok: true });
  assert.equal(streamOpts.model, "model/test:1");
  assert.equal(streamOpts.reasoning, "xhigh");
  assert.deepEqual(streamOpts.mcpConfigArgs, ["--strict-mcp-config"]);

  const coachOpts = [];
  const coach = await runChosenWithCoachReads(
    "claude",
    "PROMPT",
    { op: "profile_test", model: "model/test:1", reasoning: "xhigh", timeoutMs: 5000 },
    {},
    {
      run: async (_agent, _prompt, opts) => {
        coachOpts.push(opts);
        return {
          agent: "claude",
          result: { code: 0, raw: '{"ok":true}', stderr: "", parsed: { ok: true }, usage: {} },
          tried: [],
        };
      },
    }
  );
  assert.deepEqual(coach.result.parsed, { ok: true });
  assert.ok(coachOpts.length > 0);
  for (const opts of coachOpts) {
    assert.equal(opts.model, "model/test:1");
    assert.equal(opts.reasoning, "xhigh");
  }
});
