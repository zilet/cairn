// Shared seeding + reset helpers for the test harness. Everything writes through
// the same singleton DB the app uses (dist/db.js), which the runner has already
// pointed at a throwaway temp file via DATA_DIR/DB_PATH. Tests reset the tables
// they touch at the start of each case so files can run in any order in the one
// shared process the node:test runner gives us.
import { db } from "../dist/db.js";
import * as repo from "../dist/repo.js";
import { localDateISO } from "../dist/repo/shared.js";

export { db, repo };

// Build a nutritionally complete 7-day meal-plan fixture while preserving any
// named meals a test needs to inspect. New production writes reject partial
// historical plans, so status/prompt tests should use this helper instead of
// accidentally depending on an unchecked one-day artifact.
export function completeMealWeek(parsed = {}) {
  const dailyKcal = Number(parsed.daily_kcal) > 0 ? Math.round(Number(parsed.daily_kcal)) : 2200;
  const dailyProtein = Number(parsed.daily_protein_g) > 0 ? Math.round(Number(parsed.daily_protein_g)) : 170;
  const supplied = Array.isArray(parsed.days) ? parsed.days : [];
  const days = Array.from({ length: 7 }, (_, index) => {
    const source = supplied[index] && typeof supplied[index] === "object" ? supplied[index] : {};
    const meals = (Array.isArray(source.meals) ? source.meals : []).map((meal) => ({ ...meal }));
    if (!meals.length) meals.push({ name: "Meal-plan fixture", kcal: dailyKcal, protein_g: dailyProtein });
    const earlier = meals.slice(0, -1);
    const priorKcal = earlier.reduce((sum, meal) => sum + (Number(meal.kcal) || 0), 0);
    const priorProtein = earlier.reduce((sum, meal) => sum + (Number(meal.protein_g) || 0), 0);
    meals[meals.length - 1] = {
      ...meals[meals.length - 1],
      kcal: Math.max(1, dailyKcal - priorKcal),
      protein_g: Math.max(0, dailyProtein - priorProtein),
    };
    return { ...source, day: String(source.day || `Fixture ${index + 1}`), meals };
  });
  return { ...parsed, daily_kcal: dailyKcal, daily_protein_g: dailyProtein, days };
}

// ---- date helpers (YYYY-MM-DD) ----
// Local frame, NOT UTC: repo day-keys and "today" checks (localDateISO,
// canonicalWeightLogDate) run in the process zone, so a UTC slice here makes
// isoDaysAgo(0) read as tomorrow between UTC midnight and local midnight —
// the midnight-UTC flake window.
export function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}
export function localDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}
export function tsDaysAgo(n) {
  // SQLite-style "YYYY-MM-DD HH:MM:SS" timestamp n days ago (for created_at).
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 19).replace("T", " ");
}

// Wipe the tables a given suite depends on so each run starts from a known floor.
export function resetTables(...tables) {
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}

// ---- health markers (via health_documents.parsed_json) ----
// Each call inserts one dated document carrying a markers[] array. getMarkerHistory
// walks documents in effective-date order, so seeding several dated docs builds a
// per-marker time series.
export function seedHealthDoc(docDate, markers, kind = "bloodwork") {
  return repo.addHealthDocument({
    kind,
    doc_date: docDate,
    parsed_json: { markers },
    enrichment_status: "done",
  });
}

// Convenience: a single marker reading on a given date.
export function marker(name, value, { unit = null, flag = null } = {}) {
  return { name, value, unit, flag };
}

// ---- bodyweight log ----
export function seedWeight(date, lb) {
  return repo.logWeight(lb, date);
}

