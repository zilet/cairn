// The per-session auto-progression engine (src/repo/progression.ts) — the
// deterministic "MacroFactor-for-lifting" loop. Invariants under test:
//   - nextPrescription proposes the NEXT target from the LAST logged top set +
//     the lift's program-state trend: overload (earned) / hold / deload (grind or
//     slip) / vary (long plateau)
//   - the load step is CLAMPED (≤10% or ≤5 lb compound / ≤2.5 lb isolation) — an
//     off-spec history never produces a giant jump, and never a negative number
//   - an injury constraint_note HOLDS load (never bumps it)
//   - timed lifts progress in SECONDS, never load
//   - assisted lifts (negative weight) REDUCE the assist toward bodyweight
//   - programBalance bands by the canonical taxonomy + flags DUE groups
//   - programAdjustments detects missing-pattern GAPS (no core / grip / mobility)
// Deterministic, offline, temp DB (see test/run.mjs). Imports progression.js
// directly (the barrel re-export is the LEAD's wire-up, landing at merge).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  nextPrescription,
  planDayProgression,
  programBalance,
  programAdjustments,
  recentMuscleLoad,
} from "../dist/repo/progression.js";

// ---- local seeding (kept in-file so we don't touch the shared _seed.js) ----
function reset() {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises", "bodyweight_log", "program_blocks", "activities", "garmin_activities"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}

function makeExercise(name, { muscle_group = null, mode = "reps", constraint_note = null } = {}) {
  const ex = repo.upsertExercise({ name, muscle_group, mode });
  if (constraint_note) repo.updateExercise(ex.id, { constraint_note });
  return repo.findExercise(name);
}

// One plan day with a single strength item carrying its prescribed targets.
function planWith(dayNumber, item) {
  return repo.savePlanDay(dayNumber, item.focus || `Day ${dayNumber}`, item.focus || null, [item]);
}

// Log a top set for an exercise on a given ISO date (UTC). reps/weight for reps
// lifts; duration_sec for timed; rir optional.
function logSet(name, date, { weight = null, reps = null, rir = null, duration_sec = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir, duration_sec);
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

beforeEach(reset);

// ---------------------------------------------------------------------------
test("earned overload: hit the top of the range at RIR 2 → a clamped step up", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, focus: "Push" });
  // A few progressing sessions, last one at the top of the range, RIR 2.
  logSet("Barbell Bench Press", isoDaysAgo(28), { weight: 175, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(21), { weight: 180, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(10), { weight: 185, reps: 8, rir: 2 });

  const p = nextPrescription("Barbell Bench Press");
  assert.ok(p, "a prescription is returned");
  assert.equal(p.action, "overload");
  assert.equal(p.mode, "reps");
  // A compound: the step is clamped to ≤5 lb (so 185 → 190, not a leap).
  assert.equal(p.suggested.weight, 190);
  assert.equal(p.delta_text, "+5 lb");
  assert.ok(p.suggested.weight > 0, "never a negative weight");
});

test("overload step is CLAMPED — a giant history never yields a giant jump", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 300, focus: "Legs" });
  // Top set blew past the range at RIR 3 — the engine still caps the step.
  logSet("Back Squat", isoDaysAgo(21), { weight: 285, reps: 5, rir: 3 });
  logSet("Back Squat", isoDaysAgo(7), { weight: 300, reps: 8, rir: 3 });

  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "overload");
  // 10% of 300 = 30, but the compound ceiling caps it at 5 lb → 305.
  assert.equal(p.suggested.weight, 305);
  assert.ok(p.suggested.weight - 300 <= 5, "step never exceeds the 5 lb compound cap");
});

test("isolation lifts get the smaller 2.5 lb plate jump", () => {
  makeExercise("Dumbbell Curl", { muscle_group: "biceps" });
  planWith(1, { exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30, focus: "Arms" });
  logSet("Dumbbell Curl", isoDaysAgo(14), { weight: 27.5, reps: 12, rir: 2 });
  logSet("Dumbbell Curl", isoDaysAgo(4), { weight: 30, reps: 12, rir: 2 });

  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.weight, 32.5, "isolation step is 2.5 lb, not 5");
});

test("hold: reps not at the top / RIR low → hold the load, no bump", () => {
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  planWith(1, { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95, focus: "Push" });
  // Last set short of the top at RIR 1 — not earned.
  logSet("Overhead Press", isoDaysAgo(10), { weight: 95, reps: 6, rir: 1 });

  const p = nextPrescription("Overhead Press");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 95, "load held, not increased");
  assert.match(p.delta_text, /^hold/);
});

