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

// ---------------------------------------------------------------------------
// OBSERVE-TIER VERDICTS, AT REDUCED WEIGHT.
//
// The group filter used to read `decision_status !== "applied" → skip`, which on a
// live ledger threw away roughly three quarters of every conclusive verdict the
// evaluators had produced: advisory conference predictions and every other
// observe-tier decision were evaluated in full and then dropped at one line.
//
// They now count, at 0.4 each, with the observed class's total contribution to one
// comparable group capped at 2.0 effective observations:
//
//   effective_n = applied_n + min(observed_n × 0.4, 2.0)
//
// Everything below pins one consequence of that arithmetic, plus the two independent
// guards that keep observed evidence from ever buying a bigger step.

function observedOutcome(key, verdict, opts = {}) {
  return recordOutcome(key, verdict, {
    ...opts,
    decision: { status: "observed", applied_at: null, autonomy_tier: "observe", ...opts.decision },
  });
}

function nutritionModifier() {
  const learned = whatWorksForYou();
  return learned?.modifiers.find((modifier) => modifier.target === "nutrition_step") ?? null;
}

test("four observed verdicts are below the floor two applied ones clear", () => {
  // 4 × 0.4 = 1.6, under the effective-n floor of 2. Volume has to be real before it
  // speaks: an observed-only group needs FIVE outcomes to say what two applied ones do.
  for (const key of ["1", "2", "3", "4"]) observedOutcome(key, "not_aligned");
  assert.equal(whatWorksForYou(), null);

  observedOutcome("5", "not_aligned");
  const learned = whatWorksForYou();
  assert.ok(learned, "the fifth observed outcome reaches exactly 2.0 effective and qualifies");
  assert.equal(learned.learnings[0].evidence_n, 5);
});

test("a sixth observed verdict adds nothing — the cap is a real ceiling", () => {
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8"]) observedOutcome(key, "aligned");
  const learned = whatWorksForYou();
  assert.ok(learned);
  // min(8 × 0.4, 2.0) = 2.0, the same as five — so `strong` (which needs an effective
  // run of 4) stays permanently out of an observed-only group's reach. Volume cannot
  // manufacture certainty.
  assert.notEqual(learned.learnings[0].confidence, "strong");
});

test("three applied verdicts outweigh thirty observed ones", () => {
  // The swamping case the cap exists for: 30 × 0.4 would be 12.0 unbounded, against
  // 3.0 for the applied history. Capped, the observed side contributes 2.0 and the
  // applied evidence is the majority of the group it sits in.
  for (let i = 0; i < 30; i++) observedOutcome(`obs${i}`, "aligned");
  for (const key of ["a", "b", "c"]) recordOutcome(key, "not_aligned");

  const modifier = nutritionModifier();
  assert.ok(modifier, "the group qualifies");
  assert.equal(modifier.scale, 1.15, "the applied misses still set the learned default");
  assert.equal(modifier.bounds.max, 1.15, "and the group is not observed-only, so its ceiling is untouched");
});

test("observed evidence softens the next step and can never enlarge it", () => {
  // Five observed MISSES on a nutrition group. The miss scale for this shape is 1.15 —
  // a push — and the observed-only ceiling pulls it back to the universal default,
  // which leaves nothing to say, so no modifier is admitted at all.
  for (const key of ["1", "2", "3", "4", "5"]) observedOutcome(key, "not_aligned");
  const learned = whatWorksForYou();
  assert.ok(learned, "the learning is visible");
  assert.equal(learned.learnings[0].metric_key, "weight_trend_lb_wk");
  assert.equal(nutritionModifier(), null, "an observed-only group cannot hand out a bigger step");

  // …while the SOFTENING half is untouched: the same evidence on a lever whose miss
  // scale eases still eases, at full strength.
  db.prepare(`DELETE FROM brain_evaluations`).run();
  db.prepare(`DELETE FROM brain_expectations`).run();
  db.prepare(`DELETE FROM brain_decisions`).run();
  for (const key of ["6", "7", "8", "9", "10"]) {
    observedOutcome(key, "not_aligned", {
      expectation: {
        metric_key: "exercise_target_completion",
        evaluator: "exercise_completion",
        direction: "complete",
        baseline: { sets: 3 },
        target: { rate: 0.8 },
      },
      actual: { value: 0.4, completion_rate: 0.4, exposures: 5 },
    });
  }
  const training = whatWorksForYou().modifiers.find((item) => item.target === "training_progression_step");
  assert.ok(training);
  assert.equal(training.scale, 0.9, "easing keeps its full power — the asymmetry is the point");
  assert.equal(training.bounds.min, 0.9);
});

