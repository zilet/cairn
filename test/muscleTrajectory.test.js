// Per-muscle-group advance/stall trajectory + the strength test-week cadence
// (src/repo/muscle-trajectory.ts) — the strength brain lifted to the athlete's
// mental model. These lock the reads it must get right: a climbing group reads
// 'advancing', a stuck-and-grinding group reads 'stalling' with a MENU of
// same-pattern variations to rotate in; the test-week cadence fires off a stale
// stamp and names the benchmark key lifts; and — constitution — nothing leaks a
// 0-100 score.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { ladderCallLine } from "../dist/repo/program-state.js";
import { unitPlateauLadder } from "../dist/repo/unit-plateau.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
};

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "exercises",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "checkins",
    "context_events",
    "program_blocks",
    "app_state",
    "profile"
  );
  repo.setProfile({ primary_discipline: "strength", age: 40, sex: "male", weight_lb: 180 });
});

// ── muscleGroupTrajectory ─────────────────────────────────────────────────────

test("muscleGroupTrajectory yields per-group verdicts — a climbing group advances, a stuck one stalls", () => {
  // Quads climbing (Back Squat est-1RM rising) → advancing.
  const sq = [225, 235, 245, 255, 265];
  [28, 21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: sq[i], reps: 5, rir: 2, date: back(d) }));
  // Chest stuck and grinding (Bench Press flat at RIR 0-1) → plateaued → stalling.
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));

  const t = repo.muscleGroupTrajectory(REF);
  assert.equal(t.available, true);
  assert.ok(typeof t.headline === "string" && t.headline.length > 0, "a plain-words headline");

  const quads = t.groups.find((g) => g.group === "quads");
  assert.ok(quads, "quads are read");
  assert.equal(quads.verdict, "advancing");
  assert.equal(quads.lead_lift, "Back Squat");

  const chest = t.groups.find((g) => g.group === "chest");
  assert.ok(chest, "chest is read");
  assert.equal(chest.verdict, "stalling");
  assert.equal(chest.lead_lift, "Bench Press");
  assert.ok(chest.stalled_signal && chest.stalled_signal.length > 0, "names the stall tell");

  // The headline says what leads in plain words, never a tally of verdicts. Shoulders and
  // triceps ride only on the bench (half shares): they read flat on their own cards but
  // are not named again in the headline, where chest already speaks for that lift.
  assert.equal(t.headline, "Quads are advancing; chest is flat.");
  const triceps = t.groups.find((g) => g.group === "triceps");
  assert.equal(triceps.verdict, "stalling");
  assert.equal(triceps.direct, false);
  assert.deepEqual(triceps.vary_options, [], "the chest card carries the bench's menu");
  assert.ok(!/\d/.test(t.headline), "no counts in the headline");

  NO_SCORE(t, "muscleGroupTrajectory");
});

// ── the group is read from ALL its lifts, led by its compound ─────────────────

const rising = (name, start, step, rir = 2) =>
  [28, 21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: name, weight: start + i * step, reps: 5, rir, date: back(d) }));
const stuck = (name, weight, reps = 5) =>
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: name, weight, reps, rir: 1, date: back(d) }));

test("the compound leads the group: one stalled accessory under an advancing squat reads advancing", () => {
  rising("Back Squat", 225, 10);
  stuck("Leg Extension", 100, 10);
  const quads = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "quads");
  assert.ok(quads, "quads are read");
  assert.equal(quads.verdict, "advancing", "a stuck leg extension does not stall the quads");
  assert.equal(quads.lead_lift, "Back Squat", "the squat leads, never the accessory");
  assert.equal(quads.lead_role, "compound");
  assert.equal(quads.lifts_read, 2);
  assert.deepEqual(quads.vary_options, []);
  assert.match(quads.note, /Leg Extension is flat/, "the accessory is named in the note at most");
});

