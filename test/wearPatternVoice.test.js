// HOW ABSENCE IS SAID (src/repo/wear-pattern-voice.ts and its four consumers).
//
// The athlete wears the watch for runs and the occasional baseline night. Track C
// gave the brain a way to KNOW that (classifyWearPattern). This pins what the
// product then SAYS about it.
//
// Before this, every surface that voiced a missing wearable reading assumed one
// cause — nothing is connected, or the sync is broken — and said so in a fixed
// literal: "none synced yet", "No recent sleep or HRV synced — connecting a
// wearable would…", "recovery signal has gone quiet". For an episodic wearer all
// three are false, and the last two are an ask: fix your setup, wear the watch
// more. That is push, and the constitution says pull (VISION.md).
//
// The rulings asserted here:
//
//   SILENCE HAS A SHAPE, AND THE SHAPE IS SAYABLE.
//   A CADENCE MAY BE DESCRIBED; A HISTORY MAY NEVER BE INVENTED.
//
// And the invariant that outranks both: absence stays NEUTRAL. None of these
// words move a morning toward rest, and none of them ask for anything.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { classifyWearPattern } from "../dist/repo/sensor-cadence.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { nextBestStep, nextStepFocusCandidates } from "../dist/repo/next-step.js";
import {
  dominantSensorCadence,
  isWorkingEpisodicPattern,
  readingAgePhrase,
  wearAbsenceEvidence,
  wearAbsenceRowState,
  wearAbsenceView,
  wearAbsenceWhy,
  WEAR_ABSENCE_ROW_STATES,
  WEAR_ABSENCE_SENTENCES,
} from "../dist/repo/wear-pattern-voice.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = () => localDaysAgo(0);

// The words that were on the screen before this round, and what makes each wrong
// for a wearer whose watch is working exactly as they use it.
const FAULT_REPORT = /none synced yet|no wearable data synced|not synced|sync(?:ing)? (?:is )?broken/i;
// Any form of "wear it more / connect one". The whole point is that nothing here asks.
const AN_ASK = /\b(?:connect(?:ing)? a wearable|wear (?:your|the) watch|you should|try to wear|remember to)\b/i;

beforeEach(() => {
  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics", "sessions", "logged_sets", "activities");
});

function day(daysAgo, metrics) {
  return repo.recordDailyMetrics("apple", localDaysAgo(daysAgo), metrics);
}

// ---- the three fixtures this whole round exists for -------------------------

// The athlete in question: a reading roughly every fortnight, the last one 20
// days ago. Five dots in ninety days — a spot check, and a working habit.
function seedSpotCheckWearer() {
  for (const back of [20, 34, 48, 62, 76]) day(back, { sleep_min: 430, hrv_ms: 60, resting_hr: 52 });
}
// A daily wearer whose series genuinely stopped. Long enough that the 14-day
// recovery window is empty too, which is what puts it in front of the athlete.
function seedLapsedWearer() {
  for (let back = 15; back <= 75; back++) day(back, { sleep_min: 430, hrv_ms: 60, resting_hr: 52 });
}
// A daily wearer with the SHORT break the old wording was written for.
function seedFiveDayBreak() {
  for (let back = 5; back <= 70; back++) day(back, { sleep_min: 430, hrv_ms: 60, resting_hr: 52 });
}

