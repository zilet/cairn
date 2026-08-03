// The morning read is the highest-frequency decision the brain makes. Before this
// round it predicted nothing (zero expectations on 294 day_read rows) and churned
// ~19 immutable ledger rows per calendar day. These cases pin both halves: the read
// now carries a falsifiable, same-day expectation that matures overnight and reaches
// a real verdict through the production service path, and an unchanged read is
// idempotent in the ledger.
import assert from "node:assert/strict";
import test from "node:test";
import { db, repo, resetTables, localDaysAgo, seedTrainingDay } from "./_seed.js";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh } from "../dist/dayread-refresh.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { listBrainExpectations, recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation, latestBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { getBrainDiagnostics } from "../dist/domain/operator/brain-diagnostics-use-case.js";
import { whatWorksForYou } from "../dist/repo/reaction-model.js";
import { MIGRATIONS } from "../dist/migrate.js";
import {
  dayReadAdherenceExpectation,
  dayTrainingTruth,
  OUTCOME_SOFTENING_MIN_DIVERGENCES,
  OUTCOME_SOFTENING_WINDOW_DAYS,
  readAdherenceModel,
  readAdherenceOutcome,
  reopenDayReadAdherence,
  restOverrideSoftening,
} from "../dist/repo/brain/read-adherence.js";

const LEDGER_TABLES = [
  "brain_evaluations",
  "brain_expectations",
  "brain_decisions",
  "day_reads",
  "suggestions",
  "sessions",
  "logged_sets",
  "activities",
  "plan_days",
  "plan_items",
  "context_events",
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

const dayDecisions = (date) =>
  db
    .prepare(
      `SELECT id, status, input_fingerprint, superseded_by, action_json FROM brain_decisions
        WHERE kind='day_read' AND source_ref_type='day_read' AND source_ref_key=? ORDER BY id`
    )
    .all(date);

const expectationsFor = (decisionId) => listBrainExpectations({ decisionId, limit: 20 });

// ---------------------------------------------------------------- fingerprinting

test("an unchanged read writes ONE decision row however many times it is recomputed", () => {
  reset();
  const date = localDaysAgo(3);
  for (let n = 0; n < 6; n++) repo.saveDayRead(date, read("rest"));

  const rows = dayDecisions(date);
  assert.equal(rows.length, 1, "six identical recomputes must not be six immutable observations");
  assert.equal(rows[0].status, "observed");
  assert.match(String(rows[0].input_fingerprint), /^[a-f0-9]{64}$/);
  assert.equal(expectationsFor(rows[0].id).length, 1, "and exactly one expectation, not one per write");
});

test("a genuinely changed read still records, and closes the one it replaces", () => {
  reset();
  const date = localDaysAgo(3);
  repo.saveDayRead(date, read("rest"));
  // Prose churn alone is NOT a new decision — this is what the old signals-blob
  // comparison could not tell apart.
  repo.saveDayRead(date, read("rest", { why: "Different words, same call.", headline: "Rest up." }));
  assert.equal(dayDecisions(date).length, 1);

  repo.saveDayRead(date, read("train", { focus: "Lower" }));
  const rows = dayDecisions(date);
  assert.equal(rows.length, 2);
  const [older, newer] = rows;
  assert.equal(older.status, "superseded");
  assert.equal(Number(older.superseded_by), Number(newer.id));
  assert.equal(newer.status, "observed");
  assert.equal(JSON.parse(newer.action_json).kind, "train");
  // The retired read's expectation is canceled with it, so only the read that
  // actually stood can be judged against the day.
  assert.equal(expectationsFor(older.id)[0].status, "canceled");
  assert.equal(expectationsFor(newer.id)[0].status, "pending");
});

// ONLY A NEW PREDICTION MAY CLOSE AN OLD ONE.
//
// Every training day ends in a `done` read, and `done` used to supersede the morning
// call that preceded it — so the morning's train/easy prediction was retired by the
// very evidence that would have confirmed it, and its expectation was stamped
// `canceled` without the day ever being looked at. On the live deployment that was 13
// of 13 train/easy reads over ten days: the loop could see divergence (a rest day
// writes no `done`) and essentially never compliance.
test("a done acknowledgement does not cancel the morning it acknowledges", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("train", { focus: "Lower" }));
  seedTrainingDay(date);
  repo.saveDayRead(date, read("done", { focus: null, est_minutes: null }));

  const rows = dayDecisions(date);
  assert.equal(rows.length, 2, "the acknowledgement is still its own immutable entry");
  const [morning, ack] = rows;
  assert.equal(morning.status, "observed", "the prediction still stands — nothing replaced it");
  assert.equal(morning.superseded_by, null);
  assert.equal(ack.status, "observed");
  const expectation = expectationsFor(morning.id)[0];
  assert.equal(expectation.status, "pending", "and its expectation is still asking");

  evaluateMatureExpectations(localDaysAgo(0));
  const evaluation = latestBrainEvaluation(expectation.id);
  assert.equal(evaluation.verdict, "aligned", "the day is judged, not canceled");
  assert.equal(evaluation.actual.trained, true);
});

