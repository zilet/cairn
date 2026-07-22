// The generalized "right model for the job" layer (src/repo/settings.ts
// taskForOp / TASK_POLICY / pickAgentOrderForTask). This extends the health-doc
// ingestion pattern (pickHealthAgentOrder) to every agentic task class: an explicit
// agent_routes.<task> pin wins — exclusively for a rotation-policy task, pin-first WITH
// a fallthrough tail for an accuracy-critical one — else the task class's default policy
// (accuracy-critical Claude-first vs. the ordinary rotation) applies. Fully offline
// via injected cfg — no DB writes needed for most cases, though a few cases exercise
// the real settings round-trip (agent_routes persistence + disabled-agent filtering).
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

const ENABLED = ["claude", "codex", "grok"];

test("taskForOp: most ops are their own task class (pass-through)", () => {
  for (const op of ["chat", "day_read", "session_suggest", "nutrition_checkin", "meal_plan", "meal_swap", "recipe", "insight", "weekly_read", "health_review", "health_synthesis"]) {
    assert.equal(repo.taskForOp(op), op);
  }
});

test("taskForOp: the case-conference conductor and its per-domain specialists fold to brain_review", () => {
  assert.equal(repo.taskForOp("case_conference"), "brain_review");
  assert.equal(repo.taskForOp("conference_training"), "brain_review");
  assert.equal(repo.taskForOp("conference_nutrition"), "brain_review");
});

test("taskForOp: evolve_program shares the proposal task with the ordinary coach draft", () => {
  assert.equal(repo.taskForOp("evolve_program"), "proposal");
  assert.equal(repo.taskForOp("proposal"), "proposal");
});

test("taskForOp: marker_reconcile shares the health task", () => {
  assert.equal(repo.taskForOp("marker_reconcile"), "health");
});

test("pickAgentOrderForTask: an explicit, usable pin wins outright (one-element order)", () => {
  const order = repo.pickAgentOrderForTask("enrich", { enabled: ENABLED, routes: { enrich: "codex" } });
  assert.deepEqual(order, ["codex"]);
});

test("pickAgentOrderForTask: a pin to a DISABLED agent falls through to the class default", () => {
  // grok pinned but not in the enabled set → ignored, falls to policy default.
  const order = repo.pickAgentOrderForTask("health", { enabled: ["claude", "codex"], routes: { health: "grok" } });
  assert.deepEqual(order, ["claude", "codex"]);
});

test("pickAgentOrderForTask: no pin -> accuracy-critical tasks get the Claude-first order", () => {
  for (const task of ["health", "health_review", "health_synthesis", "brain_review"]) {
    const order = repo.pickAgentOrderForTask(task, { enabled: ["grok", "codex", "claude"], routes: {} });
    assert.deepEqual(order, ["claude", "codex", "grok"], `${task} should prefer claude then codex first`);
  }
});

test("pickAgentOrderForTask: no pin -> rotation-policy tasks return the given enabled set as-is (cfg mode)", () => {
  for (const task of ["chat", "day_read", "session_suggest", "nutrition_checkin", "meal_plan", "meal_swap", "recipe", "insight", "weekly_read", "enrich", "proposal"]) {
    const order = repo.pickAgentOrderForTask(task, { enabled: ["codex", "grok"], routes: {} });
    assert.deepEqual(order, ["codex", "grok"], `${task} should not reorder for the rotation policy`);
  }
});

test("pickAgentOrderForTask: an unknown/unlisted task falls through to rotation (no invented policy)", () => {
  const order = repo.pickAgentOrderForTask("some_future_task", { enabled: ["codex", "grok"], routes: {} });
  assert.deepEqual(order, ["codex", "grok"]);
});

test("pickAgentOrderForTask: degenerate (<=1 usable) returns as-is regardless of policy", () => {
  assert.deepEqual(repo.pickAgentOrderForTask("health", { enabled: ["claude"], routes: {} }), ["claude"]);
  assert.deepEqual(repo.pickAgentOrderForTask("chat", { enabled: [], routes: {} }), []);
});

test("pickAgentOrderForTask: a pin for a DIFFERENT accuracy task is never cross-applied", () => {
  // agent_routes.health is pinned, but resolving "brain_review" must not fall back
  // to health's pin — each accuracy task only honors its OWN route key.
  const order = repo.pickAgentOrderForTask("brain_review", { enabled: ["codex", "claude"], routes: { health: "codex" } });
  assert.deepEqual(order, ["claude", "codex"], "brain_review's own (absent) pin must not inherit health's pin");
});

