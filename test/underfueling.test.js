import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { armAnd, energyDeficiencyDecision } from "../dist/repo/energy-deficiency.js";

const TODAY = "2026-07-15";
const day = (delta) => addDaysISO(TODAY, delta);

beforeEach(() => {
  resetTables(
    "nutrition_targets",
    "food_notes",
    "fueling_feedback",
    "checkins",
    "logged_sets",
    "sessions",
    "body_measurements"
  );
});

function target(kcal, delta = -30) {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, carbs_g, fat_g, source)
     VALUES (?, ?, 175, 240, 70, 'test')`
  ).run(day(delta), kcal);
}

function intake(delta, kcal) {
  for (const [meal, share] of [
    ["breakfast", 0.45],
    ["dinner", 0.55],
  ]) {
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status)
       VALUES (?, ?, '', ?, NULL)`
    ).run(day(delta), meal, JSON.stringify({ kcal: Math.round(kcal * share), protein_g: 60 }));
  }
}

function lowFeedback(delta) {
  db.prepare(`INSERT INTO fueling_feedback (date, energy, hunger) VALUES (?, 1, 3)`).run(day(delta));
}

function lowSession(delta) {
  db.prepare(`INSERT INTO sessions (date, performance, soreness, finished_at) VALUES (?, 2, 4, datetime('now'))`).run(
    day(delta)
  );
}

const stableProgram = {
  lifts: [
    { exercise: "Bench", status: "progressing" },
    { exercise: "Squat", status: "progressing" },
  ],
  mesocycle: { acute_chronic_ratio: 1.0 },
  hybrid: null,
};

const strainedProgram = {
  lifts: [
    { exercise: "Bench", status: "regressing" },
    { exercise: "Squat", status: "regressing" },
  ],
  mesocycle: { acute_chronic_ratio: 1.1 },
  hybrid: null,
};

const stableWhole = {
  domains: [{ domain: "recovery_wellbeing", verdict: "holding", evidence_keys: ["recovery:stable"] }],
};
const strainedWhole = {
  domains: [
    { domain: "strength", verdict: "worse", evidence_keys: ["strength:down"] },
    { domain: "recovery_wellbeing", verdict: "worse", evidence_keys: ["recovery:down"] },
  ],
};

const onPathExp = {
  trend_lb_wk: -0.55,
  confidence: "high",
  window_days: 21,
  coverage: { weigh_in_days: 12 },
  tdee: 2600,
};
const fastExp = { trend_lb_wk: -1.5, confidence: "high", window_days: 21, coverage: { weigh_in_days: 12 }, tdee: 2650 };
const goal = { leanness_rate: { lean_ideal_rate_lb: 0.6, safe_max_rate_lb: 0.85 } };

test("completed-day intake keeps missing days unknown and treats a +/-100 kcal diary difference as deadband", () => {
  target(2200);
  intake(-1, 2100);
  intake(-2, 2100);
  intake(-3, 2100);
  const read = underfuelingRead(TODAY, {
    expenditure: onPathExp,
    goal,
    programState: stableProgram,
    wholePerson: stableWhole,
  });
  assert.equal(read.state, "near_target");
  assert.equal(read.intake.compared_days, 3);
  assert.equal(read.intake.near_target_days, 3);
  assert.equal(read.uncertainty.missing_food_days, 11, "unlogged days remain unknown rather than becoming zero intake");
  assert.ok(read.uncertainty.deadband_kcal >= 225);
});

test("a materially low diary alone never changes the prescription", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4]) intake(delta, 1750);
  const read = underfuelingRead(TODAY, { expenditure: null, goal, programState: null, wholePerson: null });
  assert.equal(read.state, "uncertain");
  assert.equal(read.action.kind, "hold");
  assert.deepEqual(read.agreeing_channels, ["logged_intake"]);
});

test("low logs plus an on-path weight trend and progressing lifts holds with explicit conflict", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4]) intake(delta, 1750);
  const read = underfuelingRead(TODAY, {
    expenditure: onPathExp,
    goal,
    programState: stableProgram,
    wholePerson: stableWhole,
  });
  assert.equal(read.state, "uncertain");
  assert.equal(read.action.kind, "hold");
  assert.ok(read.conflicting_channels.includes("weight_trend"));
  assert.ok(read.conflicting_channels.includes("performance"));
});

