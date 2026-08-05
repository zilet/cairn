import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { recordDecision, transitionBrainDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { applyPersonalResponseModifier, whatWorksForYou } from "../dist/repo/reaction-model.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

function decision(key, overrides = {}) {
  return {
    effective_date: "2026-01-01",
    kind: "nutrition_target",
    domain: "nutrition",
    summary: `Bounded nutrition adjustment ${key}.`,
    rationale: "Measure the response before changing the default again.",
    source: "test",
    source_ref_type: "nutrition_target",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { target_kcal: 2300 + Number(key) },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "response-test-v1",
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2, recomposition_stage: "mid_cut" },
    target: { min: -1, max: -0.2 },
    window_start: "2026-01-01",
    window_end: "2026-01-21",
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "response-test-v1",
    ...overrides,
  };
}

function recordOutcome(key, verdict, opts = {}) {
  const recorded = recordDecision(decision(key, opts.decision), [expectation(opts.expectation)]);
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: opts.actual ?? { value: verdict === "aligned" ? -0.5 : 0, weigh_ins: opts.measurements ?? 8 },
    evidence_keys: [`bodyweight_log:2026-01-01..2026-01-21:n=${opts.measurements ?? 8}`],
    confounders: opts.confounders ?? [],
    explanation:
      verdict === "aligned"
        ? "The observed weight trend landed inside the expected band."
        : "The observed weight trend stayed outside the expected band.",
    evaluator_version: "response-test-v1",
  });
  return recorded;
}

test("one noisy outcome does not change a future personal default", () => {
  recordOutcome("1", "not_aligned", { measurements: 1 });

  assert.equal(whatWorksForYou(), null);
  assert.equal(repo.getCoachContext().what_works_for_you, null);
});

test("two expectations from one decision do not masquerade as two comparable decisions", () => {
  const recorded = recordDecision(decision("1"), [
    expectation(),
    expectation({ window_start: "2026-02-01", window_end: "2026-02-21" }),
  ]);
  for (const item of recorded.expectations) {
    insertBrainEvaluation({
      expectation_id: item.id,
      verdict: "not_aligned",
      actual: { value: 0, weigh_ins: 8 },
      evidence_keys: [`bodyweight_log:${item.window_start}..${item.window_end}:n=8`],
      confounders: [],
      explanation: "The observed weight trend stayed outside the expected band.",
      evaluator_version: "response-test-v1",
    });
  }

  assert.equal(whatWorksForYou(), null);
});

test("repeated clean misses earn a bounded modifier and appear in coach context", () => {
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");

  const learned = whatWorksForYou();
  assert.ok(learned);
  assert.equal(learned.version, 2);
  assert.equal(learned.learnings.length, 1);
  assert.equal(learned.learnings[0].confidence, "observed");
  assert.equal(learned.learnings[0].evidence_n, 2);
  assert.equal(learned.learnings[0].missed_n, 2);
  assert.match(learned.learnings[0].statement, /missed the expectation/i);
  assert.equal(learned.modifiers[0].target, "nutrition_step");
  assert.equal(learned.modifiers[0].stage, "mid_cut");
  assert.equal(learned.modifiers[0].scale, 1.15);
  assert.deepEqual(learned.modifiers[0].never_overrides, ["injury", "allergy", "clinical", "lean_safe"]);

  const context = repo.getCoachContext().what_works_for_you;
  assert.equal(context.modifiers[0].scale, 1.15);
});

test("nutrition outcomes from different recomposition stages do not combine into one learned trial group", () => {
  recordOutcome("1", "not_aligned", { expectation: { baseline: { value: -1.2, recomposition_stage: "mid_cut" } } });
  recordOutcome("2", "not_aligned", { expectation: { baseline: { value: -0.6, recomposition_stage: "leaning_out" } } });

  assert.equal(whatWorksForYou(), null);
});

test("a later contradiction lowers confidence before a repeated new response supersedes the old one", () => {
  recordOutcome("1", "aligned");
  recordOutcome("2", "aligned");
  assert.equal(whatWorksForYou().modifiers[0].scale, 1);

  recordOutcome("3", "not_aligned");
  const mixed = whatWorksForYou();
  assert.equal(mixed.learnings[0].confidence, "tentative");
  assert.equal(mixed.learnings[0].contradictions, 1);
  assert.equal(mixed.modifiers.length, 0);
  assert.match(mixed.learnings[0].change, /(?:standard|universal) default/i);

  recordOutcome("4", "not_aligned");
  const superseded = whatWorksForYou();
  assert.equal(superseded.modifiers[0].scale, 1.15);
  assert.equal(superseded.learnings[0].superseded_evidence_n, 2);
  assert.equal(superseded.learnings[0].confidence, "observed");
});

