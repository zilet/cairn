// "Every spawn permit was busy" is a NON-EVENT, and the whole point of typing it is
// that a background runner can tell it apart from work that actually failed. These pin
// the contract every runner branches on: the code survives a re-wrap, the envelope form
// carries the same fact through an op's `{ok:false}` answer, and the deferral budget is
// finite — a job deferred forever is a job nobody is ever told about.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_BUSY_MAX_DEFERRALS,
  AgentBusyError,
  agentBusyErrorForOperation,
  agentBusyEnvelopeFields,
  clearAgentBusyDeferrals,
  isAgentBusyError,
  isAgentBusyResult,
  noteAgentBusyDeferral,
  resetAgentBusyDeferralsForTest,
} from "../dist/agent-busy.js";

test("busy is recognizable by its code, not only by its prototype", () => {
  const typed = new AgentBusyError("claude", 120_000);
  assert.equal(isAgentBusyError(typed), true);
  assert.equal(typed.code, "agent_busy");
  assert.equal(typed.name, "AgentBusyError");
  assert.match(typed.message, /busy/);

  // A worker that re-wraps or serializes the error keeps the code, and must still be
  // able to defer — losing the prototype must never turn congestion into a failure.
  assert.equal(isAgentBusyError({ code: "agent_busy", message: "agent busy" }), true);

  assert.equal(isAgentBusyError(new Error("agent timed out")), false);
  assert.equal(isAgentBusyError(null), false);
  assert.equal(isAgentBusyError("busy"), false, "the word alone proves nothing");
});

test("an op's {ok:false} envelope carries the same fact, since it never throws", () => {
  assert.deepEqual(agentBusyEnvelopeFields(new AgentBusyError("grok", 90_000)), { agent_busy: true });
  assert.deepEqual(agentBusyEnvelopeFields(new Error("ran but returned no valid JSON")), {});

  assert.equal(isAgentBusyResult({ ok: false, error: "no session", agent_busy: true }), true);
  assert.equal(isAgentBusyResult({ ok: false, error: "no session" }), false, "an ordinary refusal is on the merits");
  assert.equal(isAgentBusyResult(null), false);

  // Read back off an envelope there is no agent and no measured wait — the whole
  // rotation was waiting on one process-wide permit.
  const fromEnvelope = agentBusyErrorForOperation("insight");
  assert.equal(isAgentBusyError(fromEnvelope), true);
  assert.equal(fromEnvelope.waitedMs, null);
  assert.match(fromEnvelope.message, /insight/);
});

test("the deferral budget is finite, and counted per item", () => {
  resetAgentBusyDeferralsForTest();
  for (let i = 1; i <= AGENT_BUSY_MAX_DEFERRALS; i++) {
    assert.deepEqual(noteAgentBusyDeferral("enrich", "health#7"), { deferrals: i, defer: true });
  }
  assert.equal(
    noteAgentBusyDeferral("enrich", "health#7").defer,
    false,
    "past the budget it fails for real rather than waiting forever"
  );
  // The count resets with the item, so a later re-trigger gets a fresh budget.
  assert.deepEqual(noteAgentBusyDeferral("enrich", "health#7"), { deferrals: 1, defer: true });

  // Another item, and the same id in another lane, each keep their own count.
  assert.deepEqual(noteAgentBusyDeferral("enrich", "food#7"), { deferrals: 1, defer: true });
  assert.deepEqual(noteAgentBusyDeferral("agent_jobs", "health#7"), { deferrals: 1, defer: true });

  clearAgentBusyDeferrals("enrich", "health#7");
  assert.deepEqual(noteAgentBusyDeferral("enrich", "health#7"), { deferrals: 1, defer: true }, "a finished item owes nothing");
  resetAgentBusyDeferralsForTest();
});