test("near-target logs plus fast loss and weakening performance/recovery classifies prescription strain", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-1);
  lowSession(-2);
  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(read.state, "prescription_strain");
  assert.equal(read.action.kind, "raise_target");
  assert.ok(read.action.kcal_delta >= 100 && read.action.kcal_delta <= 250);
  assert.ok(read.agreeing_channels.includes("weight_trend"));
  assert.ok(read.agreeing_channels.includes("performance"));
  assert.ok(read.agreeing_channels.includes("recovery"));
});

test("repeated low felt energy corroborates a logged execution gap without raising calories", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4]) intake(delta, 1750);
  lowFeedback(-1);
  lowFeedback(-2);
  const read = underfuelingRead(TODAY, { expenditure: null, goal, programState: null, wholePerson: null });
  assert.equal(read.state, "execution_gap");
  assert.equal(read.action.kind, "reshape_meals");
  assert.equal(read.action.kcal_delta, 0);
});

test("one noisy day and one tape measurement are inert", () => {
  target(2200);
  intake(-1, 1500);
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 34, 'manual')`).run(day(-1));
  lowFeedback(-1);
  const read = underfuelingRead(TODAY, { expenditure: null, goal, programState: null, wholePerson: null });
  assert.equal(read.state, "insufficient_signal");
  assert.equal(read.channels.find((channel) => channel.key === "body_trend").direction, "unknown");
  assert.equal(read.action.kind, "collect_signal");
});

test("mood-only and legacy nullable check-ins stay unknown instead of fabricating energy or recovery strain", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  const moodOnly = repo.addCheckin(day(-1), { mood: 2 });
  assert.equal(moodOnly.energy, null);
  assert.equal(moodOnly.sleep_feel, null);
  assert.equal(moodOnly.soreness, null);
  db.prepare(
    `INSERT INTO checkins (date, mood, energy, sleep_feel, soreness, note)
     VALUES (?, 3, NULL, NULL, NULL, 'legacy nullable row')`
  ).run(day(-2));
  db.prepare(
    `INSERT INTO fueling_feedback (date, energy, hunger, note)
     VALUES (?, NULL, NULL, 'legacy nullable row')`
  ).run(day(-3));

  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: null,
    wholePerson: null,
  });
  assert.equal(read.channels.find((channel) => channel.key === "felt_energy").direction, "unknown");
  assert.equal(read.channels.find((channel) => channel.key === "recovery").direction, "unknown");
  assert.notEqual(read.state, "prescription_strain");
  assert.notEqual(read.action.kind, "raise_target");
});

test("a recent upward correction settles for seven days without a second calorie move", () => {
  target(2050, -30);
  target(2200, -3);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-1);
  lowSession(-2);
  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(read.state, "settling");
  assert.equal(read.action.kind, "settle");
  assert.equal(read.action.kcal_delta, 0);
});

test("persistent multi-channel strain after settling calls for a coordinated recovery package", () => {
  target(2050, -30);
  target(2200, -8);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-1);
  lowSession(-2);
  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(read.state, "persistent_strain");
  assert.equal(read.action.kind, "recovery_package");
  assert.equal(read.action.training, "reduce");
});

test("pre-correction athlete strain plus aggregate corroboration cannot trigger another fuel escalation", () => {
  target(2050, -30);
  target(2200, -8);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-9);
  lowSession(-10);

  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(read.state, "uncertain");
  assert.equal(read.action.kind, "hold");
  assert.match(read.rationale, /predates the current correction|aggregate history/i);
  assert.ok(!read.evidence_keys.some((key) => /post-correction-low/.test(key)));
});

test("same-day feedback cannot prove persistence, while a later dated response plus corroboration can", () => {
  target(2050, -30);
  target(2200, -8);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-8);

  const sameDay = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(sameDay.state, "uncertain");
  assert.equal(sameDay.action.kind, "hold");
  assert.ok(!sameDay.evidence_keys.some((key) => /post-correction-low/.test(key)));

  lowSession(-7);
  const later = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(later.state, "persistent_strain");
  assert.equal(later.action.kind, "recovery_package");
  assert.ok(later.evidence_keys.some((key) => /sessions\.(performance|recovery):2026-07-08:post-correction-low/.test(key)));
});

test("weight plus waist plus workload stays one outcome family and cannot autonomously escalate", () => {
  target(2050, -30);
  target(2200, -8);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 36, 'manual')`).run(day(-21));
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 35.5, 'manual')`).run(day(-11));
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 35, 'manual')`).run(day(-1));
  const highWorkload = {
    lifts: [],
    mesocycle: { acute_chronic_ratio: 1.7 },
    hybrid: { status: "fuel-protect", fuel: { risk: "high" } },
  };

  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: highWorkload,
    wholePerson: stableWhole,
  });
  assert.equal(read.channels.find((channel) => channel.key === "weight_trend").direction, "strain");
  assert.equal(read.channels.find((channel) => channel.key === "body_trend").direction, "strain");
  assert.equal(read.channels.find((channel) => channel.key === "workload").direction, "strain");
  assert.equal(read.state, "near_target");
  assert.equal(read.action.kind, "hold");
});

