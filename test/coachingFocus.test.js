import { test } from "node:test";
import assert from "node:assert/strict";
import { coachingFocus } from "../dist/repo/coaching-focus.js";

// A rich, multi-domain athlete: a stalled shoulder lift, an act-now lipid finding,
// a build-phase run plan, a DEXA leg-lean flag, stale retests. An elite coach leads
// with ONE lever, runs another alongside (via a different domain), defers the rest,
// connects the domains, and batches the retests.
function richInput() {
  return {
    discipline: { primary: "hybrid" },
    enduranceGoal: null,
    goalMode: "lose",
    programState: { mesocycle: { phase: "accumulation" }, lifts: [] },
    recovery: { delta: { hrv: 1, rhr: 0 } },
    healthFocus: {
      headline: "Lipids lead the health picture",
      lead: { group: "Lipids & Cardiovascular", why: "ApoB and LDL sit high together", tier: "act_now", moves: { nutrition: "Emphasize oily fish and soluble fiber." } },
    },
    performance: {
      hero: { headline: "You're an intermediate lifter overall" },
      lever: { headline: "Bring up your overhead press", why: "It's your furthest-behind lift" },
      imbalances: [{ title: "Pulling is ahead of pressing", why: "row outruns press" }],
      tests_due: [{ exercise: "Back Squat", kind: "strength", why: "stale max" }],
      endurance: { tone: "steady" },
    },
    groupsTrajectory: {
      groups: [
        { verdict: "stalling", label: "Shoulders", lead_lift: "Overhead Press", stalled_signal: "same load 4 sessions", vary_options: [{ name: "Push Press", why: "overload the press off the rack" }, { name: "Z-Press", why: "kills the leg drive, builds the bottom" }] },
        { verdict: "advancing", label: "Back", lead_lift: "Row" },
      ],
    },
    runPlan: { available: true, quality_focus: "tempo", why: "Build phase", mix_summary: "3 easy + 1 tempo + 1 long" },
    runVariety: { note: "Every run has been the same easy 5k", suggestions: ["Add a tempo"] },
    dexa: { available: true, lead: { area: "legs", signal: "low regional lean", bias: "bias leg volume up", domain: "training", path: "8–12 wk of leg work adds measurable lean by the next scan" }, targets: [] },
    trajectory: { horizon_weeks: 10 },
    testWeek: { due: false, key_lifts: ["Back Squat", "Bench Press"] },
    enduranceTests: [{ exercise: "a 5k time-trial", kind: "endurance", why: "no quality effort in 4 weeks" }],
  };
}

test("coachingFocus leads with the single highest-leverage lever and sequences the rest", () => {
  const out = coachingFocus(richInput());
  assert.equal(out.available, true);
  // The stalled main lift is the lead (the athlete's own 'which group stalls' framing).
  assert.ok(out.lead, "a lead is named");
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.title, /plateau|shoulder/i);
  // The move names the real variations (vary_options are {name,why} objects — a bare
  // String(o) would render "[object Object]" in the athlete's read).
  assert.ok(out.lead.move && out.lead.move.includes("Push Press"), "move names the variation");
  assert.ok(!/\[object Object\]/.test(out.lead.move || ""), "move never renders [object Object]");
  // Parallel levers are on a DIFFERENT domain than the lead (so they're worked alongside).
  assert.ok(out.parallel.length >= 1 && out.parallel.length <= 2, "1-2 parallel levers");
  for (const p of out.parallel) assert.notEqual(p.domain, out.lead.domain, "parallel never duplicates the lead's domain");
  // The act-now lipid finding rides alongside via nutrition.
  assert.ok(out.parallel.some((p) => p.domain === "nutrition"), "lipids handled in parallel via nutrition");
  // The rest is explicitly DEFERRED, not piled on.
  assert.ok(out.later.length >= 1, "a 'later' sequence is named");
  // Cross-domain connections are spelled out.
  assert.ok(out.connections.length >= 1, "at least one cross-domain connection");
  // Retests are BATCHED into one checkpoint, not four separate nags.
  assert.ok(out.retest && out.retest.focus.length >= 2, "retests batched");
  assert.equal(out.horizon_weeks, 10);
  // Constitution: no 0-100 score, and the INTERNAL ordering never leaks.
  const json = JSON.stringify(out);
  assert.ok(!/"score"/i.test(json), "no score field");
  assert.ok(!/leverage|priority/i.test(json), "internal ordering (leverage) never surfaced");
});

test("coachingFocus leads with recovery when a deload is due (won't push into fatigue)", () => {
  const out = coachingFocus({
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
    performance: { lever: { headline: "Bring up your press", why: "laggard" } },
    groupsTrajectory: { groups: [{ verdict: "stalling", label: "Legs", lead_lift: "Squat", vary_options: ["Front Squat"] }] },
  });
  assert.equal(out.available, true);
  assert.equal(out.lead.domain, "recovery");
  assert.match(out.lead.title, /recovery|lighter|deload/i);
});

test("coachingFocus promotes an act-now health lever to lead when training is steady", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { delta: { hrv: 0, rhr: 0 } },
    healthFocus: { lead: { group: "Lipids & Cardiovascular", why: "ApoB high", tier: "act_now", moves: { nutrition: "More fiber and oily fish." } } },
    performance: { endurance: { tone: "steady" } }, // nothing stalled, no lever
  });
  assert.equal(out.available, true);
  // With no training/running lead-eligible candidate, the strong health lever leads.
  assert.match(out.lead.title.toLowerCase(), /lipid/);
});

test("coachingFocus degrades to {available:false} on a thin athlete", () => {
  const out = coachingFocus({});
  assert.equal(out.available, false);
  assert.equal(out.lead, null);
  assert.deepEqual(out.parallel, []);
  assert.deepEqual(out.later, []);
  assert.equal(out.retest, null);
});