test("the muscle's direction is the capability read's: a flat squat beside a climbing extension holds, said per movement", () => {
  // The group's verdict is the capability read's muscle verdict, and a muscle follows its
  // MAIN unit (the one carrying most of its recent work): a climbing extension beside a
  // flat squat does not make the quads read progressing. The flat squat is said where
  // movements are said: its own unit holds, and the program's adaptations name it.
  stuck("Back Squat", 275);
  rising("Leg Extension", 100, 10);
  const quads = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "quads");
  const st = repo.getProgramState(REF);
  const muscle = st.capability.muscles.find((m) => m.group === "quads");
  assert.equal(muscle.verdict, "holding", "precondition: the capability read has the quads holding with their main unit");
  assert.equal(quads.verdict, "stalling", "a holding muscle whose lead lift is flat reads stalling");
  assert.equal(quads.lead_lift, "Back Squat", "the compound still leads");
  assert.equal(st.capability.units.find((u) => u.key === "squat")?.verdict, "holding");
  // The program counts it holding. Its adaptations entry is the plateau ladder's lever and
  // nothing else, and the ladder judges a movement only through its PLAN lift: with no plan
  // written there is no plan lift to judge, so the holding squat gets no call (never a
  // second opinion from the lift's own stall tell).
  assert.match(st.headline, /1 holding/, st.headline);
  assert.ok(!st.adaptations_due.some((a) => /your squat work|Back Squat/.test(a)), st.adaptations_due.join(" | "));
  // With the squat on a written plan, the entry is exactly the ladder's line for its unit.
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 275 },
    { exercise: "Leg Extension", sets: 3, rep_low: 5, rep_high: 8, target_weight: 140 },
  ]);
  const planned = repo.getProgramState(REF);
  const rung = unitPlateauLadder(REF).units.find((u) => u.unit_key === "squat") ?? null;
  const expected = ladderCallLine(rung, "squat", "Back Squat");
  assert.deepEqual(
    planned.adaptations_due.filter((a) => /your squat work/.test(a)),
    expected ? [expected] : [],
    planned.adaptations_due.join(" | ")
  );
});

test("synergist credit counts: a climbing row leads biceps over a stuck curl, unless it only grazes them; the direction follows the main unit", () => {
  rising("Barbell Row", 135, 10);
  stuck("Barbell Curl", 75, 8);
  const credits = (bicepsShare) => (name) =>
    name === "Barbell Row"
      ? [
          { group: "back", share: 1, role: "primary" },
          { group: "biceps", share: bicepsShare, role: "secondary" },
        ]
      : name === "Barbell Curl"
        ? [{ group: "biceps", share: 1, role: "primary" }]
        : [];
  const strong = repo.muscleGroupTrajectory(REF, { creditFor: credits(0.5) }).groups.find((g) => g.group === "biceps");
  // The curl carries most of the biceps' recent work and it is stuck: the muscle holds.
  assert.equal(strong.verdict, "maintaining");
  assert.equal(strong.lead_lift, "Barbell Row");
  assert.equal(strong.lifts_read, 2);
  // A sliver never LEADS the group; its direction is the capability read's muscle verdict,
  // which reads its own credit table (the injected one shapes only the lead).
  const graze = repo.muscleGroupTrajectory(REF, { creditFor: credits(0.25) }).groups.find((g) => g.group === "biceps");
  assert.equal(graze.lead_lift, "Barbell Curl", "a lift crediting a sliver never speaks for the group");
  assert.equal(graze.verdict, "stalling", "a holding muscle led by its stuck curl reads stalling");
  // The back reads the row either way.
  const backRead = repo.muscleGroupTrajectory(REF, { creditFor: credits(0.5) }).groups.find((g) => g.group === "back");
  assert.equal(backRead.verdict, "advancing");
  assert.equal(backRead.lead_lift, "Barbell Row");
});