test("fresh athlete response plus an energy-balance outcome can escalate after settling", () => {
  target(2050, -30);
  target(2200, -8);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  lowSession(-1);
  lowSession(-2);

  const read = underfuelingRead(TODAY, {
    expenditure: fastExp,
    goal,
    programState: stableProgram,
    wholePerson: stableWhole,
  });
  assert.equal(read.state, "persistent_strain");
  assert.equal(read.action.kind, "recovery_package");
  assert.ok(
    read.evidence_keys.some((key) => /sessions\.(performance|recovery):2026-07-1[34]:post-correction-low/.test(key)),
    "the escalation is explicitly anchored to a dated response after the correction took effect"
  );
});

// ── PART 4a: an endurance-strain path feeds the same performance channel ──────────
const perfChannel = (read) => read.channels.find((c) => c.key === "performance");

test("run pace decline while weekly volume held flags the performance channel as strain", () => {
  target(2200);
  // prior ~14d: 3 runs @ 5.0 min/km (10 km in 50 min); recent ~14d: 3 runs @ 5.6 min/km
  // (10 km in 56 min) — volume held (~30 km each half), pace materially slower.
  for (const d of [-15, -18, -21]) repo.addActivity({ type: "run", distance_km: 10, duration_min: 50, date: day(d) });
  for (const d of [-3, -6, -9]) repo.addActivity({ type: "run", distance_km: 10, duration_min: 56, date: day(d) });
  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  const perf = perfChannel(read);
  assert.equal(perf.direction, "strain", "endurance output decline strains the performance channel");
  assert.match(perf.summary, /endurance|pace/i);
  assert.ok(perf.evidence_keys.some((k) => /run_pace_decline/.test(k)), "the strain cites the pace-decline evidence");
});

test("stable run pace at held volume does NOT strain the performance channel", () => {
  target(2200);
  for (const d of [-15, -18, -21, -3, -6, -9]) repo.addActivity({ type: "run", distance_km: 10, duration_min: 50, date: day(d) });
  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  assert.notEqual(perfChannel(read).direction, "strain", "steady endurance output raises no fuel alarm");
});

test("a taper (dropped volume) is not misread as endurance strain even when pace slips", () => {
  target(2200);
  for (const d of [-15, -18, -21]) repo.addActivity({ type: "run", distance_km: 10, duration_min: 50, date: day(d) }); // prior ~30 km
  for (const d of [-4, -7]) repo.addActivity({ type: "run", distance_km: 5, duration_min: 30, date: day(d) }); // recent ~10 km, slower
  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  assert.notEqual(perfChannel(read).direction, "strain", "a genuine ease/taper is not blamed as under-fuelling");
});

// ── PART 4a fix round: the run-compliance drop is adherence-neutral — it needs ≥2 real
// outings in EACH week, so a thin/busy fortnight never reads as strain.
test("a thin run week (1 outing under plan, both weeks) does NOT read as endurance strain", () => {
  target(2200);
  repo.savePlanDay(1, "Run", "Easy run", [{ exercise: "Easy run", kind: "cardio", target_distance_km: 20, target_duration_min: 100 }]);
  // 1 short run this week + 1 last week, both well under plan — a thin week, not strain.
  repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(-1) }); // this week (Mon 07-13..)
  repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(-8) }); // last week
  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  assert.notEqual(perfChannel(read).direction, "strain", "a thin logging week lowers confidence, never signals");
});

test("a sustained 2-outings-each shortfall still fires the compliance-drop strain", () => {
  target(2200);
  repo.savePlanDay(1, "Run", "Easy run", [{ exercise: "Easy run", kind: "cardio", target_distance_km: 40, target_duration_min: 200 }]);
  // 2 short runs each week, both far under the 40 km plan (<60%) — a genuine shortfall.
  for (const d of [-1, -2]) repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(d) }); // this week
  for (const d of [-8, -9]) repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(d) }); // last week
  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  const perf = perfChannel(read);
  assert.equal(perf.direction, "strain");
  assert.ok(perf.evidence_keys.some((k) => /run_compliance_drop/.test(k)), "cites the compliance-drop evidence");
});

