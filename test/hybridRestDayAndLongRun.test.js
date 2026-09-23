// THE ELITE HYBRID WEEK, server side.
//
// Two structural gaps, both visible in the live template (five lifting days, two
// "Run" days, zero rest):
//
//   1. A week had no seam anywhere in it, so the day selector surfaced a training day
//      on every calendar date of the year. v99 first named the rest day as a plan ROW;
//      migration 110 moved it to the CALENDAR, where it now lives: a weekday the
//      athlete neither lifts on (strength_schedule) nor runs on (endurance_schedule).
//      A rest row is refused, and plan days hold strength work only.
//   2. A long run was whatever number the template happened to hold, forever — an
//      athlete whose longest run in ninety days is 9.85 km was handed a 12 km card
//      every week. The prescription now ramps. The week's long run is the RUN
//      ENGINE's long prescription on the stated run days, never a plan item.
//
// Plus the small one: day-read's private copy of the trailing-7-day running-volume
// query, replaced by the canonical `weeklyKm`.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { MIGRATIONS } from "../dist/migrate.js";
import {
  TEMPLATE_REST_DAY_NOTE,
  deterministicComposedSession,
  normalizeComposedSession,
} from "../dist/repo/daily-composition.js";
import { decideDailySession } from "../dist/repo/daily-decision.js";
import { DAY_READ_OUTCOMES, DAY_READ_WHY_VARIANTS, dayRead, weekAheadPlan } from "../dist/repo/day-read.js";
import {
  LONG_RUN_MIN_KM,
  longRunRamp,
  longRunRampNote,
  templateLongRunKm,
  trailingLongestRunKm,
} from "../dist/repo/long-run-ramp.js";
import { selectAdaptivePlanDay, selectedPlanDayForDate } from "../dist/repo/plan-selection.js";
import { REST_DAY_NOT_A_PLAN_DAY } from "../dist/repo/plan.js";
import { validateTrainingPlan } from "../dist/repo/plan-quality.js";
import { weeklyKm } from "../dist/repo/program-state.js";
import { weeklyRunPlan } from "../dist/repo/run-progression.js";
import { RUN_SPORT_PATTERNS } from "../dist/repo/endurance-sports.js";
import { SUSTAINABLE_LONG_STEP_FACTOR, SUSTAINABLE_WEEKLY_BUILD_FACTOR } from "../dist/repo/run-ramp.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const REF = "2031-05-21"; // a Wednesday
const YESTERDAY = addDaysISO(REF, -1);

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "logged_sets",
    "sessions",
    "checkins",
    "plan_items",
    "plan_days",
    "exercises",
    "day_reads",
    "brain_decisions",
    "profile"
  );
});

// The read may append a second sentence (a thin-data caveat, for instance), so the
// contract is that a REGISTERED phrasing LEADS the `why` — never that it is the
// whole of it.
const leadPhrasing = (why) =>
  DAY_READ_WHY_VARIANTS.template_rest_day.find((variant) => String(why).startsWith(variant)) ?? null;

const seedRun = (date, km, minutes = Math.round(km * 6)) =>
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', ?, ?)`).run(
    date,
    minutes,
    km
  );

// Lift Tuesday and Thursday, nothing stated for running: REF (a Wednesday) is the
// week's seam — a weekday with neither, so the CALENDAR's rest day. Small on purpose:
// two strength days (numbered 1 and 3, the gap where the retired rest row used to sit)
// and one rest weekday between them.
const LIFT_TUE_THU = { days: [{ dow: 2 }, { dow: 4 }], source: "athlete" };

function seedCalendarWithRest() {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
    },
    {
      day_number: 3,
      name: "Pull",
      items: [{ exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 80 }],
    },
  ]);
  repo.setProfile({ strength_schedule: LIFT_TUE_THU });
}

// A pre-migration-110 rest ROW, written straight to the table: no writer can create
// one any more, so this is the only way to prove every reader steps around it.
function insertLegacyRestRow(dayNumber = 2) {
  return Number(
    db
      .prepare(`INSERT INTO plan_days (day_number, name, focus, day_type) VALUES (?, 'Rest', NULL, 'rest')`)
      .run(dayNumber).lastInsertRowid
  );
}

// Anchor the ring on the Push day (yesterday, a Tuesday lifting day).
function anchorOnDayOne(date = YESTERDAY) {
  repo.logSetByName({ date, exercise: "Barbell Bench Press", weight: 100, reps: 8 });
}

// ---------------------------------------------------------------------------
// 1. the migration
// ---------------------------------------------------------------------------

