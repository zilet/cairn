// Prescription authorship (src/repo/prescription-authorship.ts) — the ONE answer to
// "when was this slot's prescription written, and has the athlete trained it since?".
//   1. the stamp rules, pure: identity is movement + rep range + target; a person's or a
//      restructure's set count is identity too, a brain's set step is not; an Undo's
//      carried stamp wins;
//   2. the read, pure: age / fresh / untested / since;
//   3. every plan write path stamps through it (re-save, target step, set step, swap,
//      person save, restructure, Undo);
//   4. every consumer reads through it: a fresh plan whose loads sit below older logs
//      holds at the plan in progression, composes at the plan, earns no floor, hosts no
//      reach, is not rotated, and is not read as flat by the program state.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  PRESCRIPTION_SETTLE_DAYS,
  planSlotStamps,
  prescriptionKey,
  slotAuthorship,
  stampForWrite,
} from "../dist/repo/prescription-authorship.js";
import { buildProgressionProposal, nextPrescription, planDayProgression } from "../dist/repo/progression.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { buildProgressionWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

const TODAY = localDateISO();
const daysAgo = (n) => addDaysISO(TODAY, -n);
const stampOf = (day = 1) =>
  db
    .prepare(
      `SELECT pi.prescribed_at AS at FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id WHERE pd.day_number = ?`
    )
    .get(day)?.at ?? null;
const backdate = (n) => db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(daysAgo(n));
// A person's or a redraw's stamp is a full UTC instant; a brain step's is a bare day.
const isInstantToday = (stamp) =>
  typeof stamp === "string" && stamp.includes("T") && localDateISO(new Date(stamp)) === TODAY;

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_compositions",
    "daily_session_decisions",
    "logged_sets",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals",
    "brain_decisions",
    "brain_rollbacks",
    "program_blocks"
  );
  try {
    repo.setSettings({ training_drive: "steady", lead_mode: "lead" });
  } catch {
    /* settings row may be absent */
  }
});

// ---------------------------------------------------------------- 1. stamp rules

test("identity is movement, rep range and target; sets count unless the brain is stepping them", () => {
  const slot = { exercise_id: 7, sets: 3, rep_low: 8, rep_high: 10, target_weight: 100, target_seconds: null };
  const moreSets = { ...slot, sets: 4 };
  assert.equal(prescriptionKey(slot, "brain"), prescriptionKey(moreSets, "brain"));
  assert.notEqual(prescriptionKey(slot, "person"), prescriptionKey(moreSets, "person"));
  assert.notEqual(prescriptionKey(slot, "restructure"), prescriptionKey(moreSets, "restructure"));
  assert.notEqual(prescriptionKey(slot, "brain"), prescriptionKey({ ...slot, target_weight: 105 }, "brain"));
  assert.notEqual(prescriptionKey(slot, "brain"), prescriptionKey({ ...slot, rep_low: 6 }, "brain"));
});

test("stampForWrite keeps an unchanged slot's date, authors a changed or new one today, and lets a restore win", () => {
  const prev = { exercise_id: 7, sets: 3, rep_low: 8, rep_high: 10, target_weight: 100, prescribed_at: "2026-01-05" };
  const today = "2026-03-01";
  assert.equal(stampForWrite(prev, { ...prev }, { by: "brain", today }), "2026-01-05");
  assert.equal(stampForWrite(prev, { ...prev, sets: 4 }, { by: "brain", today }), "2026-01-05", "a brain set increase");
  assert.equal(stampForWrite(prev, { ...prev, sets: 2 }, { by: "brain", today }), today, "a set CUT by any writer");
  assert.equal(stampForWrite(prev, { ...prev, sets: 2 }, { by: "person", today }), today, "a person's set change");
  assert.equal(stampForWrite(prev, { ...prev, sets: 2 }, { by: "restructure", today }), today, "a redraw's set count");
  assert.equal(stampForWrite(prev, { ...prev, target_weight: 105 }, { by: "brain", today }), today);
  assert.equal(stampForWrite(null, prev, { by: "brain", today }), today, "a brand-new slot");
  assert.equal(
    stampForWrite({ ...prev, prescribed_at: null }, { ...prev }, { by: "brain", today }),
    null,
    "settled stays settled"
  );
  assert.equal(
    stampForWrite(prev, { ...prev, target_weight: 90 }, { by: "brain", today, restore: "2025-12-01" }),
    "2025-12-01"
  );
});

// ----------------------------------------------------------------- 2. the read

