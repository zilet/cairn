// The GOAL-ANCHORED half of run planning: src/repo/run-ramp.ts (pure arithmetic)
// and the way weeklyRunPlan lets it pull — never push — the weekly build.
//
// The bug these lock down: run planning was purely reactive, so a dated race with a
// time on it was decorative. An athlete 13 weeks out from a half, having comfortably
// run 9.1 km, was prescribed 14 km/wk with a 4.9 km "long run" — a plan stepping 10%
// off last week forever and arriving nowhere near race mileage, while never saying so.
//
// Three rules the tests exist to defend:
//   • the ramp PULLS ONLY. Every protective branch (taper, deload, recovery-down,
//     mileage spike, scheduled down week, health hold) still wins outright.
//   • the WEEKLY ASK always comes from the constrained trajectory — the fastest safe
//     path from what the athlete is already doing. An out-of-reach destination must
//     never become an out-of-reach weekly number; a goal is not a quota.
//   • the gap between that trajectory and what the distance usually leans on is said
//     as a FIT and two real options, never as "behind" and never as a demand.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { peakLongKm, peakWeeklyKm, raceRamp, SUSTAINABLE_WEEKLY_BUILD_FACTOR } from "../dist/repo/run-ramp.js";
import {
  RACE_VS_SUPPORTING_VARIANTS,
  TIMELINE_CLOSE_VARIANTS,
  RAMP_RATE_NEAR_VARIANTS,
  RAMP_RATE_STEEP_VARIANTS,
  TIMELINE_FIT_VARIANTS,
} from "../dist/repo/run-progression.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

// The athlete this round was built for: Cambridge Half, 2026-11-01, 1:50 target.
const REF = "2026-08-05"; // 88 days out → 13 weeks
const RACE = "2026-11-01";
const HALF_KM = 21.1;

const raceGoal = (over = {}) => ({
  mode: "race",
  is_race: true,
  event: "Cambridge Half",
  date: RACE,
  distance_km: HALF_KM,
  target: "1:50",
  phase: "build",
  weeks_to_race: 13,
  weekly_km: null,
  weekly_sessions: null,
  ...over,
});

// weeklyRunPlan reads its whole world through opts, so the integration cases inject
// it rather than seeding a database into the exact shape they need. anchorKm is
// max(compliance.actual_km, trailing-7-day logged km) — with no activities seeded,
// the injected compliance IS the anchor.
const planOpts = (over = {}) => ({
  goal: raceGoal(over.goal),
  compliance: { actual_km: 17, prescribed_km: 14, ...over.compliance },
  // This file drives weeklyRunPlan entirely on injected inputs — the activities table
  // is wiped before every test — so the programState below IS the week, not an echo of
  // something on disk. Saying so explicitly is what lets the injected longest_km_4wk be
  // honoured: an injected state on its own now reads as economy (coach.ts hands one in
  // purely to avoid computing it twice) and yields to the anchored read, and only a
  // caller that also NAMES its week keeps the last word. The value is the default
  // anchor for this REF — the Sunday before its Monday — so nothing else moves.
  volumeAnchorDate: "2026-08-02",
  programState: {
    endurance: { sport: "run", longest_km_4wk: 9.1, has_quality: false, status: "building" },
    mesocycle: { phase: "accumulation" },
    recovery_week: { state: "none" },
    ...over.programState,
  },
  recovery: over.recovery ?? {},
  block: { week_index: 1 }, // ordinal 1 → not the every-4th scheduled down week
  zones: { available: false, zones: [] },
  directives: [],
  responseModifier: null,
  trainingIntent: { endurance_role: "primary", source: "explicit", ...over.trainingIntent },
});

const totalKm = (plan) =>
  Math.round(plan.runs.reduce((sum, run) => sum + (Number(run.target_distance_km) || 0), 0) * 10) / 10;
const longRun = (plan) => plan.runs.find((run) => run.kind_label === "long");

