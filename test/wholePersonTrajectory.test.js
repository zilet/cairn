import { test } from "node:test";
import assert from "node:assert/strict";
import { wholePersonTrajectory } from "../dist/repo/whole-person-trajectory.js";
import { db } from "../dist/db.js";

test("whole-person trajectory stays verbal, phase-aware, and flags unexplained regression", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
  for (const [date, weight] of [
    ["2026-05-01", 180],
    ["2026-05-12", 180.2],
    ["2026-06-01", 181.5],
    ["2026-06-20", 183.5],
  ]) {
    db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, weight);
  }
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.equal(read.objective, "everything better");
  assert.equal(read.domains.find((domain) => domain.domain === "body_composition").verdict, "worse");
  assert.deepEqual(read.unexplained_worse, ["body_composition"]);
  assert.equal(read.revision_needed, true);
  assert.doesNotMatch(JSON.stringify(read), /score|\b\d{1,3}\/100\b/);
});

test("a hybrid cut optimizes strength development with retention as a universal floor", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline) VALUES (1, 'lose', 180, 'hybrid')`).run();
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.ok(read.phase.protects.includes("strength"));
  assert.ok(read.phase.optimizes.includes("strength and muscle development"));
  assert.ok(read.phase.optimizes.includes("body composition"));
  assert.ok(read.phase.floors.includes("no avoidable lean-mass loss"));
  assert.ok(!read.phase.optimizes.includes("strength retention"));
  assert.ok(!read.phase.parks.includes("strength"));
  assert.equal(read.domains.find((domain) => domain.domain === "strength").parked, false);
});

test("explicit ordered intent owns phase.optimizes while strength and lean-mass floors remain", () => {
  db.prepare(
    `INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline, training_intent_json)
     VALUES (1, 'lose', 180, 'hybrid', ?)`
  ).run(
    JSON.stringify({
      priorities: ["longevity", "muscle", "leanness", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "MTB", target_duration_min: 120, context: null },
    })
  );
  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  assert.deepEqual(read.phase.optimizes, ["longevity", "muscle development", "body composition", "endurance"]);
  assert.ok(read.phase.floors.includes("no avoidable strength regression"));
  assert.ok(read.phase.floors.includes("no avoidable lean-mass loss"));
  assert.ok(read.phase.protects.includes("strength"));
});

test("one established regressing lift stays visible even while another lift advances", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb, primary_discipline) VALUES (1, 'lose', 180, 'hybrid')`).run();
  const bench = Number(db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Bench Press', 'chest')`).run().lastInsertRowid);
  const raise = Number(db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Lateral Raise', 'shoulders')`).run().lastInsertRowid);
  const dates = ["2026-05-20", "2026-05-30", "2026-06-10", "2026-06-20"];
  dates.forEach((date, index) => {
    const session = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(date).lastInsertRowid);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 5)`)
      .run(session, bench, 200 - index * 10);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 12)`)
      .run(session, raise, 10 + index * 5);
  });

  const read = wholePersonTrajectory({ end: "2026-06-25", days: 56 });
  const strength = read.domains.find((domain) => domain.domain === "strength");
  assert.equal(strength.verdict, "worse");
  assert.match(strength.why, /Bench Press/);
  assert.match(strength.why, /Lateral Raise/);
  assert.match(strength.why, /other lift is still advancing/);
  assert.ok(read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, true);
});

// ---------------------------------------------------------------------------
// Confounder discipline for the strength read.
//
// The evaluators have refused decisive verdicts from confounded windows all
// along (contextEventConfounders, src/domain/brain/evaluation-service.ts). This
// read did not, so a strength slide with a perfectly good explanation — a trip,
// an injury, a real energy deficit, an open symptom — reached the scheduler as an
// `unexplained_worse` and opened a case conference about it.
//
// The regression itself is NEVER softened away: the domain still reads "worse"
// and still names the lifts. What changes is the claim that nobody can say why.
import { repo as wpRepo } from "./_seed.js";

const WINDOW_END = "2026-06-25";

