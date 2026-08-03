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
import { renderCoachingFocus } from "../dist/prompt/shared.js";

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
    kept: ["training_intent", "endurance_capacity", "plan", "recent_sessions", "program_state", "recovery", "directives", "garmin"],
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
    kept: ["training_intent", "endurance_capacity", "recovery", "signal_state", "coaching_focus", "recent_sessions", "day_intake", "health_focus", "read_adherence"],
    // day_read recomputes a FRESH deterministic baseline and renders the last few
    // days' reads itself — handing it the STORED read invites parroting.
    dropped: ["day_read", "garmin", "recent_decisions", "insights"],
  },
  {
    site: "session",
    build: () => buildSessionPrompt(undefined, { minutes: 45 }),
    kept: ["training_intent", "endurance_capacity", "plan", "recent_sessions", "program_state", "recovery", "context_events"],
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
    kept: ["training_intent", "endurance_capacity", "profile", "family", "memory", "directives", "health_focus", "plan", "goal", "meal_plan", "recovery"],
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

// The deterministic layer's WORKING is not the model's evidence. `verified` carries the
// raw series each excursion test walks — up to 90 {date, value} pairs per metric, ~6 KB
// on every recovery-carrying site — and handing it over does worse than cost tokens: it
// invites the model to re-derive by eye the very claims the classification above it
// deliberately withholds (a provisional or aged-out reading is not a finding). The
// answer ships; the arithmetic does not. `min_hr`'s quality entry goes with it: the
// field exists only so a resting-HR row can be checked against its own floor.
test("the raw verified series and min_hr plumbing stay out of every prompt", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  assert.ok(Array.isArray(ctx.recovery.verified.resting_hr.readings), "the snapshot still carries the series");

  for (const site of ["day_read", "coach", "chat", "weekly_read", "insight"]) {
    const projected = projectCoachContext(ctx, site).recovery;
    if (!projected?.verified) continue;
    for (const [metric, trust] of Object.entries(projected.verified)) {
      assert.ok(!Object.hasOwn(trust, "readings"), `${site}: ${metric} still ships its raw readings`);
      // The classification — which IS the answer — survives intact.
      assert.equal(trust.latest_trust, ctx.recovery.verified[metric].latest_trust);
      assert.equal(trust.latest_trustworthy_date, ctx.recovery.verified[metric].latest_trustworthy_date);
      assert.equal(trust.latest_date, ctx.recovery.verified[metric].latest_date);
    }
    assert.ok(!Object.hasOwn(projected.quality, "min_hr"), `${site}: min_hr is corroboration plumbing`);
  }
  // And nothing was taken from the snapshot every non-prompt consumer reads.
  assert.ok(ctx.recovery.verified.resting_hr.readings.length >= 0 && ctx.recovery.quality.min_hr !== undefined);
});

// The regression this whole change exists to prevent: the ambient snapshot riding on
// every coaching call had grown to ~196 KB — 2-3x the budget the bounded coach-read
// TOOLS allow for an entire query loop. The ceiling is generous on purpose (it must
// not flake as the demo seed's dates roll); what it catches is a future prompt or
// context key quietly restoring the whole-snapshot dump.
// Lowered when the Brief's `recent_sessions` stopped shipping raw set rows, Garmin
// payloads and composition blobs (session_detail: "summary"). Still generous — it
// must not flake as the seed's dates roll — but it now locks that gain in.
const DAY_READ_DATA_CEILING_BYTES = 120_000;

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
  for (const key of ["training_intent", "endurance_capacity", "garmin", "day_read", "recent_decisions", "insights", "signal_state", "whole_person_trajectory"]) {
    assert.ok(Object.hasOwn(ctx, key), `the shared snapshot keeps ${key}`);
  }
  assert.ok(
    ctx.recent_sessions[0].sets.every((set) => Object.hasOwn(set, "created_at")),
    "and full set rows"
  );
});

test("training, day, and nutrition prompts honor ordered intent without treating age as fragility", () => {
  seedDemo();
  repo.setProfile({
    age: 46,
    primary_discipline: "hybrid",
    training_intent: {
      priorities: ["longevity", "muscle", "leanness", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "MTB", target_duration_min: 120, context: "trail-ready" },
    },
  });
  for (const prompt of [buildCoachPrompt(), buildDayReadPrompt(), buildMealPlanPrompt()]) {
    assert.match(prompt, /longevity → muscle → leanness → endurance/);
    assert.match(prompt, /ENDURANCE ROLE: SUPPORTING/);
    assert.match(prompt, /120 minutes of MTB/);
    assert.match(prompt, /never an automatic brake/i);
    assert.match(prompt, /must not silently overwrite|stays separate|durable athlete intent/i);
  }
});

