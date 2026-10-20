// The chat agent and the dated week (src/domain/training/dated-week.ts).
//
// The incident (2026-10-19): the plan's day_numbers are the ring's ORDER, not weekdays —
// the week deals the ring from the last LOGGED session — but chat's DATA carried no
// weekday map, so the agent assumed "Day 2 Lower" was Tuesday, edited day 2 to spare
// Tuesday, and the edit landed on Friday's Lower. The fixes held here:
//   - DATA.dated_week says which session lands on which date (the Plan strip's own week);
//   - a plan_update change may carry `date`, and the server resolves the day_number from
//     that week (the date wins; a mismatch is kept on the outcome; a liftless date skips);
//   - `until` rides each change end-to-end into the proposal (stream C applies it);
//   - a reply's "Tuesday: Strength — Lower" is held to the week and corrected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { datedWeek, datedWeekDay } from "../dist/domain/training/dated-week.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { buildChatPrompt } from "../dist/prompt/chat.js";
import { applyChatActions, resolveDatedPlanChanges } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { datedPlanChangeReceipts, reconcileChatPlanReply } from "../dist/chat-reconcile.js";
import { groundReply, scheduleContradictions } from "../dist/chatGrounding.js";

// Monday 2026-10-19, the morning of the incident.
const NOW = new Date("2026-10-19T09:00:00");
const WORKDAYS = { days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }], source: "athlete" };

const strengthDay = (day_number, name, exercises) => ({
  day_number,
  name,
  items: exercises.map((exercise) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 })),
});

