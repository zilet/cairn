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
  RUNS = [];
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

// Runs are never plan items (migration 110): the week's runs come from the run engine
// (weeklyRunPlan), injected as `opts.runPlan`. runDay() records a run into THIS test's
// engine week, and layout() hands that week to the read — the collision laws below are
// unchanged; only the run SOURCE moved off the stored plan.
let RUNS = [];
const runKind = (label) => (/long/i.test(label) ? "long" : /tempo|interval|quality|threshold/i.test(label) ? "quality" : "easy");
function runDay(dayNumber, label, km) {
  RUNS.push({ day_number: dayNumber, label, kind_label: runKind(label), target_distance_km: km });
}
const runPlanOf = () => (RUNS.length ? { available: true, week_start: REF, runs: [...RUNS] } : null);
const layout = (date, opts = {}) => weekLayoutRead(date, { runPlan: runPlanOf(), ...opts });

// ── the heaviest-lower distinction ──────────────────────────────────────────

test("the heaviest lower day is the loaded compound one, not whichever lower day comes first", () => {
  accessoryLowerDay(2);
  heavyLowerDay(5);
  const read = layout(REF);
  assert.deepEqual(read.heavy_lower_days.sort(), [2, 5], "both days read as lower work");
  assert.deepEqual(read.heaviest_lower_days, [5], "only the barbell day is the week's heaviest");
});

test("an accessory lower day next to the long run is NOT a collision", () => {
  heavyLowerDay(2);
  accessoryLowerDay(5);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, true, `expected clean, got ${JSON.stringify(read.collisions)}`);
  assert.equal(read.suggestion, null);
});

test("calf work never makes a day a leg day at all", () => {
  heavyLowerDay(2);
  repo.savePlanDay(5, "Calves", "Accessory", [
    { exercise: "Standing Calf Raise", sets: 4, rep_low: 10, rep_high: 15, target_weight: 90 },
  ]);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.ok(!read.heavy_lower_days.includes(5), "a calf day is not a lower day");
  assert.equal(read.clean, true);
});

// ── adjacency, both directions ──────────────────────────────────────────────

