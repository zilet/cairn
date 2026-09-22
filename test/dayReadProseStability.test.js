// ONE WORDING PER MORNING, PER IDENTITY.
//
// On 2026-09-02 one set of facts produced THREE different Brief paragraphs: the 04:00
// precompute wrote one before the night had synced, the morning sync's debounced
// refresh wrote a second, and the 07:39 open re-derived "material truth changed" from a
// bare fingerprint move, overwrote the agent's sentence with floor prose and armed a
// third run. The ledger kept the first wording, the cache kept the last, and the
// athlete read a screen that reworded itself three times about an unchanged day.
//
// The rule these pin: the read's IDENTITY is (date, kind, rule_code, focus). A recompute
// landing on the same identity keeps the existing headline/why and refreshes only the
// evidence, the fingerprint and the stamp — no agent is asked. The agent is asked again
// only when the identity changes, on the athlete's explicit "new read" (which deletes
// the row first), or when the cached row is floor prose (the self-heal path).
//
// Every case here runs with ALL agents disabled, which is also the assertion: a row that
// comes back `source:"agent"` with its wording intact cannot have been written by an
// agent in this process, and it proves the deterministic floor did not replace it either.
import assert from "node:assert/strict";
import test from "node:test";
import { computeDayRead, precomputeDayReadFloor, sleepRowExistsFor } from "../dist/dayread.js";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh, flushDayReadRefresh } from "../dist/dayread-refresh.js";
import { setAgentRunSink } from "../dist/agents.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const TABLES = [
  "day_reads",
  "suggestions",
  "plan_days",
  "plan_items",
  "sessions",
  "logged_sets",
  "activities",
  "daily_metrics",
  "garmin_daily_metrics",
  "brain_decisions",
  "brain_expectations",
];

// Offline: computeDayRead falls to its deterministic branch instead of spawning a CLI.
// So "the wording survived AND the row is still source:agent" is a spawn counter that
// cannot lie — nothing in this process could have produced agent prose.
function offlineAgents() {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"] });
}

function seedPlan() {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
}

// The morning's agent row, as the precompute/refresh would have left it: the agent's
// sentence, the baseline's evidence, and the prose identity of the call it answered.
function seedMorningAgentRead(date, why, extra = {}) {
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    headline: "Today's the day.",
    why,
    source: "agent",
    agent: "claude",
    prose_identity: repo.dayReadProseIdentity(date, baseline),
    ...extra,
  });
  return baseline;
}

const MORNING = "Legs are fresh and the week has room — take the session.";

test("a same-identity recompute keeps the wording and asks no agent", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  const baseline = seedMorningAgentRead(date, MORNING);

  const again = await computeDayRead({ date });

  assert.equal(again.why, MORNING, "the same call about the same day reads the same");
  assert.equal(again.headline, "Today's the day.");
  assert.equal(again.source, "agent", "no agent ran, and the floor did not overwrite the sentence");
  assert.equal(again.kind, baseline.kind);
  // Only the evidence and the stamps move.
  assert.equal(again.input_fingerprint, baseline.input_fingerprint);
  assert.deepEqual(again.signals, baseline.signals);
  assert.equal(typeof again.computed_at, "string");
  assert.equal(repo.getCachedDayRead(date).why, MORNING, "and the persisted row keeps it too");
});

test("a changed call releases the pin — new identity, new prose", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  // A cached agent row written for a DIFFERENT call: same date, but the identity says
  // it answered a rest morning. Today's baseline is a training day.
  const baseline = repo.dayRead(date);
  assert.notEqual(baseline.kind, "rest", "fixture assumption: the seeded day is not a rest day");
  repo.saveDayRead(date, {
    ...baseline,
    why: MORNING,
    source: "agent",
    agent: "claude",
    prose_identity: repo.dayReadProseIdentity(date, { ...baseline, kind: "rest" }),
  });

  const fresh = await computeDayRead({ date });

  assert.notEqual(fresh.why, MORNING, "a different call gets a fresh sentence");
  assert.equal(fresh.source, "deterministic", "with agents offline that sentence is the floor's");
  assert.equal(fresh.kind, baseline.kind);
});

test("floor prose is never pinned — the self-heal path stays open", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    why: "A floor sentence from a transient outage.",
    source: "deterministic",
    prose_identity: repo.dayReadProseIdentity(date, baseline),
  });

  const healed = await computeDayRead({ date });

  assert.notEqual(healed.why, "A floor sentence from a transient outage.");
  assert.equal(healed.source, "deterministic");
});

