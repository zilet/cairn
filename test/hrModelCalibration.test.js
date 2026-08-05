// The PERSONAL HR model and the calibration ladder.
//
// The bug this exists to make impossible: the app rendered "Z2 (128–140 bpm)"
// off a population formula at an athlete whose observed max is 182 and whose
// conversational pace sits at 155–163. Every band here is derived from THIS
// athlete's logged work instead — and when the data can't say, the model says
// "insufficient" rather than inventing a band from an age.
//
// The second half is the coach's testing loop: a stale quantity is only worth a
// test when it is actually steering a decision, a test is DETECTED from logged
// work rather than filled in on a form, and detection stays conservative because
// a false anchor poisons every zone band for months.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  classifyRunEffort,
  deriveHrModel,
  efficiencyPhrase,
  efficiencyTrend,
  getHrModel,
  hrModelForCoach,
  hrZoneLabel,
} from "../dist/repo/hr-model.js";
import {
  calibrationStatus,
  detectRunCalibration,
  detectStrengthCalibration,
  dueCalibrations,
  recordCalibrationEvent,
} from "../dist/repo/calibration.js";
import { normalizedExerciseKey } from "../dist/repo/exercise-canon.js";
import { localDateISO } from "../dist/repo/shared.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { projectCoachContext } from "../dist/prompt/context-projection.js";

const REF = "2026-05-15";

function shift(dateISO, days) {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}
function back(days) {
  return shift(REF, -days);
}

function reset() {
  resetTables(
    "calibration_events",
    "hr_model_state",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "logged_sets",
    "sessions",
    "exercises",
    "plan_items",
    "plan_days",
    "plan_proposals",
    "profile"
  );
}
beforeEach(reset);

let sourceSeq = 0;
function garminSource() {
  const existing = db.prepare(`SELECT id FROM garmin_sources LIMIT 1`).get();
  if (existing) return existing.id;
  sourceSeq += 1;
  return Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run(`hr-test-${sourceSeq}`)
      .lastInsertRowid
  );
}

let activitySeq = 0;
function logRun({ date, minutes = 40, km = 8, avgHr = 145, maxHr = 165, aerobicTe = null, type = "running" }) {
  activitySeq += 1;
  const info = db
    .prepare(
      `INSERT INTO garmin_activities
         (source_id, external_id, date, type, name, duration_min, moving_min, distance_km, avg_hr, max_hr, aerobic_te)
       VALUES (?, ?, ?, ?, 'Run', ?, ?, ?, ?, ?, ?)`
    )
    .run(garminSource(), `hr-act-${activitySeq}`, date, type, minutes, minutes, km, avgHr, maxHr, aerobicTe);
  return Number(info.lastInsertRowid);
}