test("the heaviest lower day the day BEFORE the long run collides", () => {
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, false);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `expected a long-run collision, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [5, 6]);
  assert.match(hit.detail, /before/, "the detail says which side it sits on");
  assert.equal(read.long_run_day, 6);
  assert.equal(read.source, "run_plan");
});

test("the heaviest lower day the day AFTER the long run is the intended stacking, not a collision", () => {
  // The race build's strength hint asks for exactly this ("squats land … the day
  // after the long run"): two hard leg stresses together, then whole recovery. The
  // read must not flag what the hint beside it prescribes.
  heavyLowerDay(7);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, true, JSON.stringify(read.collisions));
  assert.equal(read.suggestion, null);
});

test("a quality run beside the heaviest lower day collides on its own kind", () => {
  heavyLowerDay(3);
  runDay(4, "Tempo run", 10);
  const read = layout(REF);
  assert.equal(read.clean, false);
  assert.equal(read.quality_run_day, 4);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"));
});

// ── three hard days back to back ────────────────────────────────────────────

test("three consecutive hard days read as a stack even when no single pair is adjacent-heavy", () => {
  heavyLowerDay(4);
  accessoryLowerDay(5); // lower, but not the heaviest — so no adjacency collision of its own
  runDay(6, "Long run", 18);
  const read = layout(REF);
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
  // Only days 1-4 are part of this athlete's week at all — days 5-7 are not real slots.
  // Every real day is already spoken for (two lower days, the heaviest lower day on
  // 1-3, and the engine's long run on 4 — runs are never plan days), so the smallest
  // clearing move must come back null rather than reach past the plan's own days for
  // an empty-looking slot.
  accessoryLowerDay(1, "Legs light A");
  accessoryLowerDay(2, "Legs light B");
  heavyLowerDay(3, "Heavy legs");
  runDay(4, "Long run", 18);
  const read = layout(REF);
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
  const read = layout(REF);
  assert.ok(!read.collisions.some((c) => c.kind === "double_day_stack"));
});

// ── the suggestion ──────────────────────────────────────────────────────────

test("the suggested move actually clears the week", () => {
  heavyLowerDay(5);
  upperDay(2);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.ok(read.suggested_move, "a week with room to move gets a concrete move");
  assert.equal(read.suggested_move.from, 5);

  // Apply exactly what it suggested and re-read: the week must come back clean.
  repo.deletePlanDay(read.suggested_move.from);
  heavyLowerDay(read.suggested_move.to);
  const after = layout(REF);
  assert.equal(after.clean, true, `after the suggested move: ${JSON.stringify(after.collisions)}`);
});

test("the suggestion moves the STRENGTH day and never the run", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  const read = layout(REF);
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
  const read = layout(REF);
  assert.equal(read.clean, false);
  assert.equal(read.suggested_move, null, "no slot clears it");
  assert.ok(read.suggestion, "it still says something");
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("the week's rest day is never offered as the slot for a heavy lower day", () => {
  // Rest is a CALENDAR fact (migration 110): a weekday that is neither a lifting
  // weekday nor a stated run weekday. Thursday is that seam here — the athlete lifts
  // Mon/Tue/Wed/Fri and runs Saturday — and it is also the NEAREST weekday to Friday,
  // which is exactly how the clearing search used to land on a rest day.
  upperDay(1);
  upperDay(2, "Pull");
  upperDay(3, "Push 2");
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  const weekdayMap = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
    [5, 5],
  ]);
  const planBefore = JSON.stringify(repo.getPlan());

  const read = layout(REF, { strengthDows: [1, 2, 3, 5], enduranceDows: [6], weekdayMap });
  assert.equal(read.space, "calendar");
  assert.equal(read.clean, false, "the heavy lower day still sits beside the long run");
  assert.ok(read.suggested_move, read.suggestion);
  assert.notEqual(read.suggested_move.to, 4, "a rest day is not a slot");
  assert.equal(/thursday/i.test(String(read.suggestion ?? "")), false, `day 4 named anyway: ${read.suggestion}`);
  assert.equal(JSON.stringify(repo.getPlan()), planBefore, "and the read changed nothing");
});

test("every athlete-facing sentence holds the reading grammar", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  runDay(3, "Tempo run", 10);
  for (let i = 0; i < 14; i++) {
    const read = layout(fwd(i));
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
  for (let i = 0; i < 10; i++) said.add(layout(fwd(i)).suggestion);
  assert.ok(said.size > 1, `a stable week must not print one sentence forever (got ${said.size})`);
  // …and the same morning always reads the same way.
  assert.equal(layout(REF).suggestion, layout(REF).suggestion);
});

test("nothing in the read is a score", () => {
  heavyLowerDay(5);
  runDay(6, "Long run", 18);
  const json = JSON.stringify(layout(REF));
  assert.ok(!/\d{1,3}\s*\/\s*100/.test(json), "no 0-100 grade");
  assert.ok(!/"score"/.test(json), "no bare score field");
});

// ── the week is a RING, not a line ──────────────────────────────────────────
// day_number is a Mon–Sun TEMPLATE that repeats, so day 7 and day 1 are neighbours in
// the athlete's actual life. Reading it as a line hid the 7↔1 collision — and hid it
// permanently, since a repeating template never stops producing it.

test("Sunday's long run into Monday's heavy lower day is read on the ring — and reads as the stack it is", () => {
  // Monday FOLLOWS Sunday on the repeating template: the pair is adjacent every week,
  // never a seam. Legs the morning after the long run is the prescribed stacking, so
  // the ring sees the pair and calls it clean — a linear read would not even have
  // looked. The mirror (legs BEFORE the long run across the seam) collides below.
  heavyLowerDay(1);
  upperDay(3);
  runDay(7, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, true, JSON.stringify(read.collisions));
  assert.equal(read.long_run_day, 7);
});

test("the mirror case reads the other way round: Sunday's legs sit BEFORE Monday's long run", () => {
  heavyLowerDay(7);
  upperDay(3);
  runDay(1, "Long run", 18);
  const read = layout(REF);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `expected a long-run collision, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [1, 7]);
  assert.match(hit.detail, /Sunday'?s? .*sits right before Monday's long run/i, hit.detail);
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("a wrap collision is a quality-run collision too", () => {
  heavyLowerDay(7);
  upperDay(4);
  runDay(1, "Tempo run", 10);
  const read = layout(REF);
  assert.equal(read.quality_run_day, 1);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"));
});