test("v99 adds day_type, is idempotent, and a fresh database already has it", () => {
  const v99 = MIGRATIONS.find((m) => m.version === 99);
  assert.ok(v99, "migration v99 must exist");

  const columns = () => db.prepare(`PRAGMA table_info(plan_days)`).all();
  const before = columns();
  const dayType = before.find((c) => c.name === "day_type");
  // Fresh-DB parity: db.ts's CREATE TABLE carries the column, so the test database
  // (created from that statement, never migrated into) already has it.
  assert.ok(dayType, "a fresh database's plan_days must already carry day_type");
  assert.equal(dayType.notnull, 1, "day_type is NOT NULL");
  assert.match(String(dayType.dflt_value), /training/, "and defaults to 'training'");

  // Idempotence: the migration re-runs cleanly against a database that already has
  // the column (the ALTER is swallowed), and changes nothing.
  v99.up(db);
  v99.up(db);
  assert.deepEqual(columns().map((c) => c.name), before.map((c) => c.name));
});

// ---------------------------------------------------------------------------
// 2. the rest day is NOT a stored thing
// ---------------------------------------------------------------------------

test("a rest day is never a plan row: the write is refused, and a restructure drops it", () => {
  // A restructure carrying a legacy rest day writes only the lifting days.
  repo.replacePlan([
    {
      day_number: 1,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
    },
    { day_number: 2, name: "Rest", focus: null, day_type: "rest", items: [] },
    {
      day_number: 3,
      name: "Pull",
      items: [{ exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 80 }],
    },
  ]);
  const plan = repo.getPlan();
  assert.deepEqual(
    plan.map((d) => d.day_number),
    [1, 3],
    "the rest day is the calendar's — no row is written for it"
  );
  assert.ok(plan.every((d) => d.day_type === "training"));
  assert.equal(repo.getPlanDay(2), null);

  // A direct write of a rest day is refused, empty or carrying work, in the words the
  // editor renders verbatim.
  assert.throws(
    () => repo.savePlanDay(2, "Rest", null, [], { day_type: "rest" }),
    (err) => {
      assert.equal(err.message, REST_DAY_NOT_A_PLAN_DAY);
      return true;
    }
  );
  assert.throws(
    () =>
      repo.savePlanDay(2, "Rest", null, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5 }], {
        day_type: "rest",
      }),
    /Rest days aren't plan days/
  );
  assert.equal(repo.getPlanDay(2), null, "and nothing landed");
  assert.throws(() => repo.savePlanDay(2, "Rest", null, [], { day_type: "sabbath" }), /training day/i);

  // A week that is nothing but rest has nothing to write at all.
  assert.throws(() => repo.replacePlan([{ day_number: 1, name: "Rest", focus: null, day_type: "rest", items: [] }]));
});

test("a plan-day write over a legacy rest row makes it a training day, never preserves the rest", () => {
  seedCalendarWithRest();
  insertLegacyRestRow(2);
  assert.equal(repo.getPlanDay(2), null, "a legacy rest row is never read back as a plan day");

  // A partial edit that says nothing about the type writes a training scaffold…
  repo.savePlanDay(2, "Off", "recovery", []);
  const scaffold = repo.getPlanDay(2);
  assert.equal(scaffold.day_type, "training");
  assert.equal(scaffold.items.length, 0);

  // …and a caller sending actual work gets exactly that training day.
  repo.savePlanDay(2, "Extra", null, [{ exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10 }]);
  const promoted = repo.getPlanDay(2);
  assert.equal(promoted.day_type, "training");
  assert.equal(promoted.items.length, 1);
});

test("plan quality lets a rest day be empty and refuses a rest day with items", () => {
  const week = [
    { day_number: 1, name: "Push", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8 }] },
    { day_number: 2, name: "Rest", day_type: "rest", items: [] },
  ];
  const clean = validateTrainingPlan(week);
  assert.equal(clean.ok, true, JSON.stringify(clean.errors));
  assert.equal(
    clean.errors.some((e) => e.day_number === 2),
    false,
    "emptiness is what a rest day IS — never an error against it"
  );

  const bad = validateTrainingPlan([
    week[0],
    { day_number: 2, name: "Rest", day_type: "rest", items: [{ exercise: "Plank", mode: "timed", sets: 3, target_seconds: 30 }] },
  ]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.code === "rest_day_has_items"));
});