function logRestingHr(date, bpm) {
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, resting_hr) VALUES (?, ?, ?)`).run(
    garminSource(),
    date,
    bpm
  );
}

// The athlete this whole subsystem was built for: an observed max of 182, a
// conversational pace up around 160, and a genuinely sustained 54-minute run
// averaging 163.
function seedThisAthlete(anchor = REF) {
  const at = (days) => shift(anchor, -days);
  logRun({ date: at(12), minutes: 42, km: 8.5, avgHr: 149, maxHr: 182 });
  logRun({ date: at(26), minutes: 30, km: 6, avgHr: 152, maxHr: 180 });
  logRun({ date: at(40), minutes: 28, km: 5.5, avgHr: 147, maxHr: 179 });
  logRun({ date: at(55), minutes: 25, km: 5, avgHr: 143, maxHr: 174 });
  logRun({ date: at(70), minutes: 33, km: 6.5, avgHr: 146, maxHr: 176 });
  // The sustained effort the threshold estimate hangs off.
  logRun({ date: at(20), minutes: 54, km: 11, avgHr: 163, maxHr: 179 });
  logRestingHr(at(1), 53);
}

// ── the model ────────────────────────────────────────────────────────────────

test("the model reads THIS athlete's numbers — 182 max, a 163×54min effort — not a formula", () => {
  seedThisAthlete();
  const model = deriveHrModel(REF);

  assert.equal(model.observed_max, 182, "the observed max is the athlete's own peak");
  assert.equal(model.lthr_basis, "sustained_effort", "the best sustained effort estimates threshold");
  assert.equal(model.lthr, 166, "163 avg held for 54 min reads as a threshold around 166");
  assert.equal(model.confidence, "estimated");
  assert.equal(model.resting, 53, "a fresh resting reading is carried");
  assert.deepEqual(model.zones, { z1_top: 141, z2_top: 148, z3_top: 156, z4_top: 164 });
  assert.ok(model.basis_runs >= 3);

  // The band the old formula got wrong: this athlete's easy ceiling is ~148, not 140.
  assert.equal(hrZoneLabel("z2", model), "Z2 (142–148 bpm)");
  assert.ok(model.zones.z2_top > 140, "the derived easy ceiling clears the population band");

  // And the classification that follows from it.
  assert.ok(
    ["quality", "steady"].includes(classifyRunEffort(157, 45, model)),
    "45 minutes at 157 is real work for this athlete"
  );
  assert.equal(classifyRunEffort(144, 40, model), "easy", "40 minutes at 144 is an easy run");
});

test("one freak max-HR reading never drags the whole zone table up with it", () => {
  seedThisAthlete();
  logRun({ date: back(8), minutes: 20, km: 4, avgHr: 150, maxHr: 205 }); // strap dropout
  assert.equal(deriveHrModel(REF).observed_max, 182, "a lone spike defers to the runner-up");

  // A peak that is only a few beats clear of the rest is real, and is kept.
  reset();
  seedThisAthlete();
  logRun({ date: back(8), minutes: 35, km: 7, avgHr: 158, maxHr: 186 });
  assert.equal(deriveHrModel(REF).observed_max, 186, "a peak close to the field is genuine");
});

test("the threshold ladder: a field test outranks a sustained estimate, which outranks the floor", () => {
  seedThisAthlete();

  // (b) sustained is where the ladder starts with logged runs alone.
  assert.equal(deriveHrModel(REF).lthr_basis, "sustained_effort");

  // (a) a detected time trial anchors it outright.
  recordCalibrationEvent({
    kind: "lthr_tt",
    date: back(30),
    target_key: "lthr",
    result: { lthr: 171 },
    source: "detected",
  });
  const anchored = deriveHrModel(REF);
  assert.equal(anchored.lthr_basis, "field_test");
  assert.equal(anchored.lthr, 171);
  assert.equal(anchored.confidence, "anchored");

  // A test too old to speak for today drops back to the estimate.
  db.prepare(`UPDATE calibration_events SET date = ? WHERE kind = 'lthr_tt'`).run(back(200));
  const aged = deriveHrModel(REF);
  assert.equal(aged.lthr_basis, "sustained_effort");
  assert.equal(aged.lthr, 166);
});

test("with no sustained effort to read, the floor is a fraction of the OBSERVED max", () => {
  logRun({ date: back(12), minutes: 22, km: 4, avgHr: 150, maxHr: 182 });
  logRun({ date: back(26), minutes: 18, km: 3.5, avgHr: 152, maxHr: 180 });
  logRun({ date: back(40), minutes: 24, km: 4.5, avgHr: 147, maxHr: 179 });
  const model = deriveHrModel(REF);
  assert.equal(model.lthr_basis, "fallback");
  assert.equal(model.lthr, 167, "0.92 of an observed 182 — never 0.92 of an age formula");
  assert.equal(model.confidence, "estimated");
});

test("too little data says so, and manufactures no caution", () => {
  logRun({ date: back(12), minutes: 40, km: 8, avgHr: 150, maxHr: 178 });
  logRun({ date: back(30), minutes: 40, km: 8, avgHr: 148, maxHr: 176 });
  const model = deriveHrModel(REF);
  assert.equal(model.confidence, "insufficient");
  assert.equal(model.zones, null);
  assert.equal(model.lthr, null);
  assert.equal(model.lthr_basis, null);
  assert.equal(classifyRunEffort(160, 45, model), "unknown", "absence stays neutral, never a verdict");
  assert.equal(hrModelForCoach(REF).available, false);
});

test("a stale resting-HR reading behaves as absent, and absence changes nothing else", () => {
  seedThisAthlete();
  db.prepare(`UPDATE garmin_daily_metrics SET date = ?`).run(back(20)); // well past the 3-day window
  const model = deriveHrModel(REF);
  assert.equal(model.resting, null, "a 20-day-old resting HR is not today's resting HR");
  assert.equal(model.lthr, 166, "and the zones are unmoved by its absence");
});

test("the derive persists, and a read for another day recomputes instead of serving it", () => {
  seedThisAthlete();
  const derived = deriveHrModel(REF);
  assert.ok(derived.updated_at, "the persisted model carries when it was derived");
  const stored = db.prepare(`SELECT as_of FROM hr_model_state WHERE id = 1`).get();
  assert.equal(stored.as_of, REF);
  assert.equal(getHrModel(REF).lthr, 166);
  // A later day is derived fresh (not served from another day's row).
  assert.equal(getHrModel(shift(REF, 3)).updated_at, null);
});

// ── aerobic efficiency ───────────────────────────────────────────────────────

test("efficiency reads as a DIRECTION in words — never an index the athlete could score", () => {
  // Same pulse, progressively more ground covered.
  for (const [days, km, minutes] of [
    [100, 8, 50],
    [95, 8, 50],
    [70, 8, 48],
    [65, 8, 48],
    [20, 8, 45],
    [10, 8, 44],
  ]) {
    logRun({ date: back(days), minutes, km, avgHr: 145, maxHr: 168 });
  }
  const trend = efficiencyTrend(180, REF);
  assert.equal(trend.direction, "improving");
  assert.ok(trend.points.length >= 2 && trend.latest, "monthly means and a latest value are exposed");

  const phrase = efficiencyPhrase(trend, REF);
  assert.ok(phrase, "an improving trend has words for it");
  assert.equal(violatesReadingGrammar(phrase), null, `"${phrase}" holds the reading grammar`);
  assert.ok(!/\d/.test(phrase), "the words carry no number at all");

  const spoken = new Set();
  for (let i = 0; i < 6; i++) spoken.add(efficiencyPhrase(trend, shift(REF, i)));
  assert.ok(spoken.size >= 3, "a stable trend rotates its phrasing rather than repeating one sentence");
});

// ── calibration: staleness and decision-relevance ────────────────────────────

function raceGoal() {
  repo.setProfile({
    age: 44,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Test Half", date: shift(REF, 84), distance_km: 21.1 },
  });
}

test("threshold: never anchored + a race on the calendar is due; the same staleness without a goal is not", () => {
  seedThisAthlete();
  raceGoal();
  const withGoal = calibrationStatus(REF).items.find((item) => item.key === "lthr");
  assert.equal(withGoal.freshness, "never");
  assert.equal(withGoal.due, true, "zones steer prescriptions when a race is being trained for");

  repo.setProfile({ endurance_goal: null });
  const withoutGoal = calibrationStatus(REF).items.find((item) => item.key === "lthr");
  assert.equal(withoutGoal.freshness, "never", "it is exactly as un-anchored as before");
  assert.equal(withoutGoal.due, false, "stale alone is never a reason — nothing is steering off it");
});

test("a recent field test reads as anchored and asks for nothing", () => {
  seedThisAthlete();
  raceGoal();
  recordCalibrationEvent({ kind: "lthr_tt", date: back(10), target_key: "lthr", result: { lthr: 168 }, source: "detected" });
  const item = calibrationStatus(REF).items.find((entry) => entry.key === "lthr");
  assert.equal(item.freshness, "anchored");
  assert.equal(item.due, false);
  assert.equal(item.last_anchored, back(10));
});

test("the easy-pace benchmark ages faster than threshold does", () => {
  seedThisAthlete();
  raceGoal();
  recordCalibrationEvent({
    kind: "benchmark_run",
    date: back(60),
    target_key: "easy_pace",
    result: { pace_min_per_km: 6.1 },
    source: "detected",
  });
  const item = calibrationStatus(REF).items.find((entry) => entry.key === "easy_pace");
  assert.equal(item.freshness, "aging", "60 days is aging for a benchmark, anchored for a threshold");
  assert.equal(item.due, false, "aging is not stale — nothing is asked for yet");
});

// ── calibration: strength ────────────────────────────────────────────────────

const BENCH = "Barbell Bench Press";

function seedBenchPlanAndHistory() {
  repo.savePlanDay(1, "Push", "Push", [{ exercise: BENCH, sets: 4, rep_low: 3, rep_high: 6, target_weight: 205 }]);
  repo.logSetByName({ date: back(200), exercise: BENCH, weight: 185, reps: 5 });
  repo.logSetByName({ date: back(190), exercise: BENCH, weight: 190, reps: 5 });
  // The last set heavy enough to VERIFY the estimate the plan was using.
  repo.logSetByName({ date: back(100), exercise: BENCH, weight: 205, reps: 2 });
  repo.logSetByName({ date: back(30), exercise: BENCH, weight: 195, reps: 5 });
}

let proposalSeq = 0;
function appliedProgression(dateISO, targetWeight) {
  proposalSeq += 1;
  db.prepare(
    `INSERT INTO plan_proposals (created_at, agent, instruction, raw_output, parsed_json, status)
     VALUES (?, 'stub', 'progression', '', ?, 'applied')`
  ).run(
    `${dateISO} 08:00:00`,
    JSON.stringify({
      summary: `bench +5 (${proposalSeq})`,
      changes: [{ day_number: 1, exercise: BENCH, target_weight: targetWeight }],
    })
  );
}

test("a lift the plan keeps raising on an unverified estimate is what a coach re-tests", () => {
  seedBenchPlanAndHistory();
  const key = normalizedExerciseKey(BENCH);

  // Stale (the last verifying set was 100 days ago) but the plan has only nudged
  // the target twice since — not yet worth interrupting for.
  appliedProgression(back(80), 200);
  appliedProgression(back(50), 205);
  const quiet = calibrationStatus(REF).items.find((item) => item.key === key);
  assert.ok(quiet, "the plan's main lift is tracked");
  assert.equal(quiet.last_anchored, back(100));
  assert.equal(quiet.freshness, "stale");
  assert.equal(quiet.due, false, "stale but not yet steering enough to interrupt for");

  // A third raise on the same unverified number is where the estimate starts
  // carrying real weight.
  appliedProgression(back(20), 210);
  const due = calibrationStatus(REF).items.find((item) => item.key === key);
  assert.equal(due.due, true);
});

test("a lift verified recently is anchored, however much the plan has moved it", () => {
  seedBenchPlanAndHistory();
  // A heavy top set inside the anchored window.
  repo.logSetByName({ date: back(14), exercise: BENCH, weight: 215, reps: 2 });
  appliedProgression(back(80), 200);
  appliedProgression(back(50), 205);
  appliedProgression(back(20), 210);
  const item = calibrationStatus(REF).items.find((entry) => entry.key === normalizedExerciseKey(BENCH));
  assert.equal(item.freshness, "anchored");
  assert.equal(item.due, false);
  assert.equal(item.last_anchored, back(14));
});

test("finishing a session with a heavy top set records the verification, once", () => {
  seedBenchPlanAndHistory();
  const date = back(2);
  repo.logSetByName({ date, exercise: BENCH, weight: 215, reps: 2, day_number: 1 });
  const session = repo.getOrCreateSession(date);
  repo.finishSession(session.id);

  const events = db.prepare(`SELECT * FROM calibration_events WHERE kind = 'strength_topset'`).all();
  assert.equal(events.length, 1, "the session's verifying set is recorded exactly once");
  assert.equal(events[0].target_key, normalizedExerciseKey(BENCH));
  assert.equal(JSON.parse(events[0].result_json).weight, 215);

  // A re-finish (or a Garmin re-sync) must not stack a second anchor.
  repo.finishSession(session.id);
  detectStrengthCalibration(session.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calibration_events`).get().n, 1);
});

