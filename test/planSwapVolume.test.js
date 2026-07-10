// Elite-training WAVE C — plan swap/supersets (C4) + the honest volume model (C6).
//   C4  a first-class {swap:{from,to}} change kind (propose→apply), a superset_group
//       field on plan items (round-trips), and a stalled lift's "vary" apply becoming
//       a real swap rather than a silent no-op.
//   C6  ONE volume truth: warmups excluded, RIR-weighted, ~0.5 indirect credit, and
//       getVolumeByMuscle unified onto the canon taxonomy (no raw 'other' bucket).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import { effectiveVolumeByGroup } from "../dist/repo/exercise-variations.js";
import { getVolumeByMuscle } from "../dist/repo/sessions.js";
import { buildAndApplySwap, buildProgressionProposal, findPlanDayForExercise } from "../dist/repo/progression.js";

function reset() {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises", "program_blocks", "plan_proposals", "activities"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}
function logSet(name, date, { weight = null, reps = null, rir = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sess.id, ex.id, setNum, weight, reps, rir);
}
beforeEach(reset);

// ── C4: swap change kind (propose → apply) ────────────────────────────────────
test("C4: a {swap:{from,to}} change replaces the exercise IN PLACE on apply", () => {
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 90 },
  ]);
  const prop = repo.createProposal("test", "swap", "", {
    summary: "rotate a variation in",
    changes: [{ day_number: 1, swap: { from: "Back Squat", to: "Front Squat" }, reason: "unstick the squat" }],
  });
  const r = repo.applyProposal(prop.id);
  assert.equal(r.ok, true, "the swap applies");

  const day = repo.getPlanDay(1);
  const names = day.items.map((it) => it.exercise);
  assert.ok(names.includes("Front Squat"), "the new movement is on the day");
  assert.ok(!names.includes("Back Squat"), "the old movement was replaced in place");
  assert.ok(names.includes("Leg Curl"), "the rest of the day is untouched");
  const front = day.items.find((it) => it.exercise === "Front Squat");
  assert.equal(front.target_weight, null, "the new lift starts light (log actual)");
  assert.match(String(front.note || ""), /start light/i, "carries a start-light note");
});

test("C4: a swap whose `from` isn't on the day is reported honestly, never a silent success", () => {
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  const prop = repo.createProposal("test", "swap", "", {
    summary: "bad swap",
    changes: [{ day_number: 1, swap: { from: "Overhead Press", to: "Push Press" } }],
  });
  const r = repo.applyProposal(prop.id);
  assert.equal(r.ok, false, "nothing matched → not applied");
});

// ── C4: superset_group round-trips ────────────────────────────────────────────
test("C4: a superset_group pairs two items and survives read-back", () => {
  const saved = repo.savePlanDay(1, "Arms", "Arms", [
    { exercise: "Barbell Curl", sets: 3, rep_low: 8, rep_high: 10, target_weight: 65, superset_group: 1 },
    { exercise: "Tricep Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50, superset_group: 1 },
    { exercise: "Hammer Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30 },
  ]);
  const curl = saved.items.find((it) => it.exercise === "Barbell Curl");
  const push = saved.items.find((it) => it.exercise === "Tricep Pushdown");
  const solo = saved.items.find((it) => it.exercise === "Hammer Curl");
  assert.equal(curl.superset_group, 1, "the pair carries the superset id");
  assert.equal(push.superset_group, 1, "both members share it");
  assert.equal(solo.superset_group, null, "a standalone item stays null");
});

// ── C4: a stalled lift's vary apply is a real swap ────────────────────────────
test("C4: buildProgressionProposal turns a stalled 'vary' into a swap change, not a no-op", () => {
  repo.upsertExercise({ name: "Leg Press", muscle_group: "quads" });
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400 }]);
  // Flat for many weeks at RIR 2 (not grinding) → the engine reads 'vary'.
  for (const d of [35, 28, 21, 14, 7, 2]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, true, "there's something to propose");
  const swap = prop.proposal.parsed.changes.find((c) => c.swap);
  assert.ok(swap, "the vary became a swap change");
  assert.match(swap.swap.from, /Leg Press/i);
  assert.ok(swap.swap.to && swap.swap.to !== swap.swap.from, "swaps to a genuinely different movement");
  // No confusing same-exercise held-weight write survives.
  assert.ok(!prop.proposal.parsed.changes.some((c) => !c.swap && c.exercise === "Leg Press" && c.target_weight === 400), "no held no-op change");
});

// ── swap day-resolution: the conductor's chip carries from/to but not the day ──
test("findPlanDayForExercise resolves the day a lift sits on, case-insensitively", () => {
  repo.savePlanDay(2, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }]);
  repo.savePlanDay(3, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 }]);
  assert.equal(findPlanDayForExercise("Bench Press"), 2, "resolves the exact name");
  assert.equal(findPlanDayForExercise("bench press"), 2, "matches case-insensitively");
  assert.equal(findPlanDayForExercise("BARBELL ROW"), 3, "resolves a different day");
});

