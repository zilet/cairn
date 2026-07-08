import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo, resetTables } from "./_seed.js";
import { buildDayReadPrompt } from "../dist/prompt.js";
import {
  COACH_CONTEXT_ARRAY_KEYS,
  COACH_CONTEXT_REQUIRED_KEYS,
  isCoachContextEnvelope,
} from "../dist/brain/coach-context-contract.js";
import {
  activeBrainSnapshotStats,
  runWithBrainSnapshot,
} from "../dist/brain/snapshot.js";

function reset() {
  resetTables(
    "logged_sets",
    "session_skips",
    "plan_items",
    "plan_days",
    "sessions",
    "exercises",
    "food_notes",
    "memory",
    "context_events",
    "health_documents",
    "health_directives",
    "insights",
    "bodyweight_log",
    "daily_metrics",
    "activities",
    "garmin_activities",
    "program_blocks",
    "plan_proposals",
    "suggestions",
  );
}

function logSet(name, date, { weight = 100, reps = 8, rir = 2, setNum = 1 } = {}) {
  const ex = repo.findExercise(name) ?? repo.upsertExercise({ name });
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir);
}

beforeEach(reset);

test("getCoachContext returns the stable prompt envelope", () => {
  const ctx = repo.getCoachContext();
  for (const key of [
    "now",
    "goal_mode",
    "day_intake",
    "memory",
    "learnings",
    "context_events",
    "coaching_focus",
    "program_state",
    "performance",
    "day_read",
    "context_today",
    "next_step",
  ]) {
    assert.ok(Object.hasOwn(ctx, key), `missing coach context key: ${key}`);
  }
  assert.equal(typeof ctx.now, "object");
  assert.ok(Array.isArray(ctx.memory));
  assert.ok(Array.isArray(ctx.learnings));
  assert.ok(Array.isArray(ctx.context_events));
  assert.ok(Array.isArray(ctx.day_intake.entries));
  assert.ok(Array.isArray(ctx.program_state.lifts));
  assert.ok(Array.isArray(ctx.program_adjustments));
  assert.ok(Array.isArray(ctx.progression));
});

test("coach context contract recognizes the current prompt envelope", () => {
  const ctx = repo.getCoachContext();
  assert.equal(isCoachContextEnvelope(ctx), true);
  assert.ok(COACH_CONTEXT_REQUIRED_KEYS.includes("coaching_focus"));
  assert.ok(COACH_CONTEXT_REQUIRED_KEYS.includes("recovery"));
  for (const key of COACH_CONTEXT_REQUIRED_KEYS) {
    assert.ok(Object.hasOwn(ctx, key), `required coach-context key missing from envelope: ${key}`);
  }
  for (const key of COACH_CONTEXT_ARRAY_KEYS) {
    assert.ok(Array.isArray(ctx[key]), `coach-context array contract failed for ${key}`);
  }
});

test("request-scoped brain snapshot reuses coach-context signal computations", () => {
  const stats = runWithBrainSnapshot(() => {
    const first = repo.getCoachContext();
    const second = repo.getCoachContext();
    assert.equal(isCoachContextEnvelope(first), true);
    assert.equal(isCoachContextEnvelope(second), true);
    assert.deepEqual(second.day_read, first.day_read);
    return activeBrainSnapshotStats();
  });

  assert.equal(stats.active, true);
  for (const key of [
    "today",
    "profile",
    "garmin:coach:14",
    "recovery:14",
    "recent_sessions:20",
    "program_state",
    "coaching_focus",
    "body_metrics",
  ]) {
    assert.equal(stats.computes[key], 1, `${key} should compute once in the request scope`);
  }
  const dayReadKeys = Object.keys(stats.computes).filter((key) => key.startsWith("day_read:"));
  assert.equal(dayReadKeys.length, 1, "expected one date-scoped day-read signal");
  assert.equal(stats.computes[dayReadKeys[0]], 1, "day-read should compute once in the request scope");
});

test("coach context prompt arrays stay bounded", () => {
  for (let i = 0; i < 55; i++) {
    db.prepare(`INSERT INTO memory (kind, content, source, confidence) VALUES (?, ?, ?, ?)`)
      .run("observation", `Unique coach-context memory ${i} about topic ${i * 17}`, "test", 1);
  }
  for (let i = 0; i < 20; i++) {
    repo.addFoodNote("meal", "", { summary: `Food item ${i}`, kcal: 100 + i, protein_g: 10 });
  }

  const items = [];
  for (let i = 0; i < 18; i++) {
    const name = `Context Lift ${i}`;
    repo.upsertExercise({ name, muscle_group: i % 2 ? "back" : "chest" });
    items.push({ exercise: name, sets: 2, rep_low: 6, rep_high: 8, target_weight: 100 + i });
    logSet(name, localDaysAgo(14), { weight: 95 + i, reps: 8, setNum: 1 });
    logSet(name, localDaysAgo(7), { weight: 100 + i, reps: 8, setNum: 1 });
  }
  repo.savePlanDay(1, "Context Day", "Full body", items);

  const ctx = repo.getCoachContext();
  assert.ok(ctx.memory.length <= 40, `memory cap exceeded: ${ctx.memory.length}`);
  assert.ok(ctx.day_intake.entries.length <= 12, `day intake cap exceeded: ${ctx.day_intake.entries.length}`);
  assert.ok(ctx.program_state.lifts.length <= 14, `program-state lift cap exceeded: ${ctx.program_state.lifts.length}`);
  assert.ok(ctx.program_adjustments.length <= 6, `adjustments cap exceeded: ${ctx.program_adjustments.length}`);
  assert.ok(ctx.progression.length <= 12, `progression cap exceeded: ${ctx.progression.length}`);
  assert.ok(ctx.insights.length <= 5, `insights cap exceeded: ${ctx.insights.length}`);
});

