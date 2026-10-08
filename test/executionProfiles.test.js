import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NO_TOOLS_PREAMBLE,
  normalizedAgentCapabilities,
  resolveAgentExecutionProfile,
  resolveAgentProfileForClass,
} from "../dist/agents.js";
import { runChosenStreaming, runChosenWithCoachReads } from "../dist/runChosen.js";
import { db, repo } from "./_seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distAgentsUrl = pathToFileURL(path.join(root, "dist", "agents.js")).href;
const distRunChosenUrl = pathToFileURL(path.join(root, "dist", "runChosen.js")).href;
const distRepoUrl = pathToFileURL(path.join(root, "dist", "repo.js")).href;

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
    reasoning: ["low", "medium", "high", "xhigh", "max"],
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

// ---------- op -> execution profile (the server-owned "how hard do we run this") ----------

function bundledAgents() {
  return JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
}

// Pure resolution against injected defs/bindings: no DB, no settings, no CLI.
function resolve(task, agent, bindings = {}, classBindings = {}) {
  return repo.resolveTaskExecutionProfile(task, agent, { defs: bundledAgents(), bindings, classBindings });
}

test("every routable task except chat declares an execution profile", () => {
  for (const task of repo.ROUTABLE_TASKS) {
    if (task === "chat") {
      assert.equal(repo.TASK_EXECUTION_PROFILES[task], undefined, "chat keeps its own adaptive lane profile");
      continue;
    }
    const profile = repo.TASK_EXECUTION_PROFILES[task];
    assert.ok(profile, `${task} has no execution profile`);
    assert.ok(["fast", "deep"].includes(profile.model_class), `${task} model class`);
    assert.ok(["low", "medium", "high", "xhigh", "max"].includes(profile.reasoning), `${task} reasoning`);
  }
  // No provider pins a model for everyone any more: a class names NO model until the
  // person chooses one. The offered choices stay ALIASES (never dated ids), so a new
  // generation ships without a code change.
  const agents = bundledAgents();
  for (const [name, def] of Object.entries(agents)) {
    assert.equal(def.model_classes, undefined, `${name} must not pin a model class for everyone`);
  }
  assert.deepEqual(agents.claude.model_choices, ["sonnet", "opus", "fable", "haiku"]);
  for (const model of agents.claude.model_choices) assert.doesNotMatch(model, /\d/, "no dated model id");
});

// ROUTABLE_TASKS is the TASK_POLICY key set, so the guard above only sees ops that
// pick an AGENT. runVerify's self-critique ops never did — they are passed straight
// to runChosen as an `op`, so they stayed unpinned while the test above passed green
// over the gap. These are the safety backstops (injury/equipment/encoding, lean
// safety) and they fail OPEN, so an unpinned one degrades silently into no check.
// Scan the source rather than hardcoding: a THIRD verify op added later must fail
// here instead of quietly inheriting the CLI's defaults.
test("every self-critique verify op declares an execution profile", () => {
  // The ops live under src/coachOps/ (one file per domain) behind the coachOps.ts
  // re-export barrel, so scan the whole directory rather than the barrel itself.
  const opsDir = path.join(root, "src", "coachOps");
  const src = fs
    .readdirSync(opsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => fs.readFileSync(path.join(opsDir, f), "utf8"))
    .join("\n");
  const ops = [...new Set([...src.matchAll(/"([a-z_]+_verify)"/g)].map((m) => m[1]))];
  assert.ok(ops.length >= 2, `expected to find the verify ops under src/coachOps/, found ${ops.length}`);
  assert.ok(ops.includes("session_verify") && ops.includes("meal_plan_verify"), `found: ${ops.join(", ")}`);
  for (const op of ops) {
    // taskForOp must not remap these away from their own key, or the pin is a no-op.
    assert.equal(repo.taskForOp(op), op, `${op} should classify as itself`);
    const profile = repo.TASK_EXECUTION_PROFILES[op];
    assert.ok(profile, `${op} has no execution profile — it would inherit the CLI's defaults`);
    assert.equal(profile.model_class, "deep", `${op} guards a draft; it should not run on the cheap model`);
    // A verify runs INLINE inside a user-facing request, so its leash must not
    // exceed the composition op it checks — otherwise checking outlasts the work.
    assert.ok(
      repo.interactiveTimeoutForOp(op) <= repo.interactiveTimeoutForOp("session_suggest"),
      `${op} leash must not exceed the op it verifies`
    );
  }
});