test("a restructure that never mentions rest declares a week of training days", () => {
  seedCalendarWithRest();
  repo.replacePlan([
    { day_number: 1, name: "Push", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5 }] },
    { day_number: 2, name: "Pull", items: [{ exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 10 }] },
  ]);
  assert.equal(repo.getPlanDay(2).day_type, "training", "a full restructure declares the whole week");
});

test("the rest day is not a planned SESSION", () => {
  seedCalendarWithRest();
  // Even a legacy rest row left behind is not counted: "2 of 3" through a week that
  // only ever asked for two is the arithmetic a rest row would quietly introduce.
  insertLegacyRestRow(2);
  assert.equal(repo.getWeeklyStats().week_planned, 2);
});

// ---------------------------------------------------------------------------
// 3. selection
// ---------------------------------------------------------------------------

test("a calendar rest weekday: the selector answers rest with no plan day", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  const picked = selectAdaptivePlanDay(REF);
  assert.equal(picked.day_number, null, "a rest weekday carries no plan day at all");
  assert.equal(picked.day_type, "rest");
  assert.equal(picked.selection.adapted, false);
  assert.equal(picked.selection.rest_day, true);
  assert.equal(picked.selection.reason, null);
  assert.deepEqual(picked.selection.calendar, { kind: "rest", run_kind: null });
  // No scoring pass happened at all — the comparison is a different question.
  assert.equal(picked.selection.scores, undefined);

  // The Today door has no plan day to hand on the rest weekday.
  assert.equal(selectedPlanDayForDate(REF), null);
});

test("scoring never promotes a rest day, and never beats one into a training day", () => {
  seedCalendarWithRest();
  // A legacy rest row still sitting in the table must never be a candidate.
  insertLegacyRestRow(2);
  anchorOnDayOne();
  const THURSDAY = addDaysISO(REF, 1);
  const picked = selectAdaptivePlanDay(THURSDAY);
  assert.equal(picked.day_type, "training", "Thursday is a lifting weekday");
  assert.equal(picked.day_number, 3, "the ring's next strength day after Tuesday's Push");
  const scored = picked.selection.scores ?? [];
  assert.ok(scored.length, "a training rotation is scored");
  assert.equal(
    scored.some((s) => s.day_number === 2),
    false,
    "the rest row is not an alternative to a training day"
  );
});

test("training anyway on the rest day never moves the calendar", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  // Wednesday is the week's rest day and they lifted the Push day's work anyway.
  repo.logSetByName({ date: REF, exercise: "Barbell Bench Press", weight: 100, reps: 8 });
  // The next lifting weekday still lifts, on the ring's next strength day after the
  // Push they just did…
  const thursday = selectAdaptivePlanDay(addDaysISO(REF, 1));
  assert.equal(thursday.day_type, "training");
  assert.equal(thursday.day_number, 3);
  // …and next week's Wednesday is still the rest day: a session never re-seats the seam.
  const nextWednesday = selectAdaptivePlanDay(addDaysISO(REF, 7));
  assert.equal(nextWednesday.day_number, null);
  assert.equal(nextWednesday.day_type, "rest");
});

// ---------------------------------------------------------------------------
// 4. the read
// ---------------------------------------------------------------------------

test("a calendar rest day reads as rest, in the week's own words", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, null);
  assert.equal(read.decision.rule_code, DAY_READ_OUTCOMES.template_rest_day.code);
  assert.ok(leadPhrasing(read.why), `unregistered phrasing: ${read.why}`);
  assert.deepEqual(read.signals.template_rest_day, { day_number: null, focus: null, calendar: true });
});

test("the rest read is a variant set, never one literal", () => {
  seedCalendarWithRest();
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    // Every date here is a weekday with no lifting and no run (Wed, Sat, Fri, Mon…);
    // a lifting Tuesday is skipped below.
    const date = addDaysISO(REF, i * 3);
    resetTables("day_reads", "logged_sets", "sessions");
    const read = dayRead(date);
    if (read.kind !== "rest" || read.decision.rule_code !== DAY_READ_OUTCOMES.template_rest_day.code) continue;
    const lead = leadPhrasing(read.why);
    assert.ok(lead, `unregistered phrasing: ${read.why}`);
    seen.add(lead);
  }
  assert.ok(seen.size > 1, "different dates must not print the same sentence");
});

test("the outcome-feedback ladder cannot open the week's rest day", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  // The easy→train ladder only ever opens the day that is DUE, and it needs a real
  // plan day to open. On the seam there is none — the read stays the rest the
  // template asked for, and no plan-day focus leaks into it.
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.signals.easy_outcome_feedback?.applied ?? false, false);
  assert.equal(read.focus, null);
});

