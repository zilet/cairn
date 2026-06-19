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
