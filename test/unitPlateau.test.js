// The plateau ladder (src/repo/unit-plateau.ts): for every movement unit on the plan, ONE
// deterministic next lever. Invariants:
//   1. order: wait → rep_scheme → set_quality → volume → variation, each once per plateau;
//   2. every wait reason: climbing (none), not enough, slipping, cut, run build, recovery,
//      too young, a fresh prescription, pain, a timed lift;
//   3. rep_scheme is spent by a move whose range still stands, or by a no inside the plateau;
//   4. a slipping unit never gets volume or variation;
//   5. variation only at a block boundary, once per block; an anchor is reported, never
//      excluded from the read;
//   6. read-only: the ladder writes nothing.
// State is built from REAL rows through the repo's writers. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  PLATEAU_MIN_SESSIONS,
  PLATEAU_MIN_WEEKS,
  plateauRunOf,
  setsEndWellShortOfFailure,
  unitLadderRung,
  unitPlateauForCoach,
  unitPlateauLadder,
  UNIT_PLATEAU_AGENT,
} from "../dist/repo/unit-plateau.js";
import { COMPOUND_REP_RANGE_CEILING, movedRepRangeFor, repRangeMoveSpent } from "../dist/repo/lift-response.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { capabilityRead } from "../dist/repo/strength-capability.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

// A raw fixture write, then the cache bump every repo writer does (plan and lift reads are memoized on it).
function sql(statement, ...args) {
  db.prepare(statement).run(...args);
  bumpTrainingDataVersion();
}

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);
const WEEKS = [56, 49, 42, 35, 28, 21, 14, 7, 1];

function plan({ pushdown = { rep_low: 10, rep_high: 12 }, bench = { rep_low: 6, rep_high: 8 } } = {}) {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 3, ...bench, target_weight: 135 },
        { exercise: "Rope Pushdown", muscle_group: "triceps", sets: 3, ...pushdown, target_weight: 50 },
      ],
    },
  ]);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-200));
}

// One session of `exercise`: one set per entry of `reps` at `weight`.
function session(exercise, daysAgo, weight, reps, rir = null) {
  for (const r of reps)
    repo.logSetByName({ exercise, weight, reps: r, date: day(-daysAgo), ...(rir == null ? {} : { rir }) });
}

