// The run day is decided ON ITS MORNING (owner ruling: everything known that morning
// decides what the next session is and how hard to push — not a predefined schedule; a
// stated quality day can still be the hard session when the athlete is up for it).
//
//   • a trimmed week (reset, spike brake, recovery dip) trims VOLUME, not intensity: the
//     stated quality day keeps a SHORT stimulus, and that morning decides whether it runs;
//   • green morning keeps it, a floor or a poor morning makes the day easy, a neutral
//     morning on a trimmed week stays easy — and the athlete's own word ("feel good,
//     hills today") opens it when no floor fires; no word outranks a floor;
//   • a long run under brakes shortens and stays easy;
//   • fitness trending up (VO2max) is a support;
//   • weeklyRunPlan, the agenda and the Brief say the same thing for the same morning.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { weeklyRunPlan } from "../dist/repo/run-progression.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import {
  classifyRunWord,
  LONG_BRAKE_FACTOR,
  LONG_FLOOR_FACTOR,
  RUN_DAY_VARIANT_SETS,
  runDayIntensity,
  runMorningEvidence,
} from "../dist/repo/run-day-intensity.js";

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "checkins",
    "suggestions",
    "context_events",
    "training_symptom_events",
    "symptom_reports",
    "sessions",
    "logged_sets",
    "day_reads",
    "brain_decisions",
    "brain_expectations",
    "daily_session_decisions",
    "daily_session_compositions",
    "plan_items",
    "plan_days",
    "program_blocks",
    "health_directives",
    "app_state",
    "profile"
  );
});

// ---- a pinned clock ----
// Every fixture here is relative to "today", and the seeded runner has six steady weeks
// behind it. The deload-due law counts loaded ROLLING seven-day windows, so whether six
// of them line up depends on the weekday: on a Thursday through Monday the six-week
// streak completes and the morning reads an accumulated-load rest instead of the stated
// run day, and the real calendar decided which. The clock is pinned to a Wednesday noon
// (local time, so every timezone agrees on the date); it still advances in real time.
const RealDate = Date;
const CLOCK_OFFSET = new RealDate(2026, 8, 23, 12, 0, 0).getTime() - RealDate.now();
globalThis.Date = class PinnedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + CLOCK_OFFSET);
  }
  static now() {
    return RealDate.now() + CLOCK_OFFSET;
  }
};

const TODAY = localDateISO();
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const T = dowOf(TODAY);
const dayNumberOf = (iso) => (dowOf(iso) === 0 ? 7 : dowOf(iso));

// A steady runner: three runs a week (Tue 6, Thu 8, Sun 12 km) for six closed weeks,
// all before this week's Monday so nothing in this week closes today's intention.
const MONDAY = addDays(TODAY, -((T + 6) % 7));
function seedRunner() {
  for (let w = 1; w <= 6; w++) {
    const monday = addDays(MONDAY, -7 * w);
    for (const [offset, km] of [
      [1, 6],
      [3, 8],
      [6, 12],
    ])
      repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date: addDays(monday, offset) });
  }
}

// The athlete's own nights before today: HRV 48–56, resting HR 50–54 (a band of their own).
function seedOwnNights(n = 20) {
  for (let back = 1; back <= n; back++) {
    repo.upsertGarminDailyMetric({
      date: addDays(TODAY, -back),
      hrv_ms: [48, 50, 52, 54, 56][back % 5],
      resting_hr: [50, 51, 52, 53, 54][back % 5],
      sleep_min: 460,
    });
  }
}

const GOOD_NIGHT = { hrv_ms: 54, resting_hr: 50, sleep_min: 470, training_readiness: 72 };
function tonight(fields) {
  repo.upsertGarminDailyMetric({ date: TODAY, ...fields });
}

// Stated run days with the QUALITY day today.
function qualityTodayAthlete() {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: {
      days: [
        { dow: (T + 5) % 7, kind: "easy" },
        { dow: T, kind: "quality" },
        { dow: (T + 3) % 7, kind: "long" },
      ],
      source: "athlete",
    },
  });
  seedRunner();
  seedOwnNights();
}