test("superseded decisions do not count as comparable evidence", () => {
  const first = recordOutcome("1", "not_aligned");
  const second = recordOutcome("2", "not_aligned");
  transitionBrainDecision(first.decision.id, "superseded", { supersededBy: second.decision.id });

  assert.equal(whatWorksForYou(), null);
});

test("one strong repeated-measurement outcome can qualify without treating sparse evidence as strong", () => {
  recordOutcome("1", "aligned", {
    measurements: 14,
    expectation: { confidence: "strong" },
  });
  const learned = whatWorksForYou();
  assert.ok(learned);
  assert.equal(learned.learnings[0].confidence, "strong");
  assert.equal(learned.modifiers[0].scale, 1);
});

test("personal modifiers stay bounded and cannot weaken universal safety constraints", () => {
  const modifier = {
    key: "test",
    target: "training_progression_step",
    scale: 0.5,
    bounds: { min: 0.85, max: 1.1 },
    confidence: "strong",
    evidence_n: 4,
    rationale: "test",
    never_overrides: ["injury", "allergy", "clinical", "lean_safe"],
  };

  assert.equal(applyPersonalResponseModifier({ base: 100, modifier }), 85);
  assert.equal(applyPersonalResponseModifier({ base: 2200, modifier, safety_floor: 2100 }), 2100);
  for (const hard_constraint of ["injury", "allergy", "clinical"]) {
    assert.equal(applyPersonalResponseModifier({ base: 100, modifier, hard_constraint }), 100);
  }
});

// ---- the model is memoized on the shared training version + a ledger backstop ----
// It is read several times per day read (the progression ladder, the run ladder, the
// coach context), and each compute pays for a correlated latest-evaluation subquery
// over the whole ledger. These pin BOTH halves of the contract: an unchanged version
// serves one compute, and a bump recomputes rather than serving a stale model.

test("two reads on the same training version compute the model once", () => {
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");
  const first = whatWorksForYou();
  assert.equal(first.learnings[0].missed_n, 2);

  // Row-touch evidence: flip a stored verdict UNDERNEATH the memo, touching nothing
  // the key can see (no insert, no delete, no decision status). A recompute would
  // read the new verdict; the memo must not.
  db.prepare(`UPDATE brain_evaluations SET verdict = 'aligned'`).run();
  assert.equal(whatWorksForYou().learnings[0].missed_n, 2, "the second read was served from the memo");

  // …and the memo hands out a COPY, so one caller's edit cannot reach the next.
  const copy = whatWorksForYou();
  copy.modifiers.length = 0;
  assert.ok(whatWorksForYou().modifiers.length > 0, "callers never share the cached arrays");
});

test("a bumped training version recomputes the model", () => {
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");
  assert.equal(whatWorksForYou().learnings[0].missed_n, 2);

  db.prepare(`UPDATE brain_evaluations SET verdict = 'aligned'`).run();
  bumpTrainingDataVersion();
  const rebuilt = whatWorksForYou();
  assert.equal(rebuilt.learnings[0].missed_n, 0, "the bump invalidated the memo");
  assert.equal(rebuilt.learnings[0].aligned_n, 2);
});

test("a new evaluation invalidates the model without needing a bump", () => {
  recordOutcome("1", "not_aligned");
  assert.equal(whatWorksForYou(), null, "one outcome is below the repeat floor");

  // No writer of the ledger bumps the training counter, so the backstop is the only
  // thing standing between the nightly evaluator and a day of stale coaching.
  recordOutcome("2", "not_aligned");
  const learned = whatWorksForYou();
  assert.ok(learned, "the second outcome is visible to the very next read");
  assert.equal(learned.learnings[0].evidence_n, 2);
});

// ---------------------------------------------------------------------------
// liftLedgerRead — the ledger's word on ONE lift, readable by the progression
// DECISION (deload / vary / hold) rather than only by the step-size modifier.
//
// Until this existed, per-lift verdicts dead-ended in modifierFor's ±10% step
// scale: the ledger could know a lift had missed three windows running and the
// only thing that knowledge could do was shrink the next increment slightly.
import { liftLedgerRead } from "../dist/repo/reaction-model.js";
import { addDaysISO, localDateISO as ledgerToday } from "../dist/repo/shared.js";

function liftExpectation(exercise, overrides = {}) {
  return expectation({
    metric_key: "exercise_est_1rm_trend",
    subject_key: exercise,
    direction: "at_least",
    baseline: { est_1rm: 200 },
    target: { value: 194 },
    minimum_data: { exposures: 3 },
    evaluator: "exercise_est_1rm",
    ...overrides,
  });
}

