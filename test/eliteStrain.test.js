// No false "performance under strain": the under-fuelling read's performance channel
// may only vote strain on evidence that is like for like and current.
//   • run output: quality sessions leave the easy-pace pool, climbing is credited as
//     distance, heart rate turns pace into efficiency, and an improving watch fitness
//     read vetoes the decline;
//   • lifts: one untrained for longer than the current window is not "regressing";
//   • activities: a hand log shadowing the synced row of the same effort is one run.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { LIFT_CURRENT_WINDOW_DAYS, liftTrainedRecently } from "../dist/repo/program-state.js";
import { getCardioForDate, withoutShadowActivities } from "../dist/repo/activities.js";

const TODAY = "2026-07-15";
const day = (delta) => addDaysISO(TODAY, delta);

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "logged_sets",
    "sessions",
    "exercises",
    "checkins",
    "fueling_feedback"
  );
});

const onPathExp = { trend_lb_wk: -0.55, confidence: "high", window_days: 21, coverage: { weigh_in_days: 12 } };
const goal = { leanness_rate: { lean_ideal_rate_lb: 0.6, safe_max_rate_lb: 0.85 } };
const quietProgram = { lifts: [], mesocycle: { acute_chronic_ratio: 1.0 }, hybrid: null };
const stableWhole = { domains: [{ domain: "recovery_wellbeing", verdict: "holding", evidence_keys: [] }] };
const read = (programState = quietProgram) =>
  underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState, wholePerson: stableWhole });
const perf = (r) => r.channels.find((c) => c.key === "performance");
const endurance = (r) => perf(r).evidence_keys.filter((k) => /^run_(pace|efficiency)_decline/.test(k));

let ext = 0;
function sourceId() {
  db.prepare(`INSERT OR IGNORE INTO garmin_sources (provider, label) VALUES ('garmin', 'test')`).run();
  return Number(db.prepare(`SELECT id FROM garmin_sources WHERE label = 'test'`).get().id);
}
function garminRun(delta, { km, min, hr, ascent = null, label = "AEROBIC_BASE", name = "Morning Run" }) {
  const id = String(++ext);
  const a = db
    .prepare(
      `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source, external_id)
       VALUES (?, 'run', ?, ?, ?, 'garmin', ?)`
    )
    .run(day(delta), name, min, km, id);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, duration_min, distance_km,
                                    avg_hr, ascent_m, te_label)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
  ).run(sourceId(), id, Number(a.lastInsertRowid), day(delta), name, min, km, hr, ascent, label);
  return Number(a.lastInsertRowid);
}
function watch(delta, { vo2 = null, half = null, endurance = null }) {
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, vo2max, race_predict_half_sec, endurance_score)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sourceId(), day(delta), vo2, half, endurance);
}

// ── run output ────────────────────────────────────────────────────────────────
test("a genuine efficiency decline on easy runs at held volume still strains the channel", () => {
  // Same heart rate, slower on the same flat ground: more beats for the same work.
  for (const d of [-15, -18, -21]) garminRun(d, { km: 10, min: 55, hr: 150 });
  for (const d of [-3, -6, -9]) garminRun(d, { km: 10, min: 60, hr: 150 });
  const r = read();
  assert.equal(perf(r).direction, "strain");
  assert.equal(endurance(r).length, 1);
  assert.match(endurance(r)[0], /^run_efficiency_decline:/);
});

test("quality sessions (tempo/VO2max/threshold labels, hills, sprints) never make an easy-pace trend", () => {
  // Raw pace slips ~10% — but only because the recent fortnight is hills and sprints.
  for (const d of [-15, -18]) garminRun(d, { km: 10, min: 55, hr: 150 });
  garminRun(-21, { km: 8, min: 42, hr: 160, label: "LACTATE_THRESHOLD" });
  garminRun(-3, { km: 10, min: 62, hr: 150, label: "TEMPO", name: "Hills" });
  garminRun(-6, { km: 10, min: 61, hr: 150, label: null, name: "5k+sprints" });
  garminRun(-9, { km: 10, min: 60, hr: 150, label: "VO2MAX" });
  const r = read();
  assert.deepEqual(endurance(r), [], "no like-for-like pool, so no decline to call");
  assert.notEqual(perf(r).direction, "strain");
});

test("a slower pace at a much lower heart rate is fitness, not strain (a long run at 154 vs 9 km at 162)", () => {
  // Prior: 9 km @6:00/km @162 bpm. Recent: slower easy runs at a far lower heart rate,
  // and a 16.8 km @5:54/km @154 long run — every recent run covers more ground per beat.
  garminRun(-18, { km: 9.2, min: 55.2, hr: 162 });
  garminRun(-21, { km: 9.2, min: 55.2, hr: 162 });
  // The recent mean RAW pace is ~6% slower than the prior one — the old read fired here.
  garminRun(-3, { km: 16.8, min: 99.1, hr: 154 });
  garminRun(-6, { km: 10, min: 66, hr: 140 }); // 6:36/km at 140 bpm
  garminRun(-9, { km: 10, min: 66, hr: 140 });
  const r = read();
  assert.deepEqual(endurance(r), []);
  assert.notEqual(perf(r).direction, "strain");
});

test("climbing is credited as distance, so a hilly route is not a slow one", () => {
  for (const d of [-15, -18, -21]) garminRun(d, { km: 10, min: 50, hr: 150, ascent: 0 });
  for (const d of [-3, -6, -9]) garminRun(d, { km: 10, min: 54, hr: 150, ascent: 120 }); // 8% slower, 120 m up
  assert.deepEqual(endurance(read()), []);
});

