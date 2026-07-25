// The prompt-boundary context projection (src/prompt/context-projection.ts).
//
// Every coaching prompt used to end with `JSON.stringify(getCoachContext())` — the
// whole ~63-key snapshot, ~196 KB on the demo seed, at THIRTEEN sites, on every single
// coaching call. These tests pin the fix in place:
//   1. each site's DATA block is well-formed JSON (the payload shrinks by projecting
//      structure, never by truncating a serialized string),
//   2. each site carries the keys its prompt text / render helpers actually read and
//      omits the ones deliberately dropped, so a future edit cannot silently re-inflate
//      a prompt back to the full dump,
//   3. the shared within-key right-sizing (per-set fields, the duplicated recovery
//      quality maps) stays information-preserving,
//   4. getCoachContext() itself is untouched for every non-prompt consumer.
// Deterministic + offline: the demo seed, no agent CLI, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { seedDemo } from "../dist/demoSeed.js";
import * as repo from "../dist/repo.js";
import {
  buildChatPrompt,
  buildCoachPrompt,
  buildDailyCompositionPrompt,
  buildDayReadPrompt,
  buildHealthReviewPrompt,
  buildHealthSynthesisPrompt,
  buildInsightPrompt,
  buildMealPlanPrompt,
  buildProgramEvolutionPrompt,
  buildSessionPrompt,
  buildSessionVerifyPrompt,
  buildWeekAheadPrompt,
  buildWeeklyReadPrompt,
} from "../dist/prompt.js";
import { projectCoachContext, PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";

// The Stage-2 decision envelope buildDailyCompositionPrompt composes inside.
const ENVELOPE = {
  kind: "train",
  template: { focus: "lower" },
  muscles: { allowed: ["quads", "hamstrings"], required: ["quads"], reduced: [], excluded: [] },
  caps: { volume: "normal", intensity: "normal", duration_min: 45 },
  candidates: [{ exercise: "Back Squat", muscle_group: "quads", action: "progress", note: "+5 lb" }],
};

// Every site: its builder, and the keys it must keep / must have dropped. "Kept"
// names a key the prompt text or one of its render* helpers genuinely reads;
// "dropped" names one this site never mentions and never renders.
const SITES = [
  {
    site: "coach",
    build: () => buildCoachPrompt(),
    kept: ["plan", "recent_sessions", "program_state", "recovery", "directives", "garmin"],
    dropped: ["day_read", "recent_decisions", "insights", "whole_person_trajectory"],
  },
  {
    site: "program_evolution",
    build: () => buildProgramEvolutionPrompt(),
    kept: ["plan", "recent_sessions", "program_state", "program_balance", "garmin"],
    dropped: ["day_read", "recent_decisions", "insights", "whole_person_trajectory"],
  },
  {
    site: "day_read",
    build: () => buildDayReadPrompt(),
    kept: ["recovery", "signal_state", "coaching_focus", "recent_sessions", "day_intake", "health_focus"],
    // day_read recomputes a FRESH deterministic baseline and renders the last few
    // days' reads itself — handing it the STORED read invites parroting.
    dropped: ["day_read", "garmin", "recent_decisions", "insights"],
  },
  {
    site: "session",
    build: () => buildSessionPrompt(undefined, { minutes: 45 }),
    kept: ["plan", "recent_sessions", "program_state", "recovery", "context_events"],
    dropped: ["signal_state", "garmin", "day_read", "recent_decisions"],
  },
  {
    site: "daily_composition",
    build: () => buildDailyCompositionPrompt(ENVELOPE),
    // The envelope has already decided kind/muscles/caps/candidates; this prompt
    // only needs the guardrail keys plus enough history to carry loads over.
    kept: ["plan", "recent_sessions", "context_events", "directives", "health"],
    dropped: ["recovery", "program_state", "performance", "signal_state", "coaching_focus", "run_plan", "journey"],
  },
  {
    site: "insight",
    build: () => buildInsightPrompt(undefined, []),
    kept: ["recovery", "directives", "health", "recent_sessions", "day_intake", "whole_person_trajectory"],
    dropped: ["garmin", "signal_state", "coaching_focus", "day_read", "recent_decisions"],
  },
  {
    site: "weekly_read",
    build: () => buildWeeklyReadPrompt(),
    kept: ["recent_sessions", "recovery", "day_intake", "recent_decisions", "run_compliance"],
    dropped: ["health", "imaging", "health_review", "garmin", "signal_state", "day_read"],
  },
  {
    // Chat is the free-form surface — any question can land, so nothing is dropped.
    site: "chat",
    build: () => buildChatPrompt([], "how did my week go?"),
    kept: ["memory", "supplements", "goal", "day_read", "garmin", "recent_decisions", "imaging"],
    dropped: [],
  },
  {
    site: "health_review",
    build: () => buildHealthReviewPrompt(),
    kept: ["health", "imaging", "directives", "body_composition", "recovery", "recent_sessions"],
    dropped: ["performance", "program_balance", "coaching_focus", "signal_state", "garmin", "day_read"],
  },
  {
    site: "health_synthesis",
    build: () => buildHealthSynthesisPrompt(),
    kept: ["health", "directives", "supplements", "recovery", "body_metrics", "recent_sessions"],
    dropped: ["performance", "coaching_focus", "signal_state", "garmin", "recent_decisions"],
  },
  {
    site: "week_ahead",
    build: () => buildWeekAheadPrompt(),
    kept: ["plan", "recent_sessions", "program_state", "recovery", "directives", "coaching_focus"],
    dropped: ["health", "imaging", "health_review", "garmin", "day_read", "day_intake"],
  },
  {
    // Plan-shaping and constitution-bound: the allergen/diet sources, the nutrition
    // directives and the training split all have to survive.
    site: "meal_plan",
    build: () => buildMealPlanPrompt(),
    kept: ["profile", "family", "memory", "directives", "health_focus", "plan", "goal", "meal_plan", "recovery"],
    dropped: ["garmin", "day_read", "recent_decisions", "insights", "program_balance", "groups_trajectory"],
  },
  {
    // The safety checker: every contraindication source stays reachable.
    site: "session_verify",
    build: () => buildSessionVerifyPrompt({ name: "Lower body", items: [] }, { minutes: 45 }),
    kept: ["context_events", "memory", "directives", "health", "imaging", "plan", "recent_sessions"],
    dropped: ["recovery", "garmin", "day_intake", "meal_plan", "coaching_focus", "day_read"],
  },
];

// The serialized payload a prompt hands the agent: the line after its final `DATA…:`
// marker line. JSON.stringify never emits a literal newline, so the payload is always
// exactly one line — which also covers the verify prompts, whose labelled DATA block
// is followed by their result-contract note rather than ending the prompt.
function dataBlock(prompt) {
  const lines = prompt.split("\n");
  const at = lines.findLastIndex((line) => /^DATA\b.*:$/.test(line));
  assert.ok(at >= 0 && at + 1 < lines.length, "the prompt carries a labelled DATA block");
  return lines[at + 1];
}

test("every prompt site emits well-formed JSON carrying exactly its allowlisted keys", () => {
  seedDemo();
  const full = repo.getCoachContext();
  for (const { site, build, kept, dropped } of SITES) {
    const payload = dataBlock(build());
    // Parsing is the guardrail against ever shrinking a prompt by slicing its JSON:
    // a malformed blob in a prompt is worse than a large one.
    const parsed = JSON.parse(payload);
    const expected = PROMPT_CONTEXT_SITES[site].keys.filter((key) => Object.hasOwn(full, key));
    assert.deepEqual(
      Object.keys(parsed).sort(),
      [...new Set(expected)].sort(),
      `${site} serializes exactly its allowlisted keys`
    );
    for (const key of kept) assert.ok(Object.hasOwn(parsed, key), `${site} keeps ${key}`);
    for (const key of dropped) assert.ok(!Object.hasOwn(parsed, key), `${site} drops ${key}`);
  }
});

test("logged sets keep what a coach reads and shed internal bookkeeping", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const raw = ctx.recent_sessions.flatMap((session) => session.sets ?? []);
  assert.ok(raw.length > 0, "the demo seed logs real sets");
  assert.ok(Object.hasOwn(raw[0], "created_at") && Object.hasOwn(raw[0], "exercise_id"), "the snapshot keeps them");

  const projected = projectCoachContext(ctx, "coach").recent_sessions.flatMap((session) => session.sets ?? []);
  assert.equal(projected.length, raw.length, "no set is lost at the full-window sites");
  for (const set of projected) {
    for (const gone of ["id", "session_id", "exercise_id", "created_at"]) {
      assert.ok(!Object.hasOwn(set, gone), `a serialized set drops ${gone}`);
    }
    assert.ok(Object.hasOwn(set, "exercise") && Object.hasOwn(set, "mode"), "and keeps what was lifted");
  }
  // Fields are PROJECTED, never null-stripped: weight null = bodyweight and a
  // negative weight = assist, so absent and null are different facts.
  const withNullWeight = { exercise: "Pull-up", mode: "reps", weight: null, reps: 8, id: 1, created_at: "x" };
  const ctxWithBodyweight = { recent_sessions: [{ date: "2026-01-01", sets: [withNullWeight] }] };
  const [bodyweightSet] = projectCoachContext(ctxWithBodyweight, "coach").recent_sessions[0].sets;
  assert.ok(Object.hasOwn(bodyweightSet, "weight") && bodyweightSet.weight === null, "bodyweight survives as null");
  assert.equal(bodyweightSet.reps, 8);
});

