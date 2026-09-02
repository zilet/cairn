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
import { db, repo, resetTables, seedTrainingDay, seedRecoveryDay, localDaysAgo } from "./_seed.js";
import {
  DAY_READ_OUTCOMES,
  DAY_READ_WHY_VARIANTS,
  REST_TRADE_META_KEY,
  violatesReadingGrammar,
} from "../dist/repo/day-read.js";
import { REST_TRADE_TITLE, tradeRestDay } from "../dist/domain/brain/rest-trade.js";
import {
  todayHolds,
  planningSignalState,
  lifeCapacityIsCommitment,
  hasFreshBrake,
} from "../dist/repo/signal-state.js";
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

// ---------- (h) the trade: the athlete's own claim, in their own words ----------
// The rest trade writes the SAME claims_day event a commitment writes, plus one flag
// saying whose idea it was — so tomorrow's read is the existing claimed-rest rule with
// words that name the trade instead of an appointment the athlete does not have. The
// calendar carries it; the plan's ring is untouched.

const tradedToday = () =>
  repo.addContextEvent({
    kind: "life_event",
    title: REST_TRADE_TITLE,
    start_date: REF,
    end_date: REF,
    meta: { claims_day: true, [REST_TRADE_META_KEY]: true, traded_from: YESTERDAY },
  });

test("the rest they traded reads as rest, and says it was their own trade", () => {
  seedStackedMorning();
  tradedToday();

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.decision.rule_code, "day_traded_rest");
  assert.equal(read.est_minutes, null);
  assert.ok(DAY_READ_WHY_VARIANTS.day_traded_rest.includes(read.why), `unexpected wording ${JSON.stringify(read.why)}`);
  assert.match(read.why, /\b(?:traded|trade|moved|swapped)\b/i, "the trade is the whole basis of this read");
  assert.equal(read.signals.same_day_hold.shape, "traded");
  // It is still a suggestion — nothing here bargains the day back or forbids training.
  assert.equal(violatesReadingGrammar(read.why), null);
});

test("an ordinary claimed day is untouched by the trade wording", () => {
  seedStackedMorning();
  claimedToday();
  const read = repo.dayRead(REF);
  assert.equal(read.decision.rule_code, "day_claimed_rest");
  assert.equal(read.signals.same_day_hold.shape, "claimed");
});

test("the traded set speaks in several calm phrasings that hold the reading grammar", () => {
  const why = DAY_READ_WHY_VARIANTS.day_traded_rest;
  const reasons = DAY_READ_OUTCOMES.day_traded_rest.reasons;
  assert.ok(why.length >= 3);
  assert.ok(reasons.length >= 3);
  assert.equal(new Set(why).size, why.length);
  assert.equal(new Set(reasons).size, reasons.length);
  for (const text of [...why, ...reasons]) {
    assert.equal(violatesReadingGrammar(text), null, `breaks the reading grammar: ${JSON.stringify(text)}`);
    assert.match(text, /[.!?]$/);
    assert.match(text, /\b(?:traded|trade|moved|swapped)\b/i);
    assert.doesNotMatch(text, /\b(?:you must|have to|owe)\b/i, "a trade they made is not a debt they are held to");
  }
  const days = ["2026-03-15", "2026-03-16", "2026-03-17"];
  const landed = days.map((day) => pickDayVariant(why, day, "day_traded_rest"));
  for (let i = 1; i < landed.length; i++) assert.notEqual(landed[i], landed[i - 1]);
});

// ---------- (i) the trade itself: what it may claim, and what it may not ----------

test("a ceiling-easy morning can trade the quiet day forward, once", () => {
  seedStackedMorning({ days: 5 });
  const read = repo.dayRead(REF);
  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "accumulated_load_rest");

  const first = tradeRestDay({ date: REF });
  assert.equal(first.ok, true);
  assert.equal(first.date, REF);
  assert.equal(first.rest_date, TOMORROW);
  assert.equal(first.already_traded, false);
  assert.equal(first.train_anyway, true);
  assert.ok(first.event_id);

  // Idempotent per date: asking twice returns the same claim, never a second rest day.
  const second = tradeRestDay({ date: REF });
  assert.equal(second.ok, true);
  assert.equal(second.already_traded, true);
  assert.equal(second.event_id, first.event_id);
  const claims = repo.listContextEvents({}).filter((event) => event?.meta?.[REST_TRADE_META_KEY] === true);
  assert.equal(claims.length, 1, "one trade, one rest day on the calendar");
});

test("an ordinary training day has no quiet day to trade", () => {
  resetTables(...WORLD);
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 8 }]);
  const plain = tradeRestDay({ date: REF });
  assert.equal(plain.ok, false);
  assert.equal(plain.reason, "not_a_quiet_day");
  assert.equal(violatesReadingGrammar(plain.error), null);
});