test("slotAuthorship: age, fresh, untested and since", () => {
  const read = slotAuthorship("2026-03-01", "2026-02-20", "2026-03-05");
  assert.equal(read.prescribed_at, "2026-03-01");
  assert.equal(read.age_days, 4);
  assert.equal(read.fresh, true);
  assert.equal(read.untested, true, "logged only before it was written");
  assert.equal(read.since, "2026-03-01");
  assert.equal(slotAuthorship("2026-03-01", "2026-03-01", "2026-03-05").untested, false, "a session on the day counts");
  assert.equal(slotAuthorship("2026-03-01", null, "2026-03-05").untested, false, "no history is its own case");
  const settled = slotAuthorship(null, "2026-02-20", "2026-03-05");
  assert.deepEqual(settled, {
    prescribed_at: null,
    age_days: null,
    fresh: false,
    untested: false,
    since: null,
    since_at: null,
  });
  assert.equal(
    slotAuthorship("2026-01-01", null, addDaysISO("2026-01-01", PRESCRIPTION_SETTLE_DAYS)).fresh,
    false,
    "settled after the window"
  );
});

// --------------------------------------------------------- 3. the write paths

function benchDay(item = {}) {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, ...item },
  ]);
}

test("every plan write stamps through the one rule", () => {
  benchDay();
  assert.equal(stampOf(), TODAY, "a new slot is authored now");
  backdate(30);
  benchDay();
  assert.equal(stampOf(), daysAgo(30), "an unchanged re-save keeps its date");
  benchDay({ sets: 4 });
  assert.equal(stampOf(), daysAgo(30), "a brain re-save that only moves sets keeps its date");
  benchDay({ target_weight: 190 });
  assert.equal(stampOf(), TODAY, "a new target is a new prescription");

  backdate(30);
  repo.applyPlanChange({ day_number: 1, exercise: "Barbell Bench Press", sets: 5 }, { clamp: true });
  assert.equal(stampOf(), daysAgo(30), "a brain set step keeps its date");
  repo.applyPlanChange({ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }, { clamp: true });
  assert.equal(stampOf(), TODAY, "a brain target step re-stamps");

  backdate(30);
  repo.updateTarget(1, "Barbell Bench Press", 200, undefined, { by: "person" }); // as the route and the MCP tool call it
  assert.ok(isInstantToday(stampOf()), "a manual target edit re-stamps, at the instant it was made");

  backdate(30);
  savePlanDayByPerson(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 200 },
  ]);
  assert.ok(isInstantToday(stampOf()), "a person's set change is theirs, at the instant it was made");

  backdate(30);
  repo.replacePlan(
    [
      {
        day_number: 1,
        name: "Push",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 200 }],
      },
    ],
    { by: "restructure" }
  );
  assert.ok(isInstantToday(stampOf()), "a redraw's set count re-stamps, at the instant it was made");

  backdate(30);
  repo.applyPlanChange(
    { day_number: 1, swap: { from: "Barbell Bench Press", to: "Incline Dumbbell Press" } },
    { clamp: true }
  );
  assert.equal(stampOf(), TODAY, "a rotated-in movement is authored now");
  assert.equal(planSlotStamps().size, 1, "the batched read sees every slot");
});

test("Undo puts the slot's own date back along with its load", () => {
  benchDay();
  backdate(40);
  const ex = repo.findExercise("Barbell Bench Press");
  for (const [n, w] of [
    [28, 175],
    [21, 180],
    [10, 185],
  ]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 8, 2)`
    ).run(sess.id, ex.id, w);
  }
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.autonomy?.ok, true, JSON.stringify(out.autonomy));
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
  assert.equal(stampOf(), TODAY, "the applied step is a new prescription");
  assert.equal(revertDecision(out.autonomy.decision.id, "put it back").ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185);
  assert.equal(stampOf(), daysAgo(40), "the restored slot keeps the date it was really written");
});

// ------------------------------------------------ 4. the consumers, one fresh plan

// The dry-run shape: the plan was rewritten today BELOW what older logs show.
function freshBelowOldLogs() {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 },
  ]);
  const ex = repo.findExercise("Back Squat");
  // Capped with reserve, heavier, three times — enough to earn a floor and a reach.
  for (const n of [16, 11, 6]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    for (let s = 1; s <= 3; s++)
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, 205, 7, 3)`
      ).run(sess.id, ex.id, s);
  }
  assert.equal(stampOf(), TODAY);
}

