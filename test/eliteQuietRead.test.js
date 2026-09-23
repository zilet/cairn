// The quiet (easy/rest) read, calibrated to THIS athlete (2026-09-23).
//
// Three laws, each pinned here:
//   1. The long "you train anyway, and it costs you nothing" learning is a continuous
//      WEIGHT with a small-sample floor, not a knife-edge conjunction — it could miss a
//      record by one day (14 × 4 = 56 < 57).
//   2. Harm is judged against the athlete's OWN nights and charged once per episode —
//      a seven-day watch verdict read LOW three mornings running used to be three harms.
//   3. The day-read AGENT may not read a deterministic train day quieter without naming
//      a fresh brake that is actually firing.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import {
  harmEvidenceOnDay,
  LEARNED_EASE_REST_WEIGHT,
  LEARNED_OPEN_EASY_WEIGHT,
  LEARNED_OPEN_REST_WEIGHT,
  learnedQuietStep,
  morningReadForDate,
  trainsAnywayWithoutHarm,
} from "../dist/repo/brain/read-adherence.js";
import { dayReadCitableBrakes } from "../dist/repo/day-read.js";
import { agentCautionLacksBrake, enforceNamedBrakeForCaution, isValidDayReadAgentResult } from "../dist/dayread.js";
import { buildDayReadPrompt } from "../dist/prompt.js";
import { DAY_READ_SCHEMA } from "../dist/agent-contracts.js";
import { matchesJsonSchema } from "../dist/json-schema.js";

beforeEach(() =>
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "day_reads",
    "brain_decisions",
    "brain_expectations"
  )
);

// ---------------------------------------------------------------- 1. the weight

const TODAY = () => localDaysAgo(0);

// A synthetic adherence model: `days` quiet mornings (1..days ago), the first
// `trainedThrough` of them taken above easy. Harm is real evidence in the DB, so the
// costly mornings carry a session the athlete rated poorly.
function quietModel({ days, trainedThrough, costly = [], read = "easy" }) {
  const recent = [];
  for (let back = days; back >= 1; back--) {
    const diverged = back <= trainedThrough;
    recent.push({
      date: localDaysAgo(back),
      read,
      outcome: diverged ? "diverged" : "followed",
      load: diverged ? "moderate" : "none",
      trained: diverged,
      softened: false,
      easy_softened: false,
    });
  }
  for (const back of costly) repo.setSessionFeedback(localDaysAgo(back), { performance: 2 });
  return { as_of: TODAY(), window_days: 44, days_observed: recent.length, by_read: [], recent };
}

test("a record that missed by one day now carries weight, and one more clean day moves it a little", () => {
  // 28 quiet mornings, 19 trained through, 5 of those at a cost: 14 clean — a record
  // the old conjunction refused by one day (14 × 4 = 56 < 57).
  const costly = [2, 6, 10, 14, 18];
  const fourteen = trainsAnywayWithoutHarm(quietModel({ days: 28, trainedThrough: 19, costly }), TODAY());
  assert.equal(fourteen.trained_through, 19);
  assert.equal(fourteen.trained_without_harm.length, 14);
  assert.ok(fourteen.weight >= LEARNED_OPEN_EASY_WEIGHT, `weight ${fourteen.weight}`);
  assert.equal(fourteen.mature, true);
  assert.equal(learnedQuietStep("easy", fourteen.weight), "train");

  resetTables("logged_sets", "sessions");
  const fifteen = trainsAnywayWithoutHarm(
    quietModel({ days: 28, trainedThrough: 19, costly: costly.slice(1) }),
    TODAY()
  );
  assert.equal(fifteen.trained_without_harm.length, 15);
  assert.ok(fifteen.weight > fourteen.weight, "one more harm-free override weighs more");
  assert.ok(fifteen.weight - fourteen.weight < 0.1, "…by a step, never a cliff");
  // Deterministic: the same evidence gives the same weight.
  assert.equal(trainsAnywayWithoutHarm(quietModel({ days: 28, trainedThrough: 19 }), TODAY()).weight,
    trainsAnywayWithoutHarm(quietModel({ days: 28, trainedThrough: 19 }), TODAY()).weight);
});