test("with no choice made, no provider gets --model: every CLI runs its own default model", () => {
  // Effort stays server policy; the model is the CLI's own unless the person binds a class.
  assert.deepEqual(resolve("day_read", "claude"), { reasoning: "low" });
  assert.deepEqual(resolve("proposal", "claude"), { reasoning: "xhigh" });
  assert.deepEqual(resolve("health", "claude"), { reasoning: "high" });
  assert.deepEqual(resolve("enrich", "claude"), { reasoning: "low" });
  assert.deepEqual(resolve("session_suggest", "claude"), { reasoning: "medium" });
  for (const agent of ["claude", "codex", "antigravity", "grok"]) {
    for (const task of ["day_read", "proposal", "health"]) {
      assert.equal(resolve(task, agent).model, undefined, `${agent}/${task} must not be model-pinned`);
    }
  }
  assert.deepEqual(resolve("proposal", "codex"), { reasoning: "xhigh" });

  // No entry (chat), unknown op, and the offline stub all resolve to "no profile".
  assert.deepEqual(resolve("chat", "claude"), {});
  assert.deepEqual(resolve("not_a_real_op", "claude"), {});
  assert.deepEqual(resolve("proposal", "stub"), {});
  assert.deepEqual(resolve("proposal", "no_such_agent"), {});
});

test("a provider that tops out below the requested effort degrades instead of failing", () => {
  // antigravity/grok declare low|medium|high.
  for (const agent of ["antigravity", "grok"]) {
    assert.deepEqual(resolve("proposal", agent), { reasoning: "high" }, `${agent} xhigh -> high`);
    assert.deepEqual(resolve("health", agent), { reasoning: "high" });
    assert.deepEqual(resolve("day_read", agent), { reasoning: "low" });
  }
  // The ladder is general, not an xhigh special case.
  const twoLevel = {
    model_flag: null,
    reasoning_flag: ["--effort", "{reasoning}"],
    capabilities: { reasoning: ["low", "medium"] },
  };
  assert.deepEqual(resolveAgentProfileForClass(twoLevel, { reasoning: "max" }), { reasoning: "medium" });
  assert.deepEqual(resolveAgentProfileForClass(twoLevel, { reasoning: "high" }), { reasoning: "medium" });
  assert.deepEqual(resolveAgentProfileForClass(twoLevel, { reasoning: "low" }), { reasoning: "low" });
  // An agent with no reasoning flag at all simply gets no effort argument.
  assert.deepEqual(resolveAgentProfileForClass({ capabilities: { reasoning: ["high"] } }, { reasoning: "high" }), {});
});

test("a class binding picks the model for that provider's class, and only there", () => {
  const classes = { claude: { fast: "sonnet", deep: "opus" } };
  assert.deepEqual(resolve("day_read", "claude", {}, classes), { model: "sonnet", reasoning: "low" });
  assert.deepEqual(resolve("proposal", "claude", {}, classes), { model: "opus", reasoning: "xhigh" });
  assert.deepEqual(resolve("health", "claude", {}, classes), { model: "opus", reasoning: "high" });
  // One class bound, the other left on the CLI default.
  assert.deepEqual(resolve("day_read", "claude", {}, { claude: { deep: "opus" } }), { reasoning: "low" });
  // A choice for one provider never reaches another.
  assert.deepEqual(resolve("proposal", "grok", {}, classes), { reasoning: "high" });
  assert.deepEqual(resolve("proposal", "grok", {}, { grok: { deep: "grok-4.7" } }), {
    model: "grok-4.7",
    reasoning: "high",
  });
  // The offline stub ignores execution profiles even when bound.
  assert.deepEqual(resolve("proposal", "stub", {}, { stub: { deep: "opus" } }), {});
});

test("a user binding overrides the default profile and is still clamped to the provider", () => {
  assert.deepEqual(resolve("day_read", "claude", { claude: { day_read: { model: "fable", reasoning: "max" } } }), {
    model: "fable",
    reasoning: "max",
  });
  // A per-task model wins over the class binding.
  assert.deepEqual(
    resolve("day_read", "claude", { claude: { day_read: { model: "haiku" } } }, { claude: { fast: "sonnet" } }),
    { model: "haiku", reasoning: "low" }
  );
  // Reasoning-only override keeps the class-resolved model (none, by default).
  assert.deepEqual(resolve("day_read", "claude", { claude: { day_read: { reasoning: "high" } } }), {
    reasoning: "high",
  });
  assert.deepEqual(
    resolve("day_read", "claude", { claude: { day_read: { reasoning: "high" } } }, { claude: { fast: "sonnet" } }),
    { model: "sonnet", reasoning: "high" }
  );
  // A binding for a DIFFERENT provider/task never leaks.
  assert.deepEqual(resolve("day_read", "claude", { grok: { day_read: { reasoning: "high" } } }), {
    reasoning: "low",
  });
  // Over-strong binding on a three-level CLI still degrades rather than throwing.
  assert.deepEqual(resolve("day_read", "grok", { grok: { day_read: { reasoning: "max" } } }), { reasoning: "high" });
  // Garbage is dropped by the shared normalizer, leaving the declared default.
  assert.deepEqual(resolve("day_read", "claude", { claude: { day_read: { reasoning: "turbo" } } }), {
    reasoning: "low",
  });
});

