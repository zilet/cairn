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

test("the week's rest day is never offered as the slot for a heavy lower day", () => {
  // Day 4 is the seam the athlete wrote into their own week (v99). It carries no
  // items, so by muscle groups alone it is indistinguishable from a thin training
  // day — and it is also the NEAREST free slot to day 5, which is exactly how the
  // clearing search used to land on it.
  upperDay(1);
  upperDay(2, "Pull");
  upperDay(3, "Push 2");
  repo.savePlanDay(4, "Rest", null, [], { day_type: "rest" });
  heavyLowerDay(5);
  runDay(6, "Long run", 18);

  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false, "the heavy lower day still sits beside the long run");
  assert.notEqual(read.suggested_move?.to, 4, "a rest day is not a slot");
  assert.equal(/thursday/i.test(String(read.suggestion ?? "")), false, `day 4 named anyway: ${read.suggestion}`);
  assert.equal(repo.getPlanDay(4).day_type, "rest", "and the read changed nothing");
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

// ── the week is a RING, not a line ──────────────────────────────────────────
// day_number is a Mon–Sun TEMPLATE that repeats, so day 7 and day 1 are neighbours in
// the athlete's actual life. Reading it as a line hid the 7↔1 collision — and hid it
// permanently, since a repeating template never stops producing it.

// The same adjacency the read uses, restated here so the assertions below can't drift
// with the implementation.
const ringAdjacent = (a, b) => Math.abs(a - b) === 1 || Math.abs(a - b) === 6;

test("Sunday's long run and Monday's heavy lower day collide — the template repeats", () => {
  heavyLowerDay(1);
  upperDay(3);
  runDay(7, "Long run", 18);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false, "the Sunday/Monday seam is not a gap in the week");
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `expected a long-run collision, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [1, 7]);
  // Monday FOLLOWS Sunday on the ring. The sentence must not claim the reverse.
  assert.match(hit.detail, /Monday'?s? .*sits right after Sunday's long run/i, hit.detail);
  assert.doesNotMatch(hit.detail, /before Sunday/i, hit.detail);
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
  assert.ok(read.suggested_move, "there is a free day in this week to clear it");
  assert.equal(read.suggested_move.from, 1);
  assert.ok(
    !ringAdjacent(read.suggested_move.to, 7),
    `moved the lift to day ${read.suggested_move.to}, still beside Sunday's long run on the ring`
  );
});

test("the mirror case reads the other way round: Sunday's legs sit BEFORE Monday's long run", () => {
  heavyLowerDay(7);
  upperDay(3);
  runDay(1, "Long run", 18);
  const read = weekLayoutRead(REF);
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
  const read = weekLayoutRead(REF);
  assert.equal(read.quality_run_day, 1);
  assert.ok(read.collisions.some((c) => c.kind === "heavy_lower_adjacent_quality"));
});

test("the clearing move is judged on the RING — it never lands beside the run across the seam", () => {
  // Saturday's heavy legs collide with Sunday's long run, and Friday's tempo boxes
  // them in. The only free day in the plan is Monday — which on a repeating template
  // is the day right AFTER Sunday's long run. A linear read called that a clean slot;
  // it is the same collision moved one day round the ring, so nothing is proposed.
  upperDay(1);
  heavyLowerDay(6, "Heavy legs");
  runDay(7, "Long run", 18);
  runDay(5, "Tempo run", 10);
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, false);
  assert.equal(read.suggested_move, null, "Monday is not a clean slot for a Saturday leg day here");
  assert.ok(read.suggestion, "it still says something");
  assert.equal(violatesReadingGrammar(read.suggestion), null, read.suggestion);
});

test("a hard stretch that straddles Sunday reads as ONE stack, not two short ones", () => {
  // Hard days on 5 (long run), 6, 7 and 1. Scanning 1→7 in a line reported [5,6,7]
  // and a lonely Monday; on the ring it is four hard days without a break.
  heavyLowerDay(3, "Heavy legs");
  accessoryLowerDay(6, "Legs light A");
  accessoryLowerDay(7, "Legs light B");
  accessoryLowerDay(1, "Legs light C");
  runDay(5, "Long run", 18);
  const read = weekLayoutRead(REF);
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
  const read = weekLayoutRead(REF);
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
  const read = weekLayoutRead(REF);
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
  const read = weekLayoutRead(REF);
  assert.equal(read.clean, true, `expected clean, got ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(read.heavy_lower_days, [], "day 8 is not on the ring");
  assert.deepEqual(read.heaviest_lower_days, []);
  assert.equal(read.suggestion, null, "and nothing is said about it");
});

test("an off-ring run day is ignored too, and the real week still reads", () => {
  heavyLowerDay(3);
  const read = weekLayoutRead(REF, {
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
  const read = weekLayoutRead(REF, { runPlan: plan });
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
  const read = weekLayoutRead(REF, { runPlan: plan });
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
  const read = weekLayoutRead(REF, { runPlan: plan });
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
  const read = weekLayoutRead(REF, { runPlan: plan });
  const hit = read.collisions.find((c) => c.kind === "heavy_lower_adjacent_long_run");
  assert.ok(hit, `the Sunday/Monday pair is real and must be reported: ${JSON.stringify(read.collisions)}`);
  assert.deepEqual(hit.days, [1, 7]);
  assert.ok(!violatesReadingGrammar(read.suggestion), read.suggestion);
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