test("deload: a regressing lift backs the load off ~10%", () => {
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 1, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  // Est-1RM clearly sliding over several sessions → program-state reads regressing.
  logSet("Deadlift", isoDaysAgo(28), { weight: 365, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(21), { weight: 355, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(14), { weight: 345, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(5), { weight: 335, reps: 5, rir: 1 });

  const p = nextPrescription("Deadlift");
  assert.equal(p.action, "deload");
  assert.ok(p.suggested.weight < 365 && p.suggested.weight > 0, "load backed off, never negative");
  assert.match(p.delta_text, /^−/, "delta reads as a decrease");
});

test("vary: a long flat plateau (not grinding) suggests rotating a variation", () => {
  makeExercise("Leg Press", { muscle_group: "quads" });
  planWith(1, { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400, focus: "Legs" });
  // Same top load for many sessions across >3 weeks, RIR 2 (not grinding) → flat-long.
  for (const d of [35, 28, 21, 14, 7, 2]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const p = nextPrescription("Leg Press");
  assert.equal(p.action, "vary");
  assert.equal(p.suggested.weight, 400, "load held while a variation is suggested");
});

test("injury constraint HOLDS load even when reps were earned", () => {
  makeExercise("Barbell Row", { muscle_group: "back", constraint_note: "left elbow — keep light, no heavy pulls" });
  planWith(1, { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135, focus: "Pull" });
  // Reps fully earned at RIR 2 — but the injury note must override the overload.
  logSet("Barbell Row", isoDaysAgo(14), { weight: 135, reps: 10, rir: 2 });
  logSet("Barbell Row", isoDaysAgo(4), { weight: 135, reps: 10, rir: 2 });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 135, "constraint holds the load, never bumps it");
  assert.match(p.why.toLowerCase(), /injury/);
});

test("timed lifts progress in SECONDS, never load", () => {
  makeExercise("Dead Hang", { muscle_group: "forearms", mode: "timed" });
  planWith(1, { exercise: "Dead Hang", sets: 3, target_seconds: 45, focus: "Grip" });
  // The hold comfortably meets the target → +5s, and no weight in the suggestion.
  logSet("Dead Hang", isoDaysAgo(3), { duration_sec: 50 });

  const p = nextPrescription("Dead Hang");
  assert.equal(p.mode, "timed");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.seconds, 50, "45 + 5s step");
  assert.equal(p.suggested.weight, undefined, "no load on a timed lift");
  assert.equal(p.delta_text, "+5s");
});

test("assisted lifts reduce the assist toward bodyweight (never a positive flip)", () => {
  makeExercise("Assisted Pull-up", { muscle_group: "back" });
  // negative target_weight = assist: -50 lb assist.
  planWith(1, { exercise: "Assisted Pull-up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -50, focus: "Pull" });
  logSet("Assisted Pull-up", isoDaysAgo(10), { weight: -50, reps: 8, rir: 2 });

  const p = nextPrescription("Assisted Pull-up");
  assert.equal(p.action, "overload");
  // Assist is reduced (toward 0) — a SMALLER absolute value, still negative here.
  assert.ok(p.suggested.weight < 0, "still assisted");
  assert.ok(p.suggested.weight > -50, "assist reduced toward bodyweight");
  assert.match(p.delta_text, /assist/);
});

test("planDayProgression covers every strength item and skips cardio", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Incline Press", { muscle_group: "chest" });
  repo.savePlanDay(1, "Push + run", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Incline Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { kind: "cardio", exercise: "Easy run", target_distance_km: 5, target_zone: "Z2" },
  ]);
  logSet("Bench Press", isoDaysAgo(5), { weight: 185, reps: 8, rir: 2 });

  const rows = planDayProgression(1);
  const names = rows.map((r) => r.exercise);
  assert.ok(names.includes("Bench Press"));
  assert.ok(names.includes("Incline Press"));
  assert.ok(!names.some((n) => /run/i.test(n)), "cardio is skipped");
  for (const r of rows) assert.ok(typeof r.plan_item_id === "number", "each row carries its plan_item_id for the apply path");
});

test("nextPrescription returns null when there's no history and no plan item", () => {
  makeExercise("Phantom Lift", { muscle_group: "chest" });
  assert.equal(nextPrescription("Phantom Lift"), null);
});

// ---------------------------------------------------------------------------
test("programBalance bands by the canonical taxonomy and flags DUE groups", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Lateral Raise", { muscle_group: "shoulders" });
  // Two weeks of heavy shoulder volume, thin chest volume.
  for (const d of [12, 10, 8, 6, 4, 2, 1]) {
    for (let s = 1; s <= 4; s++) logSet("Lateral Raise", isoDaysAgo(d), { weight: 20, reps: 15, rir: 1, setNum: s });
  }
  // Chest only twice → under its low landmark (chest low = 10/wk).
  logSet("Bench Press", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logSet("Bench Press", isoDaysAgo(3), { weight: 185, reps: 8, rir: 2 });

  const bal = programBalance(2);
  const chest = bal.groups.find((g) => g.group === "chest");
  const shoulders = bal.groups.find((g) => g.group === "shoulders");
  assert.ok(chest, "chest is tracked under the canonical taxonomy");
  assert.equal(chest.band, "low", "thin chest volume bands LOW");
  assert.ok(bal.due.includes("chest"), "chest is flagged DUE");
  assert.ok(shoulders, "shoulders tracked");
  // Plain words only — no numeric grade in the summary.
  assert.doesNotMatch(bal.summary, /\b\d{2,3}%/);
});

test("programBalance collapses to a calm broad-low read when MOST groups are due", () => {
  // An endurance-led week: thin strength logs across many groups → most read 'due'.
  // The honest signal is "volume's light across the board", not a 10-item to-do list.
  const groups = [
    ["Bench Press", "chest"], ["Barbell Row", "back"], ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"], ["Overhead Press", "shoulders"],
    ["Barbell Curl", "biceps"], ["Triceps Pushdown", "triceps"],
  ];
  for (const [name, mg] of groups) {
    makeExercise(name, { muscle_group: mg });
    logSet(name, isoDaysAgo(10), { weight: 100, reps: 8, rir: 2 }); // one thin set, > a week ago
  }
  const bal = programBalance(2);
  assert.equal(bal.broad_low, true, "most groups due → broad-low");
  assert.match(bal.summary, /light across most groups/i, "one calm line, not a per-group list");
  assert.match(bal.summary, /running is the priority/i, "frames it as expected, not a failure");
  assert.doesNotMatch(bal.summary, /chest, back, quads/i, "no wall of group names");
  assert.doesNotMatch(bal.summary, /\b\d{2,3}%/, "plain words — no numeric grade");
});

test("programBalance EXCLUDES mobility from the set-count math", () => {
  makeExercise("90/90 Hip Switch", { muscle_group: "mobility" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  for (const d of [5, 3, 1]) {
    for (let s = 1; s <= 5; s++) logSet("90/90 Hip Switch", isoDaysAgo(d), { weight: null, reps: 10, rir: 9, setNum: s });
  }
  logSet("Bench Press", isoDaysAgo(2), { weight: 185, reps: 8, rir: 2 });

  const bal = programBalance(2);
  assert.ok(!bal.groups.some((g) => g.group === "mobility"), "mobility never appears in the working-set bands");
});

test("programAdjustments flags missing-pattern GAPS (no core / grip / mobility)", () => {
  // A plan that's all pressing — no core, no grip, no mobility programmed.
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95 },
  ]);

  const adj = programAdjustments();
  const gaps = adj.filter((a) => a.kind === "gap").map((a) => a.title.toLowerCase());
  assert.ok(gaps.some((t) => t.includes("core")), "flags missing core work");
  assert.ok(gaps.some((t) => t.includes("grip") || t.includes("forearm")), "flags missing grip work");
  assert.ok(gaps.some((t) => t.includes("mobility")), "flags missing mobility work");
});

test("programAdjustments surfaces a due deload + a due group, plain words", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 315 }]);
  // Sliding squat → a deload adaptation should appear.
  logSet("Back Squat", isoDaysAgo(28), { weight: 315, reps: 5, rir: 1 });
  logSet("Back Squat", isoDaysAgo(21), { weight: 305, reps: 5, rir: 1 });
  logSet("Back Squat", isoDaysAgo(14), { weight: 295, reps: 5, rir: 1 });
  logSet("Back Squat", isoDaysAgo(5), { weight: 285, reps: 5, rir: 1 });

  const adj = programAdjustments();
  assert.ok(adj.length > 0, "adaptations are surfaced");
  for (const a of adj) {
    assert.doesNotMatch(`${a.title} ${a.why}`, /\b\d{1,3}\/100\b/, "never a 0-100 score");
  }
  assert.ok(adj.some((a) => a.kind === "deload"), "the sliding squat earns a deload adaptation");
});

