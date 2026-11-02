// Build levers — a finished race's lessons that change the NEXT race build, bounded,
// server-checked, announced and undoable (src/repo/build-levers.ts).
//
// What these lock down:
//   • validation: every key's hard range in BOTH directions; the two km caps rise only
//     with evidence from the race just run; unknown keys, duplicates, a missing or
//     ungrammatical reason are rejected with a plain reason, never silently kept.
//   • adoption: ONE announce-tier, reversible decision per review (idempotent), one
//     active row per key (an older one superseded), and the server-owned Undo puts the
//     levers back and restores what they replaced.
//   • resolution: as of a date, and distance-scoped for the km caps.
//   • the engine: with no levers every output is byte-identical; with a lever the race
//     ladder AND the weekly plan move the same way, because both read one resolved set.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  activeBuildLevers,
  adoptBuildLevers,
  BUILD_LEVER_BOUNDS,
  buildLeversForRace,
  ENGINE_BUILD_LEVERS,
  raceDistanceClass,
  capForRace,
  rampLeversForRace,
  validateBuildLevers,
} from "../dist/repo/build-levers.js";
import {
  isRampDownWeekOn,
  peakLongKm,
  peakWeeklyKm,
  raceRamp,
  SUSTAINABLE_LONG_STEP_FACTOR,
  SUSTAINABLE_WEEKLY_BUILD_FACTOR,
} from "../dist/repo/run-ramp.js";
import { projectRaceBuildWeeks, raceBuild } from "../dist/repo/race-build.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";

const HALF = 21.1;
const RACE = "2026-11-01"; // a Sunday; race week's Monday is 2026-10-26

const halfFacts = (over = {}) => ({
  race_date: "2026-10-04",
  race_distance_km: HALF,
  held_week_km: 41,
  best_week_km: 44,
  harmed_weeks: 0,
  longest_run_km: 18,
  longest_run_clean: true,
  recovery_days: 4,
  expected_recovery_days: 4,
  ...over,
});

const one = (key, value, because = "The last build said so in plain words.") => [{ key, value, because }];
const accept1 = (proposals, facts = halfFacts()) => {
  const out = validateBuildLevers(proposals, facts);
  assert.equal(out.accepted.length, 1, `expected one accepted lever, got ${JSON.stringify(out)}`);
  return out.accepted[0];
};
const reject1 = (proposals, facts = halfFacts()) => {
  const out = validateBuildLevers(proposals, facts);
  assert.equal(out.accepted.length, 0, `expected no accepted lever, got ${JSON.stringify(out)}`);
  assert.equal(out.rejected.length, 1);
  assert.ok(out.rejected[0].reason.length > 10, "a rejection says why in words");
  return out.rejected[0];
};

const daysBefore = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);

function seedReview({ id, title = "Riverside Half", distance = HALF, date = "2026-10-04" } = {}) {
  db.prepare(
    `INSERT INTO goal_reviews (id, kind, ref_key, title, achieved_on, facts_json, status)
     VALUES (?, 'race', ?, ?, ?, ?, 'ready')`
  ).run(
    id,
    `${date}|${distance}`,
    title,
    date,
    JSON.stringify(halfFacts({ race_date: date, race_distance_km: distance }))
  );
  return id;
}

const leverRows = () => db.prepare(`SELECT * FROM build_levers ORDER BY id`).all();

beforeEach(() => {
  for (const t of ["build_levers", "brain_rollbacks", "brain_expectations", "brain_decisions", "goal_reviews"]) {
    try {
      db.exec(`DELETE FROM ${t}`);
    } catch {
      /* absent table */
    }
  }
});

// ── validation ──────────────────────────────────────────────────────────────

test("the factor and count levers live inside the engine's own range, clamped both ways", () => {
  assert.deepEqual(accept1(one("build_step", 1.2)), {
    key: "build_step",
    value: SUSTAINABLE_WEEKLY_BUILD_FACTOR,
    because: "The last build said so in plain words.",
    clamped_from: 1.2,
  });
  assert.equal(accept1(one("build_step", 1.0)).value, BUILD_LEVER_BOUNDS.build_step.min);
  const kept = accept1(one("build_step", 1.08));
  assert.equal(kept.value, 1.08);
  assert.equal(kept.clamped_from, undefined, "an in-range lever is not a clamp");

  assert.equal(accept1(one("long_step", 1.2)).value, SUSTAINABLE_LONG_STEP_FACTOR);
  assert.equal(accept1(one("long_step", 1.0)).value, 1.08);

  const taper = accept1(one("taper_weeks", 2.1));
  assert.equal(taper.value, 2);
  assert.equal(taper.clamped_from, 2.1);
  assert.equal(accept1(one("taper_weeks", 0.95)).value, 1);
  assert.equal(accept1(one("taper_weeks", 1.6)).value, 2, "a count is a whole number of weeks");

  assert.equal(accept1(one("down_week_every", 4.3)).value, 4, "never fewer resets than the engine");
  assert.equal(accept1(one("down_week_every", 2.8)).value, 3);
});

