import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { armAnd, energyDeficiencyDecision } from "../dist/repo/energy-deficiency.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  countComparableDoseShortfallSessions,
  sessionLogContradictsLowRating,
} from "../dist/repo/session-dose-log.js";

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
    "body_measurements",
    "daily_session_outcomes",
    "daily_session_compositions",
    "exercises"
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

function linkComparableDose(sessionId, date, { comparable = true, verdict = "met", prescribedSets = 3, achievedSets = 3 } = {}) {
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Dose fixture', ?, ?)`
    )
    .run(sessionId, date, JSON.stringify([{ exercise: "Back Squat", sets: prescribedSets }]), `dose-${sessionId}`);
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(
    composition.lastInsertRowid,
    sessionId,
    date,
    JSON.stringify({
      schema_version: 3,
      dose_evidence: [
        {
          exercise: "Back Squat",
          comparable,
          prescribed: { sets: prescribedSets },
          achieved: { sets: achievedSets },
          challenge_verdict: verdict,
        },
      ],
    })
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
  assert.equal(read.action.training, "hold_aggression", "measured scale strain is decision-grade for training");
  assert.ok(read.agreeing_channels.includes("weight_trend"));
  assert.ok(read.agreeing_channels.includes("performance"));
  assert.ok(read.agreeing_channels.includes("recovery"));
});

test("waist strain plus felt/perf with the diary near target raises calories but does not hold training", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 36, 'manual')`).run(day(-21));
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 35.5, 'manual')`).run(day(-11));
  db.prepare(`INSERT INTO body_measurements (date, waist_in, source) VALUES (?, 35, 'manual')`).run(day(-1));
  lowSession(-1);
  lowSession(-2);
  const read = underfuelingRead(TODAY, {
    expenditure: onPathExp,
    goal,
    programState: strainedProgram,
    wholePerson: strainedWhole,
  });
  assert.equal(read.state, "prescription_strain");
  assert.equal(read.action.kind, "raise_target");
  assert.ok(read.action.kcal_delta >= 100 && read.action.kcal_delta <= 250, "the nutrition half is unchanged");
  assert.equal(read.channels.find((channel) => channel.key === "body_trend").direction, "strain");
  assert.notEqual(read.channels.find((channel) => channel.key === "weight_trend").direction, "strain");
  assert.equal(
    read.action.training,
    "proceed",
    "waist plus felt strain is not decision-grade for a training hold"
  );
});

test("a logged shortfall still holds training aggression even without a scale trend", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4]) intake(delta, 1750);
  lowSession(-1);
  lowSession(-2);
  const read = underfuelingRead(TODAY, { expenditure: null, goal, programState: null, wholePerson: null });
  assert.equal(read.state, "execution_gap");
  assert.equal(read.action.kind, "reshape_meals");
  assert.equal(read.action.kcal_delta, 0);
  assert.equal(read.action.training, "hold_aggression", "the diary shortfall is decision-grade");
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

test("the watch's athlete-facing prose is a variant set that obeys the reading grammar", () => {
  const pool = repo.energyDeficiencyGrammarPool();
  assert.ok(pool.length >= 3, "a rotating set, never one literal printed for weeks");
  for (const phrase of pool) {
    assert.equal(violatesReadingGrammar(phrase), null, `reading grammar: ${phrase}`);
    assert.doesNotMatch(phrase, /REDs|relative energy deficiency|syndrome|deficiency|\b\d{1,3}\s*(?:\/|out of)\s*\d{1,3}\b/i);
  }
  // The rotation is keyed on the day, so two consecutive days do not repeat.
  const read = energyDeficiencyDecision({ ...CUT, arms: armsWith([]), arms_before: armsWith([]) });
  const said = new Set([TODAY, day(1), day(2), day(3)].map((date) => repo.energyDeficiencyBody(read, date)));
  assert.ok(said.size > 1, "the sentence moves with the day");
});

