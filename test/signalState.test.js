import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDayReadPrompt,
  buildMealPlanPrompt,
  buildMealSwapPrompt,
  buildNutritionCheckinPrompt,
} from "../dist/prompt.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "checkins",
    "daily_metrics",
    "garmin_daily_metrics",
    "garmin_sources",
    "food_notes",
    "bodyweight_log",
    "context_events",
    "sessions",
    "logged_sets",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

test("field/date collisions and linked activity duplicates resolve once with provenance", () => {
  const date = localDaysAgo(0);
  const state = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "sleep",
      date,
      source: "apple",
      direction: "caution",
      summary: "Apple reported a short night.",
    },
    {
      dimension: "recovery_capacity",
      field: "sleep",
      date,
      source: "garmin",
      direction: "support",
      summary: "Garmin's source-resolved sleep supports the day.",
    },
    {
      dimension: "training_load_tolerance",
      field: "activity_load",
      date,
      source: "activities:garmin",
      direction: "caution",
      summary: "The linked run added load.",
      observation_id: "garmin:run-42",
    },
    {
      dimension: "training_load_tolerance",
      field: "activity_load",
      date,
      source: "garmin_activity",
      direction: "caution",
      summary: "The same linked run added load.",
      observation_id: "garmin:run-42",
    },
    {
      dimension: "recovery_capacity",
      field: "hrv",
      date,
      source: "apple",
      direction: "support",
      summary: "Apple supplied a complementary HRV field.",
    },
  ]);

  const recovery = state.dimensions.recovery_capacity;
  assert.equal(recovery.evidence.length, 2, "the duplicate sleep resolves once while complementary HRV survives");
  const sleep = recovery.evidence.find((item) => item.field === "sleep");
  assert.equal(sleep.source, "garmin");
  assert.deepEqual(sleep.selected_from.sort(), ["apple", "garmin"]);
  assert.equal(recovery.evidence.find((item) => item.field === "hrv").source, "apple");
  const training = state.dimensions.training_load_tolerance;
  assert.equal(training.evidence.length, 1, "the linked Garmin/manual activity is not counted twice");
  assert.equal(training.evidence[0].selected_from.length, 2);
});

// The field name here used to be `felt_fatigue`, which is a REAL field owned by the
// autoregulation observation (training_load_tolerance, dated to the session, 7-day
// window) — so this case was pinning the felt-protect rung through a name that in
// production carries a week-old session rating. `felt_energy` is the check-in field
// this rung actually exists for; the behaviour under test is unchanged.
test("fresh user-reported fatigue overrides benign wearable evidence and preserves the conflict", () => {
  const date = localDaysAgo(0);
  const state = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "training_readiness",
      date,
      source: "garmin",
      direction: "support",
      summary: "The wearable readiness signal is supportive.",
    },
    {
      dimension: "recovery_capacity",
      field: "felt_energy",
      date,
      source: "user_checkin",
      direction: "constraint",
      summary: "The athlete reports being exhausted today.",
      safety_override: true,
      max_age_days: 0,
    },
  ]);

  assert.equal(state.dimensions.recovery_capacity.status, "constrained");
  assert.equal(state.dimensions.recovery_capacity.conflicts.length, 1);
  assert.equal(state.action.posture, "rest");
  assert.equal(state.action.readiness, "protect");
  assert.match(state.action.reason, /exhausted/i);
});

test("stale evidence lowers confidence and cannot manufacture readiness", () => {
  const date = localDaysAgo(0);
  const state = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "sleep",
      date: localDaysAgo(12),
      source: "garmin",
      direction: "support",
      summary: "An old sleep reading looked good.",
      max_age_days: 3,
    },
  ]);

  const recovery = state.dimensions.recovery_capacity;
  assert.equal(recovery.status, "unknown");
  assert.equal(recovery.confidence, "low");
  assert.deepEqual(recovery.coverage.active_fields, []);
  assert.deepEqual(recovery.coverage.stale_fields, ["sleep"]);
  assert.equal(state.action.readiness, "unknown");
  assert.equal(state.action.posture, "train", "missing recovery is not invented as a zero or forced rest");
});

test("a sparse no-data state keeps every dimension unknown and the default flexible", () => {
  const state = repo.buildUnifiedSignalState(localDaysAgo(0), []);
  for (const dimension of Object.values(state.dimensions)) {
    assert.equal(dimension.status, "unknown");
    assert.equal(dimension.confidence, "none");
    assert.equal(dimension.latest_date, null);
    assert.equal(dimension.evidence.length, 0);
  }
  assert.equal(state.action.readiness, "unknown");
  assert.equal(state.action.posture, "train");
  assert.match(state.action.reason, /not enough fresh signal/i);
});

test("completed work owns the unified posture before any prospective planning", () => {
  const state = repo.planningSignalState({ date: localDaysAgo(0), completedToday: true });
  assert.equal(state.action.posture, "done");
  assert.equal(state.action.readiness, "complete");
  assert.match(state.action.reason, /already complete/i);
});

test("partial expenditure shapes fueling without downgrading training posture", () => {
  const state = repo.planningSignalState({
    date: localDaysAgo(0),
    expenditure: {
      tdee: 2200,
      confidence: "low",
      tdee_basis: "blended_outcome_prior",
      points: 14,
      window_days: 21,
      quality: { intake: "partial", outcome: "implausible_low", explanation: "Some logged days look partial." },
    },
  });
  assert.equal(state.dimensions.energy_fueling.status, "watch");
  assert.equal(state.action.posture, "train");
  assert.equal(state.action.directives.training, "proceed");
  assert.equal(state.action.directives.fueling, "settling");

  const fuelProtect = repo.planningSignalState({
    date: localDaysAgo(0),
    programState: { hybrid: { status: "fuel-protect", headline: "Protect fuel around the recent long effort." } },
  });
  assert.equal(fuelProtect.action.posture, "train", "fuel protection can coexist with a training day");
  assert.equal(fuelProtect.action.directives.fueling, "protect");
});

test("the shared under-fueling read protects actual daily planning at the proportional dose", () => {
  const date = localDaysAgo(0);
  const prescription = repo.planningSignalState({
    date,
    underfueling: {
      state: "prescription_strain",
      agreeing_channels: ["weight_trend", "performance", "recovery"],
      rationale: "Independent channels agree.",
      action: { training: "hold_aggression", line: "One bounded fuel step is settling." },
    },
  });
  assert.equal(prescription.dimensions.energy_fueling.status, "constrained");
  assert.equal(prescription.action.posture, "modify", "a bounded correction holds aggression rather than forcing rest");
  assert.equal(prescription.action.directives.training, "hold_aggression");
  assert.equal(prescription.action.directives.fueling, "protect");

  const persistent = repo.planningSignalState({
    date,
    underfueling: {
      state: "persistent_strain",
      agreeing_channels: ["weight_trend", "performance", "recovery"],
      rationale: "The prior correction has settled and strain persists.",
      action: { training: "reduce", line: "Coordinate a recovery week and fuel toward maintenance." },
    },
  });
  assert.equal(persistent.dimensions.training_load_tolerance.status, "constrained");
  assert.equal(persistent.action.posture, "easy");
  assert.equal(persistent.action.directives.training, "recover");
});