// A program state with these lifts and statuses, nothing else (no volume).
const liftState = (exercise, muscle_group, status) => ({
  exercise,
  muscle_group,
  mode: "reps",
  sessions: 6,
  est_1rm: 200,
  best_seconds: null,
  trend_per_wk: status === "progressing" ? 3 : 0,
  status,
  stall_signals: status === "plateaued" ? ["same top load 4 sessions running"] : [],
  weeks_static: status === "plateaued" ? 4 : null,
  suggested_action: status === "plateaued" ? "vary" : "overload",
  why: status === "plateaued" ? "Flat." : "Climbing.",
});
const stateOf = (lifts) => ({
  generated_for: REF,
  discipline: "strength",
  lifts,
  volume: [],
  mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" },
  endurance: null,
  hybrid: null,
  headline: "",
  adaptations_due: [],
});

test("touched (quarter) shares are never members: a deadlift does not make forearms or core flat", () => {
  // Deadlift, bent-over row and back squat plateaued; pull-ups climbing.
  const t = repo.muscleGroupTrajectory(REF, {
    programState: stateOf([
      liftState("Deadlift", "hamstrings", "plateaued"),
      liftState("Barbell Bent Over Row", "back", "plateaued"),
      liftState("Back Squat", "quads", "plateaued"),
      liftState("Pull-Up", "back", "progressing"),
    ]),
    recentRotations: [],
  });
  const by = (g) => t.groups.find((x) => x.group === g);
  assert.equal(by("forearms"), undefined, "every forearm credit here is a touched share");
  assert.equal(by("core"), undefined, "every core credit here is a touched share");
  assert.ok(!/Forearms|Core/.test(t.headline), t.headline);
  // Biceps: the row and the pull-up each lend a half share and move opposite ways, so
  // neither speaks for the group alone; the climbing pull-up is not outvoted.
  assert.equal(by("biceps").verdict, "advancing");
  assert.equal(by("biceps").lead_lift, "Pull-Up");
  assert.equal(by("biceps").direct, false, "biceps are read only through pulls here");
  // Back: the row (full) and the deadlift (half) are flat against one climbing pull-up,
  // so the weighted majority genuinely stalls, and the note still names the climber.
  assert.equal(by("back").verdict, "stalling");
  assert.equal(by("back").lead_lift, "Barbell Bent Over Row");
  assert.match(by("back").note, /Pull-Up is still climbing/);
  // Rear delts ride only on the row: flat, no menu of their own, never in the headline.
  assert.equal(by("rear delts").verdict, "stalling");
  assert.deepEqual(by("rear delts").vary_options, []);
  assert.match(by("rear delts").note, /work from Barbell Bent Over Row, which is flat for now/);
  // The headline names only groups with direct work of their own.
  assert.equal(t.headline, "Back, quads, and hamstrings are flat.");
  // Fewer lifts read than the old count that let quarter shares vote.
  assert.equal(by("glutes").lifts_read, 2, "deadlift and squat each lend glutes a counted half");
});

test("one climbing pull-up leads the back over a half-share deadlift that stalled", () => {
  const t = repo.muscleGroupTrajectory(REF, {
    programState: stateOf([liftState("Deadlift", "hamstrings", "plateaued"), liftState("Pull-Up", "back", "progressing")]),
    recentRotations: [],
  });
  const backRead = t.groups.find((g) => g.group === "back");
  assert.equal(backRead.verdict, "advancing");
  assert.equal(backRead.lead_lift, "Pull-Up");
});

test("the vary menu stays in the stalled lift's own region: never a deadlift for a leg curl", () => {
  stuck("Leg Curl", 100, 10);
  const hams = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "hamstrings");
  assert.ok(hams, "hamstrings are read");
  assert.equal(hams.verdict, "stalling");
  assert.equal(hams.lead_lift, "Leg Curl");
  assert.ok(
    hams.vary_options.every((o) => !/deadlift|rdl|good morning|swing/i.test(o.name)),
    `no hinge offered for a leg curl: ${hams.vary_options.map((o) => o.name).join(", ")}`
  );
  assert.ok(hams.vary_options.every((o) => repo.sameVaryRegion("Leg Curl", o.name)));
  assert.match(hams.note, /close variation or a lighter week/, "an empty menu still reads as a suggestion");
});