beforeEach(() => {
  resetTables("activities", "garmin_activities", "garmin_daily_metrics", "plan_items", "plan_days", "profile");
  repo.setProfile({ age: 44, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
});

// ── raceRamp: the arithmetic on its own ──────────────────────────────────────

test("peak weekly volume bands by race distance, and short races get no ramp at all", () => {
  assert.equal(peakWeeklyKm(HALF_KM), 42.2, "a half asks for ~2× its own distance");
  assert.equal(peakWeeklyKm(42.2), 45, "a marathon is clamped at the 45 km ceiling");
  assert.equal(peakWeeklyKm(10), 22, "a 10k is a higher multiple of a shorter distance");
  assert.equal(peakWeeklyKm(5), null, "a 5k is not trained by a mileage curve");
  assert.equal(peakWeeklyKm(7.9), null);
  assert.equal(peakLongKm(HALF_KM), 17.9);
  assert.equal(peakLongKm(42.2), 20, "the long run is capped at 20 km whatever the race");
});

test("a half 13 weeks out from a 14 km anchor: the ideal is out of reach, and the ASK is not", () => {
  const ramp = raceRamp(raceGoal(), REF, 14, 9.1);
  assert.ok(ramp, "a dated half with a distance produces a ramp");
  assert.equal(ramp.weeks_to_race, 13);
  assert.equal(ramp.ideal_peak_km, 42.2, "what the distance usually leans on");
  assert.ok(
    ramp.needed_build_factor > SUSTAINABLE_WEEKLY_BUILD_FACTOR,
    `arriving on the ideal curve would take a bigger sustained step than is safe (got ${ramp.needed_build_factor})`
  );
  assert.equal(ramp.feasible, false);
  assert.ok(
    ramp.ideal_required_km / 14 > SUSTAINABLE_WEEKLY_BUILD_FACTOR,
    `and the ideal curve's ask for this week would be past the ceiling (${ramp.ideal_required_km} km)`
  );

  // THE POINT: what the athlete is actually asked for is one safe step, never the
  // unreachable number. A goal that cannot be reached must not become a quota.
  assert.equal(ramp.required_km, 15.7, "the ask is 14 km × 1.12 — reachable by construction");
  assert.ok(
    ramp.required_km <= 14 * SUSTAINABLE_WEEKLY_BUILD_FACTOR + 0.05,
    "inside the ceiling, allowing the 0.1 km rounding step"
  );
  assert.ok(ramp.required_long_km <= 9.1 * 1.15 + 0.05, "and the long run is one safe step too");

  // The gap is reported rather than demanded.
  assert.equal(ramp.fit, "beyond_horizon");
  assert.ok(
    ramp.constrained_peak_km > 14 && ramp.constrained_peak_km < ramp.ideal_peak_km,
    `the fastest safe build lands somewhere real (got ${ramp.constrained_peak_km} km/wk)`
  );
});

test("the same half 20 weeks out from a 25 km anchor reaches what the distance leans on", () => {
  const ramp = raceRamp(raceGoal({ weeks_to_race: 20, date: null }), REF, 25, 14);
  assert.ok(ramp);
  assert.equal(ramp.weeks_to_race, 20);
  assert.equal(ramp.fit, "fits", "the reachable trajectory gets all the way there");
  assert.equal(ramp.constrained_peak_km, ramp.ideal_peak_km);
  assert.ok(
    ramp.required_km <= 25 * SUSTAINABLE_WEEKLY_BUILD_FACTOR + 0.05,
    `this week is still one safe step (got ${ramp.required_km} km)`
  );
});

test("a comfortable runway asks for LESS than the ceiling — a goal is not a quota", () => {
  // 40 weeks out at 30 km/wk: the ideal curve needs a gentle step, so that is what
  // the week is asked for. The ceiling exists as a limit, not as a target.
  const ramp = raceRamp(raceGoal({ weeks_to_race: 40, date: null }), REF, 30, 15);
  assert.equal(ramp.fit, "fits");
  assert.ok(
    ramp.required_km < 30 * SUSTAINABLE_WEEKLY_BUILD_FACTOR,
    `a long runway steps gently (got ${ramp.required_km} km off a 30 km anchor)`
  );
  assert.equal(ramp.required_km, ramp.ideal_required_km, "and follows the ideal curve while it is reachable");
});

test("the taper is shaped backwards from race day, and steps DOWN from where they are", () => {
  const at = (weeks) => raceRamp(raceGoal({ weeks_to_race: weeks, date: null }), REF, 30, 15);
  assert.equal(at(2).ideal_required_km, 42.2, "the ideal curve peaks two weeks out");
  assert.equal(at(2).peak_long_km, 17.9, "the long run the ideal curve climbs toward");
  assert.ok(
    at(2).required_long_km <= 15 * 1.15 + 0.05 && at(2).required_long_km > 15,
    `but the long run ASKED for is one safe step off the demonstrated 15 km (got ${at(2).required_long_km})`
  );
  assert.ok(at(2).required_km <= 30 * SUSTAINABLE_WEEKLY_BUILD_FACTOR + 0.05, "but the ASK is still one safe step");
  assert.ok(at(1).required_km < 30, "the week before the race tapers below the anchor");
  assert.ok(at(0).required_km < at(1).required_km, "and race week is lighter still");
  assert.ok(at(0).required_long_km < at(1).required_long_km, "the long run comes down with it");
});

test("a reset week every fourth, counting back from the peak", () => {
  const down = [];
  for (let weeks = 2; weeks <= 18; weeks++) {
    if (raceRamp(raceGoal({ weeks_to_race: weeks, date: null }), REF, 30, 15).down_week) down.push(weeks);
  }
  assert.deepEqual(down, [6, 10, 14, 18], "cadence anchored to the race, and never the peak week itself");
  const reset = raceRamp(raceGoal({ weeks_to_race: 6, date: null }), REF, 30, 15);
  assert.ok(reset.required_km < 30, "a reset week asks for less than the anchor, not more");
});

test("the three fit bands describe the calendar, and never the athlete", () => {
  const fitOf = (anchor, weeks) => raceRamp(raceGoal({ weeks_to_race: weeks, date: null }), REF, anchor, 9.1).fit;
  assert.equal(fitOf(25, 20), "fits", "enough runway and enough base");
  assert.equal(fitOf(14, 13), "beyond_horizon", "a thin base on a short runway lands somewhere else");
  // Somewhere in between there is a band where the gap is small enough to leave open.
  const stretch = [];
  for (let anchor = 10; anchor <= 30; anchor += 0.5) if (fitOf(anchor, 13) === "stretch") stretch.push(anchor);
  assert.ok(stretch.length > 0, "the middle band is reachable, not a dead branch");
  const ramp = raceRamp(raceGoal({ weeks_to_race: 13, date: null }), REF, stretch[0], 9.1);
  assert.ok(
    ramp.constrained_peak_km >= 0.85 * ramp.ideal_peak_km && ramp.constrained_peak_km < ramp.ideal_peak_km,
    "a stretch sits within ~15% of what the distance leans on"
  );
});

test("raceRamp stays quiet when there is nothing to arrive at", () => {
  assert.equal(raceRamp(null, REF, 20, 9), null);
  assert.equal(raceRamp(raceGoal({ is_race: false }), REF, 20, 9), null, "a standing goal has no arrival date");
  assert.equal(raceRamp(raceGoal({ distance_km: null }), REF, 20, 9), null, "no distance, no curve");
  assert.equal(raceRamp(raceGoal({ distance_km: 5 }), REF, 20, 9), null, "a 5k is not a mileage problem");
  assert.equal(raceRamp(raceGoal({ date: "2026-07-01" }), REF, 20, 9), null, "a race already run");
});

test("with no long run on record the ramp seeds one instead of demanding a leap", () => {
  const ramp = raceRamp(raceGoal(), REF, 20, 0);
  assert.ok(
    ramp.required_long_km > 0 && ramp.required_long_km < 12,
    `a sane first long run (got ${ramp.required_long_km})`
  );
});

// ── weeklyRunPlan: the ramp pulling, and everything that outranks it ──────────

test("weeklyRunPlan: the race pulls an ordinary build week up to the sustainable ceiling", () => {
  const withRace = repo.weeklyRunPlan(REF, planOpts());
  // The identical week with a race short enough that mileage is not the limiter —
  // no ramp, so the plain ~10% build stands.
  const reactive = repo.weeklyRunPlan(REF, planOpts({ goal: { distance_km: 5 } }));
  assert.ok(withRace.available && reactive.available);
  assert.ok(
    totalKm(withRace) > totalKm(reactive),
    `the race pulls the week up (${totalKm(withRace)} km vs ${totalKm(reactive)} km)`
  );
  assert.ok(
    Math.abs(totalKm(withRace) - 17 * SUSTAINABLE_WEEKLY_BUILD_FACTOR) <= 0.3,
    `and stops exactly at the ceiling — 17 km × 1.12 (got ${totalKm(withRace)} km)`
  );
  assert.ok(
    withRace.rationale.some((line) => /week[s]? out/i.test(line)),
    "the bigger step is explained by the race, in plain words"
  );
});

test("weeklyRunPlan: a recovery-down week is NOT raised by the ramp", () => {
  const green = repo.weeklyRunPlan(REF, planOpts());
  const down = repo.weeklyRunPlan(REF, planOpts({ recovery: { delta: { hrv: -12, rhr: 4, sleep: -45 } } }));
  assert.ok(totalKm(down) < 17, `a protective week eases below the anchor (got ${totalKm(down)} km)`);
  assert.ok(totalKm(down) < totalKm(green), "and stays well under the ramped week");
  assert.ok(
    !down.rationale.some((line) => /week[s]? out/i.test(line)),
    "the race never gets to explain a week it did not shape"
  );
});

// firmHold is caught by the 0.9 cap that runs after the pull, but softHold caps
// nothing — so an UNCERTAIN endurance-limiting flag was being contradicted in the
// same breath: the week said "easing while ferritin recovers" and stepped the build
// 1.10 → 1.12 anyway. Safety states are final whether or not they are certain.
test("weeklyRunPlan: an UNCERTAIN health hold also stops the ramp pulling", () => {
  const SOFT_HOLD = {
    domain: "training",
    marker: "Ferritin",
    directive: "Ease running while ferritin recovers.",
    citation: null,
    uncertain: true,
  };
  const ramped = repo.weeklyRunPlan(REF, planOpts());
  const held = repo.weeklyRunPlan(REF, { ...planOpts(), directives: [SOFT_HOLD] });
  assert.ok(ramped.available && held.available);
  assert.ok(totalKm(ramped) > 17 * 1.1, `the reference week is genuinely ramped (got ${totalKm(ramped)} km)`);
  assert.ok(
    totalKm(held) < totalKm(ramped),
    `an uncertain hold is not raced past (${totalKm(held)} km vs ${totalKm(ramped)} km)`
  );
  assert.ok(
    totalKm(held) <= 17 * 1.1 + 0.3,
    `it keeps the ordinary ~10% build, never the race step (got ${totalKm(held)} km)`
  );
  assert.ok(
    !held.rationale.some((line) => /week[s]? out/i.test(line)),
    "and the race never explains a week a health flag is holding"
  );
});

test("weeklyRunPlan: a scheduled down week and a mileage spike also outrank the ramp", () => {
  const scheduled = repo.weeklyRunPlan(REF, { ...planOpts(), block: { week_index: 4 } });
  assert.ok(totalKm(scheduled) < 17, `the every-fourth reset still resets (got ${totalKm(scheduled)} km)`);
  const spiking = repo.weeklyRunPlan(
    REF,
    planOpts({
      programState: { endurance: { sport: "run", longest_km_4wk: 9.1, has_quality: true, status: "spiking" } },
    })
  );
  assert.ok(totalKm(spiking) <= 17.2, `a spiking athlete holds where they are (got ${totalKm(spiking)} km)`);
});

test("weeklyRunPlan: a demonstrated long run is a floor, not just a ceiling", () => {
  const plan = repo.weeklyRunPlan(REF, planOpts());
  const long = longRun(plan);
  assert.ok(long, "the week has a long run");
  const ramp = raceRamp(raceGoal(), REF, 17, 9.1);
  assert.ok(
    long.target_distance_km >= Math.min(9.1, ramp.required_long_km),
    `a comfortable 9.1 km is never prescribed back down (got ${long.target_distance_km} km)`
  );
  assert.ok(
    long.target_distance_km <= 9.1 * 1.15 + 0.05,
    `and never jumps more than a step past it (got ${long.target_distance_km} km)`
  );
});

test("weeklyRunPlan: the long-run floor does not apply on a protected week", () => {
  const down = repo.weeklyRunPlan(REF, planOpts({ recovery: { delta: { hrv: -12, rhr: 4, sleep: -45 } } }));
  const long = longRun(down);
  assert.ok(
    long.target_distance_km < 9.1,
    `a recovery week owns the long run outright (got ${long.target_distance_km} km)`
  );
});

test("weeklyRunPlan: a thin week still gets its quality session when a race time is on the line", () => {
  // 9.5 km anchor → ~10.6 km week: under the old flat 12 km bar, and above the 10 km
  // bar a dated race with a time earns.
  const withTarget = repo.weeklyRunPlan(REF, planOpts({ compliance: { actual_km: 9.5 } }));
  assert.ok(withTarget.quality_focus, "the quality session survives a thin week with a time to chase");
  const noTarget = repo.weeklyRunPlan(REF, planOpts({ compliance: { actual_km: 9.5 }, goal: { target: null } }));
  assert.equal(noTarget.quality_focus, null, "without a time on the race the thin-base rule is unchanged");
  assert.ok(noTarget.rationale.some((line) => /base is still thin/i.test(line)));
});

test("weeklyRunPlan: the ASK stays reachable even when the ideal peak is not", () => {
  // The addendum's case, and the whole point of the constrained trajectory: an
  // out-of-reach destination must never turn into an out-of-reach weekly number.
  const plan = repo.weeklyRunPlan(REF, planOpts({ compliance: { actual_km: 14 } }));
  const ramp = raceRamp(raceGoal(), REF, 14, 9.1);
  assert.equal(ramp.fit, "beyond_horizon", "the ideal peak is not reachable from here");
  assert.ok(plan.goal_feasibility, "the plan carries where it sits against the race");
  assert.equal(plan.goal_feasibility.status, "beyond_horizon");
  assert.equal(plan.goal_feasibility.ideal_peak_km, 42.2, "what the distance usually leans on");
  assert.equal(
    plan.goal_feasibility.week_km,
    ramp.required_km,
    "and this week's ask is the CONSTRAINED trajectory's value, not the ideal curve's"
  );
  assert.ok(
    plan.goal_feasibility.week_km <= 14 * SUSTAINABLE_WEEKLY_BUILD_FACTOR + 0.05,
    `one safe step from where they are (got ${plan.goal_feasibility.week_km} km off 14)`
  );
  assert.ok(
    plan.goal_feasibility.constrained_peak_km > 14 &&
      plan.goal_feasibility.constrained_peak_km < plan.goal_feasibility.ideal_peak_km,
    "the gap itself is reported, in both directions"
  );
  // Nothing prescribed exceeds the reachable week either.
  assert.ok(totalKm(plan) <= plan.goal_feasibility.week_km + 0.6, `prescribed ${totalKm(plan)} km`);
});

test("weeklyRunPlan: the fit is offered as two options, never as a demand or a verdict", () => {
  const plan = repo.weeklyRunPlan(REF, planOpts({ compliance: { actual_km: 14 } }));
  const said = plan.rationale.find((line) => /race day/i.test(line));
  assert.ok(said, `the fit is said in plain words (rationale: ${plan.rationale.join(" | ")})`);
  assert.match(said, /your call|both are good options|rather than chasing|two honest paths/i, "and offers a choice");
  // Never a demand, never a nag, never a number to fail against.
  assert.ok(
    !/\bbehind\b|\bbehind schedule\b|\byou must\b|\bneed to\b|\bshould be running\b|\bfalling short\b|\bnot enough\b/i.test(
      plan.rationale.join(" ")
    ),
    "no demand or shortfall language anywhere in the week's words"
  );
});

test("weeklyRunPlan: a trajectory that reaches the mileage adds no sentence at all", () => {
  const plan = repo.weeklyRunPlan(
    REF,
    planOpts({ goal: { weeks_to_race: 20, date: "2026-12-21" }, compliance: { actual_km: 25 } })
  );
  assert.equal(plan.goal_feasibility.status, "fits");
  assert.ok(!plan.rationale.some((line) => /race day/i.test(line)), "nothing to say, so nothing is said");
});

test("weeklyRunPlan: no race to arrive at means no feasibility read at all", () => {
  const plan = repo.weeklyRunPlan(REF, planOpts({ goal: { is_race: false, date: null, distance_km: 10 } }));
  assert.equal(plan.goal_feasibility, null);
});

test("weeklyRunPlan: a race time next to a supporting endurance role is named, and the cap holds", () => {
  const opts = planOpts({ trainingIntent: { endurance_role: "supporting" } });
  const plan = repo.weeklyRunPlan(REF, opts);
  assert.ok(
    plan.rationale.some((line) => RACE_VS_SUPPORTING_VARIANTS.includes(line)),
    "the plan says which of the two settings it followed"
  );
  assert.ok(plan.runs.length <= 3, "and the supporting cap is still what the plan follows");
  const noTarget = repo.weeklyRunPlan(
    REF,
    planOpts({ trainingIntent: { endurance_role: "supporting" }, goal: { target: null } })
  );
  assert.ok(
    !noTarget.rationale.some((line) => RACE_VS_SUPPORTING_VARIANTS.includes(line)),
    "an event with no time on it is not a contradiction"
  );
});

test("weeklyRunPlan: the base phase can rotate a threshold session in", () => {
  const seen = new Set();
  for (let week = 0; week < 6; week++) {
    const plan = repo.weeklyRunPlan(REF, {
      ...planOpts({
        goal: { phase: "base", weeks_to_race: 30, date: "2027-03-01" },
        // Already doing some faster work, so the "first quality is a gentle tempo"
        // rule is out of the way and the rotation itself is what is under test.
        programState: { endurance: { sport: "run", longest_km_4wk: 9.1, has_quality: true, status: "building" } },
      }),
      block: { week_index: week + 1 },
    });
    if (plan.quality_focus) seen.add(plan.quality_focus);
  }
  assert.ok(
    [...seen].some((label) => /threshold/i.test(label)),
    `base-phase rotation reaches threshold (saw: ${[...seen].join(", ")})`
  );
});

// ── phase + block: 13 weeks out from a half is the BUILD ──────────────────────

test("a long race gets a longer build: 13 weeks out from a half is build, not base", () => {
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Cambridge Half", date: RACE, distance_km: HALF_KM, target: "1:50" },
  });
  assert.equal(repo.getEnduranceGoal(REF).weeks_to_race, 13);
  assert.equal(repo.getEnduranceGoal(REF).phase, "build", "13 weeks out from 21.1 km is the heart of the build");
  assert.equal(repo.getEnduranceGoal("2026-07-01").phase, "base", "far enough out it is still base");
  assert.equal(repo.getEnduranceGoal("2026-10-01").phase, "sharpen");
  assert.equal(repo.getEnduranceGoal("2026-10-22").phase, "taper");
});

