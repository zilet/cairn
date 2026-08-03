// Insight intent keys (src/repo/insight-intent.ts + the acceptance ladder in
// src/coachOps.ts). Text dedup only ever caught REWORDINGS — "your protein timing
// and sleep quality look linked" and "your sleep tends to improve on days when
// dinner protein is higher" are the same claim in almost no shared words, so no
// Jaccard threshold refuses the second. The key names WHAT is connected instead.
//
// This tests the GUARD, not the subprocess: there is no offline e2e path for the
// insight op (the stub agent emits proposal JSON, which isInsightResult rejects
// before the ladder is ever reached), so the ladder is exercised through the
// exported insightVerdict().
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { insightCacheKey, insightVerdict } from "../dist/coachOps.js";
import { buildInsightPrompt } from "../dist/prompt.js";

const {
  parseInsightIntentKey,
  deriveInsightIntentKey,
  insightIntentCorpus,
  isDuplicateInsightIntent,
  isDuplicateInsight,
  describeInsightIntentKey,
  INSIGHT_FACETS,
  DOWNVOTED_KEY_LIMIT,
  INSIGHT_KEY_WINDOW_DAYS,
} = repo;

beforeEach(() => {
  db.prepare("DELETE FROM insights").run();
});

const PROTEIN_SLEEP = "nutrition.protein~sleep.quality";

// ---------------------------------------------------------------------------
// (1) parse / validate
// ---------------------------------------------------------------------------

test("a valid connection parses into a canonical, lexicographically sorted key", () => {
  // b is given first in the payload; the key must not depend on payload order.
  const key = parseInsightIntentKey({
    a: { facet: "sleep.quality", direction: "up" },
    b: { facet: "nutrition.protein", direction: "up" },
  });
  assert.equal(key, `${PROTEIN_SLEEP}:same`);
});

test("agreeing directions read :same and differing ones read :opposite", () => {
  const of = (da, db_) =>
    parseInsightIntentKey({
      a: { facet: "nutrition.protein", direction: da },
      b: { facet: "sleep.quality", direction: db_ },
    });
  assert.equal(of("up", "up"), `${PROTEIN_SLEEP}:same`);
  assert.equal(of("down", "down"), `${PROTEIN_SLEEP}:same`);
  assert.equal(of("up", "down"), `${PROTEIN_SLEEP}:opposite`);
  assert.equal(of("down", "up"), `${PROTEIN_SLEEP}:opposite`);
});

test("an unknown facet, a bad direction, or a malformed payload is refused", () => {
  assert.equal(
    parseInsightIntentKey({
      a: { facet: "nutrition.pizza", direction: "up" },
      b: { facet: "sleep.quality", direction: "up" },
    }),
    null,
    "unknown facet"
  );
  assert.equal(
    parseInsightIntentKey({
      a: { facet: "nutrition.protein", direction: "higher" },
      b: { facet: "sleep.quality", direction: "up" },
    }),
    null,
    "a direction outside up|down"
  );
  assert.equal(parseInsightIntentKey({ a: { facet: "nutrition.protein", direction: "up" } }), null, "a missing side");
  assert.equal(parseInsightIntentKey(null), null);
  assert.equal(
    parseInsightIntentKey("nutrition.protein~sleep.quality:same"),
    null,
    "a bare string is not a connection"
  );
});