// A pushdown stuck at 50 for 12, 11, 10 every week; a bench stuck at 135 for 8, 7, 6.
function stuck({ days = WEEKS, rir = null, benchToo = true } = {}) {
  repo.upsertExercise({ name: "Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  for (const d of days) {
    session("Rope Pushdown", d, 50, [12, 11, 10], rir);
    if (benchToo) session("Barbell Bench Press", d, 135, [8, 7, 6]);
  }
}

const rungOf = (ladder, key) => ladder.units.find((u) => u.unit_key === key);

function fakeUnit(over = {}) {
  return {
    key: "triceps:pushdown",
    label: "Pushdown",
    kind: "region",
    compound: false,
    in_plan: true,
    verdict: "holding",
    qualifiers: [],
    hard_sets_trend: "steady",
    line: "",
    contributors: [],
    ...over,
  };
}
const fakeLift = {
  exercise: "Rope Pushdown",
  day_number: 1,
  plan_item_id: 1,
  muscle_group: "triceps",
  sets: 3,
  rep_low: 10,
  rep_high: 12,
  target_weight: 50,
  mode: "reps",
  constraint_note: null,
};
const fakeCtx = (over = {}) => ({
  date: today(),
  capability: { available: true, date: today(), overall: null, units: [], muscles: [] },
  block: null,
  rows: [],
  touches: () => false,
  ...over,
});

function snapshot() {
  const count = (sql) => db.prepare(sql).get().n;
  return JSON.stringify({
    plan: repo.getPlan(),
    proposals: count(`SELECT COUNT(*) AS n FROM plan_proposals`),
    decisions: count(`SELECT COUNT(*) AS n FROM brain_decisions`),
  });
}

// ---- 1. the first lever ------------------------------------------------------------

test("a unit held at one load and one rep count for weeks gets a higher rep range at the held load", () => {
  plan();
  stuck();
  const cap = capabilityRead(today());
  assert.equal(cap.units.find((u) => u.key === "triceps:pushdown")?.verdict, "holding", "precondition: holding");
  const before = snapshot();
  const ladder = unitPlateauLadder(today());
  assert.equal(ladder.available, true);
  const pushdown = rungOf(ladder, "triceps:pushdown");
  assert.equal(pushdown.lever, "rep_scheme", JSON.stringify(pushdown));
  assert.deepEqual(pushdown.rep_range, { rep_low: 13, rep_high: 15 });
  assert.equal(pushdown.since, day(-56), "the plateau began with the first session at this load and rep count");
  assert.equal(pushdown.plan_lift.exercise, "Rope Pushdown");
  assert.equal(violatesReadingGrammar(pushdown.reason), null, pushdown.reason);
  assert.doesNotMatch(pushdown.reason, /\d|score/i);
  const bench = rungOf(ladder, "horizontal-push:flat");
  assert.equal(bench.lever, "rep_scheme", "a compound takes the same first lever");
  assert.deepEqual(bench.rep_range, { rep_low: 9, rep_high: 11 });
  assert.equal(snapshot(), before, "the ladder writes nothing");
  assert.ok(
    unitPlateauForCoach(today()).some((u) => u.lever === "rep_scheme"),
    "the coach read names it"
  );
});

test("a compound's rep-range move stops at its ceiling; an isolation lift's goes higher", () => {
  assert.equal(movedRepRangeFor(10, 12, { compound: true }).rep_high, 15);
  assert.equal(movedRepRangeFor(12, 15, { compound: true }), null, `never past ${COMPOUND_REP_RANGE_CEILING}`);
  assert.deepEqual(movedRepRangeFor(12, 15, { compound: false }), { rep_low: 15, rep_high: 18 });
});

// ---- 2. every wait ------------------------------------------------------------------

test("an explained or unreadable unit waits: climbing, not enough, slipping, cut, run build, recovery", () => {
  const cases = [
    [{ verdict: "climbing" }, "none", "climbing"],
    [{ verdict: "not_enough" }, "wait", "not_enough"],
    [{ verdict: "slipping" }, "wait", "slipping"],
    [{ verdict: "slipping", qualifiers: ["cut"] }, "wait", "slipping"],
    [{ qualifiers: ["cut"] }, "wait", "cut"],
    [{ qualifiers: ["run_build"] }, "wait", "run_build"],
    [{ qualifiers: ["recovery"] }, "wait", "recovery"],
    [{ qualifiers: ["cut", "recovery"] }, "wait", "recovery"],
  ];
  for (const [over, lever, code] of cases) {
    const rung = unitLadderRung(fakeUnit(over), fakeLift, fakeCtx());
    assert.equal(rung.lever, lever, JSON.stringify(over));
    assert.equal(rung.code, code, JSON.stringify(over));
    assert.equal(violatesReadingGrammar(rung.reason), null, rung.reason);
  }
});

test("a slipping unit never gets volume or variation, even at a block boundary with nothing else left", () => {
  plan();
  stuck();
  const block = { id: 1, week_index: 1, boundary: true };
  const rung = unitLadderRung(fakeUnit({ verdict: "slipping" }), fakeLift, fakeCtx({ block }));
  assert.equal(rung.lever, "wait");
  assert.match(rung.reason, /recovery|fuel|training load/);
});

test("pain on the lift and a timed lift wait", () => {
  assert.equal(unitLadderRung(fakeUnit(), fakeLift, fakeCtx({ touches: () => true })).code, "pain");
  assert.equal(unitLadderRung(fakeUnit(), { ...fakeLift, mode: "timed" }, fakeCtx()).code, "timed");
});

test("a plateau younger than the minimum waits (too young)", () => {
  plan();
  repo.upsertExercise({ name: "Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  // Five weeks climbing, then two weeks flat: a run of two sessions over two weeks.
  [
    [56, 40],
    [49, 42.5],
    [42, 45],
    [35, 47.5],
    [28, 47.5],
    [14, 50],
    [7, 50],
    [1, 50],
  ].forEach(([d, w], i) => session("Rope Pushdown", d, w, i >= 5 ? [12, 11, 10] : [12, 12, 12]));
  const run = plateauRunOf(
    [
      { session_id: 1, date: day(-14), working: 50, top_reps: 12, sets: [] },
      { session_id: 2, date: day(-7), working: 50, top_reps: 12, sets: [] },
    ],
    today()
  );
  assert.ok(run.sessions.length < PLATEAU_MIN_SESSIONS && run.weeks < PLATEAU_MIN_WEEKS);
  const rung = unitLadderRung(fakeUnit(), { ...fakeLift, plan_item_id: repo.getPlan()[0].items[1].id }, fakeCtx());
  assert.equal(rung.code, "too_young", JSON.stringify(rung));
});

test("reps climbing at one load are not a plateau: the run restarts when the reps move", () => {
  const sessions = [10, 11, 12].map((reps, i) => ({
    session_id: i + 1,
    date: day(-21 + 7 * i),
    working: 50,
    top_reps: reps,
    sets: [],
  }));
  const run = plateauRunOf(sessions, today());
  assert.equal(run.sessions.length, 2, "ten, then eleven and twelve: only the last two sit within a rep");
});

test("a prescription written inside the settle window waits for it to settle", () => {
  plan();
  stuck();
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-3));
  assert.equal(rungOf(unitPlateauLadder(today()), "triceps:pushdown").code, "fresh_prescription");
});

// ---- 3. once per plateau --------------------------------------------------------------

function seedAppliedRangeMove(exercise, repLow, repHigh, { daysAgo = 70, vetoed = false } = {}) {
  const parsed = {
    changes: [{ day_number: 1, exercise, rep_low: repLow, rep_high: repHigh, progression_escalation: "rep_range" }],
  };
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
              VALUES ('progression', 'x', '', ?, 'applied', datetime('now', ?))`)
    .run(JSON.stringify(parsed), `-${daysAgo} days`);
  if (vetoed)
    db.prepare(
      `INSERT INTO brain_decisions (kind, domain, summary, status, autonomy_tier, risk_class, source_ref_type, source_ref_key, created_at)
       VALUES ('plan_change', 'training', 'x', 'reverted', 'quiet_apply', 'low', 'plan_proposal', ?, datetime('now', ?))`
    ).run(String(info.lastInsertRowid), `-${daysAgo} days`);
  return Number(info.lastInsertRowid);
}

test("a rep-range move whose range still stands spends the lever; the ladder moves to effort when sets end easy", () => {
  plan();
  stuck({ rir: 3 });
  seedAppliedRangeMove("Rope Pushdown", 10, 12);
  assert.equal(repRangeMoveSpent("Rope Pushdown", 10, day(-56)), true);
  const run = plateauRunOf(
    [
      {
        session_id: 1,
        date: day(-7),
        working: 50,
        top_reps: 12,
        sets: [
          { weight: 50, reps: 12, rir: 3 },
          { weight: 50, reps: 11, rir: 3 },
          { weight: 50, reps: 10, rir: 4 },
          { weight: 50, reps: 10, rir: 1 },
        ],
      },
    ],
    today()
  );
  assert.equal(setsEndWellShortOfFailure(run), true);
  const rung = rungOf(unitPlateauLadder(today()), "triceps:pushdown");
  assert.equal(rung.lever, "set_quality", JSON.stringify(rung));
  assert.match(rung.reason, /closer to failure/);
});

test("unrated sets prove nothing about effort", () => {
  const run = plateauRunOf(
    [
      {
        session_id: 1,
        date: day(-7),
        working: 50,
        top_reps: 12,
        sets: [
          { weight: 50, reps: 12, rir: null },
          { weight: 50, reps: 11, rir: null },
          { weight: 50, reps: 10, rir: null },
          { weight: 50, reps: 10, rir: 3 },
        ],
      },
    ],
    today()
  );
  assert.equal(setsEndWellShortOfFailure(run), false);
});

test("a vetoed move spends the lever only inside its own plateau", () => {
  plan();
  stuck();
  seedAppliedRangeMove("Rope Pushdown", 13, 15, { daysAgo: 20, vetoed: true });
  assert.equal(repRangeMoveSpent("Rope Pushdown", 10, day(-56)), true, "a no inside the plateau");
  assert.equal(repRangeMoveSpent("Rope Pushdown", 10, day(-10)), false, "a no from before it does not carry");
});

// ---- 4. volume, then variation ---------------------------------------------------------

test("with the rep range spent and effort unproven, a group under its weekly band takes volume as the lever", () => {
  plan();
  stuck({ benchToo: false });
  seedAppliedRangeMove("Rope Pushdown", 10, 12);
  const triceps = capabilityRead(today()).muscles.find((m) => m.group === "triceps");
  assert.equal(triceps?.band, "low", "precondition: triceps under its band");
  const rung = rungOf(unitPlateauLadder(today()), "triceps:pushdown");
  assert.equal(rung.lever, "volume", JSON.stringify(rung));
  assert.match(rung.reason, /triceps/);
});

function seedVolumeStepTried(group, daysAgo = 5) {
  db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
     VALUES ('volume-step', 'x', '', ?, 'discarded', datetime('now', ?))`
  ).run(JSON.stringify({ volume_step: { group } }), `-${daysAgo} days`);
}

