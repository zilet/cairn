import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { runAgentWithFallback } from "../dist/agents.js";
import {
  acceptsWeeklyCoachProposal,
  dailyWindowOperationDue,
  MEMORY_MAINT_STATE_KEY,
  memoryMaintenanceDue,
} from "../dist/scheduler.js";
import { localDateISO } from "../dist/repo/shared.js";
import { brainRevisionSlotStamp } from "../dist/scheduler.js";

const at = (iso) => new Date(iso);

test("brain revision retry ownership is stable for one signature and changes with phase evidence", () => {
  const first = brainRevisionSlotStamp("2026-07", '{"name":"cut"}', "recovery");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, brainRevisionSlotStamp("2026-07", '{"name":"cut"}', "recovery"));
  assert.notEqual(first, brainRevisionSlotStamp("2026-07", '{"name":"maintenance"}', "recovery"));
  assert.notEqual(first, brainRevisionSlotStamp("2026-08", '{"name":"cut"}', "recovery"));
});

test("throw -> persisted retry -> success survives a restart-shaped reread", async () => {
  const operation = "weekly_read";
  const slot = "2026-07-12";
  const first = await repo.runSchedulerOperation(
    operation,
    slot,
    async () => {
      throw new Error("provider offline token=super-secret");
    },
    { now: at("2026-07-12T10:00:00Z"), backoffMs: [1_000] }
  );
  assert.equal(first.status, "retry_wait");
  assert.equal(first.operation.attempts, 1);
  assert.doesNotMatch(first.error, /super-secret/);
  assert.match(first.error, /token=\[redacted\]/);

  // No in-memory owner is needed: a fresh read of the persisted row gates the
  // retry exactly as a restarted process would.
  assert.equal(repo.schedulerOperationDue(operation, slot, at("2026-07-12T10:00:00.999Z")), false);
  assert.equal(repo.schedulerOperationDue(operation, slot, at("2026-07-12T10:00:01.001Z")), true);
  const second = await repo.runSchedulerOperation(
    operation,
    slot,
    async () => ({ outcome: "succeeded", value: { id: 42 } }),
    { now: at("2026-07-12T10:00:01.001Z"), backoffMs: [1_000] }
  );
  assert.equal(second.status, "succeeded");
  assert.deepEqual(second.value, { id: 42 });
  assert.equal(repo.getSchedulerOperation(operation, slot).attempts, 2);
  assert.equal(repo.schedulerOperationDue(operation, slot, at("2026-07-19T10:00:00Z")), false);
});

test("legitimate calm no-op completes while provider unavailable retries", async () => {
  const noOp = await repo.runSchedulerOperation("nutrition_checkin", "2026-07-12", async () => ({
    outcome: "no_op",
    value: { reason: "steady" },
  }));
  assert.equal(noOp.status, "no_op");
  assert.equal(repo.schedulerOperationDue("nutrition_checkin", "2026-07-12"), false);

  const unavailable = await repo.runSchedulerOperation(
    "program_evolution",
    "2026-07-12",
    async () => {
      throw new Error("all providers unavailable");
    },
    { backoffMs: [1_000] }
  );
  assert.equal(unavailable.status, "retry_wait");
  assert.ok(unavailable.operation.next_retry_at);
});

test("expired leases are reclaimed and stale workers are fenced", () => {
  const op = "quiet_insight";
  const slot = "2026-07-16";
  const first = repo.claimSchedulerOperation(op, slot, {
    now: at("2026-07-16T04:00:00Z"),
    leaseMs: 1_000,
  });
  assert.equal(first.status, "running");
  assert.equal(repo.claimSchedulerOperation(op, slot, { now: at("2026-07-16T04:00:00.999Z") }), null);

  const recovered = repo.claimSchedulerOperation(op, slot, {
    now: at("2026-07-16T04:00:01.001Z"),
    leaseMs: 1_000,
  });
  assert.equal(recovered.attempts, 2);
  assert.notEqual(recovered.claim_token, first.claim_token);
  assert.equal(repo.completeSchedulerOperation(first, "succeeded", at("2026-07-16T04:00:01.100Z")), null);
  assert.equal(repo.getSchedulerOperation(op, slot).status, "running");
  assert.equal(repo.completeSchedulerOperation(recovered, "succeeded").status, "succeeded");
});

