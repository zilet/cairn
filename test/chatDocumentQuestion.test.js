// A message that pastes a document AND asks the coach's view is one ordinary turn: the
// note is recorded and the question is answered. The failure this holds (2026-11-12): a
// pasted clinician note plus "…I plan on doing bloodwork next month… WDYT?" read as a
// plan edit ("optimize" + the verb "plan"), the true "I've saved your note" read as a
// plan claim, and the whole answer was replaced by "Nothing from that response reached
// the plan". All text here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_NO_CHANGE_APPENDED_VARIANTS,
  PLAN_NOT_SAVED_VARIANTS,
  PLAN_UNTOUCHED_BY_QUESTION_VARIANTS,
  reconcileChatPlanReply,
} from "../dist/chat-reconcile.js";
import { groundReply } from "../dist/chatGrounding.js";
import {
  hasExplicitPlanEditIntent,
  hasSelfContainedPlanEditIntent,
  messageAsksForAnswer,
} from "../dist/chat-intent.js";

const NOTE = [
  "Got a message from my clinician about last week's labs:",
  "",
  "```",
  "Hello - your results look good. Vitamin levels are normal and the cholesterol panel improved.",
  "Your 10-year risk estimate is now 2%, under the level where we would start medication.",
  "Is it reasonable to keep holding off? I think so. Keep up the diet changes.",
  "```",
  "",
].join("\n");
const QUESTION =
  "I want to go deeper and optimize further, get leaner and check on ApoB. I plan on doing a full panel next month (want to fit in a few hard runs first) and a DEXA too. WDYT?";
const MESSAGE = NOTE + QUESTION;
const HEALTH_LOGGED = [{ type: "log_health", result: { id: 7, kind: "visit_note" } }];
const ANSWER = [
  "I've saved the note to your health record.",
  "",
  "This is a good place to be. ApoB is the right next marker, since it counts every particle the panel only estimates.",
  "",
  "Keep the hard runs at least three easy days clear of the draw, and test fasted.",
].join("\n");

const reconcile = (reply, message = MESSAGE, applied = HEALTH_LOGGED, explicit) =>
  reconcileChatPlanReply(reply, message, applied, [], explicit);
const anyOf = (set, text) => set.some((line) => text.includes(line));

test("'I plan on …' is the athlete's verb, never a plan object", () => {
  assert.equal(hasSelfContainedPlanEditIntent(MESSAGE), false);
  assert.equal(hasExplicitPlanEditIntent(MESSAGE), false);
  assert.equal(hasExplicitPlanEditIntent("I'm planning to retest in spring, and I want to optimize further."), false);
  // Removing the verb leaves the instruction around it intact.
  assert.equal(hasExplicitPlanEditIntent("I plan to swap bench for dips in my plan"), true);
  assert.equal(hasExplicitPlanEditIntent("Optimize my plan for the race"), true);
  assert.equal(hasExplicitPlanEditIntent("We're planning to move the long run to Saturday"), true);
});

test("the athlete's own question counts; a question inside the pasted note does not", () => {
  assert.equal(messageAsksForAnswer(MESSAGE), true);
  assert.equal(messageAsksForAnswer("Here's the note:\n```\nIs it reasonable to wait?\n```\nLogging it."), false);
  assert.equal(messageAsksForAnswer("> Should we recheck in spring?\nSaving this for later."), false);
  assert.equal(messageAsksForAnswer("Thoughts on adding a DEXA."), true);
  assert.equal(messageAsksForAnswer("Log this note."), false);
});

test("a document plus a question keeps the whole answer beside the health log", () => {
  const out = reconcile(ANSWER);
  assert.equal(out, ANSWER, "nothing claimed a plan change, so the answer stands word for word");
  assert.ok(!anyOf(PLAN_NOT_SAVED_VARIANTS, out));
  const grounded = groundReply({
    reply: out,
    applied: HEALTH_LOGGED,
    ctx: { message: MESSAGE, proposedReply: ANSWER, drafts: [], today: "2026-11-12" },
  });
  assert.equal(grounded.reply, ANSWER, "the landed health log grounds the 'saved' sentence");
});

test("a true 'I've added' about a landed non-plan write is never read as a plan claim", () => {
  // Even when the turn read as an explicit plan edit, the health-log sentence is true.
  const out = reconcile(ANSWER, MESSAGE, HEALTH_LOGGED, true);
  assert.match(out, /^I've saved the note to your health record\./);
  assert.match(out, /ApoB is the right next marker/);
  assert.ok(anyOf(PLAN_NO_CHANGE_APPENDED_VARIANTS, out), "the explicit read gets its honest one-line note");
  assert.ok(!anyOf(PLAN_NOT_SAVED_VARIANTS, out));
});

test("a false plan claim beside an asked question drops only that sentence", () => {
  const reply =
    "ApoB is the right next marker. I've updated your plan so the week before the draw is easy.\n\nTest fasted.";
  const out = reconcile(reply, `Update my plan around the draw? ${QUESTION}`, HEALTH_LOGGED, true);
  assert.match(out, /^ApoB is the right next marker\./);
  assert.match(out, /Test fasted\./);
  assert.doesNotMatch(out, /I've updated your plan/);
  assert.ok(anyOf(PLAN_NO_CHANGE_APPENDED_VARIANTS, out));
  assert.ok(!anyOf(PLAN_NOT_SAVED_VARIANTS, out));
});

test("a plan claim beside a landed non-plan write, with no edit asked, keeps the answer", () => {
  const reply = "I've saved the note. I've updated your plan so the week before the draw is easy. ApoB is next.";
  const out = reconcile(reply, MESSAGE);
  assert.match(out, /^I've saved the note\./, "the true log sentence stays");
  assert.match(out, /ApoB is next\./);
  assert.doesNotMatch(out, /I've updated your plan/);
  assert.ok(anyOf(PLAN_UNTOUCHED_BY_QUESTION_VARIANTS, out));
});

test("a bare edit request answered with a false 'done' is still replaced whole", () => {
  const message = "Swap bench for dips in today's session.";
  const out = reconcile("Done — I've updated your session: dips in place of bench.", message, [], true);
  assert.ok(anyOf(PLAN_NOT_SAVED_VARIANTS, out));
});