// The athlete's five-day template, lifting Mon–Fri. Last week he logged day 1 on
// Thursday and day 2 on Friday, so the ring continues: Mon=3, Tue=4, Wed=5, Thu=1, Fri=2.
function seedIncident() {
  repo.replacePlan([
    strengthDay(1, "Push A", ["Barbell Bench Press"]),
    strengthDay(2, "Lower", ["Back Squat", "Deadlift", "Bulgarian Split Squat", "Calf Raise"]),
    strengthDay(3, "Upper back & arms", ["Chest-Supported Row"]),
    strengthDay(4, "Push B", ["Incline DB Press"]),
    strengthDay(5, "Pull", ["Lat Pulldown"]),
  ]);
  repo.setProfile({ strength_schedule: WORKDAYS });
  repo.logSetByName({ date: "2026-10-15", exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  repo.logSetByName({ date: "2026-10-16", exercise: "Back Squat", weight: 185, reps: 5 });
  repo.addContextEvent({ kind: "trip", title: "Clearwater FL", start_date: "2026-10-23", end_date: "2026-10-26" });
}

function seedPlanOnly() {
  repo.replacePlan([
    strengthDay(1, "Push A", ["Barbell Bench Press"]),
    strengthDay(2, "Lower", ["Back Squat", "Deadlift", "Bulgarian Split Squat", "Calf Raise"]),
    strengthDay(3, "Upper back & arms", ["Chest-Supported Row"]),
    strengthDay(4, "Push B", ["Incline DB Press"]),
    strengthDay(5, "Pull", ["Lat Pulldown"]),
  ]);
}

// The serialized DATA payload: the line after the final `DATA:` marker.
function dataBlock(prompt) {
  const lines = prompt.split("\n");
  const at = lines.findLastIndex((line) => /^DATA\b.*:$/.test(line));
  assert.ok(at >= 0, "the prompt carries a DATA block");
  return JSON.parse(lines[at + 1]);
}

test("the dated week runs today through next Sunday and names each date's plan day from the Plan strip's week", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const week = datedWeek("2026-10-19");
  assert.ok(week, "a lifting week is known, so the dates are too");
  assert.equal(week.from, "2026-10-19");
  assert.equal(week.to, "2026-11-01");
  assert.equal(week.days.length, 14, "this week from today, then all of next week");
  assert.equal(datedWeekDay(week, "2026-10-19").st, "today");
  assert.equal(datedWeekDay(week, "2026-10-20").st, "upcoming");

  // The incident's facts: Tuesday is Push B, the leg day is Friday.
  assert.deepEqual(
    { day: datedWeekDay(week, "2026-10-20").lift.day, name: datedWeekDay(week, "2026-10-20").lift.name },
    { day: 4, name: "Push B" }
  );
  assert.equal(datedWeekDay(week, "2026-10-23").lift.day, 2);
  assert.equal(datedWeekDay(week, "2026-10-23").lift.name, "Lower");
  assert.equal(datedWeekDay(week, "2026-10-24").lift, undefined, "Saturday is not a lifting weekday");

  // The trip marks exactly its own dates.
  const trip = week.days.filter((d) => d.trip).map((d) => d.date);
  assert.deepEqual(trip, ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);

  // One source: every upcoming row of this week is the strip's own cell.
  const strip = planWeek("2026-10-19");
  for (const cell of strip.days.filter((c) => c.date > "2026-10-19")) {
    const row = datedWeekDay(week, cell.date);
    assert.equal(row.lift?.day ?? null, cell.plan_day?.role === "strength" ? cell.plan_day.day_number : null, cell.date);
  }
  assert.doesNotMatch(JSON.stringify(week), /"(?:score|grade|percent)"/i);
});

test("chat's DATA carries the dated week, and the prompt says the plan's day_numbers are not weekdays", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const prompt = buildChatPrompt([], "what's on Tuesday?");
  const data = dataBlock(prompt);
  assert.ok(data.dated_week, "DATA.dated_week is present");
  const tuesday = data.dated_week.days.find((d) => d.date === "2026-10-20");
  assert.equal(tuesday.wd, "Tue");
  assert.equal(tuesday.lift.day, 4);
  assert.equal(tuesday.lift.name, "Push B");
  const friday = data.dated_week.days.find((d) => d.date === "2026-10-23");
  assert.equal(friday.lift.name, "Lower");
  assert.equal(friday.trip, true);
  assert.match(prompt, /WHICH SESSION IS ON WHICH DAY comes ONLY from DATA\.dated_week/);
  assert.match(prompt, /day_numbers are\s+the ring's order, NOT weekdays/);
  // The action shape documents the fields with placeholders, never a literal date the
  // model could copy into a real change.
  assert.match(prompt, /"date": "<YYYY-MM-DD>"/);
  assert.doesNotMatch(prompt, /"(?:date|until)": "20\d\d-/);
  assert.match(prompt, /"until": "YYYY-MM-DD" on a change marks an adaptation that ends on that date/);
  assert.match(prompt, /"lasting": true on a dated change means a permanent change to that session going forward/);
  // Compact: a fortnight of rows stays small.
  assert.ok(JSON.stringify(data.dated_week).length < 2500, "the dated week stays a compact block");
});

test("a dated plan_update retargets to the plan day that date holds and keeps the mismatch on the outcome", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Lighter press before the race",
          changes: [
            // The model guessed Tuesday = day 2. The date says day 4.
            {
              date: "2026-10-20",
              day_number: 2,
              exercise: "Incline DB Press",
              target_weight: 80,
              until: "2026-11-01",
              reason: "race taper",
            },
          ],
        },
      ],
    },
    { agent: "stub", message: "Can you lighten Tuesday's incline press to 80 until the race?" }
  );
  const entry = out.applied.find((a) => a.type === "plan_update");
  assert.ok(entry, "the plan_update ran");
  assert.deepEqual(entry.result.date_resolution.retargeted, [
    { date: "2026-10-20", exercise: "Incline DB Press", from: 2, to: 4, name: "Push B" },
  ]);
  assert.deepEqual(entry.result.date_resolution.skipped, []);
  const proposal = repo.getProposal(entry.result.proposal_id);
  const [change] = proposal.parsed.changes;
  assert.equal(change.day_number, 4, "the date wins over the model's day_number");
  assert.equal(change.date, "2026-10-20");
  assert.equal(change.until, "2026-11-01", "until rides the change into the proposal");
  // Friday's Lower was never the target.
  const lower = repo.getPlan().find((d) => d.day_number === 2);
  assert.deepEqual(
    lower.items.map((i) => i.exercise),
    ["Back Squat", "Deadlift", "Bulgarian Split Squat", "Calf Raise"]
  );
});