// The spike brake (a trimmed week), injected the way the run engine's own tests do, with
// a flat recovery so only the spike shapes the week.
const SPIKE = {
  programState: { endurance: { sport: "run", longest_km_4wk: 12, has_quality: true, status: "spiking" } },
  recovery: { delta: {}, baseline: {}, recovery: {}, quality: {} },
  adjustToday: true,
};
const todayRun = (plan) => plan.runs.find((r) => r.day_number === dayNumberOf(TODAY));

test("a trimmed week keeps a SHORT quality session on the stated day, and a green morning keeps it", () => {
  qualityTodayAthlete();
  tonight(GOOD_NIGHT);
  // Read as the WEEK (no morning yet): the quality day carries a short stimulus, not easy.
  const week = weeklyRunPlan(TODAY, { ...SPIKE, adjustToday: false });
  const planned = todayRun(week);
  assert.equal(planned?.kind_label, "quality", "the spike trims volume, not the quality day");
  assert.equal(planned?.dose, "short");
  assert.match(planned.label, /^Short /);
  assert.match(week.mix_summary, /\+ 1 short /);

  const plan = weeklyRunPlan(TODAY, SPIKE);
  const run = todayRun(plan);
  assert.equal(run.kind_label, "quality");
  assert.equal(plan.today_adjustment?.reason_code, "green_keeps_short");
  assert.equal(plan.today_adjustment.dose, "short");
  assert.equal(plan.today_adjustment.changed, false);
  assert.ok(plan.today_adjustment.supports.includes("hrv_at_usual"));
  assert.ok(plan.today_adjustment.supports.includes("readiness_supportive"));
  assert.equal(violatesReadingGrammar(plan.today_adjustment.why), null);
  assert.doesNotMatch(plan.today_adjustment.why, /\d/, "no numbers in the athlete's sentence");
});

test("the same trimmed week on a low-HRV morning (below their OWN band) goes easy", () => {
  qualityTodayAthlete();
  tonight({ ...GOOD_NIGHT, hrv_ms: 38 });
  const plan = weeklyRunPlan(TODAY, SPIKE);
  const run = todayRun(plan);
  assert.equal(run.kind_label, "easy");
  assert.equal(run.planned_kind_label, "quality");
  assert.equal(run.interval, null);
  assert.equal(plan.today_adjustment.reason_code, "floor:hrv_below_own_band");
  assert.match(plan.today_adjustment.why, /HRV/);
  assert.equal(violatesReadingGrammar(plan.today_adjustment.why), null);
});

test("the same trimmed week after a short night goes easy", () => {
  qualityTodayAthlete();
  tonight({ ...GOOD_NIGHT, sleep_min: 300 });
  const plan = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(plan).kind_label, "easy");
  assert.equal(plan.today_adjustment.reason_code, "floor:short_night");
});

test("a neutral morning on a trimmed week stays easy — the athlete saying 'feel good, hills' opens it", () => {
  qualityTodayAthlete();
  // No night synced, no check-in: nothing either way — the week's default stands,
  // decided when the morning comes in (never called a "quiet" morning).
  const quiet = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(quiet).kind_label, "easy");
  assert.equal(quiet.today_adjustment.reason_code, "awaiting_morning");

  repo.addCheckin(TODAY, { energy: 3, note: "feel good, hills today" });
  const asked = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(asked).kind_label, "quality");
  assert.equal(asked.today_adjustment.reason_code, "athlete_word_quality");
  assert.equal(asked.today_adjustment.athlete_word, "up");
  assert.equal(asked.today_adjustment.dose, "short", "the word opens the week's short set, not a full one");
});

test("no word outranks a safety floor", () => {
  qualityTodayAthlete();
  tonight({ ...GOOD_NIGHT, hrv_ms: 36 });
  repo.addCheckin(TODAY, { energy: 3, note: "feel good, hills today" });
  const plan = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(plan).kind_label, "easy");
  assert.equal(plan.today_adjustment.athlete_word, "up");
  assert.equal(plan.today_adjustment.reason_code, "floor:hrv_below_own_band");

  // A run-down check-in is the athlete's own floor, and "hills" in a note beside it
  // does not reopen the session either.
  resetTables("garmin_daily_metrics", "checkins");
  seedOwnNights();
  tonight(GOOD_NIGHT);
  repo.addCheckin(TODAY, { energy: 2, note: "hills today" });
  const rundown = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(rundown).kind_label, "easy");
  assert.equal(rundown.today_adjustment.reason_code, "floor:felt_run_down");
});

