// A ONE-WEEK run move (`endurance_schedule.this_week`): "skip tomorrow's run, move the
// quality run to Friday" said for THIS week. It is written beside the standing week and
// never rewrites it; the run engine, the agenda and every dated reader apply it inside its
// own week only, so the next week is the standing one again with nothing to undo.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { activity } from "./_liveWeekFixture.js";
import { addDaysISO, mondayOf } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { applyChatActions, reconcileChatPlanReply } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { recordRunWeekMove, recordStatedRunWeek, revertStatedRunWeek } from "../dist/domain/training/stated-input.js";
import { renderRunPlan, renderStatedInputLine } from "../dist/prompt/shared.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { RUN_WEEK_MOVED_VARIANTS, WEEK_STATED_QUALITY_WHOLE_VARIANTS } from "../dist/repo/run-progression.js";

// The move must sit in the CURRENT week: an earlier week's move is expired by design.
const MON = mondayOf(localDateISO());
const WED = addDaysISO(MON, 2);
const FRI = addDaysISO(MON, 4);
const NEXT_MON = addDaysISO(MON, 7);
const NEXT_WED = addDaysISO(MON, 9);

// Standing: Thursday quality, Friday easy, Sunday long.
const STANDING = {
  days: [
    { dow: 4, kind: "quality" },
    { dow: 5, kind: "easy" },
    { dow: 0, kind: "long" },
  ],
  source: "athlete",
};
// This week: Thursday skipped, the quality moved to Friday, Sunday long stays.
const MOVED = [
  { dow: 5, kind: "quality" },
  { dow: 0, kind: "long" },
];

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "exercises",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks",
    "plan_proposals",
    "brain_decisions",
    "brain_expectations",
    "brain_rollbacks",
    "app_state",
    "chat_turns",
    "chat_messages",
    "profile"
  );
});

function seedRunner() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "standing", label: "10k-ready", weekly_km: 30, weekly_sessions: 3 },
    endurance_schedule: STANDING,
  });
  // Ten weeks of three 9 km runs before this week: base volume is well past "too thin".
  for (let wk = 0; wk < 10; wk++) {
    for (const off of [1, 3, 5]) {
      repo.addActivity({ type: "run", duration_min: 54, distance_km: 9, date: addDaysISO(MON, -(wk * 7 + off)) });
    }
  }
}

function moveThisWeek(note = "skip Thursday, quality on Friday") {
  repo.setProfile({ endurance_schedule: { this_week: { week_start: MON, days: MOVED, note } } });
}

const kinds = (schedule) => schedule.days.map((d) => `${d.dow}:${d.kind}`).sort();

test("the move is this week's run days; next week and the standing read are the usual days", () => {
  seedRunner();
  moveThisWeek();

  const week = repo.getEnduranceSchedule(WED);
  assert.deepEqual(kinds(week), ["0:long", "5:quality"]);
  assert.equal(week.week_move.week_start, MON);
  assert.equal(week.week_move.note, "skip Thursday, quality on Friday");
  assert.deepEqual(week.week_move.standing_days.map((d) => d.dow).sort(), [0, 4, 5]);
  assert.equal(week.this_week, undefined, "an effective read never carries the raw move");

  for (const day of [NEXT_MON, NEXT_WED]) {
    const next = repo.getEnduranceSchedule(day);
    assert.deepEqual(kinds(next), ["0:long", "4:quality", "5:easy"], `${day} is the standing week`);
    assert.equal(next.week_move, undefined);
  }
  const standing = repo.getStandingEnduranceSchedule();
  assert.deepEqual(kinds(standing), ["0:long", "4:quality", "5:easy"]);
  assert.equal(standing.this_week.week_start, MON);

  const plan = repo.weeklyRunPlan(WED);
  assert.equal(plan.available, true);
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  assert.ok(quality, "the moved quality run is still in the week");
  assert.equal(quality.day_number, 5, "quality lands on Friday");
  assert.ok(!plan.runs.some((r) => r.day_number === 4), "the skipped Thursday holds no run");
  assert.equal(plan.runs.find((r) => r.kind_label === "long")?.day_number, 7, "long stays on Sunday");
  assert.ok(
    plan.rationale.some((line) => /Friday \(quality\)/.test(line) && /next week/i.test(line)),
    `the rationale says this week follows the move and next week returns: ${plan.rationale.join(" | ")}`
  );

  const nextPlan = repo.weeklyRunPlan(NEXT_MON);
  assert.equal(nextPlan.runs.find((r) => r.kind_label === "quality")?.day_number, 4, "next week: Thursday quality again");
  assert.ok(nextPlan.runs.some((r) => r.kind_label === "easy" && r.day_number === 5), "next week: Friday easy again");

  const agenda = repo.flexibleTrainingAgenda(WED);
  assert.equal(agenda.available, true);
  const qualityIntent = agenda.intents.find((i) => i.kind === "quality");
  assert.ok(qualityIntent, "the agenda keeps the quality intention");
  assert.equal(qualityIntent.provisional_date, FRI);
  assert.equal(qualityIntent.suggested_date, FRI, "the agenda suggests the quality run on Friday");
  assert.ok(
    !agenda.intents.some((i) => i.status === "open" && i.suggested_date === addDaysISO(MON, 3)),
    "nothing is suggested on the skipped Thursday"
  );
});

