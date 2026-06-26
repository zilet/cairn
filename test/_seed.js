// Shared seeding + reset helpers for the test harness. Everything writes through
// the same singleton DB the app uses (dist/db.js), which the runner has already
// pointed at a throwaway temp file via DATA_DIR/DB_PATH. Tests reset the tables
// they touch at the start of each case so files can run in any order in the one
// shared process the node:test runner gives us.
import { db } from "../dist/db.js";
import * as repo from "../dist/repo.js";
import { localDateISO } from "../dist/repo/shared.js";

export { db, repo };

// ---- date helpers (YYYY-MM-DD) ----
export function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
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
export function seedTrainingDay(date) {
  const ex = repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  const sess = repo.getOrCreateSession(date, null);
  for (let n = 1; n <= 4; n++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
       VALUES (?, ?, ?, 185, 5, 2)`
    ).run(sess.id, ex.id, n);
  }
  return sess;
}

// A light recovery/mobility day: bodyweight + a timed hold at high RIR — grades
// 'easy', so it should BREAK an earned-rest streak rather than extend it.
export function seedRecoveryDay(date) {
  const ex = repo.upsertExercise({ name: "Dead Bug", muscle_group: "core" });
  const plank = repo.upsertExercise({ name: "Side Plank", muscle_group: "core", mode: "timed" });
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, reps, rir) VALUES (?, ?, 1, 10, 9)`).run(sess.id, ex.id);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, duration_sec) VALUES (?, ?, 1, 30)`).run(sess.id, plank.id);
  return sess;
}

// ---- recovery: source-agnostic daily metrics (drives dayRead low-sleep branch) ----
export function seedSleep(date, sleepMin) {
  return repo.recordDailyMetrics("apple", date, { sleep_min: sleepMin });
}