test("observed-only aligned verdicts never earn the acceleration applied ones do", () => {
  // Five aligned observed outcomes on the one training metric that CAN accelerate,
  // with nothing missed and no symptom on record: every condition except the one that
  // matters is met.
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "aligned", {
      expectation: {
        metric_key: "exercise_target_completion",
        evaluator: "exercise_completion",
        direction: "complete",
        baseline: { sets: 3 },
        target: { rate: 0.8 },
      },
      actual: { value: 1, completion_rate: 1, exposures: 5 },
    });
  }
  const learned = whatWorksForYou();
  assert.ok(
    learned.learnings.some((item) => item.metric_key === "exercise_target_completion"),
    "the learning is real and visible as prose"
  );
  assert.equal(
    learned.modifiers.find((item) => item.target === "training_progression_step"),
    undefined,
    "but headroom is bought by a change the athlete actually made, so no lever moves"
  );
});

test("a floor consumer cannot be accelerated by observed-only evidence", () => {
  // The end-to-end half of the same guarantee, read through the clamp the consumers
  // actually apply. The only observed-only modifier that exists at all is one that
  // softens, and its declared ceiling is the universal default — so base × scale can
  // never come out above the base, even if the scale itself is tampered with.
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "not_aligned", {
      expectation: {
        metric_key: "exercise_target_completion",
        evaluator: "exercise_completion",
        direction: "complete",
        baseline: { sets: 3 },
        target: { rate: 0.8 },
      },
      actual: { value: 0.4, completion_rate: 0.4, exposures: 5 },
    });
  }
  const modifier = whatWorksForYou().modifiers.find((item) => item.target === "training_progression_step");
  assert.ok(modifier, "the softening reading is admitted");
  assert.equal(applyPersonalResponseModifier({ base: 10, modifier, max: 20 }), 9);
  // …and a modifier that lies about its own scale is still clamped by its bounds.
  const forged = { ...modifier, scale: 1.4 };
  assert.equal(applyPersonalResponseModifier({ base: 10, modifier: forged, max: 20 }), 10);
});

test("an inert observed-only reading of one lift never shadows an applied whole-athlete ease", () => {
  // The shadowing case the admission rule exists for: trainingModifierFor prefers a
  // subject-specific modifier over the whole-athlete one, so an observed-only "carry
  // on as normal" reading of the squat would otherwise displace an applied session-
  // feedback reading that says ease — and the squat would silently lose the ease.
  recordOutcome("g1", "not_aligned", {
    expectation: {
      metric_key: "session_performance_feedback",
      evaluator: "session_feedback",
      direction: "maintain",
      baseline: { rating: 3 },
      target: { rating: "okay_or_better" },
    },
    actual: { value: 2, sessions: 6 },
  });
  recordOutcome("g2", "not_aligned", {
    expectation: {
      metric_key: "session_performance_feedback",
      evaluator: "session_feedback",
      direction: "maintain",
      baseline: { rating: 3 },
      target: { rating: "okay_or_better" },
    },
    actual: { value: 2, sessions: 6 },
  });
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "aligned", {
      expectation: {
        metric_key: "exercise_target_completion",
        subject_key: "Back Squat",
        evaluator: "exercise_completion",
        direction: "complete",
        baseline: { sets: 3 },
        target: { rate: 0.8 },
      },
      actual: { value: 1, completion_rate: 1, exposures: 5 },
    });
  }

  const learned = whatWorksForYou();
  const training = learned.modifiers.filter((item) => item.target === "training_progression_step");
  assert.equal(training.length, 1, "only the applied reading claims the training slot");
  assert.equal(training[0].subject_key, null);
  assert.equal(training[0].scale, 0.9, "…so the ease still reaches every lift, the squat included");
});