// ---------- two registers, one arbitration ----------
// `summary` is the MACHINE contract: renderSignalState prints it into every coach
// prompt, the conductor quotes it as evidence, and the provenance trail is written in
// it — so it stays third-person observer prose, exactly as it was. What changed is
// that it is no longer ALSO what the athlete reads: day-read's protect rule used to
// assign action.reason to the Brief's headline. This case pins both sides of that.
test("the machine-facing summaries are untouched and the athlete voice sits beside them", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    checkin: { energy: 3, sleep_feel: 1, soreness: 5 },
    recovery: {
      recovery: { sleep_min: 280, training_readiness: 20 },
      delta: { hrv: -9, rhr: 6 },
      quality: {
        sleep_min: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 1 },
        training_readiness: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 1 },
        hrv_ms: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 1 },
        resting_hr: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 1 },
      },
    },
  });

  const summaryOf = (dimension, field) =>
    state.dimensions[dimension].evidence.find((item) => item.field === field)?.summary;
  assert.equal(summaryOf("recovery_capacity", "sleep"), "The most recent recorded night came in short.");
  assert.equal(summaryOf("recovery_capacity", "training_readiness"), "The wearable readiness signal is subdued.");
  assert.equal(summaryOf("recovery_capacity", "hrv"), "HRV is below the athlete's recent norm.");
  assert.equal(summaryOf("recovery_capacity", "resting_hr"), "Resting heart rate is above the athlete's norm.");
  assert.equal(
    summaryOf("recovery_capacity", "sleep_feel"),
    "The athlete feels poorly recovered despite any wearable reading."
  );
  assert.equal(summaryOf("recovery_capacity", "felt_energy"), "The athlete reports workable energy today.");
  assert.equal(summaryOf("training_load_tolerance", "felt_soreness"), "The athlete reports high soreness today.");

  // The two prose fields renderSignalState actually prints are still the summary.
  const felt = state.dimensions.recovery_capacity.evidence.find((item) => item.field === "sleep_feel");
  assert.equal(state.action.reason, felt.summary);
  assert.equal(state.dimensions.recovery_capacity.reason, felt.summary);
  assert.ok(state.action.reasons.includes(felt.summary));

  // The athlete voice is a separate vocabulary: several phrasings, second person, and
  // never the summary itself.
  assert.equal(state.action.voice.key, "sleep_feel_low");
  const spoken = repo.signalVoice(state.action.voice);
  assert.ok(spoken.length >= 3, "a stable input must not print one literal forever");
  for (const line of spoken) {
    assert.doesNotMatch(line, /\bthe athlete\b/i);
    assert.notEqual(line, felt.summary);
  }
});

test("the low-energy check-in observes in the machine register and prescribes only in its voice", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({ date, checkin: { energy: 1 } });
  const felt = state.dimensions.recovery_capacity.evidence.find((item) => item.field === "felt_energy");

  // A low-energy check-in reaches the athlete through two paths: this protect posture
  // and day-read's felt_run_down_rest rule, and BOTH speak the `felt_energy_low` voice,
  // so they cannot drift into different registers. The summary is the other register
  // entirely: it is the POSTURE line renderSignalState prints into every prompt and the
  // `based_on` provenance, and it was second person AND a verdict ("You're feeling
  // run-down today — rest is the smart call."), handing the model the conclusion where
  // the contract promises it an observation.
  assert.equal(state.action.voice.key, "felt_energy_low");
  assert.equal(felt.summary, "The athlete reports feeling run-down today.");
  assert.doesNotMatch(felt.summary, /\byou(?:'re| are|r)\b/i, "the machine register never speaks to the athlete");
  assert.doesNotMatch(felt.summary, /\brest is the smart call\b/i, "the machine register observes, never prescribes");
  assert.equal(state.action.reason, felt.summary);
  // The athlete-facing sentence is unchanged and still carries the judgement.
  assert.ok(repo.signalVoice(state.action.voice).includes("You're feeling run-down today — rest is the smart call."));
});

// ---------- the sentence may not outrun its evidence window ----------
// `recovery.sleep_min` is getRecoverySummary's `current(...)` — the latest dated night,
// never an average (`avg_sleep_min` is the separate trend, and day-read's own low_sleep
// flag reads THAT). One 4h50m night inside a fortnight of 8h nights used to lead the
// Brief with "Short nights have been stacking up", printed directly above the signals
// row saying sleep was settling in about normal.
test("a single short night speaks for that night, never for a run of them", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: {
      recovery: { sleep_min: 290, avg_sleep_min: (13 * 480 + 290) / 14 },
      delta: { sleep: -13.5 },
      quality: { sleep_min: { latest_date: date, source: "garmin", sample_count: 14, window_days: 14 } },
    },
  });

  const recovery = state.dimensions.recovery_capacity;
  assert.deepEqual(
    recovery.evidence.map((item) => item.field),
    ["sleep"],
    "a healthy 14-day average contributes no chronic observation"
  );
  // Under 5h still owns the day — only the words changed.
  assert.equal(recovery.evidence[0].direction, "constraint");
  assert.equal(state.action.posture, "easy");
  assert.equal(recovery.evidence[0].summary, "The most recent recorded night came in short.");
  assert.equal(state.action.voice.key, "sleep_night_short");
  for (const line of repo.signalVoice(state.action.voice)) {
    assert.doesNotMatch(line, /\bnights\b/i, "a single night must not be spoken as a pattern");
    assert.doesNotMatch(line, /\blately\b|\bstacking up\b/i);
    assert.match(line, /\bnight\b/i);
  }
});

test("the chronic sleep phrasings belong to an observation built from the window", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: {
      // A fine night on top of a fortnight averaging 5h30m.
      recovery: { sleep_min: 430, avg_sleep_min: 330 },
      quality: { sleep_min: { latest_date: date, source: "garmin", sample_count: 14, window_days: 14 } },
    },
  });

  const recovery = state.dimensions.recovery_capacity;
  const trend = recovery.evidence.find((item) => item.field === "sleep_trend");
  assert.ok(trend, "a sub-6h average is its own observation");
  assert.equal(trend.direction, "caution", "the window informs the day; the night still owns it");
  assert.equal(trend.voice.key, "sleep_short");
  assert.equal(recovery.evidence.find((item) => item.field === "sleep").voice.key, "sleep_night_ok");
  // The two registers of the same disagreement, held rather than averaged.
  assert.equal(recovery.conflicts.length, 1);
  assert.match(recovery.conflicts[0], /But sleep across the recent window/);
  assert.equal(recovery.voice.key, "sleep_short");
  // One caution, alone on the board: since the 2026-08-17 rebalance that is a finding
  // the read speaks, not a second opinion that holds the week (see the bar in
  // planningDirectives and the cases in brainRebalanceEarnPath.test.js). The dimension
  // is still at watch, which is what this case is actually about.
  assert.equal(recovery.status, "watch");
  assert.equal(state.action.directives.training, "proceed");
});

// day-read requires a readiness reading dated today or yesterday before it may force a
// recommendation ("a stale current value cannot" either). This layer accepted three
// days, and its protect rule leads off `action.posture` alone — so a three-day-old
// reading produced an easy read the deterministic Brief had already refused to make,
// voiced as though the watch had said it that morning.
test("readiness decides on the same one-day window day-read gates on, and says nothing about this morning", () => {
  const date = localDaysAgo(0);
  const readingFrom = (back) =>
    repo.planningSignalState({
      date,
      recovery: {
        recovery: { training_readiness: 30 },
        quality: { training_readiness: { latest_date: localDaysAgo(back), source: "garmin", sample_count: 1 } },
      },
    });

  for (const back of [0, 1]) {
    const state = readingFrom(back);
    const evidence = state.dimensions.recovery_capacity.evidence[0];
    assert.equal(evidence.freshness, "fresh", `a ${back}-day-old reading is a today-decision signal`);
    assert.equal(state.action.posture, "easy");
    assert.equal(state.action.voice.key, "readiness_subdued");
  }

  const stale = readingFrom(2);
  assert.equal(stale.dimensions.recovery_capacity.evidence[0].freshness, "stale");
  assert.equal(stale.dimensions.recovery_capacity.status, "unknown", "older readings are context, never a gate");
  assert.deepEqual(stale.dimensions.recovery_capacity.coverage.stale_fields, ["training_readiness"]);
  assert.equal(stale.action.posture, "train");

  // Even one day old is yesterday, so neither direction may claim the morning.
  for (const key of ["readiness_subdued", "readiness_ok"]) {
    for (const line of repo.signalVoice({ key })) {
      assert.doesNotMatch(line, /\bthis morning\b/i, `${key} claims a reading it may not have`);
      assert.doesNotMatch(line, /\btoday's reading\b/i, `${key} claims a reading it may not have`);
    }
  }
});

test("the readiness summary does not assert a freshness it cannot know", () => {
  const date = localDaysAgo(0);
  const at = (value) =>
    repo
      .planningSignalState({
        date,
        recovery: {
          recovery: { training_readiness: value },
          quality: { training_readiness: { latest_date: date, source: "garmin", sample_count: 1 } },
        },
      })
      .dimensions.recovery_capacity.evidence.find((item) => item.field === "training_readiness").summary;

  // renderSignalState already prints `latest <date>` beside it, which carries the age
  // honestly; the literal used to hardcode "fresh" for anything up to three days old.
  assert.equal(at(30), "The wearable readiness signal is subdued.");
  assert.equal(at(80), "The wearable readiness signal is supportive.");
});

// The conflict line splices the brake onto the support mid-sentence, and lowercased its
// first character unconditionally — so "HRV is below the athlete's recent norm." reached
// the coach context and the provenance trail as "hRV …". Sleep support plus an HRV
// caution is an ordinary morning.
test("a spliced brake keeps an acronym's and a brand's own case", () => {
  const date = localDaysAgo(0);
  const fresh = { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 };
  const acronym = repo.planningSignalState({
    date,
    recovery: {
      recovery: { sleep_min: 450 },
      delta: { hrv: -9 },
      quality: { sleep_min: fresh, hrv_ms: fresh },
    },
  });
  assert.equal(acronym.dimensions.recovery_capacity.conflicts.length, 1);
  assert.match(acronym.dimensions.recovery_capacity.conflicts[0], /But HRV is below/);
  assert.doesNotMatch(acronym.dimensions.recovery_capacity.conflicts[0], /\bhRV\b/);

  const brand = repo.planningSignalState({
    date,
    recovery: {
      recovery: { exercise_min: 51, distance_km: 8.4 },
      quality: {
        exercise_min: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    },
    programState: { mesocycle: { acute_chronic_ratio: 1 } },
  });
  assert.match(brand.dimensions.training_load_tolerance.conflicts[0], /But Apple daily activity/);

  // An ordinary sentence opener still comes down — the line is one sentence.
  const ordinary = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "a",
      date,
      source: "garmin",
      direction: "support",
      summary: "Sleep is fine.",
    },
    {
      dimension: "recovery_capacity",
      field: "b",
      date,
      source: "garmin",
      direction: "caution",
      summary: "Resting heart rate is up.",
    },
  ]);
  assert.equal(ordinary.dimensions.recovery_capacity.conflicts[0], "Sleep is fine. But resting heart rate is up.");
});

