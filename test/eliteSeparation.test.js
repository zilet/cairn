import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isPlanProposalResult, PLAN_PROPOSAL_SCHEMA } from "../dist/agent-contracts.js";
import { normalizeStrictCaseConferenceDecision } from "../dist/brain/case-conference-contract.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { weekLayoutRead } from "../dist/domain/training/week-layout.js";
import { MIGRATIONS } from "../dist/migrate.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { deterministicComposedSession } from "../dist/repo/daily-composition.js";
import { dayFuelDemand } from "../dist/repo/fuel-demand.js";
import { withFlexibleRunLookahead } from "../dist/repo/hybrid-run-lookahead.js";
import {
  calendarDayRead,
  heavyLowerWeekdaySlots,
  planDayCandidates,
  selectAdaptivePlanDay,
  selectedPlanDayForDate,
  thisWeekPlanDayMap,
  trainAnywayPlanDay,
  weekdayPlanDayMap,
} from "../dist/repo/plan-selection.js";
import { REST_DAY_NOT_A_PLAN_DAY } from "../dist/repo/plan.js";
import { RUNS_ARE_NOT_PLAN_ITEMS } from "../dist/repo/proposals.js";
import { runComplianceRead } from "../dist/repo/run-compliance.js";
import { buildRunPlanProposal, weeklyRunPlan } from "../dist/repo/run-progression.js";
import { getRunCompliance } from "../dist/repo/sessions.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { hybridDayContext } from "../dist/repo/training-read.js";
import { publicTodayPlanDay } from "../dist/routes/today.js";
import { db, repo, resetTables } from "./_seed.js";

// RUNS LEAVE THE STRENGTH PLAN (owner ruling). Plan days hold strength only; every run
// comes from the stated run days + the run engine / rolling agenda; a rest day is a
// CALENDAR weekday that is neither a lifting day nor a run day. The intelligence stays
// hybrid in both directions — only storage and display separate.

const MON = "2031-07-14";
const TUE = "2031-07-15";
const WED = "2031-07-16";
const THU = "2031-07-17";
const FRI = "2031-07-18";
const SAT = "2031-07-19";
const SUN = "2031-07-20";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "checkins",
    "context_events",
    "plan_proposals",
    "brain_decisions",
    "brain_expectations",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

const lift = (exercise, extra = {}) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, ...extra });

// A hybrid week's SHAPE, generic: five strength days over Mon–Fri, two of them lower.
function seedStrengthWeek() {
  repo.savePlanDay(1, "Push", "Chest & shoulders", [lift("Barbell Bench Press"), lift("Overhead Press")]);
  repo.savePlanDay(2, "Pull", "Back & biceps", [lift("Barbell Row"), lift("Lat Pulldown")]);
  repo.savePlanDay(3, "Lower A", "Quads", [lift("Back Squat"), lift("Leg Press")]);
  repo.savePlanDay(4, "Upper", "Upper", [lift("Incline Dumbbell Press"), lift("Cable Row")]);
  repo.savePlanDay(5, "Lower B", "Hinge", [lift("Romanian Deadlift"), lift("Hip Thrust")]);
}

function seedHybridAthlete({
  runDays = [
    { dow: 2, kind: "easy" },
    { dow: 4, kind: "quality" },
    { dow: 0, kind: "long" },
  ],
} = {}) {
  seedStrengthWeek();
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: { days: runDays, source: "athlete" },
  });
  // A runner with real history, so the engine prescribes a week.
  for (const [date, km] of [
    ["2031-06-10", 6],
    ["2031-06-12", 8],
    ["2031-06-15", 12],
    ["2031-06-17", 6],
    ["2031-06-19", 8],
    ["2031-06-22", 13],
    ["2031-06-24", 6],
    ["2031-06-26", 8],
    ["2031-06-29", 13],
    ["2031-07-01", 6],
    ["2031-07-03", 8],
    ["2031-07-06", 14],
    ["2031-07-08", 6],
    ["2031-07-10", 8],
    ["2031-07-13", 14],
  ]) {
    repo.addActivity({ type: "run", distance_km: km, duration_min: Math.round(km * 6), date });
  }
}

