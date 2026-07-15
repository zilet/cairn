import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as repo from "../dist/repo.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { registerPlanExerciseTools } from "../dist/surfaces/mcp/plan-exercises.js";

const cleanWeek = () => [
  {
    day_number: 1,
    name: "Push",
    items: [
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
      { exercise: "Barbell Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 60 },
    ],
  },
  {
    day_number: 2,
    name: "Pull",
    items: [
      { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 80 },
      { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 90 },
    ],
  },
  {
    day_number: 3,
    name: "Legs",
    items: [
      { exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
      { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 115 },
      { exercise: "Plank", mode: "timed", sets: 3, target_seconds: 30 },
    ],
  },
];

function callPlanRoute(path, body, params = {}) {
  const layer = planExercisesRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.put);
  assert.ok(layer, `missing PUT ${path}`);
  let status = 200;
  let payload;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  layer.route.stack.at(-1).handle({ body, params }, res);
  return { status, payload };
}

function planMcpHandlers() {
  const handlers = new Map();
  registerPlanExerciseTools({
    tool(name, ...args) {
      handlers.set(name, args.at(-1));
    },
  });
  return handlers;
}

test("plan compiler rejects canonical duplicates, same-angle presses, malformed prescriptions, and timed/load mixtures", () => {
  const report = repo.validateTrainingPlan([
    {
      day_number: 1,
      items: [
        { exercise: "Dead Hang", mode: "timed", sets: 3, target_seconds: 30 },
        { exercise: "Dead Hang Timed", mode: "timed", sets: 3, target_seconds: 30 },
        { exercise: "Incline DB Press", sets: 0, rep_low: 12, rep_high: 8 },
        { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10 },
        { exercise: "Plank", mode: "timed", sets: 3, target_seconds: 30, target_weight: 20, rep_low: 8 },
      ],
    },
  ]);
  const codes = new Set(report.errors.map((entry) => entry.code));
  assert.equal(report.ok, false);
  assert.ok(codes.has("canonical_duplicate"));
  assert.ok(codes.has("duplicate_press_angle"));
  assert.ok(codes.has("invalid_sets"));
  assert.ok(codes.has("reversed_rep_range"));
  assert.ok(codes.has("timed_load_incoherence"));
});

test("an explicit reps mode is not silently reclassified by target_seconds", () => {
  const report = repo.validateTrainingPlan([
    {
      day_number: 1,
      items: [{ exercise: "Plank", mode: "reps", sets: 3, rep_low: 8, rep_high: 12, target_seconds: 30 }],
    },
  ]);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => entry.code === "reps_timed_incoherence"));
  assert.ok(!report.errors.some((entry) => entry.code === "invalid_timed_target"));
});

test("only an omitted day number defaults; explicit malformed values are rejected", () => {
  assert.equal(
    repo.validateTrainingPlan([{ items: [] }]).errors.some((entry) => entry.code === "invalid_day_number"),
    false
  );
  for (const day_number of ["tomorrow", Number.NaN, 0, 15, 1.5]) {
    const report = repo.validateTrainingPlan([{ day_number, items: [] }]);
    assert.equal(report.ok, false, `expected ${String(day_number)} to be rejected`);
    assert.ok(report.errors.some((entry) => entry.code === "invalid_day_number"));
  }
});

test("checked day and restructure surfaces compile against the authoritative stored exercise mode", async () => {
  repo.upsertExercise({ name: "Quality Timer", muscle_group: "core", mode: "timed" });
  const badItems = [{ exercise: "Quality Timer", sets: 3, rep_low: 8, rep_high: 12, target_weight: 20 }];
  const qualityFailure = (error) =>
    error?.name === "PlanQualityError" && error.report.errors.some((entry) => entry.code === "timed_load_incoherence");

  assert.throws(() => repo.savePlanDayChecked(12, "Timer", "core", badItems), qualityFailure);
  assert.throws(() => repo.replacePlanChecked([{ day_number: 12, name: "Timer", items: badItems }]), qualityFailure);

  const restDay = callPlanRoute("/plan/:day", { name: "Timer", focus: "core", items: badItems }, { day: "12" });
  assert.equal(restDay.status, 400);
  assert.ok(restDay.payload.quality.errors.some((entry) => entry.code === "timed_load_incoherence"));
  const restPlan = callPlanRoute("/plan", { days: [{ day_number: 12, name: "Timer", items: badItems }] });
  assert.equal(restPlan.status, 400);
  assert.ok(restPlan.payload.quality.errors.some((entry) => entry.code === "timed_load_incoherence"));

  const handlers = planMcpHandlers();
  await assert.rejects(
    () => handlers.get("save_plan_day")({ day_number: 12, name: "Timer", focus: "core", items: badItems }),
    qualityFailure
  );
  await assert.rejects(
    () => handlers.get("set_plan")({ days: [{ day_number: 12, name: "Timer", items: badItems }] }),
    qualityFailure
  );
  assert.equal(repo.getPlanDay(12), null, "every rejected surface leaves SQLite unchanged");
});