test("a NEW predictive read for the same date still supersedes and cancels", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  repo.saveDayRead(date, read("train", { focus: "Upper" }));

  const [older, newer] = dayDecisions(date);
  assert.equal(older.status, "superseded");
  assert.equal(Number(older.superseded_by), Number(newer.id));
  assert.equal(expectationsFor(older.id)[0].status, "canceled", "a real change of call cancels honestly");

  const expectation = expectationsFor(older.id)[0];
  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "canceled");
});

// A SUPERSESSION MAY NOT ERASE A CLAIM THE DAY HAS ALREADY DECIDED.
//
// The evening read still retires the morning one — the chain reaches a genuine
// replacement and the decision is superseded for lineage. But the rest read said "no
// training today", the athlete trained, and no later read can un-log that. Within one
// day `trained` and `above_easy` only ever go TRUE, so the outcome LOCKED before the
// replacement arrived and the prediction is judged rather than thrown away. Cancelling
// here is how 13 of 22 live predictions were lost.
test("a locked outcome survives the read that replaces it, and is judged", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  seedTrainingDay(date);
  repo.saveDayRead(date, read("done", { focus: null, est_minutes: null }));
  repo.saveDayRead(date, read("train", { focus: "Upper" }));

  const rows = dayDecisions(date);
  assert.equal(rows.length, 3);
  const [morning, ack, evening] = rows;
  assert.equal(morning.status, "superseded", "the chain reaches a genuine replacement");
  assert.equal(ack.status, "superseded");
  assert.equal(evening.status, "observed");

  const expectation = expectationsFor(morning.id)[0];
  assert.equal(expectation.status, "pending", "the day already answered it — the supersede does not close it");

  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "not_aligned");
});

// The sibling case, and the boundary: nothing was logged, so the rest read's outcome
// was still OPEN when the train read took the day over. An open claim IS honestly
// replaced, and cancels.
test("an OPEN claim is still cancelled by the read that replaces it", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  repo.saveDayRead(date, read("done", { focus: null, est_minutes: null }));
  repo.saveDayRead(date, read("train", { focus: "Upper" }));

  const [morning] = dayDecisions(date);
  const expectation = expectationsFor(morning.id)[0];
  assert.equal(expectation.status, "canceled", "nothing had happened yet, so nothing was decided");

  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "canceled");
});

test("repeated readToday calls for an unchanged day do not grow the ledger", async () => {
  reset();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, { ...baseline, headline: "Steady today.", source: "deterministic", override: null });
  const afterSeed = dayDecisions(date).length;

  for (let n = 0; n < 4; n++) await readToday({ date });

  assert.equal(dayDecisions(date).length, afterSeed, "serving a cached read must write no new observation");
  assert.equal(afterSeed, 1);
});

test("a done read predicts nothing, so it carries no expectation", () => {
  reset();
  const date = localDaysAgo(3);
  repo.saveDayRead(date, read("done", { focus: null, est_minutes: null }));
  const rows = dayDecisions(date);
  assert.equal(rows.length, 1);
  assert.equal(expectationsFor(rows[0].id).length, 0);
  assert.equal(dayReadAdherenceExpectation(date, read("done")), null);
});

// ------------------------------------------------------- maturation → evaluation

// Every case below goes through the REAL nightly path: saveDayRead writes the
// decision + expectation, evaluateMatureExpectations() finds it matured and
// evaluates it. Nothing is hand-inserted into brain_expectations.
function verdictFor(date) {
  const decision = dayDecisions(date).find((row) => row.status === "observed");
  assert.ok(decision, "the read must have left an observed decision");
  const expectation = expectationsFor(decision.id)[0];
  assert.ok(expectation, "the read must have left an expectation");
  const summary = evaluateMatureExpectations(localDaysAgo(0));
  const evaluation = latestBrainEvaluation(expectation.id);
  return { summary, expectation, evaluation };
}

// The defect this pins was FATAL on the real deployment, not theoretical. With
// confounder_policy 'standard', contextEventConfounders treats an open-ended row
// (end_date NULL) as overlapping every window forever, and any confounder forces
// `inconclusive` — which this metric, being terminal once evaluated, never
// revisits. The live DB carries exactly one open-ended `injury` row, so every
// adherence verdict would have been inconclusive for good and the loop would have
// been born dead, with expectation_health.never_conclusive reporting a cause an
// operator would misdiagnose as a stopped scheduler.
test("an ongoing open-ended injury does not stop a day from being judged", () => {
  reset();
  const date = localDaysAgo(2);
  repo.addContextEvent({
    kind: "injury",
    title: "Right hand joint pain",
    detail: "ongoing",
    start_date: null,
    end_date: null,
  });
  const open = db.prepare(`SELECT start_date, end_date FROM context_events LIMIT 1`).get();
  assert.equal(open.end_date, null, "precondition: the event is genuinely open-ended");

  repo.saveDayRead(date, read("rest"));
  const { evaluation } = verdictFor(date);

  assert.equal(evaluation.verdict, "aligned", "a factual 'was training logged' question is not confounded by an injury");
  assert.deepEqual(evaluation.confounders, []);
});

test("an ongoing injury still lets a diverged day read as diverged", () => {
  reset();
  const date = localDaysAgo(2);
  repo.addContextEvent({ kind: "injury", title: "Right hand joint pain", start_date: null, end_date: null });
  repo.saveDayRead(date, read("rest"));
  seedTrainingDay(date);

  const { evaluation } = verdictFor(date);
  assert.equal(evaluation.verdict, "not_aligned");
});