test("projecting a partial context never invents keys", () => {
  const partial = { now: { date: "2026-07-25" }, recent_sessions: [] };
  const projected = projectCoachContext(partial, "day_read");
  assert.deepEqual(Object.keys(projected).sort(), ["now", "recent_sessions"]);
  assert.deepEqual(projectCoachContext({}, "chat"), {});
});

// ---------- the deterministic floor's prose never comes back as the agent's focus ----
// `day_read` is dropped from every site because "handing it today's stored read invites
// parroting" — but the SAME sentence rode back in through the conductor. On a
// rest/easy/done posture the conductor's `lead.why` is built from the identical voice,
// key and date the Brief's `why` uses (deliberately: one signal must read as one
// observation on the athlete's screen), so the prompt was labelling the floor's own
// sentence "THIS BLOCK'S ONE FOCUS" and then asking the agent for an independent read.
const POSTURE_PROSE = "Short nights have been stacking up — today is a good day to give some of that back.";
const POSTURE_FOCUS = {
  available: true,
  headline: "Steady. This block: keep today easy.",
  lead: {
    domain: "recovery",
    title: "Keep today easy",
    why: POSTURE_PROSE,
    move: "Keep movement genuinely easy; leave hard loading for the next ready day.",
    based_on: ["Unified planning posture: easy", "Recent sleep is running short."],
    day_posture: "easy",
  },
  parallel: [],
  later: [],
  connections: [],
  retest: null,
  caveat: null,
};

test("a day-posture lead reaches the agent as grounds, never as the Brief's own sentence", () => {
  for (const brief of [true, false]) {
    const rendered = renderCoachingFocus({ coaching_focus: POSTURE_FOCUS }, { brief });
    assert.ok(!rendered.includes(POSTURE_PROSE), `${brief ? "brief" : "full"} render drops the floor's phrasing`);
    // What the conductor points at, and the machine-register evidence it pointed on,
    // both survive — the agent must still know the posture and be able to disagree.
    assert.ok(rendered.includes("Keep today easy"), "the title survives");
    assert.ok(rendered.includes("leave hard loading for the next ready day"), "so does the concrete move");
    assert.ok(rendered.includes("Unified planning posture: easy"), "and the grounds");
    assert.ok(rendered.includes("Recent sleep is running short."), "including every based_on entry");
  }
});

test("a lead with no day posture keeps its why — that string can carry the work-around caveat", () => {
  const focus = {
    ...POSTURE_FOCUS,
    lead: {
      domain: "training",
      title: "Bring up your squat",
      why: "It has stalled for three weeks. Use pain-free substitutions.",
    },
    parallel: [{ domain: "nutrition", title: "Hold a lean-safe deficit", why: "Protein high, deficit modest." }],
  };
  for (const brief of [true, false]) {
    const rendered = renderCoachingFocus({ coaching_focus: focus }, { brief });
    assert.ok(
      rendered.includes("It has stalled for three weeks. Use pain-free substitutions."),
      "the lead's why survives"
    );
    assert.ok(!rendered.includes("GROUNDS"), "and no grounds line replaces it");
  }
  const full = renderCoachingFocus({ coaching_focus: focus }, {});
  assert.ok(full.includes("Protein high, deficit modest."), "a parallel item keeps its why too");
});

// The caveat is selected by CAUSE — health constraints, fueling, recovery capacity,
// accumulated load or life capacity — so the fixed "(injury/soreness)" label described
// four of the five wrongly. The prompt layer labels it from whatever cause the conductor
// publishes and stays neutral otherwise; it must not keep a second cause taxonomy.
test("the caveat label never claims a cause the conductor did not name", () => {
  const fuelCaveat =
    "Your fuel has been running behind the work. Eat around the work first and keep today's dose modest.";
  const withCaveat = { ...POSTURE_FOCUS, caveat: fuelCaveat };
  for (const brief of [true, false]) {
    const rendered = renderCoachingFocus({ coaching_focus: withCaveat }, { brief });
    assert.ok(!rendered.includes("injury/soreness"), `${brief ? "brief" : "full"} render stops calling fuel an injury`);
    assert.ok(rendered.includes(`EASE AROUND: ${fuelCaveat}`), "the caveat ships whole under a neutral label");
  }
  // When the conductor does publish a cause, the label follows it verbatim.
  const named = renderCoachingFocus(
    { coaching_focus: { ...withCaveat, caveat_cause: "energy_fueling" } },
    { brief: true }
  );
  assert.ok(named.includes("EASE AROUND (energy fueling):"), "a published cause names the label");
});