test("a SAME-domain pair is refused outright — it is not a cross-domain connection", () => {
  assert.equal(
    parseInsightIntentKey({
      a: { facet: "sleep.quality", direction: "up" },
      b: { facet: "sleep.duration", direction: "up" },
    }),
    null
  );
  assert.equal(
    parseInsightIntentKey({
      a: { facet: "labs.iron", direction: "down" },
      b: { facet: "labs.lipids", direction: "up" },
    }),
    null
  );
  // The same facet on both sides is likewise not a connection.
  assert.equal(
    parseInsightIntentKey({
      a: { facet: "sleep.quality", direction: "up" },
      b: { facet: "sleep.quality", direction: "down" },
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// (2) flip symmetry — one claim, one key
// ---------------------------------------------------------------------------

test("a globally flipped connection produces the IDENTICAL key", () => {
  const forward = parseInsightIntentKey({
    a: { facet: "nutrition.protein", direction: "up" },
    b: { facet: "sleep.quality", direction: "up" },
  });
  const flipped = parseInsightIntentKey({
    a: { facet: "sleep.quality", direction: "down" },
    b: { facet: "nutrition.protein", direction: "down" },
  });
  assert.equal(forward, flipped, "'protein up with sleep up' and 'sleep down with protein down' are one claim");
  // And a HALF flip is a different claim, so it must not collapse into the same key.
  const half = parseInsightIntentKey({
    a: { facet: "sleep.quality", direction: "down" },
    b: { facet: "nutrition.protein", direction: "up" },
  });
  assert.notEqual(forward, half);
});

// ---------------------------------------------------------------------------
// (3) the whole point: a genuine rephrase is blocked where text dedup waves it through
// ---------------------------------------------------------------------------

test("a rephrased repeat of a stored connection is refused, and text dedup alone would not have caught it", () => {
  const original = "Your protein timing and sleep quality look linked.";
  const rephrase = "Your sleep tends to improve on days when dinner protein is higher.";
  repo.addInsight({ kind: "connection", text: original, intent_key: `${PROTEIN_SLEEP}:same` });

  // What the key layer adds: the text guard sees two unrelated sentences.
  assert.equal(
    isDuplicateInsight(rephrase, [original]),
    false,
    "the text guard does NOT catch this — that is the gap the key closes"
  );

  const corpus = insightIntentCorpus();
  assert.ok(corpus.keys.includes(`${PROTEIN_SLEEP}:same`));
  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: rephrase,
      connection: {
        a: { facet: "sleep.quality", direction: "up" },
        b: { facet: "nutrition.protein", direction: "up" },
      },
    },
    kind: "connection",
    keyCorpus: corpus.keys,
    recentTexts: [original],
  });
  assert.equal(verdict.accept, false, "the same territory is refused however it is worded");
  assert.equal(verdict.agent_ran, true, "the agent DID answer — this is calm silence, not a failure");
});

// ---------------------------------------------------------------------------
// (4) a different connection still gets through
// ---------------------------------------------------------------------------

test("a different key passes even when it shares most of its words with a stored insight", () => {
  const stored = "Your protein intake and sleep quality look linked.";
  repo.addInsight({ kind: "connection", text: stored, intent_key: `${PROTEIN_SLEEP}:same` });
  const corpus = insightIntentCorpus();

  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: "Your protein intake and training volume look linked.",
      connection: {
        a: { facet: "nutrition.protein", direction: "up" },
        b: { facet: "training.volume", direction: "up" },
      },
    },
    kind: "connection",
    keyCorpus: corpus.keys,
    // Deliberately an EMPTY text corpus: this asserts the KEY layer lets it through.
    // (The shared wording is what the second net is for, and it is tested above.)
    recentTexts: [],
  });
  assert.equal(verdict.accept, true);
  assert.equal(verdict.key, "nutrition.protein~training.volume:same");
});

// ---------------------------------------------------------------------------
// (5) legacy rows: keys are derived at READ time, never backfilled
// ---------------------------------------------------------------------------

test("a legacy NULL-key row whose text names two derivable facets blocks a new keyed candidate", () => {
  const legacy = "Your weekly mileage climbed and your resting heart rate drifted up alongside it.";
  const row = repo.addInsight({ kind: "connection", text: legacy });
  assert.equal(row.intent_key, null, "the row is stored unkeyed — there is no backfill");

  const derived = deriveInsightIntentKey(legacy, null);
  assert.equal(derived, "endurance.mileage~recovery.resting_hr:*", "derivation reads territory, never polarity");

  const corpus = insightIntentCorpus();
  assert.ok(corpus.keys.includes(derived), "the legacy row contributes a derived key to the corpus");
  assert.deepEqual(corpus.unkeyedTexts, [], "a row that derives cleanly is not also listed as raw text");

  // A wildcard key collides with either polarity, so the connection is spent both ways.
  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: "Mileage and resting heart rate have been moving in step lately.",
      connection: {
        a: { facet: "endurance.mileage", direction: "up" },
        b: { facet: "recovery.resting_hr", direction: "down" },
      },
    },
    kind: "connection",
    keyCorpus: corpus.keys,
    recentTexts: [],
  });
  assert.equal(verdict.accept, false);
});

