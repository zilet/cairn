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

function seedAttention(reason, nextDueDaysAgo) {
  db.prepare(
    `INSERT INTO attention_schedule
       (signal_key, domain, tier, next_due, last_checked, reason, release_condition, source, state_json, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `sig_${Math.random().toString(36).slice(2)}`,
    "body",
    "surveillance",
    isoDaysAgo(nextDueDaysAgo),
    isoDaysAgo(3),
    reason,
    "",
    "health_review",
    "{}",
    tsDaysAgo(1)
  );
}

test("teamWeekRead composes the week: coalesced latest-state changes, attribution, and dated sections", () => {
  // Nutrition — THREE substantive target revisions plus one bare-filler line. They
  // must collapse to ONE line reflecting the FINAL state, with the filler dropped.
  recordDecision(decision("nA", { summary: "Raise the target to 2,100 kcal.", applied_at: tsDaysAgo(5) }), []);
  recordDecision(decision("nB", { summary: "Nudge protein up to 180 g.", applied_at: tsDaysAgo(4) }), [expectation()]);
  recordDecision(
    decision("nC", {
      summary: "Settle the target at 2,225 kcal.",
      applied_at: tsDaysAgo(2),
      specialist: { opinions: [{ domain: "nutrition", recommendation: "Hold 2,225 for two weeks." }] },
    }),
    []
  );
  recordDecision(decision("nFiller", { summary: "Nutrition target updated.", applied_at: tsDaysAgo(3) }), []);

  // Training — an attributed single change, two rotations, and an auto-progression.
  recordDecision(
    decision("t1", {
      kind: "training_target",
      domain: "training",
      summary: "Add a second pull day.",
      applied_at: tsDaysAgo(2),
      specialist: { opinions: [{ domain: "training", recommendation: "Two pull days balances the split." }] },
    }),
    []
  );
  recordDecision(
    decision("rot1", {
      kind: "exercise_rotation",
      domain: "training",
      source: "exercise-swap",
      summary: "Rotate Hammer Curl → Barbell Curl on day 2",
      applied_at: tsDaysAgo(3),
    }),
    []
  );
  recordDecision(
    decision("rot2", {
      kind: "exercise_rotation",
      domain: "training",
      source: "exercise-swap",
      summary: "Rotate DB Bench Press → Incline Bench Press on day 1",
      applied_at: tsDaysAgo(4),
    }),
    []
  );
  recordDecision(
    decision("prog1", {
      kind: "training_target",
      domain: "training",
      source: "auto-progression",
      summary: "Auto-progression for day 1 — 2 lifts",
      applied_at: tsDaysAgo(5),
    }),
    []
  );

  // A held-for-review decision awaiting the athlete (an actionable ask).
  recordDecision(
    decision("r1", {
      domain: "training",
      summary: "Consider a small deload next week — recover the sore knee.",
      status: "review",
      applied_at: null,
    }),
    []
  );

  // A matured expectation that closed CONCLUSIVELY (aligned) this week. The decision
  // itself is applied OUTSIDE the 7-day did-window, so it only feeds landed[].
  const landed = recordDecision(decision("n0", { summary: "Earlier bounded change.", applied_at: tsDaysAgo(20) }), [
    expectation({ window_start: isoDaysAgo(24), window_end: isoDaysAgo(10) }),
  ]);
  insertBrainEvaluation({
    expectation_id: landed.expectations[0].id,
    verdict: "aligned",
    actual: { value: -0.5, weigh_ins: 8 },
    evidence_keys: ["bodyweight_log:n=8"],
    confounders: [],
    explanation: "The trend landed inside the expected band.",
    evaluator_version: "test-v1",
  });

  repo.addInsight({ kind: "connection", text: "Sleep dipped the weeks mileage ramped.", status: "seen" });

  const read = repo.teamWeekRead({ asOf: ASOF });

  // Nutrition coalesced to ONE latest-state line + revision count, filler dropped.
  const nutrition = read.did.find((g) => g.domain === "nutrition");
  assert.ok(nutrition, "nutrition group present");
  assert.equal(nutrition.changes.length, 1, "three revisions + filler collapse to one line");
  assert.equal(nutrition.changes[0].text, "Settle the target at 2,225 kcal. (settled after 3 revisions)");
  assert.equal(nutrition.changes[0].specialist, "Nutrition lead: Hold 2,225 for two weeks.");
  assert.equal(read.did[0].domain, "nutrition", "nutrition is ordered before training");

  // Training coalesced: one single + one rotation line + one progression line.
  const training = read.did.find((g) => g.domain === "training");
  assert.ok(training, "training group present");
  assert.equal(training.changes.length, 3, "single + coalesced rotation + coalesced progression");
  const single = training.changes.find((c) => c.text === "Add a second pull day.");
  assert.ok(single, "the attributed single change survives");
  assert.match(String(single.specialist), /Two pull days balances the split\./);
  assert.ok(
    training.changes.some(
      (c) => c.text === "Rotated: Hammer Curl → Barbell Curl · DB Bench Press → Incline Bench Press"
    ),
    "rotations coalesce into one compact line"
  );
  assert.ok(
    training.changes.some((c) => c.text === "Auto-progressed 2 lifts on day 1"),
    "auto-progressions coalesce into one line"
  );

  // No filler line leaked anywhere.
  assert.ok(
    !read.did.some((g) => g.changes.some((c) => /target updated\.?$/i.test(c.text))),
    "the bare filler line never surfaces"
  );

  // flagged[] — the held-for-review actionable ask surfaces.
  assert.ok(read.flagged.some((f) => f.kind === "review" && /deload/.test(f.text)));

  // watching[] — the still-maturing expectation, capitalized, with its through-date.
  const watch = read.watching.find((w) => w.source === "expectation");
  assert.ok(watch);
  assert.equal(watch.through, isoDaysAgo(-6));
  assert.match(watch.text, /^How your weight trend/);

  // landed[] — the conclusive verdict, in words.
  assert.ok(read.landed.some((l) => l.verdict === "aligned" && /landed as expected/.test(l.text)));

  // insights[] — this week's connection.
  assert.ok(read.insights.some((i) => !i.backlog && /Sleep dipped/.test(i.text)));

  // lead — a short, factual summary sentence (words, no scores).
  assert.match(read.lead, /^This week your team made/);
  assert.doesNotMatch(JSON.stringify(read), /impact_score|internal_score/i);
});

test('"Waiting for you" dedupes near-twin asks and drops informational explainers', () => {
  // Two near-twin lipid retests from the two sources (a directive + a review
  // decision) — they differ only by a parenthetical and a trailing clause.
  repo.addDirective({
    source: "markers",
    domain: "health",
    marker: "ApoB",
    directive: "Retest a full lipid panel (with ApoB) in ~12 weeks to confirm the response.",
    status: "active",
  });
  recordDecision(
    decision("rev-lipid", {
      domain: "health",
      summary: "Retest a full lipid panel in ~12 weeks.",
      status: "review",
      applied_at: null,
    }),
    []
  );
  // A purely informational Lp(a) explainer — NOT an actionable ask.
  repo.addDirective({
    source: "markers",
    domain: "health",
    marker: "Lp(a)",
    directive: "Lp(a) is largely genetic — measure it once to know your baseline; it's not a diet you can change.",
    status: "active",
  });
  // A genuine actionable directive that OPENS by naming the marker ("Folate is low
  // — …"): it must be KEPT. (A leading-statement heuristic used to wrongly drop it;
  // only the Lp(a)-style keyword phrasing marks a true explainer.)
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Folate",
    directive:
      "Folate is low — load up on leafy greens, legumes and other folate-rich foods (or a folate/B-complex), and check B12 at the same time so you don't mask it.",
    status: "active",
  });

  const read = repo.teamWeekRead({ asOf: ASOF });
  const lipid = read.flagged.filter((f) => /lipid panel/i.test(f.text));
  assert.equal(lipid.length, 1, "the two near-twin retests collapse to one");
  assert.match(lipid[0].text, /with ApoB/, "the more specific ask is kept");
  assert.ok(!read.flagged.some((f) => /Lp\(a\)/i.test(f.text)), "the informational Lp(a) explainer is excluded");
  assert.ok(
    read.flagged.some((f) => /^Folate is low/.test(f.text)),
    "a marker-named imperative directive is kept (not dropped as an explainer)"
  );
});

test("a nutrition-target retune and a meal-plan regeneration stay two distinct lines (no cross-count)", () => {
  recordDecision(
    decision("nt", {
      kind: "nutrition_target",
      domain: "nutrition",
      source_ref_type: "nutrition_target",
      summary: "Retune the target to 2,150 kcal.",
      applied_at: tsDaysAgo(2),
    }),
    []
  );
  recordDecision(
    decision("mp", {
      kind: "meal_plan",
      domain: "nutrition",
      source_ref_type: "meal_plan",
      summary: "Regenerate this week's meal plan around the new target.",
      applied_at: tsDaysAgo(3),
    }),
    []
  );

  const read = repo.teamWeekRead({ asOf: ASOF });
  const nutrition = read.did.find((g) => g.domain === "nutrition");
  assert.ok(nutrition, "nutrition group present");
  assert.equal(nutrition.changes.length, 2, "the target and the meal plan are separate lines");
  assert.ok(nutrition.changes.some((c) => c.text === "Retune the target to 2,150 kcal."));
  assert.ok(nutrition.changes.some((c) => c.text === "Regenerate this week's meal plan around the new target."));
  assert.ok(
    !nutrition.changes.some((c) => /settled after/.test(c.text)),
    "two different things never cross-count into one revision tally"
  );
});

test('"What we\'re watching" humanizes the raw follow-up reason', () => {
  seedAttention("Health review follow-up: Repeat tape measurements with the same method (in 2-3 weeks).", -12);

  const read = repo.teamWeekRead({ asOf: ASOF });
  const watch = read.watching.find((w) => w.source === "attention");
  assert.ok(watch, "the attention entry surfaces");
  assert.equal(watch.text, "Repeat tape measurements with the same method");
  assert.doesNotMatch(watch.text, /follow-up|\(|\)/, "the machine prefix and parenthetical are stripped");
  assert.equal(watch.through, isoDaysAgo(-12));
});

test('"How it landed" keeps only conclusive verdicts and omits the section otherwise', () => {
  // An inconclusive verdict — filler that must NOT surface.
  const dInc = recordDecision(decision("inc"), [
    expectation({ window_start: isoDaysAgo(20), window_end: isoDaysAgo(9) }),
  ]);
  insertBrainEvaluation({
    expectation_id: dInc.expectations[0].id,
    verdict: "inconclusive",
    actual: { weigh_ins: 0 },
    evidence_keys: [],
    confounders: [],
    explanation: "Not enough evidence yet.",
    evaluator_version: "test-v1",
  });

  const onlyInconclusive = repo.teamWeekRead({ asOf: ASOF });
  assert.deepEqual(onlyInconclusive.landed, [], "an inconclusive-only week yields no landed section");

  // Add a conclusive not_aligned verdict — now the section is present, conclusive-only.
  const dNot = recordDecision(decision("na"), [
    expectation({ window_start: isoDaysAgo(22), window_end: isoDaysAgo(8) }),
  ]);
  insertBrainEvaluation({
    expectation_id: dNot.expectations[0].id,
    verdict: "not_aligned",
    actual: { value: 1 },
    evidence_keys: ["marker:apob"],
    confounders: [],
    explanation: "Moved the wrong way.",
    evaluator_version: "test-v1",
  });

  const withConclusive = repo.teamWeekRead({ asOf: ASOF });
  assert.equal(withConclusive.landed.length, 1, "only the conclusive verdict surfaces");
  assert.equal(withConclusive.landed[0].verdict, "not_aligned");
  assert.match(withConclusive.landed[0].text, /didn't land the way we expected/);
});

test("long change summaries clip on a word boundary with an ellipsis — never mid-word", () => {
  const long = `Shift the plan to a longer accumulation block with ${"cadence ".repeat(20)}work`;
  recordDecision(
    decision("long1", {
      kind: "training_target",
      domain: "training",
      summary: long,
      applied_at: tsDaysAgo(1),
    }),
    []
  );

  const read = repo.teamWeekRead({ asOf: ASOF });
  const text = read.did.find((g) => g.domain === "training").changes[0].text;
  assert.ok(text.length <= 152, `clipped to the budget (was ${text.length})`);
  assert.ok(text.endsWith("…"), "truncation is marked with an ellipsis");
  const base = text.slice(0, -1).trim();
  const collapsed = long.replace(/\s+/g, " ").trim();
  assert.ok(collapsed.startsWith(base), "the clip is a prefix of the original");
  assert.ok(
    collapsed.length === base.length || collapsed[base.length] === " ",
    "the clip ends on a whole word — the next original char is a space"
  );
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
