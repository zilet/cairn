import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import {
  activeRecoveryWeekLedger,
  RECOVERY_WEEK_APPLIED_KEY,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
} from "../dist/repo/recovery-week-ledger.js";

beforeEach(() => {
  resetTables("recovery_cycles", "app_state", "plan_proposals", "program_blocks");
});

test("a recovery overlay preserves the base plan and movement order while bounding dose", () => {
  const base = {
    id: 12,
    day_number: 2,
    name: "Lower",
    items: [
      { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 225, note: "Crisp" },
      { exercise: "Plank", mode: "timed", sets: 2, target_seconds: 60, target_weight: null },
      { kind: "cardio", exercise: "Easy run", target_duration_min: 40, target_distance_km: 6 },
    ],
  };
  const snapshot = structuredClone(base);
  const adapted = repo.adaptBasePlanDayForRecovery(base);

  assert.deepEqual(base, snapshot, "the reusable plan snapshot is immutable");
  assert.deepEqual(
    adapted.items.map((item) => item.exercise),
    base.items.map((item) => item.exercise),
    "frequency and movement patterns stay intact"
  );
  assert.equal(adapted.items[0].sets, 2);
  assert.equal(adapted.items[0].target_weight, 191.5, "the overlay eases load even when set count is already low");
  assert.equal(adapted.items[1].sets, 1);
  assert.equal(adapted.items[1].target_seconds, 30);
  assert.equal(adapted.items[2].target_duration_min, 20);
  assert.equal(adapted.items[2].target_zone, "easy");
  assert.equal(adapted.recovery_overlay.mutates_plan, false);
});

test("one-set prescriptions still ease positive and assisted loads", () => {
  const adapted = repo.adaptBasePlanDayForRecovery({
    id: 13,
    day_number: 3,
    name: "Low set day",
    items: [
      { exercise: "Bench Press", sets: 1, rep_low: 5, rep_high: 5, target_weight: 200 },
      { exercise: "Assisted Pull-up", sets: 1, rep_low: 5, rep_high: 5, target_weight: -30 },
    ],
  });
  assert.equal(adapted.items[0].sets, 1);
  assert.equal(adapted.items[0].target_weight, 170);
  assert.equal(adapted.items[1].sets, 1);
  assert.equal(adapted.items[1].target_weight, -33, "more assistance is the easier direction");
});

test("a non-default stored working fraction consistently changes recovery dose", () => {
  const adapted = repo.adaptBasePlanDayForRecovery(
    {
      id: 14,
      day_number: 4,
      items: [
        { exercise: "Back Squat", sets: 5, target_weight: 225 },
        { exercise: "Plank", mode: "timed", sets: 3, target_seconds: 100 },
        { kind: "cardio", exercise: "Run", target_duration_min: 50, target_distance_km: 10 },
      ],
    },
    { working_set_fraction: 0.4 }
  );
  assert.equal(adapted.items[0].sets, 2);
  assert.equal(adapted.items[1].sets, 1);
  assert.equal(adapted.items[1].target_seconds, 40);
  assert.equal(adapted.items[2].target_duration_min, 20);
  assert.equal(adapted.items[2].target_distance_km, 4);
  assert.equal(adapted.recovery_overlay.working_set_fraction, 0.4);
});

test("recovery overlays reject unknown structure and cap the working fraction", () => {
  assert.throws(
    () => repo.normalizeRecoveryOverlay({ working_set_fraction: 0.5, arbitrary_payload: "no" }),
    /unsupported recovery overlay field/
  );
  assert.equal(repo.normalizeRecoveryOverlay({ working_set_fraction: 9 }).working_set_fraction, 0.6);
  assert.equal(repo.normalizeRecoveryOverlay({ working_set_fraction: -9 }).working_set_fraction, 0.4);
});