// An arm that is on every day is worse than no arm: in a two-of-five cluster it
// quietly lowers the whole watch to "any one other arm". The first draft of this one
// fired on 21 of 21 evaluable days on a real record, because the drift bar it used
// sizes a meaningful move of a multi-day AVERAGE (about one standard deviation of a
// single night) and because a 2-day splitter counted one illness as two episodes.
test("the illness arm needs real, multi-day, separated resting-HR excursions", () => {
  resetTables("daily_metrics", "garmin_daily_metrics", "context_events");
  const rhr = (delta, bpm) =>
    db.prepare(`INSERT INTO daily_metrics (source, date, resting_hr) VALUES ('apple', ?, ?)`).run(day(delta), bpm);
  const arm = () => repo.energyDeficiencyArms(TODAY).find((entry) => entry.key === "illness_recurrence");

  // A month of norm behind, then a month of ordinary noise around it.
  for (let d = 55; d >= 28; d--) rhr(-d, 50);
  for (let d = 27; d >= 0; d--) rhr(-d, d % 3 === 0 ? 53 : 50);
  assert.equal(arm().verdict, "not_met", "ordinary night-to-night variation is not an illness");

  // Two isolated single-day spikes, well clear of the bar but one morning each.
  db.prepare(`DELETE FROM daily_metrics WHERE date >= ?`).run(day(-27));
  for (let d = 27; d >= 0; d--) rhr(-d, d === 20 || d === 6 ? 62 : 50);
  assert.equal(arm().verdict, "not_met", "one high morning is a late meal, not an infection");

  // One real illness — five consecutive mornings up — dipping under the bar and
  // returning is still ONE illness, not a recurrence.
  db.prepare(`DELETE FROM daily_metrics WHERE date >= ?`).run(day(-27));
  for (let d = 27; d >= 0; d--) rhr(-d, [20, 19, 18, 17, 16, 14, 13].includes(d) ? 62 : 50);
  assert.equal(arm().verdict, "not_met", "one illness that wobbles is not two episodes");

  // Two genuine episodes, a fortnight apart.
  db.prepare(`DELETE FROM daily_metrics WHERE date >= ?`).run(day(-27));
  for (let d = 27; d >= 0; d--) rhr(-d, [24, 23, 22, 8, 7, 6].includes(d) ? 62 : 50);
  const met = arm();
  assert.equal(met.verdict, "met");
  assert.match(met.summary, /2 separate resting-HR spike episode/);

  // Two logged illness windows say the same thing without a wearable at all.
  db.prepare(`DELETE FROM daily_metrics`).run();
  for (const [delta, title] of [[-40, "Head cold"], [-10, "Flu, off training"]]) {
    db.prepare(`INSERT INTO context_events (kind, title, detail, start_date) VALUES ('life_event', ?, '', ?)`).run(
      title,
      day(delta),
    );
  }
  assert.equal(arm().verdict, "met", "the athlete's own logged illness windows count too");
});

test("sessionLogContradictsLowRating: a complete comparable log outranks a 2-rating", () => {
  const date = day(-1);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });

  assert.equal(sessionLogContradictsLowRating(session.id), false, "no dose evidence — the rating stands");

  linkComparableDose(session.id, date, { comparable: true, verdict: "met" });
  assert.equal(sessionLogContradictsLowRating(session.id), true, "met comparable doses contradict the low rating");
});

test("sessionLogContradictsLowRating: an under-prescribed comparable dose lets the rating stand", () => {
  const date = day(-2);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkComparableDose(session.id, date, {
    comparable: true,
    verdict: "under_prescribed",
    prescribedSets: 4,
    achievedSets: 2,
  });
  assert.equal(sessionLogContradictsLowRating(session.id), false);
});

function linkSessionOutcome(sessionId, date, facts) {
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Dose fixture', ?, ?)`
    )
    .run(sessionId, date, JSON.stringify(facts.dose_evidence ?? []), `dose-${sessionId}`);
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, sessionId, date, JSON.stringify({ schema_version: 3, ...facts }));
}

function dose(
  exercise,
  {
    comparable = true,
    verdict = "met",
    prescribedSets = 3,
    achievedSets = 3,
    targetWeight = null,
    topWeight = null,
    fullLoadReference = null,
    non_comparable_reasons = [],
  } = {}
) {
  return {
    exercise,
    comparable,
    mode: "reps",
    non_comparable_reasons,
    prescribed: { sets: prescribedSets, target_weight: targetWeight },
    achieved: { sets: achievedSets, top_weight: topWeight },
    challenge_verdict: verdict,
    // Reconciliation persists a FullLoadReference OBJECT on schema-4 rows.
    ...(fullLoadReference == null ? {} : { full_load_reference: fullLoadReference }),
  };
}

// Dose comparability is a per-lift question, so the contradiction is read per
// lift: one lift that fell short does not disqualify a session the athlete
// otherwise pushed past what was asked. An INCOMPLETE log has to carry a lift
// that was genuinely exceeded before it outranks what the athlete felt.
const exceededDose = (exercise) => dose(exercise, { verdict: "exceeded", prescribedSets: 3, achievedSets: 4 });
const shortDose = (exercise) =>
  dose(exercise, {
    comparable: false,
    verdict: "under_prescribed",
    prescribedSets: 3,
    achievedSets: 1,
    non_comparable_reasons: ["partial"],
  });