test("sameVaryRegion: region family for isolation lifts, compound-for-compound otherwise", () => {
  assert.equal(repo.sameVaryRegion("Leg Curl", "Romanian Deadlift"), false);
  assert.equal(repo.sameVaryRegion("Barbell Curl", "Hammer Curl"), true);
  assert.equal(repo.sameVaryRegion("Barbell Curl", "Leg Curl"), false);
  assert.equal(repo.sameVaryRegion("Tricep Pushdown", "Skull Crusher"), true);
  assert.equal(repo.sameVaryRegion("Tricep Pushdown", "Dips"), false);
  assert.equal(repo.sameVaryRegion("Bench Press", "DB Bench Press"), true);
  assert.equal(repo.sameVaryRegion("Bench Press", "Incline DB Press"), true);
  assert.equal(repo.sameVaryRegion("Bench Press", "DB Chest Fly"), false);
  assert.equal(repo.sameVaryRegion("Conventional Deadlift", "Romanian Deadlift"), true);
});

test("the headline names what leads, and names the flat groups", () => {
  const g = (group, verdict) => ({ group, label: group.charAt(0).toUpperCase() + group.slice(1), verdict });
  assert.equal(
    repo.trajectoryHeadline([g("chest", "advancing"), g("back", "advancing"), g("quads", "advancing"), g("triceps", "stalling"), g("calves", "stalling")]),
    "Most groups are advancing; triceps and calves are flat."
  );
  assert.equal(repo.trajectoryHeadline([g("chest", "advancing"), g("back", "advancing")]), "Every group is advancing.");
  assert.equal(repo.trajectoryHeadline([g("chest", "maintaining"), g("back", "maintaining")]), "Your groups are holding steady.");
  assert.equal(
    repo.trajectoryHeadline([g("chest", "stalling"), g("back", "stalling"), g("quads", "maintaining")]),
    "Chest and back are flat."
  );
});

test("a stalled group offers a MENU of same-pattern vary options to break the plateau", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  const chest = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(chest, "chest is read");
  assert.equal(chest.verdict, "stalling");
  assert.ok(chest.vary_options.length >= 2, "a menu (not one forced swap) of same-pattern options");
  assert.ok(chest.vary_options.every((o) => o.name && o.why), "each option names a movement + why it helps");
});

