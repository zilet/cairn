// The day read's same-day hold: a context event on the day BEING READ.
//
// The look-ahead (dayReadLookahead.test.js) fixed the eve of an appointment; this is
// the incident's second act — the appointment's own morning. A today-active event
// raised schedule pressure (a window question) but nothing about the day's KIND or
// its SEQUENCE, so a morning lab draw still read as an ordinary training day with no
// word about the draw, and the athlete's own `claims_day` — honored one day out —
// went unread on the very day it named.
//
// These cases pin what the rule may do (honor the athlete's claim as rest; lean a
// draw morning easy, sequenced after the needle) and what it may not: add work to a
// day that already has some, or take a rest grounded in a signal about the athlete.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, seedRecoveryDay, localDaysAgo } from "./_seed.js";
import { DAY_READ_OUTCOMES, DAY_READ_WHY_VARIANTS, violatesReadingGrammar } from "../dist/repo/day-read.js";
import { todayHolds, planningSignalState } from "../dist/repo/signal-state.js";
import { contextEventReadsAsLabDraw } from "../dist/repo/context-effect.js";
import { pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import { buildDayReadPrompt } from "../dist/prompt/day.js";

const REF = localDaysAgo(0);
const YESTERDAY = localDaysAgo(1);
const TOMORROW = localDaysAgo(-1);

const WORLD = [
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_sources",
  "context_events",
  "sessions",
  "logged_sets",
  "activities",
  "plan_items",
  "plan_days",
  "exercises",
  "profile",
  "day_reads",
  "training_symptom_events",
];

// The exact morning the incident happened on: a run of loading days behind the
// athlete, nothing logged yet today, and a lab draw on today's calendar.
function seedStackedMorning({ days = 3 } = {}) {
  resetTables(...WORLD);
  for (let i = 1; i <= days; i++) seedTrainingDay(localDaysAgo(i));
  repo.setSessionFeedback(localDaysAgo(1), { performance: 5 });
  repo.setSessionFeedback(localDaysAgo(2), { performance: 4 });
}

const bloodworkToday = () =>
  repo.addContextEvent({
    kind: "life_event",
    title: "Bloodwork — follow-up labs",
    detail: "Morning lab draw.",
    start_date: REF,
    end_date: REF,
  });

const claimedToday = () =>
  repo.addContextEvent({
    kind: "life_event",
    title: "Family day",
    start_date: REF,
    end_date: REF,
    meta: { claims_day: true },
  });

beforeEach(() => resetTables(...WORLD));

// ---------- (a) the classifier ----------

test("a lab-draw shape is recognized from the words, wherever it was filed", () => {
  assert.equal(contextEventReadsAsLabDraw({ kind: "life_event", title: "Bloodwork — follow-up labs" }), true);
  assert.equal(contextEventReadsAsLabDraw({ kind: "life_event", title: "Quest visit", detail: "fasting labs" }), true);
  assert.equal(contextEventReadsAsLabDraw({ kind: "life_event", title: "Phlebotomy, 8am" }), true);
  assert.equal(contextEventReadsAsLabDraw({ kind: "life_event", title: "Blood draw then work" }), true);
  assert.equal(contextEventReadsAsLabDraw({ kind: "life_event", title: "Dentist" }), false);
  assert.equal(contextEventReadsAsLabDraw({ kind: "trip", title: "Belgrade" }), false);
  assert.equal(contextEventReadsAsLabDraw(null), false);
});

// ---------- (b) the holds ----------

test("todayHolds carries exactly the two shapes, and only for a day the event covers", () => {
  const holds = todayHolds(REF, [
    { id: 1, kind: "life_event", title: "Bloodwork", start_date: REF, end_date: REF },
    { id: 2, kind: "life_event", title: "All-day offsite", start_date: REF, end_date: REF, meta: { claims_day: true } },
    // A bare commitment with no claim and no draw is schedule pressure, not a hold.
    { id: 3, kind: "life_event", title: "Errands", start_date: REF, end_date: REF },
    // Tomorrow's event belongs to the look-ahead, not to today.
    { id: 4, kind: "life_event", title: "Bloodwork", start_date: TOMORROW },
    // A multi-day claimed event holds every day it covers…
    { id: 5, kind: "trip", title: "Retreat", start_date: YESTERDAY, end_date: TOMORROW, meta: { claims_day: true } },
    // …but an OPEN-ENDED event holds only its own first day.
    { id: 6, kind: "life_event", title: "Bloodwork someday", start_date: YESTERDAY },
  ]);
  assert.deepEqual(
    holds.map((hold) => [hold.id, hold.claims_day, hold.lab_draw]),
    [
      [1, false, true],
      [2, true, false],
      [5, true, false],
    ]
  );
  assert.deepEqual(todayHolds(REF, null), []);
  assert.deepEqual(todayHolds(REF, undefined), []);
});

test("the athlete's explicit claims_day:false silences both shapes, and clinical shapes never hold", () => {
  const holds = todayHolds(REF, [
    // Their word outranks the shape in this direction too: a draw they said takes
    // nothing stops holding the day.
    { id: 1, kind: "life_event", title: "Bloodwork", start_date: REF, end_date: REF, meta: { claims_day: false } },
    // An injury row and anything reading as an illness keep their own machinery.
    { id: 2, kind: "injury", title: "Procedure", start_date: REF, end_date: REF, meta: { claims_day: true } },
    { id: 3, kind: "life_event", title: "Flu — home sick", start_date: REF, end_date: REF, meta: { claims_day: true } },
  ]);
  assert.deepEqual(holds, []);
});

// ---------- (c) the signal ----------

test("a same-day hold becomes a context-only observation that cannot move the posture", () => {
  // The comparison state carries the SAME same-day event minus the hold shape: a
  // today-active life_event legitimately moves life_capacity through the ordinary
  // commitment-pressure observation (that one IS about capacity), so the two states
  // differ in exactly one thing — the today_hold observation — and everything
  // DECIDED has to be identical.
  const bare = planningSignalState({
    date: REF,
    contextEvents: [{ id: 9, kind: "life_event", title: "Errands", start_date: REF, end_date: REF }],
  });
  const withHold = planningSignalState({
    date: REF,
    contextEvents: [{ id: 9, kind: "life_event", title: "Bloodwork — labs", start_date: REF, end_date: REF }],
  });

  assert.equal(withHold.action.posture, bare.action.posture);
  assert.equal(withHold.action.readiness, bare.action.readiness);
  assert.equal(withHold.dimensions.life_capacity.status, bare.dimensions.life_capacity.status);
  assert.equal(withHold.dimensions.life_capacity.confidence, bare.dimensions.life_capacity.confidence);
  const evidence = withHold.dimensions.life_capacity.evidence.filter((item) => item.field === "today_hold");
  assert.equal(evidence.length, 1);
  // Machine register, third person — evidence prose, never the athlete's sentence.
  assert.match(evidence[0].summary, /^Bloodwork — labs holds today; it is a blood draw/);
  assert.equal(evidence[0].direction, "neutral");
  // The ordinary commitment-pressure observation still fires independently — that
  // one IS about capacity, and the hold must not swallow it.
  assert.ok(
    withHold.dimensions.life_capacity.evidence.some((item) => item.field === "schedule_pressure"),
    "schedule pressure rides alongside the hold"
  );
});

// ---------- (d) the rule: a lab-draw morning leans easy, after the draw ----------

test("a lab draw today turns the morning into an easy day that names the draw", () => {
  seedStackedMorning();
  bloodworkToday();

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "lab_draw_morning");
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, 25);
  assert.ok(
    DAY_READ_WHY_VARIANTS.lab_draw_morning.includes(read.why),
    `unexpected wording ${JSON.stringify(read.why)}`
  );
  assert.match(read.why, /\b(?:draw|labs?|blood)\b/i, "the read's whole basis is the draw; it has to say so");
  assert.equal(read.signals.same_day_hold.shape, "lab_draw");
  assert.equal(read.signals.same_day_hold.hold.title, "Bloodwork — follow-up labs");
  assert.equal(read.signals.today_holds.length, 1);
});