test("derivation stays silent on ambiguity, and those rows keep going to the model as raw text", () => {
  assert.equal(deriveInsightIntentKey("A quiet week is a fine week.", null), null, "no facets at all");
  assert.equal(deriveInsightIntentKey("Your sleep quality has been steady.", null), null, "only one facet");
  assert.equal(
    deriveInsightIntentKey("Sleep quality, bedtime and how long you sleep have all been steady.", null),
    null,
    "two facets in ONE domain is not a cross-domain connection"
  );
  assert.equal(
    deriveInsightIntentKey("Protein, sleep quality and training volume all moved together.", null),
    null,
    "three facets is ambiguous — the key would have to guess which pair"
  );

  const vague = "A quiet week is a fine week.";
  repo.addInsight({ kind: "connection", text: vague });
  const corpus = insightIntentCorpus();
  assert.deepEqual(corpus.keys, []);
  assert.deepEqual(corpus.unkeyedTexts, [vague], "unkeyable rows stay listed verbatim so a literal repeat is blocked");
});

// ---------------------------------------------------------------------------
// (6) an invalid connection costs the KEY, never the insight
// ---------------------------------------------------------------------------
//
// `connection` is the agent's optional statement of what its insight is ABOUT. A miss
// there (unknown facet, both facets in one domain, a malformed shape) used to discard
// the whole insight. It no longer does: the unusable key is dropped and the ladder
// falls through to derivation, exactly as if no connection had been named. The corpus
// is just as safe — an invalid key is never stored either way — and a vocabulary miss
// in one field no longer costs a genuine connection.

const INVALID_CONNECTIONS = [
  { a: { facet: "nutrition.unicorn", direction: "up" }, b: { facet: "sleep.quality", direction: "up" } },
  { a: { facet: "sleep.quality", direction: "up" }, b: { facet: "sleep.duration", direction: "up" } },
  { a: "protein", b: "sleep" },
  {},
];

test("an INVALID connection falls through to derivation, and the insight survives", () => {
  for (const connection of INVALID_CONNECTIONS) {
    const verdict = insightVerdict({
      parsed: {
        found: true,
        text: "Your protein intake climbs on the weeks your sleep quality holds up.",
        connection,
      },
      kind: "connection",
      keyCorpus: [],
      recentTexts: [],
    });
    assert.equal(verdict.accept, true, `invalid connection kept: ${JSON.stringify(connection)}`);
    assert.equal(verdict.key, `${PROTEIN_SLEEP}:*`, "the key comes from the TEXT, never from the bad field");
  }
});

test("an INVALID connection whose text derives nothing is stored with a NULL key", () => {
  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: "A quiet week is a fine week.",
      connection: INVALID_CONNECTIONS[0],
    },
    kind: "connection",
    keyCorpus: [],
    recentTexts: [],
  });
  assert.equal(verdict.accept, true, "no key is not a rejection — the pre-key status quo still applies");
  assert.equal(verdict.key, null, "and no invalid key ever reaches the corpus");
});

test("a VALID connection that collides is still refused — that is the key layer's whole job", () => {
  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: "Protein and sleep quality still look linked.",
      connection: {
        a: { facet: "nutrition.protein", direction: "up" },
        b: { facet: "sleep.quality", direction: "up" },
      },
    },
    kind: "connection",
    keyCorpus: [`${PROTEIN_SLEEP}:same`],
    recentTexts: [],
  });
  assert.equal(verdict.accept, false);
  assert.equal(verdict.agent_ran, true, "a calm 'the agent answered' rejection");
});

test("an insight with NO connection at all falls back to derivation, then to the text guard", () => {
  const derivable = insightVerdict({
    parsed: { found: true, text: "Your protein intake climbs on the weeks your sleep quality holds up." },
    kind: "connection",
    keyCorpus: [],
    recentTexts: [],
  });
  assert.equal(derivable.accept, true);
  assert.equal(derivable.key, `${PROTEIN_SLEEP}:*`, "derived, wildcard polarity");

  const undecidable = insightVerdict({
    parsed: { found: true, text: "A quiet week is a fine week." },
    kind: "connection",
    keyCorpus: [],
    recentTexts: [],
  });
  assert.equal(undecidable.accept, true, "no key is not a rejection — the status quo still applies");
  assert.equal(undecidable.key, null, "stored with a NULL key");

  const textRepeat = insightVerdict({
    parsed: { found: true, text: "A quiet week is a fine week." },
    kind: "connection",
    keyCorpus: [],
    recentTexts: ["A quiet week is a fine week."],
  });
  assert.equal(textRepeat.accept, false, "the text guard is still the second net");
});

