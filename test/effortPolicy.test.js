// Effort is server policy: low for everyday work, one more step only where it pays.
// Measured live on all four CLIs (2026-10-13): low matched or beat medium on the everyday
// ops, graded blind, and answered faster on every one. These hold the policy's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { localDateISO, addDaysISO } from "../dist/repo/shared.js";
import {
  INTERACTIVE_LEASH_FLOOR_MS,
  TASK_EXECUTION_PROFILES,
  interactiveTimeoutForOp,
  resolveTaskExecutionProfile,
} from "../dist/repo/settings.js";
import { effortRiskFor } from "../dist/repo/effort-risk.js";
import { interactiveTimeoutFor, repairReasoningStep } from "../dist/agents.js";
import { chatTurnTimeoutMs } from "../dist/chat-routing-runtime.js";

const CLAUDE = {
  command: "claude",
  args: [],
  reasoning_flag: ["--effort", "{reasoning}"],
  capabilities: { reasoning: ["low", "medium", "high", "xhigh", "max"] },
};
const GROK = {
  command: "grok",
  args: [],
  reasoning_flag: ["--reasoning-effort", "{reasoning}"],
  capabilities: { reasoning: ["low", "medium", "high"] },
};
const defs = { claude: CLAUDE, grok: GROK };
const resolve = (task, extra = {}) =>
  resolveTaskExecutionProfile(task, "claude", { defs, bindings: {}, classBindings: {}, risk: null, ...extra });

test("everyday work is low; depth is kept for the special items", () => {
  for (const task of [
    "day_read",
    "weekly_read",
    "week_ahead",
    "session_suggest",
    "meal_swap",
    "recipe",
    "enrich",
    "research",
  ]) {
    assert.equal(TASK_EXECUTION_PROFILES[task].reasoning, "low", task);
  }
  for (const task of [
    "session_verify", "meal_plan_verify", "plan_verify", "meal_plan", "health", "insight", "nutrition_checkin", "what_if",
    // The special items run medium and earn ONE step to high only on a server-seen risk.
    "health_review", "health_synthesis", "proposal", "coach_draft", "brain_review",
  ]) {
    assert.equal(TASK_EXECUTION_PROFILES[task].reasoning, "medium", task);
  }
  // The one standing high: a flagged lab finding researched against the evidence.
  assert.equal(TASK_EXECUTION_PROFILES.research_deep.reasoning, "high", "research_deep");
  assert.ok(
    !Object.values(TASK_EXECUTION_PROFILES).some((p) => p.reasoning === "xhigh" || p.reasoning === "max"),
    "xhigh/max are a person's choice"
  );
});

test("a risky moment earns the default one step, and a person's own choice always wins", () => {
  assert.equal(resolve("session_suggest").reasoning, "low");
  assert.equal(resolve("session_suggest", { risk: "open_pain" }).reasoning, "medium");
  assert.equal(resolve("session_verify", { risk: "open_pain" }).reasoning, "high");
  assert.equal(resolve("proposal", { risk: "race_window" }).reasoning, "high", "never past high");
  const bindings = { claude: { session_suggest: { reasoning: "low" } } };
  assert.equal(
    resolve("session_suggest", { bindings, risk: undefined }).reasoning,
    "low",
    "a bound effort is never bumped"
  );
});

