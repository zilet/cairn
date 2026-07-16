import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo, tsDaysAgo } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";

// Read/seed everything in a single UTC basis so date-only window comparisons are
// deterministic regardless of the machine's local zone (CURRENT_TIMESTAMP is UTC).
const ASOF = new Date().toISOString().slice(0, 10);

function decision(key, overrides = {}) {
  return {
    effective_date: null,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: `Bounded change ${key}`,
    rationale: "Learn from the measured response.",
    source: "test",
    source_ref_type: "nutrition_target",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {},
    specialist: null,
    applied_at: tsDaysAgo(2), // comfortably inside the 7-day window
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
    ...overrides,
  };
}

function expectation(overrides = {}) {
  return {
    metric_key: "weight_trend_lb_wk",
    subject_key: null,
    direction: "within_band",
    baseline: { value: -1.2 },
    target: { min: -1, max: -0.2 },
    window_start: isoDaysAgo(3),
    window_end: isoDaysAgo(-6), // still maturing (future) → shows under watching[]
    minimum_data: { weigh_ins: 6 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "weight_trend",
    evaluator_version: "test-v1",
    ...overrides,
  };
}

test("teamWeekRead composes a full week with grouping, specialist attribution, and dated sections", () => {
  // did[] — an attributed nutrition change and a bare training change, applied this week.
  recordDecision(
    decision("n1", {
      specialist: { opinions: [{ domain: "nutrition", recommendation: "Raise the target to 2225 kcal." }] },
    }),
    [expectation()] // a still-maturing expectation → watching[]
  );
  recordDecision(
    decision("t1", { kind: "training_target", domain: "training", summary: "Add a second pull day." }),
    []
  );

  // flagged[] — a fresh directive awaiting the athlete + a held-for-review decision.
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Anchor meals around fibre and oily fish while ApoB is elevated.",
    status: "active",
  });
  recordDecision(
    decision("r1", { status: "review", summary: "Consider a small deload next week.", applied_at: null }),
    []
  );

  // landed[] — a matured expectation that closed with an aligned verdict this week.
  const landed = recordDecision(
    decision("n0", { summary: "Earlier bounded change." }),
    // matured (window fully in the past) → eligible for a closed verdict this week.
    [expectation({ window_start: isoDaysAgo(24), window_end: isoDaysAgo(10) })]
  );
  insertBrainEvaluation({
    expectation_id: landed.expectations[0].id,
    verdict: "aligned",
    actual: { value: -0.5, weigh_ins: 8 },
    evidence_keys: ["bodyweight_log:n=8"],
    confounders: [],
    explanation: "The trend landed inside the expected band.",
    evaluator_version: "test-v1",
  });

  // insights[] — one connection surfaced this week.
  repo.addInsight({ kind: "connection", text: "Sleep dipped the weeks mileage ramped.", status: "seen" });

  const read = repo.teamWeekRead({ asOf: ASOF });

  // Grouping + attribution
  const nutrition = read.did.find((g) => g.domain === "nutrition");
  const training = read.did.find((g) => g.domain === "training");
  assert.ok(nutrition, "nutrition group present");
  assert.ok(training, "training group present");
  assert.equal(read.did[0].domain, "nutrition", "nutrition is ordered before training");
  const attributed = nutrition.changes.find((c) => c.text.includes("Bounded change n1"));
  assert.ok(attributed);
  assert.equal(attributed.specialist, "Nutrition lead: Raise the target to 2225 kcal.");
  assert.equal(attributed.when, isoDaysAgo(2));
  const bare = training.changes[0];
  assert.equal(bare.specialist, null, "a change with no stored specialist has no voice");

  // flagged[] — the directive and the held-for-review decision both surface.
  assert.ok(read.flagged.some((f) => f.kind === "directive" && /ApoB/.test(f.text)));
  assert.ok(read.flagged.some((f) => f.kind === "review" && /deload/.test(f.text)));

  // watching[] — the still-maturing expectation, with its through-date.
  assert.ok(read.watching.length >= 1);
  const watch = read.watching.find((w) => w.source === "expectation");
  assert.ok(watch);
  assert.equal(watch.through, isoDaysAgo(-6));
  assert.match(watch.text, /weight trend/);

  // landed[] — the closed evaluation, verdict in words.
  assert.ok(read.landed.some((l) => l.verdict === "aligned" && /landed as expected/.test(l.text)));

  // insights[] — this week's connection, not a backlog drain.
  assert.ok(read.insights.some((i) => !i.backlog && /Sleep dipped/.test(i.text)));

  // lead — a short, factual summary sentence (words, no scores).
  assert.match(read.lead, /^This week your team made/);
  assert.doesNotMatch(JSON.stringify(read), /impact_score|internal_score/i);
});