// #4's sibling guard: every summary this module AUTHORS is third-person evidence. The
// pass-through summaries (a mesocycle note, a hybrid headline, an underfueling action
// line) are another subsystem's machine prose and are deliberately not covered here.
test("every authored summary stays in the machine register", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    checkin: { energy: 1, sleep_feel: 1, soreness: 5 },
    recovery: {
      recovery: { sleep_min: 290, avg_sleep_min: 300, training_readiness: 20, exercise_min: 51, distance_km: 8.4 },
      delta: { hrv: -9, rhr: 6 },
      quality: {
        sleep_min: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 },
        training_readiness: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 1 },
        hrv_ms: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 },
        resting_hr: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 },
        exercise_min: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    },
    trainingSignals: { autoregulation: { joint_areas: ["Knees"], low_performance_flag: true } },
    context: {
      reduce_load: true,
      fueling_disrupted: true,
      expect_worse_sleep: true,
      active: [
        { kind: "injury", reduce_load: true, title: "Shoulder strain", reason: "an active injury is worth easing" },
      ],
    },
    completedToday: true,
  });

  const summaries = Object.values(state.dimensions).flatMap((dimension) =>
    dimension.evidence.map((item) => ({ field: item.field, summary: item.summary }))
  );
  assert.ok(summaries.length >= 10, "the whole authored vocabulary is under test");
  for (const { field, summary } of summaries) {
    assert.doesNotMatch(
      summary,
      /\byou(?:'re| are|r|'ve)?\b/i,
      `${field} speaks to the athlete in the machine register`
    );
    assert.doesNotMatch(
      summary,
      /\bis the smart call\b|\btake today\b/i,
      `${field} prescribes where it should observe`
    );
  }
});

test("a voice-less observation degrades to an athlete-facing floor, never to the summary", () => {
  const date = localDaysAgo(0);
  const state = repo.buildUnifiedSignalState(date, [
    {
      // Same rename as the case above, for the same reason.
      dimension: "recovery_capacity",
      field: "felt_energy",
      date,
      source: "user_checkin",
      direction: "constraint",
      summary: "The athlete reports being exhausted today.",
      safety_override: true,
      max_age_days: 0,
    },
  ]);

  assert.equal(state.action.posture, "rest");
  assert.equal(state.action.reason, "The athlete reports being exhausted today.");
  assert.equal(state.action.voice.key, "unvoiced_protect");
  for (const line of repo.signalVoice(state.action.voice)) assert.doesNotMatch(line, /\bthe athlete\b/i);
});

// The joint_pain voice's subject used to be a bare `.join(", ")`, so multiple
// areas read as "your left knee, right shoulder" — a person would say "your left
// knee and right shoulder". joinList (src/repo/shared.ts) fixes this for 2 items
// (plain "and", no comma) and 3+ (Oxford comma before "and").
test("joint_pain voice joins a single area plainly", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: { autoregulation: { joint_areas: ["Left knee"] } },
  });
  const evidence = state.dimensions.health_constraints.evidence.find((e) => e.field === "joint_pain");
  assert.ok(evidence, "joint_pain observation present");
  assert.equal(evidence.voice.subject, "left knee");
  const [variant] = repo.signalVoice(evidence.voice);
  assert.match(variant, /\bleft knee\b/);
});

test("joint_pain voice joins two areas with 'and', no comma", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: { autoregulation: { joint_areas: ["Left knee", "Right shoulder"] } },
  });
  const evidence = state.dimensions.health_constraints.evidence.find((e) => e.field === "joint_pain");
  assert.equal(evidence.voice.subject, "left knee and right shoulder");
});

test("joint_pain voice joins 3+ areas with an Oxford comma", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: { autoregulation: { joint_areas: ["Left knee", "Right shoulder", "Lower back"] } },
  });
  const evidence = state.dimensions.health_constraints.evidence.find((e) => e.field === "joint_pain");
  assert.equal(evidence.voice.subject, "left knee, right shoulder, and lower back");
  const [variant] = repo.signalVoice(evidence.voice);
  assert.match(variant, /left knee, right shoulder, and lower back/);
});

test("Apple-only daily activity contributes one conservative generic load observation", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: {
      recovery: { exercise_min: 51, distance_km: 8.4 },
      quality: {
        exercise_min: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    },
  });

  const load = state.dimensions.training_load_tolerance;
  assert.equal(load.evidence.length, 1);
  assert.equal(load.evidence[0].field, "generic_activity_load");
  assert.equal(load.evidence[0].source, "apple");
  assert.equal(load.evidence[0].date, date);
  assert.equal(load.evidence[0].freshness, "fresh");
  assert.match(load.evidence[0].summary, /without assuming a sport/i);
  assert.equal(state.action.posture, "train", "generic movement alone must not force recovery");
  // …and since the 2026-08-17 rebalance it does not hold aggression on its own either.
  // The watch is what this case pins; the counsel needs a second opinion.
  assert.equal(load.status, "watch");
  assert.equal(state.action.directives.training, "proceed");
});

test("a same-day endurance record suppresses mirrored Apple generic load", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: {
      recovery: { exercise_min: 51, distance_km: 8.4 },
      quality: {
        exercise_min: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    },
    programState: {
      hybrid: {
        status: "clear",
        recent_endurance: { date, label: "run", load: "moderate" },
      },
    },
  });

  assert.equal(
    state.dimensions.training_load_tolerance.evidence.some((item) => item.field === "generic_activity_load"),
    false,
    "the richer same-day activity observation owns the mirrored load"
  );
  assert.equal(state.action.posture, "train");
});

test("only an active dated obligation reduces life capacity", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    contextEvents: [
      {
        id: 1,
        kind: "family_event",
        title: "School event next month",
        start_date: localDaysAgo(-30),
        end_date: localDaysAgo(-30),
      },
    ],
  });
  assert.equal(state.dimensions.life_capacity.status, "unknown");
  assert.equal(state.action.directives.schedule, "normal");
});

test("injury modifies training while illness can protect recovery", () => {
  const date = localDaysAgo(0);
  const injury = repo.planningSignalState({
    date,
    context: {
      reduce_load: true,
      active: [
        {
          kind: "injury",
          reduce_load: true,
          reason: "An active shoulder injury is worth easing or working around.",
        },
      ],
    },
  });
  assert.equal(injury.dimensions.health_constraints.evidence[0].field, "active_injury");
  assert.equal(injury.action.posture, "modify");
  assert.equal(injury.action.directives.training, "modify");

  const illness = repo.planningSignalState({
    date,
    context: {
      reduce_load: true,
      active: [
        {
          kind: "life_event",
          reduce_load: true,
          reason: "An active illness is worth easing while it passes.",
        },
      ],
    },
  });
  assert.equal(illness.dimensions.health_constraints.evidence[0].field, "illness");
  assert.equal(illness.action.posture, "rest");
  assert.equal(illness.action.readiness, "protect");
});

