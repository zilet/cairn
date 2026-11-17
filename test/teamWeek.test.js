import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo, tsDaysAgo } from "./_seed.js";
import {
  decisionExplanation,
  getBrainDecision,
  listReadableBrainDecisions,
  patchBrainDecision,
  recordDecision,
} from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { TEAM_SEATS, storedSeat, teamSeatForDecision } from "../dist/repo/team-seats.js";
import { teamWeekLink } from "../dist/repo/team-week.js";

// Read/seed everything in a single UTC basis so date-only window comparisons are
// deterministic regardless of the machine's local zone (CURRENT_TIMESTAMP is UTC).
// Local frame to match isoDaysAgo — a UTC slice here collides with
// isoDaysAgo(-1) inside the midnight-UTC window, folding "tomorrow" into today.
const ASOF = isoDaysAgo(0);

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
  assert.equal(nutrition.changes[0].text, "Settle the target at 2,225 kcal. It settled after three passes.");
  assert.equal(nutrition.changes[0].specialist, "Fuel: Hold 2,225 for two weeks.");
  assert.equal(nutrition.changes[0].seat, "fuel");
  assert.equal(read.did[0].domain, "nutrition", "nutrition is ordered before training");

  // Training coalesced: one single + one rotation line + one progression line.
  const training = read.did.find((g) => g.domain === "training");
  assert.ok(training, "training group present");
  assert.equal(training.changes.length, 3, "single + coalesced rotation + coalesced progression");
  const single = training.changes.find((c) => c.text === "Add a second pull day.");
  assert.ok(single, "the attributed single change survives");
  assert.match(String(single.specialist), /^Strength: Two pull days balances the split\./);
  assert.ok(
    training.changes.some((c) =>
      [
        "Swapped Hammer Curl for Barbell Curl and DB Bench Press for Incline Bench Press.",
        "Brought in Barbell Curl for Hammer Curl and Incline Bench Press for DB Bench Press.",
      ].includes(c.text)
    ),
    "rotations coalesce into one spoken line"
  );
  // An older progression row with no per-lift payload is counted from its label —
  // and never read back as a plan-day number.
  const progression = training.changes.find((c) => /two lifts/.test(c.text));
  assert.ok(progression, "auto-progressions coalesce into one line");
  assert.doesNotMatch(progression.text, /\bday \d|auto-progress/i);
  assert.equal(progression.specialist, "Strength", "an unattributed row still names its seat");

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
  assert.match(watch.text, /[Yy]our weight coming down 0\.2–1 lb a week/, "the band the expectation holds, in words");

  // landed[] — the conclusive verdict, in words, with its subject.
  const aligned = read.landed.find((l) => l.verdict === "aligned");
  assert.ok(aligned);
  assert.match(aligned.text, /^The calorie target change landed/);
  assert.match(aligned.text, /your weight coming down 0\.2–1 lb a week/);
  assert.equal(aligned.seat, "fuel");

  // insights[] — this week's connection.
  assert.ok(read.insights.some((i) => !i.backlog && /Sleep dipped/.test(i.text)));

  // lead — a sentence, not a wall of counts; it names who led and the one thing waiting.
  assert.doesNotMatch(read.lead, /\d+ (changes|things|responses)/);
  assert.match(read.lead, /^(\w+ led the week\.|Most of this week's work sat with \w+\.)/);
  assert.match(read.lead, /(One change is waiting on your yes|One call is waiting on you)\./);
  assert.equal(read.changes_count, 4, "one nutrition line + three training lines");
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

test('"Waiting for you" — the marker-key pre-pass never collapses two distinct-domain, distinct-wording asks for one marker', () => {
  // A cross-domain pair for the SAME canonical marker with NO wording overlap —
  // a real nutrition lever vs an unrelated watch retest reminder — must NOT
  // collapse. MARKER_MAPPINGS routinely emits exactly this shape (one directive
  // per domain per marker), and silently folding the nutrition action behind the
  // retest reminder would drop real cross-domain guidance from the digest. (Two
  // directives sharing BOTH the same canonical marker AND the same domain never
  // reach this far as separate rows in the first place — listActiveDirectives'
  // own read-time dedup, keyed on (marker, domain), already collapses those
  // upstream; the same-domain branch below exists for defense/correctness, not
  // because this specific path can exercise it.)
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Lower saturated fat and add soluble fiber to bring ApoB toward optimal.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "Apolipoprotein B",
    directive: "Retest a full lipid panel (with ApoB) in ~12 weeks to confirm the response.",
    status: "active",
  });

  // (b) STRING: a marker-less review decision and a directive ask the same thing,
  // but the directive inserts "fasting" in the MIDDLE of the phrase — a
  // whole-string includes() test misses this (the shorter phrase is not a
  // contiguous substring of the longer one); a token-SUBSET test catches it
  // because every word of the shorter ask is present in the longer one. Domain
  // "training" (a real DIRECTIVE_DOMAINS value, not "watch") — addDirective
  // clamps any unrecognized domain to "watch", which would otherwise pull this
  // into the SAME watch-panel lipids cluster as the ApoB pair above and hide the
  // very collapse this sub-test is trying to isolate.
  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "Triglycerides",
    directive: "Recheck your fasting lipid work in a couple months.",
    status: "active",
  });
  recordDecision(
    decision("rev-lipid-mid", {
      domain: "health",
      summary: "Recheck your lipid work in a couple months.",
      status: "review",
      applied_at: null,
    }),
    []
  );

  // A genuinely different ask — a different marker AND a different verb — must
  // survive untouched (no over-collapsing).
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Vitamin D",
    directive: "Add a vitamin D3 supplement and retest in 8-12 weeks.",
    status: "active",
  });

  const read = repo.teamWeekRead({ asOf: ASOF });

  const apobAsks = read.flagged.filter((f) => /lipid panel|soluble fiber/i.test(f.text));
  assert.equal(apobAsks.length, 2, "the cross-domain, differently-worded pair for one marker both survive");
  assert.ok(
    apobAsks.some((f) => /^Retest a full lipid panel \(with ApoB\)/.test(f.text)),
    "the watch retest reminder survives as its own ask"
  );
  assert.ok(
    apobAsks.some((f) => /soluble fiber/.test(f.text)),
    "the nutrition action survives as its own ask"
  );

  const fastingAsks = read.flagged.filter((f) => /lipid work/i.test(f.text));
  assert.equal(fastingAsks.length, 1, "a mid-string insertion no longer defeats the twin test");
  assert.match(fastingAsks[0].text, /fasting/, "the more specific (longer) wording is kept");

  assert.ok(
    read.flagged.some((f) => /vitamin d3/i.test(f.text)),
    "a genuinely different marker ask survives"
  );
});

