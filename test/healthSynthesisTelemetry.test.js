// Health synthesis is its own routed/telemetry operation, not a generic "auto"
// agent run. The offline stub lets this exercise the real coachOps -> runChosen
// -> runAgentWithFallback path without invoking an external model.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setAgentRunSink } from "../dist/agents.js";
import { synthesizeHealth } from "../dist/coachOps.js";
import { normalizeHealthSynthesis } from "../dist/health-synthesis.js";

afterEach(() => {
  setAgentRunSink(null);
});

test("synthesizeHealth records health_synthesis as the agent op", async () => {
  const runs = [];
  setAgentRunSink((r) => runs.push(r));

  await synthesizeHealth("stub");

  assert.equal(runs.length, 1);
  assert.equal(runs[0].op, "health_synthesis");
  assert.equal(runs[0].agent, "stub");
});

test("normalizeHealthSynthesis clamps and filters the agent shape", () => {
  const normalized = normalizeHealthSynthesis({
    headline: "  Lipids and recovery are the lead  ",
    story: "A ".repeat(900),
    priorities: [
      { label: " Lipids ".repeat(20), why_it_matters: " ApoB ".repeat(60), the_move: " More soluble fiber ".repeat(40), recheck: " next panel ".repeat(30) },
      { label: "   ", why_it_matters: "ignored without label or move" },
      { the_move: "Hold the easy-volume floor" },
    ],
    one_change: "Add oats or beans most days. ".repeat(20),
  }, { agent: " stub ", generated_at: "2026-06-19T12:00:00.000Z" });

  assert.ok(normalized);
  assert.equal(normalized.agent, "stub");
  assert.equal(normalized.generated_at, "2026-06-19T12:00:00.000Z");
  assert.equal(normalized.headline, "Lipids and recovery are the lead");
  assert.ok(normalized.story.length <= 1400);
  assert.equal(normalized.priorities.length, 2);
  assert.ok(normalized.priorities[0].label.length <= 60);
  assert.ok(normalized.priorities[0].why_it_matters.length <= 220);
  assert.ok(normalized.priorities[0].the_move.length <= 320);
  assert.ok(normalized.priorities[0].recheck.length <= 160);
  assert.ok(normalized.one_change.length <= 200);
});

test("normalizeHealthSynthesis rejects empty or found:false shapes", () => {
  assert.equal(normalizeHealthSynthesis({ found: false, headline: "no" }, { generated_at: "2026-06-19T12:00:00.000Z" }), null);
  assert.equal(normalizeHealthSynthesis({ priorities: [{ label: "Only a list" }] }, { generated_at: "2026-06-19T12:00:00.000Z" }), null);
});
