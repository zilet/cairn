// The path under Today's Brief (src/repo/today-path.ts): the race estimate, the weight
// and the anchor lift with their trends, the dated milestones, the ONE lever, the
// progress board — composed from the reads that own each fact — plus the overnight
// digest's per-lift move words (src/domain/today/today-digest.ts) and the context
// tags' plain effect sentences (src/repo/context-tag-effects.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo, seedWeight } from "./_seed.js";
import { todayPath, todayPathPromptView } from "../dist/repo/today-path.js";
import { liftMoveOf, overnightDigest } from "../dist/domain/today/today-digest.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import { rollbackBuiltOnEmptyPlan, saveBrainRollback } from "../dist/repo/brain-decisions.js";
import { contextTagEffect, contextTagVocab } from "../dist/repo/context-tag-effects.js";
import { CONTEXT_TAG_VOCAB } from "../dist/contextTags.js";
import { localDateISO } from "../dist/repo/shared.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = localDateISO();
const shift = (n) => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const RACE = shift(49);
const GOAL_DATE = shift(60);

function seedPicture() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
    goal_mode: "lose",
    goal_weight_lb: 154,
    goal_date: GOAL_DATE,
    start_weight_lb: 184.3,
    start_date: shift(-120),
  });
  // Six weeks of running, and the watch's half predictor moving faster over the month.
  for (let wk = 0; wk < 6; wk++) {
    repo.addActivity({ type: "run", duration_min: 48, distance_km: 8, date: shift(-wk * 7 - 5) });
    repo.addActivity({ type: "run", duration_min: 84, distance_km: 13, date: shift(-wk * 7 - 1) });
  }
  repo.upsertGarminDailyMetric({ date: shift(-30), race_predict_half_sec: 7500 });
  repo.upsertGarminDailyMetric({ date: shift(-2), race_predict_half_sec: 6900 });
  // A cut running a touch behind the line the goal date asks for.
  for (let d = 21; d >= 0; d -= 3) seedWeight(shift(-d), Math.round((159.8 + d * 0.07) * 10) / 10);
  // A deadlift objective set early, then climbing.
  repo.logSetByName({ exercise: "Deadlift", weight: 245, reps: 5, rir: 2, date: shift(-42) });
  repo.logSetByName({ exercise: "Deadlift", weight: 250, reps: 5, rir: 2, date: shift(-35) });
  repo.setStrengthObjective({ exercise: "Deadlift", target_kind: "explicit_est_1rm", target_est_1rm: 340 });
  for (const [days, weight] of [
    [28, 255],
    [21, 260],
    [14, 265],
    [7, 270],
    [1, 275],
  ]) {
    repo.logSetByName({ exercise: "Deadlift", weight, reps: 5, rir: 2, date: shift(-days) });
  }
}

test("with no race, no goal and no objective, the path is quiet: nulls and an empty board, never a throw", () => {
  const path = todayPath();
  assert.equal(path.as_of, TODAY);
  assert.equal(path.race, null);
  assert.equal(path.anchor, null);
  assert.equal(path.lever, null);
  assert.deepEqual(path.board, []);
  assert.deepEqual(path.milestones, []);
  assert.equal(path.focus, null);
  assert.ok(path.trail_start < TODAY, "the trail still has a left edge");
  // A bare date param is tolerated; garbage falls back to today.
  assert.equal(todayPath("not-a-date").as_of, TODAY);
});