test("pickHealthAgentOrder behavior is unchanged (aliased into the new mechanism, not replaced)", () => {
  // Direct calls to the original function — used by tests + any caller that hasn't
  // moved to pickAgentOrderForTask — must still behave exactly as before.
  assert.deepEqual(
    repo.pickHealthAgentOrder(["claude", "codex"], { enabled: ["grok", "codex", "claude"] }),
    ["claude", "codex", "grok"]
  );
  assert.deepEqual(repo.pickHealthAgentOrder(["claude", "codex"], { enabled: ["claude"] }), ["claude"]);
  assert.deepEqual(repo.pickHealthAgentOrder(["claude", "codex"], { enabled: [] }), []);
  // "health" is an ACCURACY-policy task, so a pin resolves pin-FIRST WITH a fallthrough
  // tail (accuracy paths must never hard-fail on a dead pinned CLI — a downgraded-but-
  // faithful transcriber beats none), matching pickHealthAgentOrder's own front-with-tail
  // `route` semantics. A ROTATION-policy pin, by contrast, stays exclusive (see the
  // enrich test above returning just ["codex"]).
  const viaTask = repo.pickAgentOrderForTask("health", { enabled: ["grok", "claude"], routes: { health: "grok" } });
  assert.deepEqual(viaTask, ["grok", "claude"], "an accuracy pin is pin-first with a fallthrough tail");
});

test("settings round-trip: agent_routes persists pins for every new task class", () => {
  repo.setSettings({ disabled_agents: [] }); // enable stub so it's a valid pin target
  const before = repo.getSettings().agent_routes;
  try {
    const saved = repo.setSettings({
      agent_routes: { health: "stub", enrich: "stub", proposal: "stub", brain_review: "stub" },
    });
    assert.deepEqual(saved.agent_routes, { health: "stub", enrich: "stub", proposal: "stub", brain_review: "stub" });
    const reread = repo.getSettings();
    assert.deepEqual(reread.agent_routes, { health: "stub", enrich: "stub", proposal: "stub", brain_review: "stub" });
    // listRoutableTasks() reports these as real, pinnable task keys.
    const keys = repo.listRoutableTasks().map((t) => t.key);
    for (const task of ["health", "enrich", "proposal", "brain_review"]) {
      assert.ok(keys.includes(task), `${task} should be a listed routable task`);
    }
  } finally {
    repo.setSettings({ agent_routes: before, disabled_agents: ["stub"] });
  }
});

test("settings round-trip: an unknown task key is dropped (forward-compatible no-op)", () => {
  const saved = repo.setSettings({ agent_routes: { not_a_real_task: "claude" } });
  assert.deepEqual(saved.agent_routes, {});
});

test("settings round-trip: a route to a disabled/unknown agent is pruned on save", () => {
  const saved = repo.setSettings({ agent_routes: { health: "not_a_real_agent" } });
  assert.deepEqual(saved.agent_routes, {});
});

test("defaultOrderForOp (runChosen) resolves through the same task registry for the new classes", async () => {
  const { defaultOrderForOp } = await import("../dist/runChosen.js");
  repo.setSettings({ agent_strategy: "priority", agent_routes: {} });
  try {
    assert.deepEqual(defaultOrderForOp("case_conference"), repo.pickAgentOrderForTask("brain_review"));
    assert.deepEqual(defaultOrderForOp("conference_training"), repo.pickAgentOrderForTask("brain_review"));
    assert.deepEqual(defaultOrderForOp("evolve_program"), repo.pickAgentOrderForTask("proposal"));
    assert.deepEqual(defaultOrderForOp("proposal"), repo.pickAgentOrderForTask("proposal"));
  } finally {
    repo.setSettings({ agent_strategy: "round_robin" });
  }
});

test("resolveAgentForTask honors a brain_review pin for both case_conference and a per-domain specialist call", () => {
  const cfg = { routes: { brain_review: "codex" }, enabled: ENABLED };
  assert.equal(repo.resolveAgentForTask(repo.taskForOp("case_conference"), "auto", cfg), "codex");
  assert.equal(repo.resolveAgentForTask(repo.taskForOp("conference_recovery"), "auto", cfg), "codex");
});