// ---------------------------------------------------------------------------
// (7) the quiet path is unchanged
// ---------------------------------------------------------------------------

test("the {found:false} path is unchanged: a rejection the agent DID produce", () => {
  // generateInsight maps agent_ran:true onto agent_status:"ok" with
  // error:"no genuine new insight" — a legitimately quiet answer, never a failure.
  const quiet = insightVerdict({ parsed: { found: false }, kind: "connection", keyCorpus: [], recentTexts: [] });
  assert.deepEqual(quiet, { accept: false, agent_ran: true });

  // Nothing parseable at all is the OTHER rejection — the one that reports the agent.
  for (const parsed of [null, undefined, "found:false", 7]) {
    assert.deepEqual(
      insightVerdict({ parsed, kind: "connection", keyCorpus: [], recentTexts: [] }),
      { accept: false, agent_ran: false },
      `unparseable: ${JSON.stringify(parsed) ?? "undefined"}`
    );
  }
});

// ---------------------------------------------------------------------------
// (8) weekly_read is exempt — it recurs on the same territory by design
// ---------------------------------------------------------------------------

test("two weekly reads on the same territory both pass — the key layer never touches them", () => {
  const first = "Solid week: mileage held and your sleep quality was steady throughout.";
  repo.addInsight({ kind: "weekly_read", text: first, intent_key: null });
  const corpus = insightIntentCorpus();
  assert.deepEqual(corpus.keys, [], "a weekly read never enters the key corpus");
  assert.deepEqual(corpus.unkeyedTexts, [], "nor its text");

  const second = insightVerdict({
    parsed: {
      found: true,
      text: "Another steady week: mileage held and your sleep quality stayed even.",
      // Even if a model volunteered one, a weekly read is not keyed.
      connection: {
        a: { facet: "endurance.mileage", direction: "up" },
        b: { facet: "sleep.quality", direction: "up" },
      },
    },
    kind: "weekly_read",
    keyCorpus: [`endurance.mileage~sleep.quality:same`],
    recentTexts: [],
  });
  assert.equal(second.accept, true);
  assert.equal(second.key, null, "a weekly read is stored with no key");
});

// ---------------------------------------------------------------------------
// (9) a downvoted key suppresses territorially, bounded like its text sibling
// ---------------------------------------------------------------------------

test("a downvoted KEY keeps suppressing its territory past the recency window", () => {
  const downKey = `${PROTEIN_SLEEP}:same`;
  const downed = repo.addInsight({
    kind: "connection",
    text: "Your protein intake and sleep quality look linked.",
    intent_key: downKey,
    feedback: "down",
  });
  assert.ok(downed);
  // Age it well out of the window, and bury it under newer unrelated connections.
  db.prepare(`UPDATE insights SET created_at = datetime('now', ?) WHERE id = ?`).run(
    `-${INSIGHT_KEY_WINDOW_DAYS + 30} days`,
    downed.id
  );
  for (let i = 0; i < 20; i++) {
    repo.addInsight({ kind: "connection", text: `Unrelated observation number ${i} about something else entirely.` });
  }

  const corpus = insightIntentCorpus();
  assert.ok(corpus.keys.includes(downKey), "a downvoted key is unioned in regardless of age");
  assert.equal(isDuplicateInsightIntent(downKey, corpus.keys), true);
  // A rephrase of the waved-off connection stays suppressed too — that is the point
  // of suppressing the TERRITORY rather than the sentence.
  const verdict = insightVerdict({
    parsed: {
      found: true,
      text: "Sleep seems to hold up better on your higher-protein days.",
      connection: {
        a: { facet: "sleep.quality", direction: "down" },
        b: { facet: "nutrition.protein", direction: "down" },
      },
    },
    kind: "connection",
    keyCorpus: corpus.keys,
    recentTexts: [],
  });
  assert.equal(verdict.accept, false);
});

