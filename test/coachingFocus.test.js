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
      lead: {
        group: "Lipids & Cardiovascular",
        why: "ApoB and LDL sit high together",
        tier: "act_now",
        moves: { nutrition: "Emphasize oily fish and soluble fiber." },
      },
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
        {
          verdict: "stalling",
          label: "Shoulders",
          lead_lift: "Overhead Press",
          stalled_signal: "same load 4 sessions",
          vary_options: [
            { name: "Push Press", why: "overload the press off the rack" },
            { name: "Z-Press", why: "kills the leg drive, builds the bottom" },
          ],
        },
        { verdict: "advancing", label: "Back", lead_lift: "Row" },
      ],
    },
    runPlan: { available: true, quality_focus: "tempo", why: "Build phase", mix_summary: "3 easy + 1 tempo + 1 long" },
    runVariety: { note: "Every run has been the same easy 5k", suggestions: ["Add a tempo"] },
    dexa: {
      available: true,
      lead: {
        area: "legs",
        signal: "low regional lean",
        bias: "bias leg volume up",
        domain: "training",
        path: "8–12 wk of leg work adds measurable lean by the next scan",
      },
      targets: [],
    },
    trajectory: { horizon_weeks: 10 },
    testWeek: { due: false, key_lifts: ["Back Squat", "Bench Press"] },
    enduranceTests: [{ exercise: "a 5k time-trial", kind: "endurance", why: "no quality effort in 4 weeks" }],
  };
}

function unifiedState({
  posture = "train",
  readiness = "ready",
  training = "proceed",
  fueling = "normal",
  schedule = "normal",
  reason = "The current signals leave room for the planned day.",
  injury = false,
} = {}) {
  return {
    action: {
      posture,
      readiness,
      reason,
      reasons: [reason],
      directives: { training, fueling, schedule },
    },
    dimensions: {
      energy_fueling: { reason: fueling === "protect" ? "Recent work raises fueling needs." : "Fueling is steady." },
      life_capacity: {
        reason: schedule === "compress" ? "School pickup compresses today's window." : "Schedule is open.",
      },
      health_constraints: {
        evidence: injury
          ? [
              {
                field: "active_injury",
                freshness: "fresh",
                summary: "Shoulder strain: an active shoulder injury is worth easing or working around.",
              },
            ]
          : [],
      },
    },
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
  assert.ok(Array.isArray(out.lead.based_on), "lead carries plain provenance");
  assert.ok(out.lead.based_on.length <= 3, "lead provenance stays bounded");
  assert.ok(
    out.lead.based_on.some((line) => /stall/i.test(line)),
    "lead provenance names the cause"
  );
  // Parallel levers are on a DIFFERENT domain than the lead (so they're worked alongside).
  assert.ok(out.parallel.length >= 1 && out.parallel.length <= 2, "1-2 parallel levers");
  for (const p of out.parallel)
    assert.notEqual(p.domain, out.lead.domain, "parallel never duplicates the lead's domain");
  // The act-now lipid finding rides alongside via nutrition.
  assert.ok(
    out.parallel.some((p) => p.domain === "nutrition"),
    "lipids handled in parallel via nutrition"
  );
  const lipid = out.parallel.find((p) => p.domain === "nutrition");
  assert.ok(Array.isArray(lipid.based_on), "parallel lever carries provenance");
  assert.ok(lipid.based_on.some((line) => /health lead|lipid/i.test(line)));
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
    groupsTrajectory: {
      groups: [{ verdict: "stalling", label: "Legs", lead_lift: "Squat", vary_options: ["Front Squat"] }],
    },
  });
  assert.equal(out.available, true);
  assert.equal(out.lead.domain, "recovery");
  assert.match(out.lead.title, /recovery|lighter|deload/i);
});