function decliningSquat() {
  const exercise = wpRepo.upsertExercise({ name: "Barbell Back Squat", muscle_group: "quads" });
  for (const [date, weight] of [
    ["2026-05-04", 200],
    ["2026-05-11", 198],
    ["2026-05-18", 196],
    ["2026-06-01", 180],
    ["2026-06-08", 178],
    ["2026-06-15", 176],
  ]) {
    const session = wpRepo.getOrCreateSession(date, null);
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, 5)`
    ).run(session.id, exercise.id, weight);
  }
  return exercise;
}

function maintainProfile() {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
}

function strengthOf(read) {
  return read.domains.find((domain) => domain.domain === "strength");
}

test("a strength regression nobody can explain still demands a revision", () => {
  maintainProfile();
  decliningSquat();
  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse");
  assert.deepEqual(strength.confounders, []);
  assert.ok(read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, true);
});

test("a trip across the window explains the slide, so no revision is demanded", () => {
  maintainProfile();
  decliningSquat();
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date) VALUES ('trip', ?, ?, ?, ?)`
  ).run("Three weeks abroad", "Away from the gym.", "2026-05-25", "2026-06-14");

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  // The regression stays VISIBLE — it is not softened, hidden, or re-verdicted.
  assert.equal(strength.verdict, "worse");
  assert.ok(strength.confounders.length, "the trip is on record as the explanation");
  assert.match(strength.why, /Barbell Back Squat/, "the lifts that slid are still named");
  assert.match(strength.why, /already has an explanation/);
  // …but it is no longer UNEXPLAINED, which is what opens a case conference.
  assert.ok(!read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, false);
  assert.match(read.line, /moved down too, inside a window that already explains it/);
});

test("a measured energy deficit explains lost strength on its own", () => {
  // 'lose' so the weight drop reads as the phase working, leaving strength the
  // only domain moving down — the case this test is actually about.
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'lose', 180)`).run();
  decliningSquat();
  for (const [date, weight] of [
    ["2026-05-02", 190],
    ["2026-05-16", 187],
    ["2026-05-30", 184],
    ["2026-06-13", 181],
    ["2026-06-24", 180],
  ]) {
    db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, weight);
  }
  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse");
  assert.ok(
    strength.confounders.some((line) => /lb a week/.test(line)),
    `the deficit is named (got ${JSON.stringify(strength.confounders)})`
  );
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a cut goal alone is not evidence of a deficit — only a measured one is", () => {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'lose', 180)`).run();
  decliningSquat();
  // Cutting on paper, holding on the scale. Intent must never confound, or every
  // cutting athlete's every regression would be explained away forever.
  for (const [date, weight] of [
    ["2026-05-02", 180],
    ["2026-05-16", 179.8],
    ["2026-05-30", 180.1],
    ["2026-06-13", 179.9],
  ]) {
    db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, weight);
  }
  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.deepEqual(strengthOf(read).confounders, []);
  assert.ok(read.unexplained_worse.includes("strength"));
});

test("an open symptom that loads the lifts which slid explains them", () => {
  maintainProfile();
  decliningSquat();
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
     VALUES ('test', 'left knee', 'active', 'area', '2026-05-20', '2026-06-20')`
  ).run();

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse");
  assert.ok(
    strength.confounders.some((line) => /left knee/.test(line)),
    `the knee is named (got ${JSON.stringify(strength.confounders)})`
  );
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a symptom somewhere the lifts do not load explains nothing", () => {
  maintainProfile();
  decliningSquat();
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
     VALUES ('test', 'right elbow', 'active', 'area', '2026-05-20', '2026-06-20')`
  ).run();

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.deepEqual(strengthOf(read).confounders, []);
  assert.ok(read.unexplained_worse.includes("strength"));
});

test("a holding picture pays for none of these reads", () => {
  maintainProfile();
  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  for (const domain of read.domains) assert.deepEqual(domain.confounders, [], `${domain.domain} declares the field`);
});

// ---------------------------------------------------------------------------
// An explanation that was already TESTED and did not hold.
//
// The suppression above is correct while nobody has acted on the explanation.
// Once the remedy it implies was delivered, the lifts that slid were genuinely
// trained under it, and the slide continued anyway, the explanation has had its
// hearing. It stays on the record as dated history; it stops closing the case
// conference. Without this the fueling arm in particular suppressed forever —
// it judges intake against the target in force at window END, so the remedy
// raised the very bar that re-earned the confounder.
//
// `decliningSquat` logs Barbell Back Squat on 05-04, 05-11, 05-18, 06-01, 06-08
// and 06-15, so a remedy dated 05-20 has three exposures after it and one dated
// 06-05 has two — that is the whole exposure arithmetic below.

