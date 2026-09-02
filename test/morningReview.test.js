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
  // The concept, not one literal: the kept-rest phrasing rotates by date and one
  // variant says "quiet day" instead of "rest".
  assert.match(review.passages[0], /rest|quiet day/i);
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

// ---------- naming the cause, and the streak that hands off to the trade ----------
// The live shape this closes: four straight quiet mornings trained through, every
// "easy" run finishing above the athlete's own easy ceiling, and a Brief that printed
// "you went past it — noted." The evidence that SELECTED that curt sentence was the
// one thing it never said.

const HARM_TABLES = [...LEDGER_TABLES, "garmin_activities", "garmin_sources", "activities", "checkins", "profile"];

function shiftDay(dateISO, days) {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

let harmSeq = 0;
function garminSourceId() {
  const existing = db.prepare(`SELECT id FROM garmin_sources LIMIT 1`).get();
  if (existing) return existing.id;
  harmSeq += 1;
  return Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run(`review-${harmSeq}`)
      .lastInsertRowid
  );
}

// A wearable run row only — what the HR model and the run-intensity read look at.
function logWatchRun({ date, minutes = 40, km = 8, avgHr = 145, maxHr = 172, teLabel = null }) {
  harmSeq += 1;
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, date, type, name, duration_min, moving_min, distance_km, avg_hr, max_hr, te_label)
     VALUES (?, ?, ?, 'running', 'Run', ?, ?, ?, ?, ?, ?)`
  ).run(garminSourceId(), `review-act-${harmSeq}`, date, minutes, minutes, km, avgHr, maxHr, teLabel);
}

// A run the day actually carries: an activities row (what harmEvidenceOnDay grades)
// joined to its wearable row, labelled as real intensity so bar (a) fires.
function logHardRun(date) {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 40, 8, 'test')`
      )
      .run(date).lastInsertRowid
  );
  harmSeq += 1;
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, type, name, duration_min, moving_min, distance_km, avg_hr, max_hr, te_label)
     VALUES (?, ?, ?, ?, 'running', 'Run', 40, 40, 8, 158, 172, 'tempo')`
  ).run(garminSourceId(), `review-hard-${harmSeq}`, activityId, date);
  return activityId;
}

// The same fixture athlete the run-intensity suite is built around: threshold 166,
// easy ceiling 148 bpm. Every basis run sits outside the 14-day window.
function seedEasyCeiling(anchor) {
  logWatchRun({ date: shiftDay(anchor, -20), minutes: 54, km: 11, avgHr: 163, maxHr: 179 });
  logWatchRun({ date: shiftDay(anchor, -26), minutes: 30, km: 6, avgHr: 152, maxHr: 180 });
  logWatchRun({ date: shiftDay(anchor, -40), minutes: 28, km: 5.5, avgHr: 147, maxHr: 179 });
  logWatchRun({ date: shiftDay(anchor, -55), minutes: 25, km: 5, avgHr: 143, maxHr: 174 });
  logWatchRun({ date: shiftDay(anchor, -70), minutes: 33, km: 6.5, avgHr: 146, maxHr: 176 });
  // A compressed fortnight: four runs, none of them easy.
  for (const days of [2, 5, 9, 12]) logWatchRun({ date: shiftDay(anchor, -days), avgHr: 158 });
}

// One quiet morning the athlete trained through, the run grading hard on intensity.
function seedOverriddenQuietMorning(date, kind = "easy") {
  repo.saveDayRead(date, read(kind));
  seedTrainingDay(date);
  db.prepare(`UPDATE sessions SET performance = 5 WHERE date = ?`).run(date);
  logHardRun(date);
}

test("a hard run behind a quiet read is NAMED as the cause, with the athlete's own ceiling", () => {
  resetTables(...HARM_TABLES);
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  seedEasyCeiling(yesterday);
  seedOverriddenQuietMorning(yesterday);

  const review = morningReview(today);
  assert.equal(review.passages.length, 1, "one morning is not yet a pattern");
  const passage = review.passages[0];
  // The cause, not the bare fact of divergence.
  assert.match(passage, /\brun\b/i, "the run is what the brain knew and never said");
  // The unlock, in the athlete's own measured ceiling — the one number allowed here.
  assert.match(passage, /148 bpm/);
  assert.doesNotMatch(passage, /\d+\s*(?:\/\s*100|%|points?|scores?)/i, "no grades, ever");
  assert.equal(violatesReadingGrammar(passage), null);
  assert.doesNotMatch(passage, /— noted\.$/, "the curt ledger entry is what this replaces");
});

test("with no heart-rate model there is no ceiling to name, and the cause is still spoken", () => {
  resetTables(...HARM_TABLES);
  const today = localDaysAgo(0);
  const yesterday = localDaysAgo(1);
  // No model basis at all: runIntensityDiscipline reports nothing, so no number.
  seedOverriddenQuietMorning(yesterday);

  const review = morningReview(today);
  assert.equal(review.passages.length, 1);
  assert.match(review.passages[0], /\brun\b/i);
  assert.doesNotMatch(review.passages[0], /\bbpm\b/, "a ceiling the model cannot speak is never invented");
  assert.equal(violatesReadingGrammar(review.passages[0]), null);
});

test("three quiet mornings trained through acknowledge the pattern and offer the trade", () => {
  resetTables(...HARM_TABLES);
  const today = localDaysAgo(0);
  seedEasyCeiling(localDaysAgo(1));
  for (const back of [1, 2, 3]) seedOverriddenQuietMorning(localDaysAgo(back));

  const review = morningReview(today);
  assert.equal(review.passages.length, 2, "the cause, and then the pattern");
  const [cause, pattern] = review.passages;
  assert.match(cause, /\brun\b/i);
  // The pattern is acknowledged in words, and it hands off to the rest trade.
  assert.match(pattern, /three/i);
  assert.match(pattern, /\btomorrow\b/i, "the streak's answer is the trade, not another note");
  // Never "noted" on the third morning — the plain set is the first-time set now.
  for (const passage of review.passages) {
    assert.doesNotMatch(passage, /— noted\.?$/);
    assert.equal(violatesReadingGrammar(passage), null);
    assert.doesNotMatch(passage, /\d+\s*(?:\/\s*100|%|points?|scores?)/i);
  }
});

test("a body-response day breaks the streak — the trade answers a rhythm, never physiology", () => {
  resetTables(...HARM_TABLES);
  const today = localDaysAgo(0);
  seedEasyCeiling(localDaysAgo(1));
  for (const back of [1, 2, 3]) seedOverriddenQuietMorning(localDaysAgo(back));
  // The middle morning came back rated poorly: that is the body answering, not a
  // rhythm the athlete is disagreeing with.
  db.prepare(`UPDATE sessions SET performance = 1 WHERE date = ?`).run(localDaysAgo(2));

  const review = morningReview(today);
  assert.equal(review.passages.length, 1, "the streak stops at the day the body spoke");
  assert.doesNotMatch(review.passages[0], /\btomorrow\b/i);
});

test("the cause-naming passages rotate across calendar days", () => {
  const seen = new Set();
  for (const back of [30, 29, 28, 27]) {
    resetTables(...HARM_TABLES);
    const today = localDaysAgo(back);
    const yesterday = shiftDay(today, -1);
    seedEasyCeiling(yesterday);
    seedOverriddenQuietMorning(yesterday);
    const review = morningReview(today);
    assert.equal(review.passages.length, 1);
    seen.add(review.passages[0]);
  }
  assert.ok(seen.size > 1, "a stable input across calendar days must not print one literal forever");
});
