// "Which model ran at what effort" is auditable for EVERY op, not only chat: the model a
// spawn asked for (--model, or null = the CLI's own default) lands on the run row beside
// the effort, the model the CLI reports is parsed best-effort, and the stats read rolls
// both up and flags a Settings binding that never reached a spawn.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, repo, resetTables } from "./_seed.js";
import { invalidateAgentConfigured, runAgentWithFallback, extractAgentUsage, setAgentRunSink } from "../dist/agents.js";
import { resolveTaskExecutionProfile } from "../dist/repo/settings.js";

const CLAUDE = {
  command: "claude",
  args: [],
  model_flag: ["--model", "{model}"],
  reasoning_flag: ["--effort", "{reasoning}"],
  capabilities: { model: true, reasoning: ["low", "medium", "high"] },
};
const NO_MODEL = {
  command: "nomodel",
  args: [],
  reasoning_flag: ["--effort", "{reasoning}"],
  capabilities: { reasoning: ["low", "medium", "high"] },
};
const defs = { claude: CLAUDE, nomodel: NO_MODEL };

beforeEach(() => {
  resetTables("agent_runs");
  db.prepare("DELETE FROM settings WHERE id = 1").run();
});

// Runs `op` through the real rotation against a fake CLI that echoes its argv model/effort
// and, like claude stream-json, also announces the model it ran on an init line.
async function runFake(agentName, op, classBindings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-model-audit-"));
  const cli = path.join(dir, "fake-cli");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nconst a = process.argv;\nconst at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };\n` +
      `console.log(JSON.stringify({ found: true, model: at("--model"), effort: at("--effort") }));\n` +
      `console.log(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }));\n`
  );
  fs.chmodSync(cli, 0o755);
  const configPath = path.join(dir, "agents.json");
  const def = agentName === "claude" ? CLAUDE : NO_MODEL;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      [agentName]: { ...def, command: cli, args: ["{model_args}", "{reasoning_args}", "-p", "{prompt}"], input: "arg" },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  const rows = [];
  setAgentRunSink((r) => {
    rows.push(r);
    repo.recordAgentRun(r);
  });
  try {
    const out = await runAgentWithFallback([agentName], "Answer.", {
      op,
      timeoutMs: 10_000,
      acceptParsed: (p) => p?.found === true,
      profile: (agent) =>
        resolveTaskExecutionProfile("week_ahead", agent, { defs, bindings: {}, classBindings, risk: null }),
    });
    return { out, row: rows.at(-1) };
  } finally {
    setAgentRunSink(null);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a non-chat op records the --model it spawned with, the effort, and the model the CLI reported", async () => {
  const { out, row } = await runFake("claude", "week_ahead", { claude: { fast: "sonnet", deep: "opus" } });
  assert.equal(out.result.parsed.model, "sonnet", "the binding reached the spawn argv");
  assert.equal(row.requested_model, "sonnet");
  assert.equal(row.requested_reasoning, "low");
  assert.equal(row.model, "claude-sonnet-4-5", "the init line's model is parsed into the run row");
  const stored = db.prepare("SELECT requested_model, requested_reasoning, model FROM agent_runs").get();
  assert.equal(stored.requested_model, "sonnet", "an alias survives the telemetry sanitizer");
  assert.equal(stored.requested_reasoning, "low");
  assert.equal(stored.model, "claude-sonnet-4-5");
});

test("no binding, or a provider with no model support, records a null requested model", async () => {
  const unbound = await runFake("claude", "week_ahead", {});
  assert.equal(unbound.row.requested_model, null);
  assert.equal(unbound.row.requested_reasoning, "low");
  resetTables("agent_runs");
  const nomodel = await runFake("nomodel", "week_ahead", { nomodel: { fast: "sonnet" } });
  assert.equal(nomodel.out.result.parsed.model, null);
  assert.equal(nomodel.row.requested_model, null);
  assert.equal(nomodel.row.requested_reasoning, "low");
});

test("a model reported in a claude result envelope is read, and a parse miss is just null", () => {
  assert.equal(
    extractAgentUsage(
      JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 5, output_tokens: 7 }, modelUsage: { "claude-opus-4-1": {} } })
    ).model,
    "claude-opus-4-1"
  );
  assert.equal(extractAgentUsage("not json at all").model ?? null, null);
});

test("stats roll runs up by model and by op x model x effort, and flag a binding that never reached a spawn", () => {
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet" } } });
  const base = { agent: "claude", ok: true, parsed: true, latency_ms: 100, tried_json: false };
  repo.recordAgentRun({ ...base, op: "week_ahead", requested_model: "sonnet", requested_reasoning: "low" });
  repo.recordAgentRun({ ...base, op: "week_ahead", requested_model: "sonnet", requested_reasoning: "low", ok: false, latency_ms: 300 });
  repo.recordAgentRun({ ...base, op: "day_read", requested_model: null, requested_reasoning: "low" });
  const stats = repo.getAgentStats();
  const bySonnet = stats.by_model.find((m) => m.requested_model === "sonnet");
  assert.equal(bySonnet.runs, 2);
  assert.equal(bySonnet.ok_rate, 0.5);
  const cell = stats.by_op_effort.find((m) => m.op === "week_ahead");
  assert.deepEqual(
    { model: cell.requested_model, effort: cell.effort, runs: cell.runs, p50_ms: cell.p50_ms },
    { model: "sonnet", effort: "low", runs: 2, p50_ms: 100 }
  );
  assert.deepEqual(stats.model_bindings.unreached, [{ agent: "claude", op: "day_read", model_class: "fast", runs: 1 }]);
  assert.ok(Array.isArray(stats.by_agent) && Array.isArray(stats.by_op), "existing fields keep their shape");
});