test("a change dated to a day with no lifting session is skipped with its reason, and nothing is proposed", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const before = repo.listProposals(100).length;
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [{ date: "2026-10-24", day_number: 2, exercise: "Back Squat", remove: true, reason: "travel" }],
        },
      ],
    },
    { agent: "stub", message: "Take squats off Saturday" }
  );
  const entry = out.applied.find((a) => a.type === "plan_update");
  assert.equal(entry.result.ok, false);
  assert.match(entry.result.error, /Saturday \(2026-10-24\) has no lifting session on it/);
  assert.deepEqual(entry.result.date_resolution.skipped, [
    { date: "2026-10-24", exercise: "Back Squat", reason: "no_lift_on_date" },
  ]);
  assert.equal(repo.listProposals(100).length, before, "no proposal is created");
  assert.ok(
    repo
      .getPlan()
      .find((d) => d.day_number === 2)
      .items.some((i) => i.exercise === "Back Squat"),
    "the leg day is untouched"
  );
});

test("resolveDatedPlanChanges: date wins, liftless and past dates skip, undated changes pass through", () => {
  seedPlanOnly();
  const week = {
    from: "2026-10-19",
    to: "2026-11-01",
    days: [
      { date: "2026-10-19", wd: "Mon", st: "today", lift: { day: 3, name: "Upper back & arms" } },
      { date: "2026-10-20", wd: "Tue", st: "upcoming", lift: { day: 4, name: "Push B" } },
      { date: "2026-10-24", wd: "Sat", st: "upcoming", trip: true },
    ],
  };
  const undated = { day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 };
  const out = resolveDatedPlanChanges(
    [
      undated,
      { date: "2026-10-20", day_number: 2, exercise: "Incline DB Press", sets: 2 },
      { date: "2026-10-20", day_number: 4, swap: { from: "Incline DB Press", to: "Flat DB Press" } },
      { date: "2026-10-24", exercise: "Back Squat", remove: true },
      { date: "2026-10-12", day_number: 1, exercise: "Barbell Bench Press" },
    ],
    { today: "2026-10-19", week }
  );
  assert.equal(out.changes.length, 3);
  assert.equal(out.changes[0], undated, "an undated change is untouched");
  assert.equal(out.changes[1].day_number, 4);
  assert.equal(out.changes[2].day_number, 4);
  assert.deepEqual(out.retargeted, [
    { date: "2026-10-20", exercise: "Incline DB Press", from: 2, to: 4, name: "Push B" },
  ]);
  assert.deepEqual(out.skipped, [
    { date: "2026-10-24", exercise: "Back Squat", reason: "no_lift_on_date" },
    { date: "2026-10-12", exercise: "Barbell Bench Press", reason: "date_past" },
  ]);
});