test('"Waiting for you" — the watch-panel recheck collapse groups by clinical marker group, not canonical marker (the live lipid-panel wart)', () => {
  // Ferritin (low side): deriveDirectives emits ONE directive per domain — a
  // nutrition lever, a training caution, and a watch retest — all for the SAME
  // canonical marker. These are three genuinely different asks and must ALL
  // survive, cross-domain (collapseFlagsByMarker's same-marker rule doesn't
  // touch them — different domains, no wording overlap).
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Ferritin",
    directive:
      "Add iron-rich foods (red meat, lentils, spinach) with vitamin C, and avoid tea/coffee around iron-rich meals while ferritin is low.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "training",
    marker: "Ferritin",
    directive: "While ferritin runs low, be cautious adding endurance volume and keep easy sessions easy.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "Ferritin",
    directive: "Recheck ferritin with iron studies / CBC after ~8-12 weeks; discuss supplementation with your doctor.",
    status: "active",
  });

  // A full lipid panel flags ApoB, LDL-C and Non-HDL-C independently, so
  // deriveDirectives emits THREE separate watch retest reminders — one per
  // canonical marker. All three are "Lipids & Cardiovascular" in the shared
  // MARKER_GROUPS taxonomy and all read as a recheck/retest, so they must
  // collapse to ONE line — this is the actual live wart (three differently-
  // worded lipid retest asks under three DIFFERENT canonical markers, which
  // collapseFlagsByMarker's same-marker-only rule can never touch since each
  // marker only ever appears once here).
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive:
      "Lower saturated fat (swap toward olive oil, nuts, oily fish) and add ~10g/day soluble fiber (oats, legumes, psyllium) to bring ApoB toward optimal.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "ApoB",
    directive:
      "Recheck ApoB (and a full lipid panel) in ~12 weeks after dietary changes; discuss with your doctor if it stays elevated.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "LDL-C",
    directive: "Retest lipids in ~12 weeks; if LDL-C remains high despite diet, raise it with your doctor.",
    status: "active",
  });
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "Non-HDL-C",
    directive: "Retest a full lipid panel in ~12 weeks and discuss persistent elevation with your doctor.",
    status: "active",
  });

  const read = repo.teamWeekRead({ asOf: ASOF });

  // (a) ferritin's three cross-domain asks all survive.
  assert.ok(
    read.flagged.some((f) => /^Add iron-rich foods/.test(f.text)),
    "ferritin's nutrition action survives"
  );
  assert.ok(
    read.flagged.some((f) => /cautious adding endurance volume/.test(f.text)),
    "ferritin's training caution survives"
  );
  assert.ok(
    read.flagged.some((f) => /^Recheck ferritin/.test(f.text)),
    "ferritin's own watch retest survives"
  );

  // (b) the three different-canonical-marker lipid watch rechecks collapse to ONE.
  const lipidWatch = read.flagged.filter((f) => /lipid panel|retest lipids|recheck apob/i.test(f.text));
  assert.equal(lipidWatch.length, 1, "three different-canonical-marker lipid rechecks collapse to one");
  assert.match(lipidWatch[0].text, /^Recheck ApoB/, "the longest, most specific wording is kept");

  // (c) the nutrition ApoB action survives alongside the collapsed watch line.
  assert.ok(
    read.flagged.some((f) => /soluble fiber/.test(f.text)),
    "the nutrition ApoB action is a distinct ask from the watch retest line"
  );

  // (d) the watch-domain ferritin recheck (a DIFFERENT clinical group) is not
  // swept into the lipid collapse — two separate "Recheck …" lines survive.
  assert.equal(
    read.flagged.filter((f) => /^Recheck /.test(f.text)).length,
    2,
    "ferritin's recheck and the lipid recheck are two separate lines (different marker groups)"
  );
});

