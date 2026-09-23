// The weekly run engine delivers the race ladder it shows.
//
// The case (a supporting-role, three-run athlete: Tue easy, Thu quality, weekend long;
// a Sunday half about six weeks out, read in the ramp's reset week): the ladder climbed
// toward its peak while the engine, run week by week, actually prescribed a flat week.
// The lone easy run was pinned at 7 km and the long run at the distance already run, so
// every kilometre past what those caps hold was simply dropped — and the fit sentence
// walked forward from taper weeks, ending race week on "reset the goal".
//
//   • a lone easy run beside a quality session is the week's aerobic volume day: its cap
//     scales with the week and one step past the longest mid-week run already run;
//   • the ladder projects each week in the SAME runs and caps (deliverableRunWeek), so a
//     rung is what the engine will prescribe, not a volume three runs cannot hold;
//   • a prescribed week never trips the engine's own spike brake the Monday after;
//   • a reset is recovery, not lost ground, in the fit read too — and the fit is silent
//     in the taper, where the build is already behind the athlete;
//   • run INTENSITY is untouched: an easy run is still easy, still Z2.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { parseRaceTarget, raceBuild } from "../dist/repo/race-build.js";
import { RUN_ACWR_CEILING_VARIANTS, TIMELINE_CLOSE_VARIANTS, TIMELINE_FIT_VARIANTS } from "../dist/repo/run-progression.js";
import {
  deliverableRunWeek,
  easyRunCapKm,
  RECOVERY_EASY_CAP_KM,
  raceRamp,
  recoveryEasyCapKm,
} from "../dist/repo/run-ramp.js";

const RACE = "2031-11-02"; // a Sunday
const HALF = 21.1;
const TODAY = "2031-09-24"; // Wednesday of the ramp's reset week
const goal = { is_race: true, date: RACE, distance_km: HALF, target: "sub-2:05 target; 1:55 stretch" };

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "sessions",
    "plan_items",
    "plan_days",
    "program_blocks",
    "app_state",
    "profile"
  );
});

const km = (plan) => Math.round(plan.runs.reduce((s, r) => s + (Number(r.target_distance_km) || 0), 0) * 10) / 10;
const ofKind = (plan, kind) => plan.runs.filter((r) => r.kind_label === kind);
const longOf = (plan) => Number(ofKind(plan, "long")[0]?.target_distance_km ?? 0);
const run = (date, distance) => repo.addActivity({ type: "run", duration_min: Math.round(distance * 6), distance_km: distance, date });
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const timelineLine = (plan) =>
  plan.rationale.find((line) =>
    [...TIMELINE_FIT_VARIANTS, ...TIMELINE_CLOSE_VARIANTS].some((say) => {
      const probe = say(111, 222);
      const head = probe.slice(0, probe.indexOf("111"));
      return head.length > 0 && line.startsWith(head);
    })
  ) ?? null;

// A synthetic shape: a supporting runner, three stated run days, the mid-week runs
// 4–10 km, a 17.6 km long run the Sunday before the ramp's reset week.
function seedSupportingRunner() {
  repo.setProfile({
    age: 38,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["longevity", "muscle", "strength", "leanness", "endurance"], endurance_role: "supporting" },
    endurance_goal: { mode: "race", event: "City Half", date: RACE, distance_km: HALF, target: goal.target },
    endurance_schedule: {
      days: [
        { dow: 0, kind: "long" },
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 6, kind: "long" },
      ],
      source: "athlete",
    },
  });
  for (const [date, distance] of [
    ["2031-08-19", 7.1],
    ["2031-08-21", 6.5],
    ["2031-08-26", 7.0],
    ["2031-08-28", 9.7],
    ["2031-08-31", 10.6],
    ["2031-09-02", 4.7],
    ["2031-09-04", 6.2],
    ["2031-09-09", 5.8],
    ["2031-09-11", 4.7],
    ["2031-09-13", 12.8],
    ["2031-09-16", 5.1],
    ["2031-09-18", 9.6],
    ["2031-09-21", 17.6],
    ["2031-09-23", 4.3],
  ])
    run(date, distance);
}

// Run a week exactly as the engine prescribed it (the days after `after` only), the
// way the athlete following the plan would.
function runAsPrescribed(plan, after) {
  for (const r of plan.runs) {
    const date = addDays(plan.week_start, Number(r.day_number) - 1);
    if (date > after) run(date, Number(r.target_distance_km));
  }
}

