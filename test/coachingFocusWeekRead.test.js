import { test } from "node:test";
import assert from "node:assert/strict";
import { coachingFocus } from "../dist/repo/coaching-focus.js";

// The conductor's WEEK READ (coaching-focus-read.ts): a card that changes with the
// week — the block decision, the race build, the evidence in values and directions,
// and what moved — rather than a standing strength slogan over "Today's work is complete".
import { LIPIDS, PERFORMANCE, TODAY, WEIGHTS, liveShaped, raceBuild, signalState } from "./_coachingFocusLiveShape.mjs";

const SCOREY = /\b(score|percentile|impact_score|leverage|priority)\b|\d+\s*\/\s*100/i;

test("live shape: a finished day is a day_state, and the week's lever leads", () => {
  const out = coachingFocus(liveShaped());
  assert.equal(out.available, true);
  // (b) "Today's work is complete" is a DAY state, never the lead.
  assert.ok(out.day_state, "the day state is carried");
  assert.equal(out.day_state.posture, "done");
  assert.equal(out.day_state.title, "Today's work is complete");
  assert.match(out.day_state.move, /eat to recover/i, "the fuel-protect directive rides on the finished day");
  assert.notEqual(out.lead.title, "Today's work is complete");
  assert.equal(out.lead.day_posture, undefined);
  // Strength is his stated priority and the race is not yet in its peak week.
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.title, /overhead press/i);
  assert.match(out.lead.why, /87 lb/, "the lever is said in values");
  assert.match(out.lead.why, /climbing about 1\.2 lb a week/);
  assert.match(out.lead.move, /top set/i, "the move is what this week's phase asks of the lift");
  // (a) The strength standing is NOT the headline; it is a supporting fact on the lever.
  assert.doesNotMatch(out.headline, /intermediate lifter/i);
  assert.ok(out.lead.based_on.some((l) => /intermediate lifter overall/i.test(l)));
  // The headline is the week's through-line, anchored in the block and the race.
  assert.match(out.headline, /^Week 6 of 6, 26 days to Cambridge Half Marathon:/);
  assert.match(out.headline, /overhead press leads this week/);
  // The race build and the lipids ride alongside, specific to this week.
  const run = out.parallel.find((p) => p.domain === "running");
  assert.ok(run, "the half build rides alongside");
  assert.match(run.title, /Cambridge Half Marathon, 26 days out/);
  assert.match(run.why, /1:53:52/);
  assert.match(run.why, /inside the 2:00 target/);
  assert.match(run.move, /15 km long run/);
  assert.match(run.move, /Next week is the peak: 38 km/);
  const lipids = out.parallel.find((p) => p.domain === "health");
  assert.ok(lipids, "the act-now lipid finding rides alongside");
  assert.match(lipids.why, /ApoB 134 mg\/dL \(falling\)/);
  assert.match(lipids.move, /Informational, not medical advice/);
});

test("live shape: the block read says what the deload decision is (block-phase single source)", () => {
  const out = coachingFocus(liveShaped());
  // (c) Never "the deload is in sight" on a week the prescriptions run as a push.
  assert.doesNotMatch(out.block_line, /in sight/i);
  assert.match(out.block_line, /^Week 6 of 6 — the scheduled deload is set aside/);
  assert.equal(out.block.deload, "set_aside");
  assert.equal(out.block.phase, "intensification");
  assert.equal(out.block.scheduled_phase, "deload");
  assert.equal(out.block.race_taper_from, "2026-10-19");
  assert.match(out.block.decision, /race taper from Oct 19 lightens the legs/);
});

