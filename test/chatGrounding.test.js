// A state-change claim in a chat reply is held to what the turn actually applied. The
// positive cases are the real replies (shortened) that told the athlete something had
// changed when nothing had; the negatives are the honest shapes that must never move.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifySentence,
  detectStateClaims,
  groundReply,
  FOOD_CLAIM_UNGROUNDED_VARIANTS,
  GOAL_CLAIM_UNGROUNDED_VARIANTS,
  LOG_CLAIM_UNGROUNDED_VARIANTS,
  MEMORY_CLAIM_UNGROUNDED_VARIANTS,
  PLAN_CLAIM_UNGROUNDED_VARIANTS,
  TIMELINE_CLAIM_UNGROUNDED_VARIANTS,
} from "../dist/chatGrounding.js";
import { GOAL_NONE_SAVED_VARIANTS, PLAN_NO_CHANGE_APPENDED_VARIANTS } from "../dist/chat-reconcile.js";

const TODAY = "2026-10-16";
const noDay = () => {
  throw new Error("no intake read expected");
};
const ground = (reply, applied = [], ctx = {}) =>
  groundReply({ reply, applied, ctx: { today: TODAY, readDay: noDay, ...ctx } });
const isVariant = (set, text) => set.some((v) => (typeof v === "function" ? false : text.includes(v)));
const ok = (type, result = { ok: true }) => ({ type, result });

// ── claims with no action: rewritten ─────────────────────────────────────────
const UNGROUNDED = [
  {
    name: "moved a run onto another day with no plan action",
    reply:
      "Makes sense. I've decoupled that 5.5k easy run from your Push day and moved it over to your Pull day. That keeps your pressing fresh.",
    cls: "plan",
    set: PLAN_CLAIM_UNGROUNDED_VARIANTS,
    gone: /decoupled/,
    kept: /keeps your pressing fresh/,
  },
  {
    name: "added a lighter session to today with no plan action",
    reply: "Added it to today as a lighter Push session. Keep the pressing crisp and stop two reps shy.",
    cls: "plan",
    set: PLAN_CLAIM_UNGROUNDED_VARIANTS,
    gone: /Added it to today/,
    kept: /stop two reps shy/,
  },
  {
    name: "pushed an updated session to the app with no plan action",
    reply: "Done. I've now pushed the updated Push session directly to the app.",
    cls: "plan",
    set: PLAN_CLAIM_UNGROUNDED_VARIANTS,
    gone: /pushed the updated/,
  },
  {
    name: "putting a trip on the timeline with no context event",
    reply: "Safe travels! Putting this on your timeline: Rome first, then Belgrade. We'll keep that week light.",
    cls: "timeline",
    set: TIMELINE_CLAIM_UNGROUNDED_VARIANTS,
    gone: /Putting this on your timeline/,
    kept: /keep that week light/,
  },
  {
    name: "logged a lunch with no food action",
    reply: "Logged your lunch. That's a solid protein start.",
    cls: "food",
    set: FOOD_CLAIM_UNGROUNDED_VARIANTS,
    gone: /Logged your lunch/,
  },
  {
    name: "amended a meal with no food action",
    reply: "I've updated your dinner entry to two slices.",
    cls: "food",
    set: FOOD_CLAIM_UNGROUNDED_VARIANTS,
    gone: /two slices/,
  },
  {
    name: "logged a weigh-in with no capture",
    reply: "I've logged that for you.",
    cls: "log",
    set: LOG_CLAIM_UNGROUNDED_VARIANTS,
    gone: /logged that for you/,
  },
  {
    name: "made a note with nothing stored",
    reply: "I've made a note that you prefer evening sessions.",
    cls: "memory",
    set: MEMORY_CLAIM_UNGROUNDED_VARIANTS,
    gone: /made a note/,
  },
];