// Walk the engine from this week to race week, each week run as prescribed.
function walkEngine() {
  const weeks = [];
  let monday = "2031-09-22";
  while (monday <= "2031-10-27") {
    const asked = monday === "2031-09-22" ? TODAY : monday;
    const plan = repo.weeklyRunPlan(asked);
    weeks.push({ monday, plan, spikingBefore: repo.getProgramState(asked).endurance?.status === "spiking" });
    runAsPrescribed(plan, monday === "2031-09-22" ? TODAY : addDays(monday, -1));
    monday = addDays(monday, 7);
  }
  return weeks;
}

// ── the per-run caps (pure) ─────────────────────────────────────────────────────

test("a lone easy run beside a quality session scales with the week and what was run mid-week", () => {
  // No mid-week run on record: exactly the recovery band it always was.
  assert.equal(easyRunCapKm(36, 17.6, null), recoveryEasyCapKm(17.6));
  assert.equal(recoveryEasyCapKm(17.6), RECOVERY_EASY_CAP_KM);
  // A 9.6 km mid-week run on record: one step past it, inside 35% of the week and 70%
  // of the long run — the binding cap here is the one step.
  assert.equal(easyRunCapKm(36, 17.6, 9.6), 11.0);
  // A thin week keeps it small (35% of 20 km), and never under the recovery band.
  assert.equal(easyRunCapKm(20, 12, 9.6), 7.0);
  assert.equal(easyRunCapKm(14, 6, 9.6), recoveryEasyCapKm(6), "never below the band it replaced");
  // Never a second long run: 70% of the long run caps it.
  assert.ok(easyRunCapKm(60, 14, 30) <= 14 * 0.7 + 0.05);
});

test("a week's deliverable volume is what its runs can carry, and nothing is piled onto the long run", () => {
  const three = { easy_runs: 1, quality: true };
  const d = deliverableRunWeek(41.0, 17.5, three, 9.6);
  assert.equal(d.long_km, 17.5, "the long run keeps the ladder's distance");
  assert.equal(d.easy_km, 11.0, "the easy run takes its cap");
  assert.ok(d.km < 41.0, `three runs do not hold 41 km at these caps (got ${d.km})`);
  assert.equal(d.km, Math.round((d.long_km + d.quality_km + d.easy_km) * 10) / 10);
  // With two easy runs the remainder is shared and the caps do not bind.
  const four = deliverableRunWeek(41.0, 17.5, { easy_runs: 2, quality: true }, 9.6);
  assert.ok(Math.abs(four.km - 41.0) <= 0.2, `four runs carry the week (got ${four.km})`);
});

// ── the fit (pure) ───────────────────────────────────────────────────────────────

test("a reset is recovery, not lost ground, in the fit read too", () => {
  // The reset week: 32.3 km paused, three build weeks to the peak week after it.
  const volume = raceRamp(goal, "2031-09-22", 32.3, 17.6);
  assert.equal(volume.down_week, true);
  // Charged 25% for the reset the walk read ~38 km ("stretch"); paused, the same runway
  // reaches the peak: 32.3 × 1.12³ ≈ 45.4, capped at 42.2.
  assert.equal(volume.fit, "fits");
  assert.equal(volume.constrained_peak_km, volume.ideal_peak_km);
  // In the athlete's own three runs it lands short of that — and says where.
  const inRuns = raceRamp(goal, "2031-09-22", 32.3, 17.6, {
    shape: { easy_runs: 1, quality: true },
    demonstratedMidweekKm: 9.6,
  });
  assert.equal(inRuns.fit, "stretch");
  assert.ok(inRuns.constrained_peak_km >= 36 && inRuns.constrained_peak_km < 42.2, `${inRuns.constrained_peak_km}`);
  // Nothing the athlete is asked for this week moves with the capacity read.
  assert.equal(inRuns.required_km, volume.required_km);
  assert.equal(inRuns.required_long_km, volume.required_long_km);
});

test("in the taper the peak is read back, never walked forward from a taper week", () => {
  // Race week off a 26 km final taper week: the peak behind it was ~37, not 26.
  const raceWeek = raceRamp(goal, "2031-10-27", 26.0, 17.5);
  assert.equal(raceWeek.constrained_peak_km, 37.1);
  // The final taper week off a 37.1 km peak week: the peak IS last week.
  const finalTaper = raceRamp(goal, "2031-10-20", 37.1, 17.5);
  assert.equal(finalTaper.constrained_peak_km, 37.1);
});

// ── the engine, on the synthetic shape ──────────────────────────────────────────

