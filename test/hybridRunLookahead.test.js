// M1 — hybrid protect_run_next follows the flexible agenda's movable key runs,
// not the fixed weekly-template day_number projection alone.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, repo, resetTables } from "./_seed.js";

const TUESDAY = "2026-04-21";
const WEDNESDAY = "2026-04-22";
const THURSDAY = "2026-04-23";

function run(day_number, kind, km = 6) {
  return {
    day_number,
    label: kind === "quality" ? "Tempo run" : kind === "long" ? "Long run" : "Easy run",
    kind_label: kind,
    target_distance_km: km,
    target_duration_min: null,
    target_zone: kind === "quality" ? "Z3" : "Z2",
    note: null,
    day_name: `${kind} run`,
    focus: "Endurance",
    interval: null,
  };
}

function plan(runs) {
  return {
    available: true,
    week_start: "2026-04-20",
    runs,
    rationale: [],
    quality_focus: runs.some((item) => item.kind_label === "quality") ? "Tempo run" : null,
    mix_summary: "flexible test week",
    why: "A movable test week.",
  };
}

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "exercises",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "day_reads",
    "profile"
  );
}

function logLowerBody(date) {
  for (let set_number = 1; set_number <= 3; set_number++) {
    repo.logSetByName({
      exercise: "Back Squat",
      date,
      set_number,
      weight: 200,
      reps: 5,
      rir: 2,
    });
  }
  db.prepare(`UPDATE exercises SET muscle_group = 'quads' WHERE name = 'Back Squat'`).run();
}

beforeEach(resetAll);

test("training-read.ts must not import flexible-training-agenda (cycle ban)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/repo/training-read.ts"), "utf8");
  assert.doesNotMatch(src, /flexible-training-agenda/);
  assert.doesNotMatch(src, /hybrid-run-lookahead/);
  assert.doesNotMatch(src, /flexibleTrainingAgenda/);
});

test("withFlexibleRunLookahead shifts planned_run_next when agenda moves quality after lower-body load", () => {
  // Template: single plan day with a quality run → hybridDayContext projects it tomorrow.
  repo.setWeeklyRuns([{ day_number: 1, label: "Tempo run", target_distance_km: 8, target_zone: "Z3" }]);
  const base = repo.hybridDayContext(TUESDAY);
  assert.ok(base.planned_run_next, "template projects a next run");
  assert.equal(base.planned_run_next.date, WEDNESDAY, "template places quality tomorrow");
  assert.equal(base.planned_run_next.kind, "quality");

  // Flexible agenda: lower-body today blocks today+tomorrow for key runs → quality on Thursday.
  logLowerBody(TUESDAY);
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, {
    runPlan: plan([run(2, "quality", 8), run(6, "long", 12)]),
  });
  const quality = agenda.intents.find((intent) => intent.kind === "quality");
  assert.equal(quality.suggested_date, THURSDAY, "agenda moves quality past the lower-body conflict");

  const overridden = repo.withFlexibleRunLookahead(base, TUESDAY, {
    runPlan: plan([run(2, "quality", 8), run(6, "long", 12)]),
  });
  assert.equal(overridden.planned_run_next.date, THURSDAY, "override follows agenda, not template tomorrow");
  assert.equal(overridden.planned_run_next.kind, "quality");
  assert.equal(overridden.planned_run_next.km, 8);

  // protect_run_next semantics: tomorrow is Wednesday — not the agenda's key day.
  assert.notEqual(overridden.planned_run_next.date, WEDNESDAY);
});

test("withFlexibleRunLookahead keeps protect-shaped quality when agenda suggests it tomorrow", () => {
  repo.setWeeklyRuns([{ day_number: 1, label: "Easy run", target_distance_km: 5, target_zone: "Z2" }]);
  const base = repo.hybridDayContext(TUESDAY);
  // Template may show easy tomorrow; agenda has open quality suggested for Wednesday.
  const overridden = repo.withFlexibleRunLookahead(base, TUESDAY, {
    runPlan: plan([run(3, "quality", 7)]),
  });
  assert.ok(overridden.planned_run_next);
  assert.equal(overridden.planned_run_next.date, WEDNESDAY);
  assert.equal(overridden.planned_run_next.kind, "quality");
  assert.equal(overridden.planned_run_next.km, 7);
});