test("the recovery view ships one quality map instead of four copies of it", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  // getRecoverySummary builds `coverage` and `provenance` as literal projections of
  // `quality`, and nests the same map inside `recovery.recovery`.
  assert.ok(ctx.recovery.coverage && ctx.recovery.provenance, "the snapshot still carries both");

  const projected = projectCoachContext(ctx, "day_read").recovery;
  assert.ok(!Object.hasOwn(projected, "coverage"), "the derived coverage map is dropped");
  assert.ok(!Object.hasOwn(projected, "provenance"), "so is the derived provenance map");
  assert.ok(!Object.hasOwn(projected.recovery, "quality"), "and the nested duplicate");
  // Everything they contained is still reachable through the one surviving map.
  const [metric, entry] = Object.entries(ctx.recovery.coverage)[0];
  assert.deepEqual(
    {
      sample_count: projected.quality[metric].sample_count,
      expected_days: projected.quality[metric].expected_days,
      window_days: projected.quality[metric].window_days,
    },
    entry,
    "quality is a superset of the coverage entry"
  );
  assert.equal(projected.quality[metric].source, ctx.recovery.provenance[metric].source);
  assert.ok(projected.has_data === ctx.recovery.has_data && projected.days === ctx.recovery.days);
});

// The regression this whole change exists to prevent: the ambient snapshot riding on
// every coaching call had grown to ~196 KB — 2-3x the budget the bounded coach-read
// TOOLS allow for an entire query loop. The ceiling is generous on purpose (it must
// not flake as the demo seed's dates roll); what it catches is a future prompt or
// context key quietly restoring the whole-snapshot dump.
const DAY_READ_DATA_CEILING_BYTES = 140_000;

