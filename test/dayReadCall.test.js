// THE VERDICT JUDGES THE READ, NOT THE ATHLETE (owner ruling, 2026-09-25).
//
// "I follow the path and alternate the exercises and optimize the weights and volume to
// what I can do and feel good about — treat that as a signal back to the brain." Live,
// the only verdicts the ledger had ever reached were day_read_adherence ones, and three
// of five read `not_aligned` for days the athlete trained through a quiet read and came
// through fine — rendered back to them as "Day read adherence didn't land the way we
// expected". These pin the restructured meaning end to end, through the real nightly
// path: the read's call (held / too_cautious / vindicated / not_taken), the morning the
// harm test needs, one judged read per day, and the words the athlete reads.
import assert from "node:assert/strict";
import test from "node:test";
import { db, repo, resetTables, localDaysAgo, seedTrainingDay } from "./_seed.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { latestBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import { learnedTimeline } from "../dist/repo/learned-timeline.js";
import { morningReview } from "../dist/repo/brain/morning-review.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { getBrainDiagnostics } from "../dist/domain/operator/brain-diagnostics-use-case.js";
import {
  easyOverrideSoftening,
  readAdherenceModel,
  reopenDayReadAdherence,
} from "../dist/repo/brain/read-adherence.js";
import { addDaysISO } from "../dist/repo/shared.js";

function reset() {
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions",
    "day_reads",
    "suggestions",
    "sessions",
    "logged_sets",
    "session_skips",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "plan_days",
    "plan_items",
    "context_events",
    "insights"
  );
}

function read(kind, extra = {}) {
  return {
    kind,
    headline: `${kind} today.`,
    why: "A calm sentence about the day.",
    focus: kind === "train" ? "Lower" : null,
    est_minutes: kind === "rest" ? null : 45,
    signals: {},
    source: "deterministic",
    override: null,
    ...extra,
  };
}

// A read written at a real instant — the given-read rule compares these stamps.
function readAt(date, kind, time, extra = {}) {
  repo.saveDayRead(date, read(kind, extra));
  const row = db
    .prepare(
      `SELECT id FROM brain_decisions WHERE kind='day_read' AND source_ref_type='day_read'
        AND source_ref_key=? ORDER BY id DESC LIMIT 1`
    )
    .get(date);
  db.prepare(`UPDATE brain_decisions SET created_at=? WHERE id=?`).run(`${date} ${time}`, row.id);
  return Number(row.id);
}

function trainedAt(date, time, performance = 4) {
  seedTrainingDay(date);
  if (performance != null) repo.setSessionFeedback(date, { performance });
  db.prepare(`UPDATE sessions SET created_at=? WHERE date=?`).run(`${date} ${time}`, date);
  db.prepare(`UPDATE logged_sets SET created_at=? WHERE session_id IN (SELECT id FROM sessions WHERE date=?)`).run(
    `${date} ${time}`,
    date
  );
}

const expectationOf = (decisionId) => listBrainExpectations({ decisionId, limit: 5 })[0];
const verdictOf = (decisionId) => latestBrainEvaluation(expectationOf(decisionId).id);
const TODAY = () => localDaysAgo(0);

// ------------------------------------------------ a harmless day past a quiet read

test("easy read + hard training + no harm: the READ was too cautious, not the athlete's miss", () => {
  reset();
  const date = localDaysAgo(2);
  const id = readAt(date, "easy", "08:00:00");
  trainedAt(date, "11:00:00", 4);

  evaluateMatureExpectations(TODAY());
  const verdict = verdictOf(id);
  assert.ok(verdict.actual.load === "hard" || verdict.actual.load === "moderate", "precondition: above easy");
  assert.equal(verdict.actual.followed, false, "behaviourally they went past it — that fact is kept");
  assert.equal(verdict.actual.read_call, "too_cautious");
  assert.equal(verdict.actual.harm_kind, null);
  assert.equal(verdict.verdict, "not_aligned", "not_aligned now means the READ was off");
  assert.match(verdict.explanation, /more cautious than the day needed/);
  assert.doesNotMatch(verdict.explanation, /did not land/);

  // Calibration evidence: the SAME day is what the easy ladder loosens on.
  const ladder = easyOverrideSoftening(readAdherenceModel(TODAY(), 12), TODAY());
  assert.ok(ladder.overridden_and_fine.includes(date), "the ladder counts the same harmless day");
});