test("the clearing move is judged on the RING — the day after Sunday's long run is Monday, and that is the slot", () => {
  // Saturday's heavy legs sit the day BEFORE Sunday's long run: worked legs into the
  // key run, the one shape this read exists to catch. The only free day in the plan
  // is Monday — on a repeating template the morning after the long run, which is the
  // intended stacking, so it is offered. A linear read would have seen Monday as a
  // random free slot; the ring sees it as the right one.
  upperDay(1);
  heavyLowerDay(6, "Heavy legs");
  runDay(7, "Long run", 18);
  runDay(5, "Tempo run", 10);
  const read = layout(REF);
  assert.equal(read.clean, false);
  assert.equal(read.suggested_move?.from, 6);
  assert.equal(read.suggested_move?.to, 1, "Monday, the day after the long run, clears it");
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

// ── calendar space ──────────────────────────────────────────────────────────

test("with a lifting week mapped, the read judges the CALENDAR, not the template ring", () => {
  // A two-day strength pool cycles across five stated lifting weekdays: Mon Lower,
  // Tue Upper, Wed Lower, Thu Upper, Fri Lower. Saturday carries the long run. On the
  // template ring day 1 (Lower) and day 6 (the run slot) are three apart — clean. On
  // the calendar the athlete lifts heavy legs on FRIDAY, the day before the run.
  heavyLowerDay(1, "Lower");
  upperDay(2, "Upper");
  const weekdayMap = new Map([
    [1, 1],
    [2, 2],
    [3, 1],
    [4, 2],
    [5, 1],
  ]);
  const runPlan = { available: true, runs: [{ day_number: 6, label: "Long run", kind_label: "long", target_distance_km: 16 }] };
  const template = layout(REF, { runPlan });
  assert.equal(template.space, "template");
  assert.equal(template.clean, true, "on the ring nothing is adjacent");

  const calendar = layout(REF, { runPlan, strengthDows: [1, 2, 3, 4, 5], enduranceDows: [6], weekdayMap });
  assert.equal(calendar.space, "calendar");
  assert.equal(calendar.clean, false, JSON.stringify(calendar.collisions));
  const hit = calendar.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, JSON.stringify(calendar.collisions));
  assert.deepEqual(hit.days, [5, 6], "Friday's legs before Saturday's long run");
  assert.match(hit.detail, /Friday's Lower day sits right before Saturday's long run/);
  assert.deepEqual(calendar.heavy_lower_days, [1, 3, 5], "every weekday the ring lands the heavy day on");
  // The move is a weekday too, one of the stated lifting days, never the run's own day
  // and never beside it on the wrong side.
  assert.ok(calendar.suggested_move, calendar.suggestion);
  assert.equal(calendar.suggested_move.from, 5);
  assert.ok([2, 4].includes(calendar.suggested_move.to), `moved to weekday ${calendar.suggested_move.to}`);
  // That weekday already lifts, so the sentence is a SWAP naming both days.
  assert.match(calendar.suggestion, /Friday's Lower day/);
  assert.match(calendar.suggestion, /Upper/);
  assert.match(calendar.suggestion, /Thursday|Tuesday/);
  assert.equal(violatesReadingGrammar(calendar.suggestion), null, calendar.suggestion);
});

test("in calendar space the engine's run slot is already a weekday and is read as-is", () => {
  // Runs are never plan items, so there is no template run day to translate: the
  // engine's slots are weekday-numbered (Mon = 1). The athlete lifts Mon/Tue and runs
  // long on Sunday (dow 0 -> weekday 7). Monday's heavy legs are the morning after —
  // clean; and Saturday is not in this week's map, so nothing invents a Saturday.
  heavyLowerDay(1, "Lower");
  upperDay(2, "Upper");
  runDay(7, "Long run", 16);
  const weekdayMap = new Map([
    [1, 1],
    [2, 2],
  ]);
  const read = layout(REF, { strengthDows: [1, 2], enduranceDows: [0], weekdayMap });
  assert.equal(read.space, "calendar");
  assert.equal(read.source, "run_plan");
  assert.equal(read.long_run_day, 7, "Sunday, as a weekday index");
  assert.deepEqual(read.heavy_lower_days, [1], "the heavy day lands only on the weekday the map gives it");
  assert.equal(read.clean, true, JSON.stringify(read.collisions));
});

test("a hard stretch that straddles Sunday reads as ONE stack, not two short ones", () => {
  // Hard days on 5 (long run), 6, 7 and 1. Scanning 1→7 in a line reported [5,6,7]
  // and a lonely Monday; on the ring it is four hard days without a break.
  heavyLowerDay(3, "Heavy legs");
  accessoryLowerDay(6, "Legs light A");
  accessoryLowerDay(7, "Legs light B");
  accessoryLowerDay(1, "Legs light C");
  runDay(5, "Long run", 18);
  const read = layout(REF);
  const stack = read.collisions.find((c) => c.kind === "double_day_stack");
  assert.ok(stack, `expected a stack, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(stack.days, [5, 6, 7, 1], "the stretch is kept in template order across the seam");
  assert.match(stack.detail, /Friday to Monday are hard days back to back/, stack.detail);
  assert.equal(violatesReadingGrammar(stack.detail), null, stack.detail);
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("REGRESSION: an ordinary mid-week adjacency still flags exactly as it did", () => {
  heavyLowerDay(1);
  upperDay(4);
  runDay(2, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, false);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `expected a long-run collision, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [1, 2]);
  assert.match(hit.detail, /sits right before Tuesday's long run/i, hit.detail);
});

test("a week that is genuinely clear stays clear on the ring", () => {
  // Wednesday's legs, Saturday's long run: neither pair is adjacent either way round.
  heavyLowerDay(3);
  upperDay(1);
  runDay(6, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, true, `expected clean, got ${JSON.stringify(read.collisions)}`);
});

// ── the ring has exactly seven positions ────────────────────────────────────
// `replacePlan` puts no cap on day_number, and the ring arithmetic assumes 1–7. A
// day 8 read on a line looks adjacent to day 7, so the read would invent a collision
// between a day the athlete has and one they don't. Off-ring days are dropped, and
// dropped SILENTLY — this read is a quiet suggestion, not a validator.

test("a plan day outside 1–7 is ignored rather than faking an adjacency", () => {
  heavyLowerDay(8, "Legs (out of range)");
  runDay(7, "Long run", 18);
  const read = layout(REF);
  assert.equal(read.clean, true, `expected clean, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(read.heavy_lower_days, [], "day 8 is not on the ring");
  assert.deepEqual(read.heaviest_lower_days, []);
  assert.equal(read.suggestion, null, "and nothing is said about it");
});

test("an off-ring run day is ignored too, and the real week still reads", () => {
  heavyLowerDay(3);
  const read = layout(REF, {
    runPlan: {
      available: true,
      runs: [
        { day_number: 9, kind_label: "long" },
        { day_number: 6, kind_label: "quality" },
      ],
    },
  });
  assert.equal(read.long_run_day, null, "day 9 is not a long run day");
  assert.equal(read.quality_run_day, 6);
  assert.equal(read.clean, true, `Wednesday's legs are nowhere near Saturday (${JSON.stringify(read.collisions)})`);
});

// ── absence is neutral ──────────────────────────────────────────────────────

test("no plan at all reads clean", () => {
  const read = layout(REF);
  assert.equal(read.clean, true);
  assert.equal(read.source, "none");
  assert.deepEqual(read.collisions, []);
  assert.equal(read.suggestion, null);
});

test("a lifter with no running reads clean however the legs are placed", () => {
  heavyLowerDay(5);
  accessoryLowerDay(6);
  upperDay(7);
  const read = layout(REF);
  assert.equal(read.clean, true);
  assert.equal(read.long_run_day, null);
  assert.equal(read.source, "none");
});

test("a runner with no lifting reads clean", () => {
  runDay(6, "Long run", 18);
  runDay(3, "Tempo run", 10);
  const read = layout(REF);
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
  const read = layout(REF, { runPlan });
  assert.equal(read.source, "run_plan");
  assert.equal(read.clean, false);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_long_run"));
});

test("the engine's run plan outranks the agenda", () => {
  heavyLowerDay(5);
  // The engine's week says Tuesday; today's rolling agenda has drifted to Saturday.
  const read = weekLayoutRead(REF, {
    runPlan: { available: true, runs: [{ day_number: 2, kind_label: "long" }] },
    agenda: { available: true, intents: [{ kind: "long", status: "open", provisional_day_number: 6 }] },
  });
  assert.equal(read.source, "run_plan");
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
  const read = layout(REF, { agenda });
  assert.equal(read.source, "agenda");
  assert.equal(read.long_run_day, 6);
  assert.equal(read.quality_run_day, null, "a completed intent is not a day to plan around");
  assert.equal(read.clean, false);
});

test("a leftover template run item is stripped, so the engine's week is the run source", () => {
  // Live shape: stated Thursday quality, Lower A on Wednesday, and a leftover "Long
  // run" cardio item on the template's Saturday. Read first, that item hid the quality
  // run entirely and the week read clean. A cardio plan item is now stripped at write
  // (migration 110), so it can never outrank the engine again.
  heavyLowerDay(3, "Lower A");
  repo.savePlanDay(6, "Long run", "Endurance", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 16, target_zone: "Z2" },
  ]);
  assert.equal(
    (repo.getPlanDay(6)?.items ?? []).filter((it) => it.kind === "cardio").length,
    0,
    "the cardio item never lands in the plan"
  );
  const runPlan = {
    available: true,
    runs: [
      { day_number: 2, kind_label: "easy" },
      { day_number: 4, kind_label: "quality" },
      { day_number: 7, kind_label: "long" },
    ],
  };
  const read = layout(REF, { runPlan, enduranceDows: [0, 2, 4] });
  assert.equal(read.source, "run_plan");
  assert.equal(read.quality_run_day, 4);
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_quality");
  assert.ok(hit, JSON.stringify(read.collisions));
  assert.deepEqual(hit.days, [3, 4]);

  // No stated run days: there is no stored-plan source to fall back to any more.
  const unstated = layout(REF, { runPlan });
  assert.equal(unstated.source, "run_plan");
  assert.equal(unstated.quality_run_day, 4);
});

test("a second compound lower day the day before the long run collides even when it isn't the heaviest", () => {
  heavyLowerDay(3, "Lower A");
  repo.savePlanDay(5, "Lower B", "Lower", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
  ]);
  runDay(6, "Long run", 16);
  const read = layout(REF);
  assert.deepEqual(read.heaviest_lower_days, [3], "Lower A is still the week's heaviest");
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, JSON.stringify(read.collisions));
  assert.deepEqual(hit.days, [5, 6]);
  assert.match(hit.detail, /Lower B/);
});