test("a scheduled cycle activates, reaches recheck, and exits on calendar time without training", () => {
  const scheduled = repo.scheduleRecoveryCycle({
    effective_on: "2035-02-01",
    exit_on: "2035-02-08",
    overlay: { base_plan_day_id: 12 },
  });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.recheck_on, "2035-02-07", "recheck is the final recovery day");
  assert.equal(repo.recoveryCycleAt("2035-01-31"), null);

  const active = repo.activateRecoveryCycle(scheduled.id, "2035-02-01");
  assert.equal(active.effective_status, "active");
  assert.equal(repo.recoveryCycleAt("2035-02-06").effective_status, "active");
  assert.equal(repo.recoveryCycleAt("2035-02-07").effective_status, "recheck");
  assert.equal(
    repo.recoveryCycleAt("2035-02-08").effective_status,
    "exit_review",
    "expired open cycle stays queryable without extending recovery"
  );

  repo.completeRecoveryCycle(scheduled.id, "2035-02-08");
  const blocked = repo.recoveryCycleCooldown("2035-02-20");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "cooldown");
  assert.equal(repo.recoveryCycleCooldown("2035-03-01").allowed, true);
});

test("terminal status is date-aware and completion cannot bypass the exit or cooldown", () => {
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: "2035-03-01",
    exit_on: "2035-03-08",
  });
  repo.activateRecoveryCycle(cycle.id, "2035-03-01");
  assert.throws(() => repo.completeRecoveryCycle(cycle.id, "2035-03-05"), /cannot complete before exit_on/);
  assert.equal(repo.recoveryCycleCooldown("2035-03-05").reason, "cycle_open");

  repo.completeRecoveryCycle(cycle.id, "2035-03-08");
  assert.equal(repo.recoveryCycleAt("2035-03-03").effective_status, "active");
  assert.equal(repo.recoveryCycleAt("2035-03-07").effective_status, "recheck");
  assert.equal(repo.getRecoveryCycle(cycle.id, "2035-03-08").effective_status, "completed");
  assert.equal(repo.recoveryCycleCooldown("2035-03-09").reason, "cooldown");
});

test("canceling an open cycle removes the no-repeat block", () => {
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: "2035-04-01",
    exit_on: "2035-04-08",
  });
  assert.equal(repo.recoveryCycleCooldown("2035-04-02").reason, "cycle_open");
  repo.cancelRecoveryCycle(cycle.id, "2035-04-02");
  assert.equal(repo.recoveryCycleCooldown("2035-04-02").allowed, true);
});

test("legacy v1 date-only recovery stamps remain readable through both ledgers", () => {
  const result = db
    .prepare(
      `INSERT INTO plan_proposals (instruction, parsed_json, status)
       VALUES (?, ?, 'applied')`
    )
    .run(`${RECOVERY_WEEK_INSTRUCTION_PREFIX} from the current plan`, JSON.stringify({ days: [] }));
  repo.setAppState(RECOVERY_WEEK_APPLIED_KEY, "2035-05-01");

  const legacy = activeRecoveryWeekLedger("2035-05-03");
  assert.ok(legacy);
  assert.equal(legacy.proposal_id, Number(result.lastInsertRowid));
  const cycle = repo.recoveryCycleAt("2035-05-03");
  assert.equal(cycle.legacy, true);
  assert.equal(cycle.effective_status, "active");
  assert.equal(cycle.recheck_on, "2035-05-07");
  assert.equal(cycle.overlay.legacy_proposal_id, Number(result.lastInsertRowid));
});

test("blind program-week advancement pauses during active recovery", () => {
  const today = localDateISO();
  const block = repo.createBlock({ goal: "Build", week_index: 2, total_weeks: 6 });
  const cycle = repo.scheduleRecoveryCycle({
    effective_on: today,
    exit_on: addDaysISO(today, 7),
  });
  repo.activateRecoveryCycle(cycle.id, today);
  const paused = repo.advanceBlockWeek(block.id);
  assert.equal(paused.week_index, 2);
  repo.cancelRecoveryCycle(cycle.id, today);
  const advanced = repo.advanceBlockWeek(block.id);
  assert.equal(advanced.week_index, 3);
});
