// THE ELITE HYBRID WEEK, server side.
//
// Two structural gaps, both visible in the live template (five lifting days, two
// "Run" days, zero rest):
//
//   1. A rest day could only exist by being ABSENT from the plan, so a seven-day
//      week had no seam anywhere in it and the day selector surfaced a training day
//      on every calendar date of the year. `plan_days.day_type` (v99) names it.
//   2. A long run was whatever number the template happened to hold, forever — an
//      athlete whose longest run in ninety days is 9.85 km was handed a 12 km card
//      every week. The prescription now ramps toward the template instead.
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
import { validateTrainingPlan } from "../dist/repo/plan-quality.js";
import { weeklyKm } from "../dist/repo/program-state.js";
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
    "brain_decisions"
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

// A three-day ring: lift, REST, lift. Small on purpose — the rotation is then
// trivially readable, and the seam is exactly one day wide.
function seedRingWithRest() {
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
}

// Anchor the rotation on day 1 so "tomorrow" is unambiguously the rest day.
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
// 2. the rest day, as a stored thing
// ---------------------------------------------------------------------------

test("a rest day round-trips, and carrying work is refused", () => {
  seedRingWithRest();
  const plan = repo.getPlan();
  const rest = plan.find((d) => d.day_number === 2);
  assert.equal(rest.day_type, "rest");
  assert.equal(rest.items.length, 0);
  assert.equal(plan.find((d) => d.day_number === 1).day_type, "training");

  assert.throws(
    () =>
      repo.savePlanDay(2, "Rest", null, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5 }], {
        day_type: "rest",
      }),
    /rest day/i,
    "a rest day may not carry exercises"
  );
  assert.throws(() => repo.savePlanDay(2, "Rest", null, [], { day_type: "sabbath" }), /training.*rest|rest.*training/i);
});

test("an omitted day_type preserves an empty rest day but yields to incoming work", () => {
  seedRingWithRest();
  // A partial edit that says nothing about the type leaves the seam alone…
  repo.savePlanDay(2, "Off", "recovery", []);
  assert.equal(repo.getPlanDay(2).day_type, "rest");

  // …and a caller sending actual work plainly means a training day.
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
  seedRingWithRest();
  repo.replacePlan([
    { day_number: 1, name: "Push", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5 }] },
    { day_number: 2, name: "Pull", items: [{ exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 10 }] },
  ]);
  assert.equal(repo.getPlanDay(2).day_type, "training", "a full restructure declares the whole week");
});

test("the rest day is not a planned SESSION", () => {
  seedRingWithRest();
  // "2 of 6" through a week that only ever asked for five is the arithmetic a
  // first-class rest day would otherwise quietly introduce.
  assert.equal(repo.getWeeklyStats().week_planned, 2);
});

// ---------------------------------------------------------------------------
// 3. selection
// ---------------------------------------------------------------------------

test("the rotation lands on the rest day and the selector returns it", () => {
  seedRingWithRest();
  anchorOnDayOne();
  const picked = selectAdaptivePlanDay(REF);
  assert.equal(picked.day_number, 2);
  assert.equal(picked.day_type, "rest");
  assert.equal(picked.selection.adapted, false);
  assert.equal(picked.selection.rest_day, true);
  assert.equal(picked.selection.reason, null);
  // No scoring pass happened at all — the comparison is a different question.
  assert.equal(picked.selection.scores, undefined);

  const resolved = selectedPlanDayForDate(REF);
  assert.equal(resolved.day_number, 2);
  assert.equal(resolved.day_type, "rest");
});

test("scoring never promotes a rest day, and never beats one into a training day", () => {
  seedRingWithRest();
  // Anchored on the REST day: the rotation therefore points at day 3, a training
  // day, and the scorer runs. The rest day must not appear as a candidate at all.
  anchorOnDayOne(addDaysISO(REF, -2));
  repo.logSetByName({ date: YESTERDAY, exercise: "Seated Cable Row", weight: 80, reps: 10 });
  const picked = selectAdaptivePlanDay(REF);
  assert.notEqual(picked.day_type, "rest");
  const scored = picked.selection.scores ?? [];
  assert.ok(scored.length, "a training rotation is scored");
  assert.equal(
    scored.some((s) => s.day_number === 2),
    false,
    "the rest day is not an alternative to a training day"
  );
});

