// Today's session in the athlete's words and the coach's (review of 2026-11-12): which
// sentences ask for a session to be built or changed (the today_session gate), which ask
// to open one (start_session — never a food log that merely mentions a workout), and which
// reply sentences a turn's actions — or Today's own state — make true.
import assert from "node:assert/strict";
import { test } from "node:test";
import { repo } from "./_seed.js";
import { chatActionGates } from "../dist/chatTurns.js";
import { chatMessageStartsSession, decideChatRouting } from "../dist/chatRouting.js";
import { frameFoodCaptureMessage, hasExplicitTodaySessionIntent } from "../dist/chat-intent.js";
import {
  groundReply,
  PLAN_CLAIM_UNGROUNDED_VARIANTS,
  SESSION_CLAIM_UNGROUNDED_VARIANTS,
  SESSION_CONTENT_UNCHANGED_VARIANTS,
  SESSION_STATE_NONE_VARIANTS,
  SESSION_STATE_FINISHED_VARIANTS,
} from "../dist/chatGrounding.js";
import { localDateISO } from "../dist/repo/shared.js";

// ---- 5. the today_session gate -------------------------------------------------------

// Asks: a build/change verb governing a session (or a clear equivalent), for today —
// including the polite-question form.
const ASKS = [
  "Combine the exercise plan from yesterday and today. Make it into a full upper body session combining pull and push.",
  "make it a full upper body today",
  "give me a longer session today",
  "combine yesterday's and today's plan",
  "make today upper body",
  "Can you make today's session longer?",
  "Could you build me a quick 30 minute workout for today?",
  "Would you put together an upper session for today?",
  "Can you build me a longer session today?",
  "Please make today's workout shorter, I only have 40 minutes",
  "I need a shorter session today, only 30 minutes",
  "I want a longer workout today",
  "Give me a shorter workout today",
  "Build me a push session for today",
  "Change today's session to full body",
  "Switch today to a pull day",
  "Shorten today's workout",
  "Turn today's session into an upper body day",
  "Set up a lower body session for today",
  "Create a 45 minute full-body workout for today",
  "Design today's session around dumbbells only",
  "Add some arm work to today's session",
  "Make today's lift lighter",
  "let's do upper body today instead",
  // Opening today's session is the other action this gate offers.
  "And let's start today's session",
  "open my today's training day",
];

// Not asks: rest and skip, how it felt, logging, information questions, other days, and
// sentences that merely mention a session.
const NOT_ASKS = [
  "My legs are sore today, I need a rest",
  "I want to skip the gym today",
  "push today felt heavy, I need to log it",
  "what is today's session?",
  "What's today's workout?",
  "How did today's session go?",
  "Should I train today?",
  "I had eggs for breakfast",
  "How was my week?",
  "Today's workout was great",
  "I did legs today",
  "Can you tell me what today's workout is?",
  "Is today's session a push day?",
  "Why did you make today's session so long?",
  "I'm skipping today's workout",
  "Skip today's session",
  "Log today's workout: bench 3x5 at 185",
  "Today I want to rest",
  "Don't change today's session",
  "I'm taking a rest day today",
  "Today's session felt too long, make tomorrow shorter",
  "Move today's session to tomorrow",
  "I changed my mind about today's session",
  "Make sure I log today's workout",
  "Today was a long session, I need a break",
  "I'll be at the gym today after work",
];

test(`the today_session gate: ${ASKS.length} asks open it, ${NOT_ASKS.length} non-asks keep it shut`, () => {
  assert.ok(ASKS.length + NOT_ASKS.length >= 40);
  const wrong = [
    ...ASKS.filter((message) => !hasExplicitTodaySessionIntent(message)).map((m) => `should open: ${m}`),
    ...NOT_ASKS.filter((message) => hasExplicitTodaySessionIntent(message)).map((m) => `should stay shut: ${m}`),
  ];
  assert.deepEqual(wrong, []);
  // The chat gate reads the same answer.
  for (const message of ASKS) {
    assert.equal(chatActionGates({ message, priorAssistant: { message: "" } }).todaySession, true, message);
  }
  for (const message of NOT_ASKS) {
    assert.equal(chatActionGates({ message, priorAssistant: { message: "" } }).todaySession, false, message);
  }
});

// ---- 4. a start-session phrase never hijacks a food log -----------------------------------

test("a food log that mentions starting a workout stays a food log", () => {
  for (const message of [
    "Log food: protein shake before I start my workout",
    "protein shake before I start my workout",
    "Log food: banana when I start my training",
    "forgot to start my watch at the start of my workout",
    "Log food: forgot to start my watch at the start of my workout, had a protein bar",
    "I started my session with a coffee",
    "how do I start a workout?",
    "Don't open today's session yet",
  ]) {
    assert.equal(chatMessageStartsSession(message), false, message);
  }
  const framed = frameFoodCaptureMessage("protein shake before I start my workout", false);
  assert.equal(framed, "Log food: protein shake before I start my workout");
  const routing = decideChatRouting({ message: framed });
  assert.ok(routing.reason_codes.includes("explicit_food_log"), JSON.stringify(routing));
  assert.ok(!hasExplicitTodaySessionIntent(framed), "the session gate stays shut");
});

