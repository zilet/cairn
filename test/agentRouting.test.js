// Per-task agent routing resolution (src/repo.ts resolveAgentForTask). This is the
// pure decision the chat loop + runChosen consult before picking an agent: given a
// task label and the caller's requested agent ("auto"/blank/explicit), it returns the
// pinned agent ONLY when (a) the caller left it to Auto, (b) the task is pinned, and
// (c) that agent is enabled — otherwise it returns the request unchanged so the
// existing rotation (or an explicitly named agent) is honored exactly as before.
// Fully offline: cfg injects routes + the enabled set, no DB, no real agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

const ENABLED = ["claude", "codex", "grok"];

test('an "auto" request with a pinned, enabled agent resolves to that agent', () => {
  const r = repo.resolveAgentForTask("chat", "auto", { routes: { chat: "codex" }, enabled: ENABLED });
  assert.equal(r, "codex");
});

test("health synthesis routes under its own task label", () => {
  const r = repo.resolveAgentForTask("health_synthesis", "auto", { routes: { health_synthesis: "codex" }, enabled: ENABLED });
  assert.equal(r, "codex");
});

test("a blank/undefined request with a pinned, enabled agent resolves to it", () => {
  assert.equal(repo.resolveAgentForTask("meal_plan", undefined, { routes: { meal_plan: "grok" }, enabled: ENABLED }), "grok");
  assert.equal(repo.resolveAgentForTask("meal_plan", "", { routes: { meal_plan: "grok" }, enabled: ENABLED }), "grok");
});

test("an explicitly named agent always wins over a route", () => {
  // The caller asked for claude; even though chat is pinned to codex, honor the request.
  assert.equal(repo.resolveAgentForTask("chat", "claude", { routes: { chat: "codex" }, enabled: ENABLED }), "claude");
});

test("no route for the task falls through (returns the request unchanged)", () => {
  assert.equal(repo.resolveAgentForTask("chat", "auto", { routes: { meal_plan: "codex" }, enabled: ENABLED }), "auto");
  assert.equal(repo.resolveAgentForTask("chat", undefined, { routes: {}, enabled: ENABLED }), undefined);
});

test("a route to a DISABLED agent falls through to the rotation", () => {
  // grok pinned but not in the enabled set → fall back (request returned unchanged).
  const r = repo.resolveAgentForTask("session_suggest", "auto", { routes: { session_suggest: "grok" }, enabled: ["claude", "codex"] });
  assert.equal(r, "auto");
});

test("no task label means no routing (returns the request unchanged)", () => {
  assert.equal(repo.resolveAgentForTask(undefined, "auto", { routes: { chat: "codex" }, enabled: ENABLED }), "auto");
});

test("resolution reads live settings when cfg is omitted", () => {
  // End-to-end through the real settings store: pin chat -> stub (a real agent that
  // setSettings enables on save? stub is disabled by default, so enable it first).
  repo.setSettings({ disabled_agents: [], agent_routes: { chat: "stub" } });
  const enabled = repo.getAgentConfig().filter((a) => a.enabled).map((a) => a.name);
  assert.ok(enabled.includes("stub"), "stub is enabled for this case");
  assert.equal(repo.resolveAgentForTask("chat", "auto"), "stub");
  // And an unrouted task falls through with live settings too.
  assert.equal(repo.resolveAgentForTask("meal_plan", "auto"), "auto");
  // reset for other suites sharing the process
  repo.setSettings({ disabled_agents: ["stub"], agent_routes: {} });
});