test("checked direct, REST, and MCP writes persist an inferred timed mode instead of validating timed then storing reps", async () => {
  const direct = repo.savePlanDayChecked(10, "Direct timer", "core", [
    { exercise: "Direct Quality Timer", sets: 3, target_seconds: 35 },
  ]);
  assert.equal(direct.day.items[0].mode, "timed");
  assert.equal(repo.findExercise("Direct Quality Timer").mode, "timed");

  const rest = callPlanRoute(
    "/plan/:day",
    { name: "REST timer", focus: "core", items: [{ exercise: "REST Quality Timer", sets: 2, target_seconds: 40 }] },
    { day: "11" }
  );
  assert.equal(rest.status, 200);
  assert.equal(rest.payload.items[0].mode, "timed");
  assert.equal(repo.findExercise("REST Quality Timer").mode, "timed");

  const handlers = planMcpHandlers();
  const response = await handlers.get("save_plan_day")({
    day_number: 12,
    name: "MCP timer",
    focus: "grip",
    items: [{ exercise: "MCP Quality Timer", sets: 2, target_seconds: 45 }],
  });
  const saved = JSON.parse(response.content[0].text);
  assert.equal(saved.items[0].mode, "timed");
  assert.equal(repo.findExercise("MCP Quality Timer").mode, "timed");
});

test("quality gaps and density are warnings rather than invented clinical gates", () => {
  const days = [1, 2, 3].map((day_number) => ({
    day_number,
    items: [
      { exercise: `Cable Curl ${day_number}`, sets: 12, rep_low: 8, rep_high: 12 },
      { exercise: `Rope Pushdown ${day_number}`, sets: 12, rep_low: 8, rep_high: 12 },
    ],
  }));
  const report = repo.validateTrainingPlan(days);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((entry) => entry.code === "movement_pattern_gap"));
  assert.ok(report.warnings.some((entry) => entry.code === "muscle_density_high"));
});

test("bounded proposal validation is atomic when a change leaves a touched day incoherent", () => {
  repo.replacePlan(cleanWeek());
  const proposal = repo.createProposal("test", "bad duplicate", "", {
    summary: "incoherent timed prescription",
    changes: [{ day_number: 1, exercise: "Plank", mode: "timed", sets: 2, target_seconds: 30, target_weight: 20 }],
  });
  const result = repo.applyProposal(proposal.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /structural quality check/i);
  assert.deepEqual(
    repo.getPlanDay(1).items.map((item) => item.exercise),
    ["Barbell Bench Press", "Barbell Overhead Press"]
  );
  assert.equal(repo.getProposal(proposal.id).status, "draft");
});

test("full restructures fail before mutation, while a deliberate manual override is explicit", () => {
  repo.replacePlan(cleanWeek());
  const invalid = [
    {
      day_number: 1,
      name: "Push",
      items: [
        { exercise: "Incline DB Press", sets: 3, rep_low: 8, rep_high: 10 },
        { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10 },
      ],
    },
  ];
  const proposal = repo.createProposal("test", "bad restructure", "", { summary: "bad", days: invalid });
  assert.throws(() => repo.applyProposal(proposal.id), /Plan quality check failed/i);
  assert.equal(repo.getPlan().length, 3);

  assert.throws(
    () => repo.replacePlanChecked(invalid),
    (error) => error.name === "PlanQualityError" && error.report.ok === false
  );
  const manual = repo.replacePlanChecked(invalid, { quality_override: true });
  assert.equal(manual.ok, true);
  assert.equal(manual.quality_override, true);
  assert.equal(manual.quality.ok, false);
});

test("direct target updates compile before mutation and REST/MCP share the guarded path", () => {
  repo.replacePlan(cleanWeek());
  const before = repo.getPlanDay(1).items.find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(before.mode, "reps");
  assert.equal(before.target_seconds, null);

  assert.throws(
    () => repo.updateTarget(1, "Barbell Bench Press", undefined, 30),
    (error) =>
      error.name === "PlanQualityError" && error.report.errors.some((entry) => entry.code === "reps_timed_incoherence")
  );
  const stored = repo.getPlanDay(1).items.find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(stored.target_seconds, null, "the invalid candidate never reached SQLite");

  const route = readFileSync(new URL("../src/routes/plan-exercises.ts", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../src/surfaces/mcp/plan-exercises.ts", import.meta.url), "utf8");
  assert.match(route, /updateTarget\([\s\S]*quality_override/);
  assert.match(mcp, /updateTarget\([\s\S]*quality_override/);

  const override = repo.updateTarget(1, "Barbell Bench Press", undefined, 30, { quality_override: true });
  assert.equal(override.quality_override, true, "manual override remains explicit and visible");
  assert.equal(repo.getPlanDay(1).items.find((item) => item.exercise === "Barbell Bench Press").target_seconds, 30);
});
