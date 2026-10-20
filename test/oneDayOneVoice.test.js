// oneDayOneVoice.test.js — the 2026-09-29 morning, reproduced (owner ruling that day).
//
// A Pull day on a stated Mon–Fri lifting week. Push was logged yesterday. The oblique
// discomfort from last Thursday was resolved yesterday through its training symptom,
// while the chat turn that heard it had also filed an `injury` context event nobody
// closed. The athlete woke early ("sleep was not awesome but I feel good") and tapped
// sleep-feel 2, energy 5, soreness 1. The read said REST, excluded the back on a Pull
// day, and the week strip said nothing at all.
//
// What the athlete is owed: a train read (at most a lighter nudge), the back left in,
// no injury constraint from a resolved note, and every surface naming the day with the
// same suggestion. And the other direction must still hold: genuine objective red flags
// still rest.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { samePlace } from "../dist/repo/injury-symptom-link.js";
import { newSafetyGradeSignalSince } from "../dist/repo/recovery-refusal.js";
import { executeCoachReadTool } from "../dist/brain/read-tool-runtime.js";

const TUE = "2026-09-29";
const MON = "2026-09-28";
const THU = "2026-09-25";

beforeEach(() => {
  resetTables(
    "checkins",
    "context_events",
    "training_symptom_events",
    "symptom_reports",
    "logged_sets",
    "sessions",
    "activities",
    "plan_items",
    "plan_days",
    "profile",
    "day_reads",
    "daily_metrics",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_session_compositions",
    "app_state"
  );
});

