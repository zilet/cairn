import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";

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