test("a rest read the athlete followed matures overnight and reads as aligned", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));

  const { summary, evaluation } = verdictFor(date);
  assert.ok(summary.evaluated >= 1);
  assert.equal(evaluation.verdict, "aligned");
  // Absence IS the evidence on a followed rest day; without a real evidence key
  // the contract would force every honest "they rested" to inconclusive.
  assert.equal(evaluation.evidence_keys.length, 1);
  assert.match(evaluation.evidence_keys[0], /^day_read_adherence:/);
  assert.equal(evaluation.actual.followed, true);
  assert.equal(evaluation.actual.trained, false);
});

test("a rest read the athlete trained through reads as not aligned", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  seedTrainingDay(date);

  const { evaluation } = verdictFor(date);
  assert.equal(evaluation.verdict, "not_aligned");
  assert.equal(evaluation.actual.followed, false);
  assert.equal(evaluation.actual.occurrences, 1);
  assert.ok(evaluation.actual.logged_sets > 0);
});

test("a train read backed by a logged session reads as aligned", () => {
  reset();
  const date = localDaysAgo(2);
  seedTrainingDay(date);
  repo.saveDayRead(date, read("train", { focus: "Lower" }));

  const { evaluation } = verdictFor(date);
  assert.equal(evaluation.verdict, "aligned");
  assert.equal(evaluation.actual.value, 1);
});

test("a train read with nothing logged reads as not aligned", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("train", { focus: "Lower" }));

  const { evaluation } = verdictFor(date);
  assert.equal(evaluation.verdict, "not_aligned");
  assert.equal(evaluation.actual.value, 0);
});

test("an easy read against work that cannot be graded stays honestly inconclusive", () => {
  reset();
  const date = localDaysAgo(2);
  // A real (≥20 min) activity a strength athlete's dayLoad does not grade: work
  // happened, but "did it stay easy?" has no honest answer.
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 35)`).run(date);
  repo.saveDayRead(date, read("easy"));

  const { evaluation } = verdictFor(date);
  assert.equal(evaluation.verdict, "inconclusive");
  assert.equal(evaluation.evidence_keys.length, 0, "an inconclusive verdict claims no evidence");
  assert.ok(evaluation.confounders.some((line) => /could not be graded/i.test(line)));
});

test("a read for a day that has not closed is never concluded early", () => {
  reset();
  const today = localDaysAgo(0);
  repo.saveDayRead(today, read("rest"));
  const decision = dayDecisions(today).find((row) => row.status === "observed");
  const expectation = expectationsFor(decision.id)[0];

  // window_end is tomorrow, so the nightly pass run TODAY must not touch it.
  assert.equal(expectation.window_start, today);
  assert.ok(expectation.window_end > today);
  evaluateMatureExpectations(today);
  assert.equal(latestBrainEvaluation(expectation.id), null);
});

// The healing half of the lock, reached from the other direction. The rest read was
// replaced while its outcome was still open, so it was cancelled at the WRITE — and
// then the athlete trained. By the time the day closes the outcome is locked, and the
// evaluator judges it rather than repeating the stale cancel. Same rule as the write
// path, read back at evaluation, which is also what heals rows written before it.
test("a read cancelled before the day decided it is still judged once the day does", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  const first = dayDecisions(date)[0];
  repo.saveDayRead(date, read("train", { focus: "Lower" }));
  assert.equal(expectationsFor(first.id)[0].status, "canceled", "open at the time of the replacement");
  seedTrainingDay(date);

  evaluateMatureExpectations(localDaysAgo(0));
  const retired = expectationsFor(first.id)[0];
  assert.equal(latestBrainEvaluation(retired.id).verdict, "not_aligned");
});

test("a superseded read whose day never decided it is closed as canceled", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  const first = dayDecisions(date)[0];
  repo.saveDayRead(date, read("easy"));

  evaluateMatureExpectations(localDaysAgo(0));
  const retired = expectationsFor(first.id)[0];
  assert.equal(latestBrainEvaluation(retired.id).verdict, "canceled");
});

// ----------------------------------------------------- terminal same-day verdicts

// A same-day metric's window closes over one finished calendar day, so a second
// look can only ever repeat the first. Left re-probeable, one row PER DAY piles up
// forever and competes with genuinely new maturations for the bounded nightly
// budget. These pin that it stops — and that long-window metrics still don't.

test("an inconclusive same-day verdict is final, not re-asked every night", () => {
  reset();
  const date = localDaysAgo(2);
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 35)`).run(date);
  repo.saveDayRead(date, read("easy"));

  const first = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(first.scanned, 1);
  assert.equal(first.evaluated, 1);

  const second = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(second.scanned, 0, "the day is over — nothing about it can change tomorrow");
  assert.equal(second.skipped_unchanged, 0, "and it is not even a candidate, so nothing is recomputed");
});

test("a conclusive same-day verdict is final too", () => {
  reset();
  repo.saveDayRead(localDaysAgo(2), read("rest"));

  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).evaluated, 1);
  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).scanned, 0);
});

test("a superseded read's verdict is final too", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  repo.saveDayRead(date, read("train", { focus: "Lower" }));
  seedTrainingDay(date);

  const first = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(first.scanned, 2, "the retired expectation and the one that stood");
  assert.equal(first.evaluated, 2);

  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).scanned, 0);
});