test("a normal week keeps its full session on a neutral morning and drops it on a floor", () => {
  qualityTodayAthlete();
  const normal = {
    programState: { endurance: { sport: "run", longest_km_4wk: 12, has_quality: true, status: "maintaining" } },
    recovery: SPIKE.recovery,
    block: { week_index: 1 },
    adjustToday: true,
  };
  const quiet = weeklyRunPlan(TODAY, normal);
  const run = todayRun(quiet);
  assert.equal(run.kind_label, "quality");
  assert.equal(run.dose, undefined, "an ordinary week's session is full");
  assert.equal(quiet.today_adjustment.reason_code, "planned");

  tonight({ ...GOOD_NIGHT, sleep_min: 290 });
  const short = weeklyRunPlan(TODAY, normal);
  assert.equal(todayRun(short).kind_label, "easy");
  assert.equal(short.today_adjustment.reason_code, "floor:short_night");
});

test("a long run under brakes shortens and stays easy; the athlete's 'easier' shortens it too", () => {
  qualityTodayAthlete();
  const long = { kind_label: "long", label: "Long run", target_distance_km: 16 };
  tonight({ ...GOOD_NIGHT, sleep_min: 300 });
  const floor = runDayIntensity(TODAY, long);
  assert.equal(floor.kind, "long");
  assert.equal(floor.dose, "shortened");
  assert.equal(floor.target_distance_km, Math.round(16 * LONG_FLOOR_FACTOR * 10) / 10);
  assert.equal(floor.reason_code, "floor:short_night");

  const soft = runDayIntensity(TODAY, long, {
    evidence: {
      floors: [],
      soft_brakes: ["readiness_subdued", "legs_carrying_lift"],
      supports: [],
      athlete_word: null,
    },
  });
  assert.equal(soft.dose, "shortened");
  assert.equal(soft.target_distance_km, Math.round(16 * LONG_BRAKE_FACTOR * 10) / 10);
  assert.equal(soft.reason_code, "brakes_shorten");

  const word = runDayIntensity(TODAY, long, {
    evidence: { floors: [], soft_brakes: [], supports: ["legs_clear"], athlete_word: "down" },
  });
  assert.equal(word.dose, "shortened");
  assert.equal(word.reason_code, "athlete_word_easy");

  const green = runDayIntensity(TODAY, long, {
    evidence: { floors: [], soft_brakes: [], supports: ["hrv_at_usual", "slept_enough"], athlete_word: null },
  });
  assert.equal(green.dose, "full");
  assert.equal(green.target_distance_km, 16);
  for (const adj of [floor, soft, word, green]) assert.equal(violatesReadingGrammar(adj.why), null, adj.why);
});

test("VO2max trending up counts as a support; a flat trend does not", () => {
  qualityTodayAthlete();
  repo.upsertGarminDailyMetric({ date: addDays(TODAY, -40), vo2max: 44.0 });
  repo.upsertGarminDailyMetric({ date: addDays(TODAY, -1), vo2max: 44.2 });
  assert.ok(!runMorningEvidence(TODAY).supports.includes("fitness_improving"), "a flat trend is not a support");

  resetTables("garmin_daily_metrics");
  repo.upsertGarminDailyMetric({ date: addDays(TODAY, -40), vo2max: 44.0 });
  repo.upsertGarminDailyMetric({ date: addDays(TODAY, -1), vo2max: 46.5 });
  assert.ok(runMorningEvidence(TODAY).supports.includes("fitness_improving"));
});

test("history alone never makes a green morning: at least one support has to be this morning's", () => {
  const planned = { kind_label: "quality", dose: "short", label: "Short hills", target_distance_km: 4 };
  const historyOnly = runDayIntensity(TODAY, planned, {
    evidence: {
      floors: [],
      soft_brakes: [],
      supports: ["fitness_improving", "harm_free_recent", "trains_anyway_clean", "legs_clear"],
      athlete_word: null,
    },
  });
  assert.equal(historyOnly.kind, "easy");
  const withMorning = runDayIntensity(TODAY, planned, {
    evidence: { floors: [], soft_brakes: [], supports: ["felt_good", "fitness_improving"], athlete_word: null },
  });
  assert.equal(withMorning.kind, "quality");
  assert.equal(withMorning.reason_code, "green_keeps_short");
});