test("live shape: evidence is values and directions; changed_since is dated", () => {
  const out = coachingFocus(liveShaped());
  assert.ok(out.evidence.length >= 4 && out.evidence.length <= 9);
  // The whole picture: strength, labs, the race build and the ride, the cut, recovery.
  const domains = new Set(out.evidence.map((e) => e.domain));
  for (const d of ["training", "health", "running", "body", "recovery"])
    assert.ok(domains.has(d), `evidence covers ${d}`);
  const hrv = out.evidence.find((e) => e.label === "HRV");
  assert.equal(hrv.direction, "down");
  assert.match(hrv.note, /low edge of your 42–54 ms range/);
  const byLabel = Object.fromEntries(out.evidence.map((e) => [e.label, e]));
  assert.equal(byLabel["Overhead press"].value, "est. 1RM 87 lb");
  assert.equal(byLabel["Overhead press"].direction, "up");
  assert.ok(byLabel["Strength standing"], "the standing is a supporting fact while strength leads");
  assert.equal(byLabel["Half marathon estimate"].value, "1:53:52 (5:24 /km)");
  assert.equal(byLabel["Half marathon estimate"].direction, "down");
  assert.match(byLabel["Half marathon estimate"].note, /9 min faster since Sep 8/);
  assert.equal(byLabel.ApoB.value, "134 mg/dL");
  assert.equal(byLabel.ApoB.direction, "down");
  assert.match(byLabel.ApoB.note, /above the 40–80 optimal band/);
  // The order follows the card: lead domain first.
  assert.equal(out.evidence[0].domain, "training");
  // What moved, each against a stated date.
  const kinds = out.changed_since.map((c) => c.kind);
  assert.ok(kinds.includes("race_estimate"));
  assert.ok(kinds.includes("weight"));
  assert.ok(kinds.includes("run_volume"));
  for (const change of out.changed_since) assert.ok(change.since, `${change.kind} names its comparison date`);
  const weight = out.changed_since.find((c) => c.kind === "weight");
  assert.match(weight.text, /1\.0 lb lower than the week before/);
  // The change is the "What moved" strip's to say, right under the headline — never both.
  assert.ok(out.changed_since.some((c) => /Half marathon estimate 9 min faster since Sep 8/.test(c.text)));
  assert.doesNotMatch(out.headline, /estimate 9 min faster/);
  for (const change of out.changed_since) assert.ok(!out.headline.includes(change.text), change.text);
  assert.match(out.headline, /leads this week[^.]*\.$/, "the headline ends on the week's through-line");
  // Deferred items say why they wait.
  assert.ok(out.later.length >= 1);
  for (const item of out.later) assert.ok(item.why, `${item.title} says why it waits`);
  // Cross-domain ties are specific to this athlete's week.
  assert.ok(out.connections.some((c) => /upper-body work, so it keeps progressing through the peak and taper/.test(c)));
  assert.ok(out.connections.some((c) => /trail MTB comes the day before the long run/.test(c)));
  // Lift re-tests wait for race day.
  assert.match(out.retest.why, /after race day \(Nov 1\)/);
});

test("the card moves with the week: a peak week puts even a supporting race in the lead", () => {
  const out = coachingFocus(
    liveShaped({
      raceBuild: raceBuild({ currentKind: "peak", daysTo: 19 }),
      signalState: signalState({ posture: "train" }),
    })
  );
  assert.equal(out.lead.domain, "running");
  assert.match(out.lead.title, /19 days out: A new weekly high/);
  assert.equal(out.day_state, null, "an ordinary training day carries no day state");
  // Strength rides alongside while the race shapes the week.
  assert.ok(out.parallel.some((p) => p.domain === "training") || out.later.some((l) => l.domain === "training"));
  assert.match(out.headline, /half marathon build leads this week/);
  // How the lifting fits the race week, in the race build's own words.
  assert.ok(out.connections.some((c) => /leg extras drop a set/.test(c)));
});

test("lift-only athlete: no race, an accumulation block, the lever in values", () => {
  const out = coachingFocus({
    date: TODAY,
    goalMode: "maintain",
    trainingIntent: { priorities: ["strength", "muscle"], endurance_role: "none", source: "explicit" },
    programState: {
      mesocycle: { phase: "accumulation" },
      lifts: [
        {
          exercise: "Barbell Overhead Press",
          muscle_group: "shoulders",
          est_1rm: 87,
          trend_per_wk: 0,
          status: "plateaued",
        },
      ],
    },
    programBlock: { goal: "Build pressing", focus: "strength", phase: "accumulation", week_of: "week 2 of 5" },
    performance: PERFORMANCE,
    signalState: signalState({ posture: "train" }),
  });
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.why, /est\. 1RM of 87 lb — novice for your 40s, about 10 lb from intermediate/);
  assert.match(out.lead.why, /held/i, "a flat lift says so");
  assert.match(out.lead.move, /one more clean rep/i, "accumulation asks for reps before load");
  assert.equal(out.block_line, "Week 2 of 5 — building volume.");
  assert.equal(out.block.deload, "later");
  assert.match(out.block.decision, /intensity takes over from week 4/);
  assert.match(out.headline, /^Week 2 of 5: your overhead press leads this week/);
  assert.ok(!out.evidence.some((e) => e.domain === "running"), "no running evidence for a lifter");
  assert.ok(!out.parallel.some((p) => p.domain === "running"));
});

test("cut + lipid act-now with no training lever: the lipids lead with values and an everyday move", () => {
  const out = coachingFocus({
    date: TODAY,
    goalMode: "lose",
    healthFocus: { lead: LIPIDS, priorities: [LIPIDS] },
    goalPace: {
      points: WEIGHTS,
      trend: { lb_wk: -0.4 },
      needed: { lb_wk: -1.2 },
      goal: { weight_lb: 150, date: "2026-11-15" },
      window_days: 21,
    },
    performance: { endurance: { tone: "steady" } },
  });
  assert.equal(out.lead.domain, "health");
  assert.match(
    out.lead.why,
    /Total Cholesterol 262 mg\/dL \(rising\) and ApoB 134 mg\/dL \(falling\) sit outside the optimal band/
  );
  assert.match(out.lead.move, /soluble fiber and oily fish/);
  assert.match(out.lead.move, /Informational, not medical advice\.$/);
  const cut = out.parallel.find((p) => p.domain === "nutrition");
  assert.ok(cut, "the cut rides alongside");
  // Adherence-neutral: a slower trend is a fact about the line, never a verdict.
  assert.match(cut.why, /runs a little slower than that line/);
  assert.doesNotMatch(cut.why, /behind|fail|miss|should have/i);
  assert.ok(out.evidence.some((e) => e.label === "Weight" && e.value === "159.6 lb"));
});