test("three harmless easy days are one pattern for both the ledger and the ladder", () => {
  reset();
  const dates = [4, 3, 2].map((n) => {
    const date = localDaysAgo(n);
    readAt(date, "easy", "08:00:00");
    trainedAt(date, "11:00:00", 4);
    return date;
  });
  evaluateMatureExpectations(TODAY());
  const calls = db
    .prepare(
      `SELECT json_extract(e.actual_json, '$.read_call') AS call FROM brain_evaluations e
         JOIN brain_expectations x ON x.id = e.expectation_id WHERE x.metric_key = 'day_read_adherence'`
    )
    .all()
    .map((row) => row.call);
  assert.deepEqual(calls, ["too_cautious", "too_cautious", "too_cautious"]);
  const ladder = easyOverrideSoftening(readAdherenceModel(TODAY(), 12), TODAY());
  assert.deepEqual(ladder.overridden_and_fine, dates);
  assert.equal(ladder.active, true, "repeated harmless days open future easy mornings");

  const health = getBrainDiagnostics(5).metrics.expectation_health;
  const dayRead = health.by_metric.find((row) => row.metric_key === "day_read_adherence");
  assert.deepEqual(dayRead.read_calls, { too_cautious: 3 });
});

// ------------------------------------------------ harm followed: the read was right

test("rest read + training + a rest-grade next morning: the read is vindicated", () => {
  reset();
  const date = localDaysAgo(2);
  const morning = localDaysAgo(1);
  const id = readAt(date, "rest", "08:00:00");
  trainedAt(date, "11:00:00", null);
  repo.upsertGarminDailyMetric({ date: morning, training_readiness: 12 });

  evaluateMatureExpectations(TODAY());
  const verdict = verdictOf(id);
  assert.equal(verdict.actual.followed, false);
  assert.equal(verdict.actual.read_call, "vindicated");
  assert.equal(verdict.actual.harm_kind, "readiness_rest_grade");
  assert.equal(verdict.verdict, "aligned", "the rest read's caution fit the day");
  assert.equal(verdict.actual.occurrences, 0);
});

test("a quiet read trained through waits for the morning after to close before it is judged", () => {
  reset();
  const date = localDaysAgo(1);
  const id = readAt(date, "rest", "08:00:00");
  trainedAt(date, "11:00:00", null);

  // The nightly pass the next small hours: the morning after has not synced yet, so
  // "no harm" would be read off an absence.
  const early = evaluateMatureExpectations(TODAY());
  assert.equal(early.skipped_not_ready, 1);
  assert.equal(latestBrainEvaluation(expectationOf(id).id), null);
  assert.equal(expectationOf(id).status, "pending");

  // The body answers that morning.
  repo.upsertGarminDailyMetric({ date: TODAY(), training_readiness: 12 });
  evaluateMatureExpectations(addDaysISO(TODAY(), 1));
  assert.equal(verdictOf(id).actual.read_call, "vindicated");
});

test("a followed quiet read does not wait — only the harm question needs the morning after", () => {
  reset();
  const id = readAt(localDaysAgo(1), "rest", "08:00:00");
  evaluateMatureExpectations(TODAY());
  assert.equal(verdictOf(id).verdict, "aligned");
  assert.equal(verdictOf(id).actual.read_call, "held");
});

test("a session rated poorly after the verdict re-opens it, and the read is vindicated", () => {
  reset();
  const date = localDaysAgo(3);
  const id = readAt(date, "rest", "08:00:00");
  trainedAt(date, "11:00:00", null);
  evaluateMatureExpectations(TODAY());
  assert.equal(verdictOf(id).actual.read_call, "too_cautious");

  repo.setSessionFeedback(date, { performance: 2 });
  reopenDayReadAdherence(date);
  assert.equal(expectationOf(id).status, "pending", "the harm fact moved, so the call is asked again");
  evaluateMatureExpectations(TODAY());
  assert.equal(verdictOf(id).actual.read_call, "vindicated");
  assert.equal(verdictOf(id).verdict, "aligned");
});

// ------------------------------------------------ a train day shaped live is followed

