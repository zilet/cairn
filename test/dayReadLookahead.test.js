// The day read's ONE look-ahead: a context event that starts TOMORROW.
//
// Every other rule in the deterministic floor answers to today's evidence, and both
// paths context events reached it by dropped anything with a future `start_date` — so
// the Brief could suggest rest on the eve of a trip or an appointment that makes
// tomorrow a no-train day, on a morning the athlete wanted to train. The agent prompt
// always had the row; only the rules were blind.
//
// These cases pin what the fix is allowed to do (re-time a DISCRETIONARY rest, and
// hand back an easy day) and — far more importantly — what it is not: a rest grounded
// in safety is never moved by the calendar.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, seedRecoveryDay, localDaysAgo } from "./_seed.js";
import { DAY_READ_OUTCOMES, DAY_READ_WHY_VARIANTS, violatesReadingGrammar } from "../dist/repo/day-read.js";
import { tomorrowHolds, planningSignalState } from "../dist/repo/signal-state.js";
import { pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import { promptData } from "../dist/prompt/context-projection.js";

const REF = localDaysAgo(0);
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

// The exact morning the incident happened on: three genuinely-loading days behind the
// athlete (so the rhythm rest is what the floor would produce), a pull day programmed
// and untrained (so there is something real to open), and rated sessions behind it (so
// the signal state is positively backed and nothing is pulling the other way).
function seedStackedMorning({ days = 3 } = {}) {
  resetTables(...WORLD);
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 1; i <= days; i++) seedTrainingDay(localDaysAgo(i));
  repo.setSessionFeedback(localDaysAgo(1), { performance: 5 });
  repo.setSessionFeedback(localDaysAgo(2), { performance: 4 });
}

const bloodworkTomorrow = () =>
  repo.addContextEvent({ kind: "life_event", title: "Bloodwork appointment", start_date: TOMORROW });

beforeEach(() => resetTables(...WORLD));

// ---------- (a) the signal ----------

test("an event that starts tomorrow becomes a tomorrow_holds observation on the signal state", () => {
  seedStackedMorning();
  bloodworkTomorrow();
  const read = repo.dayRead(REF);

  const evidence = read.signals.signal_state.dimensions.life_capacity.evidence.filter(
    (item) => item.field === "tomorrow_holds"
  );
  assert.equal(evidence.length, 1, "the look-ahead reaches the signal state");
  // Machine register, third person — the same voice every other observation's summary
  // speaks in. Nothing here is written for the athlete.
  assert.match(evidence[0].summary, /^Bloodwork appointment starts tomorrow \(\d{4}-\d{2}-\d{2}\);/);
  assert.equal(evidence[0].direction, "neutral");
  // Dated to the day being READ, not to the event: freshness answers "how old is this
  // reading", which a future date has no honest answer for.
  assert.equal(evidence[0].date, REF);

  // …and it rides in the read's own signals for the ledger and the cached row.
  assert.equal(read.signals.tomorrow_holds.length, 1);
  assert.equal(read.signals.tomorrow_holds[0].start_date, TOMORROW);
  assert.equal(read.signals.tomorrow_holds[0].blocks_training, true);
});

test("the look-ahead observation is context-only: it cannot move a dimension or the posture", () => {
  // Same state twice, the second one carrying tomorrow's event. Everything DECIDED has
  // to be identical — this observation exists to be seen, never to vote. (Built through
  // planningSignalState directly so the two differ in exactly one input.)
  const bare = planningSignalState({ date: REF, contextEvents: [] });
  const withHold = planningSignalState({
    date: REF,
    contextEvents: [{ id: 7, kind: "life_event", title: "Bloodwork appointment", start_date: TOMORROW }],
  });

  assert.equal(withHold.action.posture, bare.action.posture);
  assert.equal(withHold.action.readiness, bare.action.readiness);
  assert.equal(withHold.dimensions.life_capacity.status, bare.dimensions.life_capacity.status);
  assert.equal(withHold.dimensions.life_capacity.confidence, bare.dimensions.life_capacity.confidence);
  assert.deepEqual(withHold.dimensions.life_capacity.voice, bare.dimensions.life_capacity.voice);
  // Visible, though — that is the whole point of the context-only split.
  assert.ok(withHold.dimensions.life_capacity.evidence.some((item) => item.field === "tomorrow_holds"));
});