test("an ordinary working session records no verification at all", () => {
  seedBenchPlanAndHistory();
  const date = back(2);
  repo.logSetByName({ date, exercise: BENCH, weight: 175, reps: 8, day_number: 1 });
  const session = repo.getOrCreateSession(date);
  repo.finishSession(session.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calibration_events`).get().n, 0);
});

// ── calibration: detection from synced runs ──────────────────────────────────

test("an ordinary easy run anchors nothing — a false anchor poisons the model for months", () => {
  seedThisAthlete();
  deriveHrModel(REF);
  const easy = logRun({ date: back(2), minutes: 45, km: 9, avgHr: 140, maxHr: 158, aerobicTe: 2.2 });
  assert.equal(detectRunCalibration(easy), null);
  // A long steady run that never approached threshold is not a test either.
  const steady = logRun({ date: back(3), minutes: 62, km: 12, avgHr: 150, maxHr: 168, aerobicTe: 3.1 });
  assert.equal(detectRunCalibration(steady), null);
  // Nor is a hard SHORT effort — the length is part of the signature.
  const spike = logRun({ date: back(4), minutes: 14, km: 3.5, avgHr: 170, maxHr: 182, aerobicTe: 4.1 });
  assert.equal(detectRunCalibration(spike), null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calibration_events`).get().n, 0);
});