test("the path reads the race, the weight and the anchor lift with their trends, in their own units", () => {
  seedPicture();
  const path = todayPath(TODAY);

  assert.equal(path.race.event, "Riverside Half");
  assert.equal(path.race.distance_label, "Half marathon");
  assert.equal(path.race.date, RACE);
  assert.equal(path.race.target_sec, 7200);
  assert.equal(path.race.target_raw, "sub-2:00");
  assert.ok(Math.abs(path.race.estimate_sec - 6900) < 10, `estimate ${path.race.estimate_sec}`);
  assert.ok(path.race.trend_delta_sec < 0, "faster over the month");
  assert.equal(path.race.fit, "fits");
  assert.equal(path.trail_start, path.race.since, "the trail starts where the estimate's trend window does");

  assert.equal(path.weight.mode, "lose");
  assert.equal(path.weight.current_lb, 159.8);
  assert.equal(path.weight.goal_lb, 154);
  assert.equal(path.weight.goal_date, GOAL_DATE);
  assert.ok(path.weight.trend_lb_wk < 0);
  assert.ok(path.weight.needed_lb_wk < path.weight.trend_lb_wk, "the date asks for more than the trend gives");
  assert.ok(path.weight.points.length >= 2);

  assert.match(path.anchor.exercise, /deadlift/i);
  assert.equal(path.anchor.target_est_1rm, 340);
  assert.ok(path.anchor.est_1rm > 290 && path.anchor.est_1rm < 340, `est ${path.anchor.est_1rm}`);
  assert.ok(path.anchor.lb_per_week > 0);

  assert.equal(path.focus, "recomposition & half marathon");
  // Measures, never grades.
  assert.doesNotMatch(JSON.stringify(path), /score|grade|percent/i);
});