test("withFlexibleRunLookahead keeps template fields when agenda is unavailable", () => {
  repo.setWeeklyRuns([{ day_number: 1, label: "Long run", target_distance_km: 15, target_zone: "Z2" }]);
  const base = repo.hybridDayContext(TUESDAY);
  assert.ok(base.planned_run_next);
  assert.equal(base.planned_run_next.kind, "long");
  assert.equal(base.planned_run_next.date, WEDNESDAY);

  const overridden = repo.withFlexibleRunLookahead(base, TUESDAY, { runPlan: null });
  assert.deepEqual(overridden.planned_run_next, base.planned_run_next);
  assert.equal(overridden.hard_cardio_yesterday, base.hard_cardio_yesterday);
  assert.equal(overridden.cardio_today, base.cardio_today);
  assert.equal(overridden.heavy_lower_next, base.heavy_lower_next);
});

test("withFlexibleRunLookahead clears template work when the available agenda has completed every key intention", () => {
  const qualityActivity = repo.addActivity({ type: "run", date: "2026-04-20", duration_min: 45, distance_km: 8 });
  const source = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'lookahead-quality')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, 'lookahead-quality-run', ?, '2026-04-20', 'running', 'TEMPO', 3.2)`
  ).run(source.lastInsertRowid, qualityActivity.id);
  repo.addActivity({ type: "run", date: TUESDAY, duration_min: 80, distance_km: 12 });
  const runPlan = plan([run(1, "quality", 8), run(2, "long", 12)]);
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, { runPlan });
  assert.ok(agenda.intents.every((intent) => intent.status === "completed"));

  const base = { ...repo.hybridDayContext(TUESDAY), planned_run_next: { date: WEDNESDAY, kind: "quality", km: 8 } };
  assert.equal(repo.withFlexibleRunLookahead(base, TUESDAY, { runPlan }).planned_run_next, null);
});

test("withFlexibleRunLookahead clears template key work when only easy running remains", () => {
  const qualityActivity = repo.addActivity({ type: "run", date: TUESDAY, duration_min: 45, distance_km: 8 });
  const source = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'lookahead-easy-only')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, 'lookahead-easy-only-run', ?, ?, 'running', 'TEMPO', 3.2)`
  ).run(source.lastInsertRowid, qualityActivity.id, TUESDAY);
  const runPlan = plan([run(2, "quality", 8), run(5, "easy", 6)]);
  const agenda = repo.flexibleTrainingAgenda(TUESDAY, { runPlan });
  assert.equal(agenda.intents.find((intent) => intent.kind === "quality").status, "completed");
  assert.equal(agenda.intents.find((intent) => intent.kind === "easy").status, "open");

  const base = { ...repo.hybridDayContext(TUESDAY), planned_run_next: { date: WEDNESDAY, kind: "quality", km: 8 } };
  assert.equal(repo.withFlexibleRunLookahead(base, TUESDAY, { runPlan }).planned_run_next, null);
});

test("withFlexibleRunLookahead clears template work when a key intention is deliberately undated", () => {
  const saturday = "2026-04-25";
  const runPlan = plan([run(2, "quality", 8)]);
  logLowerBody(saturday);
  const agenda = repo.flexibleTrainingAgenda(saturday, { runPlan });
  assert.ok(agenda.intents.some((intent) => intent.status === "open" && !intent.suggested_date));
  assert.ok(
    !agenda.intents.some((intent) => intent.status === "open" && intent.suggested_date),
    "the available agenda has no dated key opening to surface"
  );

  const base = { ...repo.hybridDayContext(saturday), planned_run_next: { date: "2026-04-26", kind: "quality", km: 8 } };
  assert.equal(repo.withFlexibleRunLookahead(base, saturday, { runPlan }).planned_run_next, null);
});

test("withFlexibleRunLookahead still surfaces a dated key run when a different key intention is undated", () => {
  const saturday = "2026-04-25";
  const runPlan = plan([run(2, "quality", 8), run(6, "long", 12)]);
  const agenda = repo.flexibleTrainingAgenda(saturday, { runPlan });
  assert.ok(agenda.intents.some((intent) => intent.status === "open" && !intent.suggested_date));
  const dated = agenda.intents.find((intent) => intent.status === "open" && intent.suggested_date);
  assert.ok(dated, "a separate key intention still has a clean dated opening");

  const base = { ...repo.hybridDayContext(saturday), planned_run_next: { date: "2026-04-26", kind: "quality", km: 8 } };
  assert.deepEqual(repo.withFlexibleRunLookahead(base, saturday, { runPlan }).planned_run_next, {
    date: dated.suggested_date,
    kind: dated.kind,
    km: dated.target_distance_km,
  });
});