test("canonical rest/easy postures own the conductor and gate aggressive training to Later", () => {
  for (const posture of ["rest", "easy"]) {
    const out = coachingFocus({
      ...richInput(),
      signalState: unifiedState({
        posture,
        readiness: "protect",
        training: "recover",
        reason:
          posture === "rest"
            ? "A rough night says recovery owns today."
            : "One low recovery signal supports an easier day.",
      }),
    });
    assert.equal(out.lead.domain, "recovery");
    assert.equal(out.lead.day_posture, posture);
    assert.match(out.lead.why, posture === "rest" ? /rough night/i : /easier day/i);
    assert.equal(
      out.parallel.some((item) => item.domain === "training" || item.domain === "running"),
      false,
      `${posture} cannot carry an aggressive training parallel`
    );
    assert.ok(
      out.later.some((item) => item.domain === "training"),
      "the block lever is deferred rather than erased"
    );
  }
});

test("combined poor recovery and injury keeps recovery lead plus an explicit movement caveat", () => {
  const out = coachingFocus({
    ...richInput(),
    signalState: unifiedState({
      posture: "easy",
      readiness: "protect",
      training: "recover",
      reason: "Fresh low readiness supports an easier day.",
      injury: true,
    }),
  });
  assert.equal(out.lead.domain, "recovery");
  assert.equal(out.lead.day_posture, "easy");
  assert.equal(
    out.parallel.some((item) => item.domain === "training" || item.domain === "running"),
    false
  );
  assert.match(out.caveat, /active injury|pain-free substitutions/i);
  assert.ok(out.later.some((item) => item.domain === "training"));
});

test("a sparse no-plan athlete keeps the injury caveat without a training candidate", () => {
  const out = coachingFocus({
    signalState: unifiedState({
      posture: "easy",
      readiness: "protect",
      training: "recover",
      reason: "Fresh low readiness supports an easier day.",
      injury: true,
    }),
  });
  assert.equal(out.lead.domain, "recovery");
  assert.equal(out.lead.day_posture, "easy");
  assert.equal(
    out.parallel.some((item) => item.domain === "training" || item.domain === "running"),
    false
  );
  assert.equal(
    out.later.some((item) => item.domain === "training" || item.domain === "running"),
    false
  );
  assert.match(out.caveat, /shoulder strain/i);
  assert.match(out.caveat, /pain-free substitutions/i);
});

test("canonical modify posture forces an explicit work-around on a training lead", () => {
  const out = coachingFocus({
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Shoulders",
          lead_lift: "Overhead Press",
          vary_options: [{ name: "Landmine Press" }],
        },
      ],
    },
    signalState: unifiedState({
      posture: "modify",
      readiness: "caution",
      training: "modify",
      reason: "An active shoulder injury calls for a work-around.",
    }),
  });
  assert.equal(out.lead.domain, "training");
  assert.match(out.caveat, /modify today's work|pain-free substitutions/i);
  assert.match(out.lead.why, /active shoulder injury|pain-free substitutions/i);
});

test("schedule compression constrains timing without becoming recovery", () => {
  const out = coachingFocus({
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Shoulders",
          lead_lift: "Overhead Press",
          vary_options: [{ name: "Push Press" }],
        },
      ],
    },
    signalState: unifiedState({ schedule: "compress", reason: "A dated family commitment compresses today." }),
  });
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.move, /compressed window|optional volume deferred/i);
  assert.equal(
    [out.lead, ...out.parallel].some((item) => item.domain === "recovery"),
    false
  );
});

test("fuel protection surfaces through nutrition without forcing rest", () => {
  const out = coachingFocus({
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Shoulders",
          lead_lift: "Overhead Press",
          vary_options: [{ name: "Push Press" }],
        },
      ],
    },
    signalState: unifiedState({ fueling: "protect", reason: "Training can continue with fuel protected." }),
  });
  assert.equal(out.lead.domain, "training");
  const fuel = out.parallel.find((item) => item.domain === "nutrition");
  assert.ok(fuel, "fuel protection is visible alongside training");
  assert.match(`${fuel.title} ${fuel.move}`, /protect fuel|do not deepen the deficit/i);
  assert.equal(
    [out.lead, ...out.parallel].some((item) => item.domain === "recovery"),
    false
  );
});