test("an easy run logged on Wednesday closes the week's easy intention and leaves Friday's quality", () => {
  seedRunner();
  moveThisWeek();
  repo.addActivity({ type: "run", duration_min: 40, distance_km: 7, date: WED });

  const plan = repo.weeklyRunPlan(WED);
  assert.equal(plan.runs.find((r) => r.kind_label === "quality")?.day_number, 5);
  assert.ok(!plan.runs.some((r) => r.day_number === 4), "Thursday still holds no run");

  const agenda = repo.flexibleTrainingAgenda(WED);
  const easy = agenda.intents.find((i) => i.kind === "easy");
  assert.ok(easy, "the run already done counts toward the week as its easy run");
  assert.equal(easy.status, "completed");
  assert.equal(easy.completion.date, WED);
  const quality = agenda.intents.find((i) => i.kind === "quality");
  assert.equal(quality.status, "open", "Friday's quality is still owed");
  assert.equal(quality.suggested_date, FRI);
  assert.ok(!agenda.extras.some((x) => x.date === WED), "Wednesday's run is not an orphan extra");
});

test("the move never changes the standing week; a standing write keeps it; this_week: null clears it", () => {
  seedRunner();
  moveThisWeek();
  const standing = repo.getStandingEnduranceSchedule();
  assert.deepEqual(kinds(standing), ["0:long", "4:quality", "5:easy"], "writing this_week leaves the standing days");

  // A later STANDING write keeps the unexpired move unless it clears it.
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
  });
  assert.deepEqual(kinds(repo.getStandingEnduranceSchedule()), ["0:long", "2:easy", "4:quality"]);
  assert.deepEqual(kinds(repo.getEnduranceSchedule(WED)), ["0:long", "5:quality"], "the move still holds this week");
  repo.setProfile({ endurance_schedule: { quality: { type: "tempo" } } });
  assert.ok(repo.getStandingEnduranceSchedule().this_week, "a quality-only write keeps the move too");
  repo.setProfile({ endurance_schedule: { this_week: null } });
  assert.equal(repo.getStandingEnduranceSchedule().this_week, undefined, "an explicit this_week: null clears it");
  assert.equal(repo.getEnduranceSchedule(WED).week_move, undefined);
  assert.equal(repo.getStandingEnduranceSchedule().quality.type, "tempo", "clearing the move keeps the rest");

});

test("a closed week keeps reading the days in force that week, whatever is written later", () => {
  seedRunner();
  const LAST_MON = addDaysISO(MON, -7);
  const LAST_FRI = addDaysISO(MON, -3);
  // Last week's move, as it was stored while that week ran.
  const stored = JSON.parse(db.prepare("SELECT endurance_schedule_json AS j FROM profile WHERE id = 1").get().j);
  stored.week_moves = [{ week_start: LAST_MON, days: MOVED }];
  db.prepare("UPDATE profile SET endurance_schedule_json = ? WHERE id = 1").run(JSON.stringify(stored));
  const lastWeek = () => repo.getEnduranceSchedule(LAST_FRI);
  assert.deepEqual(kinds(lastWeek()), ["0:long", "5:quality"], "last week reads its own move");
  assert.equal(repo.getEnduranceSchedule(WED).week_move, undefined, "this week does not inherit last week's move");
  assert.equal(repo.getStandingEnduranceSchedule().this_week, undefined, "the standing read names only this/next week");
  assert.equal(repo.isStatedRunDay(LAST_FRI), true);
  assert.equal(repo.isStatedRunDay(addDaysISO(MON, -4)), false, "last Thursday was not a run day that week");

  // Writes after the week ended — standing, quality-only, this week's move, a clear — never change it.
  repo.setProfile({ endurance_schedule: { days: [{ dow: 2, kind: "easy" }, { dow: 0, kind: "long" }] } });
  repo.setProfile({ endurance_schedule: { quality: { type: "hills" } } });
  moveThisWeek();
  repo.setProfile({ endurance_schedule: { this_week: null } });
  assert.deepEqual(kinds(lastWeek()), ["0:long", "5:quality"], "the closed week reads the same after every write");
  // …and a move for a week that is already over is refused outright.
  repo.setProfile({ endurance_schedule: { this_week: { week_start: LAST_MON, days: [{ dow: 3, kind: "easy" }] } } });
  repo.setProfile({ endurance_schedule: { this_week: { week_start: LAST_MON, clear: true } } });
  assert.deepEqual(kinds(lastWeek()), ["0:long", "5:quality"], "a closed week's move is never set or cleared");
});