test("the downvoted-key union is bounded by DOWNVOTED_KEY_LIMIT", () => {
  assert.ok(Number.isInteger(DOWNVOTED_KEY_LIMIT) && DOWNVOTED_KEY_LIMIT > 0);
  const labs = INSIGHT_FACETS.filter((f) => f.domain === "labs").map((f) => f.facet);
  const training = INSIGHT_FACETS.filter((f) => f.domain === "training").map((f) => f.facet);
  const distinct = [];
  for (const a of labs) for (const b of training) distinct.push(`${a}~${b}:same`);
  assert.ok(distinct.length > DOWNVOTED_KEY_LIMIT, "need more distinct keys than the limit to prove the bound bites");

  distinct.forEach((key, i) => {
    repo.addInsight({ kind: "connection", text: `Aged downvoted connection ${i}.`, intent_key: key, feedback: "down" });
  });
  // Age every row out of the time window, so the ONLY thing keeping keys alive is the
  // downvote union — and it must stop at the limit rather than growing without bound.
  db.prepare(`UPDATE insights SET created_at = datetime('now', ?)`).run(`-${INSIGHT_KEY_WINDOW_DAYS + 30} days`);
  const corpus = insightIntentCorpus();
  assert.equal(corpus.keys.length, DOWNVOTED_KEY_LIMIT, "aged downvoted keys still suppress, capped at the limit");
  assert.ok(corpus.keys.includes(distinct[distinct.length - 1]), "the most recent downvotes are the ones kept");
});

// ---------------------------------------------------------------------------
// (10) cache identity and guard identity are the same model
// ---------------------------------------------------------------------------

test("the insight cache key moves when the key corpus moves", () => {
  // Computed back to back so the shared hour bucket cannot be what differs.
  const empty = insightCacheKey("connection", [], []);
  const covered = insightCacheKey("connection", [], [`${PROTEIN_SLEEP}:same`]);
  const coveredAgain = insightCacheKey("connection", [], [`${PROTEIN_SLEEP}:same`]);
  const reordered = insightCacheKey(
    "connection",
    [],
    ["endurance.mileage~recovery.resting_hr:same", `${PROTEIN_SLEEP}:same`]
  );
  const reorderedFlipped = insightCacheKey(
    "connection",
    [],
    [`${PROTEIN_SLEEP}:same`, "endurance.mileage~recovery.resting_hr:same"]
  );

  assert.notEqual(empty, covered, "newly covered territory busts the cache — a stale hit can't mask the guard");
  assert.equal(covered, coveredAgain, "stable for the same corpus");
  assert.notEqual(covered, reordered, "more covered territory is a different pass");
  assert.equal(reordered, reorderedFlipped, "corpus order is not part of the identity");
});

// ---------------------------------------------------------------------------
// (7) surfaces must be unambiguous: no idiomatic or mechanical second meanings
// ---------------------------------------------------------------------------
//
// Derivation reads free prose, so a bare common word fires on sentences that are not
// about the facet at all. Two distinct failures come out of that, and the second is
// the quiet one:
//
//   a FALSE PAIR   — two facets derive, one of them wrong, and the resulting wildcard
//                    key suppresses a genuine territory for 90 days, invisibly.
//   a LOST GUARD   — a stray THIRD facet lands in an otherwise clean sentence, the
//                    "exactly two" rule collapses the whole derivation to null, and a
//                    real repeat walks straight through the guard.
//
// Every sentence below is SYNTHETIC — written to reproduce the idiom pattern, never
// copied from anyone's data.

test("idiomatic uses of a facet word do not derive that facet", () => {
  const idioms = [
    // "weight" as accumulated fatigue, not the scale.
    ["That run was carrying the weight of the days before it, and your sleep was short.", "body.weight"],
    // "schedule" as rate of progress, not the calendar.
    ["Your progress is ahead of schedule and your protein intake has been steady.", "life.schedule"],
    // "pace" as rate of change, not running pace.
    ["The pace of change has been steady and your protein intake is up.", "endurance.pace"],
    // "a tweak" as an edit to the plan, not a strained joint.
    ["A tweak to your plan and your sleep both landed the same week.", "recovery.joint_pain"],
    // "consistency" said of sleep, not of training attendance.
    ["The consistency of your sleep improved when your protein intake rose.", "training.consistency"],
  ];
  for (const [text, mustNotFire] of idioms) {
    const key = deriveInsightIntentKey(text, null);
    assert.ok(
      key === null || !key.includes(mustNotFire),
      `${mustNotFire} must not derive from an idiom — got ${key} for: ${text}`
    );
  }
});