test("the Brief's DATA payload stays under its byte ceiling", () => {
  seedDemo();
  const payload = dataBlock(buildDayReadPrompt());
  const full = JSON.stringify(repo.getCoachContext());
  assert.ok(
    payload.length <= DAY_READ_DATA_CEILING_BYTES,
    `day-read DATA is ${payload.length} bytes, over the ${DAY_READ_DATA_CEILING_BYTES} ceiling`
  );
  // Belt to the ceiling's suspenders, and immune to how big the seed happens to be:
  // the projected payload must stay a real fraction of the raw snapshot.
  assert.ok(
    payload.length < full.length * 0.75,
    `day-read DATA (${payload.length}) should stay well under the raw snapshot (${full.length})`
  );
  assert.ok(dataBlock(buildDailyCompositionPrompt(ENVELOPE)).length < full.length * 0.4, "a narrow site cuts far more");
});

test("getCoachContext stays complete for every non-prompt consumer", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  // The projection happens at the prompt boundary — MCP tools, routes and agentJobs
  // must still see the keys individual prompts drop.
  for (const key of ["garmin", "day_read", "recent_decisions", "insights", "signal_state", "whole_person_trajectory"]) {
    assert.ok(Object.hasOwn(ctx, key), `the shared snapshot keeps ${key}`);
  }
  assert.ok(
    ctx.recent_sessions[0].sets.every((set) => Object.hasOwn(set, "created_at")),
    "and full set rows"
  );
});

test("projecting a partial context never invents keys", () => {
  const partial = { now: { date: "2026-07-25" }, recent_sessions: [] };
  const projected = projectCoachContext(partial, "day_read");
  assert.deepEqual(Object.keys(projected).sort(), ["now", "recent_sessions"]);
  assert.deepEqual(projectCoachContext({}, "chat"), {});
});