// ── the two halves of the composition, run end to end ───────────────────────
// The run engine and this read judge the same week on the same ring. That does NOT
// mean the read can never flag a live plan — it means the engine never hands it a
// collision it could have avoided. So: on a week with a clean slot the engine's own
// placement reads clean, and on one without, the read still says the true thing.

function seedRunner({ weeks = 8, perWeek = 3, km = 10 } = {}) {
  const before = (n) => new Date(new Date(`${REF}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < weeks; wk++)
    for (const off of [1, 3, 5].slice(0, perWeek))
      repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date: before(wk * 7 + off) });
}

test("the run engine never hands this read a collision it could have placed around", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner();
  heavyLowerDay(1, "Heavy legs"); // Monday
  accessoryLowerDay(6); // Saturday — still a leg day to the placement rule
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.equal(long.day_number, 4, "Thursday is the slot with air on both sides");
  const read = layout(REF, { runPlan: plan });
  assert.equal(read.source, "run_plan");
  assert.ok(
    !read.collisions.some((c) => c.kind === "heavy_lower_adjacent_long_run"),
    `the engine's own long run must not be flagged: ${JSON.stringify(read.collisions)}`
  );
  // The QUALITY slot now takes the same ring pass, and this week still cannot give it
  // a clean day. Ring-clear of Monday's and Saturday's legs leaves only {3, 4}, and
  // both sit within a day of the long run on 4 — so the tiers degrade and quality
  // lands on 2, beside Monday. The collision is REAL and the read is right to say so.
  // What the two halves agree on is which weeks are separable, not that a collision
  // can never be reported; the engine does not get to talk the read out of this one.
  assert.ok(
    read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"),
    `an unseparable week is still reported as one: ${JSON.stringify(read.collisions)}`
  );
});