test("every site carrying the conductor strips the posture prose from its DATA too", () => {
  const conductorSites = Object.keys(PROMPT_CONTEXT_SITES).filter((site) =>
    PROMPT_CONTEXT_SITES[site].keys.includes("coaching_focus")
  );
  assert.ok(conductorSites.length >= 6, "the conductor reaches several sites");
  for (const site of conductorSites) {
    const payload = JSON.stringify(projectCoachContext({ coaching_focus: POSTURE_FOCUS }, site));
    assert.ok(!payload.includes(POSTURE_PROSE), `${site} DATA drops the floor's phrasing`);
    const parsed = JSON.parse(payload);
    assert.equal(parsed.coaching_focus.lead.title, "Keep today easy", `${site} keeps the title`);
    assert.deepEqual(parsed.coaching_focus.lead.based_on, POSTURE_FOCUS.lead.based_on, `${site} keeps the grounds`);
    assert.equal(parsed.coaching_focus.lead.day_posture, "easy", `${site} keeps the posture itself`);
  }
  // Only the posture item loses its prose; every other lever's `why` is untouched.
  const stalled = {
    ...POSTURE_FOCUS,
    lead: { domain: "training", title: "Bring up your squat", why: "Stalled three weeks." },
  };
  const kept = projectCoachContext({ coaching_focus: stalled }, "day_read");
  assert.equal(kept.coaching_focus.lead.why, "Stalled three weeks.");
  // And the projection never mutates the caller's snapshot.
  assert.equal(POSTURE_FOCUS.lead.why, POSTURE_PROSE, "the shared context object is left alone");
});

// The Brief is the read `read_adherence` MEASURES, so it is the one site where the
// divergence pattern is about the very decision being made — and the one site where a
// key that ships every single morning has to be cut to size before it goes anywhere.
test("the Brief carries the adherence pattern, compacted", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  assert.ok(ctx.read_adherence, "the snapshot carries the full model");

  const projected = projectCoachContext(ctx, "day_read").read_adherence;
  assert.deepEqual(Object.keys(projected).sort(), ["by_read", "recent"], "counts and recent days, nothing else");
  assert.ok(Array.isArray(projected.by_read));
  assert.ok(projected.recent.length <= 7, `recent is capped at a week, got ${projected.recent.length}`);
  // The counts must never travel without the plain-words test behind them — a
  // followed `train` day means training was logged, not that it was hard.
  for (const row of projected.by_read) {
    assert.equal(typeof row.measures, "string");
    assert.ok(row.measures.length > 0, `${row.read} lost the sentence that says what its counts mean`);
  }
  // The operator-only window bookkeeping stays out of every prompt.
  for (const gone of ["as_of", "window_days", "days_observed"]) {
    assert.ok(!Object.hasOwn(projected, gone), `the prompt payload drops ${gone}`);
  }
  // And it is genuinely small: this ships on every morning open.
  assert.ok(JSON.stringify(projected).length < 2_000, "the adherence block stays a footnote on the payload");
});

test("a fourteen-day model reaches the prompt as at most seven days", () => {
  const recent = Array.from({ length: 14 }, (_, n) => ({
    date: `2026-03-${String(n + 1).padStart(2, "0")}`,
    read: "rest",
    outcome: "diverged",
    load: "hard",
    trained: true,
  }));
  const projected = projectCoachContext(
    { read_adherence: { as_of: "2026-03-15", window_days: 42, days_observed: 14, by_read: [], recent } },
    "day_read"
  ).read_adherence;
  assert.equal(projected.recent.length, 7);
  assert.equal(projected.recent[0].date, "2026-03-08", "the MOST RECENT week is what survives");
  assert.equal(projected.recent.at(-1).date, "2026-03-14");
});

// ---- the Brief reads the RHYTHM of training, not every set of it -------------
//
// `recent_sessions` was the single largest key in the one prompt that ships every
// morning, and most of its weight was structure the Brief never reads: the raw set
// rows (already digested into training_signals / program_state / progression), the
// Garmin payload and the daily-composition blob. On a deployed DB a session with
// ZERO logged sets still cost several KB of the last two.

test("the Brief's sessions carry the shape of the work, not the raw set rows", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const projected = projectCoachContext(ctx, "day_read").recent_sessions;
  assert.ok(projected.length > 0, "the demo seed logs real sessions");

  for (const session of projected) {
    for (const gone of ["garmin", "daily_session", "id", "plan_day_id", "created_at"]) {
      assert.ok(!Object.hasOwn(session, gone), `a summarized session drops ${gone}`);
    }
    // What a day read actually uses: when, what kind, and what they said about it.
    for (const kept of ["date", "kind"]) assert.ok(Object.hasOwn(session, kept), `it keeps ${kept}`);
    for (const set of session.sets ?? []) {
      assert.ok(Object.hasOwn(set, "exercise") && Object.hasOwn(set, "sets"), "a roll-up names the movement + volume");
      assert.ok(!Object.hasOwn(set, "set_number"), "and is not a set row");
    }
  }

  // Feedback survives verbatim — it is the whole reason the Brief looks at sessions.
  const rated = ctx.recent_sessions.find((s) => s.soreness != null || s.performance != null || s.joint_pain);
  if (rated) {
    const match = projected.find((s) => s.date === rated.date);
    assert.ok(match, "the rated session is still in the window");
    assert.equal(match.soreness, rated.soreness);
    assert.equal(match.performance, rated.performance);
    assert.equal(match.joint_pain, rated.joint_pain);
  }
});