test("the week's harder work already in keeps the quality day easy — unless the athlete asks", () => {
  const planned = { kind_label: "quality", label: "Hill repeats", target_distance_km: 6 };
  const done = runDayIntensity(TODAY, planned, {
    weekQualityDone: true,
    evidence: { floors: [], soft_brakes: [], supports: ["felt_good", "hrv_at_usual"], athlete_word: null },
  });
  assert.equal(done.kind, "easy");
  assert.equal(done.reason_code, "week_quality_done");
  const asked = runDayIntensity(TODAY, planned, {
    weekQualityDone: true,
    evidence: { floors: [], soft_brakes: [], supports: [], athlete_word: "up" },
  });
  assert.equal(asked.kind, "quality");
  const locked = runDayIntensity(TODAY, planned, {
    locks: ["taper"],
    evidence: { floors: ["short_night"], soft_brakes: [], supports: [], athlete_word: null },
  });
  assert.equal(locked.kind, "quality", "the taper is the week's structure; the morning does not re-decide it");
  assert.equal(locked.reason_code, "locked:taper");
});

test("the athlete's word reads the way they said it", () => {
  assert.equal(classifyRunWord("feel good, hills today"), "up");
  assert.equal(classifyRunWord("I want to train anyway"), "up");
  assert.equal(classifyRunWord("give me an easy day"), "down");
  assert.equal(classifyRunWord("rough night"), "down");
  assert.equal(classifyRunWord("feel good but the calf is sore"), "down", "a down-word inside a mixed sentence wins");
  assert.equal(classifyRunWord("short on time"), "down");
  assert.equal(classifyRunWord("lunch with friends"), null);
  assert.equal(classifyRunWord(""), null);
});

test("every morning sentence is a variant set of three or more, grammar-clean and number-free", () => {
  for (const [name, set] of Object.entries(RUN_DAY_VARIANT_SETS)) {
    assert.ok(set.length >= 3, `${name} has ${set.length} phrasings`);
    for (const say of set) {
      const sentence = say("readiness is good and sleep was solid", "Thursday", "hills");
      assert.equal(violatesReadingGrammar(sentence), null, `${name}: ${sentence}`);
      assert.doesNotMatch(sentence, /\d/, `${name}: ${sentence}`);
      assert.doesNotMatch(sentence, /\byou must\b|\bdo not train\b/i);
    }
  }
});

// ---------- one morning, one answer, on every surface ----------
// Today is a stated LONG run day that carries no lifting, so the Brief speaks it through
// the stated-run-day rule; the plan, the agenda intent and the Brief must agree.
function longTodayAthlete() {
  const lift = (exercise) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 });
  repo.savePlanDay(1, "Push", "Chest & shoulders", [lift("Barbell Bench Press")]);
  repo.savePlanDay(2, "Pull", "Back", [lift("Barbell Row")]);
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    strength_schedule: { days: [{ dow: (T + 1) % 7 }, { dow: (T + 5) % 7 }], source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: (T + 2) % 7, kind: "easy" },
        { dow: (T + 4) % 7, kind: "quality" },
        { dow: T, kind: "long" },
      ],
      source: "athlete",
    },
  });
  seedRunner();
  seedOwnNights();
}

test("weeklyRunPlan, the agenda and the Brief say the same thing for the same morning", () => {
  longTodayAthlete();
  tonight(GOOD_NIGHT);
  repo.addCheckin(TODAY, { note: "tired today, go easy" });

  const plan = weeklyRunPlan(TODAY);
  const adj = plan.today_adjustment;
  assert.ok(adj, "the plan decided today's long run");
  assert.equal(adj.planned_kind, "long");
  assert.equal(adj.dose, "shortened");
  assert.equal(adj.reason_code, "athlete_word_easy");
  const run = todayRun(plan);
  assert.equal(run.target_distance_km, adj.target_distance_km);

  const agenda = flexibleTrainingAgenda(TODAY);
  const intent = agenda.intents.find((i) => i.suggested_date === TODAY && i.status === "open");
  assert.ok(intent, "the agenda opens today's run");
  assert.equal(intent.kind, "long");
  assert.equal(intent.target_distance_km, adj.target_distance_km);
  assert.equal(intent.adjustment?.reason_code, adj.reason_code);
  assert.equal(agenda.today_adjustment?.why, adj.why);
  assert.match(intent.id, /:long:1$/, "the slot keeps the identity the week gave it");

  const read = repo.dayRead(TODAY);
  assert.equal(read.decision.rule_code, "stated_run_day");
  assert.equal(read.focus, intent.label);
  assert.equal(read.why, adj.why);
  assert.equal(read.signals.stated_run_day.reason_code, adj.reason_code);
  assert.equal(violatesReadingGrammar(read.why), null);
});

