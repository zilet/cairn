// Structured injury timeline (src/repo.ts, F3): the deterministic connective
// tissue between an active injury context_event and the planned exercises it
// loads — plus calm swap suggestions. This MUST work offline (no agent), so the
// whole engine is pure repo code: injuryAffectsExercise (the small matcher) and
// getInjuryImpacts (the full read). Suggestions only — it never mutates the plan.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

// A small training plan covering several body areas. We create the exercises
// with their muscle_group first (savePlanDay's findOrCreateExercise won't update
// the group on an existing row), then reference them by name in the plan day.
function seedPlanWithGroups(items) {
  for (const it of items) {
    repo.upsertExercise({ name: it.name, muscle_group: it.muscle_group, mode: it.mode || "reps" });
    if (it.constraint_note) {
      const ex = repo.findExercise(it.name);
      if (ex) repo.updateExercise(ex.id, { constraint_note: it.constraint_note });
    }
  }
  repo.savePlanDay(1, "Lower", "Legs", items.map((it) => ({ exercise: it.name })));
}

const STD_ITEMS = [
  { name: "Back Squat", muscle_group: "legs" },
  { name: "Leg Extension", muscle_group: "quads" },
  { name: "Romanian Deadlift", muscle_group: "posterior" },
  { name: "Seated DB Overhead Press", muscle_group: "shoulders" },
  { name: "Lateral Raise", muscle_group: "shoulders" },
  { name: "Triceps Rope Pushdown", muscle_group: "triceps" },
  { name: "Hammer Curl", muscle_group: "biceps" },
];

beforeEach(() => {
  resetTables("context_events", "plan_items", "plan_days", "exercises");
});

// ---- the small matcher: injuryAffectsExercise ----

test("injuryAffectsExercise: a knee injury loads squats/leg work, not shoulder work", () => {
  const knee = { kind: "injury", title: "Right knee", meta: { area: "knee" } };
  assert.equal(repo.injuryAffectsExercise(knee, { name: "Back Squat", muscle_group: "legs" }), true);
  assert.equal(repo.injuryAffectsExercise(knee, { name: "Leg Extension", muscle_group: "quads" }), true);
  assert.equal(repo.injuryAffectsExercise(knee, { name: "Seated DB Overhead Press", muscle_group: "shoulders" }), false);
  assert.equal(repo.injuryAffectsExercise(knee, { name: "Hammer Curl", muscle_group: "biceps" }), false);
});

test("injuryAffectsExercise: a shoulder injury loads presses/raises, not leg work", () => {
  const sh = { kind: "injury", title: "Left shoulder", meta: { area: "shoulder" } };
  assert.equal(repo.injuryAffectsExercise(sh, { name: "Seated DB Overhead Press", muscle_group: "shoulders" }), true);
  assert.equal(repo.injuryAffectsExercise(sh, { name: "Lateral Raise", muscle_group: "shoulders" }), true);
  assert.equal(repo.injuryAffectsExercise(sh, { name: "Back Squat", muscle_group: "legs" }), false);
});

test("injuryAffectsExercise: a lower-back injury catches the hinge/RDL via the name token", () => {
  const lb = { kind: "injury", title: "Lower back tweak", meta: { area: "lower back" } };
  // Romanian Deadlift's muscle_group ('posterior') AND name token ('romanian'/'deadlift') both load the back.
  assert.equal(repo.injuryAffectsExercise(lb, { name: "Romanian Deadlift", muscle_group: "posterior" }), true);
  assert.equal(repo.injuryAffectsExercise(lb, { name: "Lateral Raise", muscle_group: "shoulders" }), false);
});

test("injuryAffectsExercise: an injury that names no known body area affects nothing", () => {
  const vague = { kind: "injury", title: "Felt off", meta: {} };
  assert.equal(repo.injuryAffectsExercise(vague, { name: "Back Squat", muscle_group: "legs" }), false);
});

test("injuryAffectsExercise: matches on the title/detail text when meta.area is absent", () => {
  const inj = { kind: "injury", title: "Tweaked my knee on the descent", detail: "" };
  assert.equal(repo.injuryAffectsExercise(inj, { name: "Bulgarian Split Squat", muscle_group: "legs" }), true);
});

// ---- the full read: getInjuryImpacts ----