function cuttingProfile() {
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'lose', 180)`).run();
}

/** A real measured slide on the scale — the fueling confounder's first arm. */
function measuredDeficit() {
  for (const [date, weight] of [
    ["2026-05-02", 190],
    ["2026-05-16", 187],
    ["2026-05-30", 184],
    ["2026-06-13", 181],
    ["2026-06-24", 180],
  ]) {
    db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, weight);
  }
}

function acceptTarget(effectiveDate, kcal) {
  db.prepare(`INSERT INTO nutrition_targets (effective_date, target_kcal, source) VALUES (?, ?, 'test')`).run(
    effectiveDate,
    kcal
  );
}

function squatSession(date, planDayId = null) {
  return wpRepo.getOrCreateSession(date, planDayId);
}

test("a fueling explanation the calorie raise already tested stops suppressing the conference", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-05-20", 2600); // +250 kcal, 36 days before the window ends

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse", "the regression itself is never softened");
  assert.deepEqual(strength.confounders, [], "a spent explanation no longer suppresses");
  // …but it is not erased. The conference has to be able to cite what was tried.
  assert.match(strength.why, /already been tested/);
  assert.match(strength.why, /2026-05-20/, "the remedy stays dated");
  assert.match(strength.why, /250 kcal/);
  assert.match(strength.why, /3 comparable Barbell Back Squat exposures/);
  assert.ok(read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, true);
});

test("a calorie raise delivered days ago has not been tested yet", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-06-20", 2600); // five days is not a hearing

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length, "a fresh remedy keeps its explanation alive");
  assert.doesNotMatch(strengthOf(read).why, /already been tested/);
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a calorie raise the lifts have barely trained under has not been tested yet", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-06-05", 2600); // 20 days, but only two squat exposures follow

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length, "elapsed time alone never expires an explanation");
  assert.ok(!read.unexplained_worse.includes("strength"));
});

// A remedy tests only the explanation it was DELIVERED AGAINST. Both the
// elapsed-days and the exposures-since checks are satisfied for free by any
// raise old enough, so without a lower bound one historical raise that was never
// walked back would retire fueling as an explanation permanently — and the `why`
// would claim last year's remedy answered this year's deficit.
test("a calorie raise from long before the window cannot test today's deficit", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2025-03-01", 2100);
  acceptTarget("2025-06-01", 2600); // +500 kcal, eleven months before the window

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.ok(strength.confounders.length, "a fresh deficit is still the explanation");
  assert.doesNotMatch(strength.why, /already been tested/);
  assert.doesNotMatch(strength.why, /2025-/, "no remedy from a previous year is cited");
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a raise before the window start does not test it, however recent the window end", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  // The window runs 2026-05-01..2026-06-25. This raise lands the day before it
  // opens: old enough to clear the 14-day bar, but not delivered against this
  // window's deficit, so it tests nothing here.
  acceptTarget("2026-03-01", 2350);
  acceptTarget("2026-04-30", 2600);

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length);
  assert.doesNotMatch(strengthOf(read).why, /already been tested/);
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a raise inside the window still tests it even when the target it rose from predates the window", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  // The predecessor row is what makes a raise legible as a raise, and it usually
  // sits before the window. Bounding the row scan rather than the result would
  // hide this raise entirely.
  acceptTarget("2026-02-01", 2350);
  acceptTarget("2026-05-20", 2600);

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.deepEqual(strengthOf(read).confounders, []);
  assert.match(strengthOf(read).why, /already been tested/);
  assert.match(strengthOf(read).why, /2026-05-20/);
  assert.ok(read.unexplained_worse.includes("strength"));
});

test("a calorie target that only ever went down has tested nothing", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2600);
  acceptTarget("2026-05-20", 2350); // a cut is not a remedy for a slide

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length);
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a context event that ended, and was then outlived, stops suppressing the conference", () => {
  maintainProfile();
  decliningSquat();
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date) VALUES ('trip', ?, ?, ?, ?)`
  ).run("Two weeks abroad", "Away from the gym.", "2026-05-05", "2026-05-20");

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse");
  assert.deepEqual(strength.confounders, []);
  assert.match(strength.why, /already been tested/);
  assert.match(strength.why, /ended on 2026-05-20/);
  assert.ok(read.unexplained_worse.includes("strength"));
  assert.equal(read.revision_needed, true);
});