test("a past quality day that was run easy closes its slot instead of re-asking it later in the week", () => {
  // A fixed past week, so no morning is re-decided: Thursday's quality was run easy.
  const MON = "2031-07-14";
  const THU = "2031-07-17";
  const FRI = "2031-07-18";
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
  for (const [date, km] of [
    ["2031-06-17", 6],
    ["2031-06-19", 8],
    ["2031-06-22", 12],
    ["2031-06-24", 6],
    ["2031-06-26", 8],
    ["2031-06-29", 12],
    ["2031-07-01", 6],
    ["2031-07-03", 8],
    ["2031-07-06", 13],
    ["2031-07-08", 6],
    ["2031-07-10", 8],
    ["2031-07-13", 13],
    ["2031-07-15", 6],
  ])
    repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date });
  repo.addActivity({ type: "run", distance_km: 5, duration_min: 30, date: THU });
  const before = flexibleTrainingAgenda(MON);
  assert.ok(
    before.intents.some((i) => i.kind === "quality"),
    "the week holds a quality session"
  );
  const agenda = flexibleTrainingAgenda(FRI);
  const quality = agenda.intents.find((i) => i.id.includes(":quality:"));
  assert.equal(quality?.status, "completed", "Thursday's run answers Thursday's slot");
  assert.equal(quality.completion.date, THU);
  assert.equal(quality.completion.intensity, "easy");
  assert.ok(
    !agenda.intents.some((i) => i.status === "open" && i.kind === "quality"),
    "no quality session is re-asked for the weekend"
  );
  void db;
});

// ============================================================================
// Review round (r5) — every finding pinned. Namespace imports so a symbol this round
// adds fails one test, never the file.
// ============================================================================
import * as rdi from "../dist/repo/run-day-intensity.js";
import * as rp from "../dist/repo/run-progression.js";
import * as useCase from "../dist/domain/brain/day-read-use-case.js";
import * as ramp from "../dist/repo/long-run-ramp.js";
import { configureDayReadRefresh, resetDayReadRefresh } from "../dist/dayread-refresh.js";

// ---------- 1. the athlete's word: safety-first reading ----------
test("classifyRunWord: pain, illness, negation and any mixed note read DOWN; only a clear ask reads UP", () => {
  const down = [
    "not feeling great",
    "do not push it today",
    "don't push it",
    "sleep quality was poor",
    "feel good but my knee hurts",
    "knee pain but feeling strong",
    "feel fine, a bit of a cold",
    "hate hills",
    "under the weather",
    "no hills today",
    "legs don't feel fresh",
    "feel great but a little sick",
    "slight niggle in the calf, otherwise ready to go",
    "tweaked my ankle",
    "exhausted",
    "feeling run down",
    "rough night",
    "give me an easy day",
    "short on time",
  ];
  const up = [
    "feel great, hills today",
    "legs feel fresh, let's do the intervals",
    "feel good, hills today",
    "I want to train anyway",
    "feeling strong",
    "up for it",
  ];
  const neutral = ["feel fine", "quality", "tempo", "push", "lunch with friends", "hills", ""];
  for (const note of down) assert.equal(classifyRunWord(note), "down", note);
  for (const note of up) assert.equal(classifyRunWord(note), "up", note);
  for (const note of neutral) assert.equal(classifyRunWord(note), null, JSON.stringify(note));
});