test("coach context memory excludes superseded rows", () => {
  const old = repo.addMemory("Prefers heavy evening training", "preference", "test");
  repo.supersedeMemory(old.id, {
    content: "Now prefers short morning sessions",
    kind: "preference",
    reason: "schedule changed",
  });

  const ctx = repo.getCoachContext();
  const text = ctx.memory.map((m) => m.content).join("\n");
  assert.doesNotMatch(text, /Prefers heavy evening training/);
  assert.match(text, /Now prefers short morning sessions/);
});

test("coach context memory and learnings expose typed DTO fields", () => {
  repo.addMemory("Prefers morning protein before training", "preference", "test");
  repo.addMemory("Rest-day reads can be conservative for you", "learning", "outcome-learning");

  const ctx = repo.getCoachContext();
  const memory = ctx.memory.find((row) => row.content.includes("morning protein"));
  assert.ok(memory, "expected memory row in coach context");
  assert.equal(typeof memory.id, "number");
  assert.equal(typeof memory.content, "string");
  assert.equal(memory.kind, "preference");

  const learning = ctx.learnings.find((row) => row.content.includes("Rest-day reads"));
  assert.ok(learning, "expected learning row in coach context");
  assert.equal(learning.kind, "learning");
  assert.equal(typeof learning.id, "number");
  assert.equal(typeof learning.content, "string");
});

test("coach context carries bounded clinical facts from non-marker health records", () => {
  repo.addHealthDocument({
    kind: "other",
    doc_date: "2026-07-07",
    summary: "PCP visit note with follow-up labs.",
    parsed_json: {
      markers: [],
      clinical_facts: [
        {
          kind: "encounter",
          date: "2026-07-07",
          name: "Primary care follow-up",
          status: "completed",
          detail: "Reviewed elevated LDL, elevated Lp(a), and repeat labs.",
          source: "Assessment/Plan",
        },
        {
          kind: "other",
          date: "2026-07-07",
          name: "LIPID PANEL",
          status: "ordered",
          detail: "Future lab order.",
          source: "Assessment/Plan",
        },
      ],
    },
    enrichment_status: "done",
  });

  const ctx = repo.getCoachContext();
  assert.equal(ctx.health[0].summary, "PCP visit note with follow-up labs.");
  assert.equal(ctx.health[0].markers.length, 0);
  assert.ok(Array.isArray(ctx.health[0].clinical_facts));
  assert.deepEqual(ctx.health[0].clinical_facts.map((f) => f.name), [
    "Primary care follow-up",
    "LIPID PANEL",
  ]);
});

test("coach context does not leak conductor ranking internals", () => {
  const ctx = repo.getCoachContext();
  const conductor = JSON.stringify(ctx.coaching_focus);
  assert.doesNotMatch(conductor, /"score"/i);
  assert.doesNotMatch(conductor, /"priority"/i);
  assert.doesNotMatch(conductor, /leverage/i);
});

test("day-read prompt leads with conductor context before domain evidence", () => {
  const prompt = buildDayReadPrompt({
    now: { date: localDaysAgo(0), weekday: "Monday", time: "07:30", part_of_day: "morning" },
    recent_sessions: [],
    coaching_focus: {
      available: true,
      lead: { title: "Build the aerobic base", why: "running is the lead lever", move: "Keep today easy." },
      parallel: [],
      later: [],
      connections: ["easy aerobic work supports recovery"],
      retest: null,
    },
    day_intake: {
      date: localDaysAgo(0),
      count: 1,
      totals: { kcal: 400, protein_g: 40 },
      target: null,
      remaining: null,
      entries: [{ id: 1, meal: "breakfast", summary: "Greek yogurt bowl", kcal: 400, protein_g: 40 }],
    },
    program_state: { headline: "Program is steady", lifts: [], volume: [], adaptations_due: [] },
    program_adjustments: [{ title: "Add a little core", why: "core is due" }],
    memory: [],
    learnings: [],
    context_events: [],
  });

  const conductorAt = prompt.indexOf("THIS BLOCK'S ONE FOCUS");
  const programAt = prompt.indexOf("PROGRAM STATE");
  const fuelAt = prompt.indexOf("TODAY'S FUEL");
  assert.ok(conductorAt > -1, "conductor line is present");
  assert.ok(programAt > conductorAt, "program evidence follows the conductor");
  assert.ok(fuelAt > conductorAt, "fuel evidence follows the conductor");
});