test("recovery protection outranks a simultaneous injury while preserving the work-around", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: {
      recovery: { training_readiness: 20 },
      quality: {
        training_readiness: {
          latest_date: date,
          source: "garmin",
          freshness: "fresh",
          sample_count: 1,
        },
      },
    },
    context: {
      reduce_load: true,
      active: [
        {
          kind: "injury",
          reduce_load: true,
          reason: "An active shoulder injury is worth easing or working around.",
        },
      ],
    },
  });

  assert.equal(state.action.posture, "easy");
  assert.equal(state.action.directives.training, "recover");
  assert.equal(state.dimensions.health_constraints.status, "constrained");
  assert.equal(state.dimensions.health_constraints.evidence[0].field, "active_injury");
});

test("nutrition planning prompts render fueling and schedule directives once", () => {
  const date = localDaysAgo(0);
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  repo.addContextEvent({
    kind: "family_event",
    title: "School pickup and evening event",
    start_date: date,
    end_date: date,
  });
  const ctx = repo.getCoachContext();
  ctx.signal_state = repo.planningSignalState({
    date,
    contextEvents: ctx.context_events,
    programState: {
      hybrid: { status: "fuel-protect", headline: "Protect fuel around the recent long effort." },
    },
  });

  const checkin = buildNutritionCheckinPrompt(ctx);
  assert.equal((checkin.match(/UNIFIED DAILY PLANNING STATE/g) ?? []).length, 1);
  assert.match(checkin, /fueling=protect; schedule=compress/i);

  const meal = buildMealPlanPrompt();
  assert.equal((meal.match(/UNIFIED DAILY PLANNING STATE/g) ?? []).length, 1);
  assert.match(meal, /fueling=(?:normal|settling|protect); schedule=compress/i);

  const swap = buildMealSwapPrompt({
    plan: {
      parsed: {
        daily_kcal: 2200,
        daily_protein_g: 160,
        days: [{ day: "Mon", meals: [{ name: "Grain bowl", items: "rice, beans", kcal: 600, protein_g: 30 }] }],
      },
    },
    day: "Mon",
    mealIndex: 0,
  });
  assert.equal((swap.match(/UNIFIED DAILY PLANNING STATE/g) ?? []).length, 1);
  assert.match(swap, /schedule=compress/i);
});