test("recovery drift leads only from current, adequately covered HRV and resting-HR evidence", () => {
  const evidence = (freshness = "fresh", sampleCount = 8) => ({
    latest_date: "2026-07-13",
    freshness,
    sample_count: sampleCount,
    expected_days: 14,
  });
  const recovery = {
    delta: { hrv: -5, rhr: 4 },
    quality: { hrv_ms: evidence(), resting_hr: evidence() },
  };

  const current = coachingFocus({ programState: { mesocycle: { phase: "accumulation" } }, recovery });
  assert.equal(current.lead?.domain, "recovery");
  assert.deepEqual(current.lead?.based_on, ["HRV is down while resting HR is up"]);

  const stale = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { ...recovery, quality: { hrv_ms: evidence("stale"), resting_hr: evidence("stale") } },
  });
  assert.equal(stale.available, false, "stale wearable deltas cannot lead");

  const mixedFreshness = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { ...recovery, quality: { hrv_ms: evidence("fresh"), resting_hr: evidence("stale") } },
  });
  assert.equal(mixedFreshness.available, false, "both constituent signals must be current");

  const sparse = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { ...recovery, quality: { hrv_ms: evidence("fresh", 2), resting_hr: evidence("fresh", 2) } },
  });
  assert.equal(sparse.available, false, "two nights cannot stand in for a recovery trend");

  const undated = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: {
      ...recovery,
      quality: { hrv_ms: { ...evidence(), latest_date: null }, resting_hr: evidence() },
    },
  });
  assert.equal(undated.available, false, "freshness without a dated reading is not decision-grade evidence");

  const bare = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { delta: { hrv: -5, rhr: 4 } },
  });
  assert.equal(bare.available, false, "an unqualified delta cannot become a recovery lead");
});

test("recovery drift accepts the existing provenance and coverage fallback when quality is absent", () => {
  const provenance = { latest_date: "2026-07-13", freshness: "recent" };
  const coverage = { sample_count: 7, expected_days: 14 };
  const out = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: {
      delta: { hrv: -4, rhr: 3 },
      provenance: { hrv_ms: provenance, resting_hr: provenance },
      coverage: { hrv_ms: coverage, resting_hr: coverage },
    },
  });
  assert.equal(out.lead?.domain, "recovery");
  assert.deepEqual(out.lead?.based_on, ["HRV is down while resting HR is up"]);
});

test("a recovery lead speaks STATE once its one-tap draft is waiting (draft_pending)", () => {
  const base = {
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
  };
  const fresh = coachingFocus(base);
  assert.equal(fresh.lead.domain, "recovery");
  assert.notEqual(fresh.lead.draft_pending, true, "no flag while nothing is drafted");

  const pending = coachingFocus({ ...base, recoveryDraftPending: true });
  assert.equal(pending.lead.draft_pending, true);
  assert.match(String(pending.lead.move), /drafted/i, "the move points at the waiting draft, not the same ask again");

  // Strict boolean at the trust boundary — a truthy non-boolean never flips it.
  const sloppy = coachingFocus({ ...base, recoveryDraftPending: "yes" });
  assert.notEqual(sloppy.lead.draft_pending, true);
});

test("a RUNNING recovery week leads as a calm confirmation — no ask, even without deload signals", () => {
  // recoveryWeekActive surfaces the lead on its own (the plan already IS the
  // lighter week), independent of whether the original trigger still reads due.
  const out = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: {},
    recoveryWeekActive: true,
  });
  assert.equal(out.available, true);
  assert.equal(out.lead.domain, "recovery");
  assert.equal(out.lead.recovery_active, true);
  assert.match(out.lead.title, /recovery week/i);
  assert.match(out.lead.why, /lighter/i, "explains the week is deliberately light");
  assert.notEqual(out.lead.draft_pending, true, "never both states at once");

  // Strict boolean — a truthy non-boolean never fabricates a running week.
  const sloppy = coachingFocus({
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: {},
    recoveryWeekActive: 1,
  });
  assert.notEqual(sloppy?.lead?.recovery_active, true);
});