test("a number FAR outside a key's range is set aside, never clamped into the tightest setting", () => {
  // More than BUILD_LEVER_CLAMP_MARGIN past a bound is not a near miss.
  assert.match(reject1(one("long_step", 1.3)).reason, /far outside/);
  assert.match(reject1(one("taper_weeks", 3)).reason, /far outside/);
  assert.match(reject1(one("down_week_every", 2)).reason, /far outside/);
  assert.match(reject1(one("down_week_every", 6)).reason, /far outside/);
  assert.match(reject1(one("long_run_ceiling_km", 5)).reason, /far outside/);
  assert.match(reject1(one("long_run_ceiling_km", 25)).reason, /far outside/);
  assert.match(reject1(one("peak_week_cap_km", 10)).reason, /far outside/);
  assert.match(reject1(one("peak_week_cap_km", 60)).reason, /far outside/);
  // A missing number is not 0: null, "", false, [] and 0 itself never reach the bounds.
  for (const value of [null, "", "  ", false, true, [], [2], {}, 0, -1, Number.NaN, "two"]) {
    assert.match(reject1(one("long_run_ceiling_km", value)).reason, /real number/, JSON.stringify(value));
  }
  assert.equal(accept1(one("taper_weeks", "2")).value, 2, "a numeric string is read as its number");
});

test("the long-run ceiling goes down freely, and up only on a long run taken well", () => {
  const engine = peakLongKm(HALF); // 17.9
  assert.equal(accept1(one("long_run_ceiling_km", 15)).value, 15);
  const floor = accept1(one("long_run_ceiling_km", 10));
  assert.equal(floor.value, Math.round(engine * 0.6 * 10) / 10);
  assert.equal(floor.clamped_from, 10);

  // Up: longest clean 18 km → at most 19.8 km (1.1×), and never past the race.
  assert.equal(accept1(one("long_run_ceiling_km", 19)).value, 19);
  const clamped = accept1(one("long_run_ceiling_km", 21));
  assert.equal(clamped.value, 19.8);
  assert.equal(clamped.clamped_from, 21);
  assert.equal(accept1(one("long_run_ceiling_km", 23), halfFacts({ longest_run_km: 30 })).value, HALF);

  assert.match(reject1(one("long_run_ceiling_km", 19), halfFacts({ longest_run_clean: false })).reason, /taken well/);
  assert.match(reject1(one("long_run_ceiling_km", 19), halfFacts({ longest_run_km: null })).reason, /taken well/);
  assert.match(
    reject1(one("long_run_ceiling_km", 19), halfFacts({ longest_run_km: 16 })).reason,
    /nothing to raise/,
    "a longest run under the engine's own long peak earns no raise"
  );
});

test("the peak-week cap goes down freely, and up only on a week that held with little harm", () => {
  const demand = peakWeeklyKm(HALF); // 42.2
  assert.equal(accept1(one("peak_week_cap_km", 36)).value, 36);
  assert.equal(accept1(one("peak_week_cap_km", 28)).value, Math.round(demand * 0.7 * 10) / 10);

  assert.equal(accept1(one("peak_week_cap_km", 44)).value, 44, "held 41 km → up to 45 (1.1×, the clamp max)");
  assert.equal(accept1(one("peak_week_cap_km", 48)).value, 45, "never past the formula's clamp maximum");
  assert.equal(accept1(one("peak_week_cap_km", 46), halfFacts({ held_week_km: 39.5 })).value, 43.5);

  assert.match(reject1(one("peak_week_cap_km", 44), halfFacts({ harmed_weeks: 2 })).reason, /set aside/);
  assert.match(reject1(one("peak_week_cap_km", 44), halfFacts({ held_week_km: null })).reason, /held/);
  assert.match(reject1(one("peak_week_cap_km", 44), halfFacts({ held_week_km: 38 })).reason, /nothing to raise/);
  assert.equal(
    accept1(one("peak_week_cap_km", 36), halfFacts({ harmed_weeks: 3 })).value,
    36,
    "lowering needs no evidence"
  );
});

test("a short race has no km caps to learn", () => {
  const facts = halfFacts({ race_distance_km: 5 });
  reject1(one("long_run_ceiling_km", 8), facts);
  reject1(one("peak_week_cap_km", 20), facts);
  assert.equal(accept1(one("taper_weeks", 2), facts).value, 2, "the count levers still carry");
});

