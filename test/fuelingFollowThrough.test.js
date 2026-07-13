import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { buildNutritionCheckinPrompt } from "../dist/prompt.js";
import { addDaysISO } from "../dist/repo/shared.js";

// A fixed "today" so window math is deterministic regardless of the wall clock.
const TODAY = "2026-07-13";
const day = (delta) => addDaysISO(TODAY, delta);

beforeEach(() => {
  resetTables("fueling_feedback", "food_notes", "brain_decisions", "brain_expectations", "nutrition_targets");
});

// Record an APPLIED nutrition_target decision that took effect on `appliedDate`.
function recordAppliedTarget(appliedDate) {
  return repo.recordDecision({
    effective_date: appliedDate,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "Nudged daily calories up ~200 to match the measured trend.",
    rationale: null,
    source: "test",
    source_ref_type: "nutrition_target",
    source_ref_key: "1",
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {},
    specialist: null,
    applied_at: `${appliedDate}T12:00:00Z`,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
}

function logFoodOn(date) {
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'meal', '', ?, NULL)`
  ).run(date, JSON.stringify({ kcal: 520, protein_g: 32 }));
}

// ---- gating: due only when ALL preconditions hold -----------------------------

test("not due without any applied nutrition_target decision", () => {
  logFoodOn(TODAY);
  const out = repo.fuelingFollowThroughDue(TODAY);
  assert.equal(out.due, false);
  assert.equal(out.decision_id, null);
});

test("not due when the change applied more than 7 days ago", () => {
  recordAppliedTarget(day(-8));
  logFoodOn(TODAY);
  assert.equal(repo.fuelingFollowThroughDue(TODAY).due, false);
});

test("not due on a day with no logged food", () => {
  recordAppliedTarget(day(-1));
  // no food logged for TODAY
  assert.equal(repo.fuelingFollowThroughDue(TODAY).due, false);
});

test("not due once the day has already been answered", () => {
  recordAppliedTarget(day(-1));
  logFoodOn(TODAY);
  repo.setFuelingFeedback(TODAY, { energy: 2 });
  assert.equal(repo.fuelingFollowThroughDue(TODAY).due, false);
});

test("due in the happy path, carrying the triggering decision and applied date", () => {
  const decision = recordAppliedTarget(day(-1));
  logFoodOn(TODAY);
  const out = repo.fuelingFollowThroughDue(TODAY);
  assert.equal(out.due, true);
  assert.equal(out.decision_id, decision.id);
  assert.equal(out.applied_on, day(-1));
  assert.match(String(out.summary), /calories/i);
});

test("the 7-day window boundary is inclusive", () => {
  recordAppliedTarget(day(-7));
  logFoodOn(TODAY);
  assert.equal(repo.fuelingFollowThroughDue(TODAY).due, true, "applied exactly 7 days ago is still in-window");
});

test("a future-dated change never triggers the follow-up", () => {
  recordAppliedTarget(day(2));
  logFoodOn(TODAY);
  assert.equal(repo.fuelingFollowThroughDue(TODAY).due, false);
});

// ---- write path: clamp + upsert + decision link -------------------------------

test("setFuelingFeedback clamps the 1-3 scale and trims the note", () => {
  const longNote = "x".repeat(900);
  const row = repo.setFuelingFeedback(TODAY, { energy: 9, hunger: 0, note: `  ${longNote}  ` });
  assert.equal(row.energy, 3, "energy clamps to the 1-3 ceiling");
  assert.equal(row.hunger, 1, "hunger clamps to the 1-3 floor");
  assert.equal(row.note.length, 500, "note is trimmed and capped at 500");

  const rounded = repo.setFuelingFeedback(day(-1), { energy: 2.4 });
  assert.equal(rounded.energy, 2, "a fractional energy rounds into the scale");
  assert.equal(rounded.hunger, null, "an omitted hunger stays null");
});

test("setFuelingFeedback upserts one row per day (latest wins)", () => {
  repo.setFuelingFeedback(TODAY, { energy: 1 });
  const updated = repo.setFuelingFeedback(TODAY, { energy: 3, note: "much better" });
  assert.equal(updated.energy, 3);
  assert.equal(updated.note, "much better");
  const all = repo.listFuelingFeedback(14).filter((r) => r.date === TODAY);
  assert.equal(all.length, 1, "one row per date");
});

test("a fueling read links to an applied target change only inside its window", () => {
  const decision = recordAppliedTarget(day(-2));
  logFoodOn(TODAY);
  const linked = repo.setFuelingFeedback(TODAY, { energy: 2 });
  assert.equal(linked.decision_id, decision.id, "linked to the in-window applied change");

  // A change that applied long ago must not stamp its id onto a fresh read.
  resetTables("brain_decisions", "fueling_feedback");
  recordAppliedTarget(day(-30));
  const unlinked = repo.setFuelingFeedback(TODAY, { energy: 2 });
  assert.equal(unlinked.decision_id, null, "no active window → no decision link");
});

test("listFuelingFeedback is newest-first and bounded", () => {
  for (let i = 0; i < 6; i += 1) repo.setFuelingFeedback(day(-i), { energy: 2 });
  const recent = repo.listFuelingFeedback(3);
  assert.equal(recent.length, 3, "respects the requested bound");
  assert.equal(recent[0].date, TODAY, "newest date first");
});

// ---- evidence wiring: check-in prompt + coach context -------------------------

test("recent fueling reads surface in the nutrition check-in prompt as plain lines", () => {
  repo.setFuelingFeedback(TODAY, { energy: 1, note: "dragging in the afternoons" });
  repo.setFuelingFeedback(day(-1), { energy: 3 });
  const prompt = buildNutritionCheckinPrompt();
  assert.match(prompt, /FUELING FOLLOW-THROUGH/);
  assert.match(prompt, /running low/);
  assert.match(prompt, /plenty/);
  assert.match(prompt, /dragging in the afternoons/);
  // Adherence-neutral, no numeric scores in the rendered block.
  assert.doesNotMatch(prompt, /energy 1\/|energy 3\//);
});

test("the check-in prompt omits the fueling block entirely when nothing is logged", () => {
  const prompt = buildNutritionCheckinPrompt();
  assert.doesNotMatch(prompt, /FUELING FOLLOW-THROUGH/);
});

test("getCoachContext carries a bounded fueling array", () => {
  repo.setFuelingFeedback(TODAY, { energy: 2, hunger: 3 });
  const ctx = repo.getCoachContext();
  assert.ok(Array.isArray(ctx.fueling), "fueling is always an array");
  assert.equal(ctx.fueling[0].energy, 2);
  assert.equal(ctx.fueling[0].hunger, 3);
});