for (const c of UNGROUNDED) {
  test(`ungrounded: ${c.name}`, () => {
    const out = ground(c.reply);
    assert.doesNotMatch(out.reply, c.gone);
    assert.ok(isVariant(c.set, out.reply), out.reply);
    if (c.kept) assert.match(out.reply, c.kept);
    assert.equal(out.notes[0]?.kind, "claim");
    assert.equal(out.notes[0]?.class, c.cls);
  });
}

test("a goal acknowledged but not saved says what is proposed and what saves it", () => {
  const message =
    "Ok sure but I think that 154 can be a good weight to go for. I want to start seeing my abs. No goal of rushing.";
  const out = ground("Got it — 154 lb, no rush. Seeing your abs is a great marker to aim for.", [], { message });
  assert.doesNotMatch(out.reply, /Got it — 154 lb, no rush/);
  assert.match(out.reply, /set my goal to 154 lb/);
  assert.match(out.reply, /great marker/);
  assert.equal(out.notes[0].class, "goal");
  const expected = GOAL_CLAIM_UNGROUNDED_VARIANTS.map((v) => v("154 lb"));
  assert.ok(expected.some((line) => out.reply.includes(line)));
});

test("a goal locked in by assertion with no goal saved is corrected", () => {
  const out = ground("Locking in 154 lb as the target — no rush on the timeline.", [], {
    message: "154 lb sounds right",
  });
  assert.match(out.reply, /set my goal to 154 lb/);
});

test("one honest sentence per class; a second false claim of the class goes", () => {
  const out = ground("I've moved your easy run to Thursday. I've also lightened Friday's session.");
  const hits = PLAN_CLAIM_UNGROUNDED_VARIANTS.filter((v) => out.reply.includes(v));
  assert.equal(hits.length, 1);
  assert.doesNotMatch(out.reply, /lightened/);
  assert.equal(out.notes.length, 2);
});