test("an athlete's explicit new read is never answered with yesterday's sentence", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  seedMorningAgentRead(date, MORNING);

  // `reset` deletes the row before recomputing (readToday), and a steered read is a
  // different question entirely — neither may be served the pinned wording.
  const steered = await computeDayRead({ date, override: "rough night" });
  assert.notEqual(steered.why, MORNING);

  // The explicit new read DISCARDS the row; an ordinary invalidation only marks it.
  seedMorningAgentRead(date, MORNING);
  repo.discardDayRead(date);
  const asked = await computeDayRead({ date });
  assert.notEqual(asked.why, MORNING, "a discarded day starts from the floor again");
});

test("readToday: a fingerprint drift serves the cached wording and writes no floor prose", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  seedMorningAgentRead(date, MORNING);
  // Move the inputs without changing the call: a night lands after the read was written.
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min, resting_hr) VALUES ('apple', ?, 430, 52)`).run(date);

  const opened = await readToday({ date });
  const reopened = await readToday({ date });

  assert.equal(opened.why, MORNING, "the sentence the athlete is already reading survives the sync");
  assert.equal(opened.source, "agent");
  assert.equal(repo.getCachedDayRead(date).source, "agent", "no deterministic row was written over it");
  assert.equal(reopened.why, MORNING);
  assert.equal(reopened.cached, true, "and the re-stamp settles it — the next open is a plain cache hit");
  assert.equal(reopened.input_fingerprint, opened.input_fingerprint);
});

test("the ledger says what the athlete read", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();

  // A morning that recomputes twice on the same CLAIM (same kind) with different prose —
  // the shape the 04:00 precompute and the post-sync refresh produced live.
  seedMorningAgentRead(date, "The first sentence of the day, written before the night synced.");
  seedMorningAgentRead(date, MORNING);

  const rows = db
    .prepare(`SELECT id, summary, rationale FROM brain_decisions WHERE kind='day_read' AND source_ref_key=?`)
    .all(date);
  assert.equal(rows.length, 1, "the same claim is one immutable decision, not one row per wording");
  const row = repo.getCachedDayRead(date);
  assert.equal(rows[0].rationale, row.why, "provenance shows the sentence that is on screen");
  assert.equal(rows[0].summary, row.headline);
});

// ---------------------------------------------------------------------------
// The 04:00 precompute: no night, no prose.
// ---------------------------------------------------------------------------

test("the precompute warms the deterministic floor when last night has not synced", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();

  assert.equal(sleepRowExistsFor(date), false, "at 04:00 the watch has not synced the night yet");
  precomputeDayReadFloor(date);

  const warmed = repo.getCachedDayRead(date);
  assert.ok(warmed, "the morning open is still instant");
  assert.equal(warmed.source, "deterministic", "and no sentence was written about a night that does not exist");
  assert.equal(typeof warmed.prose_identity, "string", "the floor row still carries the call it answered");

  // Once the night is in, the same check tells the scheduler it may ask the agent.
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 430)`).run(date);
  assert.equal(sleepRowExistsFor(date), true);
});

// ---------- prose stays pinned, PROVENANCE stays current ----------
// The pin holds the sentence steady; it must not hold the read's evidence list steady
// too. `decision.evidence` is the dated "here's what I was looking at" list under the
// read, so re-stamping a fresh computed_at over the morning's evidence produced one row
// whose stamp and whose evidence described two different moments.

// A cached agent row whose decision carries a deliberately STALE evidence list, so the
// refresh is visible: whatever comes back must not be this.
function seedStaleEvidence(date, extra = {}) {
  const baseline = repo.dayRead(date);
  repo.saveDayRead(date, {
    ...baseline,
    ...extra,
    headline: "Today's the day.",
    why: MORNING,
    source: "agent",
    agent: "claude",
    prose_identity: repo.dayReadProseIdentity(date, baseline),
    decision: {
      ...baseline.decision,
      evidence: [{ label: "Yesterday's reading", value: "a stamp from before the sync" }],
      computed_at: "2000-01-01T00:00:00.000Z",
    },
  });
  return baseline;
}

test("the pin re-stamps the decision's evidence, not just its clock", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  const baseline = seedStaleEvidence(date);

  const again = await computeDayRead({ date });

  assert.equal(again.why, MORNING, "the sentence is still the one the athlete read");
  assert.deepEqual(again.decision.evidence, baseline.decision.evidence, "the provenance is today's");
  assert.notEqual(again.decision.computed_at, "2000-01-01T00:00:00.000Z");
});