test("tomorrowHolds reads exactly one day forward, and judges by kind", () => {
  const events = [
    { id: 1, kind: "life_event", title: "Bloodwork", start_date: TOMORROW },
    { id: 2, kind: "trip", title: "Flying out", start_date: TOMORROW },
    { id: 3, kind: "injury", title: "Procedure", start_date: TOMORROW },
    { id: 4, kind: "life_event", title: "Next week", start_date: localDaysAgo(-7) },
    { id: 5, kind: "life_event", title: "Started already", start_date: localDaysAgo(2) },
  ];
  const holds = tomorrowHolds(REF, events);
  assert.deepEqual(
    holds.map((hold) => hold.id),
    [1, 2, 3],
    "d+1 only — not the day after, not something already running"
  );
  // An injury row dated tomorrow is a clinical shape (a procedure, a constraint about
  // to start). Carried for visibility; never a reason to reach for load today.
  assert.deepEqual(
    holds.map((hold) => hold.blocks_training),
    [true, true, false]
  );
  assert.deepEqual(tomorrowHolds(REF, null), []);
  assert.deepEqual(tomorrowHolds(REF, undefined), []);
});

test("an explicit claims_day outranks the kind in both directions, and never promotes a clinical shape", () => {
  // The kinds are what USUALLY claims a day. When the athlete has said outright whether
  // this one takes tomorrow, the inference stops and their word stands — including for
  // a shape the kind list would not have carried at all.
  const holds = tomorrowHolds(REF, [
    { id: 1, kind: "trip", title: "Flying out", start_date: TOMORROW, meta: { claims_day: false } },
    { id: 2, kind: "appointment", title: "All-day hearing", start_date: TOMORROW, meta: { claims_day: true } },
    { id: 3, kind: "injury", title: "Procedure", start_date: TOMORROW, meta: { claims_day: true } },
    { id: 4, kind: "life_event", title: "Fighting a cold", start_date: TOMORROW, meta: { claims_day: true } },
    { id: 5, kind: "note", title: "Nothing in particular", start_date: TOMORROW },
  ]);
  assert.deepEqual(
    holds.map((hold) => [hold.id, hold.blocks_training]),
    [
      [1, false], // said it claims nothing
      [2, true], // said it claims the day — carried despite an unlisted kind
      [3, false], // clinical: not the athlete's to overrule with a calendar field
      [4, false], // reads as an illness, whatever it was filed under
    ],
    "an unlisted kind with no claim is not carried at all"
  );
});

test("claims_day survives the raw meta_json shape as well as the hydrated one", () => {
  // Events reach this function hydrated (`meta`) from listContextEvents and raw
  // (`meta_json`) from anything reading the table directly. One answer either way.
  const [hold] = tomorrowHolds(REF, [
    { id: 1, kind: "trip", title: "Flying out", start_date: TOMORROW, meta_json: '{"claims_day":false}' },
  ]);
  assert.equal(hold.blocks_training, false);
  // Unparseable or non-boolean is silence, not a claim — the kind decides.
  const [garbled] = tomorrowHolds(REF, [
    { id: 1, kind: "trip", title: "Flying out", start_date: TOMORROW, meta_json: "{not json" },
  ]);
  assert.equal(garbled.blocks_training, true);
  const [stringy] = tomorrowHolds(REF, [
    { id: 1, kind: "trip", title: "Flying out", start_date: TOMORROW, meta: { claims_day: "yes" } },
  ]);
  assert.equal(stringy.blocks_training, true);
});

