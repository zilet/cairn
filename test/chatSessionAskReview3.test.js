// The third review of the session word-matchers (2026-11-12): every string here was
// reproduced against the built code by the reviewer, and each failed before the session
// asks were rebuilt as a positive reading — whose session, which day, what object
// (chatRouting.ts "Session asks") — and grounding learned the same scope.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatActionGates } from "../dist/chatTurns.js";
import { chatMessageStartsSession, decideChatRouting } from "../dist/chatRouting.js";
import { frameFoodCaptureMessage, hasExplicitTodaySessionIntent } from "../dist/chat-intent.js";
import {
  groundReply,
  PLAN_CLAIM_UNGROUNDED_VARIANTS,
  SESSION_CONTENT_UNCHANGED_VARIANTS,
  SESSION_STATE_FINISHED_VARIANTS,
} from "../dist/chatGrounding.js";

const gates = (message, prior = "") => chatActionGates({ message, priorAssistant: { message: prior } });

// ---- 1. a food message is never hijacked by the start check -----------------------------

const FOOD_WITH_START = [
  "Log food: grilled chicken, rice and broccoli. Start my workout",
  "log food: chicken and rice, start session",
  "pasta with chicken, now let's start my session",
  "had 200g chicken and rice, ok start my workout",
  "grilled salmon and potatoes. let's start the session",
];

test("review 3 item 1: food beside a start ask is captured, and the start ask still opens", () => {
  for (const message of FOOD_WITH_START) {
    const routing = decideChatRouting({ message });
    assert.ok(routing.reason_codes.includes("explicit_food_log"), `${message}: ${JSON.stringify(routing)}`);
    // The mixed turn: the coach lane keeps the capture reason, so the food is logged and
    // the start is answered in one turn.
    assert.equal(routing.lane, "coach", `${message}: ${JSON.stringify(routing)}`);
    assert.equal(gates(message).startSession, true, message);
    assert.equal(gates(message).todaySession, false, message);
    // Typed into the food box it is still framed as a food log.
    assert.match(frameFoodCaptureMessage(message, false), /^Log food: /, message);
  }
  // The framed composer with nothing food-shaped under the frame is still the coach's.
  const routing = decideChatRouting({ message: "Log food: open my today's training day" });
  assert.equal(routing.lane, "coach");
  assert.ok(!routing.reason_codes.includes("explicit_food_log"), JSON.stringify(routing));
  assert.equal(frameFoodCaptureMessage("open my today's training day", false), "open my today's training day");
});

// ---- 3. the start gate opens only for the athlete's own session today --------------------

const NOT_A_START = [
  "start my Thursday workout",
  "start my session tomorrow",
  "let's start the long run session tomorrow",
  "open my session from yesterday",
  "start a session for my son",
  "time to start the session for my client",
  "take me to the workout history",
  "open the training plan",
  "please open the workout log",
  "start the workout timer",
];

test("review 3 item 3: another day, another person or another screen never opens startSession", () => {
  const wrong = NOT_A_START.filter((message) => chatMessageStartsSession(message) || gates(message).startSession);
  assert.deepEqual(wrong, []);
});

const OFFERS_NOT_TODAY = [
  "Want me to start tracking your sleep session?",
  "Want me to start tomorrow's session early?",
  "Want me to open your session from Tuesday so you can fix a set?",
  "Want me to start a recovery week session plan?",
];

test("review 3 item 3: a bare yes opens only after an offer to open TODAY's session", () => {
  for (const prior of OFFERS_NOT_TODAY) {
    for (const message of ["yes", "go ahead", "yes please"]) {
      const g = gates(message, prior);
      assert.deepEqual([g.startSession, g.todaySession], [false, false], `${message} after: ${prior}`);
    }
  }
  assert.equal(gates("yes", "Want me to open today's session?").startSession, true);
});

// ---- 4. negations, other days and other people keep the build gate shut ------------------

const NOT_A_BUILD = [
  "I don't want to change today's session",
  "I do not want to change today's session",
  "I'd rather not change today's session",
  "I hope you won't change today's session",
  "I need a longer session tomorrow, not today",
  "build my wife a lower body session today",
];