test("an owned substitute settles retrying/running work and fences stale completion", async () => {
  const op = "meal_plan_refresh_last_slot";
  const retrySlot = "2026-07-12";
  await repo.runSchedulerOperation(
    op,
    retrySlot,
    async () => {
      throw new Error("ordinary provider unavailable");
    },
    { now: at("2026-07-12T10:00:00Z"), backoffMs: [60_000] }
  );
  assert.equal(repo.getSchedulerOperation(op, retrySlot).status, "retry_wait");
  assert.equal(repo.supersedeSchedulerOperation(op, retrySlot, at("2026-07-12T10:00:01Z")).status, "no_op");
  assert.equal(repo.schedulerOperationDue(op, retrySlot, at("2026-07-12T11:00:00Z")), false);

  const runningSlot = "2026-07-19";
  const stale = repo.claimSchedulerOperation(op, runningSlot, { now: at("2026-07-19T10:00:00Z") });
  assert.equal(stale.status, "running");
  assert.equal(repo.supersedeSchedulerOperation(op, runningSlot, at("2026-07-19T10:00:01Z")).status, "no_op");
  assert.equal(repo.completeSchedulerOperation(stale, "succeeded", at("2026-07-19T10:00:02Z")), null);
  assert.equal(repo.getSchedulerOperation(op, runningSlot).status, "no_op");
});

test("a current-day insight retry remains pollable outside its initial hour", async () => {
  const slot = localDateISO();
  const now = new Date(`${slot}T04:00:00`);
  const stateKey = "insight_last_date";
  const first = await repo.runSchedulerOperation(
    stateKey,
    slot,
    async () => {
      throw new Error("insight provider unavailable");
    },
    { now, backoffMs: [1_000] }
  );
  assert.equal(first.status, "retry_wait");
  const afterBackoff = new Date(`${slot}T10:00:00`);
  assert.equal(dailyWindowOperationDue(afterBackoff, 4, stateKey), true);

  const expiredKey = "insight_expired_lease";
  repo.claimSchedulerOperation(expiredKey, slot, { now, leaseMs: 1_000 });
  assert.equal(dailyWindowOperationDue(new Date(`${slot}T10:00:00`), 4, expiredKey), true);

  const neverScheduled = "insight_not_scheduled_today";
  assert.equal(dailyWindowOperationDue(afterBackoff, 4, neverScheduled), false);
  assert.equal(repo.getSchedulerOperation(neverScheduled, slot), null, "after-hours polling must not create a row");
});

test("a restart through the memory hour still runs the nightly learning pass that day", async () => {
  const slot = localDateISO();
  // Nothing to do before the memory hour (3am local by default).
  assert.equal(memoryMaintenanceDue(new Date(`${slot}T01:30:00`)), false);
  assert.equal(memoryMaintenanceDue(new Date(`${slot}T03:00:00`)), true);

  // The restart case: the process was down for the whole 3am hour, so nothing ever
  // acknowledged the day. The next tick past the hour catches the pass up rather
  // than dropping a day of reconciliation, evaluation, and model rebuilds.
  assert.equal(memoryMaintenanceDue(new Date(`${slot}T07:12:00`)), true);
  assert.equal(repo.getAppState(MEMORY_MAINT_STATE_KEY), null, "a skipped hour must not acknowledge the day");

  // A completed pass acknowledges the day durably — exactly what runScheduled does.
  // That DB record, not a process-memory flag, is what stops a second run, so it
  // still holds for a process that starts fresh later the same day.
  const run = await repo.runSchedulerOperation(MEMORY_MAINT_STATE_KEY, slot, async () => ({ outcome: "succeeded" }));
  assert.equal(run.status, "succeeded");
  repo.setAppState(MEMORY_MAINT_STATE_KEY, slot);
  assert.equal(memoryMaintenanceDue(new Date(`${slot}T07:13:00`)), false);
  assert.equal(memoryMaintenanceDue(new Date(`${slot}T23:59:00`)), false);
});