test("Undo of the week move restores the effective week to the standing one", () => {
  seedRunner();
  const before = repo.getStandingEnduranceSchedule();
  moveThisWeek();
  const id = recordRunWeekMove({ before, week_start: MON, words: "skip tomorrow, quality Friday", via: "mcp" });
  assert.ok(id, "the move is recorded");
  const row = db.prepare("SELECT summary FROM brain_decisions WHERE id = ?").get(id);
  assert.match(row.summary, /This week's runs moved: Friday quality, Sunday long/);
  assert.equal(
    recordRunWeekMove({ before: repo.getStandingEnduranceSchedule(), week_start: MON, via: "mcp" }),
    null,
    "no change, no row"
  );

  const undone = revertDecision(id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(repo.getEnduranceSchedule(WED).week_move, undefined);
  assert.deepEqual(kinds(repo.getEnduranceSchedule(WED)), ["0:long", "4:quality", "5:easy"]);
  assert.equal(repo.getStandingEnduranceSchedule().this_week, undefined);
});

test("chat: scope this_week writes only the move, and the receipt says this week only", () => {
  seedRunner();
  const action = normalizeChatAction({ type: "set_endurance_schedule", scope: "this_week", days: MOVED });
  assert.equal(action.scope, "this_week");
  assert.equal(
    normalizeChatAction({ type: "set_endurance_schedule", scope: "this_week", days: [{ dow: 6, kind: "ride", optional: true }] }),
    null,
    "a move with no run day is no move"
  );

  const message = "skip tomorrow's run, move the quality run to Friday";
  const written = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", scope: "this_week", days: MOVED }] },
    { agent: "stub", message, recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  const entry = written.applied.find((a) => a.type === "set_endurance_schedule");
  assert.ok(entry && !entry.error, JSON.stringify(written.applied));
  assert.equal(entry.result.scope, "this_week");
  assert.deepEqual(kinds(repo.getStandingEnduranceSchedule()), ["0:long", "4:quality", "5:easy"], "standing untouched");
  assert.equal(repo.getStandingEnduranceSchedule().this_week.week_start, MON);
  assert.deepEqual(kinds(repo.getEnduranceSchedule()), ["0:long", "5:quality"]);
  const decision = db
    .prepare("SELECT summary FROM brain_decisions WHERE context_json LIKE '%run_week_move%' ORDER BY id DESC")
    .get();
  assert.ok(decision, "the move is in the ledger");

  const reply = reconcileChatPlanReply("Done — Friday is your quality run this week.", message, written.applied, []);
  assert.doesNotMatch(reply, /no plan change was saved|didn't save/i);
  assert.match(reply, /Saved for this week only: Friday quality and Sunday long\./);
  assert.match(reply, /Next week goes back to your usual days \(Thursday quality, Friday easy and Sunday long\)\./);
  assert.doesNotMatch(reply, /standing run week/);
});

test("the days the engine plans hold a moved quality day even below three runs", () => {
  seedRunner();
  // A two-day standing week carries no quality; a move that names one does.
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 3, kind: "easy" },
        { dow: 0, kind: "long" },
      ],
    },
  });
  assert.ok(!repo.weeklyRunPlan(MON).runs.some((r) => r.kind_label === "quality"), "standing two-run week: no quality");
  repo.setProfile({
    endurance_schedule: {
      this_week: {
        week_start: MON,
        days: [
          { dow: 5, kind: "quality" },
          { dow: 0, kind: "long" },
        ],
      },
    },
  });
  const plan = repo.weeklyRunPlan(MON);
  assert.equal(plan.runs.find((r) => r.kind_label === "quality")?.day_number, 5, "the named quality day is kept");
  assert.ok(!plan.runs.some((r) => r.day_number === 3), "the dropped Wednesday holds no run");
});