test("vary options never offer a movement already on the plan — variety means something NEW", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  // Baseline: the menu includes DB Bench Press for a stalled bench.
  const before = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(before.vary_options.some((o) => /db bench press/i.test(o.name)), "DB Bench Press is a natural option when un-programmed");
  // Program it → it must drop out of the menu ("rotate in what you already have" is a dead suggestion).
  repo.savePlanDay(2, "Push", "Push", [{ exercise: "DB Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70 }]);
  const after = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.equal(after.verdict, "stalling");
  assert.ok(!after.vary_options.some((o) => /db bench press/i.test(o.name)), "an already-programmed movement is excluded");
});

test("vary options also exclude a lift the brain just rotated OUT — never offer it straight back", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  // Baseline (no rotations): DB Bench Press is a natural same-pattern option.
  const baseline = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(baseline.vary_options.some((o) => /db bench press/i.test(o.name)), "DB Bench Press is a natural option");
  // Inject a recent rotation OUT of DB Bench Press — it must drop from the menu
  // (offering it back would undo the rotation the coach just made).
  const injected = repo
    .muscleGroupTrajectory(REF, { recentRotations: [{ from: "DB Bench Press" }] })
    .groups.find((g) => g.group === "chest");
  assert.equal(injected.verdict, "stalling");
  assert.ok(!injected.vary_options.some((o) => /db bench press/i.test(o.name)), "a just-rotated-out lift is excluded");
});

test("muscleGroupTrajectory is quiet when nothing is logged", () => {
  const t = repo.muscleGroupTrajectory(REF);
  assert.equal(t.available, false);
  assert.deepEqual(t.groups, []);
});

// ── testWeekDue ───────────────────────────────────────────────────────────────

test("testWeekDue fires due off a stale last-test-week stamp and names the benchmark key lifts", () => {
  // Two benchmark compounds with real history (≥3 sessions, an est-1RM each) but
  // FLAT recent loads — no new PRs, so the logged data reads as NO de-facto test
  // week and the stale cadence stamp is what drives the read (not the self-heal).
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 3, rir: 2, date: back(d) }));
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Deadlift", weight: 405, reps: 3, rir: 2, date: back(d) }));
  // Last test week ~9 weeks ago → past the ~7-week cadence.
  repo.setAppState("last_test_week", back(63));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, true, "a test week is due past the cadence");
  assert.ok(/weeks/i.test(tw.why), "the why frames the cadence in plain words");
  assert.ok(tw.key_lifts.length > 0, "names the benchmark lifts worth re-testing");
  assert.ok(tw.key_lifts.some((l) => /squat|deadlift/i.test(l)), "leads with benchmark compounds");
  assert.equal(tw.last_test_week, back(63), "carries the read-only last-test-week stamp");
  NO_SCORE(tw, "testWeekDue");
});

test("testWeekDue is NOT due shortly after a test week", () => {
  [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  repo.setAppState("last_test_week", back(7)); // a week ago → well inside the cadence
  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false, "not nagged a week after the last test");
});

test("testWeekDue stays quiet for an athlete with no benchmark history", () => {
  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false);
  assert.deepEqual(tw.key_lifts, []);
});

// ── K5 cadence: testWeekDue DEFERS to the attention engine (rule 2a) ───────────
// The recurring re-test is no longer a fixed 49-day interval. Once the K5 benchmark-
// attention pass runs, testWeekDue reads the tier machine: a cleanly-progressing
// athlete's test-week signal RELEASES → no scheduled test even when the old fixed
// cadence would fire; a plateau keeps it active and it fires when the window arrives.

test("a cleanly-progressing athlete converges to NO scheduled test week — a released K5 entry overrides the fixed cadence", () => {
  // Real benchmark history so key_lifts is non-empty (reaches the cadence branch).
  [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 315 + i * 5, reps: 3, rir: 2, date: back(d) }));
  // A stale stamp that the OLD fixed cadence would treat as due (~9 weeks).
  repo.setAppState("last_test_week", back(63));

  // The benchmark-attention pass on a clean, progressing lift releases the test-week signal.
  repo.refreshTrainingBenchmarkAttention(REF, {
    programState: {
      generated_for: REF, discipline: "strength",
      lifts: [{ exercise: "Back Squat", muscle_group: "legs", mode: "reps", sessions: 6, est_1rm: 335, best_seconds: null, trend_per_wk: 4, status: "progressing", stall_signals: [], weeks_static: null, suggested_action: "overload", why: "Climbing." }],
      volume: [], mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" }, endurance: null, hybrid: null, headline: "", adaptations_due: [],
    },
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: back(63) },
    enduranceTests: [],
  });
  const attn = repo.getAttentionSchedule("training:strength:test-week");
  assert.equal(attn?.tier, "released", "clean progress releases the test-week signal");

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false, "a released K5 entry overrides the fixed 49-day cadence — no forced test");
});