test("mechanical uses of a facet word do not derive the psychological or dietary facet", () => {
  // "stress" on a joint is load, the opposite domain from life stress.
  const mechanical = deriveInsightIntentKey("Stress on the elbow joint climbed as your sleep got shorter.", null);
  assert.ok(mechanical === null || !mechanical.includes("life.stress"), `got ${mechanical}`);
  // "drinking" water is hydration, not alcohol.
  const hydration = deriveInsightIntentKey("Drinking water alongside your heavier sessions seems to help.", null);
  assert.ok(hydration === null || !hydration.includes("nutrition.alcohol"), `got ${hydration}`);
  // Physical tension in a joint is not life stress either.
  const tension = deriveInsightIntentKey(
    "The tension in your right elbow shows up on pressing days, and your sleep has been broken.",
    null
  );
  assert.ok(tension === null || !tension.includes("life.stress"), `got ${tension}`);
});

// The LOST-GUARD half, and the one that costs most: a clean two-facet sentence must
// not be knocked out by a third facet the prose never meant. "The strength of the
// link" is the pattern that did it — an insight-voice phrase that fires a training
// facet inside a sentence about labs and food.
test("an idiom does not smuggle a third facet in and collapse a genuine derivation", () => {
  assert.equal(
    deriveInsightIntentKey("The strength of the link between your fibre intake and your cholesterol is clear.", null),
    "labs.lipids~nutrition.fibre:*",
    "the real pair must survive the idiom"
  );
  assert.equal(
    deriveInsightIntentKey("The pain keeps showing up in your training when your sleep runs short.", null),
    "recovery.joint_pain~sleep.quality:*",
    "pain 'showing up' is not training consistency"
  );
});

// The narrowing must not have cost the true positives it exists to catch.
test("the genuine phrasings of each narrowed facet still derive", () => {
  const genuine = [
    ["Your body weight has been drifting down on the weeks your sleep holds up.", "body.weight~sleep.quality:*"],
    ["Your weight is moving again now that your protein intake is steadier.", "body.weight~nutrition.protein:*"],
    ["Work stress has been high and your sleep quality slipped with it.", "life.stress~sleep.quality:*"],
    ["A busy schedule this month lined up with a dip in your protein intake.", "life.schedule~nutrition.protein:*"],
    ["Your easy pace has drifted quicker on the weeks your sleep is long.", "endurance.pace~sleep.quality:*"],
    ["Missed sessions cluster on the weeks your work hours run long.", "life.schedule~training.consistency:*"],
    ["Your strength gains stalled while your calorie intake sat low.", "nutrition.calories~training.strength:*"],
    ["Alcohol on weeknights shows up in your sleep quality the next morning.", "nutrition.alcohol~sleep.quality:*"],
    ["Your knee pain settles on the weeks your body weight trends down.", "body.weight~recovery.joint_pain:*"],
  ];
  for (const [text, want] of genuine) {
    assert.equal(deriveInsightIntentKey(text, null), want, `should still derive from: ${text}`);
  }
});

