import { test } from "node:test";
import assert from "node:assert/strict";
import { CoachReadToolExecutionError, executeCoachReadTool } from "../dist/brain/read-tool-runtime.js";
import { COACH_READ_TOOL_CATALOG } from "../dist/brain/read-tools.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { db } from "../dist/db.js";

function seedReadFixture() {
  const exercise = Number(
    db
      .prepare(
        `INSERT INTO exercises (name, muscle_group, unit, mode) VALUES ('Barbell Bench Press', 'chest', 'lb', 'reps')`
      )
      .run().lastInsertRowid
  );
  const planDay = Number(
    db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (1, 'Push', 'Chest and shoulders')`).run()
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note)
     VALUES (?, 1, ?, 3, 6, 8, 120, 'Coach note: preserve a smooth pain-free rep.')`
  ).run(planDay, exercise);
  const session = Number(
    db
      .prepare(
        `INSERT INTO sessions (date, plan_day_id, duration_min, notes, soreness, performance, joint_pain, finished_at)
     VALUES ('2026-07-01', ?, 48, 'Good controlled session', 2, 4, NULL, datetime('now'))`
      )
      .run(planDay).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, note)
     VALUES (?, ?, 1, 115, 8, 2, 'Clean'), (?, ?, 2, 120, 6, 1, 'Still smooth')`
  ).run(session, exercise, session, exercise);
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, rpe, notes, source)
     VALUES ('2026-07-03', 'run', 30, 5.2, 6, 'Easy aerobic run', 'manual')`
  ).run();

  db.prepare(
    `INSERT INTO daily_metrics (source, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories)
     VALUES ('apple', '2026-07-08', 9200, 455, 84, 54, 61, 510)`
  ).run();
  db.prepare(
    `INSERT INTO food_notes (date, meal, parsed_json, raw_output, image_path)
     VALUES ('2026-07-08', 'lunch', ?, 'private meal prose', '/private/photo.jpg')`
  ).run(JSON.stringify({ summary: "Chicken salad", kcal: 635, protein_g: 65, carbs_g: 42, fat_g: 22, fiber_g: 11 }));
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, source, note) VALUES ('2026-07-01', 2400, 175, 'checkin', 'Small recovery adjustment')`
  ).run();
  db.prepare(
    `INSERT INTO bodyweight_log (date, weight_lb, note) VALUES ('2026-07-01', 181, 'Morning'), ('2026-07-08', 180, 'Morning')`
  ).run();
  db.prepare(
    `INSERT INTO body_measurements (date, waist_in, hip_in, neck_in, source, note)
     VALUES ('2026-07-08', 34.5, 39, 15.2, 'manual', 'Monthly tape')`
  ).run();

  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, original_name, file_path, parsed_json, summary, enrichment_status)
     VALUES ('bloodwork', '2026-06-15', 'secret-lab.pdf', '/private/secret-lab.pdf', ?, 'Iron stores are being watched.', 'done')`
  ).run(
    JSON.stringify({
      markers: [{ name: "Ferritin", value: 28, unit: "ng/mL", flag: "low" }],
      clinical_facts: [{ kind: "medication", name: "Example medication", status: "active" }],
      secret: "must not escape",
    })
  );
  db.prepare(
    `INSERT INTO health_documents (kind, doc_date, original_name, file_path, parsed_json, summary, enrichment_status)
     VALUES ('dexa', '2026-06-20', 'secret-dexa.pdf', '/private/secret-dexa.pdf', ?, 'Body composition anchor.', 'done')`
  ).run(
    JSON.stringify({
      markers: [
        { name: "Body Fat %", value: 21.2, unit: "%" },
        { name: "Lean Mass (Total)", value: 132, unit: "lb" },
      ],
    })
  );
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive_key, directive, rationale, status)
     VALUES ('markers', 'watch', 'Ferritin', 'ferritin-recheck', 'Recheck after a meaningful interval.', 'Confirm direction.', 'active')`
  ).run();
  db.prepare(
    `INSERT INTO supplements (name, dose, frequency, category, related_markers, active)
     VALUES ('Iron', 'clinician guided', 'daily', 'mineral', '["Ferritin"]', 1)`
  ).run();
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date, meta_json)
     VALUES ('trip', 'Work trip', 'Long flight and shifted meals', '2026-07-06', '2026-07-10', '{"location":"Boston"}')`
  ).run();

  db.prepare(
    `INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status)
     VALUES ('2026-07-06', 'stub', 'private model transcript', ?, 'accepted')`
  ).run(
    JSON.stringify({
      daily_kcal: 2400,
      daily_protein_g: 175,
      days: [
        {
          day: "Wednesday",
          note: "Training day",
          meals: [
            {
              name: "Chicken salad",
              items: "Chicken, greens, avocado",
              kcal: 635,
              protein_g: 65,
              recipe: { steps: ["private detail"] },
            },
          ],
        },
      ],
    })
  );

  const recorded = recordDecision(
    {
      effective_date: "2026-07-01",
      kind: "training_target",
      domain: "training",
      summary: "Hold bench load while technique settles.",
      rationale: "Keep quality high before progressing.",
      source: "program_evolution",
      source_ref_type: "suggestion",
      source_ref_key: "bench-press",
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: { recent_sessions: 3 },
      action: { target_weight: 120 },
      specialist: null,
      applied_at: "2026-07-01T12:00:00.000Z",
      reverted_at: null,
      superseded_by: null,
      evaluator_version: "training-capacity-v1",
    },
    [
      {
        metric_key: "exercise_est_1rm_trend",
        subject_key: "bench-press",
        direction: "increase",
        baseline: { value: 145 },
        target: { min: 147 },
        window_start: "2026-07-01",
        window_end: "2026-07-31",
        minimum_data: { exposures: 2 },
        confounder_policy: "require_exposure",
        confidence: "tentative",
        evaluator: "exercise_est_1rm",
        evaluator_version: "training-capacity-v1",
      },
    ]
  );
  insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict: "aligned",
    actual: { value: 148 },
    evidence_keys: ["logged_sets:bench-press"],
    confounders: [],
    explanation: "Capacity moved within the expected window.",
    evaluator_version: "training-capacity-v1",
  });
}