test("executionProfileForOp folds ops onto their task class", () => {
  const profileFor = (op, agent) => repo.executionProfileForOp(op)(agent);
  // case_conference / conference_* -> brain_review, evolve_program -> proposal,
  // marker_reconcile -> health (the same taskForOp table the agent routing uses).
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  assert.deepEqual(profileFor("case_conference", "claude"), { reasoning: "xhigh" });
  assert.deepEqual(profileFor("conference_nutrition", "claude"), { reasoning: "xhigh" });
  assert.deepEqual(profileFor("evolve_program", "claude"), { reasoning: "xhigh" });
  assert.deepEqual(profileFor("marker_reconcile", "claude"), { reasoning: "high" });
  assert.deepEqual(profileFor("day_read", "claude"), { reasoning: "low" });
  assert.deepEqual(profileFor("auto", "claude"), {});
  // The live (DB-backed) resolver reads the person's class choice.
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet", deep: "opus" } } });
  assert.deepEqual(profileFor("case_conference", "claude"), { model: "opus", reasoning: "xhigh" });
  assert.deepEqual(profileFor("day_read", "claude"), { model: "sonnet", reasoning: "low" });
  assert.deepEqual(profileFor("day_read", "codex"), { reasoning: "low" });
  db.prepare("DELETE FROM settings WHERE id = 1").run();
});

test("model_class_bindings round-trip and validate: known provider, fast|deep, an offered or well-formed model", () => {
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  assert.deepEqual(repo.getSettings().model_class_bindings, {}, "default: every CLI's own model");
  const saved = repo.setSettings({
    model_class_bindings: {
      claude: { fast: "sonnet", deep: "opus", turbo: "haiku" }, // unknown class dropped
      codex: { deep: "gpt-6-sol" }, // free-text id (no curated list): well-formed, kept
      grok: { fast: "bad model; rm -rf" }, // malformed free text dropped
      stub: { deep: "opus" }, // takes no model: dropped
      no_such_agent: { fast: "sonnet" }, // unknown provider dropped
      antigravity: { fast: "", deep: "default" }, // blank / "default" = CLI default
    },
  }).model_class_bindings;
  assert.deepEqual(saved, { claude: { fast: "sonnet", deep: "opus" }, codex: { deep: "gpt-6-sol" } });
  assert.deepEqual(repo.getSettings().model_class_bindings, saved);
  // Omitting the key leaves it; {} clears it.
  repo.setSettings({ lead_mode: "lead" });
  assert.deepEqual(repo.getSettings().model_class_bindings, saved);
  assert.deepEqual(repo.setSettings({ model_class_bindings: {} }).model_class_bindings, {});
  db.prepare("DELETE FROM settings WHERE id = 1").run();
});

test("normalizeModelClassBindings accepts a live-catalog entry the free-text rule would not", () => {
  const defs = bundledAgents();
  const catalog = (name) => (name === "antigravity" ? ["Gemini 3.5 Flash (Medium)"] : null);
  assert.deepEqual(
    repo.normalizeModelClassBindings(
      { antigravity: { fast: "Gemini 3.5 Flash (Medium)", deep: "Not In Catalog" } },
      { defs, catalog }
    ),
    { antigravity: { fast: "Gemini 3.5 Flash (Medium)" } }
  );
  // Curated aliases are always accepted; a JSON string body is parsed.
  assert.deepEqual(repo.normalizeModelClassBindings(JSON.stringify({ claude: { deep: "fable" } }), { defs, catalog }), {
    claude: { deep: "fable" },
  });
  assert.deepEqual(repo.normalizeModelClassBindings("not json", { defs, catalog }), {});
  assert.ok(repo.MODEL_ID_PATTERN.test("claude-opus-4-1"));
  assert.ok(!repo.MODEL_ID_PATTERN.test("two words"));
  assert.ok(!repo.MODEL_ID_PATTERN.test("x".repeat(81)));
});