test("programAdjustments reframes a due group ALREADY in the plan — train it, don't add more", () => {
  // Back is programmed (a Pull day) but its logged volume is thin → due. The honest
  // read is "get those sessions in", NOT "add a back movement you already have".
  makeExercise("Barbell Row", { muscle_group: "back" });
  makeExercise("Lat Pulldown", { muscle_group: "back" });
  repo.savePlanDay(3, "Pull", "Back", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
  ]);
  // A little logged back work over a week ago keeps it DUE (thin volume), not absent.
  logSet("Barbell Row", isoDaysAgo(9), { weight: 135, reps: 8, rir: 2 });

  const adj = programAdjustments();
  const back = adj.find((a) => a.kind === "balance" && /back is due/i.test(a.title));
  assert.ok(back, "back surfaces as due");
  assert.equal(back.programmed, true, "flagged programmed — it's already in the plan");
  assert.match(back.why, /already in your plan/i, "the why says it's already programmed");
  assert.match(back.why, /Day 3/i, "names the day it's on");
  assert.match(back.why, /logged volume/i, "frames the gap as logged volume, not a missing movement");
  // Its suggestions are the movements you ALREADY have, never generic 'add X'.
  assert.ok(
    back.suggestions.some((s) => /Barbell Row|Lat Pulldown/.test(s)),
    "suggestions list the programmed movements, not new ones to add"
  );
});