test("the moved-week line is a variant set in the reading grammar", () => {
  assert.ok(RUN_WEEK_MOVED_VARIANTS.length >= 3);
  const rendered = RUN_WEEK_MOVED_VARIANTS.flatMap((say) => [
    say("Friday (quality), Sunday (long)", "Thursday (quality), Friday (easy), Sunday (long)"),
    say("Friday (quality), Sunday (long)", null),
  ]);
  assert.equal(new Set(rendered).size, rendered.length, "no duplicate phrasings");
  for (const line of rendered) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.match(line, /next week/i, line);
    assert.doesNotMatch(line, /anchored|engine/i, line);
  }
});

// ---------- a move never silently deletes a key run, and never resurrects a past one ----------

test("a quality-only move keeps the standing Sunday long and puts the quality on Friday", () => {
  seedRunner();
  repo.setProfile({
    endurance_schedule: { this_week: { week_start: MON, days: [{ dow: 5, kind: "quality" }], said_on: WED } },
  });
  assert.deepEqual(kinds(repo.getEnduranceSchedule(WED)), ["0:long", "5:quality"], "Sunday long is carried");
  const plan = repo.weeklyRunPlan(WED);
  assert.equal(plan.runs.find((r) => r.kind_label === "quality")?.day_number, 5, "Friday stays the quality run");
  assert.equal(plan.runs.find((r) => r.kind_label === "long")?.day_number, 7, "Sunday stays the long run");
  assert.ok(!plan.runs.some((r) => r.day_number === 4), "Thursday's standing quality was replaced, not kept");
});

test("a move said on Friday naming only Saturday easy does not resurrect Thursday's past quality", () => {
  seedRunner();
  repo.setProfile({
    endurance_schedule: { this_week: { week_start: MON, days: [{ dow: 6, kind: "easy" }], said_on: FRI } },
  });
  assert.deepEqual(kinds(repo.getEnduranceSchedule(FRI)), ["0:long", "6:easy"], "only the long run still ahead is carried");
  const plan = repo.weeklyRunPlan(FRI);
  assert.ok(!plan.runs.some((r) => r.kind_label === "quality"), "no quality is invented");
  assert.ok(!plan.runs.some((r) => r.day_number === 4), "Thursday stays empty");
  assert.equal(plan.runs.find((r) => r.kind_label === "long")?.day_number, 7);
});

test("a moved day the athlete named quality is never re-labelled long; a skip is never carried back", () => {
  seedRunner();
  // No standing week at all, and the move holds only a quality day.
  repo.setProfile({ endurance_schedule: { days: [] } });
  repo.setProfile({
    endurance_schedule: { this_week: { week_start: MON, days: [{ dow: 5, kind: "quality" }], said_on: WED } },
  });
  const plan = repo.weeklyRunPlan(WED);
  assert.equal(plan.runs.find((r) => r.day_number === 5)?.kind_label, "quality", "Friday stays quality");
  assert.ok(!plan.runs.some((r) => r.kind_label === "long"), "no long run is invented on another day");
  const line = plan.rationale.find((l) => /moved|where you put them/.test(l));
  assert.ok(line, plan.rationale.join(" | "));
  assert.doesNotMatch(line, /returns to \.|days: \.|\(\)/, "no empty usual-days list");
  assert.match(line, /Next week|next week/);

  // A standing week, and "skip Thursday" said with skip: the quality is not carried back.
  repo.setProfile({ endurance_schedule: STANDING });
  repo.setProfile({
    endurance_schedule: {
      this_week: { week_start: MON, days: [{ dow: 5, kind: "easy" }], said_on: WED, skip: [4] },
    },
  });
  assert.deepEqual(kinds(repo.getEnduranceSchedule(WED)), ["0:long", "5:easy"]);
});

test("the moved-week line lists the days Monday first", () => {
  seedRunner();
  moveThisWeek();
  const line = repo.weeklyRunPlan(WED).rationale.find((l) => /Friday \(quality\)/.test(l));
  assert.ok(line);
  assert.ok(line.indexOf("Friday (quality)") < line.indexOf("Sunday (long)"), line);
  assert.ok(line.indexOf("Thursday (quality)") < line.lastIndexOf("Sunday (long)"), line);
});

