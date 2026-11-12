// Every enrichment agent call carries its own telemetry label (agent_runs.op) instead
// of the anonymous "auto" — and the label changes nothing about HOW the call runs.
//
// In runAgentWithFallback `op` is a log/telemetry field only. Which agents run is the
// `order` each enrich.ts site picks with pickAgentOrderForTask; how they run is the
// `profile` each site passes explicitly with executionProfileForTask. So the proof is
// twofold: the labels are not routing/profile keys at all, and a real enrichment run
// through a fake CLI records the new label next to exactly the effort the enrich task
// profile resolves to.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repo, resetTables } from "./_seed.js";
import { ENRICH_OPS, processExerciseJob } from "../dist/enrich.js";
import { invalidateAgentConfigured, setAgentRunSink } from "../dist/agents.js";
import { TASK_EXECUTION_PROFILES, TASK_POLICY, executionProfileForTask, taskForOp } from "../dist/repo/settings.js";

test("the enrichment labels are telemetry only: none is a routing or profile key", () => {
  const labels = Object.values(ENRICH_OPS);
  assert.equal(new Set(labels).size, labels.length, "each call site has its own label");
  for (const op of labels) {
    assert.match(op, /^enrich_[a-z_]+$/);
    assert.equal(TASK_POLICY[taskForOp(op)], undefined, `${op} picks no agent order`);
    assert.equal(TASK_EXECUTION_PROFILES[taskForOp(op)], undefined, `${op} resolves no profile`);
  }
});

test("an exercise enrichment records enrich_exercise at the enrich task's own effort", async () => {
  resetTables("agent_runs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-enrich-op-"));
  const cli = path.join(dir, "fake-cli");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nconst a = process.argv; const i = a.indexOf("--effort");\n` +
      `console.log(JSON.stringify({ canonical: null, muscle_group: "back", mode: null, equipment: null, effort: i >= 0 ? a[i + 1] : null }));\n`
  );
  fs.chmodSync(cli, 0o755);
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      claude: {
        command: cli,
        args: ["{reasoning_args}", "-p", "{prompt}"],
        input: "arg",
        reasoning_flag: ["--effort", "{reasoning}"],
        capabilities: { reasoning: ["low", "medium", "high"] },
      },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  const runs = [];
  setAgentRunSink((r) => runs.push(r));
  try {
    repo.setSettings({ enrich_enabled: true, disabled_agents: [] });
    const ex = repo.findOrCreateExercise("Chest Supported Row");
    await processExerciseJob(ex.id);
    assert.ok(runs.length >= 1, "the enrichment reached the CLI");
    const run = runs[0];
    assert.equal(run.op, "enrich_exercise", "the call is labelled, not 'auto'");
    const expected = executionProfileForTask("enrich")("claude")?.reasoning ?? null;
    assert.ok(expected, "the enrich task asks for an effort, so the comparison below is not null === null");
    assert.equal(run.requested_reasoning ?? null, expected, "the effort is the enrich task's, unchanged");
  } finally {
    setAgentRunSink(null);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