test("the coach context and the rule answer the tomorrow question identically", () => {
  // One predicate, one answer — and the same ROWS behind it. The coach slice used to
  // resolve holds from the active-event list, which is filtered against TODAY: an event
  // that resolves tomorrow survives `resolved_at > today` and shipped to the prompt as
  // a hold, while the rule's own tomorrow arm asks `resolved_at > tomorrow` and reads
  // the day as open. Two filters, two answers, on the one surface built to have one.
  seedStackedMorning();
  repo.addContextEvent({
    kind: "life_event",
    title: "Bloodwork appointment",
    start_date: TOMORROW,
    resolved_at: TOMORROW,
  });

  const read = repo.dayRead(REF);
  assert.equal(read.signals.tomorrow_holds, undefined, "the rule reads tomorrow as open");
  assert.equal(read.kind, "train", "uncorroborated stacked days with a due plan stay open");
  assert.equal(read.decision.rule_code, "planned_training");
  assert.equal(repo.getCoachContext().tomorrow_holds, null, "and so does the prompt");
});

// ---------- (b) the rule: a discretionary rest is RE-TIMED ----------

test("stacked loading days plus a commitment tomorrow re-times the rest into an easy training day", () => {
  seedStackedMorning();
  const baseline = repo.dayRead(REF);
  assert.equal(baseline.kind, "train", "without the look-ahead this morning is the due plan day");
  assert.equal(baseline.decision.rule_code, "planned_training");
  assert.equal(baseline.signals.consecutive_training_days, 3);

  bloodworkTomorrow();
  const read = repo.dayRead(REF);

  assert.equal(read.kind, "train");
  assert.equal(read.decision.rule_code, "lookahead_retimed_training");
  assert.equal(read.focus, "Pull", "the day that was actually due, not an invented one");
  // Reached for inside a run of loading days, so the offer is a COMPACT session — never
  // the ordinary train day's full clock.
  assert.equal(read.est_minutes, 40);
  assert.ok(
    DAY_READ_WHY_VARIANTS.lookahead_retimed_training.includes(read.why),
    `unexpected wording ${JSON.stringify(read.why)}`
  );
  assert.match(read.why, /\btomorrow\b/i, "the read's whole basis is the next day; it has to say so");
  assert.equal(read.signals.lookahead_retimed.opened, "plan_day");
  assert.equal(read.signals.lookahead_retimed.consecutive_days, 3);
  assert.equal(read.signals.lookahead_retimed.holds[0].title, "Bloodwork appointment");
});

test("with nothing programmed the re-timed day opens as easy movement, not an invented session", () => {
  resetTables(...WORLD);
  for (let i = 1; i <= 3; i++) seedTrainingDay(localDaysAgo(i));
  repo.setSessionFeedback(localDaysAgo(1), { performance: 5 });
  repo.setSessionFeedback(localDaysAgo(2), { performance: 4 });
  bloodworkTomorrow();

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "lookahead_retimed_training");
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, 25);
  assert.equal(read.signals.lookahead_retimed.opened, "easy_movement");
});

test("a trip starting tomorrow re-times the rest; an injury row starting tomorrow does not", () => {
  seedStackedMorning();
  repo.addContextEvent({ kind: "trip", title: "Flying out", start_date: TOMORROW });
  assert.equal(repo.dayRead(REF).decision.rule_code, "lookahead_retimed_training");

  seedStackedMorning();
  repo.addContextEvent({ kind: "injury", title: "Scheduled procedure", start_date: TOMORROW });
  const injury = repo.dayRead(REF);
  assert.equal(injury.kind, "rest", "a clinical shape starting tomorrow still produces a protective read");
  assert.equal(injury.decision.rule_code, "accumulated_load_rest");
  // Still SEEN, though — the prompt and the ledger carry it either way.
  assert.equal(injury.signals.tomorrow_holds[0].blocks_training, false);
});

