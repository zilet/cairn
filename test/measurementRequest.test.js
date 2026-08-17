// Measurement requests (src/repo/measurement-request.ts) — the owner-approved
// evolution of pull-never-push: the system may ask the athlete for DATA a live
// derivation is blocked on, in-app, once, with the reason attached.
//
// Constitution-critical properties pinned here:
//   - a need is BOTH a live reason to want the datum AND the datum being stale;
//     either half alone asks nothing;
//   - only ONE request is ever live, in a fixed priority order;
//   - the ask dedupes (one open row per need) and rides the shared attention
//     ladder, so it is made a handful of times and then goes quiet;
//   - a request retires itself the moment the measurement lands OR the need lapses;
//   - a card nobody actually saw never spends an ask;
//   - the wording rotates, passes the shared reading grammar, and never blames.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  BODY_MEASUREMENT_STALE_DAYS,
  LAB_RECHECK_GRACE_DAYS,
  WEIGH_IN_STALE_DAYS,
  currentMeasurementRequest,
  measurementRequestCandidate,
  measurementRequestDecision,
  measurementRequestGrammarPool,
  measurementRequestLine,
  measurementRequestSignalKey,
  measurementRequestState,
  reconcileMeasurementRequestAttention,
} from "../dist/repo/measurement-request.js";
import { localDateISO } from "../dist/repo/shared.js";

const WEIGH_IN_KEY = measurementRequestSignalKey("weigh_in");

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return localDateISO();
}

// A mid-cut athlete whose newest weigh-in is `ageDays` old.
function cutWithWeighIn(ageDays, extra = {}) {
  return {
    today: today(),
    active_cut: true,
    last_weigh_in_date: ageDays == null ? null : addDaysISO(today(), -ageDays),
    body_comp_expectation_open: false,
    last_body_measurement_date: null,
    overdue_lab_due_date: null,
    overdue_lab_label: null,
    ...extra,
  };
}

beforeEach(() => {
  resetTables(
    "profile",
    "attention_schedule",
    "journey_phases",
    "bodyweight_log",
    "garmin_daily_metrics",
    "body_measurements",
    "brain_expectations",
    "brain_decisions"
  );
});

// ---- the pure core: BOTH halves, or nothing ---------------------------------

test("a stale weigh-in during an active cut is the request", () => {
  const request = measurementRequestDecision(cutWithWeighIn(WEIGH_IN_STALE_DAYS + 1));
  assert.ok(request);
  assert.equal(request.need, "weigh_in");
  assert.equal(request.age_days, WEIGH_IN_STALE_DAYS + 1);
});

test("a fresh weigh-in asks nothing, however active the cut", () => {
  assert.equal(measurementRequestDecision(cutWithWeighIn(WEIGH_IN_STALE_DAYS)), null);
  assert.equal(measurementRequestDecision(cutWithWeighIn(0)), null);
});

test("no cut means no reason to want it — an ancient weigh-in asks nothing", () => {
  assert.equal(measurementRequestDecision(cutWithWeighIn(400, { active_cut: false })), null);
});

test("a cut with NO weigh-in on record still asks, and says so as absence not as a gap", () => {
  const request = measurementRequestDecision(cutWithWeighIn(null));
  assert.ok(request);
  assert.equal(request.need, "weigh_in");
  assert.equal(request.age_days, null);
  assert.equal(request.last_seen_date, null);
});

test("a future-dated reading is a clock problem, never staleness", () => {
  const state = cutWithWeighIn(0, { last_weigh_in_date: addDaysISO(today(), 3) });
  assert.equal(measurementRequestDecision(state), null);
});

test("a body measurement is only wanted while a composition prediction is open", () => {
  const noExpectation = {
    ...cutWithWeighIn(0),
    last_body_measurement_date: addDaysISO(today(), -(BODY_MEASUREMENT_STALE_DAYS + 10)),
  };
  assert.equal(measurementRequestDecision(noExpectation), null);

  const open = { ...noExpectation, body_comp_expectation_open: true };
  const request = measurementRequestDecision(open);
  assert.ok(request);
  assert.equal(request.need, "body_measurement");
  assert.equal(request.subject, "waist");
});

test("a lab past its recheck window gets a grace period before it is ever mentioned", () => {
  const base = { ...cutWithWeighIn(0) };
  const inGrace = {
    ...base,
    overdue_lab_due_date: addDaysISO(today(), -LAB_RECHECK_GRACE_DAYS),
    overdue_lab_label: "apob",
  };
  assert.equal(measurementRequestDecision(inGrace), null);

  const past = { ...inGrace, overdue_lab_due_date: addDaysISO(today(), -(LAB_RECHECK_GRACE_DAYS + 1)) };
  const request = measurementRequestDecision(past);
  assert.ok(request);
  assert.equal(request.need, "lab_recheck");
  assert.equal(request.subject, "apob");
});