test("a push drive does not delete the week's rest day", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  repo.setSettings({ training_drive: "push" });
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.decision.rule_code, DAY_READ_OUTCOMES.template_rest_day.code);
  repo.setSettings({ training_drive: "steady" });
});

// ---------------------------------------------------------------------------
// 5. the envelope + the card
// ---------------------------------------------------------------------------

test("the rest day composes an empty card that speaks as the athlete's own plan", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  const { envelope } = decideDailySession(REF);
  assert.equal(envelope.kind, "rest");
  assert.equal(envelope.template.day_type, "rest");
  assert.equal(envelope.template.day_number, null, "no plan row stands for the rest day");
  const session = deterministicComposedSession(envelope);
  assert.equal(session.items.length, 0);
  assert.equal(session.est_minutes, null);
  assert.ok(TEMPLATE_REST_DAY_NOTE.includes(session.why), `unregistered rest card: ${session.why}`);
  assert.equal(/\byou must\b|\bdo not train\b/i.test(session.why), false, "a rest day is never a gate");
});

test("the rest card's note rotates by date", () => {
  seedCalendarWithRest();
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const date = addDaysISO(REF, i * 3);
    resetTables("day_reads", "logged_sets", "sessions", "daily_session_decisions");
    const { envelope } = decideDailySession(date);
    if (envelope.template.day_type !== "rest") continue;
    seen.add(deterministicComposedSession(envelope).why);
  }
  assert.ok(seen.size > 1, "the same sentence every week is the bug this replaces");
});

// ---------------------------------------------------------------------------
// 6. the long run
// ---------------------------------------------------------------------------

const rampInput = (over = {}) => ({
  templateKm: 12,
  trailingLongestKm: 9.85,
  lastWeekKm: 20,
  chronicWeeklyKm: 22,
  ...over,
});

test("the ramp steps one factor past the longest run, rounded to the half kilometre", () => {
  const ramp = longRunRamp(rampInput());
  assert.equal(ramp.prescribed_km, Math.round(9.85 * SUSTAINABLE_LONG_STEP_FACTOR * 2) / 2);
  assert.equal(ramp.prescribed_km, 11.5);
  assert.equal(ramp.building, true);
  assert.equal(ramp.weekly_build_hold, false);
});

test("a template already inside the ceiling is left exactly as written", () => {
  const ramp = longRunRamp(rampInput({ templateKm: 7 }));
  assert.equal(ramp.prescribed_km, 7, "the template is always the upper bound");
  assert.equal(ramp.building, false);
});

test("a template exactly at the ceiling is not 'building'", () => {
  const ramp = longRunRamp(rampInput({ templateKm: 11.5 }));
  assert.equal(ramp.prescribed_km, 11.5);
  assert.equal(ramp.building, false);
});

test("a week already at the sustainable build holds the long run at the trailing longest", () => {
  const chronic = 20;
  const ramp = longRunRamp(
    rampInput({ chronicWeeklyKm: chronic, lastWeekKm: chronic * SUSTAINABLE_WEEKLY_BUILD_FACTOR })
  );
  assert.equal(ramp.weekly_build_hold, true);
  assert.equal(ramp.prescribed_km, 10, "held at the longest (9.85 → 10 at the half km), not stepped past it");
  assert.equal(ramp.building, true);
});

test("no history floors the anchor rather than freezing the athlete at nothing", () => {
  const ramp = longRunRamp(rampInput({ trailingLongestKm: null, lastWeekKm: 0, chronicWeeklyKm: 0 }));
  assert.equal(ramp.anchor_km, LONG_RUN_MIN_KM);
  assert.equal(ramp.prescribed_km, Math.round(LONG_RUN_MIN_KM * SUSTAINABLE_LONG_STEP_FACTOR * 2) / 2);
  assert.equal(ramp.weekly_build_hold, false, "no chronic base is not 'already ramping'");
});

test("a short template is not a long run at all", () => {
  assert.equal(longRunRamp(rampInput({ templateKm: 4 })), null);
});

test("the ramp explains itself in a rotating set, and names both distances", () => {
  const ramp = longRunRamp(rampInput());
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const note = longRunRampNote(ramp, addDaysISO(REF, i));
    assert.ok(note.includes("11.5"), `the note must name today's distance: ${note}`);
    assert.ok(note.includes("12"), `…and where it is heading: ${note}`);
    seen.add(note);
  }
  assert.ok(seen.size > 1, "one literal per rule is the bug");
});

