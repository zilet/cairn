// The day's running total is the server's arithmetic. These are the two wrong replies
// the athlete caught on 2026-10-16, replayed against the real figures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileChatIntakeReply, sentenceContradictsIntake } from "../dist/chat-reconcile.js";

const logged = [{ type: "log_food", result: { id: 1 } }];
const day = (kcal, protein_g, target = { kcal: 2009, protein_g: 175 }) => () => ({
  totals: { kcal, protein_g },
  target,
  remaining: { kcal: target.kcal - kcal, protein_g: target.protein_g - protein_g },
});

test("a wrong running total is dropped and the server's line replaces it", () => {
  const reply =
    "Good plate, that NY strip gives you a solid protein hit.\n\nWith this logged you're around 1,180 kcal and 100g protein for the day, leaving roughly 830 kcal for dinner.";
  const out = reconcileChatIntakeReply(reply, logged, day(1324, 132));
  assert.match(out, /Good plate/);
  assert.doesNotMatch(out, /1,180|830/);
  assert.match(out, /1,324 kcal and 132 g protein/);
  assert.match(out, /685 kcal and 43 g protein left of 2,009/);
});

test("a correct total (rounded) is kept and nothing is appended", () => {
  const reply = "That brings you to roughly 1,320 kcal and 130g protein so far.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply);
});

test("a reply with no total claim is untouched, per-meal figures included", () => {
  const reply = "That snack is about 230 kcal with 40 g protein, a tidy post-lift hit.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(596, 65)), reply);
});

test("no food log this turn: never rewrites a reply", () => {
  const reply = "You're at around 1,090 kcal so far today.";
  assert.equal(reconcileChatIntakeReply(reply, [], day(596, 65)), reply);
});

test("an unreadable day never breaks the reply", () => {
  const reply = "You're at around 1,090 kcal so far.";
  assert.equal(reconcileChatIntakeReply(reply, logged, () => { throw new Error("db"); }), reply);
});

test("target absent: states the total, no 'left of'", () => {
  const out = reconcileChatIntakeReply("Brings you to 1,090 kcal today.", logged, () => ({ totals: { kcal: 596, protein_g: 65 }, target: null, remaining: null }));
  assert.match(out, /596 kcal and 65 g protein/);
  assert.doesNotMatch(out, /left of/);
});

// ── cases from the grok review (2026-10-16) ───────────────────────────────────
test("a meal figure beside a CORRECT day total never kills the sentence", () => {
  const reply = "You're at 1,324 kcal today; the steak was 700.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply);
});

test("a per-meal sentence that merely says 'today' carries no day cue", () => {
  const reply = "The steak was about 700 kcal today.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply);
});

test("the pre-meal total (what the model saw) is a true figure, not a contradiction", () => {
  const entry = [{ type: "log_food", result: { id: 1, date: new Date().toLocaleDateString("en-CA"), parsed: { kcal: 728 } } }];
  const reply = "Before this meal you were at 596 kcal so far today.";
  assert.equal(reconcileChatIntakeReply(reply, entry, day(1324, 132)), reply);
});

test("a numbered list is not split at '1.' and a wrong bullet drops cleanly", () => {
  const reply = "Notes:\n1. You are at 1,180 kcal so far.\n2. Sleep was fine.";
  const out = reconcileChatIntakeReply(reply, logged, day(1324, 132));
  assert.match(out, /2\. Sleep was fine\./);
  assert.doesNotMatch(out, /1,180/);
  assert.doesNotMatch(out, /^1\.\s*$/m);
});

test("'e.g.' is not a sentence break", () => {
  const reply = "Aim for protein, e.g. 40 g protein at dinner, to stay on track.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply);
});

test("a meal logged for another day is never judged against today's figures", () => {
  const entry = [{ type: "log_food", result: { id: 1, date: "2020-01-01", food: { kcal: 500 } } }];
  const reply = "Yesterday you were at 1,900 kcal for the day.";
  assert.equal(reconcileChatIntakeReply(reply, entry, day(1324, 132)), reply);
});

test("leftover / room wording without a day figure is untouched", () => {
  const reply = "I left the bun off, so roughly 400 kcal there; good to go after 500 kcal of lunch.";
  assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply);
});

test("sentence check needs a totalling cue, so a plain meal estimate is never judged", () => {
  const intake = { kcal: 596, protein_g: 65 };
  assert.equal(sentenceContradictsIntake("The steak is roughly 640 kcal.", intake), false);
  assert.equal(sentenceContradictsIntake("That brings you to 1,090 kcal so far today.", intake), true);
});

// ── 2026-10-17: a correct food amendment was rewritten to "training split unchanged" ──────
import { reconcileChatPlanReply } from "../dist/chat-reconcile.js";

test("a food amendment's 'I've added…' is never rewritten into a plan-untouched boilerplate", () => {
  const reply =
    "Done — I've added the extra 20 g of shrimp (now 230 g) and 30 g of the homemade semolina French toast to your dinner, so it comes to about 511 kcal.";
  const applied = [{ type: "update_food_note", result: { id: 534 } }];
  assert.equal(reconcileChatPlanReply(reply, "Add20g more shrimps and 30g home made French toast", applied, []), reply);
});

test("a real plan claim with nothing applied is still corrected", () => {
  const out = reconcileChatPlanReply("I've updated your plan so Thursday's run is easier.", "how about an easier Thursday?", [], []);
  assert.doesNotMatch(out, /I've updated your plan/);
  assert.match(out, /plan|unchanged|written|saved/i);
});

test("an amended meal's wrong running total is corrected too, with no guessed 'before' figure", () => {
  const amended = [{ type: "update_food_note", result: { id: 534, food: { kcal: 511 } } }];
  const out = reconcileChatIntakeReply("Added. That brings you to 1,100 kcal so far today.", amended, day(1420, 160));
  assert.doesNotMatch(out, /1,100/);
  assert.match(out, /1,420 kcal and 160 g protein/);
});

test("the pre-meal total survives when the logged meal arrives in its real in-memory shape (parsed, not food)", () => {
  const entry = [{ type: "log_food", result: { id: 1, parsed: { kcal: 728 } } }];
  const reply = "Before this meal you were at 596 kcal so far today.";
  assert.equal(reconcileChatIntakeReply(reply, entry, day(1324, 132)), reply);
});

test("a per-meal sentence that only sounds like a total is never deleted", () => {
  for (const reply of [
    "That adds up to about 700 kcal and 55 g protein, a solid post-lift meal.",
    "That brings you 55 g of protein in one sitting.",
    "You've logged 700 kcal for that steak alone.",
  ]) assert.equal(reconcileChatIntakeReply(reply, logged, day(1324, 132)), reply, reply);
});

test("a plan claim beside a lone food write is still corrected", () => {
  const out = reconcileChatPlanReply(
    "Logged. I've updated your plan so tomorrow's session is lighter.",
    "had 2 eggs, and make tomorrow lighter",
    [{ type: "log_food", result: { id: 9 } }],
    []
  );
  assert.doesNotMatch(out, /I've updated your plan/);
});