test("the three-run week carries the volume it asks for", () => {
  seedSupportingRunner();
  runAsPrescribed(repo.weeklyRunPlan(TODAY), TODAY); // the reset week, run as written
  const plan = repo.weeklyRunPlan("2031-09-29");
  const [easy] = ofKind(plan, "easy");
  assert.ok(easy, plan.runs.map((r) => r.kind_label).join(","));
  assert.ok(Number(easy.target_distance_km) > RECOVERY_EASY_CAP_KM, `the easy run is not pinned at 7 km (${easy.target_distance_km})`);
  assert.ok(Number(easy.target_distance_km) <= longOf(plan), "and it is never longer than the long run");
  assert.ok(km(plan) >= 32, `the week holds its ask (got ${km(plan)} km)`);
  // Easy stays easy: the same Z2 tag and wording the long run carries.
  assert.equal(easy.target_zone, ofKind(plan, "long")[0].target_zone);
  assert.match(easy.note, /Easy aerobic/);
});

test("the ladder is what the engine prescribes, week by week, all the way to race week", () => {
  seedSupportingRunner();
  const ladder = raceBuild(TODAY).weeks;
  const engine = walkEngine();
  assert.deepEqual(
    ladder.map((w) => w.week_start),
    engine.map((w) => w.monday)
  );
  for (const [i, w] of ladder.entries()) {
    if (w.kind === "race") continue; // race week: the race itself is the week's work
    const prescribed = km(engine[i].plan);
    assert.ok(
      Math.abs(prescribed - w.km) <= 1.0,
      `${w.week_start} (${w.kind}): the ladder shows ${w.km} km, the engine prescribes ${prescribed} km`
    );
    assert.ok(
      Math.abs(longOf(engine[i].plan) - w.long_km) <= 1.0,
      `${w.week_start}: ladder long ${w.long_km}, engine long ${longOf(engine[i].plan)}`
    );
  }
  // …and the build genuinely climbs: past the 31 km the old caps held every week at.
  const peak = ladder.find((w) => w.kind === "peak");
  assert.ok(peak.km > 35, `peak rung ${peak.km}`);
});

test("a week the engine prescribes never trips its own spike brake the Monday after", () => {
  seedSupportingRunner();
  const engine = walkEngine();
  for (const w of engine.slice(1)) assert.equal(w.spikingBefore, false, `${w.monday} opens reading as a spike`);
  // The resume after the reset is where it binds: the paused 32.3 km is the step, not
  // 32.3 × 1.1 off a month that had a lighter stretch in it — and it says so, calmly.
  const resume = engine[1].plan;
  assert.ok(km(resume) <= 33, `${km(resume)} km`);
  assert.ok(resume.rationale.some((l) => RUN_ACWR_CEILING_VARIANTS.includes(l)), resume.rationale.join(" | "));
});

test("the taper keeps the race curve's long run, and the easy runs come down to meet it", () => {
  seedSupportingRunner();
  const engine = walkEngine();
  const finalTaper = engine.find((w) => w.monday === "2031-10-20").plan;
  const rampLong = raceRamp(goal, "2031-10-20", 37, 17.5).required_long_km; // 0.55 × the long-run peak
  assert.ok(longOf(finalTaper) <= rampLong + 0.05, `taper long ${longOf(finalTaper)} over the curve's ${rampLong}`);
  for (const e of ofKind(finalTaper, "easy")) {
    assert.ok(Number(e.target_distance_km) <= longOf(finalTaper), `easy ${e.target_distance_km} over the long run`);
  }
});

test("the fit is read in the athlete's own runs, and is silent once the taper starts", () => {
  seedSupportingRunner();
  const ladder = raceBuild(TODAY).weeks;
  const peak = ladder.find((w) => w.kind === "peak");
  const today = repo.weeklyRunPlan(TODAY);
  assert.equal(today.goal_feasibility.status, "stretch");
  // The ordinary week (quality in, even though this reset week sits it out), and the
  // longest mid-week run of the anchored 28 days: Thursday 8/28's 9.7 km.
  assert.deepEqual(today.goal_feasibility.capacity, { easy_runs: 1, quality: true, demonstrated_midweek_km: 9.7 });
  assert.ok(
    Math.abs(today.goal_feasibility.constrained_peak_km - peak.km) <= 1.0,
    `the fit says ${today.goal_feasibility.constrained_peak_km} km, the ladder peaks at ${peak.km}`
  );
  assert.ok(timelineLine(today), "a build week names the gap");

  const engine = walkEngine();
  for (const w of engine.filter((x) => x.monday >= "2031-10-20")) {
    assert.equal(timelineLine(w.plan), null, `${w.monday}: ${timelineLine(w.plan)}`);
  }
});

test("both wordings of the race target parse", () => {
  assert.equal(parseRaceTarget("1:55 target; sub-1:50 stretch", HALF).sec, 6900);
  assert.equal(parseRaceTarget("sub-2:05 target; 1:55 stretch", HALF).sec, 7500);
});