test("a 30-minute effort held near threshold IS a test, and it anchors the model", () => {
  seedThisAthlete();
  deriveHrModel(REF);
  const tt = logRun({ date: back(5), minutes: 32, km: 7.5, avgHr: 168, maxHr: 179, aerobicTe: 4.0 });
  const event = detectRunCalibration(tt);
  assert.ok(event, "the signature is recognized");
  assert.equal(event.kind, "lthr_tt");
  assert.equal(event.target_key, "lthr");
  assert.equal(event.result.lthr, 170);

  // Re-reading the same activity (a re-sync) stacks nothing.
  const again = detectRunCalibration(tt);
  assert.equal(again.id, event.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calibration_events`).get().n, 1);

  // And the next derive picks it up off the ladder's top rung.
  const model = deriveHrModel(REF);
  assert.equal(model.lthr_basis, "field_test");
  assert.equal(model.lthr, 170);
  assert.equal(model.confidence, "anchored");
});

// The trust bar under detection. On the FALLBACK rung the model has no threshold
// evidence at all — lthr is just 0.92 x the observed max — and it sits low enough
// that an ordinary tempo run clears the "held near threshold" test. Trusting a
// detection there would let that run become an uncapped field-test anchor, flip
// confidence to "anchored", and stop the ladder ever asking for the real test.
test("on the fallback rung an ordinary tempo run is not mistaken for a field test", () => {
  // Enough HR-bearing runs for a model, none long enough to estimate a threshold
  // from — so the ladder drops to its floor.
  for (const days of [8, 20, 34, 48]) {
    logRun({ date: back(days), minutes: 28, km: 5.5, avgHr: 150, maxHr: 182 });
  }
  const floored = deriveHrModel(REF);
  assert.equal(floored.lthr_basis, "fallback", "no sustained effort to hang a threshold off");
  assert.equal(floored.lthr, 167, "the floor is 0.92 x the observed 182");

  // A tempo run: real work, well short of a threshold test — and at 159 bpm it
  // clears 0.95 x the floored estimate purely because the floor is low.
  const tempo = logRun({ date: back(3), minutes: 30, km: 6.4, avgHr: 159, maxHr: 176, aerobicTe: 3.6 });
  assert.ok(159 >= 0.95 * floored.lthr, "the run does clear the raw near-threshold bar");
  assert.equal(detectRunCalibration(tempo), null, "but nothing is anchored from an unanchored model");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calibration_events`).get().n, 0);

  // And the model is exactly where it was: still estimated, still asking.
  const after = deriveHrModel(REF);
  assert.equal(after.lthr_basis, "fallback");
  assert.equal(after.confidence, "estimated", "an ordinary run never buys 'anchored'");
});