test("unknown keys, duplicates, missing numbers and reasons are rejected; the first proposal for a key wins", () => {
  const out = validateBuildLevers(
    [
      { key: "volume_multiplier", value: 2, because: "More." },
      { key: "taper_weeks", value: 2, because: "The legs came to the line flat." },
      { key: "taper_weeks", value: 1, because: "A second opinion." },
      { key: "down_week_every", value: "three", because: "Resets helped." },
      { key: "build_step", value: 1.08 },
      { key: "long_step", value: 1.1, because: "   " },
      "taper_weeks",
      null,
    ],
    halfFacts()
  );
  assert.deepEqual(
    out.accepted.map((a) => [a.key, a.value]),
    [["taper_weeks", 2]]
  );
  assert.deepEqual(
    out.rejected.map((r) => r.key),
    ["volume_multiplier", "taper_weeks", "down_week_every", "build_step", "long_step", "", ""]
  );

  // The first one is what is considered, even when it is the one that fails.
  const first = validateBuildLevers(
    [
      { key: "peak_week_cap_km", value: 44, because: "Room for more." },
      { key: "peak_week_cap_km", value: 36, because: "Or less." },
    ],
    halfFacts({ harmed_weeks: 2 })
  );
  assert.equal(first.accepted.length, 0);
  assert.equal(first.rejected.length, 2);

  assert.equal(validateBuildLevers("taper_weeks=2", halfFacts()).rejected.length, 1, "not a list");
  assert.equal(validateBuildLevers(null, halfFacts()).rejected.length, 0);
  assert.equal(
    validateBuildLevers({ levers: one("taper_weeks", 2) }, halfFacts()).accepted.length,
    1,
    "a {levers:[…]} envelope is read too"
  );
});

test("a reason has to read in the app's plain voice", () => {
  assert.ok(violatesReadingGrammar("Your build scored 80/100."));
  reject1(one("taper_weeks", 2, "Your build scored 80/100."));
  reject1(one("taper_weeks", 2, "You must taper for two weeks next time."));
  const long = accept1(one("taper_weeks", 2, `The legs  arrived\nflat. ${"Again and again. ".repeat(40)}`));
  assert.ok(long.because.length <= 241, "capped");
  assert.ok(!/\s{2}|\n/.test(long.because), "whitespace collapsed");
});

// ── adoption, supersede, Undo ───────────────────────────────────────────────

test("adopting a review's levers writes ONE announce-tier reversible decision and is idempotent", () => {
  const review = seedReview({ id: 7 });
  const { accepted } = validateBuildLevers(
    [
      { key: "taper_weeks", value: 2, because: "The legs came to the line flat after one taper week." },
      { key: "down_week_every", value: 3, because: "The fourth week kept arriving tired." },
    ],
    halfFacts()
  );
  const first = adoptBuildLevers(review, accepted, "2026-10-10");
  assert.equal(first.adopted, 2);
  assert.ok(first.decision_id > 0);

  const decisions = db.prepare(`SELECT * FROM brain_decisions WHERE source_ref_type = 'goal_review'`).all();
  assert.equal(decisions.length, 1);
  const d = decisions[0];
  assert.equal(d.kind, "training_structure");
  assert.equal(d.domain, "training");
  assert.equal(d.autonomy_tier, "announce");
  assert.equal(d.status, "applied");
  assert.equal(d.reversible, 1);
  assert.equal(d.source_ref_key, String(review));
  assert.match(d.summary, /Riverside Half/);
  assert.equal(violatesReadingGrammar(d.summary), null);
  const action = JSON.parse(d.action_json);
  assert.match(action.user_explanation, /two-week taper/);
  assert.match(action.user_explanation, /lifting/, "a longer taper says it lengthens the lifting trim too");
  assert.equal(JSON.parse(d.context_json).race_distance_km, HALF);
  const rollback = db.prepare(`SELECT kind FROM brain_rollbacks WHERE decision_id = ?`).get(d.id);
  assert.equal(rollback.kind, "build_levers");

  const rows = leverRows();
  assert.deepEqual(
    rows.map((r) => [r.key, r.value, r.status, r.decision_id, r.source_review_id, r.adopted_on]),
    [
      ["taper_weeks", 2, "active", d.id, review, "2026-10-10"],
      ["down_week_every", 3, "active", d.id, review, "2026-10-10"],
    ]
  );

  const again = adoptBuildLevers(review, accepted, "2026-10-11");
  assert.deepEqual(again, { decision_id: first.decision_id, adopted: 2 }, "the same review adopts once");
  assert.equal(leverRows().length, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 1);
});

