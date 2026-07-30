// The temporal muscle model (src/repo/hybrid-load.ts). Fatigue used to be a
// BOOLEAN with a cliff — `sets >= HEAVY_SETS` inside a fixed 2-day window — so a
// muscle was equally smoked by 4 sets and by 30, and went from smoked to fresh at
// midnight on an arbitrary day. What is pinned here:
//   - DOSE scales with effective volume (8 sets carry twice what 4 do)
//   - DECAY is exponential at a PER-GROUP half-life (rear delts forget in a day,
//     hamstrings still carry work three days out)
//   - the SATURATED band reproduces the old `heavy` bar at the same-day boundary,
//     so nothing downstream shifts underfoot on the day the work was actually done
//   - endurance contributes a real regional dose, scaled past its modality's own
//     heavy bar (a 110-min run is not the same event as a 55-min one)
//   - acuteGate() is the ONE reading, consistent with recentMuscleLoad().heavy
// Deterministic, offline, temp DB (see test/run.mjs).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  acuteGate,
  acuteGates,
  enduranceDose,
  LOADED_RESIDUAL,
  muscleResidual,
  recentMuscleLoad,
  recentEnduranceImpacts,
  residualBand,
  SATURATED_RESIDUAL,
} from "../dist/repo/hybrid-load.js";
import { recoveryHalfLifeHours } from "../dist/repo/exercise-canon.js";