const requests = [
  {
    tool: "read_exercise_history",
    args: { exercise: "Barbell Bench Press", start_date: null, end_date: null, limit: 20 },
  },
  { tool: "read_training_window", args: { end_date: "2026-07-09", weeks: 2 } },
  { tool: "read_marker_history", args: { marker: "Ferritin", limit: 20 } },
  { tool: "read_recovery_window", args: { end_date: "2026-07-09", days: 7 } },
  { tool: "read_nutrition_window", args: { end_date: "2026-07-09", days: 7 } },
  { tool: "read_body_composition_history", args: { limit: 20 } },
  { tool: "read_life_context_window", args: { start_date: "2026-07-01", end_date: "2026-07-15" } },
  { tool: "read_decision_history", args: { kind: "training_target", subject_key: "bench-press", limit: 10 } },
  { tool: "read_current_plan_detail", args: { scope: "training", day_number: 1 } },
];

test("the closed coach-read runtime executes every catalog operation within its safety envelope", () => {
  seedReadFixture();
  const results = requests.map((request) =>
    executeCoachReadTool(request, { run_id: "run-depth-1", op: "case_conference", today: "2026-07-09" })
  );
  const meal = executeCoachReadTool(
    { tool: "read_current_plan_detail", args: { scope: "meal", day: "Wednesday" } },
    { run_id: "run-depth-1", op: "case_conference", today: "2026-07-09" }
  );

  assert.deepEqual(
    results.map((result) => result.tool),
    requests.map((request) => request.tool)
  );
  assert.equal(results[0].data.exercise.name, "Barbell Bench Press");
  assert.equal(results[1].data.events.length, 2);
  assert.equal(results[2].data.marker.name, "Ferritin");
  assert.equal(results[3].data.days[0].hrv_ms, 61);
  assert.equal(results[4].data.days[0].kcal, 635);
  assert.ok(results[5].data.events.some((event) => event.type === "dexa"));
  assert.equal(results[6].data.events[0].title, "Work trip");
  assert.equal(results[7].data.decisions[0].expectations[0].latest_evaluation.verdict, "aligned");
  assert.equal(results[8].data.day.items[0].target_weight, 120);
  assert.equal(meal.data.day.meals[0].name, "Chicken salad");
  assert.equal(meal.data.day.meals[0].recipe, undefined, "recipe internals are not part of the bounded slice");

  for (const result of [...results, meal]) {
    const serialized = JSON.stringify(result);
    const catalog = COACH_READ_TOOL_CATALOG[result.tool];
    assert.ok(Buffer.byteLength(serialized) <= catalog.max_response_bytes);
    assert.ok(result.rows_returned <= catalog.max_rows);
    assert.doesNotMatch(
      serialized,
      /file_path|raw_output|raw_json|parsed_json|image_path|private model transcript|private\/secret/
    );
  }

  const telemetry = db.prepare(`SELECT * FROM brain_tool_calls WHERE run_id = 'run-depth-1' ORDER BY id`).all();
  assert.equal(telemetry.length, requests.length + 1);
  assert.ok(telemetry.every((row) => ["ok", "truncated"].includes(row.status)));
  assert.ok(
    telemetry.every(
      (row) => !String(row.args_summary).includes("Ferritin") && !String(row.args_summary).includes("Barbell")
    )
  );
});

