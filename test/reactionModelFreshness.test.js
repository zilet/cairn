// What the personal-response model is allowed to READ, and for how long a reading
// still speaks. Three defects, all of them silent:
//
//   1. evaluatedDecisionRows() capped its join at 500 rows ordered ASCENDING, so once
//      the ledger outgrew that the model froze on the oldest 500 conclusive outcomes
//      forever — every verdict recorded afterwards fell off the end and the "personal
//      defaults" the athlete was coached with were an unchanging prefix of their
//      ancient history.
//   2. A modifier earned once was applied at full scale and full confidence forever.
//      The 365-day horizon inside learningForGroup is relative to the GROUP's own
//      newest row ("were these outcomes comparable to each other?"), which is a real
//      question and not this one: two outcomes three years ago are perfectly
//      comparable to each other and say nothing about the athlete this morning.
//   3. training_progression_step DECLARED a floor of 0.85 that its own branch could
//      never produce (the reachable scales are 0.9 / 1 / 1.1) — a depth of caution the
//      model advertised and had no way to reach.
//
// The ledger rows are written raw here rather than through recordDecision, because
// the window test needs five hundred of them and the point is only ever which rows
// the SELECT keeps — no production write path is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { trainingModifierFor } from "../dist/repo/progression.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const insertDecision = db.prepare(
  `INSERT INTO brain_decisions
     (created_at, effective_date, kind, domain, summary, rationale, source, status, autonomy_tier,
      risk_class, reversible, context_json, action_json, evaluator_version)
   VALUES (?, ?, ?, 'training', ?, 'A bounded change, measured before the default moves again.',
           'test', 'applied', 'quiet_apply', 'low', 1, '{}', '{}', 'freshness-test-v1')`
);
const insertExpectation = db.prepare(
  `INSERT INTO brain_expectations
     (decision_id, metric_key, subject_key, direction, baseline_json, target_json, window_start,
      window_end, minimum_data_json, confounder_policy, confidence, evaluator, evaluator_version)
   VALUES (?, ?, ?, ?, NULL, ?, '2026-01-01', '2026-01-29', NULL, 'standard', 'tentative',
           'freshness-test', 'freshness-test-v1')`
);
const insertEvaluation = db.prepare(
  `INSERT INTO brain_evaluations
     (expectation_id, evaluated_at, verdict, actual_json, evidence_json, confounders_json,
      explanation, evaluator_version)
   VALUES (?, ?, ?, ?, '[]', '[]', 'The observed result landed where the expectation said.',
           'freshness-test-v1')`
);

// Noon on the local day `daysAgo` back, in the "YYYY-MM-DD HH:MM:SS" shape the ledger
// stores — a stable hour, so a run near midnight can't shift a seeded age by a day.
function stampDaysAgo(daysAgo) {
  return `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`;
}

// One comparable GROUP: `n` decisions that each recorded the same expectation and each
// had it judged the same way. Two is the minimum that earns a learning at all.
function seedGroup({ metricKey, subjectKey = null, kind = "training_target", verdict = "aligned", daysAgo, n = 2 }) {
  for (let i = 0; i < n; i++) {
    const stamp = stampDaysAgo(daysAgo + (n - 1 - i));
    const decision = insertDecision.run(stamp, "2026-01-01", kind, `${metricKey} ${subjectKey ?? "all"} ${i}.`);
    const expectation = insertExpectation.run(
      decision.lastInsertRowid,
      metricKey,
      subjectKey,
      "complete",
      JSON.stringify({ exposures: 2 })
    );
    insertEvaluation.run(
      expectation.lastInsertRowid,
      stamp,
      verdict,
      JSON.stringify({ value: 1, completion_rate: 1, exposures: 4 })
    );
  }
}

function trainingModifiers(response) {
  return response.modifiers.filter((modifier) => modifier.target === "training_progression_step");
}

// ---- the 500-row window has to bite at the OLD end -------------------------

