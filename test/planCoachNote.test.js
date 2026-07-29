// addCoachAdjustmentNote (src/repo/plan.ts) — a coach adjustment appends its
// rationale onto a plan item's note without corrupting a manual note that was
// already there, and a NEW coach note replaces the previous coach-note layer
// rather than stacking on top of it forever. See CLAUDE.md's prose-hygiene
// notes and the fix's own comment on addCoachAdjustmentNote for the bug this
// guards against (live rows found clamped mid-word at exactly 500 chars).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  db.prepare(`DELETE FROM plan_items`).run();
  db.prepare(`DELETE FROM plan_days`).run();
});

function noteFor(dayNumber, exercise) {
  return repo.getPlanDay(dayNumber).items.find((i) => i.exercise === exercise)?.note ?? null;
}

test("a first coach note lands as its own layer, no base note present", () => {
  repo.savePlanDay(1, "Day 1", "push", [{ exercise: "ZTest Bench", sets: 3, target_weight: 100 }]);
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 105, note: "Adding a touch of load." });
  assert.equal(noteFor(1, "ZTest Bench"), "Coach note: Adding a touch of load.");
});

test("a coach note is appended AFTER the item's own manual base note", () => {
  repo.savePlanDay(1, "Day 1", "push", [
    { exercise: "ZTest Bench", sets: 3, target_weight: 100, note: "Keep the tempo slow on the eccentric." },
  ]);
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 105, note: "Adding a touch of load." });
  assert.equal(noteFor(1, "ZTest Bench"), "Keep the tempo slow on the eccentric.\nCoach note: Adding a touch of load.");
});

test("a second coach note REPLACES the first coach-note layer instead of stacking", () => {
  repo.savePlanDay(1, "Day 1", "push", [
    { exercise: "ZTest Bench", sets: 3, target_weight: 100, note: "Keep the tempo slow on the eccentric." },
  ]);
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 105, note: "Adding a touch of load." });
  repo.applyPlanChange({
    day_number: 1,
    exercise: "ZTest Bench",
    target_weight: 110,
    note: "Backing off slightly on volume.",
  });
  const note = noteFor(1, "ZTest Bench");
  assert.equal(note, "Keep the tempo slow on the eccentric.\nCoach note: Backing off slightly on volume.");
  assert.ok(!note.includes("Adding a touch of load"), "the stale coach-note layer must not survive");
  // Three, four, five adjustments in a row must never grow past one coach layer.
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 112, note: "Third reason." });
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 114, note: "Fourth reason." });
  const final = noteFor(1, "ZTest Bench");
  assert.equal(final, "Keep the tempo slow on the eccentric.\nCoach note: Fourth reason.");
  assert.equal((final.match(/Coach note:/g) || []).length, 1);
});

test("re-applying the exact same reason is idempotent (note unchanged)", () => {
  repo.savePlanDay(1, "Day 1", "push", [{ exercise: "ZTest Bench", sets: 3, target_weight: 100 }]);
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 105, note: "Adding a touch of load." });
  const first = noteFor(1, "ZTest Bench");
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 106, note: "Adding a touch of load." });
  assert.equal(noteFor(1, "ZTest Bench"), first);
});

test("a long base note is truncated at a sentence boundary, never mid-word, when the new coach note needs the room", () => {
  const longBase =
    "This exercise has a long history of technical notes about bar path and bracing. " +
    "The athlete tends to lose upper-back tightness on the last rep of every set. " +
    "Cue a long exhale before the descent and keep the elbows tucked through the whole range. " +
    "Historically this movement has been the first one flagged whenever the week runs heavy. ".repeat(2);
  repo.savePlanDay(1, "Day 1", "push", [{ exercise: "ZTest Bench", sets: 3, target_weight: 100, note: longBase }]);
  const longReason =
    "Backing the load off about ten percent because the last three comparable sets all showed a grinding " +
    "final rep and the bar path drifted forward noticeably, so let it rebuild cleanly before pushing again. ".repeat(2);
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 90, note: longReason });
  const note = noteFor(1, "ZTest Bench");
  assert.ok(note.length <= 500, `note must fit the 500-char column budget, got ${note.length}`);
  assert.match(note, /Coach note: /, "the new coach layer must be present");
  const [base, coachLine] = note.split("\nCoach note: ");
  assert.ok(coachLine.length > 0, "the new coach note must not be truncated away entirely");
  // The retained base must end at a real sentence boundary, not a chopped word.
  assert.match(base, /[.!?]$/, `base must end at a sentence boundary, got "...${base.slice(-30)}"`);
});

test("an incoming reason longer than the per-note budget is capped at a sentence or word boundary, not mid-word", () => {
  repo.savePlanDay(1, "Day 1", "push", [{ exercise: "ZTest Bench", sets: 3, target_weight: 100 }]);
  // Deliberately avoids normalizeHistoricalReason's temporal rewrites (proposal-truth.ts)
  // — "last"/"recent"/"previous"/"this week" phrasing would rewrite the text before it
  // ever reaches addCoachAdjustmentNote, breaking this test's prefix assumption below.
  const longReason = (
    "Backing the load off about ten percent because the working sets have shown a grinding " +
    "final rep and the bar path has drifted forward noticeably. Let it rebuild cleanly before pushing the load again. " +
    "This has become a consistent pattern across several training blocks for this specific movement. "
  ).repeat(3);
  const normalized = longReason.trim().replace(/\s+/g, " ");
  repo.applyPlanChange({ day_number: 1, exercise: "ZTest Bench", target_weight: 90, note: longReason });
  const note = noteFor(1, "ZTest Bench");
  assert.ok(note.length <= 500);
  const clean = note.slice("Coach note: ".length);
  assert.ok(clean.length <= 420, `reason clause must respect the 420-char cap, got ${clean.length}`);
  assert.ok(normalized.startsWith(clean), "the retained text must be a clean prefix of the source reason");
  // Never end mid-word: either the cut lands right on sentence punctuation, or
  // the very next character in the source reason is a space (a clean word break).
  const boundaryChar = normalized.charAt(clean.length);
  assert.ok(
    /[.!?]$/.test(clean) || boundaryChar === "" || boundaryChar === " ",
    `must not cut mid-word — next source char after the cut was ${JSON.stringify(boundaryChar)}`
  );
});