test("a long-window metric keeps being re-asked — late evidence still reaches it", () => {
  reset();
  resetTables("health_documents");
  // A marker expectation whose window has closed with no draw inside it:
  // inconclusive today, but a lab result can still land next week, so it must
  // stay a candidate. This is the guarantee that terminality is scoped.
  recordDecision(
    {
      effective_date: localDaysAgo(40),
      kind: "health_directive",
      domain: "health",
      summary: "Watch the lipid panel over the next block.",
      rationale: "A bounded change makes the response measurable.",
      source: "test",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: {},
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "terminal-control-v1",
    },
    [
      {
        metric_key: "marker_direction",
        subject_key: "ldl",
        direction: "decrease",
        baseline: { value: 130 },
        target: { max: 100 },
        window_start: localDaysAgo(40),
        window_end: localDaysAgo(2),
        minimum_data: null,
        confounder_policy: "standard",
        confidence: "tentative",
        evaluator: "marker_direction",
        evaluator_version: "terminal-control-v1",
      },
    ]
  );

  const first = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(first.scanned, 1);
  assert.equal(first.evaluations[0].verdict, "inconclusive");

  const second = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(second.scanned, 1, "a lab draw can still land — this one must keep being asked");
  assert.equal(second.skipped_unchanged, 1, "re-asked, same answer, no duplicate row");
});

// ------------------------------------------ re-judging a retroactively logged day

// Terminality must not let the loop flatter itself. A missed re-judgement always
// converts a `diverged` into a stale `aligned`, never the reverse, so a Garmin
// activity landing after the day closed would silently overstate how often the
// Brief's reads are followed — on the one metric built to measure that honestly.

test("work logged retroactively for a closed rest day flips the verdict from aligned to diverged", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));

  // Night one: nothing was logged, so the read reads as followed and goes terminal.
  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).evaluated, 1);
  const expectation = expectationsFor(dayDecisions(date).find((row) => row.status === "observed").id)[0];
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "aligned");
  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).scanned, 0, "closed");

  // The session lands afterwards. Driven through the REAL logging path
  // (logSetByName → invalidateDayRead), not a raw insert, so this exercises the
  // production wiring a late Garmin sync would take.
  repo.logSetByName({ date, exercise: "Test Squat", weight: 185, reps: 5, rir: 2 });

  const rejudged = evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(rejudged.scanned, 1, "a day whose training log moved must be re-asked");
  assert.equal(rejudged.evaluated, 1);
  const verdict = latestBrainEvaluation(expectation.id);
  assert.equal(verdict.verdict, "not_aligned", "the athlete trained through a rest read");
  assert.equal(verdict.actual.trained, true);

  // ...and it closes again, rather than becoming a standing nightly re-probe.
  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).scanned, 0);
});

test("an unrelated write for a closed day re-opens nothing", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  evaluateMatureExpectations(localDaysAgo(0));

  // A backfilled weigh-in touches the day without touching what was trained.
  db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, 180)`).run(date);
  repo.invalidateDayRead(date);

  assert.equal(evaluateMatureExpectations(localDaysAgo(0)).scanned, 0, "the training log did not move");
});

test("a re-open cannot resurrect a long-window expectation", () => {
  reset();
  resetTables("health_documents");
  const date = localDaysAgo(2);
  const recorded = recordDecision(
    {
      effective_date: date,
      kind: "health_directive",
      domain: "health",
      summary: "Watch the lipid panel over the next block.",
      rationale: "A bounded change makes the response measurable.",
      source: "test",
      source_ref_type: "day_read",
      // Deliberately keyed to the SAME date the re-open targets: only the METRIC
      // may decide what is re-openable, never the date it happens to share.
      source_ref_key: date,
      status: "observed",
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: {},
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "reopen-control-v1",
    },
    [
      {
        metric_key: "marker_direction",
        subject_key: date,
        direction: "decrease",
        baseline: { value: 130 },
        target: { max: 100 },
        window_start: localDaysAgo(40),
        window_end: localDaysAgo(2),
        minimum_data: null,
        confounder_policy: "standard",
        confidence: "tentative",
        evaluator: "marker_direction",
        evaluator_version: "reopen-control-v1",
      },
    ]
  );
  evaluateMatureExpectations(localDaysAgo(0));
  const before = listBrainExpectations({ decisionId: recorded.decision.id, limit: 5 })[0];

  seedTrainingDay(date);
  assert.deepEqual(reopenDayReadAdherence(date), [], "no same-day adherence expectation exists for this date");
  assert.equal(
    listBrainExpectations({ decisionId: recorded.decision.id, limit: 5 })[0].status,
    before.status,
    "a training write must never reopen a long-window expectation"
  );
});

// ------------------------------------------------------------ the rolling model

test("read adherence is measured as counts over closed days, never as a rate", () => {
  reset();
  const followedRest = localDaysAgo(5);
  const brokenRest = localDaysAgo(4);
  const followedTrain = localDaysAgo(3);
  repo.saveDayRead(followedRest, read("rest"));
  repo.saveDayRead(brokenRest, read("rest"));
  seedTrainingDay(brokenRest);
  repo.saveDayRead(followedTrain, read("train", { focus: "Lower" }));
  seedTrainingDay(followedTrain);

  const model = readAdherenceModel(localDaysAgo(0), 42);
  const rest = model.by_read.find((row) => row.read === "rest");
  const train = model.by_read.find((row) => row.read === "train");
  assert.equal(model.days_observed, 3);
  assert.deepEqual({ days: rest.days, followed: rest.followed, diverged: rest.diverged }, {
    days: 2,
    followed: 1,
    diverged: 1,
  });
  assert.deepEqual({ days: train.days, followed: train.followed }, { days: 1, followed: 1 });
  // No rate, no percentage, no grade anywhere in the shape — adherence is counts.
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    }
  };
  walk(model);
  const graded = [...keys].filter((key) => /pct|percent|_rate|score|grade/i.test(key));
  assert.deepEqual(graded, []);
});

test("the model reads the read the athlete was GIVEN, not the row's end-of-day state", () => {
  reset();
  const date = localDaysAgo(3);
  repo.saveDayRead(date, read("rest"));
  // The day ended in a session, and the cached row was rewritten to 'done' — the
  // trap that makes day_reads answer the wrong question. The ledger's EARLIEST
  // entry still holds the rest read the athlete actually saw.
  seedTrainingDay(date);
  repo.saveDayRead(date, read("done", { focus: null, est_minutes: null }));

  const model = readAdherenceModel(localDaysAgo(0), 42);
  const rest = model.by_read.find((row) => row.read === "rest");
  assert.equal(rest.days, 1);
  assert.equal(rest.diverged, 1);
  assert.equal(model.recent.at(-1).read, "rest");
});

test("an incidental short walk is not the athlete defying a rest read", () => {
  reset();
  const date = localDaysAgo(2);
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 12)`).run(date);
  const truth = dayTrainingTruth(date);
  assert.equal(truth.activities, 1);
  assert.equal(truth.real_activities, 0);
  assert.equal(truth.trained, false);
  assert.equal(readAdherenceOutcome("rest", truth), "followed");
});