function loadTodayBrief() {
  const escHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const context = { Array, Math, Number, Object, String, escHtml, escAttr: escHtml };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

function recoveryRow(read) {
  return loadTodayBrief()
    .signalsRows({ signals: read.signals })
    .find((row) => row.label === "Recovery signals");
}

function cadenceOf(read) {
  return read.signals.recovery_cadence;
}

// ---- the vocabulary itself ---------------------------------------------------

test("a reading's age is spoken in the register a habit is kept in, and coarsens with distance", () => {
  assert.equal(readingAgePhrase(0), "today");
  assert.equal(readingAgePhrase(1), "yesterday");
  assert.equal(readingAgePhrase(4), "4 days ago");
  assert.equal(readingAgePhrase(8), "about a week ago");
  assert.equal(readingAgePhrase(20), "about 3 weeks ago");
  assert.equal(readingAgePhrase(40), "about a month ago");
  assert.equal(readingAgePhrase(80), "about 3 months ago");
  // Unknowable, and a clock problem, both resolve to "say nothing".
  assert.equal(readingAgePhrase(null), null);
  assert.equal(readingAgePhrase(-3), null);
});

test("every athlete-facing absence set is a rotation, not a literal", () => {
  const view = wearAbsenceView(classifyWearPattern([localDaysAgo(20), localDaysAgo(34)], TODAY()), TODAY());
  for (const [shape, variants] of Object.entries(WEAR_ABSENCE_SENTENCES)) {
    assert.ok(variants.length >= 3, `${shape} sentences must be a set, got ${variants.length}`);
    assert.equal(new Set(variants).size, variants.length, `${shape} repeats a phrasing`);
  }
  for (const [shape, variants] of Object.entries(WEAR_ABSENCE_ROW_STATES)) {
    assert.ok(variants.length >= 3, `${shape} row states must be a set, got ${variants.length}`);
    assert.equal(new Set(variants).size, variants.length, `${shape} repeats a phrasing`);
  }
  // Stable within a day — two surfaces reading the same key on the same morning
  // must not disagree about the sentence.
  assert.equal(wearAbsenceWhy(view, "2026-03-02"), wearAbsenceWhy(view, "2026-03-02"));
  assert.equal(wearAbsenceRowState(view, "2026-03-02"), wearAbsenceRowState(view, "2026-03-02"));
  // And it moves across days: three consecutive dates cover the whole set.
  const spoken = ["2026-03-02", "2026-03-03", "2026-03-04"].map((date) => wearAbsenceWhy(view, date));
  assert.equal(new Set(spoken).size, 3, `the sentence repeated day over day: ${JSON.stringify(spoken)}`);
  const rows = ["2026-03-02", "2026-03-03", "2026-03-04"].map((date) => wearAbsenceRowState(view, date));
  assert.equal(new Set(rows).size, 3, `the row repeated day over day: ${JSON.stringify(rows)}`);
});

test("every absence phrasing clears the reading grammar, reports no fault and asks for nothing", () => {
  const rendered = [];
  for (const variants of Object.values(WEAR_ABSENCE_SENTENCES)) rendered.push(...variants);
  for (const variants of Object.values(WEAR_ABSENCE_ROW_STATES)) rendered.push(...variants);
  for (const text of rendered.map((variant) => variant.replace(/\{\}/g, "about 3 weeks ago"))) {
    assert.equal(violatesReadingGrammar(text), null, `broke the reading grammar: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, FAULT_REPORT, `reports a fault: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, AN_ASK, `asks the athlete to change a habit: ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /\bthe athlete\b/i, `talks about the athlete instead of to them: ${text}`);
  }
});

test("a cadence may be described; a history may never be invented", () => {
  const nothing = wearAbsenceView(classifyWearPattern([], TODAY()), TODAY());
  assert.equal(nothing.shape, "unworn");
  assert.equal(nothing.readings, 0);
  assert.equal(nothing.last_reading_date, null);
  assert.equal(nothing.age_phrase, null);
  // `Number(null)` is 0 and passes isFinite — an unguarded median would have
  // reported a series with no readings as "typically 0 days apart".
  assert.equal(nothing.median_gap_days, null);
  const spoken = wearAbsenceRowState(nothing, TODAY());
  assert.doesNotMatch(spoken, /\bago\b|\bweeks?\b|\bmonths?\b|\byesterday\b/i, `invented a history: ${spoken}`);
  assert.match(spoken, /wearable|watch/i);
  assert.equal(wearAbsenceEvidence(nothing), "No wearable readings on record.");
  assert.equal(isWorkingEpisodicPattern(nothing), false);

  // One stray reading from last season is residue, not a cadence.
  const stale = wearAbsenceView(classifyWearPattern([localDaysAgo(80)], TODAY()), TODAY());
  assert.equal(stale.shape, "episodic", "a dated reading is still a history");
  assert.equal(isWorkingEpisodicPattern(stale), false, "one dot is not a rhythm");
});

test("the cadence spoken for is the densest series, so a run-day reading is not hidden by a sparse one", () => {
  const quality = {
    sleep_min: { cadence: classifyWearPattern([localDaysAgo(40)], TODAY()) },
    hrv_ms: { cadence: classifyWearPattern([localDaysAgo(2), localDaysAgo(5), localDaysAgo(9)], TODAY()) },
    resting_hr: {},
  };
  const chosen = dominantSensorCadence(quality);
  assert.equal(chosen.readings, 3);
  assert.equal(chosen.last_reading_date, localDaysAgo(2));
  assert.equal(dominantSensorCadence({ sleep_min: {} }), null, "no cadence anywhere → say nothing");
  assert.equal(dominantSensorCadence(null), null);
});

// ---- fixture 1: the spot-check wearer ----------------------------------------

test("SPOT CHECK: the day read names the athlete's own cadence instead of a missing sync", () => {
  seedSpotCheckWearer();
  const read = repo.dayRead(TODAY());
  const cadence = cadenceOf(read);

  assert.equal(cadence.pattern, "spot_check");
  assert.equal(cadence.shape, "episodic");
  assert.equal(cadence.readings, 5);
  assert.equal(cadence.last_reading_date, localDaysAgo(20));
  assert.equal(cadence.last_reading_age_days, 20);
  assert.equal(cadence.median_gap_days, 14);
  assert.equal(cadence.working_episodic, true);

  // The Brief's quiet row: the last reading's age, in weeks, read as a rhythm.
  const row = recoveryRow(read);
  assert.ok(row, "the quiet row still appears — the fact is worth stating");
  assert.equal(row.tone, "quiet");
  assert.equal(row.state, cadence.absence_state, "the client says exactly what the server sent");
  assert.match(row.state, /about 3 weeks ago/);
  assert.doesNotMatch(row.state, FAULT_REPORT);
  assert.doesNotMatch(row.state, AN_ASK);
});

test("SPOT CHECK: the machine register carries the date and the pattern, not a bare absence", () => {
  seedSpotCheckWearer();
  const state = repo.dayRead(TODAY()).signals.signal_state;
  const recovery = state.dimensions.recovery_capacity;

  assert.match(recovery.reason, /No reading in the freshness window/);
  assert.match(recovery.reason, new RegExp(`last reading ${localDaysAgo(20)}`));
  assert.match(recovery.reason, /spot-check pattern, 5 readings\/90d/);
  assert.doesNotMatch(recovery.reason, /No current evidence in this dimension/);
  // The action-level reason keeps its ruling sentence and gains the evidence.
  assert.match(state.action.reason, /not enough fresh signal/i);
  assert.match(state.action.reason, /spot-check pattern/);

  // And the athlete-facing sibling speaks the cadence, not the generic floor.
  assert.equal(state.action.voice.key, "wear_absence_episodic");
  assert.equal(state.action.voice.subject, "about 3 weeks ago");
  assert.equal(recovery.voice.key, "wear_absence_episodic");
});

test("SPOT CHECK: the next step does not tell a working wearer to fix their sync", () => {
  seedSpotCheckWearer();
  // The producer emits NOTHING for a working episodic pattern: there is no move to
  // make, so the slot goes to a real step from another domain instead. (Checked at
  // the producer, not through nextBestStep, which drops the ambient data-gap step
  // for everyone — the conductor is the surface that would still have shown it.)
  assert.equal(
    nextStepFocusCandidates(TODAY()).find((candidate) => candidate.kind === "recover:data-gap"),
    undefined
  );
  assert.equal(nextBestStep(TODAY())?.step_key, undefined);
});

test("SPOT CHECK: the reaction model attributes the gap to sampling, never to a fault", () => {
  seedSpotCheckWearer();
  const gap = repo.buildReactionModel().patterns.find((pattern) => pattern.id === "data_gap");
  assert.ok(gap, "a gap is still reported — the coach must know it cannot see a current reading");
  assert.match(gap.statement, /occasional by pattern/i);
  assert.match(gap.statement, /5 in the last 90 days/);
  assert.match(gap.statement, /roughly 14 days apart/);
  assert.match(gap.statement, /not a broken sync/i);
  assert.doesNotMatch(gap.statement, /gone quiet/i, "a cadence is not a malfunction");
  assert.equal(gap.params.readings, 5);
  assert.equal(gap.params.median_gap_days, 14);
  assert.equal(gap.params.age_days, 20, "day-keyed, like every other age in the brain");
});

test("SPOT CHECK: naming the cadence still never moves the morning toward rest", () => {
  seedSpotCheckWearer();
  const read = repo.dayRead(TODAY());
  const state = read.signals.signal_state;
  assert.equal(state.action.posture, "train", "absence is neutral, and stays neutral when it is explained");
  assert.equal(state.action.readiness, "unknown");
  assert.equal(state.action.directives.training, "proceed");
  assert.notEqual(read.kind, "rest");
});

// ---- fixture 2: the daily wearer whose series stopped ------------------------

test("LAPSED: a genuine break names the age of the last reading and stays at least as informative", () => {
  seedLapsedWearer();
  const read = repo.dayRead(TODAY());
  const cadence = cadenceOf(read);

  assert.equal(cadence.pattern, "continuous");
  assert.equal(cadence.shape, "lapsed");
  assert.equal(cadence.working_episodic, false, "a stopped daily series is not a working cadence");
  assert.equal(cadence.last_reading_age_days, 15);

  // Strictly MORE than the old line: it still offers the check-in, and it now
  // says when the last reading was.
  const row = recoveryRow(read);
  assert.match(row.state, /about 2 weeks ago/);
  assert.match(row.state, /check-in/);

  // The step fires (this one IS worth a heads-up) and names the age without
  // claiming nothing is connected and without asking for anything.
  const step = nextStepFocusCandidates(TODAY()).find((candidate) => candidate.kind === "recover:data-gap");
  assert.ok(step, "a stopped daily series is worth a calm heads-up");
  assert.match(step.why, /about 2 weeks ago/);
  assert.doesNotMatch(step.why, FAULT_REPORT);
  assert.doesNotMatch(step.why, AN_ASK);
  assert.deepEqual(step.priority_inputs, [`Last wearable reading was ${localDaysAgo(15)}`]);

  assert.match(read.signals.signal_state.dimensions.recovery_capacity.reason, /daily-wear pattern, 61 readings\/90d/);
  assert.equal(read.signals.signal_state.action.posture, "train");
});

test("LAPSED: a five-day break in a daily series keeps the wording it has today", () => {
  seedFiveDayBreak();
  const gap = repo.buildReactionModel().patterns.find((pattern) => pattern.id === "data_gap");
  assert.ok(gap);
  assert.match(gap.statement, /about 5 days old/);
  assert.match(gap.statement, /gone quiet/i, "for a daily wearer this really is a quiet stretch");
  assert.doesNotMatch(gap.statement, /occasional by pattern/i);
});

// ---- fixture 3: no wearable at all -------------------------------------------

test("NEVER WORN: the calm 'no wearable connected' read survives, with no fabricated cadence", () => {
  const read = repo.dayRead(TODAY());
  const cadence = cadenceOf(read);

  assert.equal(cadence.pattern, "none");
  assert.equal(cadence.shape, "unworn");
  assert.equal(cadence.readings, 0);
  assert.equal(cadence.last_reading_date, null);
  assert.equal(cadence.last_reading_age_days, null);
  assert.equal(cadence.median_gap_days, null);
  assert.equal(cadence.working_episodic, false);

  const row = recoveryRow(read);
  assert.match(row.state, /wearable|watch/i);
  assert.doesNotMatch(row.state, /\bago\b|\bweeks?\b|\bmonths?\b/i, "there is no history to date");

  const step = nextStepFocusCandidates(TODAY()).find((candidate) => candidate.kind === "recover:data-gap");
  assert.ok(step, "an athlete with no wearable still gets the calm heads-up it was written for");
  assert.ok(
    WEAR_ABSENCE_SENTENCES.unworn.includes(step.why),
    `unexpected wording for a never-worn athlete: ${JSON.stringify(step.why)}`
  );
  assert.deepEqual(step.priority_inputs, ["No recent sleep or HRV data is synced"]);

  const state = read.signals.signal_state;
  assert.equal(state.dimensions.recovery_capacity.reason, "No wearable readings on record.");
  assert.equal(state.action.voice.key, "wear_absence_unworn");
  assert.equal(state.action.posture, "train", "no wearable has never been a reason to rest");
});

// ---- the compatibility floor -------------------------------------------------

test("a caller that knows nothing about wear habits gets exactly the state it got before", () => {
  const bare = repo.buildUnifiedSignalState(TODAY(), []);
  assert.equal(bare.action.voice.key, "unvoiced_open");
  assert.match(bare.action.reason, /not enough fresh signal/i);
  assert.doesNotMatch(bare.action.reason, /pattern|readings\/90d/);
  assert.equal(bare.dimensions.recovery_capacity.reason, "No current evidence in this dimension.");
  assert.equal(bare.action.posture, "train");

  // And a client payload with no cadence keeps the shipped literal.
  const rows = loadTodayBrief().signalsRows({ signals: { consecutive_training_days: 3 } });
  assert.equal(
    rows.find((row) => row.label === "Recovery signals")?.state,
    "none synced yet — a morning check-in sharpens the read"
  );
});