test("review 3 item 4: a negated, other-day or other-person build ask keeps todaySession shut", () => {
  const wrong = NOT_A_BUILD.filter((message) => hasExplicitTodaySessionIntent(message) || gates(message).todaySession);
  assert.deepEqual(wrong, []);
});

// ---- 2. a finished day is never "ready" ---------------------------------------------------

const today = "2032-06-08";
const finishedStart = [
  {
    type: "start_session",
    result: {
      ok: true,
      daily_session_id: 1,
      reused: true,
      started: true,
      finished: true,
      open: { kind: "session", date: today, label: "Log more on Pull" },
    },
  },
];

test("review 3 item 2: a ready/start/continue claim over a finished session is corrected to done", () => {
  for (const claim of [
    "Your session is ready on Today — tap Start.",
    "Your session is ready on Today.",
    "Today's workout is waiting on Today.",
    "I've opened today's session for you.",
  ]) {
    const out = groundReply({
      reply: claim,
      applied: finishedStart,
      ctx: { message: "let's start today's session", today, readTodaySession: () => "finished" },
    });
    assert.ok(SESSION_STATE_FINISHED_VARIANTS.includes(out.reply), `${claim} → ${out.reply}`);
  }
  // A refused today_session pointing at a finished session grounds no "ready to continue".
  const refused = [
    {
      type: "today_session",
      result: {
        ok: false,
        code: "daily_session_locked",
        error: "You've finished today's session, so it stays as you have it.",
        started: true,
        finished: true,
        open: { kind: "session", date: today, label: "Log more on Pull" },
      },
    },
  ];
  const out = groundReply({
    reply: "Your session is ready to continue on Today.",
    applied: refused,
    ctx: { message: "make today upper body", today, readTodaySession: () => "finished" },
  });
  assert.ok(SESSION_STATE_FINISHED_VARIANTS.includes(out.reply), out.reply);
  // "It's done" is the true state and stands.
  const done = "Today's session is already done — you can add to it from Today.";
  assert.equal(
    groundReply({ reply: done, applied: finishedStart, ctx: { today, readTodaySession: () => "finished" } }).reply,
    done
  );
});

// ---- 5. grounding reads only today's own session as a today-session claim ----------------

test("review 3 item 5: other-day and other-person sentences are not today-session claims", () => {
  const none = { today, readTodaySession: () => "none" };
  for (const reply of ["Tomorrow's session is all set: Lower B.", "Your Thursday workout is ready in the plan."]) {
    const out = groundReply({ reply, applied: [], ctx: none });
    assert.equal(out.reply, reply);
    assert.deepEqual(out.notes, []);
  }
  const wife = groundReply({ reply: "Your wife's session is ready.", applied: [], ctx: none });
  assert.equal(wife.reply, "Your wife's session is ready.");
  // An other-day build claim is a PLAN claim: held to a landed plan change, not to today.
  const open = { today, readTodaySession: () => "open" };
  const tomorrow = groundReply({ reply: "I've built tomorrow's session as a lower day.", applied: [], ctx: open });
  assert.ok(PLAN_CLAIM_UNGROUNDED_VARIANTS.includes(tomorrow.reply), tomorrow.reply);
  assert.equal(tomorrow.notes[0].class, "plan");
  const landedPlan = [{ type: "plan_update", result: { ok: true, verified: true } }];
  assert.equal(
    groundReply({ reply: "I've built tomorrow's session as a lower day.", applied: landedPlan, ctx: open }).reply,
    "I've built tomorrow's session as a lower day."
  );
  // Content asserted as changed is an act claim: a start_session alone does not make it true.
  const started = [{ type: "start_session", result: { ok: true, daily_session_id: 1, reused: true } }];
  const curls = groundReply({ reply: "Today's session now has curls at the end.", applied: started, ctx: open });
  assert.ok(SESSION_CONTENT_UNCHANGED_VARIANTS.includes(curls.reply), curls.reply);
  const built = [{ type: "today_session", result: { ok: true, daily_session_id: 2, reused: false } }];
  assert.equal(
    groundReply({ reply: "Today's session now has curls at the end.", applied: built, ctx: open }).reply,
    "Today's session now has curls at the end."
  );
});