test("the outcome window keeps the NEWEST verdicts once the ledger outgrows it", () => {
  // 505 singleton groups, every one of them older than the learning that matters. They
  // earn nothing on their own (one outcome each, so no group reaches the two-outcome
  // minimum) — their only job is to fill the window.
  db.exec("BEGIN");
  for (let i = 0; i < 505; i++) {
    seedGroup({ metricKey: "exercise_target_completion", subjectKey: `Filler Lift ${i}`, daysAgo: 200 + i, n: 1 });
  }
  db.exec("COMMIT");
  // …and the learning the athlete actually earned this month, which under the old
  // ascending cut was row 506 and therefore invisible.
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 4 });

  const learned = whatWorksForYou();
  assert.ok(learned, "a model is built");
  assert.ok(
    learned.learnings.some((learning) => learning.subject_key === "Back Squat"),
    "the recent learning survived a ledger 500 rows deeper than the window"
  );
  const modifier = trainingModifierFor("Back Squat", learned);
  assert.ok(modifier, "and it still reaches the progression ladder");
  assert.equal(modifier.subject_key, "Back Squat");
});

// ---- a declared bound the branch can actually reach -------------------------

test("the training band declares only the scales it can produce", () => {
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 4 });

  const modifier = trainingModifierFor("Back Squat");
  assert.ok(modifier);
  assert.deepEqual(modifier.bounds, { min: 0.9, max: 1.1 }, "0.85 was a caution the branch could never reach");
  assert.ok(
    modifier.scale >= modifier.bounds.min && modifier.scale <= modifier.bounds.max,
    "and the emitted scale sits inside its own band"
  );
});

// ---- a learned default has a shelf life ------------------------------------

test("a modifier under six months old is at full strength", () => {
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 30 });

  const modifier = trainingModifierFor("Back Squat");
  assert.ok(modifier);
  assert.equal(modifier.scale, 1.1, "an earned acceleration inside the window is not softened");
  assert.equal(modifier.confidence, "observed");
  assert.ok(!modifier.rationale.includes("softened"), "and it is not described as stale");
});

test("between six months and a year the scale fades toward the universal default", () => {
  // Three readings of the same earned acceleration at three ages. Each is its own lift
  // so each keeps its own modifier, and the only thing that differs between them is how
  // long ago the outcome behind it was observed.
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 30 });
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Front Squat", daysAgo: 250 });
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Split Squat", daysAgo: 330 });

  const learned = whatWorksForYou();
  const fresh = trainingModifierFor("Back Squat", learned);
  const middling = trainingModifierFor("Front Squat", learned);
  const old = trainingModifierFor("Split Squat", learned);
  assert.ok(fresh && middling && old, "all three lifts keep a modifier");

  assert.equal(fresh.scale, 1.1);
  assert.ok(middling.scale < fresh.scale, `a 250-day-old reading has loosened its grip (${middling.scale})`);
  assert.ok(old.scale < middling.scale, `and a 330-day-old one further still (${old.scale})`);
  assert.ok(old.scale > 1, "…without ever crossing the universal default it fades toward");

  assert.equal(middling.confidence, "tentative", "an aged reading drops a confidence band");
  assert.equal(old.confidence, "tentative");
  assert.ok(middling.rationale.includes("months old"), "and says so where the athlete reads it");
});

test("past a year a learning keeps its sentence but loses the right to move a number", () => {
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 420 });

  const learned = whatWorksForYou();
  assert.ok(learned, "the learning itself is still on the record");
  const learning = learned.learnings.find((item) => item.subject_key === "Back Squat");
  assert.ok(learning, "the athlete can still see what was learned, and when");
  assert.match(
    learning.change,
    /standard default stands again/,
    "and is told plainly that the standard default is back"
  );

  assert.equal(trainingModifiers(learned).length, 0, "but nothing reads a modifier off it");
  assert.equal(trainingModifierFor("Back Squat", learned), null);
});

test("age is measured from the NEWEST supporting outcome, not the oldest", () => {
  // One comparable group spanning fourteen months. Its oldest row is well past the
  // expiry, but the athlete repeated the result seven months ago — so the learning is
  // aged, not dead. Measuring from the oldest row would have thrown away a reading the
  // athlete has actually re-earned since.
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 250, n: 1 });
  seedGroup({ metricKey: "exercise_target_completion", subjectKey: "Back Squat", daysAgo: 420, n: 1 });

  const spanning = trainingModifierFor("Back Squat");
  assert.ok(spanning, "the group is read off its newest outcome");
  assert.ok(spanning.scale > 1 && spanning.scale < 1.1, `faded rather than dropped (${spanning?.scale})`);
});