test("a light session already logged today closes the day; the calendar does not reopen it", () => {
  // The done rule above this one only claims a day whose work graded hard or moderate,
  // so mobility or a short shakeout falls straight through it. That is correct for the
  // done read — and it must NOT mean this rule then offers a second session on top of
  // the one the athlete already did. It may re-time a rest; it may never add work.
  seedStackedMorning();
  seedRecoveryDay(REF);
  bloodworkTomorrow();

  const read = repo.dayRead(REF);
  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "logged_light_work_today");
  // Still SEEN — the look-ahead is context either way.
  assert.equal(read.signals.tomorrow_holds[0].blocks_training, true);
});

test("an event the athlete says claims nothing stops blocking, whatever its kind", () => {
  seedStackedMorning();
  repo.addContextEvent({
    kind: "trip",
    title: "Flying out",
    start_date: TOMORROW,
    meta: { claims_day: false },
  });

  const read = repo.dayRead(REF);
  assert.equal(read.signals.tomorrow_holds[0].blocks_training, false, "the athlete's own word outranks the kind");
  assert.equal(read.kind, "train");
  assert.equal(read.decision.rule_code, "planned_training");
});

test("an illness filed as a life event is a clinical shape, not a commitment", () => {
  // Filing is a UI affordance: "Flu starts tomorrow" lands in the table as a life_event
  // because that is the only kind the athlete had to hand. Read by kind alone it looked
  // like a claim on tomorrow's hours and flipped today TOWARD training — on the eve of
  // an illness. The illness classifier the rest of the repo already reads windows with
  // is what decides, so the answer is the same one every other surface gives.
  seedStackedMorning();
  repo.addContextEvent({ kind: "life_event", title: "Flu starts tomorrow", start_date: TOMORROW });

  const read = repo.dayRead(REF);
  assert.equal(read.signals.tomorrow_holds[0].blocks_training, false);
  assert.equal(read.kind, "rest", "an illness starting tomorrow is a protective read, not a reason to load today");
  assert.equal(read.decision.rule_code, "accumulated_load_rest");
});

test("the consecutive-day ceiling bounds the re-timing: four days flips, five does not", () => {
  // The same hard ceiling the push drive respects. Pinned here because this rule reads
  // it from a shared constant, and a change made for the drive read would otherwise
  // move what the calendar is allowed to reach for without anything saying so.
  seedStackedMorning({ days: 4 });
  bloodworkTomorrow();
  const four = repo.dayRead(REF);
  assert.equal(four.decision.rule_code, "lookahead_retimed_training");
  assert.equal(four.signals.lookahead_retimed.consecutive_days, 4);

  seedStackedMorning({ days: 5 });
  bloodworkTomorrow();
  const five = repo.dayRead(REF);
  assert.notEqual(five.decision.rule_code, "lookahead_retimed_training", "five days in a row is the ceiling");
  assert.equal(five.kind, "easy", "at the ceiling with supportive recovery the read is easy, not rest");
  assert.equal(five.decision.rule_code, "accumulated_load_rest");
});

// ---------- (c) safety-grounded rest is NEVER re-timed ----------

test("a rest grounded in a symptom is not flipped by what tomorrow holds", () => {
  seedStackedMorning();
  bloodworkTomorrow();
  repo.addContextEvent({ kind: "injury", title: "Left knee pain", start_date: localDaysAgo(1) });

  const read = repo.dayRead(REF);
  assert.notEqual(read.decision.rule_code, "lookahead_retimed_training");
  assert.ok(read.kind === "rest" || read.kind === "easy" || read.kind === "modify", `got ${read.kind}`);
});

test("a run-down check-in keeps its rest whatever is on the calendar tomorrow", () => {
  seedStackedMorning();
  bloodworkTomorrow();
  repo.addCheckin(REF, { energy: 1, soreness: 5, mood: 2, sleep_feel: 1 });

  const read = repo.dayRead(REF);
  assert.notEqual(read.decision.rule_code, "lookahead_retimed_training");
  assert.notEqual(read.kind, "train");
});