test("the runtime rejects out-of-catalog and out-of-bounds requests without executing them", () => {
  assert.throws(
    () => executeCoachReadTool({ tool: "delete_everything", args: {} }, { run_id: "run-bad", op: "coach_read" }),
    (error) => error instanceof CoachReadToolExecutionError && error.code === "invalid_request"
  );
  assert.throws(
    () =>
      executeCoachReadTool(
        { tool: "read_recovery_window", args: { end_date: null, days: 91 } },
        { run_id: "run-bad", op: "coach_read" }
      ),
    (error) => error instanceof CoachReadToolExecutionError && error.code === "invalid_request"
  );
  const telemetry = db
    .prepare(`SELECT tool, status FROM brain_tool_calls WHERE run_id = 'run-bad' ORDER BY id`)
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(telemetry, [
    { tool: "delete_everything", status: "invalid_request" },
    { tool: "read_recovery_window", status: "invalid_request" },
  ]);
});

test("the response byte budget trims rows rather than leaking an oversized result", () => {
  const exercise = Number(
    db.prepare(`INSERT INTO exercises (name, mode) VALUES ('Long Note Lift', 'reps')`).run().lastInsertRowid
  );
  const session = Number(
    db.prepare(`INSERT INTO sessions (date, finished_at) VALUES ('2026-07-09', datetime('now'))`).run().lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, note) VALUES (?, ?, ?, 100, 8, ?)`
  );
  for (let index = 1; index <= 200; index++) insert.run(session, exercise, index, `note-${index}-${"x".repeat(900)}`);

  const result = executeCoachReadTool(
    {
      tool: "read_exercise_history",
      args: { exercise: "Long Note Lift", start_date: null, end_date: null, limit: 200 },
    },
    { run_id: "run-byte-cap", today: "2026-07-09" }
  );
  assert.equal(result.truncated, true);
  assert.ok(result.rows_returned < 200);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= COACH_READ_TOOL_CATALOG.read_exercise_history.max_response_bytes
  );
  assert.equal(
    db.prepare(`SELECT status FROM brain_tool_calls WHERE run_id = 'run-byte-cap'`).get().status,
    "truncated"
  );
});