// A guard against quietly reintroducing any of them: these bare words each have a
// second meaning that fires on the wrong sentence. They may appear INSIDE a
// multi-word surface ("body weight", "work stress"), never as a surface of their own.
test("no facet claims a bare word with a known second meaning", () => {
  const banned = new Set([
    "weight",
    "schedule",
    "stress",
    "pace",
    "strength",
    "consistency",
    "showing up",
    "tweak",
    "drinking",
    "drinks",
  ]);
  for (const f of INSIGHT_FACETS) {
    for (const s of f.surfaces) {
      assert.equal(banned.has(s), false, `${f.facet} must not claim the bare surface "${s}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// the vocabulary + what the model is told
// ---------------------------------------------------------------------------

test("the facet vocabulary is well-formed: unique, domain-prefixed, and spread across domains", () => {
  const seen = new Set();
  for (const f of INSIGHT_FACETS) {
    assert.equal(seen.has(f.facet), false, `${f.facet} appears twice`);
    seen.add(f.facet);
    assert.match(f.facet, /^[a-z_]+\.[a-z_]+$/, `${f.facet} must be <domain>.<name>`);
    assert.equal(f.facet.split(".")[0], f.domain, `${f.facet} must be prefixed with its own domain`);
    assert.ok(f.label && f.label.length <= 40, `${f.facet} needs a short athlete-facing label`);
    assert.ok(f.surfaces.length > 0, `${f.facet} needs at least one surface form`);
  }
  const domains = new Set(INSIGHT_FACETS.map((f) => f.domain));
  for (const d of ["training", "endurance", "nutrition", "sleep", "recovery", "labs", "body", "life"]) {
    assert.ok(domains.has(d), `the vocabulary must cover ${d}`);
  }
});

test("covered territory reaches the prompt as a plain pair, not as a sentence to reword", () => {
  assert.equal(describeInsightIntentKey(`${PROTEIN_SLEEP}:same`), "protein intake ~ sleep quality (together)");
  assert.equal(
    describeInsightIntentKey("endurance.mileage~recovery.resting_hr:opposite"),
    "running mileage ~ resting heart rate (opposite)"
  );
  assert.equal(
    describeInsightIntentKey("endurance.mileage~recovery.resting_hr:*"),
    "running mileage ~ resting heart rate (either way)"
  );
  assert.equal(describeInsightIntentKey("nonsense"), null);

  const prompt = buildInsightPrompt(undefined, ["A quiet week is a fine week."], [], [`${PROTEIN_SLEEP}:same`]);
  assert.match(prompt, /ALREADY COVERED/);
  assert.match(prompt, /protein intake ~ sleep quality \(together\)/);
  assert.match(prompt, /A quiet week is a fine week\./, "unkeyable rows are still listed verbatim");
  assert.match(prompt, /nutrition\.protein/, "the closed vocabulary is printed for the model");
  assert.match(prompt, /"connection"/, "the JSON contract asks for the connection object");
});

// The corpus is deliberately whole — the dedupe guards and the cache key need every
// key in the 90-day window, up to a couple hundred rows. The PROMPT is not: pasting
// all of it in is a payload the model reads as noise. buildInsightPrompt is the one
// choke point that cuts both lists.
test("a chatty 90 days is capped before it reaches the prompt", () => {
  for (let i = 0; i < 50; i++) {
    repo.addInsight({ kind: "connection", text: `Unkeyable observation number ${i}, a quiet week is a fine week.` });
  }
  // 30 distinct cross-domain facet pairs, drawn straight from the closed vocabulary.
  const pairs = [];
  for (let i = 0; i < INSIGHT_FACETS.length && pairs.length < 30; i++) {
    for (let j = i + 1; j < INSIGHT_FACETS.length && pairs.length < 30; j++) {
      if (INSIGHT_FACETS[i].domain === INSIGHT_FACETS[j].domain) continue;
      pairs.push([INSIGHT_FACETS[i].facet, INSIGHT_FACETS[j].facet].sort().join("~") + ":same");
    }
  }
  assert.equal(pairs.length, 30, "the fixture needs 30 distinct keys to be worth asserting on");
  for (const key of pairs) repo.addInsight({ kind: "connection", text: `Keyed row for ${key}.`, intent_key: key });

  const corpus = insightIntentCorpus();
  assert.equal(corpus.keys.length, 30, "the corpus itself stays whole — the guards need all of it");
  assert.equal(corpus.unkeyedTexts.length, 50);

  const prompt = buildInsightPrompt(undefined, corpus.unkeyedTexts, [], corpus.keys);
  const listed = (block) => {
    const body = prompt.split(block)[1]?.split("\n\n")[0] ?? "";
    return body.split("\n").filter((line) => line.startsWith("  - ")).length;
  };
  assert.ok(listed("ALREADY SAID") <= 12, `raw texts capped at 12, got ${listed("ALREADY SAID")}`);
  assert.ok(listed("ALREADY COVERED") <= 20, `territory lines capped at 20, got ${listed("ALREADY COVERED")}`);
  assert.equal(listed("ALREADY SAID"), 12, "and it does fill the cap when there is that much to say");
  assert.equal(listed("ALREADY COVERED"), 20);
  // Newest first: the corpus arrives id-DESC, so the cut drops the OLDEST rows.
  assert.match(prompt, /Unkeyable observation number 49/, "the newest unkeyed row survives the cut");
  assert.doesNotMatch(prompt, /Unkeyable observation number 0,/, "the oldest does not");
});