// A hybrid runner who lifts Tuesday/Thursday and has a stated LONG run on Wednesday
// (REF) and an easy Saturday. The run engine lays the week's runs on those days;
// nothing about them is a plan row. `extra` adds stated run days (a quality day, say).
function seedRunWeek(extra = []) {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    strength_schedule: LIFT_TUE_THU,
    endurance_schedule: { days: [{ dow: 3, kind: "long" }, { dow: 6, kind: "easy" }, ...extra] },
  });
}

const engineLongRun = (date = REF) =>
  weeklyRunPlan(date).runs.find((run) => run.kind_label === "long" && run.race !== true) ?? null;

// A run-day envelope for REF, with the caps handed in. The decision is real (so the
// run-day template it carries is not invented); only the fields these tests are
// deliberately holding still are overridden.
function runDayEnvelope(date, caps, over = {}) {
  const base = decideDailySession(date).envelope;
  return {
    ...base,
    kind: "train",
    caps,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [] },
    candidates: [],
    endurance_hold: undefined,
    ...over,
  };
}

test("the week's long run is the run engine's long prescription, and history reads the trailing longest", () => {
  seedRunWeek();
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -200), 21);
  // A run written onto a plan day is stripped — it can never become the week's long run.
  repo.savePlanDay(1, "Legacy", null, [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8 },
    { kind: "cardio", exercise: "Long run", target_distance_km: 30, target_zone: "long" },
  ]);
  assert.equal(
    repo.getPlanDay(1).items.some((item) => item.kind === "cardio"),
    false,
    "plan days hold strength only"
  );

  const long = engineLongRun();
  assert.ok(long, "the engine builds a long run on the stated long day");
  assert.equal(long.day_number, 3, "on the athlete's stated Wednesday");
  assert.ok(long.target_distance_km > 0);
  assert.equal(templateLongRunKm(REF), long.target_distance_km);
  assert.notEqual(templateLongRunKm(REF), 30);

  assert.equal(trailingLongestRunKm(REF), 9.85, "a run outside the window is not what the legs have done");
});

test("with no run week there is no long run to shape", () => {
  // No running configured, no history: the engine builds nothing, and a plan row
  // cannot stand in for it.
  repo.savePlanDay(1, "Long", null, [{ kind: "cardio", exercise: "Long run", target_distance_km: 12 }]);
  assert.equal(templateLongRunKm(REF), null);
});

test("composition prescribes the ramped distance and keeps its own note", () => {
  seedRunWeek();
  // Their longest in the window is 9.85 km, and the recent weeks are quiet, so the
  // weekly build has nothing to say and the long-run step is the only shaper.
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  const envelope = runDayEnvelope(REF, { volume: "normal", intensity: "normal", duration_min: 120 });
  assert.equal(envelope.template.day_type, "run", "Wednesday is the stated long-run day");
  assert.ok(templateLongRunKm(REF) <= 12, "a 12 km card is at least the week's long run");
  const { session } = normalizeComposedSession(
    {
      name: "Long run",
      focus: "Endurance",
      why: "today's run",
      est_minutes: 80,
      items: [
        {
          kind: "cardio",
          exercise: "Long run",
          target_distance_km: 12,
          target_duration_min: 80,
          target_zone: "long",
          note: "Long run",
        },
      ],
    },
    envelope
  );
  const item = session.items[0];
  assert.equal(item.target_distance_km, 11.5, "prescribed one honest step past the longest, not the template's 12");
  assert.ok(item.note.includes("11.5") && item.note.includes("12"), `the note must explain it: ${item.note}`);
  assert.ok(item.target_duration_min < 80, "a clock written for 12 km is not the clock for 11.5");
});

test("a held day still holds — the ramp only shapes a run being offered", () => {
  seedRunWeek();
  for (let week = 1; week <= 6; week++) seedRun(addDaysISO(REF, -week * 7), 9.85 - week * 0.4);
  const envelope = runDayEnvelope(
    REF,
    { volume: "reduced", intensity: "normal", duration_min: 60 },
    { kind: "easy", endurance_hold: { no_run: true, reasons: ["longest_run_yesterday"] } }
  );
  const { session } = normalizeComposedSession(
    {
      name: "Long run",
      focus: "Endurance",
      why: "today's run",
      est_minutes: 60,
      items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 12, target_zone: "long", note: "Long run" }],
    },
    envelope
  );
  const item = session.items[0];
  assert.equal(item.exercise, "Easy walk", "the hold still turns the run into a walk");
  assert.equal(item.target_distance_km, null, "a held day carries no distance to ramp");
  assert.equal(/\d+(\.\d+)? km/.test(String(item.note)), false, `the hold's own note survives: ${item.note}`);
});