test("sessionLogContradictsLowRating: five lifts exceeded and one short still outranks a 2-rating", () => {
  const date = day(-6);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      exceededDose("Back Squat"),
      exceededDose("Bench Press"),
      exceededDose("Romanian Deadlift"),
      exceededDose("Walking Lunge"),
      exceededDose("Calf Raise"),
      shortDose("Face Pull"),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    true,
    "the lifts that landed outnumber the one that did not, and five of them went past target"
  );
});

test("sessionLogContradictsLowRating: an even split with nothing exceeded leaves the rating standing", () => {
  const date = day(-7);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      dose("Back Squat"),
      dose("Bench Press"),
      dose("Romanian Deadlift"),
      shortDose("Walking Lunge"),
      shortDose("Calf Raise"),
      shortDose("Face Pull"),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    false,
    "half the day short and nothing pushed past target is not evidence against the felt rating"
  );
});

test("sessionLogContradictsLowRating: two exceeded against four short leaves the rating standing", () => {
  const date = day(-8);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      exceededDose("Back Squat"),
      exceededDose("Bench Press"),
      shortDose("Romanian Deadlift"),
      shortDose("Walking Lunge"),
      shortDose("Calf Raise"),
      shortDose("Face Pull"),
    ],
  });
  assert.equal(sessionLogContradictsLowRating(session.id), false, "more lifts fell short than landed");
});

test("sessionLogContradictsLowRating: a lift under its full working load leaves the rating standing", () => {
  const date = day(-9);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      exceededDose("Back Squat"),
      exceededDose("Bench Press"),
      exceededDose("Romanian Deadlift"),
      exceededDose("Walking Lunge"),
      exceededDose("Calf Raise"),
      dose("Face Pull", {
        verdict: "met",
        topWeight: 40,
        // Recent working load wins over the plan target, as harderLoad reads it.
        fullLoadReference: { sets: 3, target_weight: 35, recent_working_weight: 55, rep_low: 8 },
      }),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    false,
    "a lift that regressed under its own working load is a real shortfall, whatever the counts say"
  );
});

// The full-load arm reads the reference's LOAD, never its `sets`. Reconciliation's
// own `performed_at_full_load` folds a set shortfall into the same boolean, and
// borrowing that here would let one short lift veto the whole majority read —
// the per-session strictness this rule exists to remove. Volume is counted once,
// as a shortfall.
test("sessionLogContradictsLowRating: a short lift that still hit its working load is counted once", () => {
  const date = day(-12);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      exceededDose("Back Squat"),
      exceededDose("Bench Press"),
      exceededDose("Romanian Deadlift"),
      exceededDose("Walking Lunge"),
      exceededDose("Calf Raise"),
      dose("Face Pull", {
        verdict: "under_prescribed",
        prescribedSets: 4,
        achievedSets: 2,
        topWeight: 55,
        fullLoadReference: { sets: 4, target_weight: 55, recent_working_weight: 55, rep_low: 8 },
      }),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    true,
    "two sets short at the usual load is one shortfall, not a shortfall plus a regression"
  );
});

// The live record's shape: reconciliation writes `under_prescribed` on a lift
// whose top weight sat under target even though the athlete logged MORE sets
// than were asked for. Added volume is not a shortfall — the load question is
// the full-load arm's, and it answers per lift.
test("sessionLogContradictsLowRating: sets logged past the prescription count as exceeded", () => {
  const date = day(-11);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: ["Face Pull"],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      dose("Back Squat", { verdict: "under_prescribed", prescribedSets: 2, achievedSets: 3 }),
      dose("Bench Press", { verdict: "exceeded", prescribedSets: 2, achievedSets: 3 }),
      dose("Romanian Deadlift", { verdict: "under_prescribed", prescribedSets: 1, achievedSets: 4 }),
      dose("Walking Lunge", { verdict: "exceeded", prescribedSets: 1, achievedSets: 3 }),
      dose("Calf Raise", { verdict: "exceeded", prescribedSets: 1, achievedSets: 4 }),
      dose("Face Pull", {
        comparable: false,
        verdict: "not_attempted",
        prescribedSets: 2,
        achievedSets: 0,
        non_comparable_reasons: ["partial"],
      }),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    true,
    "five lifts carried more volume than asked; one that was not attempted does not outrank them"
  );
});