// The plan template carries no dates, so BOTH weeks are otherwise judged against
// whatever is on the plan right now. A run plan the machine applied weeks ago is a
// fossil: the athlete never agreed to it for either of these weeks, and quoting it
// turns real training into a sustained shortfall and pushes a strain signal into
// nutrition. A prescription that cannot vouch for the week it is judging reads as
// absent, exactly as a stale sensor reading does.
test("a fossilized applied run plan cannot fire the compliance-drop strain", () => {
  target(2200);
  repo.savePlanDay(1, "Run", "Easy run", [{ exercise: "Easy run", kind: "cardio", target_distance_km: 40, target_duration_min: 200 }]);
  // The same shortfall shape that fires above...
  for (const d of [-1, -2]) repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(d) });
  for (const d of [-8, -9]) repo.addActivity({ type: "run", distance_km: 4, duration_min: 24, date: day(d) });
  // ...but the 40 km week was machine-applied a month before either week began.
  const proposal = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  repo.setProposalStatus(Number(proposal.id), "applied");
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(`${day(-30)} 06:00:00`, Number(proposal.id));

  const read = underfuelingRead(TODAY, { expenditure: onPathExp, goal, programState: stableProgram, wholePerson: stableWhole });
  const perf = perfChannel(read);
  assert.ok(
    !perf.evidence_keys.some((k) => /run_compliance_drop/.test(k)),
    "a fossil prescription never gets to say the athlete fell short"
  );
  assert.notEqual(perf.direction, "strain");
});

// ---------------------------------------------------------------------------
// THE LOW-ENERGY-AVAILABILITY WATCH (src/repo/energy-deficiency.ts)
//
// Five arms, each tri-state, over signals the athlete is already producing. Two of
// them have to agree, and to have been agreeing for a week and a half, before the
// only response this watch can produce — one bounded step of the calorie target back
// toward MEASURED maintenance — is available at all.

const arm = (key, verdict) => ({ key, verdict, summary: `${key}:${verdict}`, evidence_keys: [] });
const ALL_ABSENT = [
  arm("recovery_and_performance", "absent"),
  arm("loss_pace", "absent"),
  arm("mood_energy", "absent"),
  arm("illness_recurrence", "absent"),
  arm("lift_stall", "absent"),
];
function armsWith(met, notMet = []) {
  return ALL_ABSENT.map((entry) =>
    met.includes(entry.key) ? arm(entry.key, "met") : notMet.includes(entry.key) ? arm(entry.key, "not_met") : entry
  );
}
const CUT = {
  as_of: TODAY,
  cut_active: true,
  tdee_kcal: 2600,
  tdee_basis: "logged_reality",
  active_target_kcal: 2200,
};

test("an arm's tri-state: absent is never met, and one definite no settles the conjunction", () => {
  assert.equal(armAnd("met", "met"), "met");
  assert.equal(armAnd("met", "absent"), "absent", "an unanswerable half leaves the arm absent, never true");
  assert.equal(armAnd("not_met", "absent"), "not_met", "one channel has already answered the question");
  assert.equal(armAnd("absent", "absent"), "absent");
});

test("one arm buys nothing, and two that only just agreed are 'emerging', not a cluster", () => {
  const single = energyDeficiencyDecision({
    ...CUT,
    arms: armsWith(["loss_pace"], ["mood_energy", "lift_stall"]),
    arms_before: armsWith([]),
  });
  assert.equal(single.state, "clear");
  assert.equal(single.protection.raise, false);

  // Nothing readable at all is its own answer, and it is not "clear" either.
  const blind = energyDeficiencyDecision({ ...CUT, arms: armsWith([]), arms_before: armsWith([]) });
  assert.equal(blind.state, "insufficient_signal");
  assert.equal(blind.protection.raise, false);

  const fresh = energyDeficiencyDecision({
    ...CUT,
    arms: armsWith(["loss_pace", "mood_energy"]),
    arms_before: armsWith([]),
  });
  assert.equal(fresh.state, "emerging", "the cluster has not been standing long enough to act on");
  assert.equal(fresh.protection.raise, false);
  assert.equal(fresh.sustained, false);
});