test("coach context, deterministic Brief, and prompt consume the same planning posture", () => {
  const date = localDaysAgo(0);
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5 });
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, training_readiness)
     VALUES (1, ?, 450, 80)`
  ).run(date);
  repo.addCheckin(date, { energy: 1, sleep_feel: 1, soreness: 2 });

  const ctx = repo.getCoachContext();
  assert.equal(ctx.signal_state.action.posture, "rest");
  assert.equal(ctx.day_read.signals.signal_state.action.posture, "rest");
  assert.equal(ctx.day_read.kind, "rest");
  assert.ok(ctx.signal_state.dimensions.recovery_capacity.conflicts.length > 0);
  const prompt = buildDayReadPrompt(ctx, { date });
  assert.match(prompt, /UNIFIED DAILY PLANNING STATE/);
  assert.match(prompt, /POSTURE: REST/);
});

// ---------- the felt-protect rung is for TODAY-dated felt signals ----------
// It sits at the very top of the posture ladder and is the only rung a single
// observation can use to return a whole rest day. It used to match its field name by
// SUBSTRING (`/fatigue|energy|sleep_feel|illness/`), and the autoregulation
// observation is called `felt_fatigue` and carries a 7-day window — so one below-par
// session rating won the top of the ladder for a week, and did it with the severity
// exactly inverted against the check-in signals filed that same morning.
test("a week-old low-performance rating eases the day rather than owning it", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: {
      autoregulation: { low_performance_flag: true, low_performance_date: localDaysAgo(6) },
    },
  });

  const felt = state.dimensions.training_load_tolerance.evidence.find((item) => item.field === "felt_fatigue");
  assert.ok(felt, "the observation is still made — only its rung changed");
  assert.equal(felt.direction, "constraint");
  assert.equal(
    state.action.posture,
    "easy",
    "'loading should ease' is an easy day, not a rest day claimed six days after the session"
  );
  assert.equal(state.action.readiness, "protect");
});

test("today's felt signals still own the rest rung, and the severity is no longer inverted", () => {
  const date = localDaysAgo(0);
  const runDown = repo.planningSignalState({ date, checkin: { energy: 1 } });
  assert.equal(runDown.action.posture, "rest", "the athlete saying they are run-down today is what this rung is for");

  const unrested = repo.planningSignalState({ date, checkin: { sleep_feel: 1 } });
  assert.equal(unrested.action.posture, "rest");

  const ill = repo.planningSignalState({
    date,
    context: { reduce_load: true, active: [{ kind: "life_event", reduce_load: true, title: "Head cold" }] },
  });
  assert.equal(ill.action.posture, "rest");

  // The comparison the dry-run caught: a sore check-in filed TODAY used to read easy
  // while a six-day-old session rating read rest. Both are now easy, and the acute
  // felt signals above are the only things that reach rest.
  const soreToday = repo.planningSignalState({ date, checkin: { soreness: 5 } });
  assert.equal(soreToday.action.posture, "easy");
});

test("the felt-protect rung matches exact field names, so a lookalike cannot join it", () => {
  const date = localDaysAgo(0);
  const lookalike = repo.buildUnifiedSignalState(date, [
    {
      // Under the old substring rule every one of these matched: "fatigue", "energy",
      // "sleep_feel". None of them is a field this rung was written for.
      dimension: "training_load_tolerance",
      field: "accumulated_fatigue",
      date,
      source: "manual_session",
      direction: "constraint",
      summary: "Accumulated fatigue is high.",
      safety_override: true,
      max_age_days: 0,
    },
  ]);
  assert.equal(lookalike.action.posture, "easy", "a load constraint eases the day; it does not claim the rest rung");

  const dated = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "felt_energy",
      date: localDaysAgo(3),
      source: "user_checkin",
      direction: "constraint",
      summary: "The athlete reported feeling run-down.",
      safety_override: true,
      max_age_days: 7,
    },
  ]);
  assert.equal(
    dated.action.posture,
    "easy",
    "even a listed field may not claim the morning off a three-day-old reading"
  );
});

// ---------- the backed tier's earned bar ----------
// `backed` licenses the Brief to say "everything you've logged lately says you're
// carrying this well" (TRAIN_PUSH_WHY) and licenses the prompt's TODAY IS BACKED block.
// A single check-in with energy rated 4 — one tap, on the "fine" end of a five-point
// scale, on an otherwise empty morning — used to be enough to earn all of it.
test("a lone low-confidence check-in tap does not earn the backed tier", () => {
  const date = localDaysAgo(0);
  const oneTap = repo.planningSignalState({ date, checkin: { energy: 4 } });
  assert.equal(oneTap.action.posture, "train");
  assert.equal(oneTap.action.readiness, "ready");
  assert.equal(oneTap.action.confidence, "low");
  assert.equal(oneTap.action.support, null, "one self-report is not 'everything you've logged lately'");

  // TWO self-reports agreeing is a different claim, and clears the bar.
  const twoReports = repo.planningSignalState({ date, checkin: { energy: 4, sleep_feel: 4 } });
  assert.equal(twoReports.action.support?.level, "backed");
  assert.deepEqual(twoReports.action.support.fields.sort(), ["felt_energy", "sleep_feel"]);
});

test("a rated session still earns the tier on its own, at any confidence", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: { session_quality: { strong_flag: true, strong_date: localDaysAgo(2) } },
  });
  assert.equal(state.action.confidence, "low", "one dimension, one field — the tier is not riding on confidence here");
  assert.equal(state.action.support?.level, "backed");
  assert.deepEqual(state.action.support.fields, ["session_quality"]);
});

// ---------- supportive evidence may not out-vote a fresh brake ----------
// The private arbitration summed STATUS_VALUE x DIMENSION_WEIGHT x CONFIDENCE_WEIGHT,
// and `supportive` is +2 against `watch`'s -1 — so enough good wearable readings
// cancelled genuine cautions outright and a day that should have read modify read
// train. An athlete with a dead watch got the SAFER read than one whose watch worked,
// which inverts the absence-is-neutral law the module is built on.
function brakedBoard(date, { withSupport }) {
  const support = [
    ["sleep", "The most recent recorded night supports the planned day."],
    ["training_readiness", "The wearable readiness signal is supportive."],
    ["hrv", "HRV is steady against the athlete's norm."],
  ].map(([field, summary]) => ({
    dimension: "recovery_capacity",
    field,
    date,
    source: "garmin",
    direction: "support",
    summary,
    max_age_days: 3,
  }));
  const brakes = [
    {
      dimension: "training_load_tolerance",
      field: "hybrid_interference",
      date,
      source: "cairn_hybrid_state",
      direction: "caution",
      summary: "Recent endurance work changes how the next strength session should land.",
      max_age_days: 2,
    },
    {
      dimension: "training_load_tolerance",
      field: "acute_load",
      date,
      source: "cairn_program_state",
      direction: "caution",
      summary: "Acute training load is running above the established base.",
      max_age_days: 1,
    },
    {
      dimension: "life_capacity",
      field: "schedule_pressure",
      date,
      source: "user_context",
      direction: "caution",
      summary: "A current commitment adds schedule pressure today.",
      max_age_days: 1,
    },
  ];
  return repo.buildUnifiedSignalState(date, withSupport ? [...support, ...brakes] : brakes);
}

test("good wearable readings cannot cancel a board of fresh cautions", () => {
  const date = localDaysAgo(0);
  const withoutWatch = brakedBoard(date, { withSupport: false });
  const withWatch = brakedBoard(date, { withSupport: true });

  assert.equal(withoutWatch.action.posture, "modify", "three fresh cautions are a modify day");
  assert.equal(
    withWatch.action.posture,
    "modify",
    "a healthy watch may corroborate and may soften the voice, but it does not vote the brakes down"
  );
  assert.equal(withWatch.dimensions.recovery_capacity.status, "supportive", "the support itself is untouched");
  assert.equal(withWatch.action.support, null, "and the backed tier still refuses to exist beside a brake");
});

test("with no brake on the board the arbitration is unchanged", () => {
  const date = localDaysAgo(0);
  const clear = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "sleep",
      date,
      source: "garmin",
      direction: "support",
      summary: "The most recent recorded night supports the planned day.",
      max_age_days: 3,
    },
    {
      dimension: "recovery_capacity",
      field: "training_readiness",
      date,
      source: "garmin",
      direction: "support",
      summary: "The wearable readiness signal is supportive.",
      max_age_days: 1,
    },
  ]);
  assert.equal(clear.action.posture, "train");
  assert.equal(clear.action.readiness, "ready");
  assert.equal(clear.dimensions.recovery_capacity.status, "supportive");
});

// ---------- HRV and resting HR are read against the athlete's OWN numbers ----------
// day-read already compared the same delta to a baseline-relative band; this layer used
// flat constants, so a 40 ms athlete's real collapse never registered and a 120 ms
// athlete's noise registered constantly.
const wearable = (date, { delta, baseline, current: cur = {} }) => ({
  date,
  recovery: {
    recovery: cur,
    delta,
    baseline,
    quality: {
      hrv_ms: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 },
      resting_hr: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 },
    },
  },
});
const fieldOf = (state, field) => state.dimensions.recovery_capacity.evidence.find((item) => item.field === field);

test("the HRV trend band is a share of the athlete's own norm, with the constant as a floor", () => {
  const date = localDaysAgo(0);
  // 40 ms norm, 4 ms down — a real 10% drop the flat 5 ms constant used to miss.
  const low = repo.planningSignalState(wearable(date, { delta: { hrv: -4 }, baseline: { hrv: 40 } }));
  assert.equal(fieldOf(low, "hrv").direction, "caution");
  assert.equal(fieldOf(low, "hrv").voice.key, "hrv_below");

  // 120 ms norm, 5.5 ms down — inside this athlete's noise, and formerly a caution.
  const high = repo.planningSignalState(wearable(date, { delta: { hrv: -5.5 }, baseline: { hrv: 120 } }));
  assert.equal(fieldOf(high, "hrv").direction, "support");
  assert.equal(fieldOf(high, "hrv").voice.key, "hrv_steady");

  // No baseline at all falls back to the constant, so a caller without one is unchanged.
  const bare = repo.planningSignalState(wearable(date, { delta: { hrv: -9 }, baseline: undefined }));
  assert.equal(fieldOf(bare, "hrv").direction, "caution");
  const belowFloor = repo.planningSignalState(wearable(date, { delta: { hrv: -4 }, baseline: undefined }));
  assert.equal(belowFloor.dimensions.recovery_capacity.evidence.find((i) => i.field === "hrv").direction, "support");
});

test("the resting-HR trend band scales with the norm and never dips under its floor", () => {
  const date = localDaysAgo(0);
  // 80 bpm norm: 3.5 bpm is inside 5%, and used to trip the flat 3 bpm constant.
  const high = repo.planningSignalState(wearable(date, { delta: { rhr: 3.5 }, baseline: { rhr: 80 } }));
  assert.equal(fieldOf(high, "resting_hr").direction, "support");

  // 50 bpm norm: 5% is 2.5, so the 3 bpm floor holds and the test does not get
  // hypersensitive on a low-resting athlete.
  const low = repo.planningSignalState(wearable(date, { delta: { rhr: 2.8 }, baseline: { rhr: 50 } }));
  assert.equal(fieldOf(low, "resting_hr").direction, "support");
  const clear = repo.planningSignalState(wearable(date, { delta: { rhr: 4 }, baseline: { rhr: 50 } }));
  assert.equal(fieldOf(clear, "resting_hr").direction, "caution");
});

// ---------- a raw value is not a finding ----------
// The observation's date and freshness came from the LATEST reading while its DIRECTION
// came only from the median-vs-median trend. Live on 2026-08-03 that produced "Resting
// heart rate is steady against the athlete's norm … latest 2026-08-03, fresh, high
// confidence" on a morning whose resting HR was the highest ever recorded.
//
// The first fix for that read the latest VALUE and flipped on it, which turned out to
// be the same mistake wearing the other sign: on the live data that value was Garmin's
// provisional mid-day estimate, contradicted by its own row. So the excursion path now
// reads only the verified series and only a RUN of it — the cases for that live in
// test/readingTrust.test.js, beside the classification seam they exercise. What these
// two pin is the floor underneath it: a bare latest value, with nothing saying it was
// ever verified, decides nothing at all.
test("a bare latest value cannot flip the observation on its own", () => {
  const date = localDaysAgo(0);
  const spike = repo.planningSignalState(
    wearable(date, { delta: { rhr: 0 }, baseline: { rhr: 54 }, current: { resting_hr: 68 } })
  );
  const rhr = fieldOf(spike, "resting_hr");
  assert.equal(rhr.direction, "support", "an unverified number is not evidence of anything");
  assert.equal(rhr.voice.key, "resting_hr_steady");
  assert.equal(spike.action.posture, "train");

  // …and the ordinary morning it is indistinguishable from, for the same reason.
  const steady = repo.planningSignalState(
    wearable(date, { delta: { rhr: 0 }, baseline: { rhr: 54 }, current: { resting_hr: 56 } })
  );
  assert.equal(fieldOf(steady, "resting_hr").direction, "support");
  assert.equal(fieldOf(steady, "resting_hr").summary, "Resting heart rate is steady against the athlete's norm.");
});

test("the same floor holds for HRV", () => {
  const date = localDaysAgo(0);
  const spike = repo.planningSignalState(
    wearable(date, { delta: { hrv: 0 }, baseline: { hrv: 60 }, current: { hrv_ms: 40 } })
  );
  assert.equal(fieldOf(spike, "hrv").direction, "support");
  assert.equal(fieldOf(spike, "hrv").voice.key, "hrv_steady");

  const steady = repo.planningSignalState(
    wearable(date, { delta: { hrv: 0 }, baseline: { hrv: 60 }, current: { hrv_ms: 58 } })
  );
  assert.equal(fieldOf(steady, "hrv").direction, "support");
  assert.equal(fieldOf(steady, "hrv").summary, "HRV is steady against the athlete's norm.");
});

// An Apple/Oura row has no `min_hr` to argue with, so before the plausibility floor a
// phone posting a wear-artifact "resting" heart rate of 105 was VERIFIED outright — its
// own sleep row vouched for it. Two mornings of that, and the brain braked the day on a
// number no human resting heart rate reaches.
test("an implausible generic resting HR cannot brake the day, however good its night looks", () => {
  const date = localDaysAgo(0);
  for (let i = 0; i < 30; i++) {
    repo.recordDailyMetrics("apple_health", localDaysAgo(i), { sleep_min: 430, resting_hr: i < 2 ? 105 : 52 });
  }
  const recovery = repo.getRecoverySummary(30);
  assert.equal(recovery.verified.resting_hr.latest_value, 105, "the reading is still reported, not deleted");
  assert.ok(
    !recovery.verified.resting_hr.readings.some((reading) => reading.value === 105),
    "an impossible value never enters the verified series"
  );

  const state = repo.planningSignalState({ date, recovery });
  const resting = fieldOf(state, "resting_hr");
  assert.equal(resting.direction, "support", "a wear artifact is absence, and absence is neutral");
  assert.equal(resting.voice.key, "resting_hr_steady");
  assert.notEqual(state.dimensions.recovery_capacity.status, "watch");
  assert.notEqual(state.action.posture, "rest");
});

test("the excursion voices are a real athlete vocabulary, not one literal", () => {
  for (const key of ["hrv_excursion", "resting_hr_excursion"]) {
    const variants = repo.signalVoice({ key });
    assert.ok(variants.length >= 4, `${key} needs enough phrasings to rotate`);
    assert.equal(new Set(variants).size, variants.length, `${key} repeats a phrasing`);
    for (const line of variants) {
      assert.doesNotMatch(line, /\bthe athlete\b/i, `${key} speaks the machine register`);
      // HRV and resting HR ride a 3-day window, so the newest reading may not be from
      // today at all — a sentence claiming the morning would be the same overclaim
      // these observations exist to stop.
      assert.doesNotMatch(line, /\bthis morning\b|\btoday's reading\b/i, `${key} claims a reading it may not have`);
    }
  }
});

// ---------- a constraint is not a conflict ----------
// The conflict line pairs the first support with the first brake ("X. But Y."), and the
// fuel-hold summary was written as a DECISION about agreement — so it read as
// opposition to a support statement it was not actually in tension with, and cost the
// dimension a confidence tier for a disagreement that did not exist.
test("the fuel hold states a constraint, so the conflict join reads as a qualification", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    trainingSignals: { session_quality: { strong_flag: true, strong_date: date } },
    underfueling: {
      state: "settling",
      agreeing_channels: ["weight_trend", "performance"],
      rationale: "The correction is settling.",
      action: { training: "hold_aggression", line: "One bounded fuel step is settling." },
    },
  });

  const hold = state.dimensions.training_load_tolerance.evidence.find((item) => item.field === "fuel_protection");
  assert.equal(
    hold.summary,
    "Fuel availability is still being protected, so progression aggression stays held while the next correction settles."
  );
  assert.doesNotMatch(
    hold.summary,
    /\bagree enough\b/i,
    "the summary observes a constraint rather than reporting a vote"
  );

  const [conflict] = state.dimensions.training_load_tolerance.conflicts;
  assert.ok(conflict, "the pairing itself is unchanged — support plus a brake is still worth surfacing");
  assert.match(conflict, /^Recent rated sessions came back strong.*\. But fuel availability is still being protected/);
});

// ---- the protective voices repeat the least often, so they need the most words ----
//
// Every voice set is held to "at least three phrasings" (test/dayRead.test.js runs the
// whole registry through the constitution). But the protective keys are the ones a
// stable input fires morning after morning — an open injury, a sore joint, a run of
// short nights — so three phrasings meant a three-day cycle for exactly the athlete
// most likely to notice it. These six carry a longer rotation.
test("the highest-frequency protective voices carry at least five phrasings", async () => {
  const { SIGNAL_VOICE_REGISTRY } = await import("../dist/repo/signal-state.js");
  const HIGH_FREQUENCY_PROTECTIVE = [
    "active_injury",
    "joint_pain",
    "sleep_night_short",
    "felt_energy_low",
    "sleep_feel_low",
    "unvoiced_protect",
  ];
  for (const key of HIGH_FREQUENCY_PROTECTIVE) {
    const entry = SIGNAL_VOICE_REGISTRY[key];
    assert.ok(entry, `${key} is a registered voice`);
    assert.ok(entry.variants.length >= 5, `${key} has ${entry.variants.length} phrasings, needs 5`);
    assert.equal(new Set(entry.variants).size, entry.variants.length, `${key} has a duplicate phrasing`);
    // The registry test in dayRead.test.js already holds every variant to the reading
    // grammar; this pins the one thing that is specific to these keys — each phrasing
    // still carries the idea the key exists to convey.
    for (const variant of entry.variants) {
      assert.match(variant, entry.concept, `${key}: "${variant}" drifted off the concept`);
    }
  }
});

// ---- a missing voice must not invent a brake -------------------------------
//
// signalVoice floors to `unvoiced_protect` when a ref names no voice. That is safe in
// the engineering sense and unsafe in the coaching one: on a green morning it hands
// the athlete protective words with no evidence behind them, which is the unfounded
// brake this whole vocabulary exists to prevent. The floor now follows the posture.
test("an unvoiced fallback follows the direction of the day, not the protective floor", async () => {
  const { signalVoice, spokenSignalVoice, POSTURE_FALLBACK_VOICE, SIGNAL_VOICE_REGISTRY } = await import(
    "../dist/repo/signal-state.js"
  );
  const date = localDaysAgo(0);
  const protect = SIGNAL_VOICE_REGISTRY.unvoiced_protect.variants;
  const open = SIGNAL_VOICE_REGISTRY.unvoiced_open.variants;

  // Unchanged for a caller that knows nothing about the day.
  assert.deepEqual([...signalVoice(null)], [...protect]);
  assert.deepEqual([...signalVoice({ key: "no_such_voice" })], [...protect]);

  // A protective posture keeps the protective words...
  for (const posture of ["rest", "easy", "modify"]) {
    assert.equal(POSTURE_FALLBACK_VOICE[posture], "unvoiced_protect");
    assert.ok(protect.includes(spokenSignalVoice(null, date, "k", posture)));
  }
  // ...and a green one gets the honestly-thin line instead of an invented brake.
  for (const posture of ["train", "done"]) {
    assert.equal(POSTURE_FALLBACK_VOICE[posture], "unvoiced_open");
    const spoken = spokenSignalVoice(null, date, "k", posture);
    assert.ok(open.includes(spoken), spoken);
    assert.ok(!protect.includes(spoken), "a green day is never handed a protective floor");
  }
  // A ref that DOES name a voice is untouched by the posture either way.
  const named = { key: "sleep_night_short" };
  assert.equal(spokenSignalVoice(named, date, "k", "train"), spokenSignalVoice(named, date, "k", "rest"));
});

// ---- an active health directive reaches the morning read as a BRAKE ---------
//
// A flagged lab finding propagates into an active training directive, and the run
// builder caps the week off it. This state saw no directives at all, so on the same
// morning the Brief could resolve `push_bias` and offer room the week had denied. The
// firm hold now weighs on the dimension it touches; the uncertain one informs and
// decides nothing, which is the softer weight the directive system already draws.
// (The end-to-end agreement between the two layers is pinned in runProgression.test.js.)
test("a firm endurance hold brakes load tolerance; an uncertain one only informs", async () => {
  const { dayPlanningSignalState } = await import("../dist/repo/day-read.js");
  const { spokenSignalVoice, SIGNAL_VOICE_REGISTRY } = await import("../dist/repo/signal-state.js");
  const date = localDaysAgo(0);
  const holdOf = (state) =>
    state.dimensions.training_load_tolerance.evidence.find((e) => e.field === "endurance_hold_directive");

  assert.equal(holdOf(dayPlanningSignalState(date)), undefined, "no directive, no observation");

  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "low ferritin",
    directive: "Hold endurance volume while ferritin recovers.",
    citation: "IOC consensus on iron in athletes",
    uncertain: true,
    status: "active",
  });
  const soft = dayPlanningSignalState(date);
  const softHold = holdOf(soft);
  assert.ok(softHold, "an uncertain hold is still visible in the state");
  assert.equal(softHold.context_only, true, "…and it decides nothing");
  assert.notEqual(soft.dimensions.training_load_tolerance.status, "watch", "an uncertain nudge is not a finding");

  db.prepare(`UPDATE health_directives SET uncertain = 0`).run();
  const firm = dayPlanningSignalState(date);
  const firmHold = holdOf(firm);
  assert.equal(firmHold.direction, "caution", "a brake, never a constraint — it may hold the reach, not the day");
  assert.ok(!firmHold.context_only);
  assert.equal(firm.dimensions.training_load_tolerance.status, "watch", "visibly a watch for every surface…");
  assert.equal(firm.dimensions.training_load_tolerance.deciding.status, "unknown", "…and invisible to the ladder");
  assert.equal(firmHold.advisory_brake, true);
  // MACHINE register names the directive; the athlete hears the registered voice.
  assert.match(firm.dimensions.training_load_tolerance.reason, /directive/i);
  assert.match(firmHold.summary, /iron stores/);
  const spoken = spokenSignalVoice(firmHold.voice, date, "planned_training:noted");
  assert.ok(
    SIGNAL_VOICE_REGISTRY.endurance_hold_flagged.variants.some((variant) => variant.includes("your iron stores")),
    "the voice names what the hold is waiting on"
  );
  assert.match(spoken, /iron stores/);
  assert.doesNotMatch(spoken, /directive|flag|marker/i, "the athlete never hears the machinery");

  // A directive the athlete resolved contributes nothing.
  db.prepare(`UPDATE health_directives SET status = 'resolved'`).run();
  assert.equal(holdOf(dayPlanningSignalState(date)), undefined);
});

// ---- …and it may not move the day on ANY board ------------------------------
//
// The first cut made the directive an ordinary `caution`, and an ordinary caution
// WEIGHS: STATUS_VALUE × dimension weight × confidence, plus a second, subtler channel
// — arming the arbitration's support clamp, which zeroes every positive contribution.
// The isolated arithmetic was safe (one caution at low confidence sits above the modify
// threshold) but boards are not isolated: on a board already carrying brakes the extra
// weight descended a posture rung, and on a supported board the clamp did it by
// cancelling the support instead. Either way an informational finding about ONE lane
// was deciding what the whole day is, which it may never do.
//
// These build the boards out of the REAL production observation — pulled from
// dayPlanningSignalState rather than hand-copied — and compare each against the same
// board without it. The invariant is equality, not a threshold: same posture, same
// planning directive, whatever else is on the board.
test("an endurance hold cannot descend a posture rung on any board, and cannot hold aggression", async () => {
  const { dayPlanningSignalState } = await import("../dist/repo/day-read.js");
  const { buildUnifiedSignalState } = await import("../dist/repo/signal-state.js");
  const date = localDaysAgo(0);
  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "low ferritin+low hemoglobin",
    directive: "Hold endurance volume while iron and hemoglobin recover.",
    citation: "IOC consensus on iron in athletes",
    uncertain: false,
    status: "active",
  });
  const hold = dayPlanningSignalState(date).dimensions.training_load_tolerance.evidence.find(
    (e) => e.field === "endurance_hold_directive"
  );
  assert.ok(hold, "the production observation is what these boards are built from");

  const obs = (dimension, field, direction, extra = {}) => ({
    dimension,
    field,
    date,
    source: "test",
    direction,
    summary: `${field} reads ${direction}.`,
    max_age_days: 1,
    ...extra,
  });
  // A recovery dimension at watch with three fields and no conflict: high confidence,
  // which is the heaviest an ordinary brake gets.
  const RECOVERY_WATCH = [
    obs("recovery_capacity", "sleep", "caution"),
    obs("recovery_capacity", "hrv", "neutral"),
    obs("recovery_capacity", "rhr", "neutral"),
  ];
  const HEALTH_WATCH = [obs("health_constraints", "joint_pain", "caution")];
  const SUPPORTED = [obs("training_load_tolerance", "session_quality", "support")];

  const compare = (label, board) => {
    const without = buildUnifiedSignalState(date, board);
    const with_ = buildUnifiedSignalState(date, [...board, hold]);
    assert.equal(with_.action.posture, without.action.posture, `${label}: the directive moved the posture`);
    assert.equal(with_.action.readiness, without.action.readiness, `${label}: the directive moved readiness`);
    assert.equal(
      with_.action.directives.training,
      without.action.directives.training,
      `${label}: the directive moved the training directive`
    );
    // The VOICE too, which is the half the athlete actually reads: `action.evidence[0]`
    // becomes `action.voice`, which day-read's protect rule speaks as the Brief's `why`.
    // A finding that cannot decide the day may not be named as its cause either.
    assert.deepEqual(with_.action.voice, without.action.voice, `${label}: the directive took over the why`);
    return with_;
  };

  // One brake on the board (the day already reads modify), two brakes (easy) — the two
  // boards the reviewer's counter-example was built on. Neither may descend a rung.
  const oneBrake = compare("one brake", RECOVERY_WATCH);
  assert.equal(oneBrake.action.posture, "modify", "the fixture is the board it claims to be");
  const twoBrakes = compare("two brakes", [...RECOVERY_WATCH, ...HEALTH_WATCH]);
  assert.equal(twoBrakes.action.posture, "easy");
  assert.notEqual(twoBrakes.action.posture, "rest", "and never rest");
  // Named explicitly, because dimension order puts training_load_tolerance ahead of the
  // dimensions that DID make this day easy: the reported cause must be one of them.
  // `action.reasons` are the summaries of the evidence this posture is reported to rest
  // on, in the same order `action.voice` is taken from.
  assert.ok(twoBrakes.action.reasons.length, "the easy day still reports what it rests on");
  assert.equal(
    twoBrakes.action.reasons.some((reason) => /directive|iron/i.test(reason)),
    false,
    "the hold was listed among the brakes this posture rests on"
  );
  assert.equal(
    twoBrakes.action.source_dimensions.includes("training_load_tolerance"),
    false,
    "…and it was credited as a dimension that drove the day"
  );

  // An otherwise-EMPTY board: no wearable, no check-in, one standing flag. A brake may
  // never make a board read GREENER than the same board without it — this used to flip
  // readiness from "unknown" to "ready" and swap the honestly-thin sentence for "the
  // current signals leave room for the planned day".
  const bare = compare("empty board", []);
  assert.equal(bare.action.readiness, "unknown");
  assert.match(bare.action.reason, /not enough fresh signal/i);
  assert.equal(bare.action.support, null);

  // The second channel: a board with nothing pulling the other way, where the damage
  // came from the support clamp rather than from the weight.
  const supported = compare("supported", SUPPORTED);
  assert.equal(supported.action.posture, "train");
  // …and here is the authority it DOES have: the reach is withdrawn on that same board.
  assert.ok(buildUnifiedSignalState(date, SUPPORTED).action.support, "the control day is backed");
  assert.equal(supported.action.support, null, "the hold withdraws the reach — that is its whole authority");

  // A single ordinary caution plus the hold must not become the "second opinion" that
  // holds aggression for the week: an iron flag may not cap a squat session.
  const lift = buildUnifiedSignalState(date, [...RECOVERY_WATCH, hold]);
  assert.equal(lift.action.directives.training, "proceed", "one caution and a flag is still one caution");
  assert.equal(
    lift.dimensions.training_load_tolerance.status,
    "watch",
    "the flag is still visible to every surface that shows the dimension"
  );
});

// ---- the exemption is only ever granted to a CAUTION -------------------------
//
// `advisory_brake` buys an exemption from the weighted sum, and the three rungs at the
// top of actionState are direction-only — no exemption can reach them. So a future
// caller flagging a CONSTRAINT as advisory would get the exemption inverted: excluded
// from the arbitration while still owning the whole day. The flag is honored through
// one predicate that requires a caution; anything stronger keeps its full weight.
test("advisory_brake cannot soften a constraint — the stricter reading wins", async () => {
  const { buildUnifiedSignalState } = await import("../dist/repo/signal-state.js");
  const date = localDaysAgo(0);
  const constraint = {
    dimension: "training_load_tolerance",
    field: "misflagged",
    date,
    source: "test",
    direction: "constraint",
    summary: "Something firm, mislabelled as advisory.",
    max_age_days: 1,
    advisory_brake: true,
  };
  const state = buildUnifiedSignalState(date, [constraint]);
  // It decides exactly what an unflagged constraint decides — the flag bought nothing.
  const honest = buildUnifiedSignalState(date, [{ ...constraint, advisory_brake: false }]);
  assert.equal(state.action.posture, honest.action.posture);
  assert.equal(state.action.posture, "easy", "a load constraint still owns the day");
  assert.equal(state.dimensions.training_load_tolerance.deciding.status, "constrained");
  assert.equal(state.dimensions.training_load_tolerance.status, "constrained");
});

// ---- and the ladder's plumbing does not reach the model ---------------------
test("the prompt payload carries one status per dimension, not two", async () => {
  const { projectCoachContext } = await import("../dist/prompt/context-projection.js");
  const { buildUnifiedSignalState } = await import("../dist/repo/signal-state.js");
  const date = localDaysAgo(0);
  const state = buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "sleep",
      date,
      source: "test",
      direction: "caution",
      summary: "A short night.",
      max_age_days: 1,
    },
  ]);
  assert.ok(state.dimensions.recovery_capacity.deciding, "the state itself carries it");
  const projected = projectCoachContext({ signal_state: state }, "day_read");
  for (const [key, dimension] of Object.entries(projected.signal_state.dimensions)) {
    assert.equal(dimension.deciding, undefined, `${key}: the posture ladder's plumbing reached the prompt`);
    assert.ok(dimension.status, `${key}: the status a prompt has always read is still there`);
  }
  assert.equal(projected.signal_state.action.posture, state.action.posture, "nothing else is disturbed");
});