// ---------- 2. rest-grade readiness / illness / pain: rest, never a run ----------
test("a hard floor (rest-grade readiness, illness, pain) makes ANY run day rest or optional easy movement", () => {
  const long = { kind_label: "long", label: "Long run", target_distance_km: 16 };
  const quality = { kind_label: "quality", label: "Hill repeats", target_distance_km: 7 };
  const easy = { kind_label: "easy", label: "Easy run", target_distance_km: 6 };
  const ev = (floors) => ({ floors, soft_brakes: [], supports: ["hrv_at_usual"], athlete_word: "up" });
  for (const floor of ["rest_grade_readiness", "illness", "pain_or_injury"]) {
    for (const planned of [long, quality, easy]) {
      const adj = runDayIntensity(TODAY, planned, { evidence: ev([floor]) });
      assert.equal(adj.dose, "rest", `${floor} on ${planned.kind_label}`);
      assert.equal(adj.kind, "easy");
      assert.equal(adj.target_distance_km, null, "no distance: the run is not prescribed");
      assert.equal(adj.changed, true);
      assert.equal(adj.reason_code, `floor:${floor}`);
      assert.equal(violatesReadingGrammar(adj.why), null, adj.why);
      assert.doesNotMatch(adj.why, /\d/);
    }
    // A hard floor still reaches through the week's structure — except race day itself.
    assert.equal(runDayIntensity(TODAY, quality, { locks: ["taper"], evidence: ev([floor]) }).dose, "rest");
    assert.equal(
      runDayIntensity(TODAY, { ...long, race: true }, { evidence: ev([floor]) }).reason_code,
      "locked:race_day"
    );
  }
  // A milder floor keeps the bounded shortening.
  const mild = runDayIntensity(TODAY, long, { evidence: ev(["short_night"]) });
  assert.equal(mild.dose, "shortened");
  assert.equal(mild.target_distance_km, Math.round(16 * LONG_FLOOR_FACTOR * 10) / 10);
  // …and an easy day is untouched by a milder floor.
  assert.equal(runDayIntensity(TODAY, easy, { evidence: ev(["short_night"]) }).changed, false);
});

test("rest-grade readiness on a long-run morning: plan, agenda, Today line and Brief all say rest", () => {
  longTodayAthlete();
  tonight({ ...GOOD_NIGHT, training_readiness: 10 });
  const plan = weeklyRunPlan(TODAY);
  const adj = plan.today_adjustment;
  assert.equal(adj?.dose, "rest", JSON.stringify(adj));
  const run = todayRun(plan);
  assert.equal(run.target_distance_km, null, "no shortened long run on a rest-grade morning");
  assert.equal(run.kind_label, "easy");
  assert.doesNotMatch(run.label, /long run/i);
  const agenda = flexibleTrainingAgenda(TODAY);
  const intent = agenda.intents.find((i) => i.suggested_date === TODAY && i.status === "open");
  assert.equal(intent?.target_distance_km, null);
  assert.equal(intent?.adjustment?.dose, "rest");
  const read = repo.dayRead(TODAY);
  assert.equal(read.kind, "rest", `the Brief rests too (${read.decision?.rule_code})`);
});

// ---------- 3. a Brief steer reaches its own read ----------
test("a Brief steer is heard by the very read it steers, and by every surface after it", async () => {
  longTodayAthlete();
  tonight(GOOD_NIGHT);
  // Offline: no real agent CLI is asked (the host may have them installed), and no
  // background re-warm — the read under test is the steered one's own deterministic read.
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
  configureDayReadRefresh({ today: () => TODAY, setTimer: () => 0, clearTimer: () => {} });
  const before = weeklyRunPlan(TODAY).today_adjustment;
  assert.notEqual(before?.reason_code, "athlete_word_easy");
  const steered = await useCase.readToday({
    date: TODAY,
    override: "tired today, go easy",
    recordOutcome: true,
  });
  assert.equal(steered.signals?.stated_run_day?.reason_code, "athlete_word_easy", JSON.stringify(steered.signals?.stated_run_day));
  const after = weeklyRunPlan(TODAY).today_adjustment;
  assert.equal(after?.reason_code, "athlete_word_easy");
  assert.equal(flexibleTrainingAgenda(TODAY).today_adjustment?.reason_code, "athlete_word_easy");
  resetDayReadRefresh();
  repo.setSettings({ disabled_agents: ["stub"] });
});