test("two arms held for the sustain window buy ONE bounded step, capped at measured maintenance", () => {
  const met = ["loss_pace", "mood_energy"];
  const read = energyDeficiencyDecision({ ...CUT, arms: armsWith(met), arms_before: armsWith(met) });
  assert.equal(read.state, "sustained_cluster");
  assert.equal(read.sustained, true);
  assert.deepEqual(read.met_keys, met);
  assert.equal(read.protection.raise, true);
  assert.equal(read.protection.target_kcal, 2450, "the bounded 250 kcal ceiling, not the whole 400 kcal gap");
  assert.ok(read.protection.target_kcal <= CUT.tdee_kcal, "protection buys maintenance, never a surplus");

  // …and when maintenance is closer than the step, the cap — not the step — decides.
  const near = energyDeficiencyDecision({
    ...CUT,
    active_target_kcal: 2500,
    arms: armsWith(met),
    arms_before: armsWith(met),
  });
  assert.equal(near.protection.raise, true);
  assert.equal(near.protection.target_kcal, 2600, "the step lands exactly on measured maintenance");

  // And once the target is inside a meaningful step of maintenance, the cap binds and
  // there is nothing left for protection to buy — a hold, never a cut nobody asked for.
  const atCeiling = energyDeficiencyDecision({
    ...CUT,
    active_target_kcal: 2550,
    arms: armsWith(met),
    arms_before: armsWith(met),
  });
  assert.equal(atCeiling.protection.capped, true);
  assert.equal(atCeiling.protection.raise, false);
  assert.equal(atCeiling.protection.target_kcal, null);
});

test("a formula-estimate maintenance is not headroom — the same standing cluster buys no raise", () => {
  const met = ["loss_pace", "mood_energy"];
  const read = energyDeficiencyDecision({
    ...CUT,
    tdee_basis: "formula_estimate",
    arms: armsWith(met),
    arms_before: armsWith(met),
  });
  assert.equal(read.state, "sustained_cluster", "the pattern is still real");
  assert.equal(read.protection.raise, false, "but an unmeasured maintenance can authorize nothing");
  assert.match(read.protection.reason, /estimate rather than a measurement/i);
});

test("the exit is the ordinary path: arms recover, the watch goes quiet, nothing special resumes the cut", () => {
  const met = ["loss_pace", "mood_energy"];
  const recovered = energyDeficiencyDecision({
    ...CUT,
    arms: armsWith([], met),
    arms_before: armsWith(met),
  });
  assert.equal(recovered.state, "clear");
  assert.equal(recovered.protection.raise, false);

  // And with no affirmed deficit running there is nothing to read in the first place.
  const noCut = energyDeficiencyDecision({ ...CUT, cut_active: false, arms: armsWith(met), arms_before: armsWith(met) });
  assert.equal(noCut.state, "not_watching");
  assert.equal(noCut.protection.raise, false);
});

test("the arms read absent off an empty record, and only a real double drift makes one met", () => {
  resetTables("daily_metrics", "garmin_daily_metrics", "sessions", "checkins", "context_events");
  for (const entry of repo.energyDeficiencyArms(TODAY)) {
    assert.equal(entry.verdict, "absent", `${entry.key} says nothing off an empty record`);
  }

  // HRV drifting below its own norm AND rated sessions falling: the conjunction.
  const hrv = (delta, ms) =>
    db.prepare(`INSERT INTO daily_metrics (source, date, hrv_ms) VALUES ('apple', ?, ?)`).run(day(delta), ms);
  for (let d = 34; d >= 7; d--) hrv(-d, 70);
  for (let d = 6; d >= 0; d--) hrv(-d, 55);
  const rate = (delta, value) =>
    db.prepare(`INSERT INTO sessions (date, performance) VALUES (?, ?)`).run(day(delta), value);
  for (const d of [-27, -24, -20, -17]) rate(d, 4);
  for (const d of [-10, -7, -4, -1]) rate(d, 2);
  const met = repo.energyDeficiencyArms(TODAY).find((entry) => entry.key === "recovery_and_performance");
  assert.equal(met.verdict, "met");
  assert.ok(met.evidence_keys.length >= 2, "it cites both halves");

  // Hold HRV steady and the SAME session ratings can no longer carry the arm.
  db.prepare(`DELETE FROM daily_metrics WHERE date >= ?`).run(day(-6));
  for (let d = 6; d >= 0; d--) hrv(-d, 70);
  assert.equal(
    repo.energyDeficiencyArms(TODAY).find((entry) => entry.key === "recovery_and_performance").verdict,
    "not_met"
  );
});