// ---------- the plan holds strength only ----------

test("a run item never reaches the plan: saved days strip it, reads never carry it", () => {
  repo.savePlanDay(2, "Pull", null, [
    lift("Barbell Row"),
    { kind: "cardio", exercise: "Easy run", target_distance_km: 5, target_zone: "Z2" },
  ]);
  const day = repo.getPlanDay(2);
  assert.deepEqual(
    day.items.map((it) => it.kind),
    ["strength"],
    "the Pull card carries its lift and no run"
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n, 0);
  assert.ok(repo.getPlan().every((d) => d.items.every((it) => it.kind !== "cardio")));
});

test("a rest day is not a plan day: a declared rest day is refused in the athlete's words", () => {
  assert.throws(
    () => repo.savePlanDay(6, "Rest", null, [], { day_type: "rest" }),
    (e) => e.message === REST_DAY_NOT_A_PLAN_DAY
  );
  assert.equal(repo.getPlanDay(6), null);
});

test("a restructure keeps its lifting days and drops rest / run-only / empty days, numbers intact", () => {
  const plan = repo.replacePlan([
    { day_number: 1, name: "Push", items: [lift("Barbell Bench Press")] },
    {
      day_number: 2,
      name: "Pull",
      items: [lift("Barbell Row"), { kind: "cardio", exercise: "Easy run", target_distance_km: 5 }],
    },
    { day_number: 6, name: "Rest", day_type: "rest", items: [] },
    { day_number: 7, name: "Long Run", items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 14 }] },
  ]);
  assert.deepEqual(
    plan.map((d) => [d.day_number, d.name, d.items.length]),
    [
      [1, "Push", 1],
      [2, "Pull", 1],
    ]
  );
  assert.ok(plan.every((d) => d.day_type === "training"));
  assert.throws(() =>
    repo.replacePlan([{ day_number: 1, name: "Long Run", items: [{ kind: "cardio", exercise: "Long run" }] }])
  );
});

test("a run-only proposal lands nothing; a mixed one applies its lifting and sets the runs aside", () => {
  seedStrengthWeek();
  const runsOnly = repo.createProposal("coach", "runs", "", {
    summary: "this week's runs",
    cardio: [{ day_number: 2, label: "Easy run", target_distance_km: 6 }],
  });
  const r1 = repo.applyProposal(Number(runsOnly.id));
  assert.equal(r1.ok, false);
  assert.equal(r1.error, RUNS_ARE_NOT_PLAN_ITEMS);
  const mixed = repo.createProposal("coach", "mixed", "", {
    summary: "row up, and a run",
    changes: [
      { day_number: 2, exercise: "Barbell Row", target_weight: 105, reason: "earned" },
      { day_number: 2, kind: "cardio", label: "Easy run", target_distance_km: 6 },
    ],
  });
  const r2 = repo.applyProposal(Number(mixed.id));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.runs_set_aside, 1);
  const row = repo.getPlanDay(2).items.find((it) => it.exercise === "Barbell Row");
  assert.equal(row.target_weight, 105);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n, 0);
});

test("the run-plan apply is retired: the engine's week is live, there is nothing to apply", () => {
  seedHybridAthlete();
  const built = buildRunPlanProposal(WED);
  assert.equal(built.ok, false);
  assert.match(built.error, /run days/);
  assert.ok(weeklyRunPlan(WED).runs.length > 0, "while the week itself is still prescribed, live");
});