test("an improving watch fitness read over the same window vetoes a run decline", () => {
  for (const d of [-15, -18, -21]) garminRun(d, { km: 10, min: 55, hr: 150 });
  for (const d of [-3, -6, -9]) garminRun(d, { km: 10, min: 60, hr: 150 });
  watch(-20, { vo2: 44.3, half: 7952, endurance: 5257 });
  watch(-1, { vo2: 46.8, half: 7154, endurance: 5682 });
  const r = read();
  assert.deepEqual(endurance(r), [], "VO2max, predictor and endurance score all improved");
  assert.notEqual(perf(r).direction, "strain");
});

test("a watch read that moved the wrong way on any marker does not veto", () => {
  for (const d of [-15, -18, -21]) garminRun(d, { km: 10, min: 55, hr: 150 });
  for (const d of [-3, -6, -9]) garminRun(d, { km: 10, min: 60, hr: 150 });
  watch(-20, { vo2: 44.3, half: 7952 });
  watch(-1, { vo2: 45.0, half: 8200 }); // VO2 up, but the predictor slowed ~3%
  assert.equal(endurance(read()).length, 1);
});

// ── lifts ─────────────────────────────────────────────────────────────────────
test("a sliding lift untrained past the current window reads re-baselining, never regressing", () => {
  const ref = TODAY;
  const back = (n) => addDaysISO(ref, -n);
  const w = [160, 155, 150, 145, 140];
  // A clear decline — that ended six weeks ago.
  [70, 63, 56, 49, 42].forEach((d, i) =>
    repo.logSetByName({ exercise: "Face Pull", weight: w[i], reps: 8, rir: 2, date: back(d) })
  );
  // The same decline, still being trained.
  [28, 21, 14, 7, 0].forEach((d, i) =>
    repo.logSetByName({ exercise: "Pendlay Row", weight: w[i], reps: 8, rir: 2, date: back(d) })
  );
  const lifts = repo.getProgramState(ref).lifts;
  const dormant = lifts.find((l) => l.exercise === "Face Pull");
  const current = lifts.find((l) => l.exercise === "Pendlay Row");
  assert.equal(current.status, "regressing", "a lift in the rotation still reads its slide");
  assert.notEqual(dormant.status, "regressing");
  assert.equal(dormant.status, "new");
  assert.equal(dormant.suggested_action, "hold");
  assert.equal(dormant.last_trained, back(42));
});

test("the performance channel counts only regressing lifts trained inside the current window", () => {
  const stale = addDaysISO(TODAY, -(LIFT_CURRENT_WINDOW_DAYS + 1));
  const recent = addDaysISO(TODAY, -3);
  assert.equal(liftTrainedRecently({ last_trained: recent }, TODAY), true);
  assert.equal(liftTrainedRecently({ last_trained: stale }, TODAY), false);
  assert.equal(liftTrainedRecently({ last_trained: null }, TODAY), false);
  const staleProgram = {
    ...quietProgram,
    lifts: ["Face Pull", "Lateral Raise", "Seated Cable Row"].map((exercise) => ({
      exercise,
      status: "regressing",
      last_trained: stale,
    })),
  };
  const r = read(staleProgram);
  assert.ok(!perf(r).evidence_keys.some((k) => /program_state:regressing/.test(k)));
  assert.notEqual(perf(r).direction, "strain");
  const currentProgram = {
    ...quietProgram,
    lifts: ["Squat", "Bench"].map((exercise) => ({ exercise, status: "regressing", last_trained: recent })),
  };
  assert.equal(perf(read(currentProgram)).direction, "strain", "two current slides are still strain");
});

// ── activity shadows ──────────────────────────────────────────────────────────
test("a hand log shadowing the synced run of the same day is one run, not two", () => {
  garminRun(0, { km: 9.2, min: 55.2, hr: 162 });
  // The athlete's chat note, logged hours after the watch synced — distance only.
  db.prepare(`INSERT INTO activities (date, type, raw_text, distance_km, notes) VALUES (?, 'run', 'morning 9km run', 9, 'morning run')`).run(TODAY);
  // A metric-less note of the same run.
  db.prepare(`INSERT INTO activities (date, type, raw_text, notes) VALUES (?, 'run', 'morning run (fasted)', 'fasted')`).run(TODAY);
  const cardio = getCardioForDate(TODAY);
  assert.equal(cardio.length, 1);
  assert.equal(cardio[0].source, "garmin");
  // The rows are the athlete's words — nothing is deleted.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE date = ?`).get(TODAY).n, 3);
});

test("a hand log whose measurements disagree with the synced row stays a real effort", () => {
  const rows = [
    { id: 1, date: TODAY, type: "run", source: "garmin", external_id: "x", distance_km: 9.2, duration_min: 55.2 },
    { id: 2, date: TODAY, type: "run", source: null, external_id: null, distance_km: 5, duration_min: null },
    { id: 3, date: TODAY, type: "ride", source: null, external_id: null, distance_km: null, duration_min: null },
    { id: 4, date: day(-1), type: "run", source: null, external_id: null, distance_km: 9, duration_min: null },
  ];
  assert.deepEqual(
    withoutShadowActivities(rows).map((r) => r.id),
    [1, 2, 3, 4],
    "a second run, another modality, and another day all survive"
  );
});