test("training anyway on the rest day never anchors the rotation to it", () => {
  seedRingWithRest();
  // Yesterday was the programmed rest day and they lifted the Push day's work
  // anyway. If that linked session anchored the ring, today would advance to day 3
  // and every following day would be shifted by one for the rest of the block.
  const restDayId = repo.getPlanDay(2).id;
  repo.logSetByName({ date: YESTERDAY, exercise: "Barbell Bench Press", weight: 100, reps: 8 });
  db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE date = ?`).run(restDayId, YESTERDAY);
  const picked = selectAdaptivePlanDay(REF);
  assert.equal(picked.day_number, 2, "the content they lifted resolved to day 1, so today is the seam");
  assert.equal(picked.day_type, "rest");
});

// ---------------------------------------------------------------------------
// 4. the read
// ---------------------------------------------------------------------------

test("a template rest day reads as rest, in the week's own words", () => {
  seedRingWithRest();
  anchorOnDayOne();
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, null);
  assert.equal(read.decision.rule_code, DAY_READ_OUTCOMES.template_rest_day.code);
  assert.ok(leadPhrasing(read.why), `unregistered phrasing: ${read.why}`);
  assert.equal(read.signals.template_rest_day.day_number, 2);
});

test("the rest read is a variant set, never one literal", () => {
  seedRingWithRest();
  anchorOnDayOne();
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const date = addDaysISO(REF, i * 3);
    resetTables("day_reads");
    // Re-anchor relative to each date so the rotation keeps landing on the seam.
    resetTables("logged_sets", "sessions");
    anchorOnDayOne(addDaysISO(date, -1));
    const read = dayRead(date);
    if (read.kind !== "rest" || read.decision.rule_code !== DAY_READ_OUTCOMES.template_rest_day.code) continue;
    const lead = leadPhrasing(read.why);
    assert.ok(lead, `unregistered phrasing: ${read.why}`);
    seen.add(lead);
  }
  assert.ok(seen.size > 1, "different dates must not print the same sentence");
});

test("the outcome-feedback ladder cannot open the week's rest day", () => {
  seedRingWithRest();
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
  seedRingWithRest();
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
  seedRingWithRest();
  anchorOnDayOne();
  const { envelope } = decideDailySession(REF);
  assert.equal(envelope.kind, "rest");
  assert.equal(envelope.template.day_type, "rest");
  const session = deterministicComposedSession(envelope);
  assert.equal(session.items.length, 0);
  assert.equal(session.est_minutes, null);
  assert.ok(TEMPLATE_REST_DAY_NOTE.includes(session.why), `unregistered rest card: ${session.why}`);
  assert.equal(/\byou must\b|\bdo not train\b/i.test(session.why), false, "a rest day is never a gate");
});

test("the rest card's note rotates by date", () => {
  seedRingWithRest();
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const date = addDaysISO(REF, i * 3);
    resetTables("day_reads", "logged_sets", "sessions", "daily_session_decisions");
    anchorOnDayOne(addDaysISO(date, -1));
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

test("the week's long run is the longest prescription in it, and history reads the trailing longest", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Easy",
      items: [{ kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "Z2" }],
    },
    {
      day_number: 2,
      name: "Long",
      items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 12, target_zone: "long" }],
    },
  ]);
  assert.equal(templateLongRunKm(), 12);

  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -200), 21);
  assert.equal(trailingLongestRunKm(REF), 9.85, "a run outside the window is not what the legs have done");
});

test("composition prescribes the ramped distance and keeps its own note", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Long run",
      focus: "Endurance",
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
  ]);
  // Their longest in the window is 9.85 km, and the recent weeks are quiet, so the
  // weekly build has nothing to say and the long-run step is the only shaper.
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  const envelope = {
    ...decideDailySession(REF).envelope,
    kind: "train",
    caps: { volume: "normal", intensity: "normal", duration_min: 120 },
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Endurance", intent: "template" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [] },
    candidates: [],
    endurance_hold: undefined,
  };
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
  repo.replacePlan([
    {
      day_number: 1,
      name: "Long run",
      focus: "Endurance",
      items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 12, target_zone: "long", note: "Long run" }],
    },
  ]);
  for (let week = 1; week <= 6; week++) seedRun(addDaysISO(REF, -week * 7), 9.85 - week * 0.4);
  const base = decideDailySession(REF).envelope;
  const envelope = {
    ...base,
    kind: "easy",
    caps: { volume: "reduced", intensity: "normal", duration_min: 60 },
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Endurance", intent: "template" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [] },
    candidates: [],
    endurance_hold: { no_run: true, reasons: ["longest_run_yesterday"] },
  };
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

// A cardio envelope for one plan day, with the caps handed in. The decision is real
// (so nothing about the envelope is invented); only the fields these tests are
// deliberately holding still are overridden.
function cardioEnvelope(date, dayNumber, caps) {
  return {
    ...decideDailySession(date).envelope,
    kind: "train",
    caps,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: {
      day_number: dayNumber,
      plan_day_id: repo.getPlanDay(dayNumber).id,
      focus: "Endurance",
      intent: "template",
    },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [] },
    candidates: [],
    endurance_hold: undefined,
  };
}

test("a 40 km ride is not the week's long run, and is never ramped", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Endurance",
      focus: "Endurance",
      items: [
        { kind: "cardio", exercise: "Long ride", target_distance_km: 40, target_zone: "Z2" },
        {
          kind: "cardio",
          exercise: "Long run",
          target_distance_km: 12,
          target_duration_min: 80,
          target_zone: "long",
        },
      ],
    },
  ]);
  // The bug: MAX(target_distance_km) over every cardio row made 40 the week's
  // "long run", so the 12 km run never matched it and the ramp switched off entirely.
  assert.equal(templateLongRunKm(), 12, "40 km on a bike is not the week's longest RUN");

  seedRun(addDaysISO(REF, -10), 9.8);
  seedRun(addDaysISO(REF, -24), 6);
  const envelope = cardioEnvelope(REF, 1, { volume: "normal", intensity: "normal", duration_min: 240 });
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
  repo.replacePlan([
    {
      day_number: 1,
      name: "Long run",
      focus: "Endurance",
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
  ]);
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  const envelope = cardioEnvelope(REF, 1, { volume: "normal", intensity: "normal", duration_min: 120 });
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
  repo.replacePlan([
    {
      day_number: 1,
      name: "Long run",
      focus: "Endurance",
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
  ]);
  seedRun(addDaysISO(REF, -10), 9.85);
  seedRun(addDaysISO(REF, -24), 6);
  // A 40-minute ceiling on a run the ramp just prescribed at 11.5 km: the clamp
  // rescales the distance, and the note has to be re-said about the new number
  // rather than left promising 11.5 above a 5-and-a-bit km card.
  const envelope = cardioEnvelope(REF, 1, { volume: "normal", intensity: "normal", duration_min: 40 });
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

test("the week ahead calls the template's rest day a rest day", () => {
  seedRingWithRest();
  const { days } = weekAheadPlan(REF);
  assert.equal(days.length, 3);
  const rest = days[1];
  assert.equal(rest.kind, "rest", "an itemless day is not a lift day");
  assert.equal(rest.note ?? null, null, "and a rest day carries no block-purpose line");
  assert.equal(days[0].kind, "lift");
  assert.equal(days[2].kind, "lift");
});

test("training anyway on the rest day offers the next TRAINING day, not easy movement", () => {
  seedRingWithRest();
  anchorOnDayOne();
  // Baseline: the untouched rest morning is unchanged by any of this.
  const quiet = decideDailySession(REF).envelope;
  assert.equal(quiet.kind, "rest");
  assert.equal(quiet.template.day_number, null);
  assert.equal(quiet.template.day_type, "rest");
  assert.equal(deterministicComposedSession(quiet).items.length, 0);

  const { envelope } = decideDailySession(REF, { train_anyway: true });
  assert.equal(envelope.kind, "train");
  assert.equal(envelope.template.day_number, 3, "the ring's next TRAINING day, skipping the seam");
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

test("a week that is nothing but rest keeps the old train-anyway fallback", () => {
  repo.replacePlan([{ day_number: 1, name: "Rest", focus: null, day_type: "rest", items: [] }]);
  const { envelope } = decideDailySession(REF, { train_anyway: true });
  assert.equal(envelope.kind, "train");
  const session = deterministicComposedSession(envelope);
  assert.ok(session.items.length, "the athlete still gets something");
});

test("an exercise can never be appended to the week's rest day", () => {
  seedRingWithRest();
  assert.throws(() => repo.addExerciseToPlanDay(2, "Goblet Squat", "rotate-in"), /rest day/i);
  assert.equal(repo.getPlanDay(2).items.length, 0, "and nothing landed");
  assert.ok(repo.addExerciseToPlanDay(3, "Goblet Squat", "rotate-in"), "a training day still accepts it");
});