// -------------------------------------------------------------- loop diagnostics

test("diagnostics expose whether the learning loop has ever reached a conclusion", () => {
  reset();
  const pendingDay = localDaysAgo(0);
  const maturedDay = localDaysAgo(2);
  repo.saveDayRead(pendingDay, read("rest"));
  repo.saveDayRead(maturedDay, read("rest"));

  const before = getBrainDiagnostics(5).metrics.expectation_health;
  assert.equal(before.never_conclusive, true, "nothing evaluated yet is the state that used to be invisible");
  assert.equal(before.conclusive_verdicts, 0);
  assert.equal(before.pending, 1, "today's read is still open");
  assert.equal(before.matured_unevaluated, 1);
  assert.ok(before.oldest_overdue);
  assert.equal(before.oldest_overdue.metric_key, "day_read_adherence");
  assert.ok(before.oldest_overdue.days_overdue >= 1);

  evaluateMatureExpectations(localDaysAgo(0));

  const after = getBrainDiagnostics(5).metrics.expectation_health;
  assert.equal(after.never_conclusive, false);
  assert.equal(after.conclusive_verdicts, 1);
  assert.equal(after.matured_unevaluated, 0);
  assert.equal(after.oldest_overdue, null);
  const byMetric = after.by_metric.find((row) => row.metric_key === "day_read_adherence");
  assert.equal(byMetric.conclusive, 1);
  assert.equal(byMetric.latest_verdicts.aligned, 1);
});

test("diagnostics carry the read-adherence model for the operator", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  const model = getBrainDiagnostics(5).metrics.read_adherence;
  assert.equal(model.days_observed, 1);
  assert.equal(model.by_read[0].read, "rest");
});

// ------------------------------------------------- reading the outcomes back
// The measurement above finally has ONE consumer. It is deliberately narrow — it can
// only ever tell dayRead that a rest read has been overruled without cost — so these
// pin the bounds themselves rather than the read that consumes them.

const TODAY = () => localDaysAgo(0);
const softening = () => restOverrideSoftening(readAdherenceModel(TODAY(), OUTCOME_SOFTENING_WINDOW_DAYS + 2), TODAY());

// A rest morning the athlete trained through, with their own read of how it went.
function overriddenRest(daysAgo, performance = 4) {
  const date = localDaysAgo(daysAgo);
  repo.saveDayRead(date, read("rest"));
  seedTrainingDay(date);
  if (performance != null) repo.setSessionFeedback(date, { performance });
  return date;
}

test("a run of overruled rest mornings that went fine activates the softening", () => {
  reset();
  const dates = [3, 2, 1].map((n) => overriddenRest(n));

  const signal = softening();
  assert.equal(signal.active, true);
  assert.deepEqual(signal.overridden_and_fine, dates);
  assert.equal(signal.last_honored_rest, null);
  assert.equal(signal.window_days, OUTCOME_SOFTENING_WINDOW_DAYS);
});

test("one short of the bound is not a pattern", () => {
  reset();
  for (let n = OUTCOME_SOFTENING_MIN_DIVERGENCES - 1; n >= 1; n--) overriddenRest(n);

  const signal = softening();
  assert.equal(signal.overridden_and_fine.length, OUTCOME_SOFTENING_MIN_DIVERGENCES - 1);
  assert.equal(signal.active, false);
});