test("progression: a fresh plan below older logs holds at the plan and proposes nothing", () => {
  freshBelowOldLogs();
  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 185);
  assert.ok(!p.reground && !p.vary_to);
  const day = planDayProgression(1, { forNextSession: true })[0];
  assert.equal(day.suggested.weight, 185, "the day pass reads the batched stamp the same way");
  assert.equal(day.set_step, undefined);
  assert.equal(buildProgressionProposal(1).ok, false);
});

test("daily decision + composition: no earned floor, no reach, the card carries the plan load", () => {
  freshBelowOldLogs();
  repo.setSettings({ training_drive: "push" });
  const snap = gatherDailyDecisionSnapshot(TODAY);
  const squat = snap.progression.find((p) => p.exercise === "Back Squat");
  assert.equal(squat?.action, "hold");
  assert.equal(squat?.earned, undefined, "no floor off the replaced prescription");
  const env = buildDailySessionDecision(snap, { now: `${TODAY}T12:00:00.000Z` });
  const candidate = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.ok(candidate, `the squat is a candidate (${env.kind})`);
  {
    assert.equal(candidate.earned_floor, undefined);
    assert.notEqual(candidate.action, "overload");
    const composed = normalizeComposedSession(
      {
        name: "Lower",
        focus: "Squat",
        why: "x",
        est_minutes: 45,
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 }],
      },
      env
    ).session.items.find((i) => i.exercise === "Back Squat");
    assert.equal(composed?.target_weight, 185, "the composed card is the plan load");
    assert.ok(!composed?.reach, "an untested slot never hosts a reach");
  }
});

test("program state: a slide measured across a re-prescription is not this slot's trend", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const ex = repo.findExercise("Back Squat");
  for (const [n, w] of [
    [30, 265],
    [23, 255],
    [16, 245],
    [9, 235],
  ]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 5, 1)`
    ).run(sess.id, ex.id, w);
  }
  const fresh = getProgramState().lifts.find((l) => l.exercise === "Back Squat");
  assert.equal(fresh.status, "new", `untested: no trend of its own yet (${fresh.status})`);
  assert.equal(fresh.suggested_action, "hold");
  backdate(60);
  bumpTrainingDataVersion(); // a raw fixture write; the app's writers bump this themselves
  const settled = getProgramState().lifts.find((l) => l.exercise === "Back Squat");
  assert.equal(settled.status, "regressing", "an established slot's slide still reads");
});

test("rotation: a fresh slot is never rotated for a plateau measured before it", () => {
  repo.upsertExercise({ name: "Triceps Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.savePlanDay(1, "Upper", "Upper", [
    { exercise: "Triceps Rope Pushdown", sets: 3, rep_low: 12, rep_high: 15, target_weight: 50 },
  ]);
  const ex = repo.findExercise("Triceps Rope Pushdown");
  for (const n of [35, 28, 21, 14, 7, 2]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 50, 12, 2)`
    ).run(sess.id, ex.id);
  }
  // Trained once since it was written, still inside the settle window.
  backdate(5);
  const sess = repo.getOrCreateSession(daysAgo(1), null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 50, 12, 2)`
  ).run(sess.id, ex.id);
  const p = nextPrescription("Triceps Rope Pushdown");
  assert.notEqual(p.action, "vary");
  assert.ok(!p.vary_to);
});

// ------------------------------------------------------------ review probes

function logAt(name, date, sets, createdAtSql = null) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  sets.forEach(([weight, reps, rir = null], i) => {
    if (createdAtSql)
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, created_at) VALUES (?, ?, ?, ?, ?, ?, ${createdAtSql})`
      ).run(sess.id, ex.id, i + 1, weight, reps, rir);
    else
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(sess.id, ex.id, i + 1, weight, reps, rir);
  });
}

test("earned floor: a slot cut and trained once is never floored back to the load it replaced", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 205 },
  ]);
  backdate(60);
  // Three capped sessions at 205 with reserve — enough to earn a 205 floor.
  for (const n of [16, 11, 6])
    logAt("Back Squat", daysAgo(n), [
      [205, 5, 3],
      [205, 5, 3],
      [205, 5, 3],
    ]);
  // The athlete cuts it to 185, then trains it once at 185.
  savePlanDayByPerson(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 },
  ]);
  logAt("Back Squat", TODAY, [
    [185, 5, 3],
    [185, 5, 3],
    [185, 5, 3],
  ]);
  const tomorrow = addDaysISO(TODAY, 1);
  const snap = gatherDailyDecisionSnapshot(tomorrow);
  const squat = snap.progression.find((p) => p.exercise === "Back Squat");
  assert.equal(squat?.earned, undefined, "one session under the cut is not two earned exposures");
  const env = buildDailySessionDecision(snap, { now: `${tomorrow}T12:00:00.000Z` });
  const candidate = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.ok(candidate);
  assert.equal(candidate.earned_floor, undefined);
  const composed = normalizeComposedSession(
    {
      name: "Lower",
      focus: "Squat",
      why: "x",
      est_minutes: 45,
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }],
    },
    env
  ).session.items.find((i) => i.exercise === "Back Squat");
  assert.ok(composed.target_weight < 205, `the card never goes back to 205 (${composed.target_weight})`);
});