test("the quality run never lands ON a heavy leg day — the ring pass looks past mid-week", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner();
  heavyLowerDay(2, "Heavy legs"); // Tuesday — the quality run's own default slot
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  // The old fallback dropped the leg days entirely rather than degrading, so slot 2
  // passed "not the day AFTER a leg day" and the hard run was prescribed onto the
  // squat day itself. Thursday is clear on both sides and two days off the long run.
  assert.equal(quality.day_number, 4, `the quality run must not sit on Tuesday's legs (got ${quality.day_number})`);
  const read = layout(REF, { runPlan: plan });
  assert.ok(
    !read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"),
    `a week this open must read clean: ${JSON.stringify(read.collisions)}`
  );
});

test("a mid-week leg day sends the quality run to Monday rather than the day before the legs", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner();
  heavyLowerDay(3, "Heavy legs"); // Wednesday — 2 and 4 both touch it on the ring
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.equal(long.day_number, 6, "Saturday is clear on both sides here");
  // Mid-week has nothing clean left: 2 and 4 flank Wednesday, 5 is beside the long run.
  // Monday is ring-clear and a full two days off Saturday — a slot the old candidate
  // list [2,3,4,5] could not reach at all, which is why this week used to collide.
  assert.equal(quality.day_number, 1, `Monday is the ring-clean slot (got ${quality.day_number})`);
  const read = layout(REF, { runPlan: plan });
  assert.ok(
    !read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"),
    `the engine placed around this one: ${JSON.stringify(read.collisions)}`
  );
});