test("an ask to open or start today's session still reads as one, wherever it was typed", () => {
  for (const message of [
    "Log food: open my today's training day",
    "open my today's training day",
    "Open today's training day",
    "let's start today's session",
    "And let's start today's session",
    "Start my workout",
    "start my push workout",
    "Can you open today's session?",
    "begin today's training",
    "ok, let's begin my workout",
    "Time to start my session",
  ]) {
    assert.equal(chatMessageStartsSession(message), true, message);
  }
  const routing = decideChatRouting({ message: "Log food: open my today's training day" });
  assert.equal(routing.lane, "coach");
  assert.ok(!routing.reason_codes.includes("explicit_food_log"));
});

// ---- 2. start_session never grounds a claim that the CONTENT changed ------------------

const today = localDateISO();
const started = (extra = {}) => [
  { type: "start_session", result: { ok: true, daily_session_id: 1, reused: false, ...extra } },
];
const built = (extra = {}) => [
  { type: "today_session", result: { ok: true, daily_session_id: 1, reused: false, ...extra } },
];

test("a landed start_session grounds 'it is open', never 'I changed it'", () => {
  for (const claim of [
    "I've lightened today's session and dropped the squats.",
    "I've built your upper session for today with the extra pull work.",
    "I've combined yesterday's and today's sessions into one.",
    "I've changed today's workout to full body.",
  ]) {
    const out = groundReply({
      reply: claim,
      applied: started(),
      ctx: { message: "let's start today's session", today },
    });
    assert.ok(out.notes.length > 0, `${claim} → ${out.reply}`);
    assert.notEqual(out.reply, claim);
    // The correction is itself true: a session IS open (start_session landed), so it says
    // the content is as it stood — never that Today is unchanged or empty.
    assert.ok(
      SESSION_CONTENT_UNCHANGED_VARIANTS.includes(out.reply) || PLAN_CLAIM_UNGROUNDED_VARIANTS.includes(out.reply),
      out.reply
    );
  }
  for (const claim of [
    "Your session is ready on Today.",
    "I've opened today's session for you.",
    "Here it is — today's session is open.",
  ]) {
    const out = groundReply({
      reply: claim,
      applied: started(),
      ctx: { message: "let's start today's session", today },
    });
    assert.equal(out.reply, claim);
  }
});

test("a reused or refused today_session grounds only 'it is open', never a build", () => {
  const claim = "I've built your upper session for today with the extra pull work.";
  for (const applied of [
    built({ reused: true }),
    [{ type: "today_session", result: { ok: false, code: "daily_session_invalid", error: "x" } }],
  ]) {
    const out = groundReply({ reply: claim, applied, ctx: { message: "make today upper body", today } });
    assert.notEqual(out.reply, claim, JSON.stringify(applied));
  }
  const reused = groundReply({
    reply: "Your session is ready on Today.",
    applied: built({ reused: true }),
    ctx: { message: "make today upper body", today },
  });
  assert.equal(reused.reply, "Your session is ready on Today.");
  // A landed, new today_session grounds the build and the today plan claim.
  for (const ok of [claim, "I've lightened today's session and dropped the squats."]) {
    assert.equal(
      groundReply({ reply: ok, applied: built(), ctx: { message: "make today upper body", today } }).reply,
      ok
    );
  }
});

// ---- 3. a statement about Today's state is checked against Today --------------------------

test("a true description of today's open session stands with no action", () => {
  repo.prepareDailySession({
    date: today,
    source: "athlete_override",
    session: { name: "Upper A", items: [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }] },
  });
  for (const reply of [
    "Today's session is all set: Upper A — bench, rows, curls.",
    "Your workout is waiting on Today.",
    "Your session is ready on Today.",
  ]) {
    const out = groundReply({ reply, applied: [], ctx: { message: "what's today's workout", today } });
    assert.equal(out.reply, reply);
    assert.deepEqual(out.notes, []);
  }
  // A claim of an ACT still needs the act.
  const act = groundReply({
    reply: "I've built you an upper session for today.",
    applied: [],
    ctx: { message: "what's today's workout", today },
  });
  assert.notEqual(act.reply, "I've built you an upper session for today.");
  assert.ok(SESSION_CONTENT_UNCHANGED_VARIANTS.includes(act.reply), act.reply);
});

test("a false state claim is corrected with a true sentence that promises nothing it did not do", () => {
  const out = groundReply({
    reply: "Your workout is waiting on Today.",
    applied: [],
    ctx: { message: "what's today's workout", today },
  });
  assert.ok(SESSION_STATE_NONE_VARIANTS.includes(out.reply), out.reply);
  for (const line of SESSION_STATE_NONE_VARIANTS) {
    assert.doesNotMatch(line, /\bchanged\b|\bI['’]ve\b|\bI have\b|\bI['’]ll\b/, line);
  }
  // The act claim over nothing at all keeps its own honest sentence.
  const act = groundReply({ reply: "I've built your upper session for today.", applied: [], ctx: { today } });
  assert.ok(SESSION_CLAIM_UNGROUNDED_VARIANTS.includes(act.reply), act.reply);
});

test("a ready claim over a finished day says it is done", () => {
  const prepared = repo.prepareDailySession({
    date: today,
    source: "athlete_override",
    session: { name: "Upper A", items: [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }] },
  });
  repo.logSetByName({ date: today, exercise: "Bench Press", weight: 135, reps: 8 });
  repo.finishSession(Number(prepared.session_id));
  const out = groundReply({ reply: "Your session is ready on Today.", applied: [], ctx: { today } });
  assert.ok(SESSION_STATE_FINISHED_VARIANTS.includes(out.reply), out.reply);
});
