// "Easy" runs executed at threshold.
//
// The gap this closes: an athlete whose every run finishes a few beats under their
// own threshold has no easy running at all — the hard days never land, the easy days
// never recover — and nothing in the app said so, because "easy" was a LABEL on the
// plan rather than a reading of what the run cost. classifyRunEffort could already
// answer it against the PERSONAL model and had no callers.
//
// The three things these pin: it fires on a genuinely compressed fortnight, it stays
// quiet on a polarized one, and it manufactures nothing at all when the model cannot
// speak — the last being the one that matters most, since a caution invented out of a
// thin model would fire hardest on the athlete Cairn knows least.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import { runIntensityDiscipline, runVarietyRead } from "../dist/repo/run-progression.js";
import { getHrModel } from "../dist/repo/hr-model.js";
import { dayPlanningSignalState, violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  buildUnifiedSignalState,
  signalVoice,
  SIGNAL_VOICE_REGISTRY,
  spokenSignalVoice,
} from "../dist/repo/signal-state.js";
import { renderSignalState } from "../dist/prompt/shared.js";
import { projectCoachContext } from "../dist/prompt/context-projection.js";
import { localDateISO } from "../dist/repo/shared.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";

const REF = "2026-05-15";

function shift(dateISO, days) {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
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
    "activities",
    "checkins",
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
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run(`intensity-${sourceSeq}`)
      .lastInsertRowid
  );
}