test("a rest morning they honored discards everything at or before it", () => {
  reset();
  for (const n of [7, 6, 5]) overriddenRest(n);
  const honored = localDaysAgo(4);
  repo.saveDayRead(honored, read("rest"));

  const signal = softening();
  assert.equal(signal.last_honored_rest, honored);
  assert.deepEqual(signal.overridden_and_fine, []);
  assert.equal(signal.active, false);
});

test("divergences AFTER the honored rest count again", () => {
  reset();
  for (const n of [7, 6, 5]) overriddenRest(n);
  repo.saveDayRead(localDaysAgo(4), read("rest"));
  const since = [3, 2, 1].map((n) => overriddenRest(n));

  const signal = softening();
  assert.equal(signal.last_honored_rest, localDaysAgo(4));
  assert.deepEqual(signal.overridden_and_fine, since);
  assert.equal(signal.active, true);
});

test("a day the session went badly is not a day the override was free", () => {
  reset();
  overriddenRest(3);
  overriddenRest(2, 1);
  overriddenRest(1);

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, [localDaysAgo(3), localDaysAgo(1)]);
  assert.equal(signal.active, false);
});

test("a PLAIN easy morning is not evidence — an overrun easy day is a different question", () => {
  reset();
  for (const n of [3, 2, 1]) {
    const date = localDaysAgo(n);
    repo.saveDayRead(date, read("easy"));
    seedTrainingDay(date);
  }

  assert.equal(softening().active, false);
});

test("divergences older than the window have stopped speaking", () => {
  reset();
  const past = OUTCOME_SOFTENING_WINDOW_DAYS;
  for (const n of [past + 3, past + 2, past + 1]) overriddenRest(n);

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, []);
  assert.equal(signal.active, false);
});

test("TODAY is never counted — the day is still open, so it cannot have gone well", () => {
  reset();
  for (const n of [2, 1]) overriddenRest(n);
  overriddenRest(0);

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, [localDaysAgo(2), localDaysAgo(1)]);
  assert.equal(signal.active, false);
});

test("a missing model degrades to no softening rather than throwing", () => {
  assert.equal(restOverrideSoftening(null, TODAY()).active, false);
  assert.equal(restOverrideSoftening({ recent: null }, TODAY()).active, false);
});

// ------------------------------------------------- the softening has to SUSTAIN
// Counting only rest mornings made this self-extinguishing: once active, the read
// stopped saying rest, so no new evidence could accrue, the qualifying days aged out
// of the ten-day window, and the read relapsed — a periodic cycle straight back to
// the defect the softening exists to fix. A softened easy morning trained through
// without harm is the same evidence restated under the new read.

// A morning that read easy BECAUSE this signal eased it — identifiable downstream by
// the `applied` flag dayRead publishes on the read's own signals.
function softenedEasy(daysAgo, { trained = true, performance = 4 } = {}) {
  const date = localDaysAgo(daysAgo);
  repo.saveDayRead(date, read("easy", { signals: { outcome_feedback: { active: true, applied: true } } }));
  if (trained) {
    seedTrainingDay(date);
    if (performance != null) repo.setSessionFeedback(date, { performance });
  }
  return date;
}

test("softened easy mornings trained through carry the pattern after the rest evidence ages out", () => {
  reset();
  // The rest mornings that started it are all OUTSIDE the ten-day window now.
  const past = OUTCOME_SOFTENING_WINDOW_DAYS;
  for (const n of [past + 3, past + 2, past + 1]) overriddenRest(n);
  // Everything inside the window is a softened easy day they trained through.
  const sustained = [5, 4, 3, 2, 1].map((n) => softenedEasy(n));

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, sustained, "the softened days are the evidence now");
  assert.equal(signal.active, true, "the softening must not relapse the moment its first evidence ages out");
  assert.equal(signal.last_honored_rest, null);
});

test("a softened easy morning they simply TOOK resets the count, same as an honored rest", () => {
  reset();
  for (const n of [6, 5, 4]) overriddenRest(n);
  const honored = softenedEasy(3, { trained: false });
  // Two more overruled rest mornings since — real evidence, but short of the bound.
  const since = [2, 1].map((n) => overriddenRest(n));

  const signal = softening();
  assert.equal(signal.last_honored_rest, honored);
  assert.deepEqual(signal.overridden_and_fine, since);
  assert.equal(signal.active, false, "honoring the quiet day is the athlete agreeing with the read");
});

test("plain easy mornings neither sustain the pattern nor reset it", () => {
  reset();
  for (const n of [6, 5, 4]) overriddenRest(n);
  // An ordinary easy morning trained through, and another they took off. Neither was
  // a rest the read had to argue for, so neither says anything about this signal.
  repo.saveDayRead(localDaysAgo(3), read("easy"));
  seedTrainingDay(localDaysAgo(3));
  repo.saveDayRead(localDaysAgo(2), read("easy"));

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, [localDaysAgo(6), localDaysAgo(5), localDaysAgo(4)]);
  assert.equal(signal.last_honored_rest, null, "an untrained plain easy day is not an honored rest");
  assert.equal(signal.active, true);
});

test("a softened easy morning that went badly is not sustaining evidence", () => {
  reset();
  const past = OUTCOME_SOFTENING_WINDOW_DAYS;
  for (const n of [past + 3, past + 2, past + 1]) overriddenRest(n);
  softenedEasy(3);
  softenedEasy(2, { performance: 1 });
  softenedEasy(1);

  const signal = softening();
  assert.deepEqual(signal.overridden_and_fine, [localDaysAgo(3), localDaysAgo(1)]);
  assert.equal(signal.active, false);
});