test("agent contracts stop soliciting runs and rest days on the plan", () => {
  assert.equal(PLAN_PROPOSAL_SCHEMA.properties.cardio, undefined);
  const dayProps = PLAN_PROPOSAL_SCHEMA.properties.days.items.properties;
  assert.equal(dayProps.day_type, undefined);
  assert.equal(dayProps.items.items.properties.target_distance_km, undefined);
  assert.equal(isPlanProposalResult({ summary: "runs", cardio: [{ day_number: 2, label: "Easy run" }] }), false);
  assert.equal(
    isPlanProposalResult({ summary: "lift", days: [{ day_number: 1, name: "Push", items: [lift("Bench Press")] }] }),
    true
  );
  const conference = (item) =>
    normalizeStrictCaseConferenceDecision({
      summary: "s",
      rationale: "r",
      confidence: "medium",
      risk_class: "low",
      revision: {
        type: "plan_restructure",
        summary: "s",
        days: [{ day_number: 1, name: "Push", focus: null, items: [item] }],
      },
    });
  const strength = conference({ exercise: "Bench Press", sets: 3 });
  const run = conference({ kind: "cardio", exercise: "Long run", target_distance_km: 12 });
  assert.equal(run?.revision ?? null, null, "a conference restructure carrying a run item is refused");
  assert.notEqual(strength, undefined);
});

// ---------- migration 110: the one-way repair ----------