test("a SHORT race keeps the original, tighter phase windows", () => {
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Club 10k", date: RACE, distance_km: 10, target: "42:00" },
  });
  assert.equal(repo.getEnduranceGoal(REF).phase, "base", "13 weeks out from a 10k really is base");
  assert.equal(repo.getEnduranceGoal("2026-09-06").phase, "build");
});

test("a race with a time inside sixteen weeks opens an endurance block, not off-season strength", () => {
  resetTables("program_blocks");
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Cambridge Half", date: "2026-11-22", distance_km: HALF_KM, target: "1:50" },
  });
  const block = repo.ensureActiveBlock();
  assert.equal(block.focus, "endurance-base", `${block.goal}`);
  assert.ok(!/off-season/i.test(block.goal), "and it is not described as an off-season");
});

// ── the reading grammar, over the whole new vocabulary ────────────────────────

test("every new athlete-facing phrasing holds the reading grammar", () => {
  // The fit lines are rendered from live numbers, so the grammar is checked on what
  // the athlete would actually read, across a spread of plausible values.
  const rendered = [];
  for (const [supported, wanted] of [
    [24, 42],
    [8, 22],
    [100, 120],
    [0, 45],
  ]) {
    for (const say of [...TIMELINE_FIT_VARIANTS, ...TIMELINE_CLOSE_VARIANTS]) rendered.push(say(supported, wanted));
  }
  for (const line of [...rendered, ...RACE_VS_SUPPORTING_VARIANTS]) {
    assert.equal(violatesReadingGrammar(line), null, `"${line}"`);
  }
  for (const set of [TIMELINE_FIT_VARIANTS, TIMELINE_CLOSE_VARIANTS, RACE_VS_SUPPORTING_VARIANTS]) {
    assert.ok(set.length >= 3, "a variant SET, never one literal printed for weeks");
  }
  const oneRender = TIMELINE_FIT_VARIANTS.map((say) => say(24, 42));
  assert.equal(new Set(oneRender).size, oneRender.length, "no duplicate phrasings");
  assert.equal(new Set(RACE_VS_SUPPORTING_VARIANTS).size, RACE_VS_SUPPORTING_VARIANTS.length);
});