test("a small sample moves nothing: two clean overrides, or fewer than ten quiet mornings", () => {
  const two = trainsAnywayWithoutHarm(quietModel({ days: 12, trainedThrough: 2 }), TODAY());
  assert.equal(two.weight, 0);
  assert.equal(two.mature, false);
  assert.equal(learnedQuietStep("easy", two.weight), null);
  assert.equal(learnedQuietStep("rest", two.weight), null);

  const thin = trainsAnywayWithoutHarm(quietModel({ days: 9, trainedThrough: 9 }), TODAY());
  assert.equal(thin.weight, 0, "nine mornings, however clean, is below the floor");
});

test("the weight moves a quiet read in proportion — rest eases a rung before it opens", () => {
  assert.ok(LEARNED_EASE_REST_WEIGHT < LEARNED_OPEN_EASY_WEIGHT && LEARNED_OPEN_EASY_WEIGHT < LEARNED_OPEN_REST_WEIGHT);
  assert.equal(learnedQuietStep("rest", LEARNED_EASE_REST_WEIGHT - 0.01), null);
  assert.equal(learnedQuietStep("rest", LEARNED_EASE_REST_WEIGHT), "easy");
  assert.equal(learnedQuietStep("rest", LEARNED_OPEN_REST_WEIGHT - 0.01), "easy");
  assert.equal(learnedQuietStep("rest", LEARNED_OPEN_REST_WEIGHT), "train");
  assert.equal(learnedQuietStep("easy", LEARNED_OPEN_EASY_WEIGHT - 0.01), null);
  assert.equal(learnedQuietStep("easy", LEARNED_OPEN_EASY_WEIGHT), "train");
  assert.equal(learnedQuietStep("train", 1), null, "only a quiet read moves");
});

test("a recent cost weighs more than an old one", () => {
  const recentCost = trainsAnywayWithoutHarm(quietModel({ days: 30, trainedThrough: 24, costly: [1, 2, 3] }), TODAY());
  resetTables("logged_sets", "sessions");
  const oldCost = trainsAnywayWithoutHarm(quietModel({ days: 30, trainedThrough: 24, costly: [22, 23, 24] }), TODAY());
  assert.equal(recentCost.trained_without_harm.length, oldCost.trained_without_harm.length);
  assert.ok(recentCost.weight < oldCost.weight, `${recentCost.weight} vs ${oldCost.weight}`);
});

test("the long loop's own opened mornings stay in its evidence, off the ledger", () => {
  // Train mornings this loop opened are still quiet evidence (otherwise it empties its
  // own window and relapses on a cycle).
  const model = quietModel({ days: 12, trainedThrough: 12 });
  for (const day of model.recent.slice(-6)) Object.assign(day, { read: "train", learned_opened: true });
  const withOpened = trainsAnywayWithoutHarm(model, TODAY());
  assert.equal(withOpened.quiet_mornings, 12);
  for (const day of model.recent.slice(-6)) day.learned_opened = false;
  assert.equal(trainsAnywayWithoutHarm(model, TODAY()).quiet_mornings, 6);

  // …and the flag is read back from the morning read the athlete opened to.
  const date = localDaysAgo(2);
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Good to train.",
    why: "A calm sentence about the day.",
    focus: "Upper",
    est_minutes: 60,
    signals: { learned_train_anyway: { mature: true, weight: 0.5, applied: true, step: "train" } },
    source: "deterministic",
    override: null,
  });
  assert.equal(morningReadForDate(date)?.learnedOpened, true);
});

// ---------------------------------------------------------------- 2. harm, personally

function liftedOn(date) {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date, exercise: "Test Row", weight: 100, reps: 8 });
}

// `n` nights before `morning`, cycling through `values`.
function ownNights(morning, n, values, field = "hrv_ms") {
  const base = new Date(`${morning}T00:00:00Z`).getTime();
  for (let back = 1; back <= n; back++) {
    const date = new Date(base - back * 864e5).toISOString().slice(0, 10);
    repo.upsertGarminDailyMetric({ date, [field]: values[back % values.length] });
  }
}