test("a mid-distance run held at the benchmark pulse anchors the easy-pace read", () => {
  seedThisAthlete();
  const model = deriveHrModel(REF);
  const benchmarkHr = model.zones.z2_top - 2; // 146
  const run = logRun({ date: back(6), minutes: 36, km: 6, avgHr: benchmarkHr, maxHr: 157, aerobicTe: 2.6 });
  const event = detectRunCalibration(run);
  assert.ok(event);
  assert.equal(event.kind, "benchmark_run");
  assert.equal(event.target_key, "easy_pace");
  assert.equal(event.result.pace_min_per_km, 6);

  // A run at the same distance but well off the benchmark pulse is not the test.
  const drifted = logRun({ date: back(7), minutes: 33, km: 6, avgHr: benchmarkHr + 9, maxHr: 165, aerobicTe: 3.0 });
  assert.equal(detectRunCalibration(drifted), null);
});

// ── the suggestions themselves ───────────────────────────────────────────────

test("every suggestion holds the reading grammar, and rotates rather than repeating", () => {
  seedThisAthlete();
  raceGoal();
  seedBenchPlanAndHistory();
  appliedProgression(back(80), 200);
  appliedProgression(back(50), 205);
  appliedProgression(back(20), 210);

  const lines = new Set();
  const placements = new Set();
  let seen = 0;
  for (let i = 0; i < 12; i++) {
    const day = shift(REF, i);
    const suggestions = dueCalibrations(day);
    assert.ok(suggestions.length > 0, "a stale, decision-relevant quantity has a suggestion");
    assert.ok(suggestions.length <= 2, "calibration stays a quiet opening, never a to-do list");
    for (const suggestion of suggestions) {
      seen += 1;
      assert.equal(violatesReadingGrammar(suggestion.line), null, `line holds the grammar: ${suggestion.line}`);
      assert.equal(
        violatesReadingGrammar(suggestion.placement),
        null,
        `placement holds the grammar: ${suggestion.placement}`
      );
      assert.ok(!/\bday(s)?\b\s*(ago|old)/i.test(suggestion.line), "no day-count reaches the athlete");
      lines.add(suggestion.line);
      placements.add(suggestion.placement);
    }
  }
  assert.ok(seen >= 12);
  assert.ok(lines.size >= 3, "the suggestion prose is a variant set, not one literal");
  assert.ok(placements.size >= 3, "so is the placement");
});