test("no phrasing anywhere in the new vocabulary reads as a demand or a shortfall", () => {
  const all = [
    ...TIMELINE_FIT_VARIANTS.map((say) => say(24, 42)),
    ...TIMELINE_CLOSE_VARIANTS.map((say) => say(38, 42)),
    ...RACE_VS_SUPPORTING_VARIANTS,
  ];
  for (const line of all) {
    assert.ok(
      !/\bbehind\b|\bbehind schedule\b|\bmust\b|\bneed to\b|\bshould be\b|\bfalling short\b|\bnot enough\b|\bfail/i.test(
        line
      ),
      `"${line}"`
    );
  }
});

test("consecutive days never print the same fit sentence", () => {
  const said = [];
  for (const day of ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]) {
    const plan = repo.weeklyRunPlan(day, planOpts({ compliance: { actual_km: 14 } }));
    said.push(plan.rationale.find((line) => /race day/i.test(line)));
  }
  assert.ok(said.every(Boolean), "the sentence is there every day the fit is worth naming");
  for (let i = 1; i < said.length; i++)
    assert.notEqual(said[i], said[i - 1], "and it is not the same sentence twice running");
});

test("the run plan never leaks a score", () => {
  const plan = repo.weeklyRunPlan(REF, planOpts());
  const json = JSON.stringify(plan);
  assert.ok(!/impact_score/.test(json));
  assert.ok(!/"score"/.test(json));
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(json));
});