test('"Waiting for you" — a watch directive merely containing "order" (as in "in order to") is not swept into the panel collapse', () => {
  // A real "Recheck ApoB" retest line — eligible for the panel collapse.
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "ApoB",
    directive:
      "Recheck ApoB (and a full lipid panel) in ~12 weeks after dietary changes; discuss with your doctor if it stays elevated.",
    status: "active",
  });
  // Same clinical group (lipids), same watch domain, but NOT a recheck/retest/
  // follow-up ask — "order" only appears inside "in order to", which the old
  // bare \border\b alternative would have wrongly matched.
  repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "LDL-C",
    directive: "Cut saturated fat in order to lower LDL-C toward optimal.",
    status: "active",
  });

  const read = repo.teamWeekRead({ asOf: ASOF });

  assert.ok(
    read.flagged.some((f) => /^Recheck ApoB/.test(f.text)),
    "the real recheck line survives"
  );
  assert.ok(
    read.flagged.some((f) => /^Cut saturated fat in order to/.test(f.text)),
    "the unrelated 'in order to' line is not swept into the panel collapse"
  );
  assert.equal(
    read.flagged.filter((f) => /lipid panel|ldl-c/i.test(f.text)).length,
    2,
    "both lipid-group watch items survive as two separate lines"
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
  // A subject, what was expected and what happens next — never "<metric> didn't land".
  assert.match(
    withConclusive.landed[0].text,
    /^The calorie target change (didn't land as expected|hasn't paid off yet)/
  );
  assert.match(withConclusive.landed[0].text, /the team looked for your weight coming down/);
  assert.match(withConclusive.landed[0].text, /second look/);
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
  assert.deepEqual(read.seats, []);
  assert.equal(read.link, null);
  assert.equal(read.changes_count, 0);
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
    first.insights
      .filter((i) => i.backlog)
      .map((i) => i.text)
      .sort(),
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
  assert.deepEqual(
    drained.map((i) => i.text),
    ["Untouched backlog"],
    "a drainable pass still drains after a read-only one"
  );
});

