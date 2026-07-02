// Health-model routing defaults (src/runChosen.ts defaultOrderForOp +
// src/repo/settings.ts pickResearchAgentOrder). Medical-data analysis must default to
// the faithful Claude-first health order (not the round-robin rotation) when the user
// hasn't pinned an agent; live web research must default to a web-capable-first order.
// An explicit pin still wins (handled upstream via resolveAgentForTask). All offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { defaultOrderForOp } from "../dist/runChosen.js";

test("pickResearchAgentOrder puts a web-capable agent FIRST", () => {
  const order = repo.pickResearchAgentOrder({
    agents: [
      { name: "codex", web_access: false },
      { name: "claude", web_access: true },
      { name: "grok", web_access: false },
    ],
  });
  assert.equal(order[0], "claude", "the web-capable agent leads research");
  assert.deepEqual([...order].sort(), ["claude", "codex", "grok"]);
});

test("pickResearchAgentOrder with no web-capable agent preserves the given order", () => {
  const order = repo.pickResearchAgentOrder({ agents: [{ name: "codex" }, { name: "grok" }] });
  assert.deepEqual(order, ["codex", "grok"]);
});

test("pickResearchAgentOrder degenerate (<=1 usable) returns as-is", () => {
  assert.deepEqual(repo.pickResearchAgentOrder({ agents: [{ name: "codex" }] }), ["codex"]);
  assert.deepEqual(repo.pickResearchAgentOrder({ agents: [] }), []);
});

test("defaultOrderForOp routes health ops to the Claude-first health order", () => {
  // These delegate to pickHealthAgentOrder (NO round-robin cursor side effect), so
  // calling the picker directly returns the same order deterministically.
  assert.deepEqual(defaultOrderForOp("health_review"), repo.pickHealthAgentOrder());
  assert.deepEqual(defaultOrderForOp("health_synthesis"), repo.pickHealthAgentOrder());
  assert.deepEqual(defaultOrderForOp("marker_reconcile"), repo.pickHealthAgentOrder());
});

test("defaultOrderForOp routes research web-capable-first, and other ops to the rotation", () => {
  assert.deepEqual(defaultOrderForOp("research"), repo.pickResearchAgentOrder());
  // A non-health, non-research op uses the ordinary rotation. Force a deterministic
  // strategy so the round-robin cursor doesn't drift between the two reads.
  repo.setSettings({ agent_strategy: "priority" });
  assert.deepEqual(defaultOrderForOp("chat"), repo.pickAgentOrder());
  repo.setSettings({ agent_strategy: "round_robin" });
});

test("an explicit agent pin still wins for a health op (routing default is only for auto)", () => {
  // resolveAgentForTask (consulted first in runChosen) honors an explicit agent as-is.
  assert.equal(repo.resolveAgentForTask("health_review", "grok", { routes: {}, enabled: ["claude", "codex", "grok"] }), "grok");
});