test("one applied verdict plus observed ones reaches the floor, but not the acceleration bar", () => {
  // 1 + (3 × 0.4) = 2.2 effective, so the group qualifies where one applied outcome
  // alone would not. The acceleration branch counts APPLIED outcomes in the run and
  // sees exactly one, which is under its bar of two.
  recordOutcome("1", "aligned", {
    expectation: {
      metric_key: "exercise_target_completion",
      evaluator: "exercise_completion",
      direction: "complete",
      baseline: { sets: 3 },
      target: { rate: 0.8 },
    },
    actual: { value: 1, completion_rate: 1, exposures: 5 },
  });
  for (const key of ["2", "3", "4"]) {
    observedOutcome(key, "aligned", {
      expectation: {
        metric_key: "exercise_target_completion",
        evaluator: "exercise_completion",
        direction: "complete",
        baseline: { sets: 3 },
        target: { rate: 0.8 },
      },
      actual: { value: 1, completion_rate: 1, exposures: 5 },
    });
  }
  const modifier = whatWorksForYou().modifiers.find((item) => item.target === "training_progression_step");
  assert.ok(modifier, "the mixed group qualifies on effective evidence");
  assert.equal(modifier.scale, 1, "…and one applied outcome is still one, however much observed evidence surrounds it");
  assert.equal(
    modifier.bounds.max,
    1,
    "the ceiling follows the row the scale came from, and the latest row here was observed"
  );
  assert.equal(modifier.observed_only, false, "…while the modifier still reports its mixed provenance honestly");
});

test("observed misses in a group holding an applied outcome cannot deepen a cut step", () => {
  // THE MIXED-GROUP LEAK, and the reason the no-push clamp is scoped to the ROW the
  // scale comes from rather than to the group. One applied outcome makes the group
  // non-observed-only; the three observed misses that follow are what `latest` and the
  // run point at, so the miss scale (1.15 for this shape — a PUSH, which for a cut
  // step means a deeper deficit) is authored entirely by decisions nobody made.
  recordOutcome("applied-1", "aligned", { actual: { value: -0.5, weigh_ins: 8 } });
  for (const key of ["1", "2", "3"]) observedOutcome(key, "not_aligned");

  const modifier = nutritionModifier();
  assert.ok(modifier, "the group still qualifies — 1 + (3 × 0.4) = 2.2 effective");
  assert.equal(modifier.scale, 1, "but the push is refused: no applied outcome authored it");
  assert.equal(modifier.bounds.max, 1, "and the ceiling handed to the consumer says so");
  assert.equal(
    applyPersonalResponseModifier({ base: 200, modifier, min: 100, max: 250 }),
    200,
    "so the kcal step the nutrition consumer computes is untouched"
  );
});

test("an applied outcome at the head of a mixed group keeps its full authority", () => {
  // The other side of the row-scoping rule: when the LATEST outcome is one the athlete
  // actually made, the modifier it authors is not hobbled by observed company.
  for (const key of ["1", "2", "3"]) observedOutcome(key, "not_aligned");
  recordOutcome("applied-1", "not_aligned");

  const modifier = nutritionModifier();
  assert.ok(modifier);
  assert.equal(modifier.scale, 1.15, "an applied miss still moves the step it always moved");
  assert.equal(modifier.bounds.max, 1.15);
});

test("the cautious direction is not the same direction for every target", () => {
  // recovery_adjustment sizes the RECOVERY response, so its careful direction is UP —
  // buildRecoveryMenu reads >1 as "offer the quieter menu" and ignores anything at or
  // below 1. Clamping every observed-tier ceiling to 1.0 would have deleted the only
  // direction this target can safely move in.
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "not_aligned", {
      decision: { kind: "recovery_adjustment", domain: "recovery" },
      expectation: {
        metric_key: "recovery_hrv_delta",
        evaluator: "recovery_delta",
        direction: "at_least",
        baseline: { hrv_avg_ms: 60, nights: 10 },
        target: { value: -6 },
      },
      actual: { value: -12, nights: 10 },
    });
  }
  const modifier = whatWorksForYou().modifiers.find((item) => item.target === "recovery_adjustment");
  assert.ok(modifier, "the observed-tier recovery reading is admitted");
  assert.equal(modifier.scale, 1.1, "…and keeps the raise that means MORE recovery");
  assert.equal(modifier.bounds.min, 1, "the clamp took the bold direction — down — not the careful one");
  assert.equal(modifier.bounds.max, 1.15, "so the careful direction is left intact");
});

test("confounded and superseded observed verdicts stay excluded exactly as before", () => {
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "not_aligned", { confounders: ["illness"] });
  }
  assert.equal(whatWorksForYou(), null, "a confounded outcome is not evidence, whatever tier recorded it");

  const superseding = observedOutcome("6", "not_aligned");
  db.prepare(`UPDATE brain_decisions SET superseded_by = ? WHERE superseded_by IS NULL AND id <> ?`).run(
    superseding.decision.id,
    superseding.decision.id
  );
  assert.equal(whatWorksForYou(), null);
});

test("decisions the athlete refused are not evidence about how they respond", () => {
  for (const key of ["1", "2", "3", "4", "5"]) {
    observedOutcome(key, "not_aligned", { decision: { status: "rejected" } });
  }
  assert.equal(whatWorksForYou(), null, "only applied and observed decisions carry weight");
});