const REF = "2026-05-15";
const back = (n) => new Date(new Date(`${REF}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);

function reset() {
  resetTables(
    "logged_sets",
    "sessions",
    "exercises",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days"
  );
}
beforeEach(reset);

// Log `count` identical working sets for one exercise on one date. Identical
// loads keep every set a WORKING set (effectiveVolumeByGroup drops a set under
// 55% of the day's top load as a ramp-up warmup), so the dose is exactly the
// count and the assertions below are about time, not about warmup filtering.
function logSets(name, group, date, count, weight = 100) {
  const ex = repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const sess = repo.getOrCreateSession(date, null);
  for (let i = 1; i <= count; i++) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, i, weight, 8, 2);
  }
}

const residualFor = (group, date = REF) => muscleResidual(7, date).get(group)?.residual ?? 0;

// ── dose ─────────────────────────────────────────────────────────────────────

test("no logged work reads as no residual at all, and every gate is fresh", () => {
  assert.equal(muscleResidual(7, REF).size, 0);
  const gate = acuteGate("chest", REF);
  assert.equal(gate.band, "fresh");
  assert.equal(gate.saturated, false);
  assert.equal(gate.residual, 0);
  assert.equal(gate.last_date, null);
  assert.equal(acuteGates(REF).size, 0);
});

test("dose scales with effective volume — 8 sets carry twice what 4 do", () => {
  logSets("Rear Delt Fly", "rear delts", REF, 4);
  const four = residualFor("rear delts");
  reset();
  logSets("Rear Delt Fly", "rear delts", REF, 8);
  const eight = residualFor("rear delts");
  assert.ok(four > 0, "4 sets lay down a real dose");
  assert.ok(
    Math.abs(eight - four * 2) < 1e-9,
    `8 sets should be exactly twice 4 sets (got ${eight} vs ${four})`
  );
});

test("the saturated band reproduces the old heavy bar at the same-day boundary", () => {
  // The old rule was `sets >= HEAVY_SETS` (4). Same-day, the residual has not
  // decayed at all, so the bar must land in the same place it always did.
  logSets("Rear Delt Fly", "rear delts", REF, 4);
  assert.equal(acuteGate("rear delts", REF).saturated, true, "4 sets today is still saturated");
  reset();
  logSets("Rear Delt Fly", "rear delts", REF, 2);
  const gate = acuteGate("rear delts", REF);
  assert.equal(gate.saturated, false, "2 sets today is not a heavy dose");
  assert.equal(gate.band, "loaded", "…but it is not nothing either");
});

test("residualBand draws the two documented lines and nothing between them", () => {
  assert.equal(residualBand(SATURATED_RESIDUAL), "saturated");
  assert.equal(residualBand(SATURATED_RESIDUAL - 1e-9), "loaded");
  assert.equal(residualBand(LOADED_RESIDUAL), "loaded");
  assert.equal(residualBand(LOADED_RESIDUAL - 1e-9), "fresh");
  assert.equal(residualBand(0), "fresh");
});

// ── decay ────────────────────────────────────────────────────────────────────

test("one half-life of elapsed time halves the dose", () => {
  // Rear delts recover fastest in the table (24 h), so exactly one day back is
  // exactly one half-life — the cleanest possible check of the decay curve.
  assert.equal(recoveryHalfLifeHours("rear delts"), 24);
  logSets("Rear Delt Fly", "rear delts", back(1), 4);
  const after = residualFor("rear delts");
  assert.ok(Math.abs(after - 0.5) < 1e-9, `a day-old 4-set dose should read 0.5, got ${after}`);
  assert.equal(acuteGate("rear delts", REF).saturated, false, "yesterday's small-muscle work is no longer a gate");
});

test("the same dose decays at each group's OWN rate — this is the fix for the flat 2-day cliff", () => {
  logSets("Rear Delt Fly", "rear delts", back(1), 4);
  logSets("Standing Calf Raise", "calves", back(1), 4);
  logSets("Romanian Deadlift", "hamstrings", back(1), 4);
  const map = muscleResidual(7, REF);
  const rear = map.get("rear delts").residual;
  const calves = map.get("calves").residual;
  const hams = map.get("hamstrings").residual;
  assert.ok(rear < calves, "a small isolation group forgets faster than calves");
  assert.ok(calves < hams, "calves forget faster than eccentrically-loaded hamstrings");
  // The old model said all three were equally "heavy" yesterday. The new one
  // says only the slow group is still a gate.
  assert.equal(acuteGate("hamstrings", REF).saturated, true);
  assert.equal(acuteGate("rear delts", REF).saturated, false);
});

test("a dose keeps fading across days rather than falling off a cliff", () => {
  const seen = [];
  for (const daysAgo of [0, 1, 2, 3]) {
    reset();
    logSets("Romanian Deadlift", "hamstrings", back(daysAgo), 4);
    seen.push(residualFor("hamstrings"));
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] < seen[i - 1], `day ${i} carries less than day ${i - 1} (${seen})`);
    assert.ok(seen[i] > 0, "and it is never abruptly zero inside the lookback");
  }
});

test("two sessions on different days stack, each decayed on its own", () => {
  logSets("Rear Delt Fly", "rear delts", REF, 2); // 0.5, undecayed
  logSets("Rear Delt Fly", "rear delts", back(1), 4); // 1.0 halved to 0.5
  const total = residualFor("rear delts");
  assert.ok(Math.abs(total - 1.0) < 1e-9, `stacked residual should be 1.0, got ${total}`);
});

// ── endurance ────────────────────────────────────────────────────────────────

test("a heavy run lays a real dose on the legs it actually loads", () => {
  repo.addActivity({ type: "run", duration_min: 70, date: REF });
  const map = muscleResidual(7, REF);
  for (const group of ["quads", "hamstrings", "glutes", "calves", "core"]) {
    const r = map.get(group);
    assert.ok(r, `${group} carries endurance residual`);
    assert.equal(r.source, "endurance");
    assert.ok(r.endurance > 0 && r.strength === 0);
  }
  assert.equal(acuteGate("quads", REF).saturated, true, "a heavy run saturates the prime movers");
  assert.equal(map.get("chest"), undefined, "and touches nothing it did not load");
});

test("effort past the modality's own heavy bar carries a bigger dose", () => {
  repo.addActivity({ type: "run", duration_min: 55, date: REF }); // exactly the bar
  const atBar = residualFor("quads");
  reset();
  repo.addActivity({ type: "run", duration_min: 110, date: REF }); // twice the bar
  const doubled = residualFor("quads");
  assert.ok(
    doubled > atBar * 1.9,
    `a 110-min run should carry about twice a 55-min one (${doubled} vs ${atBar})`
  );
});

test("the endurance magnitude is capped, so one enormous day cannot own the week", () => {
  repo.addActivity({ type: "run", duration_min: 600, date: REF });
  const impact = recentEnduranceImpacts(7, REF).find((i) => i.label === "run");
  assert.ok(impact, "the run is read as an endurance impact");
  assert.ok(impact.heavy_ratio > 5, "the raw ratio is genuinely large");
  assert.ok(enduranceDose(impact) <= 2.5, "…but the dose it contributes is bounded");
});

test("a casual stroll is not a dose on anything", () => {
  repo.addActivity({ type: "walk", duration_min: 20, distance_km: 1.5, date: REF });
  assert.equal(residualFor("quads"), 0);
  assert.equal(acuteGate("quads", REF).saturated, false);
});

test("strength and endurance on the same group stack into one residual", () => {
  logSets("Back Squat", "quads", REF, 2);
  repo.addActivity({ type: "run", duration_min: 70, date: REF });
  const r = muscleResidual(7, REF).get("quads");
  assert.equal(r.source, "both");
  assert.ok(r.strength > 0 && r.endurance > 0);
  assert.ok(Math.abs(r.residual - (r.strength + r.endurance)) < 1e-9);
});

// ── acuteGate is the one reading ─────────────────────────────────────────────

test("acuteGate agrees with recentMuscleLoad's derived heavy for every group", () => {
  logSets("Romanian Deadlift", "hamstrings", back(1), 5);
  logSets("Rear Delt Fly", "rear delts", back(1), 5);
  repo.addActivity({ type: "run", duration_min: 70, date: REF });
  const load = recentMuscleLoad(2, REF);
  assert.ok(load.size > 0, "there is recent load to read");
  for (const [group, rl] of load) {
    assert.equal(
      rl.heavy,
      acuteGate(group, REF).saturated,
      `${group}: recentMuscleLoad.heavy must be the acuteGate reading, not a second opinion`
    );
    // The whole record is spread into the coach context as `recent_load`, so the
    // internal float stays behind the gate — a prompt only ever sees the band.
    assert.ok(
      !("residual" in rl),
      `${group}: recentMuscleLoad must not carry the internal residual into the coach context`
    );
  }
});

test("acuteGate folds free-form group text onto the canonical taxonomy", () => {
  logSets("Rear Delt Fly", "rear delts", REF, 4);
  assert.equal(acuteGate("Rear Delts", REF).group, "rear delts");
  assert.equal(acuteGate("Rear Delts", REF).saturated, true);
  assert.equal(acuteGate("not a muscle at all", REF).saturated, false, "unknown text reads fresh, never throws");
});

test("acuteGates reports every group carrying residual, and each matches acuteGate", () => {
  logSets("Back Squat", "quads", REF, 4);
  logSets("Rear Delt Fly", "rear delts", back(2), 4);
  const gates = acuteGates(REF);
  assert.ok(gates.size >= 2);
  for (const [group, gate] of gates) {
    assert.deepEqual(gate, acuteGate(group, REF));
  }
});

test("mobility work never lays down a fatigue dose", () => {
  logSets("Hip Flexor Stretch", "mobility", REF, 8);
  assert.equal(muscleResidual(7, REF).get("mobility"), undefined);
  assert.equal(acuteGate("mobility", REF).saturated, false);
});

// ── plain muscle words, and one definition of a hard effort ─────────────────
// Canonical keys are an ANALYSIS taxonomy. Every surface a PERSON reads goes
// through the friendly mapping; the keys stay the machine register.

test("friendly muscle words never hand a canonical key to the athlete", async () => {
  const { friendlyGroupWords, plainGroupWords, MUSCLE_GROUPS } = await import(
    "../dist/repo/exercise-canon.js"
  );
  for (const group of MUSCLE_GROUPS) {
    const words = friendlyGroupWords(group);
    assert.ok(words && words.trim(), `${group} has an athlete-facing name`);
    assert.doesNotMatch(words, /[_-]/, `${group} never reads as a key: ${words}`);
  }
  assert.equal(friendlyGroupWords("rear delts"), "rear shoulders");
  assert.equal(friendlyGroupWords("forearms"), "grip and forearms");
  assert.equal(friendlyGroupWords("Rear Delts"), "rear shoulders", "free-form casing folds onto the canon");
  assert.equal(plainGroupWords(["quads", "hamstrings"]), "quads and hamstrings");
  assert.equal(plainGroupWords(["quads", "quads"]), "quads", "duplicates collapse");
  assert.equal(plainGroupWords(["quads", "hamstrings", "glutes"], 2), "quads and hamstrings", "capped, not an inventory");
  assert.equal(plainGroupWords([]), null);
});

test("the recovery menu names muscles in plain words, not canonical keys", async () => {
  const { buildRecoveryMenu } = await import("../dist/repo/recovery-menu.js");
  logSets("Rear Delt Fly", "rear delts", REF, 6);
  const menu = buildRecoveryMenu(REF, "rest");
  assert.ok(menu, "a rest day gets a menu");
  const text = JSON.stringify(menu);
  assert.doesNotMatch(text, /rear delts/i, `the canonical key must not reach the athlete: ${text}`);
  assert.match(text, /rear shoulders/i, "it names the muscle the way a person would");
});

test("one definition of a hard effort — the per-muscle read and the day grade share it", async () => {
  const { HARD_EFFORT } = await import("../dist/repo/heavy-load.js");
  // The per-muscle reader used to carry a weaker label pattern that knew nothing
  // of sprints or intervals, so the same logged session read hard to one
  // consumer and moderate to the other.
  for (const label of ["VO2MAX", "vo2 max", "THRESHOLD", "Sprint", "interval", "anaerobic", "tempo", "lactate"]) {
    assert.ok(HARD_EFFORT.label.test(label), `"${label}" names a hard workout`);
  }
  assert.ok(!HARD_EFFORT.label.test("recovery"), "an easy label does not");
  assert.ok(!HARD_EFFORT.label.test("base"), "nor does base work");
});

test("a logged interval session reads hard to the per-muscle model too", () => {
  repo.addActivity({ type: "run", duration_min: 30, date: REF });
  const activity = db.prepare(`SELECT id FROM activities WHERE date = ? ORDER BY id DESC LIMIT 1`).get(REF);
  // garmin_activities.source_id is NOT NULL — seed the source row it points at.
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','test')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, te_label)
     VALUES (?, 'iv1', ?, ?, 'running', 'Intervals', 'INTERVAL')`
  ).run(src.lastInsertRowid, activity.id, REF);
  const impact = recentEnduranceImpacts(3, REF).find((i) => i.label === "run");
  assert.ok(impact);
  assert.equal(impact.intensity, "hard", "the label alone makes it a hard effort");
  assert.equal(impact.load, "heavy");
});