test("coachingFocus promotes an act-now health lever to lead when training is steady", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { delta: { hrv: 0, rhr: 0 } },
    healthFocus: {
      lead: {
        group: "Lipids & Cardiovascular",
        why: "ApoB high",
        tier: "act_now",
        moves: { nutrition: "More fiber and oily fish." },
      },
    },
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

test("coachingFocus carries the block's temporal placement in plain words", () => {
  const withBlock = coachingFocus({
    ...richInput(),
    programBlock: { goal: "Build the squat", focus: "strength", phase: "accumulation", week_of: "week 3 of 5" },
  });
  assert.equal(withBlock.block_line, "Week 3 of 5 — building volume.");

  const deload = coachingFocus({ ...richInput(), programBlock: { phase: "deload", week_of: "week 5 of 5" } });
  assert.match(String(deload.block_line), /^Week 5 of 5 — a deload week/);

  const testWeek = coachingFocus({ ...richInput(), programBlock: { phase: "realization", week_of: "week 6 of 6" } });
  assert.match(String(testWeek.block_line), /test week: express/);

  // No active block → no placement line (and never a fabricated one).
  assert.equal(coachingFocus(richInput()).block_line, null);
  // Constitution: descriptive words only — no score/grade language.
  assert.ok(!/\bscore|grade\b/i.test(String(withBlock.block_line)));
});

test("a stalled training lead carries a one-tap swap payload {from, to[]}", () => {
  const out = coachingFocus(richInput());
  assert.equal(out.lead.domain, "training");
  assert.ok(out.lead.swap, "the stalled lead carries an actionable swap payload");
  assert.equal(out.lead.swap.from, "Overhead Press", "swap.from is the stalled lead lift");
  assert.ok(Array.isArray(out.lead.swap.to), "swap.to is a list of same-pattern options");
  assert.ok(out.lead.swap.to.includes("Push Press"), "swap.to names the real variation");
  assert.ok(out.lead.swap.to.length >= 1 && out.lead.swap.to.length <= 2, "swap.to stays bounded to 2 options");
});

test("a capacity-laggard training lead carries no swap payload (nothing stalled to rotate)", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { delta: { hrv: 0, rhr: 0 } },
    // A laggard lever leads, but no muscle group is STALLING → no rotation to offer.
    performance: {
      lever: { headline: "Bring up your overhead press", why: "furthest-behind lift" },
      endurance: { tone: "steady" },
    },
  });
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.title, /overhead press/i);
  assert.equal(out.lead.swap, undefined, "a laggard lead has no swap payload");
});

test("the swap payload is trimmed and clamped through item sanitization", () => {
  const out = coachingFocus({
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "  Barbell Bench Press  ", // untrimmed → sanitizer trims it
          vary_options: [{ name: " DB Bench Press " }, { name: "Incline Bench Press" }, { name: "Floor Press" }],
        },
      ],
    },
  });
  assert.ok(out.lead.swap, "swap survives sanitization");
  assert.equal(out.lead.swap.from, "Barbell Bench Press", "swap.from is trimmed");
  assert.equal(out.lead.swap.to.length, 2, "swap.to is capped at 2 options");
  assert.deepEqual(
    out.lead.swap.to,
    ["DB Bench Press", "Incline Bench Press"],
    "swap.to entries are trimmed, capped, non-empty"
  );
});

// ── autonomy-awareness: a handled plateau, and lead-mode acts gating ───────────

test("a stalled lead lift no longer on the plan (rotated out) does NOT lead — the stale plateau read is dropped", () => {
  const out = coachingFocus({
    goalMode: "maintain",
    programState: { mesocycle: { phase: "accumulation" } },
    recovery: { delta: { hrv: 0, rhr: 0 } },
    performance: {
      lever: { headline: "Bring up your overhead press", why: "furthest-behind lift" },
      endurance: { tone: "steady" },
    },
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "Barbell Bench Press",
          vary_options: [{ name: "DB Bench Press" }],
        },
      ],
    },
    // The plan no longer runs Barbell Bench Press, and there's no rotation record — the
    // stall can't be acted on, so the conductor falls through to the capacity laggard.
    plannedNames: ["Back Squat", "Deadlift"],
  });
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.title, /overhead press/i, "the capacity laggard leads, not the stale plateau");
  assert.doesNotMatch(out.lead.title, /plateau/i);
  assert.equal(out.lead.swap, undefined, "no swap for a lift that isn't on the plan");
});