test("nothing to adopt writes nothing", () => {
  seedReview({ id: 3 });
  assert.deepEqual(adoptBuildLevers(3, [], "2026-10-10"), { decision_id: null, adopted: 0 });
  assert.deepEqual(adoptBuildLevers(3, [{ key: "nonsense", value: 2, because: "x" }], "2026-10-10"), {
    decision_id: null,
    adopted: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("a newer review supersedes per key, and Undo puts the older lesson back", () => {
  seedReview({ id: 1, title: "Spring Half", date: "2026-04-12" });
  seedReview({ id: 2, title: "Riverside Half", date: "2026-10-04" });
  const older = adoptBuildLevers(
    1,
    [
      { key: "taper_weeks", value: 2, because: "Two easier weeks before the line suited the legs." },
      { key: "build_step", value: 1.08, because: "A gentler climb kept the build healthy." },
    ],
    "2026-04-20"
  );
  const newer = adoptBuildLevers(
    2,
    [{ key: "taper_weeks", value: 1, because: "One taper week was enough this time." }],
    "2026-10-10"
  );

  let resolved = activeBuildLevers("2026-10-12");
  assert.equal(resolved.taper_weeks, 1);
  assert.equal(resolved.build_step, 1.08, "an untouched key keeps the older lesson");
  assert.deepEqual(
    leverRows().map((r) => [r.key, r.status]),
    [
      ["taper_weeks", "superseded"],
      ["build_step", "active"],
      ["taper_weeks", "active"],
    ]
  );

  const undone = revertDecision(newer.decision_id, "user undo");
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(
    leverRows().map((r) => [r.key, r.status]),
    [
      ["taper_weeks", "active"],
      ["build_step", "active"],
      ["taper_weeks", "reverted"],
    ]
  );
  assert.ok(leverRows()[2].reverted_at, "the Undo is stamped");
  resolved = activeBuildLevers("2026-10-12");
  assert.equal(resolved.taper_weeks, 2, "the older lesson is back");
  assert.equal(db.prepare(`SELECT status FROM brain_decisions WHERE id = ?`).get(newer.decision_id).status, "reverted");

  // The older decision still owns its rows, so its Undo works too.
  assert.equal(revertDecision(older.decision_id, "user undo").ok, true);
  resolved = activeBuildLevers("2026-10-12");
  assert.equal(resolved.taper_weeks, ENGINE_BUILD_LEVERS.taper_weeks);
  assert.equal(resolved.build_step, SUSTAINABLE_WEEKLY_BUILD_FACTOR);
  assert.deepEqual(resolved.from_levers, []);
});

test("an older decision whose levers were all replaced refuses its Undo in plain words", () => {
  seedReview({ id: 1, date: "2026-04-12" });
  seedReview({ id: 2, date: "2026-10-04" });
  const older = adoptBuildLevers(1, one("taper_weeks", 2), "2026-04-20");
  adoptBuildLevers(2, one("taper_weeks", 1), "2026-10-10");
  const refused = revertDecision(older.decision_id, "user undo");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /later race/);
  assert.equal(activeBuildLevers("2026-10-12").taper_weeks, 1);
});

test("under review-everything nothing lands, and a later call under lead adopts as usual", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  try {
    seedReview({ id: 4 });
    assert.deepEqual(adoptBuildLevers(4, one("taper_weeks", 2), "2026-10-10"), { decision_id: null, adopted: 0 });
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0, "no dead-end ask is parked");
    assert.equal(leverRows().length, 0);
  } finally {
    repo.setSettings({ lead_mode: "lead" });
  }
  assert.equal(adoptBuildLevers(4, one("taper_weeks", 2), "2026-10-10").adopted, 1);
});

test("the Changes feed titles the adoption and offers its Undo", () => {
  seedReview({ id: 9, title: "Riverside Half" });
  const { decision_id } = adoptBuildLevers(9, one("taper_weeks", 2), "2026-10-10");
  const row = brainChangesRead({ asOf: "2026-10-12" })
    .days.flatMap((day) => day.changes)
    .find((c) => c.id === decision_id);
  assert.ok(row, "the adoption is a change the team made");
  assert.equal(row.state, "applied");
  assert.match(row.title, /next race build/);
  assert.equal(row.undo.available, true);
  assert.equal(row.undo.label, "Build the next race without these lessons");
});

// ── resolution ──────────────────────────────────────────────────────────────

test("resolution: engine constants with no lever, and a lever only from the day it was adopted", () => {
  assert.deepEqual(
    { ...activeBuildLevers("2026-10-12"), from_levers: undefined },
    { ...ENGINE_BUILD_LEVERS, from_levers: undefined }
  );
  assert.deepEqual(activeBuildLevers("2026-10-12").from_levers, []);
  assert.equal(rampLeversForRace(HALF, "2026-10-12"), null, "no lever hands the ramp nothing at all");

  seedReview({ id: 5 });
  adoptBuildLevers(5, one("down_week_every", 3, "The fourth week kept arriving tired."), "2026-10-10");
  assert.equal(activeBuildLevers("2026-10-09").down_week_every, 4, "not before it was adopted");
  const on = activeBuildLevers("2026-10-10");
  assert.equal(on.down_week_every, 3);
  assert.deepEqual(on.from_levers, [
    { key: "down_week_every", value: 3, because: "The fourth week kept arriving tired.", source_review_id: 5 },
  ]);
  assert.deepEqual(
    rampLeversForRace(10, "2026-10-12"),
    { down_week_every: 3 },
    "a count lever carries to any distance"
  );
});

test("a km cap applies only to a next race of the same distance class it was learned on", () => {
  assert.equal(raceDistanceClass(HALF), "half");
  assert.equal(raceDistanceClass(10), "10k");
  assert.equal(raceDistanceClass(42.2), "marathon");
  assert.equal(raceDistanceClass(5), "short");

  seedReview({ id: 6, distance: HALF });
  adoptBuildLevers(
    6,
    [
      { key: "long_run_ceiling_km", value: 15, because: "The 18 km long run cost more than it gave." },
      { key: "taper_weeks", value: 2, because: "Two easier weeks before the line suited the legs." },
    ],
    "2026-10-10"
  );
  const half = buildLeversForRace(21.0975, "2026-10-12");
  assert.equal(half.long_run_ceiling_km, 15);
  assert.deepEqual(
    half.from_levers.map((l) => l.key),
    ["long_run_ceiling_km", "taper_weeks"]
  );
  const tenK = buildLeversForRace(10, "2026-10-12");
  assert.equal(tenK.long_run_ceiling_km, peakLongKm(10), "a 10K builds to its own long run");
  assert.deepEqual(
    tenK.from_levers.map((l) => l.key),
    ["taper_weeks"]
  );
  assert.equal(buildLeversForRace(42.2, "2026-10-12").long_run_ceiling_km, peakLongKm(42.2));
});

// ── the engine ──────────────────────────────────────────────────────────────

const goal = (over = {}) => ({
  is_race: true,
  event: "Riverside Half",
  date: RACE,
  distance_km: HALF,
  target: "1:50",
  phase: "build",
  ...over,
});

const MONDAYS = Array.from({ length: 14 }, (_, i) => daysBefore("2026-10-26", 7 * i));

test("no levers is byte-identical: raceRamp, the reset cadence and the ladder", () => {
  for (const monday of MONDAYS) {
    for (const [anchor, long] of [
      [14, 9.1],
      [30, 14],
      [41, 18],
    ]) {
      const base = raceRamp(goal(), monday, anchor, long, null, { week_km: 36, long_km: 15 });
      assert.deepEqual(raceRamp(goal(), monday, anchor, long, null, { week_km: 36, long_km: 15 }, null), base);
      assert.deepEqual(raceRamp(goal(), monday, anchor, long, null, { week_km: 36, long_km: 15 }, {}), base);
    }
    assert.equal(isRampDownWeekOn(goal(), monday, {}), isRampDownWeekOn(goal(), monday));
  }
  const ladder = projectRaceBuildWeeks(goal(), "2026-08-05", 20, 10, null, null, { demonstratedLongKm: 12 });
  assert.deepEqual(
    projectRaceBuildWeeks(goal(), "2026-08-05", 20, 10, null, null, { demonstratedLongKm: 12, levers: {} }),
    ladder
  );
  assert.deepEqual(
    ladder.slice(-3).map((w) => w.kind),
    ["peak", "taper", "race"]
  );
});

test("a two-week taper moves the peak a week earlier on the ramp AND the ladder", () => {
  const levers = { taper_weeks: 2 };
  // 2026-10-12 is two calendar weeks before race week.
  const engine = raceRamp(goal(), "2026-10-12", 40, 18);
  const lever = raceRamp(goal(), "2026-10-12", 40, 18, null, null, levers);
  assert.equal(engine.taper_week, false, "the engine's peak week");
  assert.equal(lever.taper_week, true, "a taper week under the lesson");
  assert.equal(lever.required_km, 34, "0.85 of the peak it steps off");
  assert.ok(lever.required_long_km < engine.required_long_km);
  // The final taper week still lands at ~0.7 of the peak.
  const final = raceRamp(goal(), "2026-10-19", 34, 13.4, null, null, levers);
  assert.equal(final.required_km, 28);
  // The peak lands three calendar weeks out.
  const peak = raceRamp(goal(), "2026-10-05", 38, 17, null, null, levers);
  assert.equal(peak.taper_week, false);
  assert.equal(peak.ideal_required_km, peak.peak_target_km);

  const ladder = projectRaceBuildWeeks(goal(), "2026-08-05", 20, 10, null, null, { demonstratedLongKm: 12, levers });
  assert.deepEqual(
    ladder.slice(-4).map((w) => [w.week_start, w.kind]),
    [
      ["2026-10-05", "peak"],
      ["2026-10-12", "taper"],
      ["2026-10-19", "taper"],
      ["2026-10-26", "race"],
    ]
  );
});

test("a reset every third week moves the down weeks on the ramp AND the ladder", () => {
  const levers = { down_week_every: 3 };
  const downs = (lv) =>
    projectRaceBuildWeeks(goal(), "2026-07-27", 20, 10, null, null, { demonstratedLongKm: 12, levers: lv })
      .filter((w) => w.kind === "down")
      .map((w) => w.week_start);
  const engineDowns = downs(null);
  const leverDowns = downs(levers);
  assert.ok(engineDowns.length >= 1);
  assert.ok(leverDowns.length > engineDowns.length, `${leverDowns} vs ${engineDowns}`);
  for (const monday of leverDowns) assert.equal(isRampDownWeekOn(goal(), monday, levers), true, monday);
  for (const monday of engineDowns) assert.equal(isRampDownWeekOn(goal(), monday), true, monday);
});

test("a gentler build step slows the ramp's ask and its reachable peak", () => {
  const engine = raceRamp(goal(), "2026-08-03", 14, 9.1);
  const lever = raceRamp(goal(), "2026-08-03", 14, 9.1, null, null, { build_step: 1.08 });
  assert.equal(engine.required_km, 15.7);
  assert.equal(lever.required_km, 15.1, "14 × 1.08");
  assert.ok(lever.constrained_peak_km < engine.constrained_peak_km);
  const ladder = projectRaceBuildWeeks(goal(), "2026-08-03", 14, 9.1, null, null, { levers: { build_step: 1.08 } });
  for (let i = 1; i < ladder.length; i++) {
    const [prev, cur] = [ladder[i - 1], ladder[i]];
    if (cur.kind === "build" && prev.kind === "build")
      assert.ok(cur.km <= prev.km * 1.08 + 0.1, `${cur.week_start}: ${cur.km} after ${prev.km}`);
  }
});

test("a lowered long-run ceiling holds every long run of the ramp and the ladder", () => {
  const levers = { long_run_ceiling_km: 15 };
  const ladder = projectRaceBuildWeeks(goal(), "2026-07-27", 30, 14, null, null, { demonstratedLongKm: 16, levers });
  assert.ok(ladder.length > 5);
  for (const w of ladder) assert.ok(w.long_km <= 15, `${w.week_start}: ${w.long_km}`);
  const engine = projectRaceBuildWeeks(goal(), "2026-07-27", 30, 14, null, null, { demonstratedLongKm: 16 });
  assert.ok(Math.max(...engine.map((w) => w.long_km)) > 15, "the engine alone would go past it");
  assert.equal(raceRamp(goal(), "2026-09-28", 36, 16, null, { long_km: 16 }, levers).peak_long_km, 15);
});

// ── the week and the ladder read ONE set from the database ──────────────────

function seedRunner() {
  // Six weeks of Tue / Thu / Sat running before Sunday 2026-09-13.
  for (let wk = 0; wk < 6; wk++) {
    const sunday = daysBefore("2026-09-13", wk * 7);
    repo.addActivity({ type: "run", duration_min: 48, distance_km: 8, date: daysBefore(sunday, 5) });
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7.5, date: daysBefore(sunday, 3) });
    repo.addActivity({ type: "run", duration_min: 84, distance_km: 13, date: daysBefore(sunday, 1) });
  }
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: HALF, target: "1:50" },
  });
}