// ============================================================ THE CHURN, AND THE COST
//
// The decision fingerprint used to hash the read's INPUTS, so every mid-day recompute
// that reached the SAME conclusion still wrote a new immutable row, superseded the
// morning's and cancelled the prediction riding on it. A live audit found 13 of 22
// day_read_adherence expectations cancelled that way: the loop's highest-frequency
// learning signal, destroyed by its own recompute loop. Two things stop it — the
// fingerprint hashes the CLAIM, and an outcome the day has already decided survives
// the read that replaces it — and both are pinned end to end below.

test("ten recomputes that reach the same call are ONE decision and ONE live question", () => {
  reset();
  const date = localDaysAgo(3);
  for (let n = 0; n < 10; n++) {
    repo.saveDayRead(
      date,
      read("rest", {
        // Everything that used to move the hash and never moved the call: the signals
        // blob, the prose, and the focus the read happened to name.
        signals: { readiness: n, sleep_min: 400 + n, logged_today: { sets: n } },
        headline: `Rest, take ${n}.`,
        why: `A ${n}th way of saying the same thing.`,
        focus: n % 2 ? "Upper" : "Lower",
      })
    );
  }

  const rows = dayDecisions(date);
  assert.equal(rows.length, 1, "ten recomputes, one claim");
  assert.equal(rows[0].status, "observed");
  assert.equal(rows[0].superseded_by, null);
  const expectations = expectationsFor(rows[0].id);
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0].status, "pending", "and the morning's question is still being asked");
});

test("an invalidating write followed by a real recompute leaves the morning's question open", async () => {
  reset();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  // Seeded from the canonical read, so a recompute genuinely lands on the same kind.
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, { ...baseline, headline: "Steady today.", source: "agent", agent: "claude", override: null });
  const morning = dayDecisions(date)[0];
  assert.ok(morning, "precondition: the morning read is in the ledger");
  const expectationId = expectationsFor(morning.id)[0]?.id;
  assert.ok(expectationId, "precondition: it carries a falsifiable question");

  // A wearable sync — the single most common mid-day invalidation on the live device.
  repo.upsertGarminDailyMetric({ date, sleep_min: 402, resting_hr: 51 });
  await readToday({ date });

  const rows = dayDecisions(date);
  assert.equal(rows.length, 1, "the recompute reached the same call, so nothing new was recorded");
  assert.equal(Number(rows[0].id), Number(morning.id));
  assert.equal(rows[0].status, "observed");
  assert.equal(rows[0].superseded_by, null);
  assert.equal(expectationsFor(morning.id)[0].status, "pending");
});

test("a rest read the day already answered survives the train read that replaces it", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  const morning = dayDecisions(date)[0];
  seedTrainingDay(date);
  repo.saveDayRead(date, read("train", { focus: "Upper" }));

  const rows = dayDecisions(date);
  assert.equal(rows.length, 2);
  const evening = rows[1];
  assert.equal(rows[0].status, "superseded", "the read is retired — the lineage is unchanged");
  assert.equal(Number(rows[0].superseded_by), Number(evening.id));
  const restExpectation = expectationsFor(morning.id)[0];
  assert.equal(restExpectation.status, "pending", "but the claim the day already decided is not");

  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(restExpectation.id).verdict, "not_aligned");
  assert.equal(latestBrainEvaluation(restExpectation.id).actual.trained, true);

  // Both live questions for the date reach a verdict. Nothing confounds them:
  // day-read decisions are recorded `observed`, and overlappingDecisionConfounders
  // only counts applied/announced ones.
  const eveningExpectation = expectationsFor(evening.id)[0];
  const eveningVerdict = latestBrainEvaluation(eveningExpectation.id);
  assert.equal(eveningVerdict.verdict, "aligned");
  assert.deepEqual(eveningVerdict.confounders, []);
});

test("a train read the day already answered survives the easy read that replaces it", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("train", { focus: "Lower" }));
  const morning = dayDecisions(date)[0];
  seedTrainingDay(date);
  repo.saveDayRead(date, read("easy"));

  const expectation = expectationsFor(morning.id)[0];
  assert.equal(expectation.status, "pending");
  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "aligned", "they trained — the read was right");
});

test("an OPEN rest read replaced mid-day with nothing logged is still cancelled", () => {
  reset();
  const date = localDaysAgo(2);
  repo.saveDayRead(date, read("rest"));
  const morning = dayDecisions(date)[0];
  repo.saveDayRead(date, read("train", { focus: "Upper" }));

  const expectation = expectationsFor(morning.id)[0];
  assert.equal(expectation.status, "canceled", "nothing had happened, so nothing was decided");
  evaluateMatureExpectations(localDaysAgo(0));
  assert.equal(latestBrainEvaluation(expectation.id).verdict, "canceled");
});

// ------------------------------------------- migration 91: healing the rows already written

const healDayReadExpectations = () => MIGRATIONS.find((entry) => entry.version === 91).up(db);