test("a seven-day LOW verdict read three mornings running is ONE harm, charged to the day it began after", () => {
  // No personal band yet (too few nights), so the watch's own verdict stands in.
  const [d1, d2, d3] = [6, 5, 4].map(localDaysAgo);
  for (const day of [d1, d2, d3]) liftedOn(day);
  repo.upsertGarminDailyMetric({ date: d1, hrv_status: "BALANCED" });
  for (const back of [5, 4, 3]) repo.upsertGarminDailyMetric({ date: localDaysAgo(back), hrv_status: "LOW" });

  assert.equal(harmEvidenceOnDay(d1)?.kind, "physiology_brake", "the onset is news about the day before it");
  assert.equal(harmEvidenceOnDay(d2), null, "the same episode is not charged again");
  assert.equal(harmEvidenceOnDay(d3), null);
});

test("HRV is read against the athlete's own nights, not the watch's word", () => {
  // A low-HRV athlete: their ordinary nights run 35-47 ms. A 38 is inside their own
  // spread even with the watch calling the week LOW.
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  liftedOn(day);
  ownNights(morning, 14, [35, 38, 41, 44, 47]);
  repo.upsertGarminDailyMetric({ date: morning, hrv_ms: 38, hrv_status: "LOW" });
  assert.equal(harmEvidenceOnDay(day), null);

  // A high-HRV athlete: 76-84 ms nights, and a 70 the watch still calls BALANCED is a
  // real drop for THEM.
  resetTables("garmin_daily_metrics", "garmin_sources");
  ownNights(morning, 14, [76, 78, 80, 82, 84]);
  repo.upsertGarminDailyMetric({ date: morning, hrv_ms: 70, hrv_status: "BALANCED" });
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "physiology_brake");
  assert.match(harm.detail, /own band/);
});

test("resting HR is read against their own nights, and a run of high mornings is one episode", () => {
  const [d1, d2] = [4, 3].map(localDaysAgo);
  liftedOn(d1);
  liftedOn(d2);
  // Their own resting HR sits 48-52; the row's 7-day column is not a resting figure.
  ownNights(localDaysAgo(4), 14, [48, 49, 50, 51, 52], "resting_hr");
  repo.upsertGarminDailyMetric({ date: d1, resting_hr: 50, hr_7d_avg: 68 });
  repo.upsertGarminDailyMetric({ date: localDaysAgo(3), resting_hr: 56, hr_7d_avg: 68 });
  repo.upsertGarminDailyMetric({ date: localDaysAgo(2), resting_hr: 57, hr_7d_avg: 68 });

  const onset = harmEvidenceOnDay(d1);
  assert.equal(onset?.kind, "physiology_brake");
  assert.match(onset.detail, /resting hr 56 above own band/);
  assert.equal(harmEvidenceOnDay(d2), null, "the second high morning continues the same episode");
});

// ---------------------------------------------------------------- 3. the agent's named brake

const evidence = (field, direction, extra = {}) => ({ field, direction, freshness: "fresh", ...extra });
const trainBaseline = (ruleCode = "planned_training") => ({
  kind: "train",
  focus: "Upper",
  why: "Today's a good day for the session that's due.",
  est_minutes: 60,
  decision: { rule_code: ruleCode },
  signals: {
    today_load: "none",
    trained_today: false,
    signal_state: {
      dimensions: {
        recovery_capacity: {
          evidence: [evidence("sleep_min", "constraint"), evidence("hrv_ms", "caution", { freshness: "stale" })],
        },
        energy_fueling: {
          evidence: [evidence("hybrid_fuel", "caution", { advisory_brake: true, advice_only: true })],
        },
        training_load_tolerance: {
          evidence: [evidence("run_intensity_discipline", "caution", { advisory_brake: true })],
        },
      },
    },
  },
});
const easyRead = (extra = {}) => ({
  kind: "easy",
  headline: "Keep today easy.",
  why: "A lighter day sits better with how the week has gone.",
  focus: null,
  est_minutes: 30,
  ...extra,
});