test("the risks are read from what the athlete said and what the server knows", () => {
  const today = localDateISO();
  assert.equal(effortRiskFor("session_suggest", today), null);

  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on) VALUES ('chat', 'left knee', 'active', 'area', ?, ?)`
  ).run(today, today);
  assert.equal(effortRiskFor("session_suggest", today), "open_pain");
  assert.equal(effortRiskFor("insight", today), null, "a read op never bumps");
  assert.equal(effortRiskFor("meal_swap", today), null, "pain is a training risk");
  db.prepare(`UPDATE training_symptom_events SET last_reported_on = ?`).run(addDaysISO(today, -30));
  assert.equal(effortRiskFor("session_suggest", today), null, "an old report is not today's risk");
  db.prepare(`UPDATE training_symptom_events SET last_reported_on = ?, scope = 'systemic'`).run(today);
  assert.equal(effortRiskFor("session_suggest", today), null, "a systemic report names no place");

  db.prepare(`INSERT OR IGNORE INTO profile (id) VALUES (1)`).run();
  db.prepare(`UPDATE profile SET endurance_goal_json = ? WHERE id = 1`).run(
    JSON.stringify({ mode: "race", date: addDaysISO(today, 10), distance_km: 21.1 })
  );
  assert.equal(effortRiskFor("week_ahead", today), "race_window");
  db.prepare(`UPDATE profile SET endurance_goal_json = ? WHERE id = 1`).run(
    JSON.stringify({ mode: "race", date: addDaysISO(today, 40), distance_km: 21.1 })
  );
  assert.equal(effortRiskFor("week_ahead", today), null);

  db.prepare(
    `INSERT INTO health_directives (source, domain, directive, status, uncertain) VALUES ('markers', 'nutrition', 'iron-forward meals', 'active', 0)`
  ).run();
  assert.equal(effortRiskFor("meal_plan", today), "new_finding");
  db.prepare(`UPDATE health_directives SET created_at = datetime('now', '-30 days')`).run();
  assert.equal(effortRiskFor("meal_plan", today), null, "a standing finding is the ordinary case");
});

test("a contract repair thinks one declared step harder, never past high", () => {
  assert.equal(repairReasoningStep(CLAUDE, "low"), "medium");
  assert.equal(repairReasoningStep(CLAUDE, "medium"), "high");
  assert.equal(repairReasoningStep(CLAUDE, "high"), null);
  assert.equal(repairReasoningStep(GROK, "medium"), "high");
  assert.equal(repairReasoningStep(CLAUDE, undefined), null, "the CLI's own default has nothing to step from");
  assert.equal(repairReasoningStep({ command: "x", args: [] }, "low"), null);
});

test("going low never shortens a slow CLI's leash, except the Brief's own", () => {
  assert.equal(interactiveTimeoutForOp("day_read"), interactiveTimeoutFor("low"));
  assert.equal(interactiveTimeoutForOp("session_suggest"), INTERACTIVE_LEASH_FLOOR_MS);
  assert.ok(interactiveTimeoutForOp("health_review") >= INTERACTIVE_LEASH_FLOOR_MS);
  assert.ok(chatTurnTimeoutMs({ requested: { reasoning: "low" } }) >= 150_000);
});

test("end to end: the repair run carries the stepped effort, and the run log says so", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { invalidateAgentConfigured, runAgentWithFallback, setAgentRunSink } = await import("../dist/agents.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-effort-repair-"));
  const cli = path.join(dir, "fake-cli");
  // Off-contract at low effort, on-contract at any higher one.
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nconst i = process.argv.indexOf("--effort");\nconst effort = i >= 0 ? process.argv[i + 1] : "none";\nconsole.log(JSON.stringify(effort === "low" ? { wrong: true } : { found: true, effort }));\n`
  );
  fs.chmodSync(cli, 0o755);
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ claude: { ...CLAUDE, command: cli, args: ["{reasoning_args}", "-p", "{prompt}"], input: "arg" } })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  const rows = [];
  setAgentRunSink((r) => rows.push(r));
  try {
    const out = await runAgentWithFallback(["claude"], "Answer.", {
      op: "insight",
      reasoning: "low",
      timeoutMs: 10_000,
      acceptParsed: (p) => p?.found === true,
    });
    assert.deepEqual(out.result.parsed, { found: true, effort: "medium" });
    const row = rows.at(-1);
    assert.equal(row.tried_json, true);
    assert.equal(row.requested_reasoning, "low");
    assert.equal(row.effective_reasoning, "medium");
  } finally {
    setAgentRunSink(null);
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the heavy ops run medium and a server-seen risk lifts them one step, never past high", () => {
  for (const task of ["proposal", "coach_draft", "brain_review", "health_review", "health_synthesis"]) {
    assert.equal(resolve(task).reasoning, "medium", `${task} defaults to medium`);
    assert.equal(resolve(task, { risk: "open_pain" }).reasoning, "high", `${task} steps once on a risk`);
  }
  assert.equal(resolve("research_deep", { risk: "open_pain" }).reasoning, "high", "never past high");
});