test("migration 110 removes run items and non-lifting days without orphaning history, idempotently", () => {
  const day = (n, name, type = "training") =>
    Number(
      db.prepare(`INSERT INTO plan_days (day_number, name, focus, day_type) VALUES (?, ?, NULL, ?)`).run(n, name, type)
        .lastInsertRowid
    );
  const ex = Number(
    db.prepare(`INSERT INTO exercises (name, muscle_group) VALUES ('Barbell Row', 'back')`).run().lastInsertRowid
  );
  const pull = day(2, "Pull");
  const rest = day(6, "Rest", "rest");
  const longRun = day(7, "Long Run");
  const scaffold = day(8, "Day 8");
  const item = (dayId, kind, exerciseId = null) =>
    db
      .prepare(
        `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, kind, target_distance_km) VALUES (?, 0, ?, 3, ?, ?)`
      )
      .run(dayId, exerciseId, kind, kind === "cardio" ? 6 : null);
  item(pull, "strength", ex);
  item(pull, "cardio");
  item(longRun, "cardio");
  const session = Number(
    db.prepare(`INSERT INTO sessions (date, plan_day_id) VALUES ('2031-07-06', ?)`).run(longRun).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, plan_day_id, items_json, request_fingerprint)
     VALUES (1, ?, '2031-07-06', 'adaptive_plan', 'active', ?, '[]', 'fp')`
  ).run(session, longRun);

  const m110 = MIGRATIONS.find((m) => m.version === 110);
  assert.ok(m110, "migration 110 is registered");
  m110.up(db);
  m110.up(db); // idempotent

  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n, 0);
  const days = db.prepare(`SELECT id, day_type FROM plan_days ORDER BY day_number`).all();
  assert.deepEqual(
    days.map((d) => d.id),
    [pull, scaffold],
    "rest and run-only days are gone; the scaffold stays"
  );
  assert.ok(days.every((d) => d.day_type === "training"));
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE plan_day_id = ?`).get(pull).n,
    1,
    "Pull keeps its lift"
  );
  assert.equal(
    db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(session).plan_day_id,
    null,
    "the session survives, unlinked"
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions WHERE session_id = ?`).get(session).n,
    1
  );
  assert.equal(
    db.prepare(`SELECT plan_day_id FROM daily_session_compositions WHERE session_id = ?`).get(session).plan_day_id,
    null
  );
  void rest;
});

// ---------- the calendar: lift, run, or rest ----------

test("the ring is the lifting days: run and free weekdays map to no plan day", () => {
  seedHybridAthlete();
  const candidates = planDayCandidates();
  assert.ok(candidates.every((c) => c.names.length && !("cardio" in c)));
  const map = weekdayPlanDayMap(candidates, [1, 2, 3, 4, 5], 0);
  assert.deepEqual([...map.keys()].sort(), [1, 2, 3, 4, 5]);
  assert.equal(map.has(0), false, "Sunday (a stated run day) carries no plan day");
  assert.equal(map.has(6), false, "Saturday (neither) carries no plan day");
  assert.deepEqual(calendarDayRead(SUN), {
    kind: "run",
    run_kind: "long",
    lift_dows: [1, 2, 3, 4, 5],
    run_dows: [2, 4, 0],
  });
  assert.equal(calendarDayRead(SAT).kind, "rest");
  assert.equal(calendarDayRead(TUE).kind, "lift", "a stated run day that is also a lifting day lifts");
});

test("the selector answers a run or rest weekday WITHOUT a plan-day row, and never a lift", () => {
  seedHybridAthlete();
  const sun = selectAdaptivePlanDay(SUN);
  assert.equal(sun.day_number, null);
  assert.equal(sun.day_type, "run");
  assert.deepEqual(sun.selection.calendar, { kind: "run", run_kind: "long" });
  const sat = selectAdaptivePlanDay(SAT);
  assert.equal(sat.day_number, null);
  assert.equal(sat.day_type, "rest");
  assert.equal(sat.selection.rest_day, true);
  for (const d of [MON, TUE, WED, THU, FRI]) {
    const pick = selectAdaptivePlanDay(d);
    assert.equal(pick.day_type, "training", d);
    assert.ok(Number.isInteger(pick.day_number), d);
  }
  assert.equal(selectedPlanDayForDate(SUN), null, "no plan day stands for Sunday");
  // Train anyway from Sunday: the strength day Monday was about to hand them.
  const monday = thisWeekPlanDayMap("2031-07-21").map.get(1);
  assert.equal(trainAnywayPlanDay(SUN)?.day_number, monday?.day_number);
});

test("the week strip: strength from the weekday map, runs from the agenda, rest where neither", () => {
  seedHybridAthlete();
  const week = planWeek(WED);
  const cell = (dow) => week.days.find((c) => c.dow === dow);
  assert.equal(cell(6).status, "rest", "Saturday is the calendar's rest day");
  assert.equal(cell(6).plan_day, null);
  assert.equal(cell(0).plan_day, null, "Sunday has no plan day");
  assert.equal(cell(0).run?.kind, "long", "Sunday carries the long run from the agenda");
  assert.equal(cell(2).plan_day?.name, thisWeekPlanDayMap(WED).map.get(2)?.name, "Tuesday lifts");
  assert.ok(week.days.every((c) => c.plan_day == null || c.plan_day.role === "strength"));
});

test("Today on a run day and a rest day: one line, one calendar shape, no plan row", () => {
  seedHybridAthlete();
  const sun = todayStrengthLine(SUN);
  assert.equal(sun.state, "no_lift");
  assert.equal(sun.role, "endurance");
  assert.equal(sun.text, "Long run · no lift today");
  const sat = todayStrengthLine(SAT);
  assert.equal(sat.state, "rest_day");
  assert.equal(sat.text, "Rest day");
  const shape = publicTodayPlanDay(SUN);
  assert.equal(shape.day_number, null);
  assert.equal(shape.source, "calendar");
  assert.equal(shape.calendar, "run");
  assert.equal(shape.run_kind, "long");
  assert.equal(publicTodayPlanDay(SAT).calendar, "rest");
});

test("a run day composes no lifting card; the Brief names the run, the rest day reads rest", () => {
  seedHybridAthlete();
  const read = repo.dayRead(SUN);
  assert.equal(read.decision.rule_code, "stated_run_day");
  assert.equal(read.kind, "train");
  assert.match(read.why, /\brun\b/i);
  assert.equal(repo.violatesReadingGrammar(read.why), null);
  const sat = repo.dayRead(SAT);
  assert.equal(sat.decision.rule_code, "template_rest_day", "no lift and no run: the week's rest day");
  const snapshot = gatherDailyDecisionSnapshot(SUN);
  assert.equal(snapshot.plan.day_type, "run");
  assert.equal(snapshot.plan.day_number, null);
  const envelope = buildDailySessionDecision(snapshot);
  if (envelope.kind !== "rest") {
    const card = deterministicComposedSession(envelope);
    assert.equal(card.name, "Run day");
    assert.deepEqual(card.items, [], "the run lives on the Endurance plan, never on a card");
    assert.notEqual(envelope.reach?.level, "push", "no lifting card, no reach");
  }
});

// ---------- cross-domain awareness survives the move ----------

test("key-run protection still sees Thursday's quality run — from the stated days and the agenda", () => {
  seedHybridAthlete();
  const base = hybridDayContext(WED);
  assert.deepEqual(
    base.planned_run_next,
    { date: THU, kind: "quality", km: null },
    "stated Thursday quality, no plan row"
  );
  const withAgenda = withFlexibleRunLookahead(base, WED, {
    runPlan: {
      available: true,
      week_start: MON,
      runs: [
        {
          day_number: 4,
          label: "Tempo",
          kind_label: "quality",
          target_distance_km: 8,
          target_duration_min: null,
          target_zone: "Z3",
          note: null,
          interval: null,
        },
        {
          day_number: 7,
          label: "Long run",
          kind_label: "long",
          target_distance_km: 14,
          target_duration_min: null,
          target_zone: "Z2",
          note: null,
          interval: null,
        },
      ],
      rationale: [],
      quality_focus: "Tempo",
      mix_summary: "",
      why: "",
    },
  });
  assert.equal(withAgenda.planned_run_next?.date, THU);
  assert.equal(withAgenda.planned_run_next?.kind, "quality");
});

test("the run engine keeps its hard runs clear of the lifting week's lower WEEKDAYS", () => {
  seedHybridAthlete();
  // Lower A / Lower B land on Wednesday and Friday of this lifting week (the map, not
  // the plan numbers), and that is what the engine reads.
  const slots = heavyLowerWeekdaySlots(WED);
  const map = thisWeekPlanDayMap(WED).map;
  for (const [dow, day] of map) {
    const slot = dow === 0 ? 7 : dow;
    assert.equal(slots.has(slot), /Lower/.test(day.name), `${day.name} on slot ${slot}`);
  }
});

test("endurance_lower_conflict still fires after a heavy run this morning, off the log", () => {
  seedHybridAthlete({ runDays: [{ dow: 0, kind: "long" }] });
  // A long, hard run logged THIS morning on a lower lifting day that is not a stated run
  // day: the legs are loaded, and the log — not a plan row — says so.
  repo.addActivity({ type: "run", distance_km: 24, duration_min: 135, avg_hr: 168, date: WED });
  const snapshot = gatherDailyDecisionSnapshot(WED);
  assert.ok(
    snapshot.endurance.some((e) => e.days_ago === 0),
    "today's run reaches the snapshot from activities"
  );
  assert.ok(
    snapshot.plan_items.every((it) => String(it.kind ?? "strength") !== "cardio"),
    "the card carries no run"
  );
  const envelope = buildDailySessionDecision(snapshot);
  // The legs are loaded from the run (the acute gate reads it off the activity), and the
  // decision still names the conflict — whatever the selector then chose to lift.
  assert.ok(
    snapshot.muscle_load.some((m) => m.group === "quads" && m.saturated && m.source === "endurance"),
    JSON.stringify(snapshot.muscle_load)
  );
  assert.ok(envelope.precedence.includes("endurance_lower_conflict"), JSON.stringify(envelope.precedence));
});

test("the week-layout collision law still reads a lift the day before a long run", () => {
  seedHybridAthlete({
    runDays: [
      { dow: 2, kind: "easy" },
      { dow: 6, kind: "long" },
    ],
  });
  const week = thisWeekPlanDayMap(WED);
  const friday = week.map.get(5);
  assert.match(friday.name, /Lower/, "the ring lands a lower day on Friday this week");
  const read = weekLayoutRead(WED, {
    runPlan: weeklyRunPlan(WED),
    strengthDows: [1, 2, 3, 4, 5],
    enduranceDows: [2, 6],
    weekdayMap: new Map([...week.map].map(([dow, d]) => [dow, d.day_number])),
  });
  assert.equal(read.source, "run_plan");
  assert.equal(read.long_run_day, 6, "the long run comes from the engine, on Saturday");
  assert.equal(read.clean, false, "Friday's lower day the day before Saturday's long run collides");
});

test("fuel demand still sees the long-run day, and the calendar's rest day reads light", () => {
  seedHybridAthlete();
  const sun = dayFuelDemand(SUN, { today: WED });
  assert.equal(sun.demand, "big");
  assert.ok(sun.drivers.includes("long run on this day"));
  const sat = dayFuelDemand(SAT, { today: WED });
  assert.equal(sat.demand, "light");
});

test("run compliance quotes the engine's live week, never a plan row", () => {
  seedHybridAthlete();
  assert.equal(getRunCompliance(MON).prescribed_km, 0, "the raw read is actuals only");
  const read = runComplianceRead(WED);
  assert.equal(read.basis, "live_plan");
  assert.ok(read.prescribed_km > 0);
  assert.equal(read.prescribed_sessions, weeklyRunPlan(MON).runs.length);
});

// ---------- race day ----------

test("race day IS the week's long run: its weekday, its distance, its name — no second long run", () => {
  seedHybridAthlete({
    runDays: [
      { dow: 2, kind: "easy" },
      { dow: 4, kind: "quality" },
      { dow: 6, kind: "long" },
    ],
  });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Harbour Half", date: SUN, distance_km: 21.1 } });
  const plan = weeklyRunPlan(WED);
  const longs = plan.runs.filter((r) => r.kind_label === "long");
  assert.equal(longs.length, 1);
  const race = longs[0];
  assert.equal(race.race, true);
  assert.equal(race.day_number, 7, "on the race's own weekday, not the stated Saturday long slot");
  assert.equal(race.target_distance_km, 21.1);
  assert.match(race.label, /Harbour Half/);
  assert.equal(plan.runs.filter((r) => r.day_number === 7).length, 1, "nothing else on race day");
  assert.match(plan.mix_summary, /race/);
  // …and the week before carries an ordinary long run.
  const before = weeklyRunPlan("2031-07-09");
  assert.ok(before.runs.every((r) => r.race !== true));
});

// ---------- orchestrator review fixes (2026-09-23) ----------
test("the editor's save keeps an empty scaffold but drops a day that only held runs", async () => {
  const { replacePlanChecked, getPlan } = await import("../dist/repo/plan.js");
  replacePlanChecked([
    { day_number: 1, name: "Push", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8 }] },
    { day_number: 2, name: "New day", items: [] },
    { day_number: 3, name: "Long Run", items: [{ kind: "cardio", exercise: "Long Run", target_minutes: 75 }] },
  ], { quality_override: true, keepScaffolds: true });
  assert.deepEqual(
    getPlan().map((day) => day.name),
    ["Push", "New day"],
    "the scaffold stays, the run-only day is the calendar's"
  );
});

test("migration 110 retires a run-only draft and cancels the decision waiting to land it", async () => {
  const { MIGRATIONS } = await import("../dist/migrate.js");
  const { db } = await import("./_seed.js");
  const draft = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, parsed_json, status) VALUES ('auto-run-plan', 'runs', ?, 'draft')`)
    .run(JSON.stringify({ summary: "This week's runs", cardio: [{ day_number: 2, label: "Easy run", target_distance_km: 6 }] }));
  const keep = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, parsed_json, status) VALUES ('claude', 'x', ?, 'draft')`)
    .run(JSON.stringify({ summary: "Bench step", changes: [{ day_number: 1, exercise: "Bench", target_weight: 140 }] }));
  const draftId = Number(draft.lastInsertRowid);
  const cols = db.prepare(`PRAGMA table_info(brain_decisions)`).all();
  const values = {};
  for (const col of cols) {
    if (col.pk) continue;
    if (col.notnull && col.dflt_value == null) values[col.name] = col.type.toUpperCase().includes("INT") || col.type.toUpperCase().includes("REAL") ? 0 : "x";
  }
  Object.assign(values, { status: "announced", action_json: JSON.stringify({ proposal_id: draftId }) });
  const names = Object.keys(values);
  const decision = db
    .prepare(`INSERT INTO brain_decisions (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((name) => values[name]));

  MIGRATIONS.find((m) => m.version === 110).up(db);

  assert.equal(db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(draftId).status, "superseded");
  assert.equal(db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(Number(keep.lastInsertRowid)).status, "draft");
  assert.equal(db.prepare(`SELECT status FROM brain_decisions WHERE id = ?`).get(Number(decision.lastInsertRowid)).status, "canceled");
  // Idempotent.
  MIGRATIONS.find((m) => m.version === 110).up(db);
});