test("the action parser keeps real dates and FLAGS an unreadable or past one instead of dropping it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const action = normalizeChatAction({
    type: "plan_update",
    changes: [
      { day_number: 1, exercise: "Back Squat", date: " 2026-10-23 ", until: "2026-11-01" },
      { day_number: 1, exercise: "Deadlift", date: "next Tuesday", until: "2026-10-01" },
      { day_number: 1, exercise: "Calf Raise", date: "2026-02-30", until: "2026-13-01" },
      { day_number: 1, exercise: "Lat Pulldown", until: "2026-10-19" },
      { day_number: 1, exercise: "Lat Pulldown", date: "2026-10-23", until: "2026-10-21" },
      { day_number: 1, exercise: "Back Squat" },
    ],
  });
  const [a, b, c, d, e, f] = action.changes;
  assert.equal(a.date, "2026-10-23");
  assert.equal(a.until, "2026-11-01");
  assert.ok(!a.date_invalid && !a.until_invalid);
  // Never dropped: a dropped date fell back to the model's day_number, a dropped until
  // made a scoped change permanent.
  assert.equal(b.date, "next Tuesday");
  assert.equal(b.date_invalid, true);
  assert.equal(b.until_invalid, true, "a past until is flagged, not deleted");
  assert.equal(c.date_invalid, true, "an impossible date is flagged");
  assert.equal(c.until_invalid, true);
  assert.equal(d.until, "2026-10-19", "today is a valid last day");
  assert.ok(!d.until_invalid);
  assert.equal(e.until_invalid, true, "an until before the change's own date is not a real scope");
  assert.equal(f, action.changes[5]);
  assert.ok(!("until" in f) && !("date" in f), "an undated change is untouched");
  // Idempotent: the reply parser and the apply path both normalize.
  assert.deepEqual(normalizeChatAction(action).changes, action.changes);
});

test("a dated change with no until is a one-day adaptation unless it says lasting", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const action = normalizeChatAction({
    type: "plan_update",
    changes: [
      { date: "2026-10-23", exercise: "Back Squat", sets: 2 },
      { date: "2026-10-23", exercise: "Deadlift", sets: 2, lasting: true },
      { date: "2026-10-23", exercise: "Calf Raise", sets: 2, until: "2026-11-01", lasting: true },
      { day_number: 2, exercise: "Bulgarian Split Squat", sets: 2 },
    ],
  });
  const [oneDay, lasting, scoped, undated] = action.changes;
  assert.equal(oneDay.until, "2026-10-23", "ends on its own date");
  assert.equal(lasting.until, undefined, "lasting keeps the change open");
  assert.equal(lasting.lasting, true);
  assert.equal(scoped.until, "2026-11-01", "an explicit end date still scopes it");
  assert.ok(!("until" in undated), "undated changes keep today's behaviour");

  // End to end: "make Friday lighter, I'm travelling" lands scoped to Friday.
  seedIncident();
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Lighter legs on the travel day",
          changes: [{ date: "2026-10-23", exercise: "Back Squat", sets: 2, reason: "travel day" }],
        },
      ],
    },
    { agent: "stub", message: "Make Friday lighter, I'm travelling" }
  );
  const entry = out.applied.find((a) => a.type === "plan_update");
  const proposal = repo.getProposal(entry.result.proposal_id);
  const [change] = proposal.parsed.changes;
  assert.equal(change.day_number, 2);
  assert.equal(change.until, "2026-10-23", "a one-day adaptation, restored the day after");
});

test("an unreadable date or end date refuses that part; it never lands on a guessed day or for good", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const before = repo.listProposals(100).length;
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [
            { date: "next Tuesday", day_number: 2, exercise: "Back Squat", sets: 2 },
            { day_number: 2, exercise: "Deadlift", sets: 2, until: "2026-10-01" },
          ],
        },
      ],
    },
    { agent: "stub", message: "Lighten my legs next Tuesday and for the taper" }
  );
  const entry = out.applied.find((a) => a.type === "plan_update");
  assert.equal(entry.result.ok, false);
  assert.deepEqual(
    entry.result.date_resolution.skipped.map((s) => s.reason),
    ["date_invalid", "until_invalid"]
  );
  assert.equal(repo.listProposals(100).length, before, "nothing is proposed");
  const lower = repo.getPlan().find((d) => d.day_number === 2);
  assert.ok(
    lower.items.every((i) => i.sets === 3),
    "the leg day is untouched"
  );
});