test("legacy weekly coach rotates parseable wrong-shape JSON through its semantic contract", async () => {
  let extracts = 0;
  const run = await runAgentWithFallback(["stub", "stub"], "ignored", {
    extract: () =>
      ++extracts <= 2
        ? { ok: true, recommendation: "not a plan proposal" }
        : { summary: "Progress squat.", changes: [{ day_number: 2, exercise: "Back Squat", target_weight: 225 }] },
    acceptParsed: acceptsWeeklyCoachProposal,
  });
  assert.equal(run.tried.length, 1);
  assert.equal(run.result.parsed.summary, "Progress squat.");
  assert.equal(acceptsWeeklyCoachProposal({ ok: true, recommendation: "wrong shape" }), false);
});

test("final expired lease exhaustion emits one terminal result and then stays quiet", async () => {
  const op = "expired_final_lease";
  const slot = "2026-07-16";
  let calls = 0;
  repo.claimSchedulerOperation(op, slot, {
    now: at("2026-07-16T04:00:00Z"),
    leaseMs: 1_000,
    maxAttempts: 1,
  });
  const terminal = await repo.runSchedulerOperation(
    op,
    slot,
    async () => {
      calls++;
      return { outcome: "succeeded" };
    },
    { now: at("2026-07-16T04:00:01.001Z"), maxAttempts: 1 }
  );
  assert.equal(terminal.attempted, true, "the running -> exhausted transition is observable once");
  assert.equal(terminal.status, "exhausted");
  assert.match(terminal.error, /lease expired/i);
  assert.equal(calls, 0);

  const quiet = await repo.runSchedulerOperation(
    op,
    slot,
    async () => {
      calls++;
      return { outcome: "succeeded" };
    },
    { now: at("2026-07-16T04:00:02Z"), maxAttempts: 1 }
  );
  assert.equal(quiet.attempted, false);
  assert.equal(quiet.status, "exhausted");
  assert.equal(calls, 0);
});

test("one operation failure never suppresses a sibling in the same slot", async () => {
  const slot = "2026-07-12";
  const failed = await repo.runSchedulerOperation(
    "weekly_read",
    slot,
    async () => {
      throw new Error("bad weekly-read provider");
    },
    { backoffMs: [1_000] }
  );
  const sibling = await repo.runSchedulerOperation("weekly_health_synthesis", slot, async () => ({
    outcome: "succeeded",
  }));
  assert.equal(failed.status, "retry_wait");
  assert.equal(sibling.status, "succeeded");
  assert.equal(repo.getSchedulerOperation("weekly_read", slot).status, "retry_wait");
  assert.equal(repo.getSchedulerOperation("weekly_health_synthesis", slot).status, "succeeded");
});

test("repeated failure is bounded and the slot becomes exhausted", async () => {
  const op = "bounded_failure";
  const slot = "2026-07-12";
  let now = at("2026-07-12T10:00:00Z");
  let result;
  for (let i = 0; i < 3; i++) {
    result = await repo.runSchedulerOperation(
      op,
      slot,
      async () => {
        throw new Error("still unavailable");
      },
      { now, maxAttempts: 3, backoffMs: [1_000] }
    );
    now = at(new Date(now.getTime() + 1_001).toISOString());
  }
  assert.equal(result.status, "exhausted");
  assert.equal(result.operation.attempts, 3);
  assert.equal(repo.schedulerOperationDue(op, slot, now), false);
});
