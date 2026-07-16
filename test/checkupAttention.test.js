// The nightly lab/marker recheck-attention scheduler op (scheduler.ts
// "checkup_attention_date") — the doctor-loop counterpart of the training-benchmark
// pass. It re-runs refreshDoctorLoopAttention() so due rechecks are noticed without
// anyone opening an endpoint. This mirrors schedulerOperations.test.js: the op body
// is exercised through the same runSchedulerOperation ownership primitive, so the
// isolation/idempotency/no-op contract is proven the way the tick relies on it.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "attention_schedule", "scheduler_operations", "app_state", "profile");
});

// The exact op body the scheduler tick runs (kept in lockstep with scheduler.ts).
const checkupOp = () => {
  const hasMarkers = ((repo.getMarkerHistory()).markers || []).length > 0;
  if (hasMarkers) return { outcome: "succeeded", value: repo.refreshDoctorLoopAttention() };
  return { outcome: "no_op" };
};

test("refreshDoctorLoopAttention does not drift a persistently-flagged signal", () => {
  seedHealthDoc("2026-01-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  const a1 = repo.refreshDoctorLoopAttention().find((r) => r.signal_key === "marker:apob");
  const a2 = repo.refreshDoctorLoopAttention().find((r) => r.signal_key === "marker:apob");
  assert.ok(a1 && a2, "the ApoB recheck signal exists on both passes");
  assert.equal(a1.tier, "active");
  assert.equal(a2.tier, "active");
  assert.equal(a1.next_due, a2.next_due, "re-running the refresh leaves the schedule stable");
});

test("the checkup-attention op runs deterministically and acknowledges its slot", async () => {
  seedHealthDoc("2026-01-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  const run = await repo.runSchedulerOperation("checkup_attention_date", "2026-07-01", checkupOp);
  assert.equal(run.status, "succeeded");
  assert.ok(Array.isArray(run.value) && run.value.length > 0, "it wrote at least one recheck signal");
  assert.equal(
    repo.schedulerOperationDue("checkup_attention_date", "2026-07-01"),
    false,
    "the slot is acknowledged after a successful pass"
  );
});

test("the checkup-attention op is a calm no-op when no markers are on file", async () => {
  const run = await repo.runSchedulerOperation("checkup_attention_date", "2026-07-02", checkupOp);
  assert.equal(run.status, "no_op");
});

test("a throw inside the checkup op is isolated as a retry, never a crash", async () => {
  const run = await repo.runSchedulerOperation(
    "checkup_attention_date",
    "2026-07-03",
    async () => {
      throw new Error("attention refresh blew up");
    },
    { backoffMs: [1_000] }
  );
  assert.equal(run.status, "retry_wait");
  assert.ok(run.operation.next_retry_at, "a failed pass schedules a bounded retry instead of propagating");
});