// A day-read decision written STRAIGHT to the ledger, so the fixture can build the
// exact shape the old writer left behind — a state the fixed writer can no longer
// create, which is precisely why the repair migration exists.
function legacyRead(date, kind) {
  const recorded = recordDecision(
    {
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: `${kind} day`,
      rationale: null,
      source: "deterministic",
      source_ref_type: "day_read",
      source_ref_key: date,
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      // Distinct per row, the way the old input-hashing fingerprint was.
      input_fingerprint: `legacy-${date}-${kind}-${Math.random().toString(16).slice(2)}`,
      context: { signals: {} },
      action: { kind, focus: null, est_minutes: null, why: null },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "day-read-adherence-v1",
    },
    [dayReadAdherenceExpectation(date, read(kind))]
  );
  return {
    decisionId: Number(recorded.decision.id),
    expectationId: Number(recorded.expectations[0].id),
  };
}

// Close `prior` out against `next` the way the old writer did: supersede the decision
// AND cancel its question, then store the canceled verdict the nightly pass reached.
function legacyCancel(prior, next) {
  db.prepare(`UPDATE brain_decisions SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(
    next.decisionId,
    prior.decisionId
  );
  insertBrainEvaluation({
    expectation_id: prior.expectationId,
    verdict: "canceled",
    actual: null,
    evidence_keys: [],
    confounders: ["The decision was superseded before its outcome could be interpreted."],
    explanation: "The decision was superseded before its outcome could be interpreted.",
    evaluator_version: "maturity-v1/canceled",
  });
}

const expectationStatus = (id) => db.prepare(`SELECT status FROM brain_expectations WHERE id = ?`).get(id).status;
const expectationSnapshot = () =>
  db.prepare(`SELECT id, status FROM brain_expectations ORDER BY id`).all().map((row) => `${row.id}:${row.status}`);

test("migration 91 re-opens a prediction cancelled by a recompute that agreed with it", () => {
  reset();
  const date = localDaysAgo(2);
  const morning = legacyRead(date, "rest");
  const recompute = legacyRead(date, "rest");
  legacyCancel(morning, recompute);
  assert.equal(expectationStatus(morning.expectationId), "canceled", "precondition: the old writer closed it");

  healDayReadExpectations();
  assert.equal(expectationStatus(morning.expectationId), "pending", "nothing ever took the claim away from it");

  // ...and the nightly pass can finally answer the day it asks about.
  evaluateMatureExpectations(localDaysAgo(0));
  const verdict = latestBrainEvaluation(morning.expectationId);
  assert.equal(verdict.verdict, "aligned", "no training was logged, so the rest read was followed");
  // The old canceled verdict is history, not deleted — brain_evaluations is append-only.
  const stored = db
    .prepare(`SELECT verdict FROM brain_evaluations WHERE expectation_id = ? ORDER BY id`)
    .all(morning.expectationId)
    .map((row) => row.verdict);
  assert.deepEqual(stored, ["canceled", "aligned"]);
});

test("migration 91 leaves a genuine change of call cancelled", () => {
  reset();
  const date = localDaysAgo(2);
  const morning = legacyRead(date, "rest");
  const evening = legacyRead(date, "train");
  legacyCancel(morning, evening);

  healDayReadExpectations();
  assert.equal(expectationStatus(morning.expectationId), "canceled", "a rest read really was replaced by a train read");
});

test("migration 91 is idempotent", () => {
  reset();
  const date = localDaysAgo(2);
  const morning = legacyRead(date, "rest");
  legacyCancel(morning, legacyRead(date, "rest"));
  const flipped = legacyRead(localDaysAgo(3), "rest");
  legacyCancel(flipped, legacyRead(localDaysAgo(3), "train"));

  const before = expectationSnapshot();
  healDayReadExpectations();
  const afterFirst = expectationSnapshot();
  // Guard the guard: "twice equals once" also holds for a migration that does nothing.
  assert.notDeepEqual(afterFirst, before, "the first pass really did heal something");

  healDayReadExpectations();
  assert.deepEqual(expectationSnapshot(), afterFirst, "a second pass finds nothing left to heal");
  healDayReadExpectations();
  assert.deepEqual(expectationSnapshot(), afterFirst);
});

// ---------------------------------------- the surviving evidence reaches the athlete

// The last place the evidence could still be silently dropped. dayReadAdherenceLearnings
// used to skip any row whose DECISION carried a superseded_by, which under the lock is
// exactly the shape a surviving verdict has — so the Learned timeline would have shown
// nothing for precisely the days the athlete overruled the read.
test("a locked verdict on a superseded read still reaches the Learned timeline", () => {
  reset();
  for (const n of [6, 5, 4, 3, 2]) {
    const date = localDaysAgo(n);
    repo.saveDayRead(date, read("rest"));
    seedTrainingDay(date);
    // On one of them the Brief caught up and re-read the day as train — the shape that
    // used to be dropped twice over (cancelled at the write, filtered at the read).
    if (n === 4) repo.saveDayRead(date, read("train", { focus: "Upper" }));
  }
  evaluateMatureExpectations(localDaysAgo(0));

  const learnings = whatWorksForYou()?.learnings ?? [];
  const pattern = learnings.find((row) => row.key === "day_read:day_read_adherence:rest");
  assert.ok(pattern, "five overruled rest mornings is a pattern the athlete should be told about");
  assert.equal(pattern.evidence_n, 5, "including the morning a later read replaced");
  assert.equal(pattern.missed_n, 5);
  assert.match(pattern.statement, /you usually train anyway/);
});
