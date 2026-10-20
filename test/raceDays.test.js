// The race countdown (src/domain/training/race-days.ts, GET /api/race-build/days,
// get_race_days) and the coach's changes attached to the days they adapted
// (plan-day-dates.ts, day-changes.ts; `changes` on /plan/day-detail, `open_day` on a
// Changes feed row).
//
// The fixture is the 2026-10-19 incident's shape: five plan days lifted Mon–Fri, the
// ring phased by the log (last week day 1 landed Thursday, day 2 Friday), so this week
// deals Mon=3, Tue=4, Wed=5, Thu=1, Fri=2 — the Lower day falls on FRIDAY. A change to
// day 2 must show on Friday (the weekday map's date), never on a guessed Tuesday.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { coachChangesRead } from "../dist/domain/training/day-changes.js";
import { weekLayoutWeekOf } from "../dist/domain/training/plan-day-dates.js";
import { plainInline } from "../dist/lib/plain-text.js";
import { paceWords } from "../dist/repo/display-words.js";
import { insertBrainDecision } from "../dist/repo/brain-decisions.js";
import { thisWeekPlanDayMap } from "../dist/repo/plan-selection.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import { decisionAffectedDates, planDayDatesAhead } from "../dist/domain/training/plan-day-dates.js";
import { dayChangesOn } from "../dist/domain/training/day-changes.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { raceDays } from "../dist/domain/training/race-days.js";
import { programRouter } from "../dist/routes/program.js";
import { registerProgramTools } from "../dist/surfaces/mcp/program.js";
import { runWithTimeZone } from "../dist/tz.js";

const NOW = new Date("2026-10-19T12:00:00");
const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";
const FRIDAY = "2026-10-23";
const NEXT_MONDAY = "2026-10-26";
const RACE_DAY = "2026-11-01";
const LAST_THURSDAY = "2026-10-15";
const LAST_FRIDAY = "2026-10-16";

function seedRuns() {
  const before = (n) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < 8; wk++) {
    for (const off of [1, 3, 4]) {
      repo.addActivity({ type: "run", duration_min: 50, distance_km: 8, date: before(wk * 7 + off) });
    }
  }
}

function seedIncidentWeek(t, { raceDate = RACE_DAY } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  repo.savePlanDay(1, "Push A", "Chest and shoulders", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
  ]);
  repo.savePlanDay(2, "Lower", "The week's one leg day", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 90 },
  ]);
  repo.savePlanDay(3, "Upper back & arms", "Back and arms", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "EZ Bar Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 60 },
  ]);
  repo.savePlanDay(4, "Push B", "Incline and dips", [
    { exercise: "Incline Dumbbell Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 50 },
  ]);
  repo.savePlanDay(5, "Pull", "Vertical pull", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Cambridge Half", date: raceDate, distance_km: 21.1, target: "sub-1:45" },
    strength_schedule: {
      days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }],
      source: "athlete",
      updated_at: "2026-10-01",
    },
    endurance_schedule: {
      days: [
        { dow: 4, kind: "quality" },
        { dow: 5, kind: "easy" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
      updated_at: "2026-10-01",
    },
  });
  seedRuns();
  // Last week the athlete lifted day 1 on Thursday and day 2 on Friday: the ring
  // continues from there, so this week opens on day 3.
  repo.logSetByName({ exercise: "Bench Press", weight: 155, reps: 8, rir: 2, date: LAST_THURSDAY, day_number: 1 });
  repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 6, rir: 2, date: LAST_FRIDAY, day_number: 2 });
}