function recordLiftOutcome(exercise, key, verdict, opts = {}) {
  const recorded = recordDecision(
    decision(key, { kind: "training_target", domain: "training", action: { lift: exercise, slot: key }, ...opts.decision }),
    [liftExpectation(exercise, opts.expectation)]
  );
  const evaluation = insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? 205 : 180, exposures: 5 },
    evidence_keys: [`logged_sets:2026-01-01..2026-01-21:n=5`],
    confounders: [],
    explanation: verdict === "aligned" ? "The estimate held." : "The estimate did not hold.",
    evaluator_version: "response-test-v1",
  });
  db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(
    `${addDaysISO(ledgerToday(), -(opts.daysAgo ?? 10))} 12:00:00`,
    evaluation.id
  );
  return recorded;
}

test("a lift the ledger has never judged says so, rather than reading as a clean sheet", () => {
  const read = liftLedgerRead("Back Squat");
  assert.deepEqual(read.verdicts, []);
  assert.equal(read.informative, false, "silence is distinguishable from a good record");
  assert.equal(liftLedgerRead("").informative, false);
});

test("one verdict is an anecdote, not something to make a decision on", () => {
  recordLiftOutcome("Back Squat", "1", "not_aligned", { daysAgo: 5 });
  const read = liftLedgerRead("Back Squat");
  assert.equal(read.verdicts.length, 1);
  assert.equal(read.informative, false);
});

test("two conclusive verdicts let the ledger speak, newest first", () => {
  recordLiftOutcome("Back Squat", "1", "not_aligned", { daysAgo: 40 });
  recordLiftOutcome("Back Squat", "2", "not_aligned", { daysAgo: 5 });
  const read = liftLedgerRead("Back Squat");
  assert.equal(read.informative, true);
  assert.equal(read.verdicts.length, 2);
  assert.deepEqual(
    read.verdicts.map((row) => row.outcome),
    ["missed", "missed"]
  );
  assert.ok(read.verdicts[0].decided_on > read.verdicts[1].decided_on, "newest first");
  for (const row of read.verdicts) assert.match(row.decided_on, /^\d{4}-\d{2}-\d{2}$/);
});

test("the read is scoped to ONE lift — another lift's record never vouches for it", () => {
  recordLiftOutcome("Back Squat", "1", "not_aligned", { daysAgo: 30 });
  recordLiftOutcome("Back Squat", "2", "not_aligned", { daysAgo: 5 });
  recordLiftOutcome("Barbell Bench Press", "3", "aligned", { daysAgo: 10 });

  assert.deepEqual(
    liftLedgerRead("Back Squat").verdicts.map((row) => row.outcome),
    ["missed", "missed"]
  );
  const bench = liftLedgerRead("Barbell Bench Press");
  assert.deepEqual(bench.verdicts.map((row) => row.outcome), ["aligned"]);
  assert.equal(bench.informative, false, "one outcome of its own is still only one");
});

test("the lift name is matched without case being load-bearing", () => {
  recordLiftOutcome("Back Squat", "1", "aligned", { daysAgo: 30 });
  recordLiftOutcome("Back Squat", "2", "aligned", { daysAgo: 5 });
  assert.equal(liftLedgerRead("back squat").informative, true);
});

test("verdicts that have aged out of the window stop speaking for today", () => {
  recordLiftOutcome("Back Squat", "1", "not_aligned", { daysAgo: 400 });
  recordLiftOutcome("Back Squat", "2", "not_aligned", { daysAgo: 380 });
  const read = liftLedgerRead("Back Squat");
  assert.deepEqual(read.verdicts, []);
  assert.equal(read.informative, false);
});

test("a superseded decision's verdict is not the ledger's word on the lift", () => {
  recordLiftOutcome("Back Squat", "1", "not_aligned", { daysAgo: 30 });
  const later = recordLiftOutcome("Back Squat", "2", "not_aligned", { daysAgo: 5 });
  assert.equal(liftLedgerRead("Back Squat").informative, true);

  db.prepare(`UPDATE brain_decisions SET superseded_by = ? WHERE id = ?`).run(
    later.decision.id,
    // supersede the OLDER decision with the newer one
    db.prepare(`SELECT id FROM brain_decisions ORDER BY id LIMIT 1`).get().id
  );
  const read = liftLedgerRead("Back Squat");
  assert.equal(read.verdicts.length, 1, "the undone decision's outcome drops out");
  assert.equal(read.informative, false);
});

test("session feedback and joint pain never vouch for a lift's progression", () => {
  // Both are session-level safety floors written against whatever was trained that
  // day: they answer "did anything break?", not "is this lift's progression
  // working?", and folding them in would let a good week elsewhere speak for a squat.
  recordLiftOutcome("Back Squat", "1", "aligned", {
    daysAgo: 20,
    expectation: { metric_key: "session_performance_feedback", evaluator: "session_feedback", direction: "maintain" },
  });
  recordLiftOutcome("Back Squat", "2", "aligned", {
    daysAgo: 10,
    expectation: { metric_key: "joint_pain_or_soreness", evaluator: "symptom_load", direction: "avoid" },
  });
  assert.deepEqual(liftLedgerRead("Back Squat").verdicts, []);
});