// The contract as a PROPERTY, over every lower-day layout there is. A single hand-built
// week can only ever show that one case works; what the engine actually promises is that
// it never places the quality run ON a leg day while some legal day without one sits
// free. The first ring pass held that mid-week and quietly broke it everywhere else —
// once the ring-clean level missed, days 1 and 7 were unreachable and the ladder fell
// through to "a leg day is fine", 55 layouts deep, every one flagged by this very read.
test("the quality run never takes a leg day while a legal free day exists — all 128 layouts", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner();
  const ring = (a, b) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  const failures = [];
  for (let mask = 0; mask < 128; mask += 1) {
    const lower = new Set();
    for (let i = 0; i < 7; i += 1) if (mask & (1 << i)) lower.add(i + 1);
    db.exec("DELETE FROM plan_items; DELETE FROM plan_days;");
    for (let day = 1; day <= 7; day += 1) (lower.has(day) ? heavyLowerDay : upperDay)(day);

    const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
    const quality = plan.runs.find((r) => r.kind_label === "quality");
    const long = plan.runs.find((r) => r.kind_label === "long");
    if (!quality || !long) continue;
    const where = `lower={${[...lower]}} quality=${quality.day_number} long=${long.day_number}`;

    if (ring(quality.day_number, long.day_number) < 2) failures.push(`${where}: the two hard days stack`);
    if (lower.has(quality.day_number)) {
      // "Legal" is the engine's own hard rule: a day at least two off the long run.
      const free = [1, 2, 3, 4, 5, 6, 7].filter((s) => ring(s, long.day_number) >= 2 && !lower.has(s));
      if (free.length) failures.push(`${where}: on a leg day with ${free} free`);
    }
  }
  assert.deepEqual(failures, [], `every layout must place around what it can:\n${failures.join("\n")}`);
});