test("nothing stale AND relevant means nothing is suggested", () => {
  seedThisAthlete(); // runs, but no goal and no plan targets being raised
  assert.deepEqual(dueCalibrations(REF), []);
});

// ── the prompt boundary ──────────────────────────────────────────────────────

test("the model + calibration reach the Brief and the session prompt, and no other site", () => {
  const ctx = {
    hr_model: { available: true, lthr: 166 },
    calibration: { due: [], recently_anchored: [] },
    now: { date: REF },
  };
  for (const site of ["day_read", "session"]) {
    const projected = projectCoachContext(ctx, site);
    assert.ok(Object.hasOwn(projected, "hr_model"), `${site} carries hr_model`);
    assert.ok(Object.hasOwn(projected, "calibration"), `${site} carries calibration`);
  }
  for (const site of ["coach", "meal_plan", "health_review", "daily_composition", "weekly_read", "insight"]) {
    const projected = projectCoachContext(ctx, site);
    assert.ok(!Object.hasOwn(projected, "hr_model"), `${site} does not carry hr_model`);
    assert.ok(!Object.hasOwn(projected, "calibration"), `${site} does not carry calibration`);
  }
});

test("the coach context carries the compact model and the due list", () => {
  // getCoachContext always builds for TODAY, so this one seeds against the real
  // calendar rather than the fixed reference day the rest of the file uses.
  const today = localDateISO();
  seedThisAthlete(today);
  raceGoal();
  deriveHrModel(today);
  const ctx = repo.getCoachContext();
  assert.ok(Object.hasOwn(ctx, "hr_model"), "hr_model is a coach-context key");
  assert.ok(Object.hasOwn(ctx, "calibration"), "calibration is a coach-context key");
  assert.equal(ctx.hr_model.available, true);
  assert.equal(ctx.hr_model.lthr, 166);
  assert.equal(ctx.hr_model.lthr_basis, "sustained_effort");
  assert.match(ctx.hr_model.zones.z2, /bpm/);
  assert.ok(Array.isArray(ctx.calibration.due));
});