test("milestones are dated, ascending, from today on, and say the race as a fit", () => {
  seedPicture();
  const { milestones } = todayPath(TODAY);
  const dates = milestones.map((m) => m.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(dates.every((d) => d >= TODAY));
  const race = milestones.find((m) => m.kind === "race");
  assert.equal(race.date, RACE);
  assert.equal(race.label, "Riverside Half");
  assert.match(race.detail, /^Now reading 1:55:\d\d, inside sub-2:00\.$/);
  const goal = milestones.find((m) => m.kind === "goal");
  assert.equal(goal.date, GOAL_DATE);
  assert.equal(goal.label, "Goal weight · 154 lb");
  assert.match(goal.detail, /lb\/wk gets there; the trend reads/);
});

test("the lever is ONE calm sentence from the ranked rules: a cut behind the line holds steady", () => {
  seedPicture();
  const { lever } = todayPath(TODAY);
  assert.equal(lever.kind, "weight");
  assert.match(lever.text, /steady/);
  assert.doesNotMatch(lever.text, /\bmust\b|\bshould\b|\d+\s*\/\s*100|score/i, "no gate language, no score");
});

test("the board lays every thread out start → now → goal, most movement first", () => {
  seedPicture();
  const { board } = todayPath(TODAY);
  const byKey = Object.fromEntries(board.map((row) => [row.id.split(":")[0], row]));
  assert.equal(byKey.race.reached, true, "1:55 is inside sub-2:00");
  assert.equal(byKey.race.progress, 1);
  assert.equal(byKey.race.note, "Past your target.");
  assert.equal(byKey.weight.start_text, "184.3 lb");
  assert.equal(byKey.weight.now_text, "159.8 lb");
  assert.equal(byKey.weight.goal_text, "154 lb");
  assert.ok(byKey.weight.progress > 0.7 && byKey.weight.progress < 1);
  assert.match(byKey.weight.note, /^24\.5 lb down since /);
  assert.equal(byKey.strength.goal_text, "340 lb");
  assert.ok(byKey.strength.progress > 0 && byKey.strength.progress < 1);
  assert.match(byKey.strength.note, /^\+\d+(\.\d)? lb\/wk$/);
  const moved = board.map((row) => row.movement);
  assert.deepEqual(
    moved,
    [...moved].sort((a, b) => b - a),
    "most movement this month first"
  );
});

test("the prompt view is small: three threads, a few milestones and the lever — no board, no points", () => {
  seedPicture();
  const view = todayPathPromptView(todayPath(TODAY));
  assert.deepEqual(Object.keys(view).sort(), ["anchor", "lever", "milestones", "race", "weight"]);
  assert.equal(view.race.estimate.slice(0, 4), "1:55");
  assert.equal(view.weight.points, undefined);
  assert.ok(view.milestones.length <= 4);
  assert.ok(JSON.stringify(view).length < 1500);
});

test("the surfaces carry the path: REST route, MCP tool, the /today fan-in and the Brief's prompt site", async () => {
  const routes = readFileSync(join(root, "src/routes/today.ts"), "utf8");
  assert.match(routes, /todayRouter\.get\("\/today-path"/);
  assert.match(routes, /todayRouter\.get\("\/today-digest"/);
  const mcp = readFileSync(join(root, "src/surfaces/mcp/daily-driver.ts"), "utf8");
  assert.match(mcp, /"get_today_path"/);
  assert.match(mcp, /"get_today_digest"/);
  const { todaySurfaceResponses } = await import("../dist/routes/today-responses.js");
  const out = todaySurfaceResponses(TODAY, {
    agenda: null,
    progressionDay: null,
    coachingFocus: null,
    strengthJourney: null,
  });
  assert.ok(out[`/today-path?date=${TODAY}`], "the fan-in carries the path");
  assert.ok(out[`/today-digest?date=${TODAY}`], "and the digest");
  const { PROMPT_CONTEXT_SITES } = await import("../dist/prompt/context-projection.js");
  assert.ok(PROMPT_CONTEXT_SITES.day_read.keys.includes("today_path"));
  assert.ok(!PROMPT_CONTEXT_SITES.coach.keys.includes("today_path"), "the Brief is the one site");
});

test("the Brief's prompt carries the road ahead only when there is one", async () => {
  const { buildDayReadPrompt } = await import("../dist/prompt/day.js");
  assert.doesNotMatch(buildDayReadPrompt(undefined, { date: TODAY }), /THE ROAD AHEAD/);
  seedPicture();
  const prompt = buildDayReadPrompt(undefined, { date: TODAY });
  assert.match(prompt, /THE ROAD AHEAD \(DATA\.today_path/);
  assert.match(prompt, /"today_path":\{/);
});

test("a digest move says which way a lift went and its before → after in its own units", () => {
  const before = { sets: 3, rep_low: 8, rep_high: 10, target_weight: 205, target_seconds: null };
  assert.deepEqual(liftMoveOf({ exercise: "Romanian Deadlift", target_weight: 210 }, before), {
    exercise: "Romanian Deadlift",
    direction: "up",
    from_text: "205 lb",
    to_text: "210 lb",
    reason: null,
  });
  const rep = liftMoveOf({ exercise: "Reverse Pec Deck", rep_low: 9, rep_high: 11 }, before);
  assert.equal(rep.direction, "up");
  assert.equal(rep.to_text, "+1 rep");
  const range = liftMoveOf({ exercise: "Curl", rep_low: 6, rep_high: 8 }, before);
  assert.equal(range.direction, "range");
  assert.equal(range.from_text, "8–10 reps");
  assert.equal(range.to_text, "6–8 reps");
  const held = liftMoveOf({ exercise: "Back Squat", target_weight: 205 }, before);
  assert.equal(held.direction, "same");
  assert.equal(held.from_text, null);
  assert.equal(held.to_text, "205 lb");
  const assist = liftMoveOf({ exercise: "Pull-Up", target_weight: -20 }, { ...before, target_weight: -30 });
  assert.equal(assist.direction, "up", "less assist is harder");
  assert.equal(assist.from_text, "30 lb assist");
  const added = liftMoveOf(
    { exercise: "Face Pull", change: "added", sets: 3, rep_low: 12, rep_high: 15, target_weight: 40 },
    null
  );
  assert.equal(added.direction, "added");
  assert.equal(added.to_text, "3 × 12–15 at 40 lb");
  assert.equal(liftMoveOf({ exercise: "Row", target_weight: 150 }, null), null, "no before, no invented move");
});

test("an empty ledger digests to nothing", () => {
  const digest = overnightDigest(TODAY);
  assert.equal(digest.as_of, TODAY);
  assert.deepEqual(digest.changes, []);
  assert.equal(digest.headline, null);
  assert.equal(digest.total_rows, 0);
});

test("the digest's total counts every qualifying change, past the capped list it carries", () => {
  for (let i = 0; i < 9; i++) {
    repo.recordDecision({
      effective_date: TODAY,
      kind: "training_target",
      domain: "training",
      summary: `A coaching change number ${i + 1}`,
      rationale: null,
      source: "test",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: false,
      input_fingerprint: null,
      context: null,
      action: { seed: `digest-total-${i}` },
      specialist: null,
      applied_at: `${TODAY}T09:00:00.000Z`,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  }
  const feedRows = brainChangesRead({ days: 3, asOf: TODAY })
    .days.flatMap((day) => day.changes)
    .filter((row) => row.state === "applied" || row.state === "announced");
  assert.ok(feedRows.length > 6, `the feed carries more than the digest's cap (${feedRows.length})`);
  const digest = overnightDigest(TODAY);
  assert.equal(digest.changes.length, 6, "the payload stays capped");
  assert.equal(digest.total_rows, feedRows.length, "but the total counts them all");
  assert.equal(digest.headline, `${feedRows.length} changes`);
});

test("a set-aside draft is housekeeping: the digest never carries it (Ask › Changes does)", () => {
  const draft = repo.createProposal("case_conference", "case conference: weekly", "", {
    summary: "Week of 2026-09-28: re-enter Back Squat at 185 x 3 x 5-7 behind a brace gate; hold.",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 185, reason: "brace gate" }],
  });
  repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: "A held draft was set aside instead of applied.",
    rationale: "A newer team review replaced this one.",
    source: "case_conference",
    source_ref_type: "plan_proposal",
    source_ref_key: String(draft.id),
    status: "superseded",
    autonomy_tier: "ask",
    risk_class: "low",
    reversible: false,
    input_fingerprint: null,
    context: { thaw_receipt: true, review_reason_code: "source_superseded" },
    action: { proposal_id: Number(draft.id), outcome: "superseded_by_newer_review" },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const digest = overnightDigest(TODAY);
  assert.equal("receipts" in digest, false);
  assert.deepEqual(digest.changes, []);
  assert.doesNotMatch(JSON.stringify(digest), /Set aside|brace gate|2026-09-28/);
});

test("each context tag says what it changes, worded from what the server does with it", () => {
  const vocab = contextTagVocab(TODAY);
  assert.deepEqual(
    vocab.map((t) => t.key),
    CONTEXT_TAG_VOCAB.map((t) => t.key)
  );
  for (const tag of vocab) assert.match(tag.effect, /isn't judged on it\.$/, tag.key);
  // Travel reads as a fueling disruption in the active-context engine: food targets hold.
  assert.match(contextTagEffect("travel", TODAY), /^Food targets hold/);
});

function recordWeekStructure(summary, before) {
  const id = repo.recordDecision({
    effective_date: TODAY,
    kind: "training_structure",
    domain: "training",
    summary,
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: {
      changes: [
        { day_number: 1, exercise: "Barbell Bench Press", sets: 4, rep_low: 6, rep_high: 8, change: "added", before: null },
        { day_number: 2, exercise: "Leg Press", sets: 3, rep_low: 10, rep_high: 12, change: "added", before: null },
      ],
    },
    specialist: null,
    applied_at: `${TODAY}T09:00:00.000Z`,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const decisionId = Number(id.decision.id);
  saveBrainRollback(decisionId, "training_plan", { version: 2, before, after: [] });
  return decisionId;
}

test("the first week composed onto an empty plan is not overnight news, and its Undo never promises a previous week", () => {
  // A real first-run walk: two minutes after the welcome revealed the first week, Today
  // read "Overnight · 24 lifts moved" with every lift "added" and a "Restore your previous
  // week" Undo — on an install that had never had a week.
  const id = recordWeekStructure("Your four lifting days stay where you train.", []);
  assert.equal(rollbackBuiltOnEmptyPlan(id), true);
  const digest = overnightDigest(TODAY);
  assert.equal(digest.changes.length, 0, "the first week is not a change to report");
  assert.equal(digest.headline, null);
  const row = brainChangesRead({ days: 3, asOf: TODAY })
    .days.flatMap((day) => day.changes)
    .find((change) => change.id === id);
  assert.ok(row, "Ask › Changes still carries it");
  assert.equal(row.undo.available, true);
  assert.equal(row.undo.label, "Remove this first week");
});

test("a restructure of an existing week stays in the digest with its restore Undo", () => {
  const before = [{ day_number: 1, name: "Full Body", items: [{ exercise: "Back Squat", sets: 3 }] }];
  const id = recordWeekStructure("A new split.", before);
  assert.equal(rollbackBuiltOnEmptyPlan(id), false);
  const digest = overnightDigest(TODAY);
  assert.equal(digest.changes.length, 1);
  const row = brainChangesRead({ days: 3, asOf: TODAY })
    .days.flatMap((day) => day.changes)
    .find((change) => change.id === id);
  assert.equal(row.undo.label, "Restore your previous week");
});