// ---------------------------------------------------------------------------
// 7. the weekKm dedupe
// ---------------------------------------------------------------------------

// The window the inline copy computed, restated here as the SPEC the canonical
// helper has to match: the seven days ending `end`, run sports only, one decimal.
function inlineWeekKm(endIso) {
  const start = addDaysISO(endIso, -6);
  const rows = db
    .prepare(
      `SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities
        WHERE date >= ? AND date <= ? AND LOWER(type) LIKE '%run%'`
    )
    .get(start, endIso);
  return Math.round(Number(rows?.km ?? 0) * 10) / 10;
}

test("weeklyKm computes exactly the window day-read's private copy did", () => {
  // A history with runs on both endpoints of every window, so an off-by-one on
  // either side changes the answer.
  for (let back = 0; back <= 28; back++) seedRun(addDaysISO(REF, -back), 1 + (back % 5) * 0.3);
  const acuteEnd = addDaysISO(REF, -1);
  assert.equal(weeklyKm(acuteEnd, 0, RUN_SPORT_PATTERNS), inlineWeekKm(acuteEnd));
  for (const weekBack of [1, 2, 3]) {
    assert.equal(
      weeklyKm(REF, weekBack, RUN_SPORT_PATTERNS),
      inlineWeekKm(addDaysISO(REF, -weekBack * 7)),
      `week ${weekBack} back drifted`
    );
  }
});

test("the spike classification the read publishes is unchanged by the swap", () => {
  // A synthetic spike: a quiet chronic base, then a big acute week.
  for (let back = 8; back <= 28; back++) seedRun(addDaysISO(REF, -back), 0.5);
  for (let back = 1; back <= 7; back++) seedRun(addDaysISO(REF, -back), 5);
  const read = dayRead(REF);
  const acuteEnd = addDaysISO(REF, -1);
  const expectedLastWeek = inlineWeekKm(acuteEnd);
  const chronic = [1, 2, 3].map((n) => inlineWeekKm(addDaysISO(REF, -n * 7))).reduce((a, b) => a + b, 0) / 3;
  const expectedSpike = expectedLastWeek >= 25 && chronic > 0 && expectedLastWeek > chronic * 1.5;
  if (read.signals.endurance_volume) {
    assert.equal(read.signals.endurance_volume.last_week_km, expectedLastWeek);
    assert.equal(read.signals.endurance_volume.volume_spike, expectedSpike);
  }
});

// ---------------------------------------------------------------------------
// 8. review fixes — detection and application ask the SAME question
// ---------------------------------------------------------------------------