test("same-day edit: a morning session is not evidence for a plan the athlete rewrote that evening", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 205 },
  ]);
  backdate(60);
  logAt("Back Squat", daysAgo(7), [
    [205, 7],
    [205, 7],
    [205, 7],
  ]);
  // Trained this morning (two hours ago), at the old load…
  logAt(
    "Back Squat",
    TODAY,
    [
      [205, 6],
      [205, 6],
      [205, 6],
    ],
    "datetime('now','-2 hours')"
  );
  // …and rewrote the plan down this evening.
  savePlanDayByPerson(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 },
  ]);
  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 185, "the morning's 205 does not re-ground the evening's 185");
  assert.ok(!p.reground);

  // A legacy bare-day stamp reads as the start of its day: the same session counts.
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(TODAY);
  const legacy = slotAuthorship(TODAY, { date: TODAY, first_at: "2000-01-01 00:00:00" }, TODAY);
  assert.equal(legacy.untested, false);
  assert.equal(legacy.since_at, null);
});

test("a brain step applied at a session's finish is that session's consequence, never untested", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  backdate(40);
  logAt(
    "Barbell Bench Press",
    TODAY,
    [
      [185, 8, 2],
      [185, 8, 2],
      [185, 8, 2],
    ],
    "datetime('now','-1 hours')"
  );
  repo.applyPlanChange({ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }, { clamp: true });
  const stamp = stampOf();
  assert.equal(stamp, TODAY, "a brain step stores its day");
  const first = db.prepare(`SELECT MIN(created_at) AS at FROM logged_sets`).get().at;
  assert.equal(slotAuthorship(stamp, { date: TODAY, first_at: first }, TODAY).untested, false);
});

test("a redraw that omits the load still grounds a lift with loaded history", () => {
  repo.upsertExercise({ name: "Leg Press", muscle_group: "quads", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Legs", [
    { exercise: "Leg Press", sets: 3, rep_low: 10, rep_high: 12, target_weight: 300 },
  ]);
  backdate(60);
  for (const n of [12, 5])
    logAt("Leg Press", daysAgo(n), [
      [320, 10],
      [320, 10],
      [320, 10],
    ]);
  repo.replacePlan(
    [
      {
        day_number: 1,
        name: "Lower",
        items: [{ exercise: "Leg Press", sets: 3, rep_low: 10, rep_high: 12, target_weight: null }],
      },
    ],
    { by: "restructure" }
  );
  const p = nextPrescription("Leg Press");
  assert.equal(p.suggested.weight, 320, "grounded from the latest loaded history, not left empty");
  assert.equal(p.reground, true);
});

test("a set CUT by the brain (a conductor's plan_update) re-stamps; a brain set increase does not", () => {
  benchDay();
  backdate(30);
  repo.applyPlanChange({ day_number: 1, exercise: "Barbell Bench Press", sets: 4 }, { clamp: true });
  assert.equal(stampOf(), daysAgo(30), "the catch-up direction keeps its date");
  repo.applyPlanChange({ day_number: 1, exercise: "Barbell Bench Press", sets: 3 }, { clamp: true });
  assert.equal(stampOf(), TODAY, "a deliberate cut is a new prescription");
});

test("Undo keeps a stamp something else wrote since, rather than restoring over it", () => {
  benchDay();
  backdate(40);
  const ex = repo.findExercise("Barbell Bench Press");
  for (const [n, w] of [
    [28, 175],
    [21, 180],
    [10, 185],
  ]) {
    const sess = repo.getOrCreateSession(daysAgo(n), null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, ?, 8, 2)`
    ).run(sess.id, ex.id, w);
  }
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.autonomy?.ok, true);
  // Something re-stamped the slot after the decision (its values untouched).
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(daysAgo(2));
  assert.equal(revertDecision(out.autonomy.decision.id, "put it back").ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185);
  assert.equal(stampOf(), daysAgo(2), "the later stamp stands");
});