test("variation waits for a block boundary, then names a same-unit variant; an anchor is named too", () => {
  plan({ bench: { rep_low: 12, rep_high: 15 } });
  stuck();
  seedAppliedRangeMove("Rope Pushdown", 10, 12);
  seedVolumeStepTried("triceps");
  seedVolumeStepTried("chest");
  // A pushdown variant he has trained before, outside the plateau's sessions.
  repo.upsertExercise({ name: "Straight Bar Pushdown", muscle_group: "triceps", mode: "reps" });
  session("Straight Bar Pushdown", 150, 55, [10, 10, 10]);
  let pushdown = rungOf(unitPlateauLadder(today()), "triceps:pushdown");
  assert.equal(pushdown.code, "next_block", "no block running: no boundary");

  const block = createBlock({ goal: "strength", focus: "strength", week_index: 1, total_weeks: 4 });
  const ladder = unitPlateauLadder(today());
  assert.equal(ladder.block?.boundary, true);
  pushdown = rungOf(ladder, "triceps:pushdown");
  assert.equal(pushdown.lever, "variation", JSON.stringify(pushdown));
  assert.equal(pushdown.candidate.exercise, "Straight Bar Pushdown", "history first");
  const bench = rungOf(ladder, "horizontal-push:flat");
  assert.equal(bench.lever, "variation", "the anchor's lever is reported for the redraw");
  assert.equal(bench.compound, true);

  // A ladder change answered in this block spends the block for that unit.
  db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status) VALUES (?, 'x', '', ?, 'discarded')`
  ).run(
    UNIT_PLATEAU_AGENT,
    JSON.stringify({
      unit_plateau: { unit_key: "triceps:pushdown", lever: "variation", since: day(-56), block_id: block.id },
    })
  );
  assert.equal(rungOf(unitPlateauLadder(today()), "triceps:pushdown").code, "block_used");

  // Off the boundary (week two), every rotation waits for the next block.
  sql(`UPDATE program_blocks SET week_index = 2 WHERE id = ?`, block.id);
  assert.equal(rungOf(unitPlateauLadder(today()), "horizontal-push:flat").code, "next_block");
});
