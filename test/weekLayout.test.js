// THE WEEK-LAYOUT READ (src/domain/training/week-layout.ts) — does the lifting week
// compose with the running week? These lock the half of the composition the strength
// side never had: the heaviest lower day is identified by the work it actually carries
// (not by "has legs in it"), a collision is only ever reported against THAT day, the
// suggestion names a move that genuinely clears the week, absence reads clean in every
// direction, and every athlete-facing sentence holds the reading grammar and rotates.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { weekLayoutRead } from "../dist/domain/training/week-layout.js";

const REF = "2026-04-20"; // a Monday
const fwd = (n) => new Date(new Date(`${REF}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

function reset() {
  resetTables("logged_sets", "sessions", "activities", "plan_items", "plan_days", "app_state", "profile");
}
beforeEach(reset);

// The week's genuinely heaviest lower day: barbell squat + hinge, loaded.
function heavyLowerDay(dayNumber, name = "Lower") {
  repo.savePlanDay(dayNumber, name, "Lower", [
    { exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
}

// A lower day only by muscle group — isolation work, light. lowerBodyPlanDayNumbers()
// counts this as "lower"; the ranking must not let it read as the week's big day.
function accessoryLowerDay(dayNumber, name = "Legs accessory") {
  repo.savePlanDay(dayNumber, name, "Accessory", [
    { exercise: "Leg Curl", sets: 3, rep_low: 12, rep_high: 15, target_weight: 40 },
  ]);
}

function upperDay(dayNumber, name = "Push") {
  repo.savePlanDay(dayNumber, name, "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8, target_weight: 155 },
  ]);
}

// A run lands as a cardio plan item whose label rides in `note` (see savePlanDay).
function runDay(dayNumber, label, km) {
  const existing = repo.getPlanDay(dayNumber);
  const strength = (existing?.items ?? [])
    .filter((it) => it.kind !== "cardio")
    .map((it) => ({
      exercise: it.exercise,
      sets: it.sets,
      rep_low: it.rep_low,
      rep_high: it.rep_high,
      target_weight: it.target_weight,
    }));
  repo.savePlanDay(dayNumber, existing?.name ?? label, existing?.focus ?? "Endurance", [
    ...strength,
    { kind: "cardio", exercise: label, target_distance_km: km, target_zone: "Z2" },
  ]);
}

// ── the heaviest-lower distinction ──────────────────────────────────────────

test("the heaviest lower day is the loaded compound one, not whichever lower day comes first", () => {
  accessoryLowerDay(2);
  heavyLowerDay(5);
  const read = weekLayoutRead(REF);
  assert.deepEqual(read.heavy_lower_days.sort(), [2, 5], "both days read as lower work");
  assert.deepEqual(read.heaviest_lower_days, [5], "only the barbell day is the week's heaviest");
});

test("an accessory lower day next to the long run is NOT a collision", () => {
  heavyLowerDay(2);
  accessoryLowerDay(5);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true, `expected clean, got ${JSON.stringify(read.collisions)}`);
  assert.equal(read.suggestion, null);
});

test("calf work never makes a day a leg day at all", () => {
  heavyLowerDay(2);
  repo.savePlanDay(5, "Calves", "Accessory", [
    { exercise: "Standing Calf Raise", sets: 4, rep_low: 10, rep_high: 15, target_weight: 90 },
  ]);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.ok(!read.heavy_lower_days.includes(5), "a calf day is not a lower day");
  assert.equal(read.clean, true);
});

// ── adjacency, both directions ──────────────────────────────────────────────

test("the heaviest lower day the day BEFORE the long run collides", () => {
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `expected a long-run collision, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [5, 6]);
  assert.match(hit.detail, /before/, "the detail says which side it sits on");
  assert.equal(read.long_run_day, 6);
  assert.equal(read.source, "plan");
});

test("the heaviest lower day the day AFTER the long run collides too", () => {
  heavyLowerDay(7);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit);
  assert.deepEqual(hit.days, [6, 7]);
  assert.match(hit.detail, /after/);
});

test("a quality run beside the heaviest lower day collides on its own kind", () => {
  heavyLowerDay(3);
  runDay(4, "Tempo run", 10);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  assert.equal(read.quality_run_day, 4);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"));
});