test("only ONE request is ever live, and the order is fixed", () => {
  const everything = {
    today: today(),
    active_cut: true,
    last_weigh_in_date: addDaysISO(today(), -30),
    body_comp_expectation_open: true,
    last_body_measurement_date: null,
    overdue_lab_due_date: addDaysISO(today(), -90),
    overdue_lab_label: "apob",
  };
  assert.equal(measurementRequestDecision(everything).need, "weigh_in");
  // Settle the weigh-in and the next need in the order steps forward — never both.
  const weighed = { ...everything, last_weigh_in_date: today() };
  assert.equal(measurementRequestDecision(weighed).need, "body_measurement");
  const measured = { ...weighed, body_comp_expectation_open: false };
  assert.equal(measurementRequestDecision(measured).need, "lab_recheck");
});

// ---- the DB-facing read -----------------------------------------------------

function seedCut(extra = {}) {
  return repo.setProfile({
    sex: "male",
    age: 44,
    height_cm: 178,
    weight_lb: 168,
    goal_weight_lb: 164,
    goal_mode: "lose",
    activity_factor: 1.5,
    ...extra,
  });
}

test("the state read finds a real cut and a real weigh-in, and a Garmin reading counts", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  const stale = measurementRequestState(today());
  assert.equal(stale.active_cut, true);
  assert.equal(stale.last_weigh_in_date, addDaysISO(today(), -20));
  assert.equal(currentMeasurementRequest(today())?.need, "weigh_in");

  repo.logWeight(167.5, today());
  assert.equal(currentMeasurementRequest(today()), null, "a fresh reading settles the need immediately");
});

// ---- the attention ladder: dedupe, cooldown, silence -------------------------

test("the request rides the shared attention ladder — asked, then quiet for a real cooldown", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));

  const first = measurementRequestCandidate(today());
  assert.ok(first, "the first ask is offered");
  assert.equal(first.id, "measurement-request-weigh-in");
  assert.equal(first.dismissible, true);

  // Producing the card writes nothing — the ask is only spent on placement.
  assert.equal(repo.getAttentionSchedule(WEIGH_IN_KEY), null, "a pure read never opens a row");

  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");
  const entry = repo.getAttentionSchedule(WEIGH_IN_KEY);
  assert.ok(entry, "placement opens the ladder");
  assert.equal(entry.tier, "active");
  assert.ok(entry.next_due > today(), "and pushes the next ask out");

  assert.equal(measurementRequestCandidate(today()), null, "inside the cooldown it stays quiet");
});

test("a card nobody saw never spends an ask", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  assert.ok(measurementRequestCandidate(today()));

  reconcileMeasurementRequestAttention(today(), null);
  assert.equal(repo.getAttentionSchedule(WEIGH_IN_KEY), null, "a buried card leaves the ladder untouched");
  assert.ok(measurementRequestCandidate(today()), "so the same ask is still available");
});

test("the ask stretches toward silence rather than repeating on a fixed cadence", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));

  const gaps = [];
  let asOf = today();
  for (let i = 0; i < 4; i++) {
    const card = measurementRequestCandidate(asOf);
    if (!card) break;
    reconcileMeasurementRequestAttention(asOf, card.id);
    const entry = repo.getAttentionSchedule(WEIGH_IN_KEY);
    if (!entry?.next_due) break;
    gaps.push(Math.round((Date.parse(entry.next_due) - Date.parse(entry.last_checked)) / 86_400_000));
    asOf = entry.next_due;
  }
  assert.ok(gaps.length >= 3, `the ask is repeated a few times, not endlessly; saw ${gaps.length}`);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] > gaps[i - 1], `each gap must stretch: ${gaps.join(" -> ")}`);
  }
  // And then it stops entirely for this episode.
  const released = repo.getAttentionSchedule(WEIGH_IN_KEY);
  assert.equal(released.tier, "released");
  assert.equal(measurementRequestCandidate(addDaysISO(asOf, 400)), null, "a released request never asks again");
});

test("the measurement arriving retires the request outright, so a later lapse starts fresh", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");
  assert.ok(repo.getAttentionSchedule(WEIGH_IN_KEY));

  repo.logWeight(167.2, today());
  reconcileMeasurementRequestAttention(today(), null);
  assert.equal(repo.getAttentionSchedule(WEIGH_IN_KEY), null, "the row is deleted, not left released");
});

test("the need lapsing retires it just as cleanly as the data arriving", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");
  assert.ok(repo.getAttentionSchedule(WEIGH_IN_KEY));

  // The cut ends: nothing is steering by the weekly trend any more.
  seedCut({ goal_mode: "maintain", goal_weight_lb: null });
  reconcileMeasurementRequestAttention(today(), null);
  assert.equal(repo.getAttentionSchedule(WEIGH_IN_KEY), null);
});

// Opens a pending body-composition expectation, which is the only reason the tape
// request exists. brain_expectations hangs off a decision, so one is recorded for it.
function openBodyCompExpectation() {
  const decision = repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "nutrition",
    summary: "A cut that should not put the waist up",
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    context: null,
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  db.prepare(
    `INSERT INTO brain_expectations
       (decision_id, metric_key, direction, window_start, window_end, confidence, status, evaluator, evaluator_version)
     VALUES (?, 'body_measurement_direction', 'down', ?, ?, 'moderate', 'pending', 'body_measurement', 'v1')`
  ).run(Number(decision.decision.id), addDaysISO(today(), -14), addDaysISO(today(), 42));
}

