// Stream B wiring — the program-evolution PROMPT (the agentic call itself needs a
// CLI and isn't part of the offline suite, but the prompt it builds is fully
// deterministic). These lock that the evolution prompt actually carries the
// program-state read, concrete variation candidates for a stalled lift, the
// active periodization block, and the plan output contract — and that an active
// block also periodizes the normal coach prompt.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { buildProgramEvolutionPrompt, buildCoachPrompt } from "../dist/prompt.js";

const REF = "2026-05-01";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("logged_sets", "session_skips", "sessions", "activities", "plan_items", "plan_days", "program_blocks", "daily_metrics", "checkins");
});

test("the evolution prompt carries the program-state, the schema, and variation candidates for a stalled lift", () => {
  // A clearly plateaued lift: same load, 5 sessions, taken near failure.
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  const p = buildProgramEvolutionPrompt();
  assert.match(p, /PROGRAM-STATE/i, "embeds the deterministic program-state read");
  assert.match(p, /VARIATION CANDIDATES/, "offers concrete same-pattern variations to break the plateau");
  assert.match(p, /Bench Press →/, "names the stalled lift's variation options");
  assert.match(p, /"changes"/, "uses the plan output contract (changes/cardio/days)");
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(p), "no 0-100 score leaks into the prompt");
});

test("an active periodization block periodizes BOTH the evolution and the normal coach prompt", () => {
  repo.createBlock({ goal: "Build squat base", focus: "strength", total_weeks: 5, week_index: 5 }); // last week → deload phase
  const evo = buildProgramEvolutionPrompt();
  const coach = buildCoachPrompt();
  assert.match(evo, /ACTIVE TRAINING BLOCK/, "evolution prompt sees the block");
  assert.match(coach, /ACTIVE TRAINING BLOCK/, "coach prompt sees the block too");
  assert.match(coach, /Build squat base/, "names the block goal");
  assert.match(coach, /deload/i, "the last week reads as a deload phase to lighten");
});

test("no block, no lifts → the evolution prompt still builds cleanly (degrades, never throws)", () => {
  const p = buildProgramEvolutionPrompt();
  assert.match(p, /PROGRAM-STATE/i);
  assert.ok(!/VARIATION CANDIDATES/.test(p), "no stalled lifts → no variation block");
  assert.ok(!/ACTIVE TRAINING BLOCK/.test(p), "no block → no block line");
});

// programEvolutionTrigger — the DATA-TRIGGERED half of the continuous-coach
// cadence (scheduler fires an EARLY evolution draft when these conditions show up
// before the weekly slot). Pure function with injectable state → tested with
// fixtures, no DB. Invariants: a real shift is `due` with a plain reason + a
// STABLE signature (so a standing condition drafts once, not daily); a brand-new
// plan's "every group under-trained" is NOT a shift; nothing → calm not-due.
test("trigger fires on a stalled lift that wants a variation (names it, stable signature, no [object Object])", () => {
  const out = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Overhead Press", status: "plateaued", suggested_action: "vary", sessions: 6 }] },
    balance: { due: [], over: [] },
    testWeek: { due: false },
  });
  assert.equal(out.due, true);
  assert.match(out.reasons.join(" "), /Overhead Press/);
  assert.match(out.reasons.join(" "), /stalled/i);
  assert.match(out.signature, /vary:Overhead Press/);
  assert.ok(!/\[object Object\]/.test(JSON.stringify(out)), "never leaks [object Object]");
});

test("trigger fires on a re-test due", () => {
  const out = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [] },
    balance: { due: [], over: [] },
    testWeek: { due: true, key_lifts: ["Back Squat", "Bench Press"] },
  });
  assert.equal(out.due, true);
  assert.match(out.reasons.join(" "), /re-test/i);
  assert.match(out.signature, /test:1/);
});

test("a weak-point group only triggers for an athlete who is actually training", () => {
  const dueGroups = { due: ["Core", "Rear delts"], over: [] };
  // Brand-new plan: lifts logged but thin history (no group has ≥4 sessions) and
  // nothing stalled / due-to-test → "every group is under-trained" is a blank
  // start, NOT a shift. Calm no-op.
  const fresh = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Squat", status: "new", suggested_action: "hold", sessions: 1 }] },
    balance: dueGroups,
    testWeek: { due: false },
  });
  assert.equal(fresh.due, false, "a fresh plan's under-trained groups do not trigger");
  assert.equal(fresh.signature, "");

  // Same weak points, but a real training history → now it's a genuine weak-point
  // to build toward, so it triggers.
  const trained = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Squat", status: "progressing", suggested_action: "overload", sessions: 8 }] },
    balance: dueGroups,
    testWeek: { due: false },
  });
  assert.equal(trained.due, true, "with history, an under-trained group triggers");
  assert.match(trained.signature, /due:Core,Rear delts/);
});

test("the signature is order-stable so a standing condition drafts once, not daily", () => {
  const a = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Press", status: "regressing", suggested_action: "deload", sessions: 9 }] },
    balance: { due: ["Hamstrings", "Core"], over: [] },
    testWeek: { due: false },
  });
  // Same conditions, groups supplied in a different order → identical signature.
  const b = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Press", status: "regressing", suggested_action: "deload", sessions: 9 }] },
    balance: { due: ["Core", "Hamstrings"], over: [] },
    testWeek: { due: false },
  });
  assert.equal(a.due, true);
  assert.equal(a.signature, b.signature, "signature is stable regardless of input order");
});

test("nothing material → not due, empty signature (calm no-op)", () => {
  const out = repo.programEvolutionTrigger("2026-06-26", {
    programState: { lifts: [{ exercise: "Squat", status: "progressing", suggested_action: "overload", sessions: 10 }] },
    balance: { due: [], over: [] },
    testWeek: { due: false },
  });
  assert.equal(out.due, false);
  assert.deepEqual(out.reasons, []);
  assert.equal(out.signature, "");
});
