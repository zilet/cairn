// program-blocks — deterministic periodization model tests.
// Covers: create→getActive, advanceBlockWeek transitions (deload on last week,
// auto-complete past total_weeks), clamping/validation, blockForCoach shape.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetTables } from "./_seed.js";
import * as blocks from "../dist/repo/program-blocks.js";

beforeEach(() => {
  resetTables("program_blocks");
});

// ---- basic create + read ----

test("createBlock stores a block and getActiveBlock returns it", () => {
  const b = blocks.createBlock({ goal: "Build squat + base", focus: "strength", total_weeks: 5 });
  assert.equal(b.goal, "Build squat + base");
  assert.equal(b.focus, "strength");
  assert.equal(b.total_weeks, 5);
  assert.equal(b.week_index, 1);
  assert.equal(b.status, "active");

  const active = blocks.getActiveBlock();
  assert.ok(active, "getActiveBlock returns the block");
  assert.equal(active.id, b.id);
});

test("getActiveBlock returns null when no block is active", () => {
  assert.equal(blocks.getActiveBlock(), null);
});

test("listBlocks returns created blocks newest-first", () => {
  blocks.createBlock({ goal: "First", total_weeks: 4 });
  blocks.createBlock({ goal: "Second", total_weeks: 6 });
  const list = blocks.listBlocks();
  assert.equal(list.length, 2);
  assert.equal(list[0].goal, "Second", "newest first");
  assert.equal(list[1].goal, "First");
});

// ---- phase defaults ----

test("createBlock assigns accumulation phase for week 1 of a multi-week block", () => {
  const b = blocks.createBlock({ total_weeks: 6, week_index: 1 });
  assert.equal(b.phase, "accumulation");
});

test("createBlock accepts an explicit phase override", () => {
  const b = blocks.createBlock({ phase: "intensification", total_weeks: 4, week_index: 3 });
  assert.equal(b.phase, "intensification");
});

// ---- advanceBlockWeek transitions ----

test("advanceBlockWeek increments week_index and updates phase deterministically", () => {
  // 6-week block: weeks 1-3 = accumulation, 4-5 = intensification, 6 = deload
  const b = blocks.createBlock({ total_weeks: 6, week_index: 1 });
  assert.equal(b.phase, "accumulation");

  // → week 2 (still accumulation: 2 <= ceil(6/2)=3)
  const w2 = blocks.advanceBlockWeek(b.id);
  assert.equal(w2.week_index, 2);
  assert.equal(w2.phase, "accumulation");
  assert.equal(w2.status, "active");

  // → week 3 (accumulation: 3 = ceil(6/2))
  const w3 = blocks.advanceBlockWeek(b.id);
  assert.equal(w3.week_index, 3);
  assert.equal(w3.phase, "accumulation");

  // → week 4 (intensification: 4 > ceil(6/2)=3 and 4 < 6)
  const w4 = blocks.advanceBlockWeek(b.id);
  assert.equal(w4.week_index, 4);
  assert.equal(w4.phase, "intensification");

  // → week 5 (intensification)
  const w5 = blocks.advanceBlockWeek(b.id);
  assert.equal(w5.week_index, 5);
  assert.equal(w5.phase, "intensification");

  // → week 6: last week → deload, still active
  const w6 = blocks.advanceBlockWeek(b.id);
  assert.equal(w6.week_index, 6);
  assert.equal(w6.phase, "deload");
  assert.equal(w6.status, "active", "at total_weeks it's still active (deload week)");
});

test("advanceBlockWeek auto-completes when week exceeds total_weeks", () => {
  const b = blocks.createBlock({ total_weeks: 3, week_index: 3 });
  // Next advance: week 4 > 3 → completed
  const done = blocks.advanceBlockWeek(b.id);
  assert.equal(done.week_index, 4, "records the overshoot week");
  assert.equal(done.status, "completed");
  assert.equal(blocks.getActiveBlock(), null, "no active block after completion");
});

test("advanceBlockWeek on active block with no explicit id uses the active block", () => {
  const b = blocks.createBlock({ total_weeks: 4, week_index: 1 });
  const advanced = blocks.advanceBlockWeek(); // no id → active block
  assert.equal(advanced.id, b.id);
  assert.equal(advanced.week_index, 2);
});

test("advanceBlockWeek on a non-active block is a no-op", () => {
  const b = blocks.createBlock({ total_weeks: 4, week_index: 1 });
  blocks.completeBlock(b.id);
  const before = blocks.listBlocks()[0];
  const after = blocks.advanceBlockWeek(b.id);
  assert.equal(after.week_index, before.week_index, "week unchanged on a completed block");
  assert.equal(after.status, "completed");
});