test("the roll-up keeps the top set honest about both weight encodings", () => {
  const sets = [
    { exercise: "Squat", mode: "reps", set_number: 1, weight: 185, reps: 5, rir: 2 },
    { exercise: "Squat", mode: "reps", set_number: 2, weight: 205, reps: 3, rir: 1 },
    { exercise: "Pull-up", mode: "reps", set_number: 1, weight: -30, reps: 8, rir: 2 },
    { exercise: "Pull-up", mode: "reps", set_number: 2, weight: -10, reps: 5, rir: 1 },
    { exercise: "Push-up", mode: "reps", set_number: 1, weight: null, reps: 12, rir: 2 },
    { exercise: "Push-up", mode: "reps", set_number: 2, weight: null, reps: 20, rir: 1 },
    // Assistance came off mid-exercise: the unassisted set is the harder one, and
    // it is the one the rollup must call best. Ranking any numbered weight above
    // bodyweight put the machine-assisted set on top instead.
    { exercise: "Chin-up", mode: "reps", set_number: 1, weight: -30, reps: 8, rir: 2 },
    { exercise: "Chin-up", mode: "reps", set_number: 2, weight: null, reps: 4, rir: 1 },
    { exercise: "Plank", mode: "timed", set_number: 1, duration_sec: 45 },
    { exercise: "Plank", mode: "timed", set_number: 2, duration_sec: 70 },
  ];
  const ctx = { recent_sessions: [{ date: "2026-01-01", kind: "strength", sets }] };
  const [session] = projectCoachContext(ctx, "day_read").recent_sessions;
  const by = Object.fromEntries(session.sets.map((row) => [row.exercise, row]));

  // `total_reps` is the cross-set total and says so — it used to be `reps`, the same
  // name the per-set rows carry, sitting next to the per-set `top_reps`.
  assert.deepEqual(
    {
      sets: by.Squat.sets,
      total_reps: by.Squat.total_reps,
      top_weight: by.Squat.top_weight,
      top_reps: by.Squat.top_reps,
    },
    { sets: 2, total_reps: 8, top_weight: 205, top_reps: 3 }
  );
  assert.ok(!Object.hasOwn(by.Squat, "reps"), "the ambiguous name is gone");
  // Assisted: -10 is TEN pounds of help, which is the harder set of the two.
  assert.equal(by["Pull-up"].top_weight, -10);
  // Bodyweight stays null (never absent, never 0), and more reps is the better set.
  assert.ok(Object.hasOwn(by["Push-up"], "top_weight") && by["Push-up"].top_weight === null);
  assert.equal(by["Push-up"].top_reps, 20);
  // Bodyweight outranks assistance: four unassisted beats eight with 30 lb of help.
  assert.equal(by["Chin-up"].top_weight, null, "the true bodyweight set is the best set");
  assert.equal(by["Chin-up"].top_reps, 4);
  // A timed movement ranks on seconds and carries no load at all.
  assert.equal(by.Plank.top_duration_sec, 70);
  assert.ok(!Object.hasOwn(by.Plank, "top_weight"));
});

test("only the Brief summarizes: every other site keeps its full set rows", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const rawSets = ctx.recent_sessions.flatMap((session) => session.sets ?? []).length;
  assert.ok(rawSets > 0);

  for (const [site, spec] of Object.entries(PROMPT_CONTEXT_SITES)) {
    const projected = projectCoachContext(ctx, site).recent_sessions ?? [];
    const summarized = spec.session_detail === "summary";
    assert.equal(summarized, site === "day_read", `${site}: only the Brief summarizes`);
    if (summarized) continue;
    const inWindow = ctx.recent_sessions.slice(0, spec.sessions);
    assert.equal(
      projected.flatMap((session) => session.sets ?? []).length,
      inWindow.flatMap((session) => session.sets ?? []).length,
      `${site} keeps every set in its window`
    );
    // And the session-level blobs a plan-shaping site may read are untouched.
    for (const key of ["garmin", "daily_session"]) {
      if (inWindow.length && Object.hasOwn(inWindow[0], key)) {
        assert.ok(Object.hasOwn(projected[0], key), `${site} keeps ${key}`);
      }
    }
  }
});