test("the athlete's claims_day today reads as the rest they asked for", () => {
  seedStackedMorning();
  claimedToday();

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.decision.rule_code, "day_claimed_rest");
  assert.equal(read.est_minutes, null);
  assert.ok(DAY_READ_WHY_VARIANTS.day_claimed_rest.includes(read.why), `unexpected wording ${JSON.stringify(read.why)}`);
  assert.equal(read.signals.same_day_hold.shape, "claimed");
});

test("work already logged today closes the day; the calendar does not reopen it", () => {
  seedStackedMorning();
  seedRecoveryDay(REF);
  bloodworkToday();

  const read = repo.dayRead(REF);
  assert.notEqual(read.decision.rule_code, "lab_draw_morning");
  // Still SEEN — the hold is context either way.
  assert.equal(read.signals.today_holds[0].lab_draw, true);
});

test("a bare commitment today changes nothing — schedule pressure is not a hold", () => {
  seedStackedMorning();
  repo.addContextEvent({ kind: "life_event", title: "Errands all over town", start_date: REF, end_date: REF });

  const read = repo.dayRead(REF);
  assert.equal(read.signals.today_holds, undefined);
  assert.equal(read.signals.same_day_hold, undefined);
  assert.notEqual(read.decision.rule_code, "lab_draw_morning");
  assert.notEqual(read.decision.rule_code, "day_claimed_rest");
});

// ---------- (e) rests grounded in the athlete keep their own why ----------