test("a clearly-low recovery reading keeps its rest whatever is on the calendar tomorrow", () => {
  seedStackedMorning();
  bloodworkTomorrow();
  // A short night, corroborated — the safety path that reaches the athlete before any
  // preference or calendar is consulted.
  const read = repo.dayRead(REF, {
    has_data: true,
    recovery: { sleep_min: 280, avg_sleep_min: 300 },
    quality: { sleep_min: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 } },
  });
  assert.notEqual(read.decision.rule_code, "lookahead_retimed_training");
  assert.notEqual(read.kind, "train");
});

// ---------- (d) no event ⇒ absent signal, unchanged behavior ----------

test("with nothing on tomorrow the signal is absent and the read is byte-for-byte what it was", () => {
  seedStackedMorning();
  const read = repo.dayRead(REF);

  assert.equal(read.signals.tomorrow_holds, undefined);
  assert.equal(read.signals.lookahead_retimed, undefined);
  assert.equal(read.kind, "train");
  assert.equal(read.decision.rule_code, "planned_training");
  assert.equal(
    read.signals.signal_state.dimensions.life_capacity.evidence.some((item) => item.field === "tomorrow_holds"),
    false
  );
});

test("an event starting the day AFTER tomorrow changes nothing", () => {
  seedStackedMorning();
  repo.addContextEvent({ kind: "life_event", title: "Two days out", start_date: localDaysAgo(-2) });

  const read = repo.dayRead(REF);
  assert.equal(read.signals.tomorrow_holds, undefined);
  assert.equal(read.kind, "train");
  assert.equal(read.decision.rule_code, "planned_training");
});

// ---------- (e) the words ----------

test("the re-timed read speaks in several calm phrasings that hold the reading grammar", () => {
  const why = DAY_READ_WHY_VARIANTS.lookahead_retimed_training;
  const reasons = DAY_READ_OUTCOMES.lookahead_retimed_training.reasons;
  assert.ok(why.length >= 3, "a stable input fires a stable rule — one literal reads as a broken app");
  assert.ok(reasons.length >= 3);
  assert.equal(new Set(why).size, why.length);
  assert.equal(new Set(reasons).size, reasons.length);
  for (const text of [...why, ...reasons]) {
    assert.equal(violatesReadingGrammar(text), null, `breaks the reading grammar: ${JSON.stringify(text)}`);
    assert.match(text, /\btomorrow\b/i, "the rule's own meaning");
    assert.match(text, /[.!?]$/);
  }
  // No phrasing may ask for more than easy work: this rule reaches INTO a run of
  // loading days, so it offers a comfortable session and never a reason to push.
  for (const text of why) assert.doesNotMatch(text, /\b(?:hard|push|heavy|full send|go big)\b/i);
});

test("consecutive mornings of the same re-timed read do not print the same sentence", () => {
  // A stable input fires a stable rule every morning, so the rotation — not the rule —
  // is what stops the sentence repeating. Asked of the vocabulary directly, over a run
  // of days, because seeding N consecutive live mornings would test the seeder.
  const key = "lookahead_retimed_training";
  const set = DAY_READ_WHY_VARIANTS[key];
  const days = ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19"];
  const landed = days.map((day) => pickDayVariant(set, day, key));
  for (let i = 1; i < landed.length; i++) {
    assert.notEqual(landed[i], landed[i - 1], `${days[i]} repeated the previous morning's sentence`);
  }
  // …and the same day always reads the same, so a reload never re-rolls the words.
  assert.equal(pickDayVariant(set, days[0], key), landed[0]);
});

// ---------- the prompt boundary ----------

test("the day-read prompt site carries the resolved look-ahead", () => {
  const ctx = { tomorrow_holds: { date: TOMORROW, events: [{ kind: "life_event", title: "Bloodwork" }] } };
  const data = promptData(ctx, "day_read");
  assert.match(data, /tomorrow_holds/);
  assert.match(data, /Bloodwork/);
  // The allowlist is a per-site decision, not a global one: the plan-shaping sites
  // reason over a whole week, where one day's commitment is noise.
  assert.doesNotMatch(promptData(ctx, "coach"), /tomorrow_holds/);
});