// ---------------------------------------------------------------------------
// Round W3.4 — the recovery science
// ---------------------------------------------------------------------------

// ---- (1) the decision band is the athlete's own smallest worthwhile change ----
test("the trend band widens to the athlete's own dispersion and never narrows below the floors", async () => {
  const { recoveryTrendBars } = await import("../dist/repo/recovery-trend.js");
  const baseline = { hrv: 60, rhr: 50, sleep: 420 };

  const flat = recoveryTrendBars(baseline);
  assert.equal(flat.hrv, 3, "with no dispersion the bar is exactly what it always was");

  // A NOISY athlete: half of a 14 ms spread is 7 ms, well past the 5%-of-baseline bar.
  const noisy = recoveryTrendBars(baseline, { hrv: 14 });
  assert.equal(noisy.hrv, 7, "the smallest worthwhile change is half their own SD");

  // A CONSISTENT one: half of a 2 ms spread is 1 ms, and the floor holds. The band may
  // only ever widen — narrowing it would mint cautions for the athlete Cairn knows best.
  const consistent = recoveryTrendBars(baseline, { hrv: 2 });
  assert.equal(consistent.hrv, flat.hrv, "dispersion can widen the band, never tighten it");

  // Nonsense dispersion is absence, not a band of zero.
  for (const bad of [null, 0, -5, "many", Number.NaN]) {
    assert.equal(recoveryTrendBars(baseline, { hrv: bad }).hrv, flat.hrv, `dispersion ${String(bad)}`);
  }
});