test("only one trade may be open at a time", () => {
  seedStackedMorning({ days: 5 });
  assert.equal(tradeRestDay({ date: REF }).ok, true);
  // A second trade, a day later, would move the rest again without ever taking it.
  const again = tradeRestDay({ date: TOMORROW });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "trade_already_open");
});

test("a floor is never a trade: a rest-grade reading, a symptom and a clinical hold each refuse", () => {
  seedStackedMorning({ days: 5 });
  const sourceId = Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'trade-floor')`).run().lastInsertRowid
  );
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, training_readiness) VALUES (?, ?, 12)`).run(
    sourceId,
    REF
  );
  const readiness = tradeRestDay({ date: REF });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "rest_grade_readiness");
  assert.equal(violatesReadingGrammar(readiness.error), null);

  // A symptom the athlete reported holds the day on its own terms.
  seedStackedMorning({ days: 5 });
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: REF, report_text: "My left knee is sore." });
  const symptom = tradeRestDay({ date: REF });
  assert.equal(symptom.ok, false);
  assert.equal(symptom.reason, "active_symptom");

  // And anything clinical shaping the day keeps the quiet day where it is.
  seedStackedMorning({ days: 5 });
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: REF });
  const clinical = tradeRestDay({ date: REF });
  assert.equal(clinical.ok, false);
  assert.ok(clinical.reason === "clinical_hold" || clinical.reason === "not_a_quiet_day", clinical.reason);
});

// ---------- (i) the trade's own row is bookkeeping, never a commitment ----------
//
// The trade has to write a real calendar row for the day to read as the rest the
// athlete chose — and that row is a `life_event`, which is exactly the shape the
// signal state reads as SCHEDULE PRESSURE. So the system's own bookkeeping came back
// at the athlete the next morning as "Rest day — traded adds schedule pressure
// today": a fresh caution on life_capacity, a fresh brake under every rule that gates
// on one, and — if they trained anyway, which this very read invites them to — a
// session compressed 60 → 40 minutes blaming a commitment that does not exist. It
// reached the coach prompt as evidence prose too.
//
// The trade row is now excluded from that filter the way the clinical shapes are
// excluded from `todayHolds`: it is only ever read as the claimed rest day it is.

test("the traded day raises no schedule pressure, no fresh brake and no commitment", () => {
  seedStackedMorning();
  tradedToday();
  const events = repo.listContextEvents({ activeOnly: true });
  const state = planningSignalState({ date: REF, contextEvents: events });

  const pressure = state.dimensions.life_capacity.evidence.filter((row) => row.field === "schedule_pressure");
  assert.deepEqual(pressure, [], "the trade's own row is not a commitment on the athlete");
  assert.notEqual(state.dimensions.life_capacity.status, "watch");
  assert.equal(lifeCapacityIsCommitment(state), false, "and the 60 → 40 clamp's discriminator stays off");
  assert.equal(hasFreshBrake(state.dimensions), false);

  // An ordinary same-day commitment is untouched — this is a carve-out for one row,
  // not the end of schedule pressure.
  resetTables(...WORLD);
  seedStackedMorning();
  claimedToday();
  const ordinary = planningSignalState({ date: REF, contextEvents: repo.listContextEvents({ activeOnly: true }) });
  assert.equal(lifeCapacityIsCommitment(ordinary), true);
});

test("todayHolds marks the trade as a trade, and the ordinary claim as a claim", () => {
  const holds = todayHolds(REF, [
    {
      id: 1,
      kind: "life_event",
      title: REST_TRADE_TITLE,
      start_date: REF,
      end_date: REF,
      meta: { claims_day: true, [REST_TRADE_META_KEY]: true },
    },
    { id: 2, kind: "life_event", title: "All-day offsite", start_date: REF, end_date: REF, meta: { claims_day: true } },
  ]);
  assert.deepEqual(
    holds.map((hold) => [hold.id, hold.claims_day, hold.rest_trade]),
    [
      [1, true, true],
      [2, true, false],
    ]
  );
});

test("the traded day never compresses the clock, and the coach prompt never names a commitment", () => {
  seedStackedMorning();
  tradedToday();

  const read = repo.dayRead(REF);
  assert.equal(read.decision.rule_code, "day_traded_rest");
  assert.equal(read.signals.schedule, undefined, "no clock to compress and nothing to blame it on");

  const prompt = buildDayReadPrompt(undefined, { date: REF });
  assert.match(prompt, /THIS IS THE REST THEY TRADED FORWARD/);
  assert.doesNotMatch(prompt, /THE DAY IS SPOKEN FOR/, "there is no appointment");
  assert.doesNotMatch(prompt, /Rest day — traded adds schedule pressure/);
  assert.doesNotMatch(
    prompt,
    /commitment or stressful stretch is likely to compress/,
    "the schedule-pressure evidence prose must not reach the model either"
  );
});