test("the honest sentence rotates by day and is stable within a day", () => {
  const reply = "Added it to today as a lighter Push session.";
  const a = groundReply({ reply, applied: [], ctx: { today: "2026-10-16", readDay: noDay } }).reply;
  const b = groundReply({ reply, applied: [], ctx: { today: "2026-10-16", readDay: noDay } }).reply;
  const c = groundReply({ reply, applied: [], ctx: { today: "2026-10-17", readDay: noDay } }).reply;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── claims WITH the matching action: untouched ───────────────────────────────
const GROUNDED = [
  ["a plan move with plan_update applied", "I've moved the run to your Pull day.", [ok("plan_update")]],
  [
    "a set run week with set_endurance_schedule",
    "I've set your run days to Tuesday and Thursday.",
    [ok("set_endurance_schedule")],
  ],
  [
    "a timeline claim with add_context_event",
    "Putting this on your timeline: Rome, then Belgrade.",
    [ok("add_context_event", { id: 4 })],
  ],
  ["a note for later with add_memory", "I've noted that for later.", [ok("add_memory", { id: 9 })]],
  [
    "an amendment with update_food_note",
    "I've added 40 g of avocado to your lunch.",
    [ok("update_food_note", { id: 3 })],
  ],
  ["a lunch log with log_food", "Logged your lunch — a good protein start.", [ok("log_food", { id: 3 })]],
  ["a weigh-in with log_weight", "Logged it.", [ok("log_weight", { id: 1 })]],
  ["a felt effort with set_activity_effort", "I've logged that run as a hard effort.", [ok("set_activity_effort")]],
  ["a structural draft the plan reconciler owns", "I've restructured your week around four days.", []],
];

for (const [name, reply, applied] of GROUNDED) {
  test(`grounded: ${name}`, () => {
    const ctx = name.includes("draft") ? { drafts: [{ id: 1 }] } : {};
    const out = ground(reply, applied, ctx);
    assert.equal(out.reply, reply);
    assert.equal(out.notes.length, 0);
  });
}

test("a goal acknowledgement stands when the goal really saved", () => {
  const reply = "Got it — 154 lb, no rush.";
  const out = ground(reply, [ok("set_profile")], {
    message: "set my goal to 154 lb",
    appliedGoalPatch: { goal_weight_lb: 154 },
  });
  assert.equal(out.reply, reply);
});

test("a weigh-in read back is never mistaken for a goal", () => {
  const reply = "Got it — 176 lb this morning, right on trend.";
  assert.equal(ground(reply, [], { message: "176 this morning" }).reply, reply);
});

test("a failed capture does not ground its claim", () => {
  const out = ground("I've logged that run as a hard one.", [
    { type: "set_activity_effort", result: { ok: false, code: "not_found" } },
  ]);
  assert.ok(isVariant(LOG_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
});

// ── never claims at all ──────────────────────────────────────────────────────
const NOT_CLAIMS = [
  "I can move it to your Pull day if you like.",
  "Want me to put this on your timeline?",
  "I'd move the easy run to Thursday so your legs are fresher.",
  "If you want, I'll add it to today as a lighter session.",
  "I'll keep an eye on how the humid runs feel.",
  "I haven't moved anything on your plan.",
  "Should I log that lunch?",
  "Moving the run to Thursday would keep Saturday clean.",
  "Your run from this morning has been recorded on Garmin.",
  "Your goal is set at 165 lb by June, and you're tracking well.",
  "Noted — the salmon dinner sounds great.",
  "**Updated Push session:**",
  "You moved your run to Thursday last week and it went well.",
];

for (const reply of NOT_CLAIMS) {
  test(`not a claim: ${reply}`, () => {
    assert.equal(classifySentence(reply), null);
    assert.equal(ground(reply).reply, reply);
  });
}

// ── coexistence with the reconcilers that already spoke ──────────────────────
test("server receipts are never judged — only the model's own sentences are", () => {
  const proposed = "Here's the read for today.";
  const reply = `${proposed}\n\nSaved and verified plan day 2.`;
  const out = ground(reply, [], { proposedReply: proposed });
  assert.equal(out.reply, reply);
});

test("a plan claim the plan reconciler already annotated is left alone", () => {
  const proposed = "Added it to today as a lighter Push session.";
  const reply = `${proposed}\n\n${PLAN_NO_CHANGE_APPENDED_VARIANTS[0]}`;
  assert.equal(ground(reply, [], { proposedReply: proposed }).reply, reply);
});

test("a goal the goal reconciler already corrected is left alone", () => {
  const proposed = "Got it — 154 lb, no rush.";
  const reply = `${proposed}\n\n${GOAL_NONE_SAVED_VARIANTS[0]}`;
  const out = ground(reply, [], {
    proposedReply: proposed,
    message: "I think 154 is a good weight to go for",
    droppedGoalFields: ["goal_weight_lb"],
  });
  assert.equal(out.reply, reply);
});

test("detectStateClaims lists every claiming sentence with its classes", () => {
  const claims = detectStateClaims("Nice run. I've moved it to Pull day.\n- Logged your lunch.");
  assert.deepEqual(
    claims.map((c) => c.classes),
    [["plan"], ["food", "log"]]
  );
});

// ── the stated day figure on a turn that logged no food ──────────────────────
const day =
  (kcal, protein_g, extra = {}) =>
  () => ({
    totals: { kcal, protein_g },
    target: { kcal: 2009, protein_g: 175 },
    remaining: { kcal: 2009 - kcal, protein_g: 175 - protein_g },
    entries: [{ id: 1, kcal, enrichment_status: "done" }],
    ...extra,
  });

test("a wrong running total is dropped and the server's figure appended", () => {
  const reply = "You're at roughly 1,090 kcal so far today. Not quite where you want to be yet.";
  const out = ground(reply, [], { readDay: day(596, 61) });
  assert.doesNotMatch(out.reply, /1,090/);
  assert.match(out.reply, /Not quite/);
  assert.match(out.reply, /596 kcal and 61 g protein/);
  assert.match(out.reply, /1,413 kcal and 114 g protein left of 2,009/);
  assert.equal(out.notes[0].kind, "intake");
});

test("a total within about ten percent of the server's stands", () => {
  const reply = "You're at about 1,100 kcal so far today.";
  assert.equal(ground(reply, [], { readDay: day(1064, 98) }).reply, reply);
});

test("a correct 'left' figure stands", () => {
  const reply = "You have about 1,400 kcal left for dinner and a snack.";
  assert.equal(ground(reply, [], { readDay: day(596, 61) }).reply, reply);
});

test("another day's figure or a what-if is never judged", () => {
  const read = day(596, 61);
  for (const reply of [
    "Yesterday you were at 2,300 kcal for the day.",
    "A 700 kcal dinner would leave you at 1,300 kcal so far.",
    "You averaged 2,100 kcal a day this week.",
  ]) {
    assert.equal(ground(reply, [], { readDay: read }).reply, reply);
  }
});

test("a meal still awaiting its estimate leaves the figure alone", () => {
  const reply = "You're at roughly 1,090 kcal so far today.";
  const read = day(596, 61, {
    entries: [
      { id: 1, kcal: 596 },
      { id: 2, kcal: null, enrichment_status: "pending" },
    ],
  });
  assert.equal(ground(reply, [], { readDay: read }).reply, reply);
});

test("a food-log turn belongs to the intake reconciler, never this backstop", () => {
  const reply = "You're at roughly 1,090 kcal so far today.";
  assert.equal(ground(reply, [ok("log_food", { id: 2 })]).reply, reply);
});

test("an unreadable day never breaks the reply", () => {
  const reply = "You're at roughly 1,090 kcal so far today.";
  assert.equal(ground(reply, [], { readDay: noDay }).reply, reply);
});

test("the turn wires grounding after every reconciler, before the reply is stored", () => {
  const src = fs.readFileSync(new URL("../src/chatTurns.ts", import.meta.url), "utf8");
  const revert = src.indexOf("reconcileChatRevertReply(intakeReply");
  const grounded = src.indexOf("groundReply({", revert);
  const stored = src.indexOf('repo.addChatMessage("assistant", reply, agent, meta)', grounded);
  assert.ok(revert > 0 && grounded > revert && stored > grounded);
});

// ── review round: what the sentence NAMES grounds it, whatever verb it uses ──────
const NAMED_SUBJECT_GROUNDED = [
  [
    "a session note with add_session_note",
    "I've added that to today's session notes.",
    [ok("add_session_note", { id: 7 })],
    "moved to a closer grip on the last sets",
  ],
  ["a set log with log_set", "Added your 4th set of squats at 225.", [ok("log_set", { id: 11 })]],
  ["a felt effort with set_activity_effort", "Updated that run's effort to hard.", [ok("set_activity_effort")]],
  ["an activity log with log_activity", "Added your 5k run from this morning.", [ok("log_activity", { id: 5 })]],
  ["a weigh-in named as weight with log_weight", "I've saved your weight for today.", [ok("log_weight", { id: 2 })]],
  [
    "a check-in named as sleep with log_checkin",
    "I've updated today's check-in with the rough sleep.",
    [ok("log_checkin")],
  ],
];

for (const [name, reply, applied, message] of NAMED_SUBJECT_GROUNDED) {
  test(`grounded by what it names: ${name}`, () => {
    const out = ground(reply, applied, { message: message ?? "" });
    assert.equal(out.reply, reply);
    assert.equal(out.notes.length, 0);
  });
}

test("a session-notes sentence is never a plan claim", () => {
  const claim = classifySentence("I've added that to today's session notes.");
  assert.deepEqual(claim?.classes, ["log"]);
});

test("a session-notes claim with nothing applied gets the log line, never the plan line", () => {
  const out = ground("I've added that to today's session notes.");
  assert.ok(isVariant(LOG_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
  assert.ok(!isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply));
});

test("a capture of a DIFFERENT subject does not ground a plan claim", () => {
  const out = ground("I've moved your Push session to Thursday.", [ok("log_weight", { id: 2 })]);
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
});

test("a capture that failed does not ground by subject either", () => {
  const out = ground("Added your 4th set of squats at 225.", [{ type: "log_set", error: "unknown exercise" }]);
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
});

// ── openers about the athlete's own work are not claims ──────────────────────
const ATHLETE_WORK = [
  ["Moved well today — squats looked strong.", "squats felt good"],
  ["Pushed through all five sets today.", "did all five sets"],
  ["Swapped to dumbbells today since the bench was taken — good call.", "swapped to dumbbells, bench was taken"],
  ["Added a few extra reps on the last set, nice.", "added reps at the end"],
  ["Swapped the last sets to dumbbells — smart.", "Swapped the last sets to dumbbells because my wrist hurt"],
  ["Logged 12k steps already, great day.", "12k steps today"],
];

for (const [reply, message] of ATHLETE_WORK) {
  test(`athlete's own work, not a claim: ${reply}`, () => {
    assert.equal(classifySentence(reply, message), null);
    assert.equal(ground(reply, [], { message }).reply, reply);
  });
}

test("a participle with something the coach could change is still a claim", () => {
  for (const reply of ["Moved your run to Thursday.", "Swapped the Push session for an easy ride.", "Logged it."]) {
    assert.ok(classifySentence(reply, "anything"), reply);
  }
});

// ── the intake backstop never judges advice or the future ────────────────────
const proteinDay = () => ({
  totals: { kcal: 1200, protein_g: 110 },
  target: { kcal: 2000, protein_g: 170 },
  remaining: { kcal: 800, protein_g: 60 },
  entries: [{ id: 1, kcal: 1200, enrichment_status: "done" }],
});

const INTAKE_ADVICE = [
  "Get 40 g protein at dinner and you'll hit your total.",
  "Have a 500 kcal dinner with 45 g protein and you're set.",
  "Aim for about 700 kcal with 50 g protein to round out the day.",
  "Tonight, 40 g protein gets you there.",
  "You should be at about 1,500 kcal so far by now.",
  "If you add a shake you'd be at 140 g protein so far.",
  "Tomorrow you'll want 2,200 kcal.",
];

for (const reply of INTAKE_ADVICE) {
  test(`advice is not a stated day figure: ${reply}`, () => {
    assert.equal(ground(reply, [], { readDay: proteinDay }).reply, reply);
  });
}

test("a stated current figure that is wrong is still corrected", () => {
  const out = ground("You're at 140 g protein so far today.", [], { readDay: proteinDay });
  assert.doesNotMatch(out.reply, /140 g/);
  assert.match(out.reply, /1,200 kcal and 110 g protein/);
});

test("a correct current figure and its remainder stand", () => {
  const reply = "You're at 110 g protein so far — 60 g protein to go.";
  assert.equal(ground(reply, [], { readDay: proteinDay }).reply, reply);
});

// ── second review: each figure is judged against the quantity its cue names ──────
const bigTarget = () => ({
  totals: { kcal: 596, protein_g: 61 },
  target: { kcal: 2400, protein_g: 175 },
  remaining: { kcal: 1804, protein_g: 114 },
  entries: [{ id: 1, kcal: 596, enrichment_status: "done" }],
});

const QUANTITY_CASES = [
  ["a 'so far' figure equal to the TARGET is still wrong", "You're at roughly 2,400 kcal so far.", true],
  ["a 'so far' figure equal to what is LEFT is still wrong", "You're at about 1,800 kcal so far today.", true],
  ["a 'left' figure equal to what is EATEN is still wrong", "You have about 600 kcal left today.", true],
  ["a correct total beside a wrong remainder is corrected", "You're at 596 kcal so far, with 2,400 kcal left.", true],
  [
    "a correct total beside a correct remainder stands",
    "You're at 596 kcal so far, with about 1,800 kcal left.",
    false,
  ],
  [
    "a target figure is a truth only where the sentence says target",
    "You're at 596 kcal so far against a 2,400 kcal target.",
    false,
  ],
  ["a wrong target named as target is corrected", "You're at 596 kcal so far against a 3,000 kcal target.", true],
  [
    "a meal-sized figure beside a correct total is not judged",
    "That 700 kcal steak puts you at 596 kcal so far.",
    false,
  ],
  ["protein so far equal to the protein target is wrong", "You're at 175 g protein so far.", true],
];

for (const [name, reply, corrected] of QUANTITY_CASES) {
  test(`intake quantity: ${name}`, () => {
    const out = ground(reply, [], { readDay: bigTarget });
    if (corrected) {
      assert.notEqual(out.reply, reply);
      assert.match(out.reply, /596 kcal and 61 g protein/);
      assert.equal(out.notes[0]?.kind, "intake");
    } else {
      assert.equal(out.reply, reply);
    }
  });
}

// ── second review: every claim in a multi-claim sentence is checked ─────────────
test("a grounded clause stays and the ungrounded plan clause is corrected", () => {
  const out = ground("I've updated today's session and logged your lunch.", [ok("log_food", { id: 3 })]);
  assert.doesNotMatch(out.reply, /updated today's session/);
  assert.match(out.reply, /^Logged your lunch\./);
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
  assert.deepEqual(
    out.notes.map((n) => n.class),
    ["plan"]
  );
});

test("comma- and dash-separated claims are each judged", () => {
  const out = ground("Logged your lunch, moved your run to Thursday — and added it to your timeline.", [
    ok("log_food", { id: 3 }),
    ok("add_context_event", { id: 4 }),
  ]);
  assert.doesNotMatch(out.reply, /moved your run/);
  assert.match(out.reply, /Logged your lunch/);
  assert.match(out.reply, /added it to your timeline/);
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
});

test("a multi-claim sentence where every claim landed is left verbatim", () => {
  const reply = "I've moved your run to Thursday and logged your lunch.";
  assert.equal(ground(reply, [ok("plan_update"), ok("log_food", { id: 3 })]).reply, reply);
});

test("a multi-claim sentence where nothing landed gets one honest line per class", () => {
  const out = ground("I've moved your run to Thursday and logged your lunch.");
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
  assert.ok(isVariant(FOOD_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
  assert.doesNotMatch(out.reply, /moved your run|logged your lunch/i);
});

test("a description riding on a false claim goes with it; one on a true claim stays", () => {
  const out = ground("I've moved your run to Thursday, which keeps Friday fresh, and logged your lunch.", [
    ok("log_food", { id: 3 }),
  ]);
  assert.doesNotMatch(out.reply, /keeps Friday fresh/);
  assert.match(out.reply, /Logged your lunch/);
});

// ── second review: a weigh-in is a log, never a plan change ─────────────────────
test("a weigh-in added to today's log is grounded by log_weight", () => {
  const reply = "I've added 176 lb to today's log.";
  const out = ground(reply, [ok("log_weight", { id: 2 })], { message: "176 this morning" });
  assert.equal(out.reply, reply);
});

test("a weigh-in claim with nothing applied is a log claim, never a plan one", () => {
  const claim = classifySentence("I've added 176 lb to today's log.");
  assert.deepEqual(claim?.classes, ["log"]);
  const out = ground("I've added 176 lb to today's log.");
  assert.ok(isVariant(LOG_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
});

test("'added X to your food log / diary' is a capture claim, not a plan claim", () => {
  for (const reply of ["I've added the oats to today's food log.", "Added your coffee to the diary for today."]) {
    const claim = classifySentence(reply);
    assert.ok(claim && !claim.classes.includes("plan"), `${reply} → ${claim?.classes}`);
  }
  const reply = "I've added the oats to today's food log.";
  assert.equal(ground(reply, [ok("log_food", { id: 3 })]).reply, reply);
});

test("a body-weight figure grounds by log_weight only outside a lift sentence", () => {
  const out = ground("I've bumped your squat to 225 lb for today's session.", [ok("log_weight", { id: 2 })]);
  assert.ok(isVariant(PLAN_CLAIM_UNGROUNDED_VARIANTS, out.reply), out.reply);
  const weighIn = "Your weigh-in has been logged for today.";
  assert.equal(ground(weighIn, [ok("log_weight", { id: 2 })]).reply, weighIn);
});