test("a quieter read over a train baseline needs a named, fresh, deciding brake", () => {
  const baseline = trainBaseline();
  assert.deepEqual(dayReadCitableBrakes(baseline), ["sleep_min"]);

  assert.equal(isValidDayReadAgentResult(easyRead(), baseline), false, "no brake named");
  assert.equal(isValidDayReadAgentResult(easyRead({ brake: "hrv_ms" }), baseline), false, "a stale reading");
  assert.equal(isValidDayReadAgentResult(easyRead({ brake: "hybrid_fuel" }), baseline), false, "advice only");
  assert.equal(isValidDayReadAgentResult(easyRead({ brake: "run_intensity_discipline" }), baseline), false, "advisory");
  assert.equal(isValidDayReadAgentResult(easyRead({ brake: "made_up" }), baseline), false);
  assert.equal(isValidDayReadAgentResult(easyRead({ brake: "sleep_min" }), baseline), true, "a firing brake, named");
  assert.equal(isValidDayReadAgentResult({ ...easyRead(), kind: "rest", est_minutes: null, brake: "sleep_min" }, baseline), true);

  // The athlete's own steer is the brake; a train read, or a non-train baseline, is untouched.
  assert.equal(isValidDayReadAgentResult(easyRead(), baseline, undefined, { override: true }), true);
  assert.equal(isValidDayReadAgentResult({ ...easyRead(), kind: "train", focus: "Upper", est_minutes: 60 }, baseline), true);
  assert.equal(isValidDayReadAgentResult({ ...easyRead(), kind: "rest", est_minutes: null }, { ...baseline, kind: "easy" }), true);
  // The schema carries the field, so constrained decoding cannot drop it.
  assert.equal(matchesJsonSchema(DAY_READ_SCHEMA, easyRead({ brake: "sleep_min" }), { coerce: true }), true);
});

test("a day the athlete's own record opened has no citable brake", () => {
  for (const code of ["learned_train_anyway", "outcome_feedback_open"]) {
    const baseline = trainBaseline(code);
    assert.deepEqual(dayReadCitableBrakes(baseline), []);
    assert.equal(agentCautionLacksBrake(easyRead({ brake: "sleep_min" }), baseline), true, code);
  }
});

test("a quieter row that reaches the clamp without a live brake comes back as the server's train read", () => {
  const baseline = trainBaseline();
  const date = localDaysAgo(0);
  const agentRow = (brake) => ({
    ...easyRead(),
    source: "agent",
    agent: "claude",
    tried: ["claude"],
    decision: { rule_code: "agent_conservative_adjustment", basis: "agent", ...(brake ? { brake } : {}) },
  });

  const clamped = enforceNamedBrakeForCaution(agentRow("hrv_ms"), baseline, false, date);
  assert.equal(clamped.kind, "train");
  assert.equal(clamped.why, baseline.why, "the server's own wording, not the agent's easy sentence");
  assert.equal(clamped.source, "deterministic");
  assert.equal(clamped.agent, "claude", "provenance survives");
  assert.equal(clamped.decision.rule_code, "agent_caution_without_brake");
  assert.equal(clamped.decision.reason, "", "the clamp narrates nothing about Cairn's internals");

  const kept = agentRow("sleep_min");
  assert.equal(enforceNamedBrakeForCaution(kept, baseline, false, date), kept, "a live named brake stands");
  const steered = agentRow(null);
  assert.equal(enforceNamedBrakeForCaution(steered, baseline, true, date), steered, "an override stands");
  const floor = { ...agentRow(null), source: "deterministic" };
  assert.equal(enforceNamedBrakeForCaution(floor, baseline, false, date), floor);
});

test("the day-read prompt carries the named-brake rule with the exact list the validator holds", () => {
  const date = localDaysAgo(0);
  const live = repo.dayRead(date);
  const withBrake = { ...live, ...trainBaseline(), signals: { ...live.signals, ...trainBaseline().signals } };
  const prompt = buildDayReadPrompt(repo.getCoachContext(), { date, baseline: withBrake });
  assert.match(prompt, /NAMED BRAKE RULE \(the baseline is train\)/);
  assert.match(prompt, /one of: sleep_min\./);
  assert.match(prompt, /"brake":/, "the output contract names the field");

  const opened = { ...withBrake, decision: { rule_code: "learned_train_anyway" } };
  assert.match(buildDayReadPrompt(repo.getCoachContext(), { date, baseline: opened }), /keep it a training day \("brake": null\)/);

  const easy = { ...withBrake, kind: "easy" };
  assert.doesNotMatch(buildDayReadPrompt(repo.getCoachContext(), { date, baseline: easy }), /NAMED BRAKE RULE \(/);
  assert.doesNotMatch(
    buildDayReadPrompt(repo.getCoachContext(), { date, baseline: withBrake, override: "rough night" }),
    /NAMED BRAKE RULE \(/,
    "an athlete steer is its own brake"
  );
});