test("findPlanDayForExercise returns null for an unknown lift and blank input", () => {
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  assert.equal(findPlanDayForExercise("Overhead Press"), null, "not on any plan day → null");
  assert.equal(findPlanDayForExercise("  "), null, "blank input → null, never throws");
});

test("findPlanDayForExercise resolves the LOWEST day when a lift appears on several", () => {
  repo.savePlanDay(4, "Full B", "Full", [{ exercise: "Deadlift", sets: 3, rep_low: 3, rep_high: 5, target_weight: 315 }]);
  repo.savePlanDay(2, "Full A", "Full", [{ exercise: "Deadlift", sets: 3, rep_low: 3, rep_high: 5, target_weight: 315 }]);
  assert.equal(findPlanDayForExercise("Deadlift"), 2, "lowest day_number wins");
});

// The route/MCP day-optional swap path (no HTTP): resolve the day from `from`,
// then apply through the same buildAndApplySwap the surfaces call.
test("a day-less swap resolves the plan day from `from` and applies in place", () => {
  repo.savePlanDay(2, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 },
    { exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 95 },
  ]);
  const day = findPlanDayForExercise("Bench Press"); // mirrors the surface's day resolution
  assert.equal(day, 2);
  const r = buildAndApplySwap(day, "Bench Press", "DB Bench Press");
  assert.equal(r.ok, true, "the resolved-day swap applies");
  const names = repo.getPlanDay(2).items.map((it) => it.exercise);
  assert.ok(names.includes("DB Bench Press"), "the new movement is on the day");
  assert.ok(!names.includes("Bench Press"), "the old movement was rotated out");
  assert.ok(names.includes("Overhead Press"), "the rest of the day is untouched");
});

test("a day-less swap for a lift not on the plan resolves to null (the surface then returns the designed error)", () => {
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 }]);
  assert.equal(findPlanDayForExercise("Incline Bench Press"), null, "unknown lift → no day; the surface answers { ok:false, error } at 200");
});

// ── C6: the honest volume model ───────────────────────────────────────────────
test("C6: warmups are excluded from working volume", () => {
  // One warmup well below the top load + three real working sets.
  const sets = [
    { date: "2026-05-01", exercise: "Back Squat", muscle_group: "quads", weight: 95, reps: 5, rir: null },
    { date: "2026-05-01", exercise: "Back Squat", muscle_group: "quads", weight: 225, reps: 5, rir: 2 },
    { date: "2026-05-01", exercise: "Back Squat", muscle_group: "quads", weight: 225, reps: 5, rir: 2 },
    { date: "2026-05-01", exercise: "Back Squat", muscle_group: "quads", weight: 225, reps: 5, rir: 2 },
  ];
  const quads = effectiveVolumeByGroup(sets).get("quads");
  assert.ok(Math.abs(quads.sets - 3) < 1e-9, `three working sets, warmup dropped (got ${quads.sets})`);
});

test("C6: a set far from failure (RIR 5) counts less than a hard set", () => {
  const hard = effectiveVolumeByGroup([{ date: "2026-05-01", exercise: "Bench Press", muscle_group: "chest", weight: 185, reps: 5, rir: 1 }]).get("chest");
  const easy = effectiveVolumeByGroup([{ date: "2026-05-01", exercise: "Bench Press", muscle_group: "chest", weight: 185, reps: 5, rir: 5 }]).get("chest");
  assert.equal(hard.sets, 1, "a hard set is a full working set");
  assert.ok(easy.sets < 1, `an RIR-5 set counts as less than a full set (got ${easy.sets})`);
});

test("C6: secondary muscles earn ~0.5 indirect credit", () => {
  // A bench press (chest) also loads triceps + shoulders indirectly.
  const map = effectiveVolumeByGroup([{ date: "2026-05-01", exercise: "Bench Press", muscle_group: "chest", weight: 185, reps: 5, rir: 2 }]);
  assert.equal(map.get("chest").sets, 1, "chest gets the full direct set");
  assert.equal(map.get("triceps").sets, 0.5, "triceps earns half a set indirectly");
  assert.equal(map.get("shoulders").sets, 0.5, "shoulders earns half a set indirectly");
  assert.equal(map.get("triceps").tonnage, 0, "indirect credit never adds tonnage");
});

test("C6: getVolumeByMuscle is unified onto the canon taxonomy (no raw 'other' bucket)", () => {
  // A bench logged with NO stored muscle_group must still land under 'chest', never 'other'.
  db.prepare(`INSERT INTO exercises (name, muscle_group, mode) VALUES ('Bench Press', NULL, 'reps')`).run();
  logSet("Bench Press", isoDaysAgo(2), { weight: 185, reps: 5, rir: 2 });
  logSet("Bench Press", isoDaysAgo(2), { weight: 185, reps: 5, rir: 2, setNum: 2 });
  const vol = getVolumeByMuscle(30);
  const groups = vol.by_muscle.map((r) => r.muscle_group);
  assert.ok(groups.includes("chest"), "classified onto chest by name");
  assert.ok(!groups.includes("other"), "no raw 'other' catch-all bucket");
});