test("train read + a session adjusted live (other lifts, other loads, extra sets, a skipped slot) is held", () => {
  reset();
  const date = localDaysAgo(2);
  const id = readAt(date, "train", "08:00:00");
  repo.upsertExercise({ name: "Test Bench", muscle_group: "chest" });
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Test Curl", muscle_group: "arms" });
  // Swapped in a different lift, dropped the load mid-way, added a set.
  for (const [weight, reps] of [
    [135, 8],
    [125, 10],
    [125, 10],
    [115, 12],
  ])
    repo.logSetByName({ date, exercise: "Test Row", weight, reps });
  repo.logSetByName({ date, exercise: "Test Bench", weight: 95, reps: 12 });
  const skipped = repo.skipExercise("Test Curl", date);
  assert.notEqual(skipped?.ok, false, "precondition: the slot was skipped");
  db.prepare(`UPDATE logged_sets SET created_at=? WHERE session_id IN (SELECT id FROM sessions WHERE date=?)`).run(
    `${date} 11:00:00`,
    date
  );

  evaluateMatureExpectations(TODAY());
  const verdict = verdictOf(id);
  assert.equal(verdict.verdict, "aligned");
  assert.equal(verdict.actual.followed, true);
  assert.equal(verdict.actual.read_call, "held");

  const landed = repo.teamWeekRead({ asOf: TODAY() }).landed;
  assert.equal(landed.length, 1);
  assert.doesNotMatch(landed[0].text, /didn't land|miss/i);
  assert.equal(landed[0].tone, "good");
  assert.equal(violatesReadingGrammar(landed[0].text), null);
});

// ------------------------------------------------ one judged read per day

test("two reads for one date (the live 2026-09-23 shape): only the read they were given is judged", () => {
  reset();
  const date = localDaysAgo(2);
  const midnight = readAt(date, "easy", "04:01:00");
  const given = readAt(date, "train", "08:16:00");
  trainedAt(date, "11:54:00", 4);

  evaluateMatureExpectations(TODAY());
  assert.equal(verdictOf(midnight).verdict, "canceled", "nobody trained against the midnight read");
  assert.equal(verdictOf(given).verdict, "aligned");
  const conclusive = db
    .prepare(
      `SELECT COUNT(*) AS n FROM brain_evaluations e JOIN brain_expectations x ON x.id = e.expectation_id
        WHERE x.subject_key = ? AND e.verdict IN ('aligned','not_aligned')`
    )
    .get(date).n;
  assert.equal(conclusive, 1);
  const landed = repo.teamWeekRead({ asOf: TODAY() }).landed;
  assert.ok(landed.every((line) => !/didn't land/.test(line.text)));
});

test("two same-kind reads where the earlier question was already closed: the given read is still judged", () => {
  reset();
  const date = localDaysAgo(2);
  const earlier = readAt(date, "easy", "04:01:00");
  // The legacy shape: before the fingerprint hashed the claim, a same-kind recompute wrote
  // its own row (and question) for the same date. Copied row for row, later in the morning.
  const copyRow = (table, where, overrides) => {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name)
      .filter((c) => c !== "id");
    const exprs = cols.map((c) => (c in overrides ? "?" : c));
    const values = cols.filter((c) => c in overrides).map((c) => overrides[c]);
    return Number(
      db
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${exprs.join(", ")} FROM ${table} WHERE ${where}`)
        .run(...values).lastInsertRowid
    );
  };
  const given = copyRow("brain_decisions", `id = ${earlier}`, {
    created_at: `${date} 08:16:00`,
    input_fingerprint: `legacy-restated-${date}`,
  });
  copyRow("brain_expectations", `decision_id = ${earlier}`, { decision_id: given });
  trainedAt(date, "11:54:00", 4);
  // An older rule already closed the midnight row's question as not-the-morning.
  db.prepare(`UPDATE brain_expectations SET status = 'canceled' WHERE decision_id = ?`).run(earlier);

  evaluateMatureExpectations(TODAY());
  assert.notEqual(verdictOf(given).verdict, "canceled", "a closed predecessor is never the one judged");
  const conclusive = db
    .prepare(
      `SELECT COUNT(*) AS n FROM brain_evaluations e JOIN brain_expectations x ON x.id = e.expectation_id
        WHERE x.subject_key = ? AND e.verdict IN ('aligned','not_aligned')`
    )
    .get(date).n;
  assert.equal(conclusive, 1, "the date ends with exactly one verdict, never none");
});

// ------------------------------------------------ the words the athlete reads

test("the team's week speaks a harmless easy day as the team learning, in rotating words", () => {
  reset();
  const date = localDaysAgo(2);
  readAt(date, "easy", "08:00:00");
  trainedAt(date, "11:00:00", 4);
  evaluateMatureExpectations(TODAY());

  const landed = repo.teamWeekRead({ asOf: TODAY() }).landed;
  assert.equal(landed.length, 1);
  assert.equal(landed[0].verdict, "not_aligned");
  assert.equal(landed[0].tone, "quiet", "never the warning styling");
  assert.doesNotMatch(landed[0].text, /didn't land|adherence/i);
  assert.match(landed[0].text, /easy/);
  assert.match(landed[0].text, /less cautious|learning|what you can carry/);
  assert.equal(violatesReadingGrammar(landed[0].text), null);

  const outcome = learnedTimeline({ limit: 50 }).items.find((item) => item.kind === "outcome");
  assert.equal(outcome.title, "A morning read more cautious than the day needed");
  assert.match(outcome.detail, /The morning read said easy\./);
  assert.doesNotMatch(outcome.detail, /day read adherence|did not land/i);
});

test("a legacy not_aligned verdict (no recorded call) is still read back as the read's call", () => {
  reset();
  const date = localDaysAgo(2);
  const id = readAt(date, "rest", "08:00:00");
  trainedAt(date, "11:00:00", 4);
  evaluateMatureExpectations(TODAY());
  // Strip the call off, the way every verdict written before this round was stored.
  const evaluation = verdictOf(id);
  const legacy = { ...evaluation.actual };
  for (const key of ["read_call", "harm_kind", "harm_detail", "behaviour_measures"]) delete legacy[key];
  db.prepare(`UPDATE brain_evaluations SET actual_json = ?, explanation = ? WHERE id = ?`).run(
    JSON.stringify(legacy),
    "The observed result did not land within the expectation after enough comparable data was available.",
    evaluation.id
  );

  const landed = repo.teamWeekRead({ asOf: TODAY() }).landed;
  assert.equal(landed.length, 1);
  assert.match(landed[0].text, /rest/);
  assert.doesNotMatch(landed[0].text, /didn't land/);
  const outcome = learnedTimeline({ limit: 50 }).items.find((item) => item.kind === "outcome");
  assert.equal(outcome.title, "A morning read more cautious than the day needed");
  assert.doesNotMatch(outcome.detail, /did not land/);
});

test("the look-back says the team learns from a harmless easy day", () => {
  reset();
  const yesterday = localDaysAgo(1);
  readAt(yesterday, "easy", "08:00:00");
  trainedAt(yesterday, "11:00:00", 5);
  const review = morningReview(TODAY());
  assert.equal(review.passages.length, 1);
  assert.match(review.passages[0], /less cautious|learn|what you can carry/);
  assert.equal(violatesReadingGrammar(review.passages[0]), null);
  assert.equal(morningReview(TODAY()).passages[0], review.passages[0], "one wording per morning");
});

test("the Learned pattern counts FOLLOWED from behaviour and names the harmless days", () => {
  reset();
  for (const n of [7, 6, 5, 4]) {
    const date = localDaysAgo(n);
    readAt(date, "rest", "08:00:00");
    trainedAt(date, "11:00:00", 4);
  }
  // One override that DID cost them — vindicated, so `aligned`, but not a day they took.
  const costly = localDaysAgo(3);
  readAt(costly, "rest", "08:00:00");
  trainedAt(costly, "11:00:00", 2);
  evaluateMatureExpectations(TODAY());

  const pattern = (whatWorksForYou()?.learnings ?? []).find((row) => row.key === "day_read:day_read_adherence:rest");
  assert.ok(pattern);
  assert.equal(pattern.aligned_n, 0, "a vindicated read is not a read they took");
  assert.equal(pattern.missed_n, 5);
  assert.match(pattern.statement, /you usually train anyway — 5 of the last 5, and only 1 of them showed a cost/);
  assert.match(pattern.change, /lean less cautious/);
  assert.equal(violatesReadingGrammar(pattern.statement), null);
  assert.equal(violatesReadingGrammar(pattern.change), null);
});