const planOpts = (monday, over = {}) => ({
  goal: { ...goal(), mode: "race", weeks_to_race: 5, weekly_km: null, weekly_sessions: null },
  compliance: { actual_km: 30, prescribed_km: 30 },
  volumeAnchorDate: daysBefore(monday, 1),
  programState: {
    endurance: { sport: "run", longest_km_4wk: 14, has_quality: false, status: "building" },
    mesocycle: { phase: "accumulation" },
    recovery_week: { state: "none" },
  },
  recovery: {},
  block: { week_index: 1 },
  zones: { available: false, zones: [] },
  directives: [],
  responseModifier: null,
  trainingIntent: { endurance_role: "primary", source: "explicit" },
  adjustToday: false,
  ...over,
});

test("adopted levers move raceBuild's ladder and weeklyRunPlan together, and the build says why", () => {
  seedRunner();
  const before = raceBuild("2026-09-13");
  assert.deepEqual(before.levers, []);
  assert.doesNotMatch(before.why, /taper/);

  seedReview({ id: 11, title: "Spring Half", date: "2026-04-12" });
  adoptBuildLevers(
    11,
    [
      { key: "taper_weeks", value: 2, because: "Two easier weeks before the line suited the legs." },
      { key: "down_week_every", value: 3, because: "The fourth week kept arriving tired." },
    ],
    "2026-09-01"
  );
  const after = raceBuild("2026-09-13");
  assert.deepEqual(
    after.levers.map((l) => [l.key, l.value]),
    [
      ["taper_weeks", 2],
      ["down_week_every", 3],
    ]
  );
  assert.match(after.why, /two-week taper/);
  assert.match(after.why, /lighter week every third week/);
  assert.match(after.why, /Spring Half/);
  assert.equal(violatesReadingGrammar(after.why), null);
  const kinds = Object.fromEntries(after.weeks.map((w) => [w.week_start, w.kind]));
  assert.equal(kinds["2026-10-05"], "peak");
  assert.equal(kinds["2026-10-12"], "taper");
  assert.equal(kinds["2026-10-19"], "taper");

  // The week reads the same lessons: the ladder's second taper week is a taper week in
  // the plan, and the ladder's reset weeks are the plan's scheduled down weeks.
  const taperWeek = repo.weeklyRunPlan("2026-10-12", planOpts("2026-10-12"));
  assert.ok(
    taperWeek.rationale.some((l) => /Two weeks out/.test(l)),
    taperWeek.rationale.join(" | ")
  );
  for (const w of after.weeks.filter((x) => x.kind === "down")) {
    const plan = repo.weeklyRunPlan(w.week_start, planOpts(w.week_start));
    assert.ok(
      plan.rationale.some((l) => /Scheduled down week/.test(l)),
      `${w.week_start}: ${plan.rationale.join(" | ")}`
    );
  }
  for (const w of after.weeks.filter((x) => x.kind === "build")) {
    const plan = repo.weeklyRunPlan(w.week_start, planOpts(w.week_start));
    assert.ok(!plan.rationale.some((l) => /Scheduled down week/.test(l)), w.week_start);
  }
});