test("undoing a first-ever standing statement leaves an active move in place", () => {
  const before = repo.getStandingEnduranceSchedule();
  assert.equal(before, null);
  repo.setProfile({ endurance_schedule: STANDING });
  const id = recordStatedRunWeek({ before, words: "I run Thu, Fri and Sun", via: "mcp" });
  assert.ok(id);
  moveThisWeek();
  assert.equal(revertDecision(id).ok, true);
  assert.equal(repo.getStandingEnduranceSchedule().days.length, 0, "the standing week is cleared");
  assert.deepEqual(kinds(repo.getEnduranceSchedule(WED)), ["0:long", "5:quality"], "the move still holds");
});

test("an Undo tapped after the move's week is over says the week is over", () => {
  assert.throws(
    () =>
      revertStatedRunWeek({
        version: 1,
        scope: "this_week",
        applied: { week_start: addDaysISO(MON, -7), days: [{ dow: 5, kind: "quality" }] },
        previous: null,
      }),
    /week is over/
  );
});

test("chat: a move said about next week is stored for next week and the receipt says so", () => {
  seedRunner();
  const message = "skip tomorrow's run";
  const written = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", scope: "this_week", week: "next", days: [{ dow: 3, kind: "easy" }] }] },
    { agent: "stub", message, recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  const entry = written.applied.find((a) => a.type === "set_endurance_schedule");
  assert.ok(entry && !entry.error, JSON.stringify(written.applied));
  assert.equal(entry.result.week, "next");
  assert.equal(entry.result.week_start, NEXT_MON);
  assert.equal(repo.getEnduranceSchedule(WED).week_move, undefined, "this week is untouched");
  assert.ok(repo.getEnduranceSchedule(NEXT_WED).week_move, "next week reads the move");
  assert.equal(repo.getStandingEnduranceSchedule().next_week.week_start, NEXT_MON);
  // Next week's standing Thursday quality and Sunday long are still ahead, so they stay.
  assert.deepEqual(kinds(repo.getEnduranceSchedule(NEXT_WED)), ["0:long", "3:easy", "4:quality"]);
  const decision = db
    .prepare("SELECT summary FROM brain_decisions WHERE context_json LIKE '%run_week_move%' ORDER BY id DESC")
    .get();
  assert.match(decision.summary, /^Next week's runs moved: /);
  const reply = reconcileChatPlanReply("Done.", message, written.applied, []);
  assert.match(reply, /Saved for next week only: Wednesday easy, Thursday quality and Sunday long\./);
  assert.match(reply, /The week after goes back to your usual days/);
});

test("prompts follow the week in force: the quality day, the run plan's move line", () => {
  seedRunner();
  repo.setProfile({ endurance_schedule: { quality: { type: "threshold", work_km: 5 } } });
  moveThisWeek();
  const ctx = { endurance_schedule: repo.getStandingEnduranceSchedule() };
  const stated = renderStatedInputLine(ctx);
  assert.match(stated, /on Friday this week only \(they moved it; usually Thursday\)/, stated);
  const noStanding = {
    endurance_schedule: { days: [], this_week: { week_start: MON, days: MOVED } },
    run_plan: {
      available: true,
      week_start: MON,
      why: "a moved week",
      runs: [{ day_number: 5, label: "Tempo run", kind_label: "quality", target_distance_km: 8 }],
      rationale: [],
    },
  };
  const plan = renderRunPlan(noStanding);
  assert.match(plan, /THIS WEEK ONLY the athlete moved the runs to: Sunday \(long\), Friday \(quality\)|THIS WEEK ONLY the athlete moved the runs to: Friday \(quality\), Sunday \(long\)/, plan);
});

// ---------- a session stated FOR the moved week runs whole through a down week ----------

const VO2_5K = { type: "vo2", work_km: 5 };
// The engine's down week, forced for the week under test (ord % 4 === 0).
const DOWN = { block: { week_index: 4 } };

function moveWithSession(quality) {
  repo.setProfile({
    endurance_schedule: { this_week: { week_start: MON, days: MOVED, ...(quality ? { quality } : {}), said_on: MON } },
  });
}

test("a quality session stated for the moved week is full-sized through the down week", () => {
  seedRunner();
  // Hard sessions on record (named interval work): the evidence hold has a step to stand on.
  for (const back of [6, 13, 20])
    activity(addDaysISO(MON, -back), {
      km: 9.5,
      min: 50,
      garmin: { name: "Track intervals", te_label: "VO2MAX", aerobic_te: 4.2 },
    });
  repo.addActivity({ type: "run", duration_min: 44, distance_km: 7.4, date: WED });

  moveWithSession(null);
  const plain = repo.weeklyRunPlan(WED, DOWN);
  const short = plain.runs.find((r) => r.kind_label === "quality");
  assert.ok(short, "the moved week keeps a quality run");
  assert.equal(short.dose, "short", "without a session of its own the down week trims it to a short set");
  assert.ok(plain.rationale.some((l) => /down week/i.test(l)), plain.rationale.join(" | "));

  moveWithSession(VO2_5K);
  const week = repo.getEnduranceSchedule(WED);
  assert.equal(week.quality.type, "vo2");
  assert.equal(week.week_move.quality_stated, true);
  const plan = repo.weeklyRunPlan(WED, DOWN);
  const full = plan.runs.find((r) => r.kind_label === "quality");
  assert.equal(full.day_number, 5, "Friday");
  assert.equal(full.dose, undefined, "not the short set");
  assert.equal(full.stated_quality?.dose, "full");
  assert.equal(full.stated_quality?.type, "vo2");
  assert.ok(full.target_distance_km > short.target_distance_km, `${full.target_distance_km} > ${short.target_distance_km}`);
  assert.ok(
    plan.rationale.some((l) => /lighter week|steps back in distance/i.test(l) && /for this week|this week, so/i.test(l)),
    `the rationale says the session stays whole because they asked for it: ${plan.rationale.join(" | ")}`
  );
  assert.equal(plan.runs.find((r) => r.kind_label === "easy")?.day_number, 3, "Wednesday's run is the week's easy run");
});

test("a week-stated session never opens a recovery week, and never changes the standing session", () => {
  seedRunner();
  repo.setProfile({ endurance_schedule: { quality: { type: "threshold", work_km: 4 } } });
  moveWithSession(VO2_5K);
  const ps = repo.getProgramState(WED);
  const recovery = repo.weeklyRunPlan(WED, {
    ...DOWN,
    programState: { ...ps, mesocycle: { ...(ps.mesocycle ?? {}), phase: "deload" }, recovery_week: { state: "applied" } },
  });
  assert.ok(!recovery.runs.some((r) => r.kind_label === "quality"), "an applied recovery week still has no quality");

  assert.equal(repo.getStandingEnduranceSchedule().quality.type, "threshold", "the standing session is untouched");
  assert.equal(repo.getStandingEnduranceSchedule().this_week.quality.type, "vo2");
  assert.equal(repo.getEnduranceSchedule(NEXT_WED).quality.type, "threshold", "next week reads the standing session");
  assert.equal(repo.getEnduranceSchedule(NEXT_WED).week_move, undefined);
  const next = repo.weeklyRunPlan(NEXT_MON);
  const nextQuality = next.runs.find((r) => r.kind_label === "quality");
  assert.equal(nextQuality?.day_number, 4);
  assert.equal(nextQuality?.stated_quality?.type, "threshold");
});

test("chat: a move with its session writes it for that week and names it in the receipt and ledger", () => {
  seedRunner();
  const message = "do the 5K intervals on Friday instead";
  const written = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", scope: "this_week", days: MOVED, quality: VO2_5K }] },
    { agent: "stub", message, recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  const entry = written.applied.find((a) => a.type === "set_endurance_schedule");
  assert.ok(entry && !entry.error, JSON.stringify(written.applied));
  assert.equal(repo.getStandingEnduranceSchedule().quality, undefined, "no standing session was written");
  assert.equal(repo.getEnduranceSchedule(WED).quality.type, "vo2");
  const reply = reconcileChatPlanReply("Done.", message, written.applied, []);
  assert.match(reply, /Saved for this week only: Friday quality \(VO2 intervals 5 km\) and Sunday long\./, reply);
  const decision = db
    .prepare("SELECT summary FROM brain_decisions WHERE context_json LIKE '%run_week_move%' ORDER BY id DESC")
    .get();
  assert.match(decision.summary, /Friday quality \(VO2 intervals 5 km\), Sunday long/);
});

test("the week-stated-session lines are a variant set in the reading grammar", () => {
  assert.ok(WEEK_STATED_QUALITY_WHOLE_VARIANTS.length >= 3);
  const rendered = WEEK_STATED_QUALITY_WHOLE_VARIANTS.map((say) => say("6 × 800m hard with 2 km either side"));
  assert.equal(new Set(rendered).size, rendered.length);
  for (const line of rendered) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /anchored|engine/i, line);
  }
});