test("an open-ended context event never expires, however long it has run", () => {
  maintainProfile();
  decliningSquat();
  // No end_date and no resolved_at: the read synthesizes a horizon so the query
  // can bound itself, but a synthesized end is a guess, never "the trip is over".
  db.prepare(`INSERT INTO context_events (kind, title, detail, start_date) VALUES ('injury', ?, ?, ?)`).run(
    "Ongoing shoulder rehab",
    "Still working through it.",
    "2026-05-05"
  );

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length, "an unfinished event is still the explanation");
  assert.doesNotMatch(strengthOf(read).why, /already been tested/);
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("an active symptom never expires, so it suppresses even beside a spent explanation", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-05-20", 2600);
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
     VALUES ('test', 'everything aches', 'active', 'systemic', '2026-05-06', '2026-06-22')`
  ).run();

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.confounders.length, 1, `only the symptom survives (got ${JSON.stringify(strength.confounders)})`);
  assert.match(strength.confounders[0], /whole-body symptom/);
  // Training through pain for weeks is not a failed test of the pain.
  assert.ok(!read.unexplained_worse.includes("strength"), "one live explanation is still an explanation");
  assert.match(strength.why, /already been tested/, "the spent fueling history is still recorded");
});

test("one live explanation beside one spent one still closes the conference", () => {
  cuttingProfile();
  decliningSquat();
  measuredDeficit(); // a live fueling explanation: no raise was ever delivered
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date) VALUES ('trip', ?, ?, ?, ?)`
  ).run("Two weeks abroad", "Away from the gym.", "2026-05-05", "2026-05-20");

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.confounders.length, 1, `the trip spent, the deficit live (got ${JSON.stringify(strength.confounders)})`);
  assert.match(strength.confounders[0], /lb a week/);
  assert.match(strength.why, /ended on 2026-05-20/, "the spent trip stays in the record");
  assert.ok(!read.unexplained_worse.includes("strength"));
});

// A remedy delivered right before a deload would otherwise read as tested by
// sessions that were never a strength test at all. `comparableLiftDates` is the
// counter for exactly this reason, and these two cases are each other's control:
// same dates, same raise, one recovery-compliant session versus one ordinary one.
function reducedRecoveryWeek(appliedOn) {
  wpRepo.savePlanDay(1, "Recovery Legs", "Legs", [
    { exercise: "Barbell Back Squat", sets: 2, rep_low: 5, rep_high: 8, target_weight: 176 },
  ]);
  const proposal = wpRepo.createProposal("stub", wpRepo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: wpRepo.getPlan(),
  });
  wpRepo.setProposalStatus(proposal.id, "applied");
  wpRepo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
  db.prepare(`UPDATE app_state SET updated_at = ? WHERE key = 'recovery_week_applied'`).run(`${appliedOn} 00:00:00`);
  return wpRepo.getPlanDay(1);
}

test("a compliant recovery session is not an exposure, so it cannot test an explanation", () => {
  cuttingProfile();
  const squat = decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-06-05", 2600); // 20 days out; 06-08 and 06-15 are its only real tests
  const planDay = reducedRecoveryWeek("2026-06-18");
  const session = squatSession("2026-06-20", planDay.id);
  for (const setNumber of [1, 2]) {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, 176, 5, 5)`
    ).run(session.id, squat.id, setNumber);
  }
  assert.equal(wpRepo.recoverySessionDose(session.id).classification, "compliant");

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.ok(strengthOf(read).confounders.length, "a deload week does not count as trying the remedy");
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("an ordinary third exposure after the raise does test it — the recovery control", () => {
  cuttingProfile();
  const squat = decliningSquat();
  measuredDeficit();
  acceptTarget("2026-05-01", 2350);
  acceptTarget("2026-06-05", 2600);
  const session = squatSession("2026-06-20");
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 174, 5)`
  ).run(session.id, squat.id);

  const read = wholePersonTrajectory({ end: WINDOW_END, days: 56 });
  assert.deepEqual(strengthOf(read).confounders, []);
  assert.match(strengthOf(read).why, /3 comparable Barbell Back Squat exposures/);
  assert.ok(read.unexplained_worse.includes("strength"));
});