test("readToday's re-stamp refreshes the provenance the same way", async () => {
  resetTables(...TABLES);
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  // The inputs drifted but the CALL did not — the branch that re-stamps rather than
  // rewriting. Stamping the cached row with a fingerprint the live baseline no longer
  // matches is that state exactly, and it does not depend on which particular input
  // the day-read fingerprint happens to cover.
  seedStaleEvidence(date, { input_fingerprint: "a-fingerprint-from-before-the-sync" });

  const opened = await readToday({ date });

  assert.equal(opened.why, MORNING);
  assert.notDeepEqual(
    opened.decision.evidence,
    [{ label: "Yesterday's reading", value: "a stamp from before the sync" }],
    "a fresh stamp must not sit over the morning's evidence"
  );
  assert.deepEqual(opened.decision.evidence, repo.dayRead(date).decision.evidence);
});

// ---------------------------------------------------------------------------
// An invalidation keeps the wording. It used to DELETE the row, so every meal log
// threw the agent's sentence away and the re-warm asked an agent for a new one — live,
// 12-20 day_read runs a day about a day whose call never moved.
// ---------------------------------------------------------------------------

// One usable agent (the offline stub) and a sink counting every day_read spawn, so
// "no agent was asked" is observed rather than inferred from agents being off.
function countDayReadSpawns() {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok"] });
  const spawns = [];
  setAgentRunSink((run) => {
    if (run.op === "day_read") spawns.push(run);
  });
  return spawns;
}

test("a meal logged under a warm agent read asks no agent and keeps the sentence", async (t) => {
  resetTables(...TABLES, "food_notes");
  const spawns = countDayReadSpawns();
  t.after(() => setAgentRunSink(null));
  const date = localDaysAgo(0);
  let fire = null;
  configureDayReadRefresh({
    today: () => date,
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  seedPlan();
  const baseline = seedMorningAgentRead(date, MORNING);

  repo.addFoodNote("lunch", "", { summary: "Chicken bowl", kcal: 500, protein_g: 45 });

  assert.equal(
    repo.dayRead(date).signals?.fuel?.bucket,
    baseline.signals?.fuel?.bucket,
    "fixture check: this meal does not flip the fuel bucket"
  );
  assert.equal(repo.getCachedDayRead(date), null, "a consumer reading the cache as current truth sees it retired");
  assert.equal(repo.getCachedDayRead(date, { includeStale: true })?.why, MORNING, "but the sentence is kept");

  // The re-warm the invalidation armed, through the REAL recompute path.
  assert.ok(fire, "the invalidation armed a background re-warm");
  fire();
  await flushDayReadRefresh();
  const warmed = repo.getCachedDayRead(date);
  assert.equal(warmed?.why, MORNING, "the re-warm re-stamped the same call's sentence");
  assert.equal(warmed.source, "agent");

  const opened = await readToday({ date });
  assert.equal(opened.why, MORNING, "and the open reads the sentence the athlete already read");
  assert.equal(spawns.length, 0, "no day_read agent was spawned anywhere along the way");
});

test("the pin gives way to a fuel bucket flip, as the open's material-truth check does", async () => {
  resetTables(...TABLES, "food_notes", "profile", "bodyweight_log", "nutrition_targets");
  offlineAgents();
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  seedPlan();
  // A profile complete enough for a protein target to derive, so the fuel bucket exists.
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 180, sex: "male", activity_factor: 1.5, goal_mode: "maintain" });
  const baseline = repo.dayRead(date);
  const identity = repo.dayReadProseIdentity(date, baseline);
  seedMorningAgentRead(date, MORNING, { signals: { ...baseline.signals, fuel: { bucket: "behind" } } });
  // A protein-dense lunch: the live bucket is now 'met' while the call stays the same.
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status) VALUES (?, 'lunch', '', ?, 'done')`
  ).run(date, JSON.stringify({ summary: "chicken & rice", protein_g: 170, kcal: 700 }));
  const live = repo.dayRead(date);
  assert.equal(live.signals.fuel.bucket, "met", "fixture check: the bucket flipped");
  assert.equal(repo.dayReadProseIdentity(date, live), identity, "fixture check: the call did not");

  const again = await computeDayRead({ date });

  assert.notEqual(again.why, MORNING, "a sentence about light protein does not outlive the lunch that fixed it");
});