test("a gentler build step and a long-run ceiling reach the weekly plan", () => {
  seedRunner();
  const monday = "2026-09-07"; // an ordinary build week, eight weeks out
  const engine = repo.weeklyRunPlan(monday, planOpts(monday));
  seedReview({ id: 12, date: "2026-04-12" });
  adoptBuildLevers(
    12,
    [
      { key: "build_step", value: 1.05, because: "A gentler climb kept the last build healthy." },
      { key: "long_run_ceiling_km", value: 12, because: "The longest runs cost more than they gave." },
    ],
    "2026-09-01"
  );
  const lever = repo.weeklyRunPlan(monday, planOpts(monday));
  const total = (p) => p.runs.reduce((s, r) => s + (Number(r.target_distance_km) || 0), 0);
  const longOf = (p) => Number(p.runs.find((r) => r.kind_label === "long")?.target_distance_km ?? 0);
  assert.ok(total(lever) < total(engine), `${total(lever)} vs ${total(engine)}`);
  assert.ok(total(lever) <= 30 * 1.05 + 0.5, `the week climbs at most 5%: ${total(lever)}`);
  assert.ok(longOf(lever) <= 12, `the long run holds the ceiling: ${longOf(lever)}`);
  assert.ok(
    lever.rationale.some((l) => /Building gently/.test(l)),
    lever.rationale.join(" | ")
  );
});

