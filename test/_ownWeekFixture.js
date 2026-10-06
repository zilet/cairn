// The athlete's own week, laid RELATIVE to today's real weekday — the shape of the live
// morning of 2026-10-06 (shape only, no real data): lifts Monday–Friday, runs Tuesday
// (easy) / Thursday (quality) / Sunday (long), a recurring Saturday ride, a seven-day
// streak, and this morning's run already in with the lift still open.
//
// `role` is which weekday TODAY plays (0 = Monday … 6 = Sunday); every other day is laid
// at its offset from today, so the wall-clock freshness gates read exactly as in
// production. Seeded through the production writers (repo.*), like test/_seed.js.
import { db, repo, localDaysAgo } from "./_seed.js";

export const WORLD = [
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_activities",
  "garmin_sources",
  "context_events",
  "sessions",
  "logged_sets",
  "activities",
  "plan_items",
  "plan_days",
  "exercises",
  "profile",
  "day_reads",
  "training_symptom_events",
  "symptom_reports",
  "program_blocks",
  "app_state",
  "daily_session_compositions",
  "daily_session_decisions",
  "training_stances",
  "brain_decisions",
  "brain_expectations",
  "brain_rollbacks",
  "calibration_events",
  "hr_model_state",
];

export const REF = localDaysAgo(0);
export const ago = (n) => localDaysAgo(n);
const T = new Date(`${REF}T00:00:00Z`).getUTCDay();
const dowAt = (offset) => (((T + offset) % 7) + 7) % 7;

// The week's roles, Monday = 0.
export const ROLE = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const LIFT_ROLES = [0, 1, 2, 3, 4];
const RUN_ROLES = [
  { role: 1, kind: "easy" },
  { role: 3, kind: "quality" },
  { role: 6, kind: "long" },
];
const RIDE_ROLE = 5;

/** Days from today (negative = past) to the most recent `role` day on or before today. */
function backTo(role, todayRole) {
  return -(((todayRole - role) % 7) + 7) % 7;
}

let sourceId = null;
function garminSource() {
  if (sourceId != null && db.prepare(`SELECT id FROM garmin_sources WHERE id = ?`).get(sourceId)) return sourceId;
  sourceId = Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'own-week-fixture')`).run().lastInsertRowid
  );
  return sourceId;
}

/** One activity, optionally with a watch row (TE / load / name). */
export function addActivity(date, type, minutes, km, garmin = null) {
  const id = Number(
    db
      .prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, ?, ?, ?)`)
      .run(date, type, minutes, km).lastInsertRowid
  );
  if (garmin) {
    db.prepare(
      `INSERT INTO garmin_activities
         (source_id, external_id, activity_id, date, type, name, duration_min, distance_km, aerobic_te, training_effect, training_load)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      garminSource(),
      `own-week-${id}`,
      id,
      date,
      garmin.type ?? (type === "ride" ? "mountain_biking" : type),
      garmin.name ?? null,
      minutes,
      km,
      garmin.te ?? null,
      garmin.te ?? null,
      garmin.load ?? null
    );
  }
  return id;
}

export function seedPlan() {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Overhead Press", muscle_group: "shoulders" });
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Lat Pulldown", muscle_group: "back" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings" });
  repo.savePlanDay(1, "Push", "Chest, shoulders & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  repo.savePlanDay(2, "Pull", "Back & biceps", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(3, "Lower A", "Squat & quads", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6 }]);
  repo.savePlanDay(4, "Upper", "Chest, back & arms", [
    { exercise: "Bench Press", sets: 3, rep_low: 8, rep_high: 10 },
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(5, "Lower B", "Hinge & single-leg", [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8 }]);
}

function liftDay(date) {
  repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  for (let n = 1; n <= 4; n++) repo.logSetByName({ date, exercise: "Test Squat", weight: 185, reps: 5, rir: 2 });
}

/**
 * Lay the week. Options:
 *   role         which weekday today plays (default Tuesday)
 *   goal         profile goal_mode ("lose" live: weekend endurance reads as fueling advice;
 *                "maintain": it reads as a hybrid-interference caution)
 *   rideWeeks    weekly Saturday rides (2 → the observed cross-training day; 1 → none)
 *   rideMin      minutes of the most recent Saturday ride (history rides are 142)
 *   rideTe       the most recent ride's watch TE (null → no watch row); history rides get
 *                `historyRideTe` (default: the same as rideTe)
 *   runToday     log this morning's run (default true)
 *   streakDays   lifting/endurance days laid before today (default 7)
 *   statedLift   state the lifting weekdays (default true)
 *   statedRuns   state the run weekdays (default true)
 */
export function layOwnWeek({
  role = ROLE.tue,
  goal = "lose",
  rideWeeks = 2,
  rideMin = 142,
  rideTe = null,
  historyRideTe = rideTe,
  runToday = true,
  streakDays = 7,
  statedLift = true,
  statedRuns = true,
} = {}) {
  repo.setProfile({
    goal_mode: goal,
    primary_discipline: "hybrid",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    ...(statedLift
      ? { strength_schedule: { days: LIFT_ROLES.map((r) => ({ dow: dowAt(r - role) })), source: "athlete", updated_at: REF } }
      : {}),
    ...(statedRuns
      ? {
          endurance_schedule: {
            days: RUN_ROLES.map((r) => ({ dow: dowAt(r.role - role), kind: r.kind })),
            source: "athlete",
            updated_at: REF,
          },
        }
      : {}),
  });
  seedPlan();
  // Four steady weeks of the same running (no spike, no "longest in months"), laid at
  // each run role's most recent past occurrence and the three weeks before it.
  for (const { role: runRole, kind } of RUN_ROLES) {
    let back = backTo(runRole, role);
    if (back === 0) back = -7; // today's own run is the morning's, laid below
    for (let week = 0; week < 4; week++) {
      const date = ago(-back + week * 7);
      if (kind === "long") addActivity(date, "run", 84, week === 0 ? 13.5 : 14);
      else addActivity(date, "run", 40, kind === "easy" ? 6.5 : 6);
    }
  }
  // The Saturday rides: the most recent at `rideMin` / `rideTe`, the earlier ones at the habit.
  let rideBack = backTo(RIDE_ROLE, role);
  if (rideBack === 0) rideBack = -7;
  for (let week = 0; week < rideWeeks; week++) {
    const te = week === 0 ? rideTe : historyRideTe;
    addActivity(ago(-rideBack + week * 7), "ride", week === 0 ? rideMin : 142, 31.2, te != null ? { te, load: 230 } : null);
  }
  // The lifting days of the streak.
  for (let n = 1; n <= streakDays; n++) {
    const dayRole = (((role - n) % 7) + 7) % 7;
    if (LIFT_ROLES.includes(dayRole)) liftDay(ago(n));
  }
  // This morning's run is in; the lift is not.
  if (runToday) addActivity(REF, "run", 38, 6.1);
}