test("an applied group keeps exactly the behaviour it had before observed rows counted", () => {
  // The regression guard on the whole change: two applied misses still earn 1.15 with
  // `observed` confidence and an untouched 1.15 ceiling.
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");
  const modifier = nutritionModifier();
  assert.equal(modifier.scale, 1.15);
  assert.deepEqual(modifier.bounds, { min: 0.85, max: 1.15 });
  assert.equal(modifier.confidence, "observed");
});

// ---------------------------------------------------------------------------
// WHAT THE ATHLETE IS TOLD IT LEARNED FROM.
//
// Every count on a learning used to be a raw total, and the surfaces that render it
// said "comparable decisions" about all of them. Once outcomes on decisions the app
// only WEIGHED started counting, that sentence began claiming the athlete had made
// changes they never made — a sentence outrunning its evidence.

test("a learning says how many of its outcomes judged a change actually made", () => {
  for (const key of ["1", "2", "3", "4", "5"]) observedOutcome(key, "not_aligned");
  const learning = whatWorksForYou().learnings[0];
  assert.equal(learning.applied_n, 0);
  assert.equal(learning.observed_only, true);
  assert.match(learning.statement, /weighed but did not make/i, "and words itself accordingly");
  assert.doesNotMatch(learning.statement, /comparable decision/i);
});

test("a mixed run names the part of itself that was never enacted", () => {
  // 1 + (3 × 0.4) = 2.2 effective, so the group qualifies and the run is genuinely mixed.
  recordOutcome("applied-1", "not_aligned");
  for (const key of ["1", "2", "3"]) observedOutcome(key, "not_aligned");
  const learning = whatWorksForYou().learnings[0];
  assert.equal(learning.applied_n, 1);
  assert.equal(learning.observed_only, false);
  assert.match(learning.statement, /4 comparable decisions, 3 of them weighed but not made/i);
});

test("an all-applied learning keeps the sentence it always had", () => {
  recordOutcome("1", "not_aligned");
  recordOutcome("2", "not_aligned");
  const learning = whatWorksForYou().learnings[0];
  assert.equal(learning.applied_n, 2);
  assert.equal(learning.observed_only, false);
  assert.match(learning.statement, /across 2 comparable decisions/i);
});

// A flagged marker already has its own surface (Connections) and its outcomes move no
// lever from here — modifierFor returns null for the clinical metrics they carry. What
// admitting them did was spend the four learned slots on the one story the athlete can
// already read in full elsewhere.
test("health-directive outcomes never occupy the athlete-facing learned slots", () => {
  for (const key of ["1", "2", "3", "4"]) {
    recordOutcome(key, "aligned", {
      decision: { kind: "health_directive", domain: "health" },
      expectation: {
        metric_key: "marker_direction",
        subject_key: "hs-CRP",
        evaluator: "marker_direction",
        direction: "at_most",
        baseline: { value: 3.1 },
        target: { max: 2 },
      },
      actual: { value: 1.4, draws: 2 },
    });
  }
  assert.equal(whatWorksForYou(), null, "nothing reaches the learned list from a directive");
});

// One volume raise writes THREE recovery guards against the same event, and a hard
// week resolves all three the same way. The modifier map has always deduped them (one
// slot per target); the prose list had no such rule, so three of the four learned
// lines would tell the athlete the same thing in three vocabularies.
test("the three recovery guards on one raise spend one prose slot, not three", () => {
  const recoveryOutcome = (key, metric) =>
    recordOutcome(key, "not_aligned", {
      decision: { kind: "recovery_adjustment", domain: "recovery" },
      expectation: {
        metric_key: metric,
        evaluator: "recovery_delta",
        direction: "at_least",
        baseline: { nights: 10 },
        target: { value: -6 },
      },
      actual: { value: -12, nights: 10 },
    });
  for (const metric of ["recovery_hrv_delta", "recovery_rhr_delta", "sleep_duration_delta"]) {
    recoveryOutcome(`${metric}-1`, metric);
    recoveryOutcome(`${metric}-2`, metric);
  }

  const learned = whatWorksForYou();
  const recovery = learned.learnings.filter((item) =>
    ["recovery_hrv_delta", "recovery_rhr_delta", "sleep_duration_delta"].includes(item.metric_key)
  );
  assert.equal(recovery.length, 1, "one story, one sentence");
  assert.equal(
    learned.modifiers.filter((item) => item.target === "recovery_adjustment").length,
    1,
    "…which is the rule the modifier map already had"
  );
});