test("a dated update, removal or swap must name a lift on that date's session — the upsert never adds it there", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  // "Lighter on Tuesday's legs": Tuesday is Push B, Back Squat lives on Friday's Lower.
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [{ date: "2026-10-20", exercise: "Back Squat", sets: 2, reason: "lighter legs" }],
        },
      ],
    },
    { agent: "stub", message: "Go lighter on Tuesday's legs" }
  );
  const entry = out.applied.find((a) => a.type === "plan_update");
  assert.equal(entry.result.ok, false);
  assert.deepEqual(entry.result.date_resolution.skipped, [
    { date: "2026-10-20", exercise: "Back Squat", reason: "exercise_not_on_date", day: 4, name: "Push B" },
  ]);
  const pushB = repo.getPlan().find((d) => d.day_number === 4);
  assert.deepEqual(
    pushB.items.map((i) => i.exercise),
    ["Incline DB Press"],
    "Back Squat was not added to Push B"
  );

  const week = datedWeek("2026-10-19");
  const res = resolveDatedPlanChanges(
    [
      // A respelling of a lift that IS there is re-aimed at the stored name.
      { date: "2026-10-20", exercise: "incline db press", sets: 2 },
      { date: "2026-10-20", exercise: "Back Squat", remove: true },
      { date: "2026-10-20", swap: { from: "Deadlift", to: "Hip Thrust" } },
      { date: "2026-10-20", swap: { from: "Incline DB Press", to: "Flat DB Press" } },
      // An addition in the add shape, of a lift no session carries, stays allowed.
      { date: "2026-10-20", exercise: "Cable Fly", sets: 3, rep_low: 12, rep_high: 15 },
      // The same shape for a lift living on another day is the mis-aim…
      { date: "2026-10-20", exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 },
      // …unless the change says it is an addition.
      { date: "2026-10-20", add: true, exercise: "Calf Raise", sets: 3, rep_low: 12, rep_high: 15 },
    ],
    { today: "2026-10-19", week }
  );
  assert.deepEqual(
    res.changes.map((c) => c.exercise ?? c.swap.from),
    ["Incline DB Press", "Incline DB Press", "Cable Fly", "Calf Raise"]
  );
  assert.ok(res.changes.every((c) => c.day_number === 4));
  assert.deepEqual(
    res.skipped.map((s) => [s.exercise, s.reason]),
    [
      ["Back Squat", "exercise_not_on_date"],
      ["Deadlift", "exercise_not_on_date"],
      ["Back Squat", "exercise_not_on_date"],
    ]
  );
});