// ---------- 4. the Brief's volume spike is a floor on the morning ----------
function qualityTodayWithLifting() {
  const lift = (exercise) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 });
  repo.savePlanDay(1, "Push", "Chest & shoulders", [lift("Barbell Bench Press")]);
  repo.savePlanDay(2, "Pull", "Back", [lift("Barbell Row")]);
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    strength_schedule: { days: [{ dow: (T + 1) % 7 }, { dow: (T + 5) % 7 }], source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: (T + 2) % 7, kind: "easy" },
        { dow: T, kind: "quality" },
        { dow: (T + 4) % 7, kind: "long" },
      ],
      source: "athlete",
    },
  });
  seedRunner();
  seedOwnNights();
}

test("a running-volume spike is a floor: quality goes easy, the athlete's word does not reopen it, the Brief agrees", () => {
  qualityTodayWithLifting();
  for (const back of [2, 3, 4]) repo.addActivity({ type: "run", distance_km: 15, duration_min: 90, date: addDays(TODAY, -back) });
  tonight(GOOD_NIGHT);
  repo.addCheckin(TODAY, { note: "feel great, hills today" });
  const ev = runMorningEvidence(TODAY);
  assert.ok(ev.floors.includes("volume_spike"), JSON.stringify(ev));
  const plan = weeklyRunPlan(TODAY);
  if (plan.today_adjustment) {
    assert.equal(plan.today_adjustment.kind, "easy", JSON.stringify(plan.today_adjustment));
    assert.ok(plan.today_adjustment.floors.includes("volume_spike"));
  }
  const read = repo.dayRead(TODAY);
  assert.notEqual(read.kind, "train", `the Brief does not send a spiking week to a hard session (${read.decision?.rule_code})`);
  // The spike ALONE, on an otherwise green morning with the athlete asking: still easy.
  const alone = runDayIntensity(
    TODAY,
    { kind_label: "quality", label: "Hill repeats", target_distance_km: 7 },
    {
      evidence: {
        floors: ["volume_spike"],
        soft_brakes: [],
        supports: ["readiness_supportive", "hrv_at_usual", "slept_enough"],
        athlete_word: "up",
      },
    }
  );
  assert.equal(alone.kind, "easy");
  assert.equal(alone.reason_code, "floor:volume_spike");
  assert.equal(violatesReadingGrammar(alone.why), null, alone.why);
});

// ---------- 5. readers that sum the week see the week, not the morning ----------
test("the week's own readers (long-run ramp, weekAsPlanned) never see a morning-adjusted week", () => {
  longTodayAthlete();
  tonight(GOOD_NIGHT);
  repo.addCheckin(TODAY, { note: "tired today, go easy" });
  const adjusted = weeklyRunPlan(TODAY);
  const planned = weeklyRunPlan(TODAY, { adjustToday: false });
  const plannedLong = planned.runs.find((r) => r.kind_label === "long").target_distance_km;
  assert.ok(todayRun(adjusted).target_distance_km < plannedLong, "precondition: the morning shortened today's long run");
  assert.equal(ramp.templateLongRunKm(TODAY), plannedLong, "the ramp reads the week's long run");
  assert.equal(typeof rp.weekAsPlanned, "function");
  const sum = (runs) => Math.round(runs.reduce((s, r) => s + Number(r.target_distance_km ?? 0), 0) * 10) / 10;
  assert.equal(sum(rp.weekAsPlanned(adjusted)), sum(planned.runs));
});

// ---------- 7. HRV / resting HR speak only when VERIFIED ----------
test("a contradicted overnight reading opens no floor and adds no support; an unwitnessed low HRV opens no floor", () => {
  qualityTodayAthlete();
  // The mid-day provisional shape: resting HR far above the same source's own floor,
  // no night behind it. HRV high beside it must not count as "usual" either.
  tonight({ hrv_ms: 70, resting_hr: 75, min_hr: 50 });
  const contradicted = runMorningEvidence(TODAY);
  assert.ok(!contradicted.floors.includes("rhr_above_own_band"), JSON.stringify(contradicted));
  assert.ok(!contradicted.supports.includes("hrv_at_usual"), JSON.stringify(contradicted));

  resetTables("garmin_daily_metrics");
  seedOwnNights();
  tonight({ hrv_ms: 30 });
  const unwitnessed = runMorningEvidence(TODAY);
  assert.ok(!unwitnessed.floors.includes("hrv_below_own_band"), JSON.stringify(unwitnessed));

  // A verified low night still brakes.
  resetTables("garmin_daily_metrics");
  seedOwnNights();
  tonight({ ...GOOD_NIGHT, hrv_ms: 30 });
  assert.ok(runMorningEvidence(TODAY).floors.includes("hrv_below_own_band"));
});