let activitySeq = 0;
function logRun({ date, minutes = 40, km = 8, avgHr = 145, maxHr = 172, type = "running" }) {
  activitySeq += 1;
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, date, type, name, duration_min, moving_min, distance_km, avg_hr, max_hr)
     VALUES (?, ?, ?, ?, 'Run', ?, ?, ?, ?, ?)`
  ).run(garminSource(), `intensity-act-${activitySeq}`, date, type, minutes, minutes, km, avgHr, maxHr);
}

// The model basis, deliberately ALL outside the 14-day intensity window so the runs
// under test are the only thing the read is looking at. This is the same athlete the
// HR-model suite is built around: observed max 180, a 54-minute effort at 163 that
// puts threshold at 166, and therefore an easy ceiling (z2_top) of 148 bpm.
function seedModelBasis(anchor) {
  const at = (days) => shift(anchor, -days);
  logRun({ date: at(20), minutes: 54, km: 11, avgHr: 163, maxHr: 179 });
  logRun({ date: at(26), minutes: 30, km: 6, avgHr: 152, maxHr: 180 });
  logRun({ date: at(40), minutes: 28, km: 5.5, avgHr: 147, maxHr: 179 });
  logRun({ date: at(55), minutes: 25, km: 5, avgHr: 143, maxHr: 174 });
  logRun({ date: at(70), minutes: 33, km: 6.5, avgHr: 146, maxHr: 176 });
}

// Four runs inside the window, every one of them at ~95% of this athlete's threshold.
// That is the real complaint: they are all labelled easy and none of them is.
function seedThresholdEasyRuns(anchor) {
  const at = (days) => shift(anchor, -days);
  for (const days of [2, 5, 9, 12]) logRun({ date: at(days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
}

function prescribeEasyRunning() {
  const dayId = Number(
    db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (1, 'Easy run', 'Endurance')`).run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, kind, target_distance_km, target_zone, note)
     VALUES (?, 1, 'cardio', 8, 'Z2', 'Easy aerobic run')`
  ).run(dayId);
}

function loadObservation(state) {
  return (state.dimensions.training_load_tolerance.evidence ?? []).find(
    (item) => item.field === "run_intensity_discipline"
  );
}

// ── the model these tests stand on ───────────────────────────────────────────

test("the fixture athlete's own easy ceiling is 148 bpm, and 158 is not easy", () => {
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);
  const model = getHrModel(REF);
  assert.equal(model.lthr, 166);
  assert.equal(model.zones.z2_top, 148, "the easy ceiling comes from this athlete, not a formula");
  assert.equal(model.confidence, "estimated");
});

// ── the read ─────────────────────────────────────────────────────────────────

test("a fortnight of threshold 'easy' runs reads as compressed, with the numbers behind it", () => {
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);
  prescribeEasyRunning();

  const read = runIntensityDiscipline(REF);
  assert.equal(read.status, "compressed");
  assert.equal(read.window_days, 14);
  assert.equal(read.runs_classified, 4);
  assert.equal(read.easy_count, 0);
  assert.equal(read.above_easy_count, 4);
  assert.equal(read.z2_top, 148);
  assert.equal(read.lthr, 166);
  assert.equal(read.easy_prescribed, true, "the plan does ask for the easy runs that aren't happening");
  // The machine register cites its own evidence rather than asserting a mood.
  assert.match(read.summary, /148 bpm/);
  assert.match(read.summary, /4 of 4/);
  assert.match(read.summary, /none read easy/);
});

test("a mixed week is polarized, not compressed — real easy days are the healthy case", () => {
  seedModelBasis(REF);
  const at = (days) => shift(REF, -days);
  logRun({ date: at(2), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: at(4), minutes: 45, km: 8, avgHr: 144, maxHr: 160 });
  logRun({ date: at(8), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: at(11), minutes: 50, km: 9, avgHr: 141, maxHr: 158 });

  const read = runIntensityDiscipline(REF);
  assert.equal(read.status, "polarized");
  assert.equal(read.easy_count, 2);
  assert.equal(read.above_easy_count, 2);
});

test("one hard run in a thin fortnight is not a pattern", () => {
  seedModelBasis(REF);
  logRun({ date: shift(REF, -3), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: shift(REF, -6), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });

  const read = runIntensityDiscipline(REF);
  assert.equal(read.status, "insufficient", "two runs is a fortnight, not a habit");
  assert.equal(read.runs_classified, 2);
});

test("with no model to read against, the surface stays silent rather than cautious", () => {
  // The runs ARE there and they ARE hard — but nothing has ever recorded a peak, so
  // the personal model reports "insufficient" and there is no ceiling to be above.
  for (const days of [2, 5, 9, 12]) {
    logRun({ date: shift(REF, -days), minutes: 40, km: 8, avgHr: 158, maxHr: null });
  }
  assert.equal(getHrModel(REF).confidence, "insufficient");
  assert.equal(runIntensityDiscipline(REF), null, "absence is neutral, never a caution");

  const state = dayPlanningSignalState(REF);
  assert.equal(loadObservation(state), undefined, "no model, no observation");
});

test("the window holds fourteen days, not fifteen", () => {
  seedModelBasis(REF);
  for (const days of [2, 5, 13]) logRun({ date: shift(REF, -days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: shift(REF, -14), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });

  const read = runIntensityDiscipline(REF);
  assert.equal(read.runs_classified, 3, "day −13 is the oldest day of a 14-day window; day −14 is outside it");
  assert.equal(read.status, "compressed");
});

test("a corrupt strap history is an implausible model, and an implausible model is silence", () => {
  // Three garbage rows put the fallback model's easy ceiling in the single digits.
  // The one thing worse than no caution would be "keep it under 4 bpm" spoken with
  // confidence — an implausible ceiling gets the same answer as no model at all.
  for (const days of [2, 5, 9, 12]) {
    logRun({ date: shift(REF, -days), minutes: 40, km: 8, avgHr: 158, maxHr: 6 });
  }
  const model = getHrModel(REF);
  assert.notEqual(model.confidence, "insufficient", "the model itself is willing to speak…");
  assert.ok(model.zones.z2_top < 100, "…and its ceiling is nonsense");
  assert.equal(runIntensityDiscipline(REF), null, "the read refuses it");
  assert.equal(loadObservation(dayPlanningSignalState(REF)), undefined, "so no caution is manufactured");
});

test("cycling never answers a running question", () => {
  seedModelBasis(REF);
  for (const days of [2, 5, 9, 12]) {
    logRun({ date: shift(REF, -days), minutes: 60, km: 30, avgHr: 158, maxHr: 172, type: "cycling" });
  }
  const read = runIntensityDiscipline(REF);
  assert.equal(read.runs_classified, 0);
  assert.equal(read.status, "insufficient");
});

// ── the signal state ─────────────────────────────────────────────────────────

test("the compressed read reaches the planning state as a caution that overrules nothing", () => {
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);
  prescribeEasyRunning();

  const state = dayPlanningSignalState(REF);
  const obs = loadObservation(state);
  assert.ok(obs, "the observation is in the training-load dimension");
  assert.equal(obs.direction, "caution");
  assert.equal(obs.source, "cairn_hr_model");
  assert.equal(obs.safety_override, undefined, "a pattern about a fortnight may not overrule today");
  assert.equal(obs.summary, runIntensityDiscipline(REF).summary, "one summary, written once");
  assert.equal(obs.voice.key, "run_intensity_compressed");
  assert.equal(obs.voice.subject, "148 bpm");
  assert.equal(state.dimensions.training_load_tolerance.status, "watch");
});

test("alone on a clean board, the caution is VISIBLE and holds nothing — owner ruling 2026-08-17", () => {
  // THIS TEST DELIBERATELY REVERSES THE ONE IT REPLACES.
  //
  // It used to pin the opposite: a compressed fortnight, alone on an otherwise-clean
  // board, counselled holding load and volume everywhere — lifting days included — on
  // the argument that a fortnight of near-threshold easy running is systemic recovery
  // debt. The owner has ruled that too firm for the softest brake this layer can raise.
  // One caution is a finding; it is not a second opinion, and an experienced athlete
  // collects one most weeks, so the softest evidence was producing the firmest ordinary
  // counsel.
  //
  // What is pinned now: the finding still REACHES the athlete in full — the dimension
  // sits at watch, the observation carries its voice and its bpm ceiling, and the read
  // says so — it just no longer stops the week by itself. See the second-opinion bar in
  // planningDirectives (signal-state.ts) and the earn-path branch in the planned-training
  // rule (day-read.ts).
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);
  prescribeEasyRunning();

  const state = dayPlanningSignalState(REF);
  assert.equal(state.dimensions.training_load_tolerance.status, "watch", "the finding is still on the board");
  assert.equal(state.action.directives.training, "proceed", "one caution no longer holds aggression on its own");
  assert.equal(state.action.directives.training_source, null);
  assert.equal(state.action.posture, "train", "counsel, not a gate — the day is still a training day");
});

test("a second watch anywhere is what turns the caution into a hold", () => {
  // The other half of the same ruling: the bar is a SECOND opinion, not the removal of
  // the brake. Built from observations rather than seeded rows so the threshold itself
  // is what is under test — the compressed-fortnight caution is the same one
  // dayPlanningSignalState emits above (training_load_tolerance, direction "caution").
  const caution = (dimension, field) => ({
    dimension,
    field,
    date: REF,
    source: "cairn_test",
    direction: "caution",
    summary: "A caution about this dimension.",
  });
  const intensity = caution("training_load_tolerance", "run_intensity_discipline");

  const alone = buildUnifiedSignalState(REF, [intensity]);
  assert.equal(alone.dimensions.training_load_tolerance.status, "watch");
  assert.equal(alone.action.directives.training, "proceed");

  const seconded = buildUnifiedSignalState(REF, [intensity, caution("recovery_capacity", "sleep_debt")]);
  assert.equal(seconded.action.directives.training, "hold_aggression");
  assert.equal(
    seconded.action.directives.training_source,
    "recovery_capacity",
    "the rung order is unchanged — recovery still names the hold before training load"
  );

  // One dimension CONSTRAINED still decides on its own; the ruling raised the bar for
  // `watch` and left every constrained rung exactly where it was.
  const constrained = buildUnifiedSignalState(REF, [
    { ...caution("energy_fueling", "protein_gap"), direction: "constraint" },
  ]);
  assert.equal(constrained.action.directives.training, "hold_aggression");
  assert.equal(constrained.action.directives.training_source, "energy_fueling");
});

test("a busy calendar is not the second opinion", () => {
  // life_capacity is deliberately excluded from the count: it has never had a hold rung
  // of its own (it drives `schedule`), and counting it would have made the new bar
  // easier to clear than the old one in the cases the ruling is about.
  const caution = (dimension, field) => ({
    dimension,
    field,
    date: REF,
    source: "cairn_test",
    direction: "caution",
    summary: "A caution about this dimension.",
  });
  const state = buildUnifiedSignalState(REF, [
    caution("training_load_tolerance", "run_intensity_discipline"),
    caution("life_capacity", "commitment"),
  ]);
  assert.equal(state.dimensions.life_capacity.status, "watch");
  assert.equal(state.action.directives.schedule, "compress", "it still governs the clock");
  assert.equal(state.action.directives.training, "proceed", "…and still not the training day");
});

test("a polarized fortnight puts no row in the state at all", () => {
  seedModelBasis(REF);
  const at = (days) => shift(REF, -days);
  logRun({ date: at(2), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: at(4), minutes: 45, km: 8, avgHr: 144, maxHr: 160 });
  logRun({ date: at(8), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  logRun({ date: at(11), minutes: 50, km: 9, avgHr: 141, maxHr: 158 });

  assert.equal(runIntensityDiscipline(REF).status, "polarized");
  assert.equal(loadObservation(dayPlanningSignalState(REF)), undefined, "absence, not a reassuring row");
});

test("the evidence prose reaches the prompt the coach actually reads", () => {
  const today = localDateISO();
  seedModelBasis(today);
  seedThresholdEasyRuns(today);

  const state = dayPlanningSignalState(today);
  const summary = runIntensityDiscipline(today).summary;
  const projected = projectCoachContext({ signal_state: state, now: { date: today } }, "day_read");
  assert.ok(Object.hasOwn(projected, "signal_state"), "the Brief's site carries the signal state");
  const rendered = renderSignalState(projected);
  assert.ok(rendered.includes(summary), `the training-load line carries the finding:\n${rendered}`);
});

// ── the athlete's voice ──────────────────────────────────────────────────────

test("the athlete hears a suggestion in bpm, and hears a different one tomorrow", () => {
  const entry = SIGNAL_VOICE_REGISTRY.run_intensity_compressed;
  assert.ok(entry, "the voice is registered with the rest of the vocabulary");
  assert.ok(entry.variants.length >= 4, "a stable finding repeats daily; it needs a rotation");
  assert.equal(new Set(entry.variants).size, entry.variants.length, "no duplicate phrasing");
  for (const variant of entry.variants) {
    assert.equal(violatesReadingGrammar(variant), null, `breaks the reading grammar: ${variant}`);
    assert.match(variant, entry.concept, `drifted off the concept: ${variant}`);
    assert.doesNotMatch(variant, /\bthe athlete\b/i, "speaks to the athlete, not about them");
    assert.doesNotMatch(variant, /\byou (?:must|have to|need to)\b/i, "a suggestion, never a gate");
  }

  const spoken = signalVoice({ key: "run_intensity_compressed", subject: "148 bpm" });
  for (const line of spoken) {
    assert.match(line, /148 bpm/, "the ceiling is a measurement, and it is what makes this actionable");
    assert.equal(violatesReadingGrammar(line), null, `breaks the reading grammar once rendered: ${line}`);
  }

  const ref = { key: "run_intensity_compressed", subject: "148 bpm" };
  const seen = [];
  for (let back = 4; back >= 0; back--) {
    const date = shift(REF, -back);
    const line = spokenSignalVoice(ref, date, "signal_state:run_intensity");
    assert.ok(spoken.includes(line), `unexpected wording ${JSON.stringify(line)}`);
    seen.push(line);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], "the same finding printed the same sentence two days running");
  }
  assert.ok(new Set(seen).size >= 3, "five days must not cycle through two sentences");
});

// ── the weekly read / insight reach ──────────────────────────────────────────

test("run_variety carries the intensity balance, which is how the weekly read sees it", () => {
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);

  const variety = runVarietyRead(REF);
  assert.ok(variety, "a compressed balance ships even with no variety finding");
  assert.equal(variety.note, "", "and it invents no variety nudge to carry itself");
  assert.deepEqual(variety.intensity_balance, {
    status: "compressed",
    window_days: 14,
    runs_classified: 4,
    easy_count: 0,
    above_easy_count: 4,
    z2_top: 148,
  });

  // …and it reaches the two sites the endurance bundle serves, on the existing key.
  for (const site of ["weekly_read", "insight"]) {
    const projected = projectCoachContext({ run_variety: variety, now: { date: REF } }, site);
    assert.equal(projected.run_variety.intensity_balance.status, "compressed", `${site} carries the balance`);
  }
});

test("the signal state and run_variety are two views of one computation, not two computations", () => {
  // A run logged mid-request must not hand the weekly read a different fortnight
  // than the Brief just spoke about. Both consumers go through the same memo key,
  // so within one snapshot they agree even when the underlying table has moved.
  seedModelBasis(REF);
  seedThresholdEasyRuns(REF);

  // The memo lives in the request-scoped brain snapshot — the same scope
  // getCoachContext builds both views inside. Outside a scope every call computes
  // fresh, which is why this whole test runs within one.
  runWithBrainSnapshot(() => {
    assert.ok(loadObservation(dayPlanningSignalState(REF)), "the Brief's view is built first");
    // An easy run lands mid-snapshot (raw insert: nothing invalidates the memo)…
    logRun({ date: shift(REF, -1), minutes: 45, km: 8, avgHr: 140, maxHr: 158 });
    // …a fresh unmemoized read would now say "polarized, 5 runs, one of them easy"…
    const fresh = runIntensityDiscipline(REF);
    assert.equal(fresh.status, "polarized");
    assert.equal(fresh.runs_classified, 5);
    // …but run_variety still carries the fortnight the signal state was built from.
    const balance = runVarietyRead(REF).intensity_balance;
    assert.equal(balance.status, "compressed", "same snapshot, same answer");
    assert.equal(balance.runs_classified, 4);
  });
});

test("a thin history still returns nothing at all", () => {
  assert.equal(runVarietyRead(REF), null, "no model and no runs is silence, not an empty finding");
});

// ── the projection boundary the HR model owns ────────────────────────────────

test("this read ships its own numbers and does not widen hr_model's two sites", () => {
  const ctx = { hr_model: { available: true, lthr: 166 }, now: { date: REF } };
  for (const site of ["weekly_read", "insight", "coach", "meal_plan", "health_review", "daily_composition"]) {
    assert.ok(!Object.hasOwn(projectCoachContext(ctx, site), "hr_model"), `${site} still does not carry hr_model`);
  }
});

// ── the CHRONIC read (round W3.4, rule 3) ────────────────────────────────────
//
// The acute `compressed` status is absolute — a fortnight in which NOTHING read
// easy. It misses the far commoner shape: the occasional genuine easy run survives
// while most of the easy days creep above the ceiling. These pin the proportional
// read that catches it, and the floor that keeps it from firing on a normal
// polarized block.

// Easy at −2 and −5 keeps the ACUTE window polarized, so the chronic finding is the
// only thing that can speak. Seven hot runs spread across three weeks (plus the
// day −20 threshold effort the model basis itself contributes) put the majority
// above the ceiling.
function seedChronicDrift(anchor) {
  const at = (days) => shift(anchor, -days);
  for (const days of [2, 5]) logRun({ date: at(days), minutes: 45, km: 8, avgHr: 144, maxHr: 160 });
  for (const days of [1, 3, 6, 9, 12, 16, 19]) logRun({ date: at(days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
}

test("a three-week majority above the easy ceiling reads as chronic drift", () => {
  seedModelBasis(REF);
  seedChronicDrift(REF);

  const read = runIntensityDiscipline(REF);
  assert.equal(read.status, "polarized", "real easy runs exist, so the acute read is not compressed");
  assert.ok(read.chronic, "the wider window cleared its own sample floor");
  assert.equal(read.chronic.window_days, 21);
  assert.equal(read.chronic.drifting, true);
  assert.ok(
    read.chronic.above_easy_count * 2 > read.chronic.runs_classified,
    "the finding is a strict majority, not a count"
  );
  assert.match(read.chronic_summary, /148 bpm/);
  assert.match(read.chronic_summary, /21 days/);
});

test("three hot runs inside a large easy block is a polarized month, not a compressed one", () => {
  seedModelBasis(REF);
  const at = (days) => shift(REF, -days);
  for (const days of [1, 4, 7]) logRun({ date: at(days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  for (const days of [2, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    logRun({ date: at(days), minutes: 45, km: 8, avgHr: 144, maxHr: 160 });

  const read = runIntensityDiscipline(REF);
  assert.ok(read.chronic, "there is plenty of data — this is a judgement, not an absence");
  assert.equal(read.chronic.drifting, false, "a handful of hard days in a big easy block is the healthy shape");
  assert.equal(read.chronic_summary, null);
  assert.equal(
    loadObservation(dayPlanningSignalState(REF)),
    undefined,
    "and nothing at all reaches the signal state"
  );
});

test("below the chronic sample floor the wider window says nothing", () => {
  seedModelBasis(REF);
  const at = (days) => shift(REF, -days);
  // Four classified runs inside the window (the model basis contributes a fifth at
  // day −20), every one of them hot — a clean majority, and still under the six-run
  // floor. Absence is neutral here exactly as it is for the acute read.
  for (const days of [2, 6, 10, 15]) logRun({ date: at(days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });
  const read = runIntensityDiscipline(REF);
  assert.equal(read.chronic, null);
  assert.equal(read.chronic_summary, null);
});

test("the chronic observation is advisory: visible at watch, unable to move the day", () => {
  seedModelBasis(REF);
  seedChronicDrift(REF);
  prescribeEasyRunning();

  const state = dayPlanningSignalState(REF);
  const obs = loadObservation(state);
  assert.ok(obs, "the finding reaches the planning state");
  assert.equal(obs.direction, "caution");
  assert.equal(obs.advisory_brake, true, "a discipline finding about one lane may not decide what today is");
  assert.equal(obs.voice.key, "run_intensity_chronic_drift");
  assert.equal(obs.voice.subject, "148 bpm");
  assert.equal(obs.summary, runIntensityDiscipline(REF).chronic_summary, "one summary, written once");
  assert.equal(state.dimensions.training_load_tolerance.status, "watch", "it IS visible");
  assert.notEqual(
    state.dimensions.training_load_tolerance.deciding.status,
    "watch",
    "and the posture ladder reads past it"
  );
  assert.equal(state.action.posture, "train");
  assert.equal(state.action.directives.training, "proceed", "it may hold the reach back; it may not hold the day");
});

test("the acute compressed read still owns the surface when both would fire", () => {
  seedModelBasis(REF);
  // Every run hot, across three weeks: compressed AND drifting. One observation, and
  // it is the sharper claim — two rows about one lane would be the same finding twice.
  const at = (days) => shift(REF, -days);
  for (const days of [1, 3, 6, 9, 12, 16, 19]) logRun({ date: at(days), minutes: 40, km: 8, avgHr: 158, maxHr: 172 });

  const read = runIntensityDiscipline(REF);
  assert.equal(read.status, "compressed");
  assert.equal(read.chronic.drifting, true);

  const evidence = (dayPlanningSignalState(REF).dimensions.training_load_tolerance.evidence ?? []).filter(
    (item) => item.field === "run_intensity_discipline"
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].voice.key, "run_intensity_compressed");
});

test("the chronic voice speaks the athlete's own ceiling and clears the reading grammar", () => {
  for (const variant of SIGNAL_VOICE_REGISTRY.run_intensity_chronic_drift.variants) {
    assert.equal(violatesReadingGrammar(variant), null, `chronic drift voice: ${variant}`);
  }
  const spoken = spokenSignalVoice({ key: "run_intensity_chronic_drift", subject: "148 bpm" }, REF, "chronic");
  assert.match(spoken, /148 bpm/);
  assert.doesNotMatch(spoken, /\bevery run\b|\bnothing\b/i, "some easy running survives — the words may not deny it");
});