test("a drop inside the athlete's own noise is not a finding; one outside it still is", () => {
  const date = localDaysAgo(0);
  const recovery = (delta, dispersion) => ({
    baseline: { hrv: 60 },
    dispersion,
    delta: { hrv: delta },
    quality: { hrv_ms: { latest_date: date, source: "garmin", sample_count: 7, window_days: 14 } },
  });
  const hrvOf = (state) =>
    (state.dimensions.recovery_capacity.evidence ?? []).find((item) => item.field === "hrv");

  // −5 ms against a 3 ms bar was a caution, and for a steady athlete it still is.
  assert.equal(hrvOf(repo.planningSignalState({ date, recovery: recovery(-5, null) })).direction, "caution");
  // The SAME −5 ms for an athlete whose own nights swing 14 ms is ordinary variation.
  assert.equal(
    hrvOf(repo.planningSignalState({ date, recovery: recovery(-5, { hrv: 14 }) })).direction,
    "support",
    "half their own SD is 7 ms, and 5 does not clear it"
  );
  // Past their own band it speaks again — a wider band is not a silenced one.
  assert.equal(hrvOf(repo.planningSignalState({ date, recovery: recovery(-9, { hrv: 14 }) })).direction, "caution");
});

// ---- (2) parasympathetic saturation ----
const hrvRecovery = (date, delta) => ({
  baseline: { hrv: 60 },
  delta: { hrv: delta },
  quality: { hrv_ms: { latest_date: date, source: "garmin", sample_count: 7, window_days: 14 } },
});
// The run-intensity channel's chronic finding, in the shape runIntensityDiscipline
// returns it — "the same easy work is costing more pulse", the only pace-at-heart-rate
// reading this system actually takes.
const driftingRuns = {
  status: "polarized",
  z2_top: 148,
  window_days: 14,
  runs_classified: 4,
  chronic: { window_days: 21, runs_classified: 10, easy_count: 2, above_easy_count: 8, drifting: true },
  chronic_summary: "Most of the athlete's recent running finished above their own easy ceiling of 148 bpm.",
};
const decliningSignals = {
  autoregulation: { low_performance_flag: true, low_performance_date: null, joint_areas: [], soreness_flag: false },
};