test("a 40 km ride is not the week's long run, and is never ramped", () => {
  seedRunWeek();
  seedRun(addDaysISO(REF, -10), 9.8);
  seedRun(addDaysISO(REF, -24), 6);
  // The bug: MAX(target_distance_km) over every endurance prescription made a 40 km
  // ride the week's "long run", so the 12 km run never matched it and the ramp
  // switched off entirely. The long run is the run engine's, and a ride is not in it.
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'cycling', 120, 40)`).run(
    addDaysISO(REF, -3)
  );
  assert.equal(templateLongRunKm(REF), engineLongRun().target_distance_km);
  assert.notEqual(templateLongRunKm(REF), 40, "40 km on a bike is not the week's longest RUN");

  const envelope = runDayEnvelope(REF, { volume: "normal", intensity: "normal", duration_min: 240 });
  const { session } = normalizeComposedSession(
    {
      name: "Endurance",
      focus: "Endurance",
      why: "today's endurance",
      est_minutes: 200,
      items: [
        { kind: "cardio", exercise: "Long ride", target_distance_km: 40, target_zone: "Z2", note: "Long ride" },
        {
          kind: "cardio",
          exercise: "Long run",
          target_distance_km: 12,
          target_duration_min: 80,
          target_zone: "long",
          note: "Long run",
        },
      ],
    },
    envelope
  );
  const ride = session.items.find((it) => /ride/i.test(String(it.note ?? it.exercise ?? "")));
  const run = session.items.find((it) => /run/i.test(String(it.note ?? it.exercise ?? "")));
  assert.ok(ride && run, `both prescriptions survive: ${JSON.stringify(session.items)}`);
  assert.equal(ride.target_distance_km, 40, "the ride is left exactly as the template wrote it");
  assert.equal(run.target_distance_km, Math.round(9.8 * SUSTAINABLE_LONG_STEP_FACTOR * 2) / 2);
});

test("a quality session is never the long run, whatever its distance", () => {
  // The reconciliation fixture that caught this live: a Z4 interval run was ramped
  // down like a long run — but an interval session's distance is a property of its
  // structure, and the ramp was never entitled to it.
  seedRunWeek([{ dow: 1, kind: "quality" }]);
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  // Detection: the week's long run is the engine's LONG run, never the quality session.
  const plan = weeklyRunPlan(REF);
  assert.ok(
    plan.runs.some((run) => run.kind_label === "quality"),
    "the stated quality day is in the week"
  );
  assert.equal(
    templateLongRunKm(REF),
    engineLongRun().target_distance_km,
    "the interval session does not own the week's long-run identity"
  );

  // A 12 km interval card clears the week's long-run distance, so ONLY the quality
  // predicate stands between it and the ramp's 11.5.
  assert.ok(templateLongRunKm(REF) <= 12);
  const envelope = runDayEnvelope(REF, { volume: "normal", intensity: "normal", duration_min: 240 });
  const { session } = normalizeComposedSession(
    {
      name: "Quality",
      focus: "Endurance",
      why: "today's endurance",
      est_minutes: 90,
      items: [
        {
          kind: "cardio",
          exercise: "Quality run",
          target_distance_km: 12,
          target_duration_min: 60,
          target_zone: "Z4",
          interval: [{ reps: 6, on: "1 km", off: "2 min", zone: "Z4" }],
          note: "Quality run",
        },
      ],
    },
    envelope
  );
  const quality = session.items.find((it) => /quality/i.test(String(it.note ?? it.exercise ?? "")));
  assert.ok(quality, JSON.stringify(session.items));
  assert.equal(quality.target_distance_km, 12, "the interval prescription is left exactly as written");
  assert.equal(quality.target_duration_min, 60, "and so is its clock");
});

test("an athlete with no run history is never told a distance is past 'their longest'", () => {
  const ramp = longRunRamp({ templateKm: 12, trailingLongestKm: null, lastWeekKm: 0, chronicWeeklyKm: 0 });
  assert.equal(ramp.first_long_run, true);
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const note = longRunRampNote(ramp, addDaysISO(REF, i));
    assert.equal(/longest/i.test(note), false, `there is no longest run to be past: ${note}`);
    assert.ok(note.includes(String(ramp.prescribed_km)), `the note still names today's distance: ${note}`);
    seen.add(note);
  }
  assert.ok(seen.size > 1, "one literal per rule is the bug");

  // And an athlete WITH history still gets the sentence that references it.
  const built = longRunRamp({ templateKm: 12, trailingLongestKm: 9.85, lastWeekKm: 20, chronicWeeklyKm: 22 });
  assert.equal(built.first_long_run, false);
});

test("the ramp explains the number without deleting the athlete's own instruction", () => {
  seedRunWeek();
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  const envelope = runDayEnvelope(REF, { volume: "normal", intensity: "normal", duration_min: 120 });
  const { session } = normalizeComposedSession(
    {
      name: "Long run",
      focus: "Endurance",
      why: "today's run",
      est_minutes: 80,
      items: [
        {
          kind: "cardio",
          exercise: "Long run",
          target_distance_km: 12,
          target_duration_min: 80,
          target_zone: "long",
          note: "Negative split the back half",
        },
      ],
    },
    envelope
  );
  const item = session.items[0];
  assert.equal(item.target_distance_km, 11.5);
  assert.ok(
    String(item.note).startsWith("Negative split the back half"),
    `the athlete's own coaching survives: ${item.note}`
  );
  assert.ok(item.note.includes("11.5"), `and the ramp still explains the number: ${item.note}`);
});

test("a clamped long run's note names the distance actually on the card", () => {
  seedRunWeek();
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  // A 40-minute ceiling on a run the ramp just prescribed at 11.5 km: the clamp
  // rescales the distance, and the note has to be re-said about the new number
  // rather than left promising 11.5 above a 5-and-a-bit km card.
  const envelope = runDayEnvelope(REF, { volume: "normal", intensity: "normal", duration_min: 40 });
  const { session } = normalizeComposedSession(
    {
      name: "Long run",
      focus: "Endurance",
      why: "today's run",
      est_minutes: 80,
      items: [
        {
          kind: "cardio",
          exercise: "Long run",
          target_distance_km: 12,
          target_duration_min: 80,
          target_zone: "long",
          note: "Long run",
        },
      ],
    },
    envelope
  );
  const item = session.items[0];
  assert.equal(item.target_duration_min, 40);
  assert.ok(item.target_distance_km < 11.5, `the clamp rescaled the distance: ${item.target_distance_km}`);
  assert.ok(
    item.note.includes(String(item.target_distance_km)),
    `the note must name the card's own distance (${item.target_distance_km}): ${item.note}`
  );
  assert.equal(item.note.includes("11.5"), false, `and must not still promise the pre-clamp figure: ${item.note}`);
});

