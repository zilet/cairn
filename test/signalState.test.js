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
      field: "felt_fatigue",
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
  assert.equal(summaryOf("recovery_capacity", "sleep"), "Recent sleep is running short.");
  assert.equal(summaryOf("recovery_capacity", "training_readiness"), "The fresh wearable readiness signal is subdued.");
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

test("the one already-athlete-voiced summary and its day-read rule stay a single sentence", () => {
  const date = localDaysAgo(0);
  const state = repo.planningSignalState({ date, checkin: { energy: 1 } });
  const felt = state.dimensions.recovery_capacity.evidence.find((item) => item.field === "felt_energy");

  // A low-energy check-in reaches the athlete through two paths: this protect posture
  // and day-read's felt_run_down_rest rule. This one summary was written in the
  // athlete's voice — unlike its ~30 siblings — precisely BECAUSE it doubled as the
  // Brief's line, and it duplicated the rule's first phrasing verbatim. It now leads
  // the shared voice set, so the two paths cannot drift into different registers.
  assert.equal(state.action.voice.key, "felt_energy_low");
  assert.equal(felt.summary, repo.signalVoice(state.action.voice)[0]);
});

test("a voice-less observation degrades to an athlete-facing floor, never to the summary", () => {
  const date = localDaysAgo(0);
  const state = repo.buildUnifiedSignalState(date, [
    {
      dimension: "recovery_capacity",
      field: "felt_fatigue",
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
  assert.equal(state.action.directives.training, "hold_aggression");
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