test("a stalled lift the brain already rotated out becomes a calm 'handled' note, not a fresh ask", () => {
  const out = coachingFocus({
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "Barbell Bench Press",
          vary_options: [{ name: "DB Bench Press" }],
        },
      ],
    },
    recentRotations: [{ from: "Barbell Bench Press", to: "Incline Bench Press", date: "2026-07-08" }],
    plannedNames: ["Incline Bench Press"],
  });
  // Recovery leads; the handled plateau rides alongside as a calm note (no ask).
  assert.equal(out.lead.domain, "recovery");
  const handled = out.parallel.find((p) => /new stimulus/i.test(p.title));
  assert.ok(handled, "the handled plateau surfaces as a parallel note");
  assert.equal(handled.domain, "training");
  assert.match(handled.why, /rotated in/i);
  assert.match(handled.why, /Incline Bench Press/);
  assert.equal(handled.swap, undefined, "no swap ask — it's already handled");
  // The stale plateau LEAD never appears anywhere.
  const stall = [out.lead, ...out.parallel].find((i) => /break the plateau/i.test(String(i.title || "")));
  assert.equal(stall, undefined, "no stall lead once the rotation is on record");
});

test("a handled rotation never suppresses the capacity-laggard training lead", () => {
  const out = coachingFocus({
    performance: {
      lever: {
        headline: "Bring up your overhead press",
        why: "Furthest behind for your age.",
        target: "Add one focused OHP day.",
      },
    },
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "Barbell Bench Press",
          vary_options: [{ name: "DB Bench Press" }],
        },
      ],
    },
    recentRotations: [{ from: "Barbell Bench Press", to: "Incline Bench Press", date: "2026-07-08" }],
    plannedNames: ["Incline Bench Press"],
  });
  // The live lever still LEADS; the handled plateau does not swallow training.
  assert.equal(out.lead.domain, "training");
  assert.match(out.lead.title, /overhead press/i);
  // The handled note still exists in the read (parallel or later — never the lead).
  const everywhere = [...out.parallel.map((p) => p.title), ...out.later.map((l) => l.title)];
  assert.ok(
    everywhere.some((t) => /new stimulus/i.test(String(t))),
    "handled note rides along"
  );
});

test("an unrelated structural decision is never dressed up as the recovery week", () => {
  const base = {
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
    leadMode: "lead",
  };
  const out = coachingFocus({
    ...base,
    upcoming: [
      {
        kind: "training_structure",
        domain: "training",
        summary: "Move to a 4-day upper/lower split.",
        effective_date: "2026-07-13",
      },
    ],
  });
  assert.equal(out.lead.domain, "recovery");
  assert.doesNotMatch(String(out.lead.move), /lands \w+day/i, "no weekday claim off an unrelated decision");
  assert.match(String(out.lead.move), /automatically at the week boundary/i);
  // The match is STRUCTURAL (domain stamped at write time) — prose that merely says
  // "lighter"/"deload" in another sense can never qualify.
  const prose = coachingFocus({
    ...base,
    upcoming: [
      {
        kind: "training_structure",
        domain: "training",
        summary: "Redistribute the split so your legs get a lighter midweek touch.",
        effective_date: "2026-07-13",
      },
    ],
  });
  assert.doesNotMatch(String(prose.lead.move), /lands \w+day/i, "substring prose never trips the weekday claim");
});

test("under lead mode the stall lead speaks state — never an athlete-directed rotate ask without a button", () => {
  const stallInput = {
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Shoulders",
          lead_lift: "Overhead Press",
          vary_options: [{ name: "Push Press" }, { name: "Z-Press" }],
        },
      ],
    },
    plannedNames: ["Overhead Press"],
  };
  const lead = coachingFocus({ ...stallInput, leadMode: "lead" });
  assert.match(lead.lead.title, /plateau/i);
  assert.equal(lead.lead.swap, undefined);
  assert.doesNotMatch(String(lead.lead.move), /rotate in/i, "no orphaned ask when the buttons are stripped");
  assert.match(String(lead.lead.move), /your coach will rotate/i);
  // Athlete-driven modes keep the actionable copy + payload together.
  const review = coachingFocus({ ...stallInput, leadMode: "review_everything" });
  assert.match(String(review.lead.move), /rotate in/i);
  assert.ok(review.lead.swap);
});