test("an empty week yields a genuinely short read, never filler", () => {
  const read = repo.teamWeekRead({ asOf: ASOF });
  assert.equal(read.lead, "");
  assert.deepEqual(read.did, []);
  assert.deepEqual(read.flagged, []);
  assert.deepEqual(read.watching, []);
  assert.deepEqual(read.landed, []);
  assert.deepEqual(read.insights, []);
});

test("the backlog drain is bounded to one pair per LOCAL day and never re-drains the same items", () => {
  const NEXT = isoDaysAgo(-1); // the next local day
  // Three still-unseen connections from BEFORE this week (the rotting backlog).
  const ins = db.prepare(`INSERT INTO insights (kind, text, status, created_at) VALUES ('connection', ?, 'new', ?)`);
  ins.run("Backlog A", tsDaysAgo(30));
  ins.run("Backlog B", tsDaysAgo(29));
  ins.run("Backlog C", tsDaysAgo(28));

  // Day 1: the oldest pair drains.
  const first = repo.teamWeekRead({ asOf: ASOF, drainBacklog: true });
  assert.deepEqual(
    first.insights.filter((i) => i.backlog).map((i) => i.text).sort(),
    ["Backlog A", "Backlog B"],
    "the oldest two are surfaced first"
  );

  // Same local day, a second render drains NOTHING more — even though C is still unseen.
  const second = repo.teamWeekRead({ asOf: ASOF, drainBacklog: true });
  assert.equal(second.insights.filter((i) => i.backlog).length, 0, "at most one drain per local day");
  assert.equal(
    db.prepare(`SELECT status FROM insights WHERE text = 'Backlog C'`).get().status,
    "new",
    "C stays unseen until the next local day"
  );

  // The NEXT local day drains the next pair (only C remains unseen).
  const nextDay = repo.teamWeekRead({ asOf: NEXT, drainBacklog: true });
  assert.deepEqual(
    nextDay.insights.filter((i) => i.backlog).map((i) => i.text),
    ["Backlog C"],
    "the next local day drains the next pair"
  );
  // And a second render that day drains nothing more.
  assert.equal(
    repo.teamWeekRead({ asOf: NEXT, drainBacklog: true }).insights.filter((i) => i.backlog).length,
    0,
    "the next day's drain is also bounded to one pass"
  );
});

test("a read-only pass (drainBacklog:false) mutates nothing and never spends the day's drain", () => {
  db.prepare(`INSERT INTO insights (kind, text, status, created_at) VALUES ('connection', ?, 'new', ?)`).run(
    "Untouched backlog",
    tsDaysAgo(40)
  );
  const readOnly = repo.teamWeekRead({ asOf: ASOF, drainBacklog: false });
  assert.equal(readOnly.insights.filter((i) => i.backlog).length, 0, "no backlog surfaced when the drain is off");
  assert.equal(
    db.prepare(`SELECT status FROM insights WHERE text = 'Untouched backlog'`).get().status,
    "new",
    "the read-only pass left the insight unseen"
  );
  // The read-only pass must not have stamped the day: a later human render still drains it.
  const drained = repo.teamWeekRead({ asOf: ASOF, drainBacklog: true }).insights.filter((i) => i.backlog);
  assert.deepEqual(drained.map((i) => i.text), ["Untouched backlog"], "a drainable pass still drains after a read-only one");
});