test("rising HRV beside a declining performance channel reads watch, not green", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: hrvRecovery(date, 9),
    trainingSignals: decliningSignals,
  });
  const hrv = (state.dimensions.recovery_capacity.evidence ?? []).find((item) => item.field === "hrv");
  assert.ok(hrv, "the HRV observation is still made");
  assert.notEqual(hrv.direction, "support", "a rising number may not endorse a day the work is arguing with");
  assert.equal(hrv.direction, "caution");
  assert.equal(hrv.voice.key, "hrv_saturation");
  assert.match(hrv.summary, /costing more/i, "the machine reason names the divergence");
  assert.match(hrv.summary, /below the athlete's usual/i, "…and cites the channel it read");
  assert.equal(state.dimensions.recovery_capacity.status, "watch");
});

test("saturation is advisory: it withdraws the reach and cannot take the day", () => {
  const date = localDaysAgo(0);
  // The performance evidence here is the run-intensity channel rather than a rated
  // session, because a low-performance RATING is itself a safety constraint and would
  // own the day on its own — which would prove nothing about this brake's standing.
  const state = repo.planningSignalState({
    date,
    recovery: hrvRecovery(date, 9),
    runIntensity: driftingRuns,
  });
  const hrv = (state.dimensions.recovery_capacity.evidence ?? []).find((item) => item.field === "hrv");
  assert.equal(hrv.voice.key, "hrv_saturation");
  assert.equal(hrv.advisory_brake, true);
  assert.equal(state.dimensions.recovery_capacity.status, "watch", "it IS visible");
  assert.notEqual(state.dimensions.recovery_capacity.deciding.status, "watch", "the posture ladder reads past it");
  assert.equal(state.action.posture, "train", "an argument about what a number MEANS is not a rest verdict");
  assert.equal(state.action.support, null, "but the backed tier is withdrawn");
});

test("saturation needs BOTH halves — either alone changes nothing", () => {
  const date = localDaysAgo(0);
  const hrvOf = (input) =>
    (repo.planningSignalState(input).dimensions.recovery_capacity.evidence ?? []).find(
      (item) => item.field === "hrv"
    );

  // Rising HRV alone is exactly what it looks like.
  const risingOnly = hrvOf({ date, recovery: hrvRecovery(date, 9) });
  assert.equal(risingOnly.direction, "support");
  assert.equal(risingOnly.voice.key, "hrv_steady");

  // A declining performance channel beside a STEADY trend is not saturation either —
  // the finding is a divergence, and there is nothing here to diverge from.
  const steady = hrvOf({ date, recovery: hrvRecovery(date, 1), trainingSignals: decliningSignals });
  assert.equal(steady.voice.key, "hrv_steady");

  // And a FRESH strong rating settles it the other way outright: the most recent thing
  // the athlete said about their own training outranks the inference.
  const strong = hrvOf({
    date,
    recovery: hrvRecovery(date, 9),
    trainingSignals: { ...decliningSignals, session_quality: { strong_flag: true, strong_date: date } },
  });
  assert.equal(strong.voice.key, "hrv_steady");
});

test("a FALLING trend keeps its own words — saturation never layers a second claim", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: hrvRecovery(date, -9),
    trainingSignals: decliningSignals,
  });
  const hrv = (state.dimensions.recovery_capacity.evidence ?? []).find((item) => item.field === "hrv");
  assert.equal(hrv.voice.key, "hrv_below");
  assert.equal(hrv.advisory_brake, undefined, "the ordinary trend caution keeps its full standing");
});

test("absent HRV fires nothing at all, whatever the performance channel says", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({
    date,
    recovery: { ...hrvRecovery(date, 0), delta: {} },
    trainingSignals: decliningSignals,
  });
  assert.equal(
    (state.dimensions.recovery_capacity.evidence ?? []).find((item) => item.field === "hrv"),
    undefined
  );
});
