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