test("getInjuryImpacts: no injuries → empty, count 0", () => {
  seedPlanWithGroups(STD_ITEMS);
  const res = repo.getInjuryImpacts();
  assert.deepEqual(res.injuries, []);
  assert.equal(res.count, 0);
});

test("getInjuryImpacts: an active knee injury surfaces the leg movements + safe swaps", () => {
  seedPlanWithGroups(STD_ITEMS);
  repo.addContextEvent({ kind: "injury", title: "Right knee", start_date: "2025-01-01", meta: { area: "knee", severity: "moderate" } });

  const res = repo.getInjuryImpacts();
  assert.equal(res.injuries.length, 1);
  const inj = res.injuries[0];
  assert.equal(inj.area, "knee");
  assert.equal(inj.severity, "moderate");

  const names = inj.affected.map((a) => a.exercise).sort();
  // squat + leg extension load the knee; the upper-body lifts do not.
  assert.ok(names.includes("Back Squat"));
  assert.ok(names.includes("Leg Extension"));
  assert.ok(!names.includes("Seated DB Overhead Press"));
  assert.ok(!names.includes("Hammer Curl"));
  assert.equal(res.count, inj.affected.length);

  // Each affected movement carries where it appears + at least one swap that is
  // NOT itself a knee-loading movement.
  const squat = inj.affected.find((a) => a.exercise === "Back Squat");
  assert.ok(squat.days.some((d) => d.day_name === "Lower"));
  assert.ok(Array.isArray(squat.swaps) && squat.swaps.length >= 1);
  for (const s of squat.swaps) {
    assert.equal(repo.injuryAffectsExercise({ meta: { area: "knee" } }, { name: s.name, muscle_group: s.muscle_group }), false,
      `swap ${s.name} must not load the injured knee`);
  }
});

test("getInjuryImpacts: an archived/past injury is not active → no impacts", () => {
  seedPlanWithGroups(STD_ITEMS);
  repo.addContextEvent({ kind: "injury", title: "Old knee", start_date: "2024-01-01", end_date: "2024-02-01", meta: { area: "knee" } });
  const res = repo.getInjuryImpacts();
  // end_date is in the past → not active → excluded from the active-only read.
  assert.equal(res.injuries.length, 0);
  assert.equal(res.count, 0);
});

test("getInjuryImpacts: a constraint_note naming the area is itself an affected signal", () => {
  // Lat Pulldown is back work; tag it with a shoulder constraint and inject a
  // shoulder injury — the note pulls it into 'affected' even if the load tokens
  // alone wouldn't, because a hand-noted limit on the area is evidence of risk.
  seedPlanWithGroups([
    ...STD_ITEMS,
    { name: "Lat Pulldown", muscle_group: "back", constraint_note: "Avoid if the shoulder flares." },
  ]);
  repo.addContextEvent({ kind: "injury", title: "Shoulder", start_date: "2025-01-01", meta: { area: "shoulder" } });
  const res = repo.getInjuryImpacts();
  const names = res.injuries[0].affected.map((a) => a.exercise);
  assert.ok(names.includes("Lat Pulldown"), "the constraint_note on the area pulls it in");
});

test("getInjuryImpacts: swaps never include a constraint-noted or knee-loading exercise", () => {
  seedPlanWithGroups([
    ...STD_ITEMS,
    { name: "Leg Press", muscle_group: "legs", constraint_note: "Knee — go light." },
  ]);
  repo.addContextEvent({ kind: "injury", title: "Knee", start_date: "2025-01-01", meta: { area: "knee" } });
  const res = repo.getInjuryImpacts();
  for (const a of res.injuries[0].affected) {
    for (const s of a.swaps) {
      assert.notEqual(s.name, "Leg Press", "a constraint-noted exercise is never suggested as a swap");
      assert.notEqual(s.name, a.exercise, "a movement is never suggested as a swap for itself");
    }
  }
});

test("getInjuryImpacts is a pure read — calling it does not change the plan", () => {
  seedPlanWithGroups(STD_ITEMS);
  repo.addContextEvent({ kind: "injury", title: "Knee", start_date: "2025-01-01", meta: { area: "knee" } });
  const before = JSON.stringify(repo.getPlan());
  repo.getInjuryImpacts();
  repo.getInjuryImpacts();
  assert.equal(JSON.stringify(repo.getPlan()), before, "the plan is untouched");
});