// ── the RATE story: feasible + needed_build_factor, wired into the words ──────
// These two were computed and read by nothing but a test. What they know that the
// fit sentences above do not is the SHAPE of the gap: a destination gap says how
// far short the reachable peak lands, but says nothing about how hard the weeks
// would have to climb to close it. Thirty weeks out and six weeks out can share a
// fit and be nowhere near the same situation.

const rateLine = (plan) =>
  plan.rationale.find(
    (line) => RAMP_RATE_NEAR_VARIANTS.includes(line) || RAMP_RATE_STEEP_VARIANTS.includes(line)
  ) ?? null;

test("the same fit, two runways: the rate line separates what the fit sentence cannot", () => {
  // Both are "beyond_horizon" — the reachable peak lands well under what a half
  // usually leans on — so the destination sentence reads the same for each.
  const far = repo.weeklyRunPlan(
    REF,
    planOpts({ goal: { date: "2027-03-01", weeks_to_race: 30 }, compliance: { actual_km: 12 } })
  );
  const near = repo.weeklyRunPlan(
    REF,
    planOpts({ goal: { date: "2026-09-14", weeks_to_race: 6 }, compliance: { actual_km: 10 } })
  );

  const farLine = rateLine(far);
  const nearLine = rateLine(near);
  assert.ok(farLine, "a runway that would need a slightly hotter build says so");
  assert.ok(nearLine, "and so does one that would need a far hotter build");
  assert.ok(
    RAMP_RATE_NEAR_VARIANTS.includes(farLine),
    "thirty weeks out, the required step is only a little past sustainable"
  );
  assert.ok(
    RAMP_RATE_STEEP_VARIANTS.includes(nearLine),
    "six weeks out, the same destination gap needs a far steeper climb"
  );
});

