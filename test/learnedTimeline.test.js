// The learned timeline (src/repo/learned-timeline.ts) — a calm, legible
// "what Cairn has understood about you" read. It is a thin, deterministic
// PROJECTION over data the app already owns (load-bearing memories, outcome
// learnings, propagated health directives, applied plan proposals). Invariants:
//   - aggregates from EXISTING sources, newest-first by `when`
//   - bounded by `limit` (sane default ~40)
//   - deduped (the same understanding never appears twice)
//   - EXPLAINS, never GRADES — NO numeric score in ANY field (constitution)
//   - null-safe / degrades to fewer items, never throws
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("memory", "health_directives", "plan_proposals", "suggestions");
});

// No numeric "score"/"grade"/"%" should ever appear in a timeline field — the
// constitution bans surfacing them. (A bare year like "2026" is fine; this guards
// against an accuracy %, a 0-100 grade, or a "score: N" leaking through.)
function assertNoScores(items) {
  for (const it of items) {
    const blob = `${it.title || ""} ${it.detail || ""} ${it.source || ""}`.toLowerCase();
    assert.ok(!/\bscore\b/.test(blob), `no "score" in: ${blob}`);
    assert.ok(!/\bgrade\b/.test(blob), `no "grade" in: ${blob}`);
    assert.ok(!/\baccuracy\b/.test(blob), `no "accuracy" in: ${blob}`);
    assert.ok(!/\d+\s?%/.test(blob), `no percentage in: ${blob}`);
  }
}

test("aggregates memories, a directive, and an applied proposal — newest-first, no scores", () => {
  // A load-bearing memory (durable person-model) — should surface.
  repo.addMemory("Left shoulder impingement; avoid heavy overhead pressing", "injury", "user");
  // A connected-brain directive (a propagated connection).
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Lean toward more soluble fiber and oily fish",
    rationale: "ApoB sits above the optimal band",
  });
  // An applied plan proposal (a change you accepted).
  const prop = repo.createProposal("stub", "Add a back movement to Thursday", "{}", {
    changes: [{ exercise: "Barbell Row", target_weight: 135 }],
  });
  repo.setProposalStatus(prop.id, "applied");

  const { items } = repo.learnedTimeline();
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 3, `expected >= 3 items, got ${items.length}`);

  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(kinds.has("memory"));
  assert.ok(kinds.has("directive"));
  assert.ok(kinds.has("applied"));

  // Every item has the required shape.
  for (const it of items) {
    assert.equal(typeof it.when, "string");
    assert.equal(typeof it.kind, "string");
    assert.equal(typeof it.title, "string");
    assert.ok(it.title.length > 0);
  }

  // Newest-first: each `when` is >= the next one (descending string compare on
  // ISO-ish stamps; unstamped sorts last).
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].when || "";
    const b = items[i].when || "";
    if (a && b) assert.ok(a >= b, `not newest-first at ${i}: ${a} < ${b}`);
  }

  assertNoScores(items);
});

test("day-to-day chatter (observation kind) is NOT surfaced — only load-bearing understanding", () => {
  repo.addMemory("Ate oatmeal this morning", "observation", "chat-distill");
  repo.addMemory("Prefers training in the morning", "preference", "user");
  const { items } = repo.learnedTimeline();
  const details = items.map((i) => (i.detail || "").toLowerCase());
  assert.ok(details.some((d) => d.includes("morning")), "the preference should surface");
  assert.ok(!details.some((d) => d.includes("oatmeal")), "an observation should not surface");
});

test("respects the limit (bounded)", () => {
  // GENUINELY distinct decisions — addMemory folds near-duplicates (Jaccard overlap
  // ≥ threshold), so templated "decision number N" sentences would collapse to one
  // row. These share almost no tokens, so each is its own memory and the limit bites.
  const decisions = [
    "Train fasted on weekday mornings",
    "Run the city half-marathon in October",
    "Cut alcohol down to special occasions only",
    "Replace back squats with the hack squat for my knee",
    "Bike to work on Tuesdays and Thursdays",
    "Take creatine every day, year round",
    "Move the long run to Sunday afternoons",
    "Deload during the first week of each month",
    "Add zone-two cardio for heart health",
    "Hire a physio before adding overhead pressing",
    "Keep protein near one gram per pound of bodyweight",
    "Drop the evening espresso to sleep better",
    "Eat oily fish at least twice a week",
    "Schedule a full rest week after the race",
    "Use a standing desk through the afternoon",
  ];
  for (const d of decisions) repo.addMemory(d, "decision", "user");
  const { items } = repo.learnedTimeline({ limit: 5 });
  assert.equal(items.length, 5);
  assertNoScores(items);
});

test("dedupes the same understanding surfaced twice", () => {
  repo.addMemory("No dairy — lactose intolerant", "constraint", "user");
  // An exact repeat folds in addMemory (so DB-side it's one row) — but even if two
  // sources produced the same detail+kind, the timeline must collapse them.
  repo.addMemory("No dairy — lactose intolerant", "constraint", "chat-distill");
  const { items } = repo.learnedTimeline();
  const dairy = items.filter((i) => (i.detail || "").toLowerCase().includes("no dairy"));
  assert.equal(dairy.length, 1, "the same understanding should appear once");
});

test("empty / fresh DB returns an empty (not thrown) timeline", () => {
  const { items } = repo.learnedTimeline();
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});
