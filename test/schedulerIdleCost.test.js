import { test } from "node:test";
import assert from "node:assert/strict";
import { runOrphanSweepIfDue, resetOrphanSweepGateForTest, dailyWindowOperationDue } from "../dist/scheduler.js";
import { resetTrainingDataCache } from "../dist/repo/training-cache.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";

// WHAT THIS FILE PROTECTS: the scheduler's IDLE minute.
//
// The orphan-draft sweep used to run on every one of the 1440 minute ticks in a day,
// walking up to 100 decisions and 50 proposals — and, for a draft that keeps being
// refused, re-running a 42-day evidence capture — to reach the answer it had already
// reached a minute earlier. On a Raspberry Pi with SD storage that is the single largest
// standing cost of a day on which nothing happens.
//
// The gate is a SIGNATURE, not a timer, so nothing the athlete would notice is deferred:
// a new draft still flips within the minute. These tests hold both halves of that — the
// second idle pass is nearly free, and a genuinely new draft is still picked up at once.

// db.prepare is the one funnel every read and write goes through, so wrapping it counts
// statements exactly (the same instrumentation the hot-path audit used).
function countStatements(fn) {
  const original = db.prepare;
  let count = 0;
  db.prepare = function (...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    db.prepare = original;
  }
  return count;
}

function nutritionDraft(instruction, kcal = 2200) {
  return repo.createProposal("stub", `auto: ${instruction}`, "", {
    kind: "nutrition_target",
    summary: "A small measured intake adjustment",
    nutrition: { target_kcal: kcal, protein_g: 170, reason: "The measured trend missed its expected band." },
  });
}

function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

test("a second idle minute with nothing new costs almost nothing", () => {
  resetOrphanSweepGateForTest();
  repo.setSettings({ lead_mode: "lead" });

  // First pass: the sweep runs for real (this is the expensive one, and it is allowed to be).
  assert.equal(runOrphanSweepIfDue(), true, "the first pass sweeps");

  // Second pass one simulated minute later, with not a single row changed in between.
  const second = countStatements(() => {
    assert.equal(runOrphanSweepIfDue(Date.now() + 60_000), false, "an unchanged picture is not re-swept");
  });
  assert.ok(second < 10, `the idle pass must be nearly free, executed ${second} statements`);
});

test("a draft created after a quiet period is still picked up on the very next tick", () => {
  resetOrphanSweepGateForTest();
  repo.setSettings({ lead_mode: "lead" });

  runOrphanSweepIfDue();
  runOrphanSweepIfDue(Date.now() + 60_000); // quiet minute, skipped

  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  // A minute later — far inside the 10-minute cadence floor, so ONLY the signature can
  // have opened this gate.
  assert.equal(runOrphanSweepIfDue(Date.now() + 120_000), true, "a new draft re-opens the gate immediately");

  const decisions = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(decisions.length, 1, "the new draft was adopted, not deferred to the cadence floor");
  assert.equal(decisions[0].source_ref_key, String(draft.id));
});

test("the cadence floor sweeps again even when no row has moved", () => {
  resetOrphanSweepGateForTest();
  repo.setSettings({ lead_mode: "lead" });

  runOrphanSweepIfDue();
  assert.equal(runOrphanSweepIfDue(Date.now() + 60_000), false, "still quiet a minute later");
  // The clock is an input the signature cannot see (a draft aging out of its grace
  // window, a surprise budget rolling over), so the floor must fire on its own.
  assert.equal(runOrphanSweepIfDue(Date.now() + 11 * 60_000), true, "the 10-minute floor sweeps regardless");
});

test("a lead-mode change re-opens the gate without waiting for the floor", () => {
  resetOrphanSweepGateForTest();
  repo.setSettings({ lead_mode: "lead" });
  runOrphanSweepIfDue();
  assert.equal(runOrphanSweepIfDue(Date.now() + 60_000), false);

  repo.setSettings({ lead_mode: "review_everything" });
  assert.equal(runOrphanSweepIfDue(Date.now() + 120_000), true, "posture is part of the sweep's signature");
});

// The due-check is polled by every tick for every slot, every minute. It must be a pure
// SELECT: it used to INSERT OR IGNORE a row per slot per minute purely to answer a
// question, and rows are the claim path's job.
test("polling a slot's due-ness never writes a scheduler_operations row", () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM scheduler_operations").get().c;
  assert.equal(repo.schedulerOperationDue("never_claimed_op", "2026-09-02"), true, "an unclaimed slot is due");
  repo.schedulerOperationDue("never_claimed_op", "2026-09-02");
  const after = db.prepare("SELECT COUNT(*) AS c FROM scheduler_operations").get().c;
  assert.equal(after, before, "asking the question created no row");
});

// …with ONE deliberate exception, because there the row IS the marker: a small-hours slot
// opened in its hour stays pollable for the rest of the day.
test("a small-hours slot opened in its hour stays pollable after the hour has passed", () => {
  const slot = "2026-09-02";
  const inHour = new Date(`${slot}T04:30:00`);
  const afterHours = new Date(`${slot}T10:00:00`);
  const key = "idle_cost_window_op";

  assert.equal(dailyWindowOperationDue(afterHours, 4, key), false, "an unopened slot is not due after its hour");
  assert.equal(repo.getSchedulerOperation(key, slot), null, "and after-hours polling created no row");

  assert.equal(dailyWindowOperationDue(inHour, 4, key), true, "in its hour the slot opens and is due");
  assert.ok(repo.getSchedulerOperation(key, slot), "opening the slot in its hour writes the marker row");
  assert.equal(dailyWindowOperationDue(afterHours, 4, key), true, "and it stays pollable for the rest of the day");
});

test("the per-test cache reset clears the sweep gate, so no test starts with it closed", () => {
  repo.setSettings({ lead_mode: "lead" });
  assert.equal(runOrphanSweepIfDue(), true, "the first pass sweeps");
  assert.equal(runOrphanSweepIfDue(Date.now() + 60_000), false, "and the gate is now closed");

  // The gate is process-global, and the harness wipes the DB out-of-band between tests.
  // Registering the reset with the same clear every memo in this round uses means a test
  // never inherits a closed gate from the one before it — whether or not it remembers to
  // call resetOrphanSweepGateForTest itself.
  resetTrainingDataCache();
  assert.equal(runOrphanSweepIfDue(Date.now() + 60_000), true, "a wiped-DB test starts unswept");
});