test("a plateau keeps the test week scheduled through K5 — due when the response window arrives", () => {
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 205, reps: 3, rir: 1, date: back(d) }));
  repo.setAppState("last_test_week", back(30)); // inside the old fixed cadence — the fixed path would NOT fire

  const plateaued = {
    generated_for: REF, discipline: "strength",
    lifts: [{ exercise: "Bench Press", muscle_group: "chest", mode: "reps", sessions: 6, est_1rm: 205, best_seconds: null, trend_per_wk: 0, status: "plateaued", stall_signals: ["same top load"], weeks_static: 4, suggested_action: "vary", why: "Flat." }],
    volume: [], mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" }, endurance: null, hybrid: null, headline: "", adaptations_due: [],
  };
  repo.refreshTrainingBenchmarkAttention(REF, { programState: plateaued, testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: back(30) }, enduranceTests: [] });
  const attn = repo.getAttentionSchedule("training:strength:test-week");
  assert.equal(attn?.tier, "active", "a plateau activates the test-week signal");

  // Before the response window → not yet due (a scheduled, not fixed, check).
  assert.equal(repo.testWeekDue(REF, { programState: plateaued }).due, false, "scheduled, not immediate");
  // Once next_due arrives → due.
  const arrived = new Date(new Date(attn.next_due + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  assert.equal(repo.testWeekDue(arrived, { programState: plateaued }).due, true, "fires when the scheduled window arrives");
});

// ── recordTestWeek (the writer that closes the loop) ──────────────────────────

test("recordTestWeek stamps the cadence date and is MONOTONIC — it never moves backwards", () => {
  const today = localDateISO();

  assert.equal(repo.recordTestWeek(back(60)), back(60), "returns the effective stamp");
  assert.equal(repo.getAppState("last_test_week"), back(60), "the stamp is written");

  // An OLDER date is ignored — the loop can't rewind onto a stale test week.
  assert.equal(repo.recordTestWeek(back(90)), back(60), "an older date is a no-op");
  assert.equal(repo.getAppState("last_test_week"), back(60));

  // A NEWER date advances the stamp.
  assert.equal(repo.recordTestWeek(back(10)), back(10), "a newer date advances");
  assert.equal(repo.getAppState("last_test_week"), back(10));

  // No arg stamps today (today > back(10)), and today's stamp holds.
  assert.equal(repo.recordTestWeek(), today, "no-arg stamps today");
  assert.equal(repo.getAppState("last_test_week"), today);
});

// ── testWeekDue read-time self-heal (data-driven de-facto test week) ───────────

test("testWeekDue self-heals the stamp from a de-facto test week — PRs on ≥2 key lifts inside a week close the loop", () => {
  // A stale (or missing) stamp would normally read "due"...
  repo.setAppState("last_test_week", back(63));
  // ...but the logged history shows new est-1RM maxes landing on TWO benchmark
  // lifts within the same week (Back Squat back(2), Deadlift back(0)) — a de-facto
  // test week. Each lift has ≥3 sessions with a rising top set.
  [30, 16, 2].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  [30, 14, 0].forEach((d, i) => repo.logSetByName({ exercise: "Deadlift", weight: 400 + i * 10, reps: 3, rir: 2, date: back(d) }));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.last_test_week, back(0), "the stamp self-heals to the window's most recent PR date");
  assert.equal(repo.getAppState("last_test_week"), back(0), "and it's persisted");
  assert.equal(tw.due, false, "no nag right after a de-facto test week");
});

test("testWeekDue does NOT self-heal off a SINGLE lift PRing — a de-facto test week needs ≥2 lifts", () => {
  repo.setAppState("last_test_week", back(63));
  // Only Back Squat sets new maxes; Deadlift is flat (a real key lift, but no PRs).
  [30, 16, 2].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  [21, 14, 0].forEach((d) => repo.logSetByName({ exercise: "Deadlift", weight: 405, reps: 3, rir: 2, date: back(d) }));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.last_test_week, back(63), "one lift climbing is normal overload, not a test week");
  assert.equal(repo.getAppState("last_test_week"), back(63), "the stale stamp is untouched");
  assert.equal(tw.due, true, "the cadence is still due off the stale stamp");
});