// ---- food intake (controlled created_at so we can build N distinct intake days) ----
// addFoodNote always stamps created_at = now AND (when raw text + enrich on) tries
// to enqueue a background agent job. We bypass both by inserting directly with a
// chosen created_at and empty raw_output, so intake seeding stays fully offline.
//
// This one CANNOT follow seedTrainingDay onto the production path, and the reason is
// structural rather than a preference: `insertFoodNote` (the single insert behind every
// food-note writer) hardcodes `localDateISO()` for `date` and lets `created_at` default
// to now. No repo function can create a food note for a PAST day, so a fixture whose
// entire purpose is N distinct historical intake days has no faithful path to take.
// src/demoSeed.ts inserts food notes raw for exactly the same reason.
//
// So the caveat stands here. addFoodNote fires bumpFoodDataVersion() (backstopped —
// ignore it), a `food_logged` brain event, and invalidateDayReadForDate(), which busts
// the cached Brief for the note's own day AND today whenever they differ. A test
// pinning any of those must drive the repo path on a day it can afford to have stamped
// today — see food-invalidates-day-read.test.js, which uses a raw insert only to place
// the fixture row and then asserts against real repo.updateFoodNote / deleteFoodNote
// calls. That split — raw for setup, production path for the behavior under test — is
// the pattern to copy.
export function seedIntake(daysAgo, kcal, extra = {}) {
  const parsed = { kcal, ...extra };
  return db
    .prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, created_at)
       VALUES (?, 'meal', '', ?, NULL, ?)`
    )
    .run(localDaysAgo(daysAgo), JSON.stringify(parsed), tsDaysAgo(daysAgo));
}

// ---- sessions + logged sets (drives dayRead's consecutive-training count) ----
// A "training day" for dayRead = a session date that has at least one logged set.
// A genuinely-LOADING training day: real volume taken near failure, so the
// intensity-aware day-read (training-read.dayLoad) grades it 'moderate'/'hard'
// and it counts toward the earned-rest streak. (A single light set would now,
// correctly, grade 'easy' and NOT stack — see seedRecoveryDay.)
//
// This drives repo.logSetByName — the PRODUCTION path — so every side effect of a
// real logging write fires: invalidateDayRead(date) (busts the cached Brief for that
// date, drops the brain snapshots, schedules the re-warm, and re-opens an already-
// judged day_read_adherence expectation), the `set_logged` brain event,
// completeStrengthObjectiveFromLoggedSet() (a real WRITE to strength_objectives, not
// just a signal), and bumpTrainingDataVersion().
//
// It used to insert logged_sets directly, and that silent divergence from production
// was a live trap: a test could assert on behavior that only a real write produces,
// pass on the fixture artifact, and certify nothing. Making the faithful path the
// DEFAULT removes the hazard for everyone who never reads this comment — which was
// the whole problem with documenting it instead.
//
// If you need INERT rows — a cached day read coexisting with newer logged work, or a
// second session row for one date that getOrCreateSession would never create — do the
// raw insert INLINE in your own test, the way dayReadUseCase.test.js and
// adaptiveDailySession.test.js do for activities and sessions. Rawness belongs at the
// call site that depends on it, where it is visible, not hidden in a shared fixture.
export function seedTrainingDay(date) {
  // Upsert first so the exercise keeps its muscle group: logSetByName's
  // findOrCreateExercise would default it, and volume-by-group reads care.
  repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  for (let n = 1; n <= 4; n++) {
    repo.logSetByName({ date, exercise: "Test Squat", weight: 185, reps: 5, rir: 2 });
  }
  return repo.getOrCreateSession(date, null);
}

// A light recovery/mobility day: bodyweight + a timed hold at high RIR — grades
// 'easy', so it should BREAK an earned-rest streak rather than extend it.
//
// Production path, for the same reasons as seedTrainingDay above. (These sets carry
// no load, so est_1rm is null and the strength-objective write correctly stays out.)
export function seedRecoveryDay(date) {
  repo.upsertExercise({ name: "Dead Bug", muscle_group: "core" });
  repo.upsertExercise({ name: "Side Plank", muscle_group: "core", mode: "timed" });
  repo.logSetByName({ date, exercise: "Dead Bug", reps: 10, rir: 9 });
  repo.logSetByName({ date, exercise: "Side Plank", duration_sec: 30, exercise_mode: "timed" });
  return repo.getOrCreateSession(date, null);
}

// ---- recovery: source-agnostic daily metrics (drives dayRead low-sleep branch) ----
export function seedSleep(date, sleepMin) {
  return repo.recordDailyMetrics("apple", date, { sleep_min: sleepMin });
}