test("on a week that genuinely cannot be separated, the read still tells the truth", () => {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
  seedRunner();
  heavyLowerDay(1, "Heavy legs"); // Monday
  accessoryLowerDay(5); // Friday
  accessoryLowerDay(6); // Saturday
  const plan = repo.weeklyRunPlan(REF, { block: { week_index: 1 } });
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.equal(long.day_number, 7, "no ring-clean slot exists, so the old fallback stands");
  const read = layout(REF, { runPlan: plan });
  // Sunday's long run into Monday's legs is the intended stacking, not a collision —
  // but Friday, Saturday, Sunday, Monday are four hard days in a row, and THAT is the
  // truth this week still has to hear.
  assert.equal(read.clean, false);
  const stack = read.collisions.find((c) => c.kind === "double_day_stack");
  assert.ok(stack, `the Friday-to-Monday stack is real and must be reported: ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(stack.days, [5, 6, 7, 1]);
  assert.ok(!violatesReadingGrammar(read.suggestion), read.suggestion);
});

// ── the quiet surface ───────────────────────────────────────────────────────

test("a colliding week says its one line through adaptations_due", () => {
  // Runs come from the athlete's stated run days and the engine, never plan items:
  // a stated Saturday long run (dow 6) with Friday's heavy legs the day before.
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 6, kind: "long" },
      ],
    },
  });
  seedRunner();
  heavyLowerDay(5);
  upperDay(2);
  const runPlan = repo.weeklyRunPlan(REF);
  assert.equal(runPlan.runs.find((r) => r.kind_label === "long")?.day_number, 6, "the stated Saturday long run");
  const read = weekLayoutRead(REF, { runPlan, enduranceDows: [2, 6] });
  assert.equal(read.clean, false, JSON.stringify(read.collisions));
  const state = repo.getProgramState(REF);
  assert.ok(
    state.adaptations_due.includes(read.suggestion),
    `expected the layout line in adaptations_due:\n${JSON.stringify(state.adaptations_due, null, 2)}`
  );
  assert.equal(
    state.adaptations_due.filter((line) => line === read.suggestion).length,
    1,
    "at most one line, never a repeated one"
  );
});

test("a clean week adds nothing to adaptations_due", () => {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: { days: [{ dow: 6, kind: "long" }] },
  });
  seedRunner();
  heavyLowerDay(2);
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
  const read = layout(REF);
  assert.deepEqual(read.heaviest_lower_days, [5], "compound sets rank the week when nothing is loaded");
  assert.equal(read.clean, false);
});

test("a cardio item written into the plan is not a run: with no run plan or agenda the week reads clean", () => {
  heavyLowerDay(5);
  repo.savePlanDay(6, "Long run", "Endurance", [
    { kind: "cardio", exercise: "Long run", target_distance_km: 18, target_zone: "Z2" },
  ]);
  const cardioRows = db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n;
  assert.equal(cardioRows, 0, "the writer strips it");
  const read = weekLayoutRead(REF);
  assert.equal(read.source, "none");
  assert.equal(read.clean, true, "with no run anywhere there is nothing to stack against");
});
