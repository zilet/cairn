// The morning wake-up review (W4.7) — a short past-tense passage the Brief shows
// above today's suggestion. These cases pin the deterministic builder: divergence
// from yesterday's morning read spoken with curiosity, a kept quiet day spoken
// positively, a landed brain_expectation spoken as a win, and silence when
// yesterday was genuinely unremarkable.
import assert from "node:assert/strict";
import test from "node:test";
import { db, repo, resetTables, localDaysAgo, seedTrainingDay } from "./_seed.js";
import { morningReview } from "../dist/repo/brain/morning-review.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

const LEDGER_TABLES = [
  "brain_evaluations",
  "brain_expectations",
  "brain_decisions",
  "day_reads",
  "suggestions",
  "sessions",
  "logged_sets",
  "activities",
];

function reset() {
  resetTables(...LEDGER_TABLES);
}

function read(kind, extra = {}) {
  return {
    kind,
    headline: `${kind} today.`,
    why: "A calm sentence about the day.",
    focus: null,
    est_minutes: kind === "rest" ? null : 45,
    signals: {},
    source: "deterministic",
    override: null,
    ...extra,
  };
}

// Seeds a matured, aligned brain_expectation for `windowEnd` on the given
// metric, so landedWin() has a real ledger row to read back — never a fabricated
// win, the same evidence the ledger itself would surface elsewhere.
function seedLandedExpectation(metricKey, windowEnd, evaluator = "recovery_delta") {
  const { decision, expectations } = recordDecision(
    {
      effective_date: windowEnd,
      kind: "recovery_adjustment",
      domain: "recovery",
      summary: "Reduced week",
      rationale: null,
      source: "deterministic",
      source_ref_type: null,
      source_ref_key: null,
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      context: null,
      action: null,
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    },
    [
      {
        metric_key: metricKey,
        subject_key: "test",
        direction: "increase",
        baseline: null,
        target: { value: 1 },
        window_start: windowEnd,
        window_end: windowEnd,
        minimum_data: null,
        confounder_policy: "standard",
        confidence: "tentative",
        evaluator,
        evaluator_version: "test-v1",
      },
    ]
  );
  const expectationId = expectations[0].id;
  insertBrainEvaluation({
    expectation_id: expectationId,
    verdict: "aligned",
    actual: { value: 2 },
    evidence_keys: ["value"],
    confounders: [],
    explanation: "test evaluation",
    evaluator_version: "test-v1",
  });
  return { decision, expectationId };
}

test("an unremarkable yesterday (nothing predicted, nothing landed) returns nothing", () => {
  reset();
  const today = localDaysAgo(0);
  const review = morningReview(today);
  assert.deepEqual(review, { passages: [], win: null });
});

test("a kept rest day is spoken positively, with no guilt", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  repo.saveDayRead(yesterday, read("rest"));

  const review = morningReview(today);
  assert.equal(review.passages.length, 1);
  assert.match(review.passages[0], /rest/i);
  assert.doesNotMatch(review.passages[0], /you didn't train|failed|missed/i);
  assert.equal(violatesReadingGrammar(review.passages[0]), null);
});

test("a rest read overridden without harm is spoken with curiosity, not judgment", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  repo.saveDayRead(yesterday, read("rest"));
  seedTrainingDay(yesterday);
  db.prepare(`UPDATE sessions SET performance = 5 WHERE date = ?`).run(yesterday);

  const review = morningReview(today);
  assert.equal(review.passages.length, 1);
  assert.match(review.passages[0], /rest/i);
  // Curiosity, not judgment: each phrasing either notes the divergence or says it
  // cost nothing / landed fine — the concept, since the word rotates by date.
  assert.match(review.passages[0], /noted|cost|landed fine/i);
  assert.doesNotMatch(review.passages[0], /you must|do not train|forbidden/i);
  assert.equal(violatesReadingGrammar(review.passages[0]), null);
});

test("a train read is never spoken about either way — only rest/easy carry a passage", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  repo.saveDayRead(yesterday, read("train", { focus: "Lower" }));
  // Neither followed (trained) nor missed produces a passage.
  const reviewMissed = morningReview(today);
  assert.equal(reviewMissed.passages.length, 0);

  seedTrainingDay(yesterday);
  const reviewFollowed = morningReview(today);
  assert.equal(reviewFollowed.passages.length, 0);
});

test("a landed expectation speaks as the earned win, grammar-clean", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  seedLandedExpectation("recovery_hrv_delta", yesterday);

  const review = morningReview(today);
  assert.equal(typeof review.win, "string");
  assert.match(review.win, /hrv/i);
  assert.equal(violatesReadingGrammar(review.win), null);
});

test("the read-adherence expectation's own maturity never double-counts as a win", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  repo.saveDayRead(yesterday, read("rest"));
  seedLandedExpectation("day_read_adherence", yesterday, "day_read_adherence");

  const review = morningReview(today);
  // day_read_adherence is excluded from landedWin — it is the SAME fact the
  // day-comparison passage already speaks, in its own voice.
  assert.equal(review.win, null);
});

test("passages and a win combine on a genuinely rich yesterday", () => {
  reset();
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  repo.saveDayRead(yesterday, read("easy"));
  seedTrainingDay(yesterday);
  db.prepare(`UPDATE sessions SET performance = 4 WHERE date = ?`).run(yesterday);
  seedLandedExpectation("vo2max_trend", yesterday, "vo2max_trend");

  const review = morningReview(today);
  assert.equal(review.passages.length, 1);
  assert.match(review.passages[0], /easy/i);
  assert.ok(review.win);
  for (const sentence of [...review.passages, review.win]) {
    assert.equal(violatesReadingGrammar(sentence), null);
  }
});

test("variant sentences rotate across dates for the same shape of morning", () => {
  reset();
  const dates = [localDaysAgo(30), localDaysAgo(29), localDaysAgo(28), localDaysAgo(27), localDaysAgo(26)];
  const seen = new Set();
  for (const today of dates) {
    reset();
    const yesterday = (() => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    repo.saveDayRead(yesterday, read("rest"));
    const review = morningReview(today);
    assert.equal(review.passages.length, 1);
    seen.add(review.passages[0]);
  }
  assert.ok(seen.size > 1, "a stable input across different calendar days should not print one literal forever");
});