test("a run-down check-in keeps its rest; the draw rides as context", () => {
  seedStackedMorning();
  bloodworkToday();
  repo.addCheckin(REF, { energy: 1, soreness: 5, mood: 2, sleep_feel: 1 });

  const read = repo.dayRead(REF);
  assert.notEqual(read.decision.rule_code, "lab_draw_morning");
  assert.notEqual(read.kind, "train");
  assert.equal(read.signals.today_holds[0].lab_draw, true, "still seen");
});

test("a clearly-low recovery reading keeps its rest whatever today's calendar holds", () => {
  seedStackedMorning();
  bloodworkToday();
  const read = repo.dayRead(REF, {
    has_data: true,
    recovery: { sleep_min: 280, avg_sleep_min: 300 },
    quality: { sleep_min: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 } },
  });
  assert.notEqual(read.decision.rule_code, "lab_draw_morning");
  assert.notEqual(read.kind, "train");
});

test("the athlete's claim is not gated the way the lab arm is — rest is the safest read", () => {
  // A run-down morning on a claimed day still rests; the claimed why may carry it,
  // since both roads end in the same rest and the claim is itself an athlete signal.
  seedStackedMorning();
  claimedToday();
  repo.addCheckin(REF, { energy: 1, soreness: 5, mood: 2, sleep_feel: 1 });

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "rest");
});

// ---------- (f) the words ----------

test("both same-day reads speak in several calm phrasings that hold the reading grammar", () => {
  for (const key of ["day_claimed_rest", "lab_draw_morning"]) {
    const why = DAY_READ_WHY_VARIANTS[key];
    const reasons = DAY_READ_OUTCOMES[key].reasons;
    assert.ok(why.length >= 3, `${key}: a stable input fires a stable rule — one literal reads as a broken app`);
    assert.ok(reasons.length >= 3);
    assert.equal(new Set(why).size, why.length);
    assert.equal(new Set(reasons).size, reasons.length);
    for (const text of [...why, ...reasons]) {
      assert.equal(violatesReadingGrammar(text), null, `breaks the reading grammar: ${JSON.stringify(text)}`);
      assert.match(text, /[.!?]$/);
    }
  }
  // The lab set's whole meaning: the draw is named, and nothing it offers is big.
  for (const text of [...DAY_READ_WHY_VARIANTS.lab_draw_morning, ...DAY_READ_OUTCOMES.lab_draw_morning.reasons]) {
    assert.match(text, /\b(?:draw|labs?|blood)\b/i);
    assert.doesNotMatch(text, /\b(?:hard|push|heavy|full send|go big)\b/i);
  }
  // The claimed set accepts the athlete's word — it may never bargain the day back.
  for (const text of [...DAY_READ_WHY_VARIANTS.day_claimed_rest, ...DAY_READ_OUTCOMES.day_claimed_rest.reasons]) {
    assert.match(text, /\b(?:claimed|taken|spoken for)\b/i);
    assert.doesNotMatch(text, /\b(?:train anyway|still fit|squeeze)\b/i);
  }
});

test("consecutive mornings of the same read do not print the same sentence", () => {
  for (const key of ["day_claimed_rest", "lab_draw_morning"]) {
    const set = DAY_READ_WHY_VARIANTS[key];
    const days = ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19"];
    const landed = days.map((day) => pickDayVariant(set, day, key));
    for (let i = 1; i < landed.length; i++) {
      assert.notEqual(landed[i], landed[i - 1], `${key}: ${days[i]} repeated the previous morning's sentence`);
    }
    assert.equal(pickDayVariant(set, days[0], key), landed[0]);
  }
});

// ---------- (g) the prompt boundary ----------

test("the day-read prompt teaches the sequencing rule when a draw holds the day", () => {
  seedStackedMorning();
  bloodworkToday();

  const prompt = buildDayReadPrompt(undefined, { date: REF });
  assert.match(prompt, /LAB DRAW TODAY/);
  assert.match(prompt, /AFTER the draw/);
  assert.match(prompt, /Bloodwork — follow-up labs/);
  assert.doesNotMatch(prompt, /THE DAY IS SPOKEN FOR/);
});

test("…and names the athlete's own claim when they made one", () => {
  seedStackedMorning();
  claimedToday();

  const prompt = buildDayReadPrompt(undefined, { date: REF });
  assert.match(prompt, /THE DAY IS SPOKEN FOR/);
  assert.match(prompt, /Family day/);
  assert.doesNotMatch(prompt, /LAB DRAW TODAY/);
});

test("with nothing on today the prompt says nothing and the read is what it was", () => {
  seedStackedMorning();
  const read = repo.dayRead(REF);
  assert.equal(read.signals.today_holds, undefined);
  const prompt = buildDayReadPrompt(undefined, { date: REF });
  assert.doesNotMatch(prompt, /LAB DRAW TODAY/);
  assert.doesNotMatch(prompt, /THE DAY IS SPOKEN FOR/);
});