test("a live need that is merely OUTRANKED keeps the ladder it has already climbed", () => {
  // The bug this pins: the sweep used to clear every row but the one firing today, so a
  // lower-priority need was reset to `active` every time the weigh-in came round — and
  // through a cut that is every few days, which means it could never reach silence.
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  repo.logWeight(167.5, today()); // fresh, so the weigh-in need is not live
  openBodyCompExpectation();

  const tapeKey = measurementRequestSignalKey("body_measurement");
  assert.equal(currentMeasurementRequest(today())?.need, "body_measurement");
  reconcileMeasurementRequestAttention(today(), "measurement-request-body-measurement");
  const opened = repo.getAttentionSchedule(tapeKey);
  assert.ok(opened, "the tape ladder is open");

  // Now the weigh-in goes stale again and outranks the tape — the tape need itself has
  // not changed at all: the prediction is still open and there is still no measurement.
  db.prepare(`DELETE FROM bodyweight_log WHERE date = ?`).run(today());
  assert.equal(currentMeasurementRequest(today())?.need, "weigh_in", "the weigh-in wins today");

  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");

  const survived = repo.getAttentionSchedule(tapeKey);
  assert.ok(survived, "an outranked need is not a resolved need — its row must survive");
  assert.equal(survived.tier, opened.tier);
  assert.equal(survived.next_due, opened.next_due);
  assert.equal(survived.state.clean_checks, opened.state.clean_checks);
  assert.equal(survived.last_checked, opened.last_checked);
});

test("a need that genuinely resolves is still swept, even while another one is firing", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  repo.logWeight(167.5, today());
  openBodyCompExpectation();

  const tapeKey = measurementRequestSignalKey("body_measurement");
  reconcileMeasurementRequestAttention(today(), "measurement-request-body-measurement");
  assert.ok(repo.getAttentionSchedule(tapeKey));

  // The tape reading lands, and the weigh-in goes stale on the same day.
  db.prepare(`INSERT INTO body_measurements (date, waist_in) VALUES (?, ?)`).run(today(), 33.5);
  db.prepare(`DELETE FROM bodyweight_log WHERE date = ?`).run(today());
  assert.equal(currentMeasurementRequest(today())?.need, "weigh_in");

  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");
  assert.equal(repo.getAttentionSchedule(tapeKey), null, "the measurement arrived, so the row is retired");
});

test("one open request per need — a second ask never opens a second row", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  reconcileMeasurementRequestAttention(today(), "measurement-request-weigh-in");
  const entry = repo.getAttentionSchedule(WEIGH_IN_KEY);
  reconcileMeasurementRequestAttention(entry.next_due, "measurement-request-weigh-in");

  const rows = db.prepare(`SELECT COUNT(*) AS n FROM attention_schedule WHERE source = 'measurement-request'`).get();
  assert.equal(Number(rows.n), 1, "the ladder advances in place; it never accumulates rows");
});

// ---- the words a person reads ------------------------------------------------

test("every athlete-facing phrasing passes the shared reading grammar", () => {
  for (const line of measurementRequestGrammarPool()) {
    assert.equal(violatesReadingGrammar(line), null, `"${line}" must read as coaching prose`);
  }
});

test("the wording rotates rather than printing one literal", () => {
  const request = measurementRequestDecision(cutWithWeighIn(20));
  const titles = new Set();
  const bodies = new Set();
  for (let i = 0; i < 8; i++) {
    const line = measurementRequestLine(request, addDaysISO(today(), i));
    titles.add(line.title);
    bodies.add(line.body);
  }
  assert.ok(titles.size >= 4, `at least four title phrasings; saw ${titles.size}`);
  assert.ok(bodies.size >= 4, `at least four body phrasings; saw ${bodies.size}`);
});

test("the voice is adherence-neutral — a reason, never a gap, a count or a rebuke", () => {
  for (const line of measurementRequestGrammarPool()) {
    assert.doesNotMatch(
      line,
      /\b(you haven't|haven't|missed|overdue|behind|failed|forgot|neglect|streak|since you last)\b/i,
      `"${line}" reads as a rebuke rather than an offer`
    );
  }
  // And every body says out loud that nothing is waiting on it.
  const request = measurementRequestDecision(cutWithWeighIn(20));
  for (let i = 0; i < 4; i++) {
    const { body } = measurementRequestLine(request, addDaysISO(today(), i));
    assert.match(body, /whenever|no hurry|optional|any morning|costs nothing/i);
  }
});

test("the card sits below anything actionable and is never a gate", () => {
  seedCut();
  repo.logWeight(168, addDaysISO(today(), -20));
  const card = measurementRequestCandidate(today());
  assert.ok(card);
  assert.ok(card.priority > 0 && card.priority < 20, `a calm ask, not an alarm; got ${card.priority}`);
  assert.equal(card.action, undefined, "nothing to accept or decline — it asks for data, not permission");
});