// ── review fixes (2026-11-02) ───────────────────────────────────────────────

test("a learned acceleration never lifts the week past a gentler learned build step", () => {
  seedRunner();
  const monday = "2026-09-07";
  const accelerate = {
    key: "training_target:run_volume_adherence:all:complete:all-phases",
    target: "run_volume_step",
    stage: null,
    scale: 1.05,
    bounds: { min: 0.9, max: 1.05 },
    confidence: "observed",
    evidence_n: 3,
    rationale: "a slightly larger run volume step is the earned default",
    never_overrides: ["injury", "allergy", "clinical", "lean_safe"],
  };
  seedReview({ id: 21, date: "2026-04-12" });
  adoptBuildLevers(21, one("build_step", 1.05, "A gentler climb kept the last build healthy."), "2026-09-01");
  const plan = repo.weeklyRunPlan(monday, planOpts(monday, { responseModifier: accelerate }));
  const total = plan.runs.reduce((s, r) => s + (Number(r.target_distance_km) || 0), 0);
  assert.ok(total <= 30 * 1.05 + 0.5, `the week stays at the learned step: ${total}`);
  assert.ok(!plan.rationale.some((l) => /Nudging the weekly build up/.test(l)), plan.rationale.join(" | "));
});

test("a lowered km cap stays a lowering on another race of the same class, and a raise never grows", () => {
  // 14 km learned on a 25 km race (engine long peak 20): a lesson to go SHORTER.
  const lowered = capForRace("long_run_ceiling_km", 14, 25, 15);
  assert.ok(lowered < peakLongKm(15), `still under a 15 km race's own long peak: ${lowered}`);
  assert.equal(lowered, Math.round(0.7 * peakLongKm(15) * 10) / 10);
  // Never under the floor share either.
  assert.equal(capForRace("long_run_ceiling_km", 12, 25, 15), Math.round(0.6 * peakLongKm(15) * 10) / 10);
  // A raise of 19.8 learned on a half: on the same half it stands…
  assert.equal(capForRace("long_run_ceiling_km", 19.8, 21.1, 21.0975), 19.8);
  // …on a 25 km race it would not clear that race's own 20 km, so it does not apply.
  assert.equal(capForRace("long_run_ceiling_km", 19.8, 21.1, 25), null);
  // A peak-week raise never carries past the km validated.
  assert.ok(capForRace("peak_week_cap_km", 44, 21.1, 28) <= 44);

  seedReview({ id: 22, distance: 25, date: "2026-04-12" });
  adoptBuildLevers(22, one("long_run_ceiling_km", 14, "The 20 km long runs cost more than they gave."), "2026-04-20");
  const next = buildLeversForRace(15, "2026-09-07");
  assert.ok(next.long_run_ceiling_km < peakLongKm(15));
  assert.deepEqual(rampLeversForRace(15, "2026-09-07"), { long_run_ceiling_km: lowered });
});