/** A coach change that landed today on plan day 2 (the chat replan's shape). */
function landDayTwoChange(overrides = {}) {
  return insertBrainDecision({
    effective_date: MONDAY,
    kind: "training_target",
    domain: "training",
    summary: "Lighter leg work for the race",
    rationale: "The race is close, so the Lower day keeps its movements at fewer sets.",
    source: "chat",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {
      changes: [
        {
          day_number: 2,
          exercise: "Back Squat",
          sets: 2,
          before: { sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
          change: "updated",
        },
      ],
    },
    specialist: null,
    applied_at: "2026-10-19T08:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  });
}

const SCORE = /"(?:score|grade|percent|percentile|impact_score)"/i;

test("a change to plan day 2 maps onto the date that carries day 2 — the weekday map, not Mon=Day 1", (t) => {
  seedIncidentWeek(t);
  const map = thisWeekPlanDayMap(MONDAY).map;
  assert.equal(map.get(1)?.day_number, 3, "Monday carries the ring's day 3, not Mon=Day 1");
  // The ring dealt Lower onto Friday (the threshold run's next day); the key-run-aware week
  // trades it onto Tuesday, clear of Thursday's quality run and Sunday's long run.
  assert.equal(map.get(2)?.day_number, 2, "the key-run trade puts day 2 on Tuesday this week");
  assert.notEqual(map.get(5)?.day_number, 2, "Friday is not day 2 after the trade");

  const dayTwo = planDayDatesAhead(MONDAY)
    .filter((row) => row.day_number === 2)
    .map((row) => row.date);
  assert.equal(dayTwo[0], TUESDAY, "this week's day-2 date");
  const nextDayTwo = dayTwo.filter((d) => d >= NEXT_MONDAY);
  assert.equal(nextDayTwo.length, 1, "next week carries day 2 once");

  const decision = landDayTwoChange();
  assert.deepEqual(decisionAffectedDates(decision, MONDAY), dayTwo);

  // The day page carries it on Friday, in the feed's words, with the feed's Undo; Tuesday has none.
  const [row] = brainChangesRead({ asOf: MONDAY }).days.flatMap((d) => d.changes);
  assert.equal(row.id, decision.id);
  assert.equal(row.open_day, TUESDAY, "the feed row links the day it adapted");
  const friday = dayDetail(TUESDAY);
  assert.equal(friday.lift?.title, "Lower");
  assert.equal(friday.changes.length, 1);
  assert.equal(friday.changes[0].decision_id, decision.id);
  assert.equal(friday.changes[0].title, row.title);
  assert.equal(friday.changes[0].state, "applied");
  assert.equal(friday.changes[0].reversible, true);
  assert.deepEqual(friday.changes[0].undo, { available: row.undo.available, label: row.undo.label });
  assert.deepEqual(dayDetail(FRIDAY).changes, []);
  assert.deepEqual(dayChangesOn("2026-10-18", MONDAY), [], "a day already lived carries no change");
  assert.doesNotMatch(JSON.stringify(friday.changes), /\bremov/i, "adapted, never removed");
});

test("an announced change touches only the days from when it lands; a put-back one touches none", (t) => {
  seedIncidentWeek(t);
  const draft = repo.createProposal("stub", "chat: lighter legs for the race", "", {
    summary: "Lighter leg work for the race",
    rationale: "The race is close.",
    changes: [{ day_number: 2, exercise: "Back Squat", sets: 2, reason: "taper" }],
  });
  const announced = insertBrainDecision({
    effective_date: NEXT_MONDAY,
    kind: "training_target",
    domain: "training",
    summary: "Lighter leg work for the race",
    rationale: "The race is close.",
    source: "chat",
    source_ref_type: "plan_proposal",
    source_ref_key: String(draft.id),
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: draft.id },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const nextDayTwo = planDayDatesAhead(MONDAY)
    .filter((row) => row.day_number === 2 && row.date >= NEXT_MONDAY)
    .map((row) => row.date);
  assert.equal(nextDayTwo.length, 1);
  assert.deepEqual(decisionAffectedDates(announced, MONDAY), nextDayTwo, "its draft names day 2; it lands next Monday");
  assert.equal(dayDetail(nextDayTwo[0]).changes[0]?.state, "announced");
  assert.deepEqual(dayDetail(TUESDAY).changes, [], "not before it lands");

  const reverted = landDayTwoChange({ status: "reverted", reverted_at: "2026-10-19T09:00:00.000Z" });
  assert.deepEqual(decisionAffectedDates(reverted, MONDAY), []);
});

test("the countdown: today through race day, a row a day, read over the plan strip and the race build", (t) => {
  seedIncidentWeek(t);
  const decision = landDayTwoChange();
  const read = raceDays();
  assert.equal(read.available, true);
  assert.equal(read.reason, null);
  assert.equal(read.race.date, RACE_DAY);
  assert.equal(read.race.days_to_race, 13);
  assert.equal(read.race.target_text, "sub-1:45");
  assert.equal(read.weeks[0].week_start, MONDAY);
  assert.equal(read.weeks.at(-1).week_start, NEXT_MONDAY);
  const days = read.weeks.flatMap((w) => w.days);
  assert.equal(days.length, 14, "Oct 19 through Nov 1");
  assert.equal(days[0].date, MONDAY);
  assert.equal(days[0].today, true);
  assert.equal(days[0].days_out, 13);
  assert.equal(days.at(-1).date, RACE_DAY);
  assert.equal(days.at(-1).race_day, true);
  assert.equal(days.at(-1).days_out, 0);
  assert.equal(days.at(-1).run?.race, true, "race day carries the race");
  assert.equal(days.at(-1).lift, null);

  // A read over the plan strip: the lift and the run are the strip's own cells.
  const week = planWeek(MONDAY);
  for (const row of read.weeks[0].days) {
    const cell = week.days.find((d) => d.date === row.date);
    const strength = cell?.plan_day?.role === "strength" ? cell.plan_day.name : null;
    assert.equal(row.lift?.name ?? null, strength ?? (cell?.session?.title || null), `${row.date}: the strip's lift`);
    if (cell?.run && !cell.run.rested && !(cell.run.completion_date && cell.run.completion_date !== cell.date)) {
      assert.ok(row.run, `${row.date}: the strip's run`);
      if (row.run.km != null) assert.ok(row.run.distance_text, `${row.date}: its distance in words`);
    }
    assert.equal(row.rest, !row.run && !row.lift);
  }

  // The week's heading is the build's own rung.
  assert.ok(read.weeks[0].stage_word, "the stage word for the week");

  // Tuesday: the Lower day (traded off Friday), adapted by the coach — legs lighter, the change attached.
  const friday = days.find((d) => d.date === TUESDAY);
  assert.equal(friday.lift?.name, "Lower");
  assert.equal(friday.lift?.heavy_lower, true);
  assert.equal(friday.lift?.legs_lighter, true);
  assert.deepEqual(
    friday.changes.map((c) => c.decision_id),
    [decision.id]
  );
  // No `travel` on the strip's cells yet: absent is no marker.
  assert.ok(days.every((d) => d.travel === null));
  assert.doesNotMatch(JSON.stringify(read), SCORE);
});

test("farther than three weeks out there is no countdown, and the route and MCP tool answer the same body", async (t) => {
  seedIncidentWeek(t, { raceDate: "2026-12-06" });
  const far = raceDays();
  assert.equal(far.available, false);
  assert.match(far.reason, /three weeks/);
  assert.deepEqual(far.weeks, []);

  const layer = programRouter.stack.find((l) => l.route?.path === "/race-build/days" && l.route.methods.get);
  assert.ok(layer, "routed");
  const rest = await new Promise((resolve) => {
    layer.route.stack.at(-1).handle(
      { query: { through: "race" } },
      {
        json(body) {
          resolve(body);
        },
      }
    );
  });
  const tools = new Map();
  registerProgramTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const mcp = JSON.parse((await tools.get("get_race_days")({})).content[0].text);
  assert.deepEqual(mcp, JSON.parse(JSON.stringify(rest)));
  assert.deepEqual(rest, JSON.parse(JSON.stringify(far)));
});

test("a change that raises the squat adapts the day without lightening the legs", (t) => {
  seedIncidentWeek(t);
  const baseline = raceDays().weeks.flatMap((w) => w.days).find((d) => d.date === TUESDAY).lift?.legs_lighter;
  landDayTwoChange({
    summary: "Squat steps up",
    action: {
      changes: [
        {
          day_number: 2,
          exercise: "Back Squat",
          sets: 3,
          target_weight: 195,
          before: { sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
          change: "updated",
        },
      ],
    },
  });
  const tuesday = raceDays().weeks.flatMap((w) => w.days).find((d) => d.date === TUESDAY);
  assert.equal(tuesday.changes.length, 1, "the day still says the coach changed it");
  assert.equal(tuesday.lift?.legs_lighter, baseline, "a raise adds nothing to the race build's own trim read");
});

test("an old un-scoped change no longer marks upcoming days; a scoped one holds only to its end date", (t) => {
  seedIncidentWeek(t);
  landDayTwoChange({ applied_at: "2026-10-01T08:00:00.000Z", effective_date: "2026-10-01" });
  assert.deepEqual(dayChangesOn(TUESDAY, MONDAY), [], "landed three weeks ago: not this week's adaptation");
  const newer = landDayTwoChange();
  const superseded = landDayTwoChange({ superseded_by: newer.id });
  assert.ok(!dayChangesOn(TUESDAY, MONDAY).some((c) => c.decision_id === superseded.id), "a superseded change marks nothing");
});

// ---------- a whole-week layout belongs to its week (2026-10-20) ----------
//
// Live: two week rewrites applied Thursday 2026-10-15 ("Restore your previous week")
// still listed on the NEXT week's Friday, and Horizon repeated them on every day Tue–Fri.
// A layout touches only the week it was made for, said once on that week's heading —
// never on a later week's day, so no Undo there rolls back an earlier week.

function landWeekLayout(overrides = {}) {
  const changes = [1, 2, 3, 4, 5].map((day_number) => ({
    day_number,
    exercise: "Bench Press",
    sets: 3,
    change: "added",
    before: null,
  }));
  return insertBrainDecision({
    effective_date: MONDAY,
    kind: "training_structure",
    domain: "training",
    summary: "The week now fits around your three runs.",
    rationale: "You asked for the week to fit around the runs.",
    source: "chat",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {
      day_count: 5,
      changes,
      days: [1, 2, 3, 4, 5].map((day_number) => ({ day_number, name: `Day ${day_number}`, focus: null, reasons: [] })),
    },
    specialist: null,
    applied_at: "2026-10-19T08:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  });
}

test("a week layout made last week touches no day of this week — no stale Undo on a later week", (t) => {
  seedIncidentWeek(t);
  const stale = landWeekLayout({ effective_date: LAST_THURSDAY, applied_at: "2026-10-15T04:04:44.495Z" });
  assert.equal(weekLayoutWeekOf(stale), "2026-10-12", "made for the week of Oct 12");
  assert.deepEqual(decisionAffectedDates(stale, MONDAY), [], "no date this week or next carries it");
  for (const day of [MONDAY, TUESDAY, FRIDAY, NEXT_MONDAY]) {
    assert.ok(!dayChangesOn(day, MONDAY).some((c) => c.decision_id === stale.id), day);
  }
  const read = raceDays();
  for (const week of read.weeks) {
    assert.ok(!(week.changes ?? []).some((c) => c.decision_id === stale.id), week.week_start);
    for (const day of week.days) assert.ok(!day.changes.some((c) => c.decision_id === stale.id), day.date);
  }
});

test("this week's layout is said once on its week, on its own days' pages, and never on next week", (t) => {
  seedIncidentWeek(t);
  const older = landWeekLayout({ applied_at: "2026-10-19T07:00:00.000Z" });
  const newer = landWeekLayout({ applied_at: "2026-10-19T09:00:00.000Z" });
  const read = coachChangesRead(MONDAY);
  assert.deepEqual(
    (read.weeks.get(MONDAY) ?? []).map((c) => c.decision_id),
    [newer.id],
    "the newest rewrite of the week replaced the older one"
  );
  for (const [date, list] of read.days) {
    assert.ok(!list.some((c) => c.decision_id === newer.id || c.decision_id === older.id), `never per day: ${date}`);
  }
  // Horizon: once, on the week's heading; no day row repeats it.
  const days = raceDays();
  const thisWeek = days.weeks.find((w) => w.week_start === MONDAY);
  assert.deepEqual((thisWeek.changes ?? []).map((c) => c.decision_id), [newer.id]);
  for (const day of thisWeek.days) assert.ok(!day.changes.some((c) => c.decision_id === newer.id), day.date);
  for (const week of days.weeks.filter((w) => w.week_start !== MONDAY)) {
    assert.ok(!(week.changes ?? []).some((c) => c.decision_id === newer.id), week.week_start);
  }
  // The day page of a day in that week carries it (one day, one week); next week's never.
  assert.ok(dayChangesOn(FRIDAY, MONDAY).some((c) => c.decision_id === newer.id));
  assert.ok(!dayChangesOn("2026-10-27", MONDAY).some((c) => c.decision_id === newer.id));
});

// ---------- a lift change lands where its plan day sits this week ----------

test("after today's swap a lift change lands on the date its plan day now holds, not the template weekday", (t) => {
  seedIncidentWeek(t);
  // The swap is the REAL today's (week-strength-placement.ts): the clock reads Tuesday.
  t.mock.timers.setTime(new Date(`${TUESDAY}T12:00:00`).getTime());
  const plain = planWeek(TUESDAY);
  const mapped = plain.days.find((d) => d.date === TUESDAY).plan_day;
  assert.equal(mapped?.day_number, 2, "Lower sits on Tuesday before the swap");
  const later = plain.days.find((d) => d.date > TUESDAY && d.plan_day?.role === "strength" && d.plan_day.day_number !== 2);
  assert.ok(later, "a later lift day to swap with");
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'x', 'y', NULL, ?, 'deterministic')`
  ).run(TUESDAY, JSON.stringify({ plan_selection: { selected: { day_number: later.plan_day.day_number }, adapted: true } }));
  const week = planWeek(TUESDAY);
  assert.equal(week.days.find((d) => d.date === TUESDAY).plan_day.day_number, later.plan_day.day_number);
  assert.equal(week.days.find((d) => d.date === later.date).plan_day.day_number, 2, "Lower traded to the later day");

  const decision = landDayTwoChange({ effective_date: TUESDAY, applied_at: "2026-10-20T08:00:00.000Z" });
  const thisWeek = decisionAffectedDates(decision, TUESDAY).filter((d) => d < NEXT_MONDAY);
  assert.deepEqual(thisWeek, [later.date], "the Lower change sits where Lower now is");
  const rows = raceDays({ today: TUESDAY }).weeks.flatMap((w) => w.days);
  assert.ok(!rows.find((d) => d.date === TUESDAY).changes.some((c) => c.decision_id === decision.id), "not on Tuesday");
  assert.ok(rows.find((d) => d.date === later.date).changes.some((c) => c.decision_id === decision.id));
});

// ---------- a run already run shows what was run ----------

test("a done run's row shows the logged pace, not the plan's band", (t) => {
  seedIncidentWeek(t);
  repo.addActivity({ type: "run", duration_min: 38, distance_km: 6.6, date: MONDAY });
  const today = raceDays().weeks[0].days.find((d) => d.date === MONDAY);
  assert.ok(today.run, "the run sits on today's row");
  assert.equal(today.run.status, "completed");
  assert.equal(today.run.pace_text, paceWords((38 * 60) / 6.6, "km"));
  assert.doesNotMatch(today.run.pace_text, /–/, "a single run pace, never a band");
});

// ---------- an agent's markdown is read as words ----------

test("a change's why written in markdown reaches the day and the feed without its asterisks", (t) => {
  seedIncidentWeek(t);
  const decision = landDayTwoChange({
    action: {
      user_explanation: "**Tuesday: your one leg day (squat, deadlift, calves).** It sits clear of the key runs.",
      changes: [
        {
          day_number: 2,
          exercise: "Back Squat",
          sets: 2,
          before: { sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
          change: "updated",
        },
      ],
    },
  });
  const row = brainChangesRead({ asOf: MONDAY }).days.flatMap((d) => d.changes).find((c) => c.id === decision.id);
  assert.ok(row?.why, "the why survives");
  assert.doesNotMatch(row.why, /\*/);
  assert.match(row.why, /^Tuesday: your one leg day/);
  const onDay = dayChangesOn(TUESDAY, MONDAY).find((c) => c.decision_id === decision.id);
  assert.equal(onDay.why, row.why, "the day page carries the feed's own clean words");
  assert.equal(plainInline("**Bold** and _em_ and `code` and [a link](https://x)"), "Bold and em and code and a link");
  assert.equal(plainInline("- **Monday:** Push A"), "Monday: Push A");
});

// ---------- review fixes (2026-10-20) ----------

test("an applied week layout keeps its Undo on the week while a newer announced one waits to land", (t) => {
  seedIncidentWeek(t);
  const applied = landWeekLayout({ applied_at: "2026-10-19T07:00:00.000Z" });
  const announced = landWeekLayout({
    status: "announced",
    effective_date: "2026-10-22",
    applied_at: null,
  });
  assert.equal(weekLayoutWeekOf(announced), MONDAY, "both are this week's layouts");
  const read = coachChangesRead(MONDAY);
  assert.deepEqual(
    (read.weeks.get(MONDAY) ?? []).map((c) => c.decision_id),
    [applied.id],
    "the applied layout stands until the announced one lands"
  );
  assert.ok(dayChangesOn(TUESDAY, MONDAY).some((c) => c.decision_id === applied.id));
});

test("a race-scoped adaptation applied a month ago still marks its days while it holds", (t) => {
  seedIncidentWeek(t);
  const decision = landDayTwoChange({
    effective_date: "2026-09-21",
    applied_at: "2026-09-21T08:00:00.000Z",
    action: {
      changes: [
        {
          day_number: 2,
          exercise: "Back Squat",
          sets: 2,
          until: RACE_DAY,
          before: { sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
          change: "updated",
        },
      ],
    },
  });
  db.prepare(
    `INSERT INTO plan_adaptations (decision_id, day_number, exercise, kind, until_date, status) VALUES (?, 2, 'Back Squat', 'updated', ?, 'active')`
  ).run(decision.id, RACE_DAY);
  const days = planDayDatesAhead(MONDAY).filter((r) => r.day_number === 2).map((r) => r.date);
  assert.ok(days.length, "day 2 is on the calendar ahead");
  for (const date of days) {
    assert.ok(dayChangesOn(date, MONDAY).some((c) => c.decision_id === decision.id), `${date} still carries the taper`);
  }
});

test("a whole-week layout's week is the LOCAL day it landed on, never a UTC slice", () => {
  const layout = {
    kind: "training_structure",
    action: { days: [{ day_number: 1 }] },
    context: {},
    effective_date: null,
    // Saturday evening in UTC is already Sunday morning in Tokyo: a Sunday landing opens the next week.
    applied_at: "2026-10-17T20:00:00Z",
    created_at: "2026-10-17 20:00:00",
  };
  assert.equal(runWithTimeZone("UTC", () => weekLayoutWeekOf(layout)), "2026-10-12");
  assert.equal(runWithTimeZone("Asia/Tokyo", () => weekLayoutWeekOf(layout)), "2026-10-19");
});