test("advanceBlockWeek returns null when block id does not exist", () => {
  assert.equal(blocks.advanceBlockWeek(999999), null);
});

// ---- completeBlock / abandonBlock ----

test("completeBlock flips status to completed", () => {
  const b = blocks.createBlock({ total_weeks: 6 });
  const c = blocks.completeBlock(b.id);
  assert.equal(c.status, "completed");
  assert.equal(blocks.getActiveBlock(), null);
});

test("abandonBlock flips status to abandoned", () => {
  const b = blocks.createBlock({ total_weeks: 6 });
  const a = blocks.abandonBlock(b.id);
  assert.equal(a.status, "abandoned");
  assert.equal(blocks.getActiveBlock(), null);
});

// ---- updateBlock ----

test("updateBlock changes only the specified fields", () => {
  const b = blocks.createBlock({ goal: "Original", focus: "strength", total_weeks: 4 });
  const u = blocks.updateBlock(b.id, { goal: "Updated goal", focus: "hypertrophy" });
  assert.equal(u.goal, "Updated goal");
  assert.equal(u.focus, "hypertrophy");
  assert.equal(u.total_weeks, 4, "total_weeks unchanged");
  assert.equal(u.status, "active", "status unchanged");
});

test("updateBlock returns null for unknown id", () => {
  assert.equal(blocks.updateBlock(999999, { goal: "x" }), null);
});

// ---- clamping / validation ----

test("createBlock clamps total_weeks to [2, 12]", () => {
  const tooShort = blocks.createBlock({ total_weeks: 0 });
  assert.equal(tooShort.total_weeks, 2, "minimum is 2");

  resetTables("program_blocks");
  const tooLong = blocks.createBlock({ total_weeks: 999 });
  assert.equal(tooLong.total_weeks, 12, "maximum is 12");
});

test("createBlock clamps week_index to at least 1", () => {
  const b = blocks.createBlock({ week_index: -5 });
  assert.equal(b.week_index, 1);
});

test("createBlock trims and caps goal string; empty goal gets a default", () => {
  const b = blocks.createBlock({ goal: "  trimmed  " });
  assert.equal(b.goal, "trimmed");

  resetTables("program_blocks");
  const def = blocks.createBlock({ goal: "" });
  assert.equal(def.goal, "Training block");
});

test("createBlock falls back to 'strength' for invalid focus enum", () => {
  const b = blocks.createBlock({ focus: "powerlifting" });
  assert.equal(b.focus, "strength");
});

test("createBlock falls back to sensible phase for invalid phase enum", () => {
  const b = blocks.createBlock({ phase: "deload_x", total_weeks: 4, week_index: 1 });
  // invalid → falls back to the derived phase for week 1 of 4 = accumulation
  assert.equal(b.phase, "accumulation");
});

// ---- blockForCoach ----

test("blockForCoach returns null when no active block", () => {
  assert.equal(blocks.blockForCoach(), null);
});

test("blockForCoach returns a plain-language summary with no scores", () => {
  blocks.createBlock({ goal: "Build squat + base", focus: "strength", total_weeks: 5 });
  const summary = blocks.blockForCoach();
  assert.ok(summary, "summary is not null");
  assert.equal(summary.goal, "Build squat + base");
  assert.equal(summary.focus, "strength");
  assert.equal(typeof summary.phase, "string");
  assert.match(summary.week_of, /^week \d+ of \d+$/, "week_of is human readable");
  // Constitution: no numeric score fields
  assert.ok(!("score" in summary), "no score field");
});

test("blockForCoach week_of reflects the current week_index", () => {
  const b = blocks.createBlock({ total_weeks: 8 });
  blocks.advanceBlockWeek(b.id); // → week 2
  blocks.advanceBlockWeek(b.id); // → week 3
  const summary = blocks.blockForCoach();
  assert.equal(summary.week_of, "week 3 of 8");
});

// ---- only-one-active invariant ----
// The API layer enforces this; here we verify that getActiveBlock returns the
// latest active block when multiple exist (the most recently created wins).

test("getActiveBlock returns the newest active block when multiple are active", () => {
  blocks.createBlock({ goal: "First", total_weeks: 4 });
  blocks.createBlock({ goal: "Second", total_weeks: 6 });
  const active = blocks.getActiveBlock();
  assert.equal(active.goal, "Second", "newest active block wins");
});