function seedWeek() {
  repo.savePlanDay(1, "Push", "Chest, shoulders & triceps", [
    { exercise: "Bench Press", muscle_group: "chest", sets: 3, rep_low: 6, rep_high: 8 },
    { exercise: "Overhead Press", muscle_group: "shoulders", sets: 3, rep_low: 6, rep_high: 8 },
    { exercise: "Triceps Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12 },
  ]);
  repo.savePlanDay(2, "Pull", "Back, rear delts & biceps", [
    { exercise: "Lat Pulldown", muscle_group: "back", sets: 3, rep_low: 8, rep_high: 10 },
    { exercise: "Seated Cable Row", muscle_group: "back", sets: 3, rep_low: 8, rep_high: 10 },
    { exercise: "Face Pull", muscle_group: "rear delts", sets: 3, rep_low: 12, rep_high: 15 },
    { exercise: "Barbell Curl", muscle_group: "biceps", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(3, "Lower A", "Squat & quads", [
    { exercise: "Back Squat", muscle_group: "quads", sets: 3, rep_low: 5, rep_high: 8 },
  ]);
  repo.savePlanDay(4, "Upper", "Chest, back & arms", [
    { exercise: "Incline Press", muscle_group: "chest", sets: 3, rep_low: 6, rep_high: 10 },
  ]);
  repo.savePlanDay(5, "Lower B", "Hinge & single-leg", [
    { exercise: "Romanian Deadlift", muscle_group: "hamstrings", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  repo.setProfile({
    strength_schedule: {
      days: [1, 2, 3, 4, 5].map((dow) => ({ dow })),
      source: "athlete",
      updated_at: "2026-09-01",
    },
    // Runs Tue/Thu/Sat/Sun, as stated. Thursday is easy here: with a Thursday quality
    // run the week trades Wednesday's Lower A onto Tuesday (plan-selection's key-run
    // placement), and this file is about the Pull morning that week actually had.
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "easy" },
        { dow: 6, kind: "easy" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
}

function seedOblique() {
  // The two records of one pain: the training symptom from the session note, and the
  // injury event the chat turn filed the same afternoon.
  const symptom = repo.reportTrainingSymptom({
    area_text: "below right lateral",
    onset_on: THU,
    report_text: "After the last Pallof press I felt an unpleasant feeling below my right lateral.",
  });
  repo.addContextEvent({
    kind: "injury",
    title: "Right lateral / oblique discomfort",
    detail: "Unpleasant pain below right lateral following Pallof press; dead hang felt okay but discomfort persists.",
    start_date: THU,
    meta: { area: "right lateral", severity: "mild" },
  });
  return symptom;
}

function seedMorning({ withRun = true } = {}) {
  seedWeek();
  const symptom = seedOblique();
  repo.resolveTrainingSymptom(symptom.id, MON);
  // Push, logged and finished yesterday.
  for (const exercise of ["Bench Press", "Overhead Press", "Triceps Pushdown"])
    for (let i = 0; i < 3; i++) repo.logSetByName({ date: MON, exercise, weight: 100, reps: 8, day_number: 1 });
  const push = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(MON);
  repo.finishSession(Number(push.id));
  repo.addCheckin(TUE, { energy: 5, sleep_feel: 2, soreness: 1 });
  // …and the easy 9.7 km the athlete ran that day, beside the Pull.
  if (withRun)
    db.prepare(
      `INSERT INTO activities (date, type, duration_min, distance_km, rpe) VALUES (?, 'running', 58, 9.7, 4)`
    ).run(TUE);
}

test("a resolved training symptom closes its twin injury event — same day, nothing deleted", () => {
  seedWeek();
  const symptom = seedOblique();
  const open = repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury");
  assert.equal(open.length, 1, "precondition: the open symptom keeps the injury open");

  repo.resolveTrainingSymptom(symptom.id, MON);
  assert.deepEqual(
    repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury"),
    [],
    "resolved means resolved: the event leaves the active set"
  );
  const all = repo.listContextEvents().filter((e) => e.kind === "injury");
  assert.equal(all.length, 1, "no data loss: the event is still on the timeline");
  assert.equal(all[0].resolved, true);
  assert.equal(all[0].constraint_level, "resolved");
  assert.equal(all[0].resolved_by_symptom.symptom_id, symptom.id);
  assert.equal(all[0].resolved_at, null, "the row itself is untouched");
  assert.deepEqual(repo.getInjuryImpacts(TUE).injuries, []);

  // If it comes back, the event reads open again with it.
  repo.recurTrainingSymptom(symptom.id, { on: TUE });
  assert.equal(
    repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury").length,
    1,
    "a recurrence reopens the place"
  );
});

test("every reader sees the symptom-closed injury as closed — one fact, one answer", () => {
  seedWeek();
  const symptom = seedOblique();
  repo.resolveTrainingSymptom(symptom.id, MON);
  const [event] = repo.listContextEvents().filter((e) => e.kind === "injury");

  // The refusal reopen does not count a closed injury as safety-grade news.
  assert.equal(newSafetyGradeSignalSince("2026-09-20", TUE), false);

  // The coach agent's life window hands it over closed, on the symptom's date.
  const read = executeCoachReadTool(
    { tool: "read_life_context_window", args: { start_date: "2026-09-20", end_date: TUE } },
    { run_id: "run-w7", op: "coach_read", today: TUE }
  );
  const handed = read.data.events.find((e) => Number(e.id) === Number(event.id));
  assert.equal(handed.resolved_at, MON);
  assert.equal(handed.resolved_by_symptom_id, symptom.id);

  // A recurrence reopens it for every reader at once.
  repo.recurTrainingSymptom(symptom.id, { on: TUE });
  assert.equal(newSafetyGradeSignalSince("2026-09-20", TUE), true);
});

test("the tie refuses what is more than the one symptom", () => {
  // The live shape still ties.
  assert.equal(samePlace("Right lateral / oblique discomfort right lateral", "below right lateral"), true);
  // An event naming more places than the symptom.
  assert.equal(samePlace("Knee and hip pain", "left knee"), false);
  // Tissue words say WHAT, never WHERE.
  assert.equal(samePlace("Post-run muscle soreness", "muscle soreness legs"), false);
  assert.equal(samePlace("Tendon pain", "elbow tendon"), false);
  // A structural injury is never closed by a soreness symptom in the same place.
  seedWeek();
  const knee = repo.reportTrainingSymptom({ area_text: "right knee", onset_on: THU });
  repo.addContextEvent({ kind: "injury", title: "Right knee meniscus tear", start_date: THU });
  repo.resolveTrainingSymptom(knee.id, MON);
  assert.equal(repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury").length, 1);
});

test("a symptom in another place, or another episode, never closes the injury", () => {
  seedWeek();
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: THU });
  repo.addContextEvent({
    kind: "injury",
    title: "Right lateral / oblique discomfort",
    start_date: THU,
    meta: { area: "right lateral", severity: "mild" },
  });
  repo.resolveTrainingSymptom(knee.id, MON);
  assert.equal(repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury").length, 1);

  // Same place, but the symptom was a separate, earlier episode resolved before this
  // event began: it cannot speak for it.
  resetTables("context_events", "training_symptom_events", "symptom_reports");
  const earlier = repo.reportTrainingSymptom({ area_text: "right lateral", onset_on: "2026-09-10" });
  repo.resolveTrainingSymptom(earlier.id, "2026-09-12");
  repo.addContextEvent({ kind: "injury", title: "Right lateral discomfort", start_date: THU });
  assert.equal(repo.listContextEvents({ activeOnly: true, on: TUE }).filter((e) => e.kind === "injury").length, 1);
});

test("'discomfort' is not a disc: a flank note never names the lower back", () => {
  seedWeek();
  repo.addContextEvent({
    kind: "injury",
    title: "Right lateral / oblique discomfort",
    detail: "Unpleasant pain below right lateral following Pallof press.",
    start_date: TUE,
    meta: { area: "right lateral", severity: "mild" },
  });
  const [impact] = repo.getInjuryImpacts(TUE).injuries;
  assert.deepEqual(impact.areas, ["oblique"]);
  assert.equal(
    impact.affected.some((a) => /deadlift|squat|row|pulldown/i.test(a.exercise)),
    false,
    "no hinge, squat, row or pulldown is 'affected' by a flank"
  );
  const env = repo.decideDailySession(TUE).envelope;
  assert.equal(env.muscles.excluded.includes("back"), false, "the back is not gutted by a flank note");
  assert.equal(env.muscles.excluded.includes("quads"), false);
  assert.equal(env.muscles.excluded.includes("hamstrings"), false);
});

test("the 2026-09-29 morning: Pull stays a Pull day, back included, no stale injury", () => {
  seedMorning();
  const read = repo.dayRead(TUE);
  // The stated easy run is in, the Pull is not: on a lifting weekday a run is not the
  // lifting, so the read stays the planned Pull rather than "you've moved, keep it easy".
  assert.equal(read.kind, "train", `${read.kind} / ${read.decision?.rule_code}`);
  assert.equal(read.decision.rule_code, "planned_training");
  assert.equal(read.focus ?? "Back, rear delts & biceps", "Back, rear delts & biceps");
  const sleepFeel = read.signals.signal_state.dimensions.recovery_capacity.evidence.find(
    (item) => item.field === "sleep_feel"
  );
  assert.equal(sleepFeel.voice.key, "sleep_feel_mixed", "a poor night they feel good after is a caveat");

  const { envelope } = repo.decideDailySession(TUE);
  assert.notEqual(envelope.kind, "rest");
  assert.equal(envelope.template.day_number, 2, "the plan day is Pull");
  assert.equal(envelope.muscles.excluded.includes("back"), false);
  assert.equal(
    envelope.hard_constraints.some((c) => c.code === "injury_exclusion"),
    false,
    "a resolved note produces no protective exclusion"
  );
  assert.deepEqual(envelope.protective_exclusions ?? [], []);
  // Push-day saturation is not news about a Pull morning: whatever the envelope says
  // is saturated, it names only groups today's Pull actually trains.
  const saturatedNote = envelope.soft_preferences.find((p) => p.code === "muscle_saturated");
  assert.doesNotMatch(saturatedNote?.detail ?? "", /chest|triceps|shoulders|quads|hamstrings/);

  // One day, one voice, on the reproduced morning itself: the strength line and the
  // week strip's today cell say what the read says (no row cached: the line speaks the
  // floor the Brief would serve).
  const line = todayStrengthLine(TUE);
  assert.equal(line.title, "Pull", "the plan day keeps its NAME");
  const expected = read.kind === "easy" || read.kind === "rest" ? read.kind : null;
  assert.equal(line.suggestion, expected, "the line carries the read's suggestion, or none on a train read");
  const cell = planWeek(TUE).days.find((d) => d.status === "today");
  assert.ok(cell, "a today cell exists");
  assert.equal(cell.plan_day?.name, "Pull");
  assert.equal(cell.suggestion?.kind ?? null, expected, "the strip agrees with the read and the line");
});

test("genuine objective red flags still rest", () => {
  // The morning itself, before anything was trained: a rest read is about the day ahead.
  seedMorning({ withRun: false });
  // A run-down tap (energy 2, no good-energy answer) on a genuinely short night.
  db.prepare(`DELETE FROM checkins`).run();
  repo.addCheckin(TUE, { energy: 2, sleep_feel: 2, soreness: 1 });
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 270)`).run(TUE);
  assert.equal(repo.dayRead(TUE).kind, "rest", "felt low, and last night agrees");

  // A rest-grade readiness reading is its own rule and needs no tap at all.
  db.prepare(`DELETE FROM checkins`).run();
  db.prepare(`DELETE FROM daily_metrics`).run();
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, training_readiness) VALUES (1, ?, 15)`).run(TUE);
  const deep = repo.dayRead(TUE);
  assert.equal(deep.kind, "rest");
  assert.equal(deep.decision.rule_code, "rest_grade_readiness");

  // And the same tap with nothing objective behind it reads lighter, never rest.
  db.prepare(`DELETE FROM garmin_daily_metrics`).run();
  repo.addCheckin(TUE, { energy: 2, sleep_feel: 3, soreness: 1 });
  const light = repo.dayRead(TUE);
  assert.equal(light.kind, "easy");
});

test("one day, one voice: the strength line and the week strip carry the read's suggestion", () => {
  // The read cache only speaks for live dates, so this half runs on today.
  const today = localDaysAgo(0);
  repo.savePlanDay(1, "Pull", "Back, rear delts & biceps", [
    { exercise: "Lat Pulldown", muscle_group: "back", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.setProfile({
    strength_schedule: { days: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow })), source: "athlete", updated_at: today },
  });
  repo.addCheckin(today, { energy: 2, sleep_feel: 3 });
  const read = repo.dayRead(today);
  assert.equal(read.kind, "easy", "a lone run-down tap reads lighter");
  repo.saveDayRead(today, read);
  // A check-in or sync only MARKS the Brief's row stale; the line must still speak.
  repo.invalidateDayRead(today);

  const line = todayStrengthLine(today);
  assert.equal(line.title, "Pull", "the plan day keeps its NAME");
  assert.equal(line.suggestion, read.kind);
  assert.equal(line.suggestion_label, "lighter today");
  assert.ok(line.caveat && line.caveat.includes("Pull"));

  const week = planWeek(today);
  const cell = week.days.find((d) => d.status === "today");
  assert.ok(cell, "a today cell exists");
  assert.equal(cell.plan_day.name, "Pull");
  assert.deepEqual(cell.suggestion, { kind: "easy", label: "lighter today", caveat: line.caveat });
  assert.equal(week.days.filter((d) => d.suggestion).length, 1, "only today's cell carries it");

  // Once the day is logged, the caveat resolves quietly everywhere.
  repo.logSetByName({ date: today, exercise: "Lat Pulldown", weight: 120, reps: 10, day_number: 1 });
  const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(today);
  repo.finishSession(Number(session.id));
  assert.equal(todayStrengthLine(today).caveat, null);
  assert.equal(
    planWeek(today).days.some((d) => d.suggestion),
    false
  );
});
