// What each background runner does with "every spawn permit was busy".
//
// The spawn cap's wait is bounded now, so a run that never reaches the front fails
// instead of hanging. That failure must never be spent like an ordinary one: no CLI
// started, so the enrichment row has not been read, the agent job has not been tried,
// and the scheduled operation has not been attempted. Each lane defers — with a finite
// budget, so nothing waits in silence forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_BUSY_MAX_DEFERRALS, AgentBusyError, resetAgentBusyDeferralsForTest } from "../dist/agent-busy.js";
import { enrichFailureAction } from "../dist/enrich.js";
import { recordSchedulerFailure } from "../dist/diagnostics.js";
import { schedulerTaskError } from "../dist/provider-unavailable.js";
import { repo } from "./_seed.js";

function busy() {
  return new AgentBusyError("claude", 120_000);
}

test("the enrichment drain defers a busy job, and fails it only once the budget is gone", () => {
  resetAgentBusyDeferralsForTest();
  const job = { kind: "health", id: 41 };
  for (let i = 0; i < AGENT_BUSY_MAX_DEFERRALS; i++) {
    assert.equal(enrichFailureAction(job, busy()), "defer", `deferral ${i + 1} keeps the document owed`);
  }
  assert.equal(
    enrichFailureAction(job, busy()),
    "fail",
    "a queue permanently over capacity still has to tell someone"
  );

  // Everything else is the job's own failure and is filed as one, first time.
  assert.equal(enrichFailureAction({ kind: "health", id: 42 }, new Error("ran but returned no valid JSON")), "fail");
  assert.equal(enrichFailureAction({ kind: "food", id: 42 }, new Error("timed out")), "fail");
  resetAgentBusyDeferralsForTest();
});

test("a deferred agent job goes back in the queue instead of into an ending", () => {
  const created = repo.createAgentJob({ kind: "insight" });
  const id = Number(created.id);
  assert.equal(repo.markAgentJobRunning(id).status, "running");

  const deferred = repo.deferAgentJob(id);
  assert.equal(deferred.status, "queued", "queued is not an ending — the card keeps waiting, not failing");
  assert.equal(deferred.phase, "queued");
  assert.equal(deferred.started_at, null, "it has not started yet, because it hasn't");
  assert.equal(deferred.error, null);

  // And it is genuinely runnable again (markAgentJobRunning only picks up 'queued').
  assert.equal(repo.markAgentJobRunning(id).status, "running");

  // A job that already reached a real ending is never resurrected by a defer.
  repo.failAgentJob(id, "ran but returned no valid JSON");
  assert.equal(repo.deferAgentJob(id).status, "error");
});

test("a scheduled operation that could not start is deferred, never filed as a task failure", () => {
  const events = [];
  const sink = (event) => events.push(event);

  recordSchedulerFailure("insight_last_date", busy(), sink);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "task_deferred", "not task_failure — nothing about the operation is broken");
  assert.equal(events[0].level, "warning");
  assert.equal(events[0].operation, "insight_last_date");
  assert.match(events[0].fingerprint, /task_deferred:insight_last_date:agent_busy/);

  recordSchedulerFailure("insight_last_date", new Error("boom"), sink);
  assert.equal(events[1].kind, "task_failure", "a real failure still reads as one");
  assert.equal(events[1].level, "error");
});

test("an op's busy envelope reaches the scheduler as the same typed deferral", () => {
  // A coachOp answers 200 with `{ok:false}` rather than throwing, so the scheduler's
  // one task-error chokepoint is where that envelope becomes the typed error.
  const fromBusy = schedulerTaskError("insight_last_date", { ok: false, error: "no insight", agent_busy: true }, "x");
  assert.equal(fromBusy.code, "agent_busy");

  const events = [];
  recordSchedulerFailure("insight_last_date", fromBusy, (event) => events.push(event));
  assert.equal(events[0].kind, "task_deferred");

  // An ordinary refusal keeps its ordinary error, and its ordinary diagnostic.
  const plain = schedulerTaskError("insight_last_date", { ok: false, error: "nothing to say" }, "fallback");
  assert.equal(plain.code, undefined);
  assert.equal(plain.message, "nothing to say");
});
