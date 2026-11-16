// Far-from-failure bodyweight filler is a light stimulus on recovery, not deep fatigue.
// Live case (2026-11-16): three sets of "Flat Bench Knee Raise" (core, bodyweight, x15,
// RIR 5) between bench sets read core as deep/reduced mid-session. Two causes pinned here:
// the acute residual weighed RIR 5 like half a working set, and the word "bench" made the
// knee raise a horizontal press that lent triceps/shoulders indirect credit.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { acuteEffortWeight, acuteGate, acuteGates, muscleResidual } from "../dist/repo/hybrid-load.js";
import { gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";

const REF = "2026-11-16";
beforeEach(() => resetTables("logged_sets", "sessions", "exercises", "activities", "garmin_activities", "profile"));

function log(name, group, sets) {
  const ex = repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const sess = repo.getOrCreateSession(REF, null);
  let n = 1;
  for (const [w, reps, rir] of sets)
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?,?,?,?,?,?)`
    ).run(sess.id, ex.id, n++, w, reps, rir);
}
function session(kneeRir, { knee = true } = {}) {
  log("Bench Press", "chest", [[140, 8, 2], [145, 6, 2], [145, 5, 2]]);
  log("Overhead Press", "shoulders", [[70, 7, 1], [70, 7, 1]]);
  if (knee) log("Flat Bench Knee Raise", "core", [[null, 15, kneeRir], [null, 15, kneeRir], [null, 15, kneeRir]]);
}
const res = (g) => muscleResidual(7, REF).get(g)?.residual ?? 0;

test("RIR 5 bodyweight knee raises leave core fresh, not saturated, not deep, not reduced", () => {
  session(5);
  const core = acuteGate("core", REF);
  assert.equal(core.band, "fresh");
  assert.equal(core.saturated, false);
  assert.equal(core.deep, false);
  const snap = gatherDailyDecisionSnapshot(REF);
  const entry = snap.muscle_load.find((m) => m.group === "core");
  assert.ok(!entry || (!entry.saturated && !entry.deep), "the envelope sees no core load");
});

test("a core movement named 'bench' lends no indirect credit to triceps or shoulders", () => {
  session(5);
  const withKnee = { t: res("triceps"), s: res("shoulders") };
  resetTables("logged_sets", "sessions", "exercises");
  session(5, { knee: false });
  assert.equal(withKnee.t, res("triceps"));
  assert.equal(withKnee.s, res("shoulders"));
});

test("the same sets at RIR 0-1 still load core as before (saturated, not deep)", () => {
  session(1);
  const core = acuteGates(REF).get("core");
  assert.equal(core.saturated, true);
  assert.equal(core.deep, false);
  assert.ok(Math.abs(core.residual - 0.75) < 1e-9);
});

test("RIR absent is unchanged: a full set, never ease", () => {
  session(null);
  assert.ok(Math.abs(res("core") - 0.75) < 1e-9);
  assert.equal(acuteGate("core", REF).saturated, true);
});

test("acute effort weight: <=3 and absent full, 4 half, 5+ a quarter", () => {
  for (const r of [null, undefined, 0, 1, 2, 3]) assert.equal(acuteEffortWeight(r), 1);
  assert.equal(acuteEffortWeight(4), 0.5);
  assert.equal(acuteEffortWeight(5), 0.25);
  assert.equal(acuteEffortWeight(9), 0.25);
  assert.equal(acuteEffortWeight(40), 1, "an implausible RIR is absent");
});