// ── PART 5: a quiet factual endurance line, only when aerobic activity exists ─────
test("teamWeekRead adds an endurance line only when there was aerobic activity this week", () => {
  // Empty week → no line (never a zero-shame "you didn't run").
  assert.equal(repo.teamWeekRead({ asOf: ASOF }).endurance, null);

  // Two runs + a hike this week → one plain factual line + structured totals.
  repo.addActivity({ type: "run", distance_km: 10, duration_min: 55, date: ASOF });
  repo.addActivity({ type: "run", distance_km: 8, duration_min: 44, date: ASOF });
  repo.addActivity({ type: "hike", distance_km: 6, duration_min: 80, date: ASOF });
  const read = repo.teamWeekRead({ asOf: ASOF });
  assert.ok(read.endurance, "an endurance line appears when there was aerobic activity");
  assert.equal(read.endurance.sessions, 3);
  assert.equal(read.endurance.km, 24);
  assert.equal(read.endurance.longest_km, 10);
  assert.match(read.endurance.text, /24 km over 3 outings/i);
  assert.doesNotMatch(read.endurance.text, /didn't|no runs|no aerobic/i, "never a zero-shame line");
});

test("teamWeekRead frames the endurance line as plan compliance when a run plan exists", () => {
  // Runs are not plan items (migration 110): the week's prescription is the live run
  // engine's, laid on a runner's stated run days. A runner + some logged mileage → the
  // line reads as compliance against that live week.
  repo.setProfile({
    endurance_sport: "run",
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 6, kind: "long" },
      ],
    },
  });
  repo.addActivity({ type: "run", distance_km: 6, duration_min: 34, date: ASOF });
  const comp = repo.vouchedRunCompliance(ASOF);
  assert.equal(comp.basis, "live_plan", "the prescription is the live engine's week");
  assert.ok(comp.prescribed_sessions > 0);
  const read = repo.teamWeekRead({ asOf: ASOF });
  assert.ok(read.endurance);
  assert.match(read.endurance.text, /of .* km this week/i, "compliance framing (actual of prescribed)");
  assert.equal(read.endurance.text, `${comp.in_words.charAt(0).toUpperCase()}${comp.in_words.slice(1)}.`);
});

test('"What we did" excludes observed facts — a block that opened on its own is not team work', () => {
  // ensureActiveBlock opens a periodization block deterministically and records it at
  // the observe tier: the ledger noting something is TRUE, not the team deciding it.
  // Crediting it under "what we did this week" claims work nobody did.
  recordDecision(
    decision("blk", {
      kind: "training_structure",
      domain: "training",
      source: "program-blocks",
      summary: "A 6-week strength block is running.",
      autonomy_tier: "observe",
      applied_at: tsDaysAgo(2),
    }),
    []
  );
  recordDecision(
    decision("t1", {
      kind: "training_target",
      domain: "training",
      summary: "Add a second pull day.",
      applied_at: tsDaysAgo(2),
    }),
    []
  );

  const read = repo.teamWeekRead(ASOF, { drainBacklog: false });
  const lines = (read.did ?? []).flatMap((group) => (group.changes ?? []).map((change) => change.text));
  assert.ok(
    lines.some((line) => /second pull day/i.test(line)),
    "a real decision still reads as team work"
  );
  assert.ok(
    !lines.some((line) => /strength block is running/i.test(line)),
    "an observed fact is not something the team did"
  );
});

// ── The six seats: attribution, the seats summary, the link, spoken lines ─────────

// An auto-progression row as the applier writes it: per-lift after-values beside the
// `before` prescription they overwrote.
function progression(key, lifts, overrides = {}) {
  const day = overrides.day ?? 1;
  const { day: _day, ...rest } = overrides;
  return decision(key, {
    kind: "training_target",
    domain: "training",
    source: "auto-progression",
    source_ref_type: "plan_proposal",
    summary: `Auto-progression for day ${day} — ${lifts.length} lifts`,
    action: {
      changes: lifts.map(([exercise, from, to]) => ({
        day_number: day,
        exercise,
        target_weight: to,
        sets: 3,
        rep_low: 6,
        rep_high: 8,
        before: { sets: 3, rep_low: 6, rep_high: 8, target_weight: from, target_seconds: null },
        change: "updated",
      })),
    },
    ...rest,
  });
}