test("deload week and an applied recovery week say so, and the recovery lead stays put", () => {
  const scheduled = coachingFocus({
    date: TODAY,
    programBlock: { phase: "deload", week_of: "week 5 of 5" },
    performance: PERFORMANCE,
    programState: { mesocycle: { phase: "deload" }, lifts: [] },
  });
  assert.match(scheduled.block_line, /^Week 5 of 5 — a deload week/);
  assert.equal(scheduled.block.deload, "deload_week");
  assert.match(scheduled.lead.move, /Deload week: hold the load on the overhead press/);

  const applied = coachingFocus({
    date: TODAY,
    recoveryWeekActive: true,
    programBlock: { phase: "deload", week_of: "week 3 of 6" },
    programState: { mesocycle: { phase: "deload" } },
    performance: PERFORMANCE,
  });
  assert.equal(applied.lead.domain, "recovery");
  assert.equal(applied.lead.recovery_active, true);
  assert.equal(applied.block.deload, "recovery_week");
  assert.match(applied.headline, /the recovery week leads this week/);

  // Loaded weeks calling for a lighter week outrank the calendar's wording.
  const earned = coachingFocus({
    date: TODAY,
    programBlock: { phase: "intensification", week_of: "week 4 of 6" },
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
  });
  assert.equal(earned.lead.domain, "recovery");
  assert.equal(earned.block.deload, "earned");
  assert.match(earned.block.decision, /loaded weeks now call for a lighter week/);

  // The last intensification week before a deload that will run vs one that only runs if earned.
  const next = coachingFocus({
    programBlock: { phase: "intensification", week_of: "week 4 of 5", next_week_deload_runs: true },
    performance: PERFORMANCE,
  });
  assert.equal(next.block_line, "Week 4 of 5 — pushing intensity; the deload is next week.");
  const ifEarned = coachingFocus({
    programBlock: { phase: "intensification", week_of: "week 4 of 5", next_week_deload_runs: false },
    performance: PERFORMANCE,
  });
  assert.equal(ifEarned.block.deload, "next_week_if_earned");
  assert.match(ifEarned.block_line, /runs only if your loaded weeks call for one/);
});

test("rest and easy days still own the card, and also report themselves as day_state", () => {
  const out = coachingFocus(liveShaped({ signalState: signalState({ posture: "easy" }) }));
  assert.equal(out.lead.day_posture, "easy");
  assert.equal(out.day_state.posture, "easy");
  assert.match(out.headline, /today belongs to recovery; your overhead press picks back up on the next ready day/);
  for (const item of out.later.filter((l) => l.domain === "training")) assert.match(item.why, /next ready day/);
});

test("new bests and a fresh lab show up as dated changes", () => {
  const out = coachingFocus(
    liveShaped({
      weekWins: { prs: [{ exercise: "Back Squat", label: "235 lb × 5 — new best" }] },
      healthFocus: {
        lead: { ...LIPIDS, readings: [{ ...LIPIDS.readings[1], date: "2026-10-01", value: 121, trend: "falling" }] },
        priorities: [],
      },
    })
  );
  const best = out.changed_since.find((c) => c.kind === "new_best");
  assert.equal(best.text, "New best this week: Back Squat 235 lb × 5.");
  assert.equal(best.since, "2026-09-30");
  const lab = out.changed_since.find((c) => c.kind === "new_lab");
  assert.match(lab.text, /New lab \(Oct 1\): ApoB 121 mg\/dL \(falling\)/);
  // The strip owns the new best; the headline stays the week + its levers.
  assert.doesNotMatch(out.headline, /New best/);
});

test("a VO2max reading rides in the evidence with the ride folded into the run week", () => {
  const out = coachingFocus(
    liveShaped({
      performance: { ...PERFORMANCE, endurance: { tone: "steady", vo2max: 46.5, trend: "Base is building." } },
    })
  );
  const vo2 = out.evidence.find((e) => e.label === "VO2max");
  assert.equal(vo2.value, "46.5 mL/kg/min");
  const week = out.evidence.find((e) => e.label === "Running this week");
  assert.match(week.note, /trail MTB Saturdays ~140 min, heavy, the day before the long run/);
});

test("constitution: no score, percentile, impact_score or internal ordering anywhere in the read", () => {
  for (const input of [liveShaped(), liveShaped({ raceBuild: raceBuild({ currentKind: "peak", daysTo: 19 }) })]) {
    const out = coachingFocus(input);
    const prose = JSON.stringify({ ...out, retest: null });
    assert.doesNotMatch(prose, SCOREY);
    assert.doesNotMatch(prose, /\byou must\b/i, "a suggestion, never a gate");
  }
});

test("thin input degrades: no block, no race, no evidence", () => {
  const out = coachingFocus({});
  assert.equal(out.block, null);
  assert.equal(out.day_state, null);
  assert.deepEqual(out.evidence, []);
  assert.deepEqual(out.changed_since, []);
});
