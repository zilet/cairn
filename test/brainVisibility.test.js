// Brain-trust visibility (F1 + F2): the two pure reads that make an already-built
// intelligence layer DISCOVERABLE without changing what it does.
//   F1 — evidenceSummary(): per-marker counts of cached evidence so a UI can show
//        "see the evidence (N)" without an N-fetch fan-out (+ the research flag).
//   F2 — getOutcomeLearnings(): the durable suggestion→actual learnings surfaced as
//        gentle "What Cairn has noticed" observations (live rows only, newest-first).
// Both are deterministic, offline, no agent/network — exactly what npm test covers.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("evidence_cache", "memory", "settings");
});

// ---------- F1: evidence summary (discoverability counts) ----------

test("evidenceSummary is empty before any research, with research flag default-off", () => {
  const s = repo.evidenceSummary();
  assert.equal(s.total, 0);
  assert.deepEqual(s.by_marker, []);
  assert.equal(s.research_enabled, false); // off by default — the deterministic floor
});

test("evidenceSummary counts cached rows per marker (case-insensitive), newest-first by count", () => {
  repo.addEvidence({ marker: "ApoB", claim: "Lower ApoB lowers ASCVD risk", source_title: "AHA/ACC", source_url: "https://www.ahajournals.org/x" });
  repo.addEvidence({ marker: "apob", claim: "ApoB is a causal driver", source_title: "EAS", source_url: "https://www.escardio.org/y" });
  repo.addEvidence({ marker: "Ferritin", claim: "Replete iron stores", source_title: "ASH", source_url: "https://www.hematology.org/z" });
  const s = repo.evidenceSummary();
  assert.equal(s.total, 3);
  // ApoB and apoB fold into one case-insensitive bucket of 2; Ferritin has 1.
  const apob = s.by_marker.find((r) => r.marker.toLowerCase() === "apob");
  const fer = s.by_marker.find((r) => r.marker.toLowerCase() === "ferritin");
  assert.equal(apob.count, 2);
  assert.equal(fer.count, 1);
  // ordered by count desc → the 2-row marker leads.
  assert.equal(s.by_marker[0].count, 2);
});

test("evidenceSummary: a NULL-marker evidence row counts toward total but no marker bucket", () => {
  repo.addEvidence({ claim: "general longevity guidance", source_title: "WHO", source_url: "https://www.who.int/a" });
  const s = repo.evidenceSummary();
  assert.equal(s.total, 1);
  assert.deepEqual(s.by_marker, []); // a sourceless-of-marker row never invents a bucket
});

test("evidenceSummary reflects research_enabled when turned on", () => {
  repo.setSettings({ research_enabled: true });
  assert.equal(repo.evidenceSummary().research_enabled, true);
});

// ---------- F2: outcome learnings ("What Cairn has noticed") ----------

test("getOutcomeLearnings is empty until reconciliation writes a learning", () => {
  const r = repo.getOutcomeLearnings();
  assert.deepEqual(r.learnings, []);
});

test("getOutcomeLearnings surfaces 'learning' memory rows, newest-first, with id + stamp", () => {
  repo.addMemory("Tolerates higher training frequency than the 3-hard-days read assumes.", "learning", "outcome-learning");
  repo.addMemory("Intake estimate runs low when bodyweight drifts up after a deficit check-in.", "learning", "outcome-learning");
  const { learnings } = repo.getOutcomeLearnings();
  assert.equal(learnings.length, 2);
  for (const l of learnings) {
    assert.ok(Number.isFinite(l.id));
    assert.ok(typeof l.content === "string" && l.content.length > 0);
    assert.ok(l.noticed_at === null || typeof l.noticed_at === "string");
  }
});

test("getOutcomeLearnings ignores non-learning memory and superseded learnings", () => {
  repo.addMemory("Prefers fasted morning training.", "preference", "user");      // wrong kind — excluded
  const live = repo.addMemory("Recovers fast — fine training back-to-back days.", "learning", "outcome-learning");
  const old = repo.addMemory("Historically wanted two full rest days between leg sessions.", "learning", "outcome-learning");
  // Supersede WITH a (distinct) replacement so the old row genuinely points at a
  // successor — supersedeMemory with no replacement is just a touch, not a hide.
  repo.supersedeMemory(old.id, { content: "Now tolerates one rest day between heavy leg sessions, no flat performance.", kind: "learning" });
  const { learnings } = repo.getOutcomeLearnings();
  const ids = learnings.map((l) => l.id);
  assert.ok(ids.includes(live.id), "the live learning is surfaced");
  assert.ok(!ids.includes(old.id), "a superseded learning is hidden");
  assert.equal(learnings.every((l) => l.content !== "Prefers fasted morning training."), true);
});

test("getOutcomeLearnings clamps the limit to a bounded window", () => {
  // Genuinely distinct learnings (low token overlap) so addMemory's Jaccard dedup
  // doesn't fold them — each is a separate row, exercising the clamp honestly.
  const topics = [
    "Friday evening sessions skip more often than any other slot.",
    "Sleep dips below six hours predict a flat squat the next morning.",
    "Higher protein on travel days keeps the weight trend steadier.",
    "Long Sunday rides leave Monday legs heavy for upper work.",
    "Skipping breakfast before noon lifts pushes total intake low.",
    "Back-to-back HIIT raises resting heart rate two days later.",
    "Deload weeks land best after three consecutive hard training days.",
    "Caffeine after 3pm shows up as worse deep-sleep minutes that night.",
  ];
  for (const t of topics) repo.addMemory(t, "learning", "outcome-learning");
  assert.equal(repo.getOutcomeLearnings(5).learnings.length, 5, "respects a small limit");
  assert.equal(repo.getOutcomeLearnings(100).learnings.length, topics.length, "returns all when room");
  assert.ok(repo.getOutcomeLearnings(9999).learnings.length <= 50); // hard cap, never unbounded
});

// reconcileSuggestions → getOutcomeLearnings is the real path: a past 'rest' read
// the athlete trained through produces a durable, surfaced learning.
test("reconcileSuggestions writes a learning that getOutcomeLearnings then surfaces", () => {
  resetTables("suggestions", "sessions", "logged_sets", "exercises");
  const yesterday = localDaysAgo(1);
  repo.recordSuggestion("day_read", yesterday, { kind: "rest" });
  // The athlete trained that day anyway (a logged set on the date) — logSetByName
  // resolves/creates the session for that date itself.
  repo.logSetByName({ exercise: "ZTest Bench", weight: 135, reps: 5, date: yesterday });
  const out = repo.reconcileSuggestions();
  assert.ok(out.learnings >= 1, "a rest-read-then-trained day yields a learning");
  const { learnings } = repo.getOutcomeLearnings();
  assert.ok(learnings.some((l) => /higher training frequency|rest/i.test(l.content)), "the learning is now visible");
});