test("a required step that IS the sustainable step stays quiet — the fit line already said it", () => {
  // A stretch this far out needs a weekly step a fraction of a percent above the
  // ceiling. There is no rate story there, and a second sentence saying so would
  // be the fit sentence again in different words.
  const plan = repo.weeklyRunPlan(
    REF,
    planOpts({ goal: { date: "2027-05-10", weeks_to_race: 40 }, compliance: { actual_km: 17 } })
  );
  assert.equal(rateLine(plan), null, "inside the margin the rate has nothing to add");
  assert.equal(plan.goal_feasibility.status, "stretch", "…while the destination gap is still named");
});

test("a trajectory that arrives never gets a rate sentence at all", () => {
  const plan = repo.weeklyRunPlan(
    REF,
    planOpts({ goal: { date: "2027-05-10", weeks_to_race: 40 }, compliance: { actual_km: 20 } })
  );
  assert.equal(rateLine(plan), null);
});

test("the rate words carry no number, and rotate by day", () => {
  for (const line of [...RAMP_RATE_NEAR_VARIANTS, ...RAMP_RATE_STEEP_VARIANTS]) {
    assert.equal(violatesReadingGrammar(line), null, `"${line}"`);
    assert.ok(!/\d/.test(line), `a weekly build factor is never handed to the athlete: "${line}"`);
    assert.ok(
      !/\bbehind\b|\bmust\b|\bneed to\b|\bshould be\b|\bfalling short\b|\bnot enough\b|\bfail/i.test(line),
      `"${line}"`
    );
  }
  for (const set of [RAMP_RATE_NEAR_VARIANTS, RAMP_RATE_STEEP_VARIANTS]) {
    assert.ok(set.length >= 3, "a variant SET, never one literal printed for weeks");
    assert.equal(new Set(set).size, set.length, "no duplicate phrasings");
  }

  const said = [];
  for (const day of ["2026-08-05", "2026-08-06", "2026-08-07"]) {
    said.push(
      rateLine(repo.weeklyRunPlan(day, planOpts({ goal: { date: "2026-09-14", weeks_to_race: 6 }, compliance: { actual_km: 10 } })))
    );
  }
  assert.ok(said.every(Boolean));
  for (let i = 1; i < said.length; i++) assert.notEqual(said[i], said[i - 1]);
});