test("sessionLogContradictsLowRating: a session where every lift was skipped never contradicts", () => {
  const date = day(-10);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: ["Back Squat", "Bench Press", "Romanian Deadlift"],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      dose("Back Squat", { verdict: "not_attempted", achievedSets: 0 }),
      dose("Bench Press", { verdict: "not_attempted", achievedSets: 0 }),
      dose("Romanian Deadlift", { verdict: "not_attempted", achievedSets: 0 }),
    ],
  });
  assert.equal(sessionLogContradictsLowRating(session.id), false, "nothing landed, so nothing contradicts");
});

test("sessionLogContradictsLowRating: 2 of 5 lifts done at target leaves a 2-rating standing", () => {
  const date = day(-3);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: ["Romanian Deadlift", "Walking Lunge", "Calf Raise"],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      dose("Back Squat", { comparable: true, verdict: "met" }),
      dose("Bench Press", { comparable: true, verdict: "met" }),
      dose("Romanian Deadlift", {
        comparable: false,
        verdict: "partial",
        prescribedSets: 3,
        achievedSets: 0,
        non_comparable_reasons: ["partial"],
      }),
      dose("Walking Lunge", {
        comparable: false,
        verdict: "partial",
        prescribedSets: 3,
        achievedSets: 0,
        non_comparable_reasons: ["partial"],
      }),
      dose("Calf Raise", {
        comparable: false,
        verdict: "partial",
        prescribedSets: 3,
        achievedSets: 0,
        non_comparable_reasons: ["partial"],
      }),
    ],
  });
  assert.equal(
    sessionLogContradictsLowRating(session.id),
    false,
    "abandoned lifts must not vanish behind comparable:false — the 2-rating stands"
  );
});

test("sessionLogContradictsLowRating: all 5 lifts met discards a 2-rating", () => {
  const date = day(-4);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  repo.setSessionFeedback(date, { performance: 2 });
  linkSessionOutcome(session.id, date, {
    skipped: [],
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      dose("Back Squat"),
      dose("Bench Press"),
      dose("Romanian Deadlift"),
      dose("Walking Lunge"),
      dose("Calf Raise"),
    ],
  });
  assert.equal(sessionLogContradictsLowRating(session.id), true, "a complete log outranks the felt 2");
});

test("a session with a skipped dose counts toward log-confirmed fatigue arm (b)", () => {
  const date = day(-5);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  linkSessionOutcome(session.id, date, {
    skipped: ["Bench Press"],
    dose_context: { partial: true, comparable: false, non_comparable_reasons: ["partial"] },
    dose_evidence: [
      dose("Back Squat", { comparable: true, verdict: "met" }),
      dose("Bench Press", {
        comparable: false,
        verdict: "partial",
        prescribedSets: 3,
        achievedSets: 0,
        non_comparable_reasons: ["partial"],
      }),
    ],
  });
  assert.equal(
    countComparableDoseShortfallSessions(TODAY, 14),
    1,
    "a skip is an own-dose shortfall even though comparable is false"
  );
});

test("a schema-2 under-prescribed dose does not feed the comparable-shortfall arm", () => {
  const date = day(-6);
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
  const session = repo.getOrCreateSession(date);
  linkSessionOutcome(session.id, date, {
    schema_version: 2,
    skipped: [],
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      dose("Back Squat", { comparable: true, verdict: "under_prescribed", prescribedSets: 3, achievedSets: 3 }),
    ],
  });
  assert.equal(
    countComparableDoseShortfallSessions(TODAY, 14),
    0,
    "schema 2 never carried per-dose comparable — even a materialized flag is not this arm"
  );
});

test("a completed comparable log outranks two low performance ratings in the fueling channel", () => {
  target(2200);
  for (const delta of [-1, -2, -3, -4, -5]) intake(delta, 2175);
  for (const delta of [-1, -2]) {
    const date = day(delta);
    repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, rir: 2, date });
    const session = repo.getOrCreateSession(date);
    repo.setSessionFeedback(date, { performance: 2 });
    linkComparableDose(session.id, date, { comparable: true, verdict: "met" });
  }
  const read = underfuelingRead(TODAY, {
    expenditure: onPathExp,
    goal,
    programState: stableProgram,
    wholePerson: stableWhole,
  });
  const performance = read.channels.find((channel) => channel.key === "performance");
  assert.equal(performance.direction, "support", "met logs plus progressing lifts are support, not strain");
});