test("the interactive leash scales with the effort the op asked for", () => {
  assert.equal(repo.interactiveTimeoutForOp("day_read"), 90_000); // low: unchanged
  assert.equal(repo.interactiveTimeoutForOp("session_suggest"), 150_000);
  assert.equal(repo.interactiveTimeoutForOp("health_review"), 240_000);
  assert.equal(repo.interactiveTimeoutForOp("evolve_program"), 300_000); // xhigh, capped at the default
  assert.equal(repo.interactiveTimeoutForOp("chat"), 90_000); // no entry -> today's leash
  assert.equal(repo.interactiveTimeoutForOp("not_a_real_op"), 90_000);
});

test("agent_profile_bindings round-trip through settings and drop unknown keys", () => {
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  assert.deepEqual(repo.getSettings().agent_profile_bindings, {});
  const saved = repo.setSettings({
    agent_profile_bindings: {
      claude: { day_read: { model: "fable", reasoning: "max" }, not_a_task: { reasoning: "high" } },
      grok: { proposal: { reasoning: "nope" } },
    },
  }).agent_profile_bindings;
  assert.deepEqual(saved, { claude: { day_read: { model: "fable", reasoning: "max" } } });
  assert.deepEqual(repo.getSettings().agent_profile_bindings, saved);
  // The live (DB-backed) resolver honors it.
  assert.deepEqual(repo.resolveTaskExecutionProfile("day_read", "claude"), { model: "fable", reasoning: "max" });
  db.prepare("DELETE FROM settings WHERE id = 1").run();
});

test("op profiles reach the spawned argv, per provider, with no caller-supplied model", () =>
  withTempDir((dataDir) => {
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify(providerConfig()));
    // A plain (file-less) prompt reaches every CLI behind the no-tools preamble.
    const prompt = `${NO_TOOLS_PREAMBLE}\n\nRead my day.`;
    const runner = [
      `import { runChosen } from ${JSON.stringify(distRunChosenUrl)};`,
      `const prompt = ${JSON.stringify(prompt)};`,
      "const out = {};",
      "for (const name of ['claude','codex','antigravity','grok']) {",
      "  out[name] = {};",
      "  for (const op of ['day_read','proposal']) {",
      "    out[name][op] = (await runChosen(name, prompt, { op, timeoutMs: 5000 })).result.parsed.argv;",
      "  }",
      "}",
      // The person binds claude's deep class to opus: deep ops get it, fast ones stay on the default.
      `const { setSettings } = await import(${JSON.stringify(distRepoUrl)});`,
      "setSettings({ model_class_bindings: { claude: { deep: 'opus' } } });",
      "out.bound = {};",
      "for (const op of ['day_read','proposal']) {",
      "  out.bound[op] = (await runChosen('claude', prompt, { op, timeoutMs: 5000 })).result.parsed.argv;",
      "}",
      "process.stdout.write('__CAIRN_OP_PROFILE__'+JSON.stringify(out));",
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
    const marker = "__CAIRN_OP_PROFILE__";
    const at = res.stdout.lastIndexOf(marker);
    assert.ok(at >= 0, res.stdout);
    const argv = JSON.parse(res.stdout.slice(at + marker.length));
    // fast/low vs deep/xhigh, expressed in each CLI's own flags. Nobody gets --model
    // until the person chooses one, and grok/antigravity degrade xhigh to their ceiling.
    assert.deepEqual(argv.claude.day_read, ["--effort", "low", "-p", prompt]);
    assert.deepEqual(argv.claude.proposal, ["--effort", "xhigh", "-p", prompt]);
    // With deep bound to opus: the deep op carries it, the fast op still does not.
    assert.deepEqual(argv.bound.day_read, ["--effort", "low", "-p", prompt]);
    assert.deepEqual(argv.bound.proposal, ["--model", "opus", "--effort", "xhigh", "-p", prompt]);
    assert.deepEqual(argv.codex.day_read, [
      "exec",
      "-c",
      "model_reasoning_effort=low",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      prompt,
    ]);
    assert.deepEqual(argv.codex.proposal, [
      "exec",
      "-c",
      "model_reasoning_effort=xhigh",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      prompt,
    ]);
    assert.deepEqual(argv.antigravity.day_read, ["--effort", "low", "-p", prompt, "--print-timeout", "5m"]);
    assert.deepEqual(argv.antigravity.proposal, ["--effort", "high", "-p", prompt, "--print-timeout", "5m"]);
    assert.deepEqual(argv.grok.day_read, ["--reasoning-effort", "low", "-p", prompt]);
    assert.deepEqual(argv.grok.proposal, ["--reasoning-effort", "high", "-p", prompt]);
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
