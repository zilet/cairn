// The training-intelligence / performance read (src/repo/performance.ts) — the
// athletic counterpart to the health Standing. These lock the coach-level reads it
// must get right: each benchmark lift is read as a sex/age percentile + level
// (beginner→elite) against proven strength standards; a press-far-ahead-of-pull gap
// surfaces as an imbalance AND becomes the lever; a lift not tested near a max in a
// while is flagged for re-testing; a single-movement pattern earns a variety nudge;
// and — constitution — nothing leaks a 0-100 score.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "exercises",
    "plan_items",
    "plan_days",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "daily_metrics",
    "bodyweight_log",
    "profile"
  );
  repo.setProfile({ age: 44, sex: "male", height_cm: 178, weight_lb: 177 });
});

function logAcross(exercise, weight, reps, days) {
  for (const d of days) repo.logSetByName({ exercise, weight, reps, rir: 2, date: back(d) });
}

test("benchmarks a strong bench against sex/age strength standards as a percentile + level", () => {
  logAcross("Bench Press", 230, 3, [28, 21, 14, 7, 0]); // est-1RM ~253 lb → ~1.43× bodyweight
  const p = repo.performanceStanding(REF);
  const bench = (p.capacities || []).find((c) => c.key === "bench");
  assert.ok(bench, "bench is benchmarked");
  assert.equal(bench.age_band, "40s", "compared against the athlete's own age band");
  assert.ok(bench.est_1rm >= 245 && bench.est_1rm <= 260, "est-1RM is the Epley read");
  assert.ok(
    ["beginner", "novice", "intermediate", "advanced", "elite"].includes(bench.level),
    "a recognized level, not a score"
  );
  assert.ok(bench.percentile >= 60, `a strong bench reads high (got ${bench.percentile})`);
  assert.equal(bench.tone, "strong");
  // strength-only athlete → no endurance capacity block, no throw.
  assert.equal(p.endurance, null);
});

test("constitution: the read never leaks a 0-100 score field", () => {
  logAcross("Bench Press", 200, 3, [28, 21, 14, 7, 0]);
  logAcross("Back Squat", 300, 3, [27, 20, 13, 6, 0]);
  const json = JSON.stringify(repo.performanceStanding(REF));
  assert.ok(!/impact_score/.test(json), "no impact_score leak");
  assert.ok(!/"score"/.test(json), "no bare score field");
});

test("a press-far-ahead-of-pull gap surfaces as an imbalance and becomes the lever", () => {
  logAcross("Bench Press", 230, 3, [28, 21, 14, 7, 0]); // strong press (~p78)
  logAcross("Barbell Row", 90, 3, [27, 20, 13, 6, 0]); // weak pull (~p22)
  const p = repo.performanceStanding(REF);
  const imb = (p.imbalances || []).find((i) => /pressing is ahead of pulling/i.test(i.title));
  assert.ok(imb, "the press/pull imbalance is detected");
  assert.equal(imb.severity, "watch");
  assert.ok(p.lever, "a lever is surfaced");
  assert.equal(p.lever.headline, imb.title, "the injury-relevant imbalance is the lever");
});

test("a benchmark lift not tested near a max is flagged worth re-testing", () => {
  logAcross("Bench Press", 200, 8, [21, 14, 7, 0]); // only higher-rep work — never a ≤5-rep heavy test
  const p = repo.performanceStanding(REF);
  const t = (p.tests_due || []).find((x) => x.exercise === "Bench Press" && x.kind === "strength");
  assert.ok(t, "the un-tested benchmark lift is surfaced for a re-test");
  assert.ok(/re-?anchor|true max|heavy|re-?read/i.test(t.why), "the why frames it as re-measuring true capacity");
});

test("a recent ≤5-rep heavy effort means the lift is NOT flagged for re-testing", () => {
  logAcross("Bench Press", 230, 3, [28, 21, 14, 7, 0]); // tested heavy through back(0)
  const p = repo.performanceStanding(REF);
  assert.ok(!(p.tests_due || []).some((x) => x.exercise === "Bench Press"), "a freshly-tested lift isn't nagged");
});

test("a single-movement pattern over many sessions earns a gentle variety nudge", () => {
  logAcross("Back Squat", 225, 5, [0, 7, 14, 21, 28, 35, 42]); // 7 sessions, the only squat-pattern lift
  const p = repo.performanceStanding(REF);
  assert.ok(p.variety, "a variety nudge is surfaced");
  assert.ok(/Back Squat/.test(p.variety.note), "names the over-used movement");
  assert.ok((p.variety.suggestions || []).length > 0, "offers concrete same-pattern alternatives");
});

test("a calm empty read when nothing is logged — no throw, a warming-up hero", () => {
  const p = repo.performanceStanding(REF);
  assert.deepEqual(p.capacities, []);
  assert.equal(p.endurance, null);
  assert.ok(/warming up|log a few/i.test(p.hero.headline + " " + p.hero.sub), "a calm warming-up message");
});

test("a machine leg press is NOT graded against squat standards — it prompts a true back-squat test", () => {
  logAcross("Leg Press", 400, 5, [28, 21, 14, 7, 0]); // a leg press loads ~1.8× a back squat
  const p = repo.performanceStanding(REF);
  assert.ok(!(p.capacities || []).some((c) => c.key === "squat"), "leg press is not benchmarked as a squat");
  const t = (p.tests_due || []).find((x) => x.kind === "benchmark" && /squat/i.test(x.exercise));
  assert.ok(t, "instead it prompts logging a true back squat to measure the squat");
});

test("an RDL is not graded as a conventional deadlift; an assisted pull-up isn't a bodyweight pull", () => {
  logAcross("Romanian Deadlift", 250, 5, [28, 21, 14, 7, 0]);
  logAcross("Assisted Pull-Up", 90, 5, [27, 20, 13, 6, 0]);
  const p = repo.performanceStanding(REF);
  assert.ok(!(p.capacities || []).some((c) => c.key === "deadlift"), "an RDL isn't graded as a deadlift");
  assert.ok(
    !(p.capacities || []).some((c) => c.key === "pullup"),
    "an assisted pull-up isn't graded as a bodyweight pull"
  );
  assert.ok(
    (p.tests_due || []).some((x) => x.kind === "benchmark"),
    "both surface a 'log the true lift' prompt"
  );
});