test("Undo A, then Undo B: A's replaced row stays undone", () => {
  seedReview({ id: 23, date: "2026-04-12" });
  seedReview({ id: 24, date: "2026-10-04" });
  const a = adoptBuildLevers(
    23,
    [
      { key: "build_step", value: 1.08, because: "A gentler climb kept the build healthy." },
      { key: "taper_weeks", value: 2, because: "Two easier weeks before the line suited the legs." },
    ],
    "2026-04-20"
  );
  const b = adoptBuildLevers(
    24,
    one("build_step", 1.06, "An even gentler climb suited the second build."),
    "2026-10-10"
  );
  assert.equal(revertDecision(a.decision_id, "user undo").ok, true);
  assert.equal(revertDecision(b.decision_id, "user undo").ok, true);
  assert.ok(
    leverRows().every((r) => r.status === "reverted"),
    JSON.stringify(leverRows().map((r) => [r.key, r.status]))
  );
  const resolved = activeBuildLevers("2026-10-12");
  assert.equal(resolved.build_step, SUSTAINABLE_WEEKLY_BUILD_FACTOR);
  assert.deepEqual(resolved.from_levers, []);
  assert.deepEqual(activeBuildLevers("2026-06-01").from_levers, [], "and not in the past either");
});

test("resolution is truly as-of: a newer review never rewrites how a past week resolves", () => {
  seedReview({ id: 25, date: "2026-04-12" });
  seedReview({ id: 26, date: "2026-10-04" });
  adoptBuildLevers(25, one("taper_weeks", 2, "Two easier weeks before the line suited the legs."), "2026-04-20");
  assert.equal(activeBuildLevers("2026-06-01").taper_weeks, 2);
  adoptBuildLevers(26, one("taper_weeks", 1, "One taper week was enough this time."), "2026-10-10");
  assert.equal(activeBuildLevers("2026-06-01").taper_weeks, 2, "the spring build still reads its own lesson");
  assert.equal(activeBuildLevers("2026-10-12").taper_weeks, 1);
  assert.equal(activeBuildLevers("2026-04-19").taper_weeks, 1, "nothing before the first adoption");
});

test("with a two-week taper the ladder and the week print the same long run two weeks out", () => {
  const levers = { taper_weeks: 2 };
  const ramp = raceRamp(goal(), "2026-10-12", 30, 14, null, null, levers);
  assert.equal(ramp.required_long_km, 8.4, "min(0.6 × the long peak, 0.6 × the long run before it)");
  seedRunner();
  seedReview({ id: 27, date: "2026-04-12" });
  adoptBuildLevers(27, one("taper_weeks", 2, "Two easier weeks before the line suited the legs."), "2026-09-01");
  const plan = repo.weeklyRunPlan("2026-10-12", planOpts("2026-10-12"));
  const long = Number(plan.runs.find((r) => r.kind_label === "long")?.target_distance_km);
  assert.equal(long, ramp.required_long_km, plan.rationale.join(" | "));
});