// ── three hard days back to back ────────────────────────────────────────────

test("three consecutive hard days read as a stack even when no single pair is adjacent-heavy", () => {
  heavyLowerDay(4);
  accessoryLowerDay(5); // lower, but not the heaviest — so no adjacency collision of its own
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  const stack = read.collisions.find((c) => c.kind === "double_day_stack");
  assert.ok(stack, `expected a stack, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(stack.days, [4, 5, 6]);
  assert.ok(
    !read.collisions.some((c) => c.kind !== "double_day_stack"),
    "the accessory day beside the run is still not an adjacency collision"
  );
});

test("a 4-day plan never suggests moving a lift onto a day the plan doesn't have", () => {
  // Only day_numbers 1-4 exist in this plan at all — days 5-7 are not real slots for
  // this athlete. Every real day is already spoken for (two lower days, the heaviest
  // lower day, and the long run), so the smallest clearing move must come back null
  // rather than reach past the plan's own days for an empty-looking slot.
  accessoryLowerDay(1, "Legs light A");
  accessoryLowerDay(2, "Legs light B");
  heavyLowerDay(3, "Heavy legs");
  runDay(4, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  if (read.suggested_move) {
    assert.ok(
      [1, 2, 3, 4].includes(read.suggested_move.to),
      `suggested day ${read.suggested_move.to} does not exist in this 4-day plan`
    );
  }
  assert.equal(read.suggested_move, null, "no real day in this 4-day plan clears the collision");
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("two hard days back to back are not a stack", () => {
  accessoryLowerDay(5);
  heavyLowerDay(2);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.ok(!read.collisions.some((c) => c.kind === "double_day_stack"));
});

// ── the suggestion ──────────────────────────────────────────────────────────

test("the suggested move actually clears the week", () => {
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.ok(read.suggested_move, "a week with room to move gets a concrete move");
  assert.equal(read.suggested_move.from, 5);

  // Apply exactly what it suggested and re-read: the week must come back clean.
  repo.deletePlanDay(read.suggested_move.from);
  heavyLowerDay(read.suggested_move.to);
  const after = weekLayoutRead(REF);
  assert.equal(after.clean, true, `after the suggested move: ${JSON.stringify(after.collisions)}`);
});

test("the suggestion moves the STRENGTH day and never the run", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.notEqual(read.suggested_move?.to, read.long_run_day, "never proposes the run's own day");
  assert.notEqual(read.suggested_move?.from, read.long_run_day, "the day being moved is the lifting day");
  assert.ok(!/move (the |your )?(long |quality )?run/i.test(read.suggestion), read.suggestion);
});

test("a week with nowhere clean to move says so instead of inventing a slot", () => {
  // Lower work on five of seven days plus both runs: every candidate slot is taken.
  for (const dn of [1, 2, 3, 4, 5]) accessoryLowerDay(dn, `Legs ${dn}`);
  heavyLowerDay(5, "Heavy legs");
  runDay(6, "Long run", 18);
  runDay(7, "Tempo run", 10);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  assert.equal(read.suggested_move, null, "no slot clears it");
  assert.ok(read.suggestion, "it still says something");
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("every athlete-facing sentence holds the reading grammar", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  runDay(3, "Tempo run", 10);
  for (let i = 0; i < 14; i++) {
    const read = weekLayoutRead(fwd(i));
    assert.equal(read.clean, false);
    assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
    for (const c of read.collisions) assert.equal(violatesReadingGrammar(c.detail), null, c.detail);
  }
});

test("the suggestion is a variant set, not one literal printed every morning", () => {
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const said = new Set();
  for (let i = 0; i < 10; i++) said.add(weekLayoutRead(fwd(i)).suggestion);
  assert.ok(said.size > 1, `a stable week must not print one sentence forever (got ${said.size})`);
  // …and the same morning always reads the same way.
  assert.equal(weekLayoutRead(REF).suggestion, weekLayoutRead(REF).suggestion);
});

test("nothing in the read is a score", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  const json = JSON.stringify(weekLayoutRead(REF));
  assert.ok(!/\d{1,3}\s*\/\s*100/.test(json), "no 0-100 grade");
  assert.ok(!/"score"/.test(json), "no bare score field");
});

// ── absence is neutral ──────────────────────────────────────────────────────

test("no plan at all reads clean", () => {
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true);
  assert.equal(read.source, "none");
  assert.deepEqual(read.collisions, []);
  assert.equal(read.suggestion, null);
});

test("a lifter with no running reads clean however the legs are placed", () => {
  heavyLowerDay(5);
  accessoryLowerDay(6);
  upperDay(7);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true);
  assert.equal(read.long_run_day, null);
  assert.equal(read.source, "none");
});

test("a runner with no lifting reads clean", () => {
  runDay(6, "Long run", 18);
  runDay(3, "Tempo run", 10);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true);
  assert.deepEqual(read.heavy_lower_days, []);
});

// ── the run placement fallbacks ─────────────────────────────────────────────

test("with no runs in the plan, an injected run plan is what the week is composed against", () => {
  heavyLowerDay(5);
  const runPlan = {
    available: true,
    runs: [
      { day_number: 6, kind_label: "long" },
      { day_number: 2, kind_label: "quality" },
    ],
  };
  const read = weekLayoutRead(REF, { runPlan });
  assert.equal(read.source, "run_plan");
  assert.equal(read.clean, false);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_long_run"));
});

test("the stored plan outranks an injected run plan", () => {
  heavyLowerDay(5);
  runDay(2, "Long run", 18); // the plan says Tuesday; the live builder says Saturday
  const read = weekLayoutRead(REF, { runPlan: { available: true, runs: [{ day_number: 6, kind_label: "long" }] } });
  assert.equal(read.source, "plan");
  assert.equal(read.long_run_day, 2);
  assert.equal(read.clean, true, "Tuesday's long run is nowhere near Friday's legs");
});

test("the flexible agenda is the last resort, and completed intents don't count", () => {
  heavyLowerDay(5);
  const agenda = {
    available: true,
    intents: [
      { kind: "long", status: "open", provisional_day_number: 6 },
      { kind: "quality", status: "completed", provisional_day_number: 4 },
    ],
  };
  const read = weekLayoutRead(REF, { agenda });
  assert.equal(read.source, "agenda");
  assert.equal(read.long_run_day, 6);
  assert.equal(read.quality_run_day, null, "a completed intent is not a day to plan around");
  assert.equal(read.clean, false);
});

// ── the quiet surface ───────────────────────────────────────────────────────

test("a colliding week says its one line through adaptations_due", () => {
  repo.setProfile({ primary_discipline: "hybrid" });
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const layout = weekLayoutRead(REF);
  const state = repo.getProgramState(REF);
  assert.ok(
    state.adaptations_due.includes(layout.suggestion),
    `expected the layout line in adaptations_due:\n${JSON.stringify(state.adaptations_due, null, 2)}`
  );
  assert.equal(
    state.adaptations_due.filter((line) => line === layout.suggestion).length,
    1,
    "at most one line, never a repeated one"
  );
});

test("a clean week adds nothing to adaptations_due", () => {
  repo.setProfile({ primary_discipline: "hybrid" });
  heavyLowerDay(2);
  runDay(6, "Long run", 18);
  const state = repo.getProgramState(REF);
  for (const line of state.adaptations_due) {
    assert.ok(!/runway|unstacks|hard days run/i.test(line), `no layout line on a clean week: ${line}`);
  }
});

test("the read survives a plan whose loads were never filled in", () => {
  repo.savePlanDay(5, "Lower", "Lower", [
    { exercise: "Back Squat", sets: 5, rep_low: 3, rep_high: 5 },
    { exercise: "Walking Lunge", sets: 3, rep_low: 10, rep_high: 12 },
  ]);
  repo.savePlanDay(2, "Legs light", "Accessory", [{ exercise: "Leg Curl", sets: 3, rep_low: 12, rep_high: 15 }]);
  runDay(6, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.deepEqual(read.heaviest_lower_days, [5], "compound sets rank the week when nothing is loaded");
  assert.equal(read.clean, false);
});

test("the read is not thrown off by a plan with no plan_days table rows for a run day", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  db.prepare(`DELETE FROM plan_items WHERE kind = 'cardio'`).run();
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true, "with the run gone there is nothing to stack against");
});