function attention(signalKey, reason, nextDueDaysAgo, source = "test") {
  db.prepare(
    `INSERT INTO attention_schedule
       (signal_key, domain, tier, next_due, last_checked, reason, release_condition, source, state_json, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    signalKey,
    "training",
    "surveillance",
    isoDaysAgo(nextDueDaysAgo),
    isoDaysAgo(1),
    reason,
    "",
    source,
    "{}",
    tsDaysAgo(1)
  );
}

test("the six seats are one table of roles, and every decision maps to exactly one", () => {
  assert.deepEqual(
    TEAM_SEATS.map((s) => [s.seat, s.role]),
    [
      ["strength", "Strength"],
      ["endurance", "Run"],
      ["recovery", "Recovery"],
      ["fuel", "Fuel"],
      ["body", "Body"],
      ["heart", "Heart"],
    ]
  );
  const cases = [
    [{ kind: "training_target", domain: "training", source: "auto-progression" }, "strength"],
    [{ kind: "exercise_rotation", domain: "training", source: "exercise-swap" }, "strength"],
    [
      {
        kind: "training_structure",
        domain: "training",
        source: "mcp",
        summary: "This week's runs moved: Friday quality (threshold 5 km), Sunday long",
      },
      "endurance",
    ],
    [
      { kind: "training_structure", domain: "training", source: "auto-run-plan", summary: "Next week's plan" },
      "endurance",
    ],
    [{ kind: "training_structure", domain: "recovery", source: "autonomy" }, "recovery"],
    [{ kind: "nutrition_target", domain: "nutrition" }, "fuel"],
    [{ kind: "meal_plan", domain: "nutrition" }, "fuel"],
    [{ kind: "recovery_adjustment", domain: "recovery", source: "underfuel-brain" }, "fuel"],
    [{ kind: "recovery_adjustment", domain: "recovery", source: "autonomy" }, "recovery"],
    [{ kind: "health_directive", domain: "nutrition" }, "heart"],
    [{ kind: "day_read", domain: "cross_domain" }, "recovery"],
    [{ kind: "goal_change", domain: "cross_domain", summary: "Goal weight date moved to Feb 14." }, "body"],
    [{ kind: "case_conference", domain: "health", source: "case_conference" }, "heart"],
    [
      {
        kind: "nutrition_target",
        domain: "nutrition",
        source: "case_conference",
        action: { conference_revision_type: "nutrition_target" },
      },
      "fuel",
    ],
    [
      {
        kind: "case_conference",
        domain: "cross_domain",
        specialist: { opinions: [{ domain: "endurance", recommendation: "x" }] },
      },
      "endurance",
    ],
    [{ kind: "training_target", domain: "training", specialist: { seat: "body" } }, "body"],
  ];
  for (const [row, seat] of cases) assert.equal(teamSeatForDecision(row), seat, JSON.stringify(row));
});

test("an auto-progression is attributed to Strength at the write, and history is attributed at the read", () => {
  const recorded = recordDecision(
    progression("p-attr", [
      ["Bench Press", 135, 145],
      ["Barbell Row", 125, 135],
    ]),
    []
  );
  assert.equal(storedSeat(recorded.decision.specialist), "strength", "the write stamps the seat");

  // A patch that changes what the row IS re-derives the seat from the patched row.
  const nutrition = recordDecision(decision("p-patch", { applied_at: tsDaysAgo(9) }), []);
  assert.equal(storedSeat(nutrition.decision.specialist), "fuel");
  const patched = patchBrainDecision(nutrition.decision.id, { kind: "training_target", domain: "training" });
  assert.equal(storedSeat(patched.specialist), "strength");

  // An older row stored with no seat at all is still attributed when read.
  db.prepare(`UPDATE brain_decisions SET specialist_json = NULL WHERE id = ?`).run(recorded.decision.id);
  assert.equal(getBrainDecision(recorded.decision.id).specialist, null);
  const read = repo.teamWeekRead({ asOf: ASOF });
  const training = read.did.find((g) => g.domain === "training");
  const line = training.changes.find((c) => /Bench Press/.test(c.text));
  assert.ok(line, "the progression names its lifts");
  assert.equal(line.seat, "strength");
  assert.equal(line.specialist, "Strength");
  assert.match(line.text, /^Bench Press moved up to 145 lb and Barbell Row up to 135 lb/);
});

test("progression lines name the lifts and the step — never 'across days 1, 2, 4'", () => {
  recordDecision(
    progression(
      "d1",
      [
        ["Bench Press", 135, 145],
        ["Incline Press", 95, 100],
      ],
      { day: 1, applied_at: tsDaysAgo(5) }
    ),
    []
  );
  recordDecision(
    progression(
      "d2",
      [
        ["Back Squat", 185, 195],
        ["Leg Curl", 70, 75],
      ],
      { day: 2, applied_at: tsDaysAgo(4) }
    ),
    []
  );
  recordDecision(
    progression(
      "d4",
      [
        ["Barbell Row", 125, 135],
        ["Lat Pulldown", 100, 100],
      ],
      { day: 4, applied_at: tsDaysAgo(3) }
    ),
    []
  );
  const read = repo.teamWeekRead({ asOf: ASOF });
  const texts = read.did.flatMap((g) => g.changes.map((c) => c.text));
  assert.equal(texts.length, 1, "the week's progressions are one line");
  assert.doesNotMatch(texts[0], /\bdays?\s+\d|auto-progress/i);
  assert.match(texts[0], /moved up to \d+ lb/);
  assert.match(
    texts[0],
    /(and four more lifts moved from your log|plus four more lifts adjusted from what you logged)\.$/
  );
  assert.match(JSON.stringify(read), /"seat":"strength"/);
});

test("seats: at most three, most material first, each with one spoken call", () => {
  // Strength: a load step (material) AND a single tweak — two calls this week.
  recordDecision(progression("s-prog", [["Bench Press", 135, 145]], { applied_at: tsDaysAgo(2) }), []);
  recordDecision(
    decision("s-single", {
      kind: "training_target",
      domain: "training",
      summary: "Add a second pull day.",
      applied_at: tsDaysAgo(2),
    }),
    []
  );
  // Fuel, Recovery and Run: one material call each, Fuel the newest.
  recordDecision(decision("f-target", { summary: "Hold the target at 2,163 kcal.", applied_at: tsDaysAgo(1) }), []);
  recordDecision(
    decision("r-easy", {
      kind: "recovery_adjustment",
      domain: "recovery",
      source: "autonomy",
      summary: "Ease this week for recovery.",
      applied_at: tsDaysAgo(3),
    }),
    []
  );
  recordDecision(
    decision("e-runs", {
      kind: "training_structure",
      domain: "training",
      source: "mcp",
      summary: "This week's runs moved: Friday quality, Sunday long",
      applied_at: tsDaysAgo(4),
    }),
    []
  );
  const read = repo.teamWeekRead({ asOf: ASOF });
  assert.equal(read.seats.length, 3, "capped at three");
  assert.deepEqual(
    read.seats.map((s) => s.seat),
    ["strength", "fuel", "recovery"],
    "material calls first, then the seat with more calls, then the newest"
  );
  const [strength, fuel] = read.seats;
  assert.equal(strength.role, "Strength");
  assert.match(strength.did, /^Bench Press moved up to 145 lb/, "the seat's most material call, not its smallest");
  assert.equal(strength.when, isoDaysAgo(2));
  assert.equal(fuel.role, "Fuel");
  assert.equal(fuel.did, "Hold the target at 2,163 kcal.");
  assert.equal(read.changes_count, 5);
  assert.match(
    read.lead,
    /^(Strength led the week\.|Most of this week's work sat with Strength\.) Bench Press moved up to 145 lb/
  );
});

test("a seat's expects and landed come from the ledger's own expectation and verdict", () => {
  // This week's call, with a real open expectation.
  recordDecision(progression("x-now", [["Bench Press", 135, 145]], { applied_at: tsDaysAgo(1) }), [
    expectation({
      metric_key: "exercise_target_completion",
      subject_key: "Bench Press",
      direction: "complete",
      baseline: null,
      target: { exposures: 2 },
      window_start: isoDaysAgo(1),
      window_end: isoDaysAgo(-20),
      minimum_data: { exposures: 2 },
      confounder_policy: "require_exposure",
      evaluator: "exercise_completion",
    }),
  ]);
  // An earlier Strength call whose verdict came in: it missed.
  const earlier = recordDecision(progression("x-then", [["Barbell Row", 125, 135]], { applied_at: tsDaysAgo(25) }), [
    expectation({
      metric_key: "exercise_target_completion",
      subject_key: "Barbell Row",
      direction: "complete",
      baseline: null,
      target: { exposures: 2 },
      window_start: isoDaysAgo(25),
      window_end: isoDaysAgo(3),
      minimum_data: { exposures: 2 },
      confounder_policy: "require_exposure",
      evaluator: "exercise_completion",
    }),
  ]);
  insertBrainEvaluation({
    expectation_id: earlier.expectations[0].id,
    verdict: "not_aligned",
    actual: { exposures: 2, completed: 0 },
    evidence_keys: ["exercise:Barbell Row"],
    confounders: [],
    explanation: "Neither exposure hit the written target.",
    evaluator_version: "test-v1",
  });

  const read = repo.teamWeekRead({ asOf: ASOF });
  const strength = read.seats.find((s) => s.seat === "strength");
  assert.ok(strength);
  assert.match(
    strength.expects,
    /^Expects to see Bench Press done as written in two sessions by [A-Z][a-z]{2} \d{1,2}(, \d{4})?\.$/
  );
  assert.match(
    strength.landed,
    /^The last step on Barbell Row (didn't land as expected, so it's getting a second look|fell short, so the team is taking a second look)\.$/
  );

  // The landed list names the subject, what was expected and what happens next.
  const missed = read.landed.find((l) => l.verdict === "not_aligned");
  assert.ok(missed);
  assert.match(
    missed.text,
    /^The step on Barbell Row (didn't land as expected|hasn't paid off yet): the team looked for it done as written in two sessions\. /
  );
  assert.equal(missed.seat, "strength");
  for (const l of read.landed) assert.doesNotMatch(l.text, /^(Exercise completion|Strength progression) didn't land/);

  // The watch line for the open expectation is spoken too.
  const watch = read.watching.find((w) => w.source === "expectation");
  assert.match(watch.text, /Bench Press done as written in two sessions/);
  assert.doesNotMatch(watch.text, /exercise completion answers/);
});

test("a seat with no open expectation and no concluded call says so with nulls, never filler", () => {
  recordDecision(decision("q-fuel", { summary: "Hold the target at 2,163 kcal.", applied_at: tsDaysAgo(1) }), []);
  const [fuel] = repo.teamWeekRead({ asOf: ASOF }).seats;
  assert.equal(fuel.seat, "fuel");
  assert.equal(fuel.expects, null);
  assert.equal(fuel.landed, null);
});

function cutRead(verdict, anchors, vs = "within") {
  return {
    active: true,
    verdict,
    words: "A couple of anchor lifts are sliding while your weight drops.",
    weight: { trend_lb_wk: -0.9, window_days: 21 },
    strength: { considered: 4, holding: 2, regressing: 2, anchors },
    endurance: null,
    rate: { vs_lean_safe: vs },
  };
}

test("the link speaks only during a confident cut with sliding lifts", () => {
  const sliding = cutRead("sliding", [
    { name: "Overhead Press", status: "regressing" },
    { name: "Bench Press", status: "regressing" },
    { name: "Back Squat", status: "progressing" },
  ]);
  const link = teamWeekLink(sliding, ASOF);
  assert.deepEqual(link.seats, ["strength", "fuel"]);
  assert.match(link.text, /^Overhead Press and Bench Press are sliding while your weight drops\. /);
  assert.match(link.text, /deficit/);
  assert.match(link.ask, /^What if I (ease the cut|eased the deficit a little)\?$/);
  assert.match(teamWeekLink(cutRead("sliding", [], "above"), ASOF).text, /lean-safe pace/);

  assert.equal(teamWeekLink(cutRead("preserving", []), ASOF), null);
  assert.equal(teamWeekLink(cutRead("mixed", []), ASOF), null);
  assert.equal(teamWeekLink(cutRead("insufficient", []), ASOF), null);
  assert.equal(teamWeekLink({ active: false }, ASOF), null);
  assert.equal(teamWeekLink(null, ASOF), null);

  // Through the read: the link rides beside the existing cut line.
  const read = repo.teamWeekRead({ asOf: ASOF, cutRead: sliding });
  assert.ok(read.link);
  assert.ok(read.cut, "the cut line still stands");
  assert.equal(repo.teamWeekRead({ asOf: ASOF, cutRead: cutRead("insufficient", []) }).link, null);
});

test("directives written for a clinician become ONE line for you and your doctor, and the lead never counts asks", () => {
  repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "Rheumatoid factor",
    directive:
      "No training or meal change for RF. Surface the 16 IU/mL result and the negative ANA for a clinician to decide on repeat.",
    status: "active",
  });
  repo.addDirective({
    source: "health_review",
    domain: "watch",
    marker: "Lp(a)",
    directive:
      "Do not chase Lp(a) with diet changes; manage ApoB and LDL, and let the clinician interpret the 102.8 nmol/L result.",
    status: "active",
  });
  repo.addDirective({
    source: "health_review",
    domain: "nutrition",
    marker: "Omega-3 Total",
    directive: "Include two servings of oily fish this week (salmon, sardines, mackerel, or trout).",
    status: "active",
  });
  const read = repo.teamWeekRead({ asOf: ASOF });
  const texts = read.flagged.map((f) => f.text);
  assert.equal(read.flagged.length, 2, "the two clinician notes fold into one line beside the food suggestion");
  const doctor = texts.find((t) => /doctor/.test(t));
  assert.ok(doctor);
  assert.match(doctor, /rheumatoid factor/);
  assert.match(doctor, /Lp\(a\)/);
  for (const t of texts) assert.doesNotMatch(t, /clinician|^Surface|^Do not/i);
  assert.ok(texts.includes("Include two servings of oily fish this week (salmon, sardines, mackerel, or trout)."));
  assert.doesNotMatch(read.lead, /\d/);
  assert.match(
    read.lead,
    /(One lab result is worth raising with your doctor|Your labs left one thing for you and your doctor)\./
  );
});

test("watching speaks plateau, change-check and marker notes in plain words", () => {
  attention(
    "strength:benchmark:row",
    "Barbell Bent-Over Row is plateaued ~22 wk; re-test or rotate only after a useful training response.",
    -4,
    "training-milestones"
  );
  const missed = recordDecision(progression("w-check", [["Bench Press", 135, 145]], { applied_at: tsDaysAgo(9) }), []);
  attention(
    `training:change-check:d${missed.decision.id}`,
    "Auto-progression for day 1 — 1 lifts — that one hasn't played out the way we expected.",
    -5,
    "expectation-followup"
  );
  attention(
    "marker:apob",
    "ApoB is outside its optimal/lab range; Lipids take about three months to answer a change in food or training, so a recheck after that says the most",
    -6,
    "doctor-loop"
  );
  const texts = repo.teamWeekRead({ asOf: ASOF }).watching.map((w) => w.text);
  const row = texts.find((t) => /Barbell Bent-Over Row/.test(t));
  assert.match(row, /about twenty-two weeks|about 22 weeks/);
  assert.doesNotMatch(row, /useful training response|~22 wk/);
  const check = texts.find((t) => /Bench Press/.test(t));
  assert.match(check, /^The step on Bench Press hasn't/);
  assert.doesNotMatch(texts.join(" "), /Auto-progression for day|outside its optimal\/lab range/);
  assert.ok(texts.some((t) => /ApoB/.test(t) && /Lipids take about three months/.test(t)));
});

test("a decision's explanation never leaks the machine register to the athlete", () => {
  const leak =
    "case conference: Unexplained regression requires a revision: recovery_wellbeing. Reconcile the next bounded revision against the standing objective: everything better.";
  const held = recordDecision(
    decision("leak", { status: "review", applied_at: null, rationale: leak, action: {}, source: "case_conference" }),
    []
  ).decision;
  const words = decisionExplanation(held);
  assert.equal(words, "A change to your calorie and protein targets from the team's latest review.");
  const listed = listReadableBrainDecisions({ limit: 20 }).find((d) => d.id === held.id);
  assert.equal(listed.user_explanation, words);

  // A conductor's sentence that leaks falls back to a readable rationale.
  const fallback = recordDecision(
    decision("leak2", {
      rationale: "Your recovery has lagged, so the week eases.",
      action: { user_explanation: "Unexplained regression requires a revision: recovery_wellbeing." },
    }),
    []
  ).decision;
  assert.equal(decisionExplanation(fallback), "Your recovery has lagged, so the week eases.");

  // A sentence written for the athlete passes through verbatim.
  const clean = recordDecision(
    decision("clean", {
      action: { user_explanation: "Strength is moving; recovery isn't, so fuel moves onto the hard days." },
    }),
    []
  ).decision;
  assert.equal(decisionExplanation(clean), "Strength is moving; recovery isn't, so fuel moves onto the hard days.");

  // Nothing written at all stays nothing.
  assert.equal(decisionExplanation(recordDecision(decision("none", { rationale: null }), []).decision), null);
});