// ---- acute recovery: never recommend a just-smoked muscle for the next session ---
function logRide(date, { type = "ride", duration_min = 180, distance_km = 40 } = {}) {
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(date, type, `${type} ride`, duration_min, distance_km, "test");
}

test("recentMuscleLoad maps a long ride to the leg + core regions it torched (heavy)", () => {
  // "ride" is exactly what normalizeGarminType folds cycling onto — the real sync path.
  logRide(isoDaysAgo(1)); // a 3 h ride yesterday
  const load = recentMuscleLoad(2);
  for (const g of ["quads", "hamstrings", "glutes", "calves", "core"]) {
    const rl = load.get(g);
    assert.ok(rl, `${g} is flagged as recently loaded by the ride`);
    assert.equal(rl.heavy, true, `${g} is HEAVY (a 3 h ride is a real dose)`);
    assert.equal(rl.source, "endurance");
    assert.equal(rl.activity, "ride");
  }
  // A ride doesn't torch the chest/biceps — they stay fresh.
  assert.ok(!load.get("chest"), "the ride doesn't flag chest");
  assert.ok(!load.get("biceps"), "the ride doesn't flag biceps");
  // The raw provider type ("mountain_biking") in a free-text log matches too.
  reset();
  logRide(isoDaysAgo(1), { type: "mountain_biking" });
  assert.equal(recentMuscleLoad(2).get("quads")?.heavy, true, "raw mountain_biking is recognized");
});

test("recentMuscleLoad does NOT gate legs after a short casual walk", () => {
  // A 40-min walk folds onto "hike" but is well under hike's heavy bar (90 min).
  db.prepare(`INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(isoDaysAgo(1), "hike", "evening walk", 40, 3, "test");
  const rl = recentMuscleLoad(2).get("quads");
  if (rl) assert.equal(rl.heavy, false, "a short walk loads legs but not HEAVY — it won't hold back leg training");
});

test("programAdjustments holds back a due group the athlete just smoked on a ride", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  // Both quads and chest are DUE (thin, trained > a week ago) — but only legs got
  // hammered by yesterday's long ride.
  logSet("Back Squat", isoDaysAgo(9), { weight: 225, reps: 5, rir: 2 });
  logSet("Bench Press", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logRide(isoDaysAgo(1)); // 3 h MTB ride yesterday → quads recovering

  const adj = programAdjustments();
  const quads = adj.find((a) => a.kind === "balance" && /quad/i.test(a.title));
  const chest = adj.find((a) => a.kind === "balance" && /chest/i.test(a.title));
  assert.ok(quads, "quads still appears (it IS due on the week)");
  assert.equal(quads.recovering, true, "but it's reframed as RECOVERING, not a call to act");
  assert.match(quads.title, /recovering/i);
  assert.ok(!(quads.suggestions && quads.suggestions.length), "a recovering group offers no 'do it now' movements");
  assert.match(quads.why, /ride/i, "the why names the ride that loaded it (the connected read)");
  assert.ok(chest, "chest — fresh, untouched by the ride — is a normal due item");
  assert.ok(!chest.recovering, "chest is NOT recovering");
  assert.ok(chest.suggestions && chest.suggestions.length, "a fresh due group carries concrete movements");
  // Fresh work leads; the recovering group is sunk below it.
  assert.ok(adj.indexOf(chest) < adj.indexOf(quads), "fresh due group ranks above the recovering one");
  // Plain words only — never a 0-100 score.
  for (const a of adj) assert.doesNotMatch(`${a.title} ${a.why}`, /\b\d{1,3}\/100\b/);
});

test("multiple smoked due groups consolidate into ONE calm recovering note", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Romanian Deadlift", { muscle_group: "hamstrings" });
  logSet("Back Squat", isoDaysAgo(9), { weight: 225, reps: 5, rir: 2 });
  logSet("Romanian Deadlift", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logRide(isoDaysAgo(1)); // a long ride yesterday torches both quads and hamstrings

  const adj = programAdjustments();
  const rec = adj.filter((a) => a.recovering);
  assert.equal(rec.length, 1, "the smoked groups collapse into ONE recovering line, not three rows");
  assert.match(rec[0].title, /quad/i);
  assert.match(rec[0].title, /hamstring/i);
  assert.match(rec[0].why, /they're due/i, "plural phrasing for multiple groups");
  assert.match(rec[0].why, /ride/i, "names the ride that loaded them");
});