test("plan membership is judged by movement slot, not exact spelling", () => {
  // The plan spells the slot "Dumbbell Bench Press"; the logged/stalled lift reads
  // "DB Bench Press" — same movement slot, so the plateau lead must still surface.
  const out = coachingFocus({
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "DB Bench Press",
          vary_options: [{ name: "Incline DB Press" }],
        },
      ],
    },
    plannedNames: ["Dumbbell Bench Press", "Back Squat"],
  });
  assert.match(String(out.lead.title), /plateau/i, "implement-spelling divergence never hides a live plateau");
});

test("lead posture without background coaching keeps the athlete-driven asks (no empty promises)", () => {
  const input = {
    programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } },
    recovery: {},
    groupsTrajectory: {
      groups: [
        {
          verdict: "stalling",
          label: "Chest",
          lead_lift: "Bench Press",
          vary_options: [{ name: "Incline Bench Press" }],
        },
      ],
    },
    plannedNames: ["Bench Press"],
    leadMode: "lead",
    proactiveEnabled: false,
  };
  const out = coachingFocus(input);
  // With the scheduler off, the coach cannot act unattended — buttons come back.
  assert.equal(out.acts, true);
  assert.doesNotMatch(
    String(out.lead.move ?? ""),
    /automatically/i,
    "never promise unattended work the scheduler can't do"
  );
});

test("lead mode strips the one-tap swap payload and reports acts:false; other modes keep it", () => {
  const lead = coachingFocus({ ...richInput(), leadMode: "lead" });
  assert.equal(lead.acts, false, "lead mode owns the actions server-side");
  assert.equal(lead.lead.domain, "training");
  assert.equal(lead.lead.swap, undefined, "no swap ask under lead mode — the coach rotates itself");
  // The plateau read still speaks (title/why) — only the ACTION is withheld.
  assert.match(lead.lead.title, /plateau|shoulder/i);

  const review = coachingFocus({ ...richInput(), leadMode: "review_everything" });
  assert.equal(review.acts, true);
  assert.ok(review.lead.swap, "off lead mode the athlete-driven swap payload stays");
  // Absent leadMode defaults to acts:true (legacy behavior).
  assert.equal(coachingFocus(richInput()).acts, true);
});

test("under lead mode a due recovery week speaks STATE — the coach sets it up, no ask", () => {
  const base = { programState: { mesocycle: { phase: "deload-due", note: "Time for a lighter week." } }, recovery: {} };
  // With an upcoming RECOVERY-shaped decision, name the weekday it lands (2026-07-13 is a Monday).
  const named = coachingFocus({
    ...base,
    leadMode: "lead",
    upcoming: [
      {
        kind: "training_structure",
        domain: "recovery",
        summary: "Recovery deload week — volume halves.",
        effective_date: "2026-07-13",
      },
    ],
  });
  assert.equal(named.acts, false);
  assert.equal(named.lead.domain, "recovery");
  assert.match(String(named.lead.move), /lands Monday/, "names the weekday the auto-set week arrives");
  assert.match(String(named.lead.move), /undo any time/i);

  // No upcoming decision → the generic auto-boundary note.
  const generic = coachingFocus({ ...base, leadMode: "lead" });
  assert.match(String(generic.lead.move), /automatically at the week boundary/i);
  assert.notEqual(generic.lead.draft_pending, true);

  // A queued draft under lead mode → the "queued, lands automatically" copy (the review
  // link still renders client-side via draft_pending).
  const queued = coachingFocus({ ...base, leadMode: "lead", recoveryDraftPending: true });
  assert.equal(queued.lead.draft_pending, true);
  assert.match(String(queued.lead.move), /queued/i);
});

test("getCoachingFocus memoizes across requests and invalidates on a data write", async () => {
  const { repo } = await import("./_seed.js");
  const first = repo.getCoachingFocus();
  const second = repo.getCoachingFocus();
  assert.equal(second, first, "identity-equal inside the version window (memo hit)");

  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5 }); // bumps the training version
  const third = repo.getCoachingFocus();
  assert.notEqual(third, first, "a training write invalidates the conductor memo");
});