test("each skipped or retargeted dated part gets one calm receipt line, and a skipped part is never claimed done", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  const message = "Take squats off Saturday and lighten Tuesday's incline press";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [
            { date: "2026-10-24", day_number: 2, exercise: "Back Squat", remove: true },
            { date: "2026-10-20", day_number: 2, exercise: "Incline DB Press", sets: 2 },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );
  const lines = datedPlanChangeReceipts(out.applied);
  assert.equal(lines.length, 2, "one line per part that was skipped or re-aimed");
  assert.ok(lines.some((l) => /Saturday, Oct 24/.test(l) && /no lifting|isn't a lifting day/.test(l)));
  assert.ok(lines.some((l) => /Tuesday, Oct 20/.test(l) && /Push B/.test(l)));
  const reply = "Here's the plan for the week.";
  const reconciled = reconcileChatPlanReply(reply, message, out.applied, out.drafts, out.explicitPlanEdit);
  for (const line of lines) assert.ok(reconciled.includes(line), line);
  assert.doesNotMatch(reconciled, /\d+\s*\/\s*100|score|removed|dropped/i);

  // Every part skipped: the answer stays, the claim of a change goes, the receipt says why.
  const skipped = applyChatActions(
    {
      actions: [{ type: "plan_update", changes: [{ date: "2026-10-24", exercise: "Back Squat", remove: true }] }],
    },
    { agent: "stub", message: "Take squats off Saturday" }
  );
  const claimed = "Saturday's a travel day. I've updated your plan so Saturday has no squats.";
  const honest = reconcileChatPlanReply(claimed, "Take squats off Saturday", skipped.applied, skipped.drafts, true);
  assert.match(honest, /Saturday's a travel day\./);
  assert.doesNotMatch(honest, /I've updated your plan/);
  assert.match(honest, /Saturday, Oct 24/);
});

// A fortnight shaped like the incident, for the pure grounding checks.
const WEEK = {
  from: "2026-10-19",
  to: "2026-11-01",
  days: [
    { date: "2026-10-19", wd: "Mon", st: "today", lift: { day: 3, name: "Upper back & arms" } },
    { date: "2026-10-20", wd: "Tue", st: "upcoming", lift: { day: 4, name: "Push B" } },
    { date: "2026-10-21", wd: "Wed", st: "upcoming", lift: { day: 5, name: "Pull" } },
    { date: "2026-10-22", wd: "Thu", st: "upcoming", lift: { day: 1, name: "Push A" }, run: { kind: "quality", km: 8 } },
    {
      date: "2026-10-23",
      wd: "Fri",
      st: "upcoming",
      lift: { day: 2, name: "Lower", heavy_lower: true },
      run: { kind: "easy", km: 5 },
      trip: true,
    },
    { date: "2026-10-24", wd: "Sat", st: "upcoming", trip: true },
    { date: "2026-10-25", wd: "Sun", st: "upcoming", run: { kind: "long", km: 16 }, trip: true },
    { date: "2026-10-26", wd: "Mon", st: "upcoming", lift: { day: 3, name: "Upper back & arms" }, trip: true },
    { date: "2026-10-27", wd: "Tue", st: "upcoming", lift: { day: 4, name: "Push B" } },
  ],
};

test("a reply's weekday→session lines are held to the dated week and corrected calmly", () => {
  const reply = [
    "Here's how the week lines up:",
    "- Tuesday: Strength — Lower",
    "- Wednesday: Pull",
    "- Thursday: threshold run — legs stay fresh",
    "- Friday: easy run + Upper Pull",
  ].join("\n");
  const out = groundReply({ reply, applied: [], ctx: { today: "2026-10-19", proposedReply: reply, week: WEEK } });
  assert.ok(out.reply.startsWith(reply), "the model's own lines stay word for word");
  const tail = out.reply.slice(reply.length);
  assert.match(tail, /Tuesday/);
  assert.match(tail, /Push B/);
  assert.match(tail, /Friday/);
  assert.match(tail, /Lower, your leg day/);
  assert.doesNotMatch(tail, /Wednesday|Thursday/, "the lines that agree with the week are not touched");
  assert.deepEqual(
    out.notes.filter((n) => n.kind === "schedule").map((n) => n.date),
    ["2026-10-20", "2026-10-23"]
  );
  assert.doesNotMatch(out.reply, /\d+\s*\/\s*100|score/i);
});

test("schedule grounding stays out of suggestions, past days, negations, abbreviations in prose and week-moving turns", () => {
  const quiet = [
    "If you'd rather, we could move Lower to Tuesday.",
    "Tuesday is a good day to swap in Lower if the legs feel fresh?",
    "Last Tuesday: Lower was solid.",
    "Saturday: optional MTB ride, easy on the legs",
    "Saturday: no lifting",
    "Tuesday: Push B",
    "**Fri** — Lower before the flight",
    "Monday: Upper back & arms",
    "I'll see you Tue with fresh legs.",
  ];
  for (const line of quiet) {
    assert.deepEqual(scheduleContradictions(line, WEEK), [], line);
  }
  // A lift said on a date the plan holds none.
  assert.equal(scheduleContradictions("Saturday: Strength — Upper", WEEK)[0].plan, "a day with no lifting session");
  // Another plan day's own name, and the abbreviated list form.
  assert.equal(scheduleContradictions("Tue: Push A", WEEK)[0].date, "2026-10-20");
  // "next Tuesday" reads next week's row.
  assert.equal(scheduleContradictions("Next Tuesday: Lower", WEEK)[0].date, "2026-10-27");
  // A turn that moved the week (a stated lifting week landed) is not held to the old one.
  const moved = groundReply({
    reply: "Tuesday: Lower",
    applied: [{ type: "set_strength_schedule", result: { ok: true } }],
    ctx: { today: "2026-10-19", week: WEEK },
  });
  assert.equal(moved.reply, "Tuesday: Lower");
  // A line the server wrote (not in the model's reply) is never judged.
  const server = groundReply({
    reply: "Tuesday: Lower",
    applied: [],
    ctx: { today: "2026-10-19", proposedReply: "Something else entirely.", week: WEEK },
  });
  assert.equal(server.reply, "Tuesday: Lower");
  // No calendar week: nothing to hold the line to.
  const none = groundReply({ reply: "Tuesday: Lower", applied: [], ctx: { today: "2026-10-19", week: null } });
  assert.equal(none.reply, "Tuesday: Lower");
});

// Next week differs from this one (the ring keeps turning), so a line about next week
// judged against this week's weekday is a false correction.
const FORTNIGHT = {
  from: "2026-10-19",
  to: "2026-11-01",
  days: [
    ...WEEK.days.slice(0, 7),
    { date: "2026-10-26", wd: "Mon", st: "upcoming", lift: { day: 3, name: "Upper back & arms" } },
    { date: "2026-10-27", wd: "Tue", st: "upcoming", lift: { day: 4, name: "Push B" } },
    { date: "2026-10-28", wd: "Wed", st: "upcoming", lift: { day: 5, name: "Pull" } },
    { date: "2026-10-29", wd: "Thu", st: "upcoming", lift: { day: 2, name: "Lower", heavy_lower: true } },
    { date: "2026-10-30", wd: "Fri", st: "upcoming", lift: { day: 1, name: "Push A" } },
    { date: "2026-10-31", wd: "Sat", st: "upcoming" },
    { date: "2026-11-01", wd: "Sun", st: "upcoming", run: { kind: "race", km: 21.1 } },
  ],
};

test("a dated weekday line is judged on ITS date, a Next week section is next week, and a doubled weekday is not guessed", () => {
  const quiet = [
    "Fri Oct 30: Push A",
    "- **Friday (Oct 30)**: Push A",
    "Friday, October 30th: Push A",
    "Fri 10/30: Push A",
    "Next week:\n- Friday: Push A\n- Thursday: Lower",
    "**Next week**\n- Thu — Lower",
    // A date outside the window, or one its weekday disagrees with, is not judged.
    "Fri Nov 6: Lower",
    "Thu Oct 30: Lower",
    // Two Fridays, no dates: which is which is a guess.
    "- Friday: Lower\n- Saturday: rest\n- Friday: Push A",
  ];
  for (const reply of quiet) assert.deepEqual(scheduleContradictions(reply, FORTNIGHT), [], reply);

  // The same lines still catch a real contradiction on the date they name.
  const dated = scheduleContradictions("Fri Oct 30: Lower", FORTNIGHT);
  assert.equal(dated.length, 1);
  assert.equal(dated[0].date, "2026-10-30");
  assert.equal(dated[0].when, "Friday, Oct 30");
  const section = scheduleContradictions("Next week:\n- Thursday: Push A", FORTNIGHT);
  assert.equal(section[0].date, "2026-10-29");
  // "This week" resets the section; an undated Friday there is this Friday.
  const reset = scheduleContradictions("Next week:\n- Thursday: Lower\nThis week:\n- Friday: Push A", FORTNIGHT);
  assert.deepEqual(
    reset.map((c) => c.date),
    ["2026-10-23"]
  );
  // A bare weekday is still this week's.
  assert.equal(scheduleContradictions("Friday: Push A", FORTNIGHT)[0].date, "2026-10-23");
});

test("the prompt carries the turn's own dated week when the caller built it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedIncident();
  let reads = 0;
  const read = () => {
    reads++;
    return FORTNIGHT;
  };
  const data = dataBlock(buildChatPrompt([], "what's on Friday?", undefined, { datedWeek: read }));
  assert.equal(reads, 1);
  assert.deepEqual(data.dated_week, FORTNIGHT);
});