// ---------- a. an easy day on the stated QUALITY weekday can open ----------
function thinBaseQualityToday() {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: {
      days: [
        { dow: (T + 5) % 7, kind: "easy" },
        { dow: T, kind: "quality" },
        { dow: (T + 3) % 7, kind: "long" },
      ],
      source: "athlete",
    },
  });
  for (let w = 1; w <= 6; w++) {
    const monday = addDays(MONDAY, -7 * w);
    for (const [offset, km] of [
      [1, 3],
      [3, 3],
      [6, 4],
    ])
      repo.addActivity({ type: "run", distance_km: km, duration_min: km * 7, date: addDays(monday, offset) });
  }
  seedOwnNights();
}

test("a thin-base week's easy run on the stated quality weekday opens to a short set on a green morning or the athlete's word", () => {
  thinBaseQualityToday();
  const week = weeklyRunPlan(TODAY, { adjustToday: false });
  assert.ok(!week.runs.some((r) => r.kind_label === "quality"), "precondition: a thin base keeps no quality");
  assert.equal(todayRun(week)?.kind_label, "easy", "precondition: an easy run sits on the stated quality day");

  tonight(GOOD_NIGHT);
  const green = weeklyRunPlan(TODAY);
  assert.equal(todayRun(green).kind_label, "quality", JSON.stringify(green.today_adjustment));
  assert.equal(green.today_adjustment?.dose, "short");
  assert.equal(todayRun(green).target_distance_km, todayRun(week).target_distance_km, "the volume is the week's own");

  // A floor keeps it easy, the athlete's word included.
  resetTables("garmin_daily_metrics");
  seedOwnNights();
  tonight({ ...GOOD_NIGHT, sleep_min: 290 });
  repo.addCheckin(TODAY, { note: "feel great, hills today" });
  assert.equal(todayRun(weeklyRunPlan(TODAY)).kind_label, "easy");

  // A neutral morning with the athlete's explicit word opens it.
  resetTables("garmin_daily_metrics", "checkins");
  seedOwnNights();
  repo.addCheckin(TODAY, { note: "legs feel fresh, let's do the intervals" });
  assert.equal(todayRun(weeklyRunPlan(TODAY)).kind_label, "quality");
});

// ---------- c. absent morning data says nothing about the morning ----------
test("before anything from the morning has come in, no sentence calls the morning quiet or steady", () => {
  qualityTodayAthlete();
  const quiet = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(todayRun(quiet).kind_label, "easy");
  assert.doesNotMatch(quiet.today_adjustment.why, /this morning|morning is quiet|morning reads/i, quiet.today_adjustment.why);
  const normal = {
    programState: { endurance: { sport: "run", longest_km_4wk: 12, has_quality: true, status: "maintaining" } },
    recovery: SPIKE.recovery,
    block: { week_index: 1 },
    adjustToday: true,
  };
  const planned = weeklyRunPlan(TODAY, normal);
  assert.equal(todayRun(planned).kind_label, "quality");
  assert.doesNotMatch(planned.today_adjustment.why, /this morning|morning reads/i, planned.today_adjustment.why);
  // With a morning in, the neutral read may speak of it.
  repo.addCheckin(TODAY, { energy: 3 });
  const withMorning = weeklyRunPlan(TODAY, SPIKE);
  assert.equal(withMorning.today_adjustment.reason_code, "quiet_trim_week");
});

// ---------- d. a floor-day sentence promises nothing the agenda will not keep ----------
test("an easy-day sentence never promises the session a fresher day later this week", () => {
  for (const name of ["easy_floor", "easy_brakes", "word_down", "easy_neutral"]) {
    for (const say of RUN_DAY_VARIANT_SETS[name]) {
      const sentence = say("last night was a short one", "Thursday", "hills");
      assert.doesNotMatch(sentence, /fresher (?:day|one)|better morning|for later|greener day|move on/i, `${name}: ${sentence}`);
    }
  }
});