test("the week ahead lists the lift days and the stated run days — rest is the weekdays with neither", () => {
  seedCalendarWithRest();
  repo.setProfile({ endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });
  // A legacy rest row is not a day of the week ahead either.
  insertLegacyRestRow(2);
  const { days } = weekAheadPlan(REF);
  assert.equal(days.length, 3);
  assert.deepEqual(
    days.map((day) => day.kind),
    ["lift", "lift", "run"]
  );
  assert.equal(
    days.some((day) => day.kind === "rest"),
    false,
    "no rest row is listed as a day"
  );
  const run = days[2];
  assert.equal(run.day, "Saturday", "the run sits on the athlete's stated weekday");
  assert.equal(run.label, "Long run");
});

test("the run day composes an empty card that points at the Endurance plan", () => {
  seedCalendarWithRest();
  // Wednesday — a weekday with no lifting — is now the stated long-run day.
  repo.setProfile({ endurance_schedule: { days: [{ dow: 3, kind: "long" }] } });
  const picked = selectAdaptivePlanDay(REF);
  assert.equal(picked.day_number, null);
  assert.equal(picked.day_type, "run");
  const { envelope } = decideDailySession(REF);
  assert.equal(envelope.template.day_type, "run");
  assert.equal(envelope.template.day_number, null, "no Long Run plan day stands for it");
  const session = deterministicComposedSession(envelope);
  assert.equal(session.name, "Run day");
  assert.equal(session.items.length, 0, "a run day carries no lifting card");
});

test("training anyway on the rest day offers the next lifting weekday's strength day, not easy movement", () => {
  seedCalendarWithRest();
  anchorOnDayOne();
  // Baseline: the untouched rest morning is unchanged by any of this.
  const quiet = decideDailySession(REF).envelope;
  assert.equal(quiet.kind, "rest");
  assert.equal(quiet.template.day_number, null);
  assert.equal(quiet.template.day_type, "rest");
  assert.equal(deterministicComposedSession(quiet).items.length, 0);

  const { envelope } = decideDailySession(REF, { train_anyway: true });
  assert.equal(envelope.kind, "train");
  assert.equal(
    envelope.template.day_number,
    3,
    "the strength day Thursday — the next lifting weekday — was about to carry"
  );
  assert.equal(envelope.template.day_type, undefined, "the emitted template describes the day being composed");
  assert.equal(envelope.caps.intensity, "hold", "the train-anyway load rules still apply");

  const session = deterministicComposedSession(envelope);
  assert.ok(session.items.length, "a real day composes real work");
  assert.equal(
    session.items.some((it) => /easy movement/i.test(String(it.exercise ?? ""))),
    false,
    "the generic fallback is what this replaces"
  );
  assert.ok(
    session.items.some((it) => /Seated Cable Row/i.test(String(it.exercise ?? ""))),
    `day 3's own work: ${JSON.stringify(session.items)}`
  );
});

test("a week with no strength day to give keeps the old train-anyway fallback", () => {
  // Lifting days are stated but the plan holds nothing to lift: the calendar still
  // answers Wednesday as rest, and train-anyway has no strength day to take them to.
  repo.setProfile({ strength_schedule: LIFT_TUE_THU });
  assert.equal(selectAdaptivePlanDay(REF).day_type, "rest", "the calendar is answered even with an empty plan");
  const { envelope } = decideDailySession(REF, { train_anyway: true });
  assert.equal(envelope.kind, "train");
  const session = deterministicComposedSession(envelope);
  assert.ok(session.items.length, "the athlete still gets something");
});

test("an exercise can never be appended to a legacy rest row", () => {
  seedCalendarWithRest();
  const restId = insertLegacyRestRow(2);
  assert.equal(repo.addExerciseToPlanDay(2, "Goblet Squat", "rotate-in"), null, "a rest row is no landing spot");
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE plan_day_id = ?`).get(restId).n,
    0,
    "and nothing landed"
  );
  assert.ok(repo.addExerciseToPlanDay(3, "Goblet Squat", "rotate-in"), "a training day still accepts it");
});
