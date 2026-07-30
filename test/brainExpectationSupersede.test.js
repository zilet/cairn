import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpectation, evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import {
  getBrainDecision,
  getBrainExpectation,
  insertBrainExpectation,
  listBrainExpectations,
  recordDecision,
} from "../dist/repo/brain-decisions.js";
import { latestBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { MIGRATIONS } from "../dist/migrate.js";
import { db } from "../dist/db.js";

const LIFT = "Bulgarian Split Squat";
const OVERLAP_CONFOUNDER = /also targeted this outcome/;

function decision(seed, overrides = {}) {
  return {
    effective_date: "2026-01-01",
    kind: "training_target",
    domain: "training",
    summary: `Bounded training change ${seed}.`,
    rationale: "A bounded change makes the response measurable.",
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { seed }, // distinct action -> a distinct fingerprint per seed
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

// A completion expectation with every OTHER source of doubt switched off, so the
// only thing that can hold a verdict back is an overlapping window.
function completion(overrides = {}) {
  return {
    metric_key: "exercise_target_completion",
    subject_key: LIFT,
    direction: "complete",
    baseline: null,
    target: { value: 1 },
    window_start: "2026-01-01",
    window_end: "2026-01-15",
    minimum_data: null,
    confounder_policy: "none",
    confidence: "tentative",
    evaluator: "exercise_completion",
    evaluator_version: "test-v1",
    ...overrides,
  };
}

// One logged set of the tracked lift, so the completion evaluator has real evidence.
function logLift(date) {
  const exercise = db.prepare(`SELECT id FROM exercises WHERE name = ?`).get(LIFT);
  const exerciseId =
    exercise?.id ??
    Number(db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES (?, 'legs')`).run(LIFT).lastInsertRowid);
  const sessionId = Number(db.prepare(`INSERT INTO sessions (date, kind) VALUES (?, 'strength')`).run(date).lastInsertRowid);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 95, 8)`).run(
    sessionId,
    exerciseId
  );
}

function statusOf(expectation) {
  return getBrainExpectation(Number(expectation.id)).status;
}

const arbitrate = () => MIGRATIONS.find((entry) => entry.version === 87).up(db);

// A window written the way the ledger wrote them BEFORE supersede-on-write existed:
// straight to the table, with no arbitration. Everything the repair migration has to
// clean up on the live deployment has this shape.
function legacyExpectation(windowStart, windowEnd, overrides = {}) {
  const decisionId =
    overrides.decision_id ??
    Number(
      recordDecision(
        decision(`legacy-${windowStart}-${windowEnd}-${overrides.subject_key ?? LIFT}`, {
          ...(overrides.decision_status ? { status: overrides.decision_status, applied_at: null } : {}),
        }),
        []
      ).decision.id
    );
  const proposed = completion({ window_start: windowStart, window_end: windowEnd, ...overrides });
  const info = db
    .prepare(
      `INSERT INTO brain_expectations
         (decision_id, metric_key, subject_key, direction, baseline_json, target_json, window_start,
          window_end, minimum_data_json, confounder_policy, confidence, status, evaluator, evaluator_version)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    )
    .run(
      decisionId,
      proposed.metric_key,
      proposed.subject_key,
      proposed.direction,
      JSON.stringify(proposed.target),
      proposed.window_start,
      proposed.window_end,
      proposed.confounder_policy,
      proposed.confidence,
      overrides.status ?? "pending",
      proposed.evaluator,
      proposed.evaluator_version
    );
  return getBrainExpectation(Number(info.lastInsertRowid));
}

function liveCompletionIds() {
  return listBrainExpectations({ limit: 200 })
    .filter(
      (row) =>
        row.metric_key === "exercise_target_completion" &&
        row.subject_key === LIFT &&
        (row.status === "pending" || row.status === "mature")
    )
    .map((row) => Number(row.id));
}

function statusSnapshot() {
  return listBrainExpectations({ limit: 200 }).map((row) => `${row.id}:${row.status}`);
}

test("a newer overlapping window retires the older one, and then earns a real verdict", () => {
  logLift("2026-01-10");

  const first = recordDecision(decision("first"), [completion()]);
  const second = recordDecision(decision("second", { effective_date: "2026-01-08" }), [
    completion({ window_start: "2026-01-08", window_end: "2026-01-22" }),
  ]);

  assert.equal(statusOf(first.expectations[0]), "superseded", "the older window stepped aside");
  assert.equal(statusOf(second.expectations[0]), "pending", "the newest change owns the metric");

  const evaluation = evaluateExpectation(
    getBrainExpectation(Number(second.expectations[0].id)),
    getBrainDecision(Number(second.decision.id)),
    "2026-01-22"
  );
  assert.deepEqual(evaluation.confounders, [], "no overlapping-window confounder survives the supersede");
  assert.equal(evaluation.verdict, "aligned", "the surviving window reaches a real verdict");

  // The nightly sweep never spends budget on, or writes a verdict for, a retired window.
  const sweep = evaluateMatureExpectations("2026-01-22");
  assert.equal(sweep.evaluated, 1, "only the live window was evaluated");
  assert.equal(latestBrainEvaluation(Number(first.expectations[0].id)), null, "the retired window has no verdict");
  assert.equal(latestBrainEvaluation(Number(second.expectations[0].id)).verdict, "aligned");
});

test("superseded windows do not confound the survivor", () => {
  logLift("2026-01-10");

  // Three applied decisions all reaching for the same metric in one overlapping span.
  // Without the status filter on the confounder query, the last one would still see the
  // two retired rows and be forced inconclusive — the exact annihilation this fixes.
  const first = recordDecision(decision("a"), [completion()]);
  const second = recordDecision(decision("b"), [completion({ window_start: "2026-01-05", window_end: "2026-01-19" })]);
  const third = recordDecision(decision("c"), [completion({ window_start: "2026-01-08", window_end: "2026-01-22" })]);

  assert.equal(statusOf(first.expectations[0]), "superseded");
  assert.equal(statusOf(second.expectations[0]), "superseded");
  assert.equal(statusOf(third.expectations[0]), "pending");

  const evaluation = evaluateExpectation(
    getBrainExpectation(Number(third.expectations[0].id)),
    getBrainDecision(Number(third.decision.id)),
    "2026-01-22"
  );
  assert.equal(
    evaluation.confounders.filter((line) => OVERLAP_CONFOUNDER.test(line)).length,
    0,
    "retired rows are not confounders"
  );
  assert.equal(evaluation.verdict, "aligned");
});

test("a live overlapping window on another decision still confounds", () => {
  logLift("2026-01-10");

  const older = recordDecision(decision("older"), [completion()]);
  recordDecision(decision("newer"), [completion({ window_start: "2026-01-08", window_end: "2026-01-22" })]);

  // The RETIRED row is the one that loses its verdict, and it loses it by being
  // retired — not by silently going inconclusive. Asking anyway still reports the
  // live rival, so the confounder rule itself is intact.
  const evaluation = evaluateExpectation(
    getBrainExpectation(Number(older.expectations[0].id)),
    getBrainDecision(Number(older.decision.id)),
    "2026-01-22"
  );
  assert.ok(
    evaluation.confounders.some((line) => OVERLAP_CONFOUNDER.test(line)),
    "a live rival window is still reported"
  );
  assert.equal(evaluation.verdict, "inconclusive");
});

test("different metrics, different subjects and disjoint windows are left alone", () => {
  db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Romanian Deadlift', 'legs')`).run();

  const base = recordDecision(decision("base"), [completion()]);
  const otherMetric = recordDecision(decision("other-metric"), [
    completion({ metric_key: "exercise_est_1rm_trend", direction: "increase", evaluator: "exercise_est_1rm" }),
  ]);
  const otherSubject = recordDecision(decision("other-subject"), [completion({ subject_key: "Romanian Deadlift" })]);
  const disjoint = recordDecision(decision("disjoint"), [
    completion({ window_start: "2026-01-16", window_end: "2026-01-30" }),
  ]);

  for (const recorded of [base, otherMetric, otherSubject, disjoint]) {
    assert.equal(statusOf(recorded.expectations[0]), "pending");
  }
});

test("two windows on the SAME decision are untouched — they never confounded each other", () => {
  const recorded = recordDecision(decision("same"), [
    completion(),
    completion({ window_start: "2026-01-08", window_end: "2026-01-22" }),
  ]);
  assert.equal(recorded.expectations.length, 2);
  for (const expectation of recorded.expectations) assert.equal(statusOf(expectation), "pending");
});

test("an advisory prediction neither supersedes a real change nor is retired by one", () => {
  // A held/advisory conference records its predictions on a `review` decision. Those
  // windows do not confound anything and nothing has happened for them to lose to, so
  // arbitration must not touch either side.
  const advisory = recordDecision(
    decision("advisory", { status: "review", autonomy_tier: "ask", applied_at: null, reversible: false }),
    [completion()]
  );
  const applied = recordDecision(decision("real"), [
    completion({ window_start: "2026-01-08", window_end: "2026-01-22" }),
  ]);

  assert.equal(statusOf(advisory.expectations[0]), "pending", "an advisory window is not retired by a real change");
  assert.equal(statusOf(applied.expectations[0]), "pending", "an advisory window does not retire a real change");
});

test("a thawed prediction never resurrects over a newer live window", () => {
  // A parked prediction thaws onto the decision that finally applied the change, with
  // its window re-based. Whichever window STARTS later owns the metric, both ways.
  const live = recordDecision(decision("live"), [
    completion({ window_start: "2026-01-10", window_end: "2026-01-24" }),
  ]);
  const applyRow = recordDecision(decision("thaw-host"), []);

  const stale = insertBrainExpectation(
    Number(applyRow.decision.id),
    completion({ window_start: "2026-01-05", window_end: "2026-01-19" })
  );
  assert.equal(stale.status, "superseded", "a window thawed behind a newer one arrives retired");
  assert.equal(statusOf(live.expectations[0]), "pending", "the newer live window is untouched");

  const fresh = insertBrainExpectation(
    Number(applyRow.decision.id),
    completion({ window_start: "2026-01-12", window_end: "2026-01-26" })
  );
  assert.equal(fresh.status, "pending", "a window thawed onto today takes the metric over");
  assert.equal(statusOf(live.expectations[0]), "superseded", "and retires the one it overtook");

  const liveRows = listBrainExpectations({ limit: 100 }).filter(
    (row) => row.metric_key === "exercise_target_completion" && (row.status === "pending" || row.status === "mature")
  );
  assert.equal(liveRows.length, 1, "exactly one live window per metric and subject");
  assert.equal(Number(liveRows[0].id), Number(fresh.id));
});

test("the newest window survives a whole legacy stack, not just the one it was compared against", () => {
  // Rows written BEFORE the rule existed can stand two-deep, which is the case the
  // predecessor's pairwise "compare against the newest rival" pass got wrong: the
  // arriving row lost to the newest rival and returned, leaving the OTHER stale rival
  // live beside it. Two live windows still annihilate each other.
  const older = legacyExpectation("2026-01-01", "2026-01-15");
  const newest = legacyExpectation("2026-01-05", "2026-01-19");

  const arriving = insertBrainExpectation(
    Number(recordDecision(decision("arriving"), []).decision.id),
    completion({ window_start: "2026-01-03", window_end: "2026-01-17" })
  );

  assert.equal(statusOf(arriving), "superseded", "the arriving window lost to a newer one");
  assert.equal(statusOf(older), "superseded", "and the one IT overtook was retired in the same pass");
  assert.equal(statusOf(newest), "pending");
  assert.equal(liveCompletionIds().length, 1, "exactly one live window per metric and subject");
});

// ---------- migration 87: the same rule, applied to rows that predate it ----------

test("migration 87 keeps exactly one live window per overlapping stack", () => {
  // A live-Pi shape: several applied decisions stacked on one lift over one span.
  const first = legacyExpectation("2026-01-01", "2026-01-15");
  const second = legacyExpectation("2026-01-05", "2026-01-19");
  const third = legacyExpectation("2026-01-08", "2026-01-22");
  // Untouched neighbours: a different subject, and a window that starts after the stack ends.
  const otherSubject = legacyExpectation("2026-01-05", "2026-01-19", { subject_key: "Romanian Deadlift" });
  const disjoint = legacyExpectation("2026-01-23", "2026-02-06");

  // Four live windows on this lift going in — the three-deep stack plus the disjoint one.
  assert.equal(liveCompletionIds().length, 4, "the stack really is stacked before the repair");

  arbitrate();

  assert.equal(statusOf(first), "superseded");
  assert.equal(statusOf(second), "superseded");
  assert.equal(statusOf(third), "pending", "the newest window in the stack owns the metric");
  assert.equal(statusOf(otherSubject), "pending", "a different subject is a different question");
  assert.equal(statusOf(disjoint), "pending", "a non-overlapping window never competed");
  assert.deepEqual(
    liveCompletionIds().sort((a, b) => a - b),
    [Number(third.id), Number(disjoint.id)].sort((a, b) => a - b),
    "one live window per overlapping span, and the disjoint span keeps its own"
  );
});

test("migration 87 is idempotent", () => {
  legacyExpectation("2026-01-01", "2026-01-15");
  legacyExpectation("2026-01-05", "2026-01-19");
  const newest = legacyExpectation("2026-01-08", "2026-01-22");

  const before = statusSnapshot();
  arbitrate();
  const afterFirst = statusSnapshot();
  // Guard the guard: without this, "twice equals once" would also hold for a
  // migration that did nothing at all.
  assert.notDeepEqual(afterFirst, before, "the first pass really did repair the stack");
  assert.deepEqual(liveCompletionIds(), [Number(newest.id)]);

  arbitrate();
  assert.deepEqual(statusSnapshot(), afterFirst, "a second pass finds no pairs and changes nothing");

  arbitrate();
  assert.deepEqual(statusSnapshot(), afterFirst);
});

test("migration 87 leaves alone what never confounded", () => {
  // Only applied/announced decisions arbitrate. An advisory `review` record and an
  // already-evaluated window are both outside the rule, and a stack on ONE decision was
  // never in it either — the confounder query has always excluded same-decision rows.
  const advisory = legacyExpectation("2026-01-01", "2026-01-15", { decision_status: "review" });
  const advisoryRival = legacyExpectation("2026-01-08", "2026-01-22", { decision_status: "review" });
  const evaluated = legacyExpectation("2026-01-02", "2026-01-16", { status: "evaluated" });

  const sharedDecisionId = Number(recordDecision(decision("one-decision-two-windows"), []).decision.id);
  const twinA = legacyExpectation("2026-01-01", "2026-01-15", { decision_id: sharedDecisionId });
  const twinB = legacyExpectation("2026-01-06", "2026-01-20", { decision_id: sharedDecisionId });

  arbitrate();

  assert.equal(statusOf(advisory), "pending", "an advisory prediction is not arbitrated");
  assert.equal(statusOf(advisoryRival), "pending");
  assert.equal(statusOf(evaluated), "evaluated", "a window that already answered is not retired");
  assert.equal(statusOf(twinA), "pending", "two windows on one decision never competed");
  assert.equal(statusOf(twinB), "pending");
});