// ── the two suggestion slots are SHARED, not first-come ──────────────────────
// A hybrid athlete has two endurance quantities aging on their own clocks and a
// plan full of lifts. Taking the due list in item order handed both slots to
// endurance forever, so a strength test was never offered — and the progression
// engine's "hold this lift until a heavy set settles it" had no reachable way to
// be settled. The slots now split when both domains are waiting.

test("when both domains are due, the two slots split one and one", () => {
  seedThisAthlete();
  raceGoal();
  seedBenchPlanAndHistory();
  appliedProgression(back(80), 200);
  appliedProgression(back(50), 205);
  appliedProgression(back(20), 210);

  const items = calibrationStatus(REF).items;
  const dueEndurance = items.filter((item) => item.domain === "endurance" && item.due);
  const dueStrength = items.filter((item) => item.domain === "strength" && item.due);
  assert.equal(dueEndurance.length, 2, "both endurance quantities are genuinely due");
  assert.ok(dueStrength.length >= 1, "and so is the lift the plan keeps raising");

  const due = dueCalibrations(REF);
  assert.equal(due.length, 2, "still at most two suggestions — this is an opening, not a to-do list");
  assert.equal(due[0].kind, "lthr_tt", "endurance still speaks first");
  assert.equal(due[1].kind, "strength_topset", "…it just no longer speaks twice while strength waits");
  assert.equal(due[1].target_key, normalizedExerciseKey(BENCH));
});

test("with only one domain due, that domain still fills both slots", () => {
  // Fairness is a tiebreak, not a quota: nothing is withheld when there is nothing
  // on the other side waiting for the slot.
  seedThisAthlete();
  raceGoal();
  const due = dueCalibrations(REF);
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((entry) => entry.kind), ["lthr_tt", "benchmark_run"]);
});

// ── a lift the engine is HOLDING is a lift whose test is due ─────────────────

test("a lift held for want of a heavy set counts as due, however few raises it has had", () => {
  // No applied progressions at all, so the raise-count path cannot fire. What makes
  // the test due is that a live decision — the progression engine's hold — is
  // waiting on exactly the confirmation this ladder would produce.
  repo.savePlanDay(1, "Push", "Push", [{ exercise: BENCH, sets: 3, rep_low: 5, rep_high: 5, target_weight: 205 }]);
  for (const [days, weight] of [[28, 205], [21, 200], [14, 195], [5, 190]]) {
    repo.logSetByName({ date: back(days), exercise: BENCH, weight, reps: 5 });
  }
  const item = calibrationStatus(REF).items.find((entry) => entry.key === normalizedExerciseKey(BENCH));
  assert.ok(item, "the plan's main lift is tracked");
  assert.equal(item.freshness, "never", "no heavy set has ever stood behind this estimate");
  assert.equal(item.due, true, "the hold is the live decision depending on it");
  assert.ok(
    dueCalibrations(REF).some((entry) => entry.target_key === normalizedExerciseKey(BENCH)),
    "and it reaches the suggestion list"
  );
});
