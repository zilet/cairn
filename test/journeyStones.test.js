// Horizon's road, the walked stones (journey-ground.ts journeyGround / pickJourneyStones /
// roadStart, contract WeekReadJourneyStone): what the athlete actually did between the
// trail's start and today, each read from the source that owns it — every race run (even
// under an old goal), a lift goal's new best (else the week's new bests on a main lift), the
// longest run taken well (never a race), a bodyweight waypoint the trend crossed, a lab draw
// that moved a marker the right way, a block finished, the first full week, a measured body
// change — each source failing alone, capped and spread so the trail stays calm, in plain
// words that pass the reading grammar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedWeight } from "./_seed.js";
import {
  journeyGround,
  journeyLine,
  pickJourneyStones,
  roadStart,
  walkedSpanWords,
  weekRead,
} from "../dist/domain/training/week-read.js";
import { bloodMarkerMoves } from "../dist/domain/training/standing/blood.js";
import { JOURNEY_STONES_MAX } from "../dist/contracts/week-read.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { raceBuild } from "../dist/repo/race-build.js";

const ISO = /\b\d{4}-\d{2}-\d{2}\b/;
const NO_PRAISE = /!|%|percent|score|grade|great|amazing|crush|well done|good job/i;
const LB = { distance: "km", weight: "lb" };
const KG = { distance: "km", weight: "kg" };

/** A falling weight series whose week-mean trend crosses 180 lb on Sep 25 and stays under. */
function cut(goal_lb = 170) {
  const points = [
    ["2026-09-01", 184],
    ["2026-09-04", 183.6],
    ["2026-09-08", 182.8],
    ["2026-09-11", 182],
    ["2026-09-15", 181],
    ["2026-09-18", 180.6],
    ["2026-09-22", 179.6],
    ["2026-09-25", 179.2],
    ["2026-09-28", 178.8],
  ].map(([date, weight_lb]) => ({ date, weight_lb }));
  return { mode: "lose", current_lb: 178.8, goal_lb, goal_date: "2026-12-15", points };
}

const squat = (best, baseline) => ({
  available: true,
  objective: { exercise: "Barbell Back Squat" },
  best,
  baseline,
  reps: null,
});

function input(over = {}) {
  return {
    start: "2026-09-01",
    today: "2026-09-29",
    end: "2026-12-15",
    units: LB,
    finished: { event: "Riverside 10K", date: "2026-09-13", run_km: 10, finish_sec: 2900 },
    build: { review: { longest_well: { km: 14.2, date: "2026-09-20" } } },
    journeys: [
      squat({ est_1rm: 285.4, date: "2026-09-28" }, { est_1rm: 265, date: "2026-08-01" }),
      // A best set before this stretch began is not on it.
      {
        ...squat({ est_1rm: 240, date: "2026-08-20" }, { est_1rm: 220, date: "2026-07-01" }),
        objective: { exercise: "Bench Press" },
      },
      // A best no higher than where the goal began is not a new best.
      {
        ...squat({ est_1rm: 300, date: "2026-09-10" }, { est_1rm: 300, date: "2026-09-02" }),
        objective: { exercise: "Deadlift" },
      },
    ],
    bests: [
      { exercise: "Barbell Bench Press", label: "185 lb × 5 — new best", date: "2026-09-27", weight_lb: 185, reps: 5 },
    ],
    weight: cut(),
    ...over,
  };
}

test("the walked stones: each a dated, logged event from its own source, in plain words", () => {
  const stones = journeyGround(input());
  assert.deepEqual(
    stones.map((s) => [s.date, s.kind, s.stone, s.short]),
    [
      ["2026-09-13", "race_done", "endurance", "10K"],
      ["2026-09-20", "longest_run", "endurance", "14.2 km"],
      ["2026-09-25", "weight", "body", "180 lb"],
      ["2026-09-28", "best", "strength", "285 lb"],
    ],
    "ascending; the week's bests stay out while a lift goal speaks for the lifts"
  );
  assert.deepEqual(
    stones.map((s) => s.words),
    [
      "Riverside 10K run in 48:20 on Sep 13.",
      "14.2 km on Sep 20, the longest run of the last four weeks.",
      "Your weight trend went under 180 lb on Sep 25.",
      "A new best on the squat on Sep 28, an estimated 285 lb max.",
    ]
  );
  assert.deepEqual(
    stones.map((s) => s.href),
    ["/app/day/2026-09-13", "/app/day/2026-09-20", "/app/horizon/goal", "/app/day/2026-09-28"]
  );
  assert.deepEqual(
    stones.map((s) => [s.date_words, s.days_ago]),
    [
      ["Sep 13", 16],
      ["Sep 20", 9],
      ["Sep 25", 4],
      ["Sep 28", 1],
    ]
  );
  for (const s of stones) {
    assert.doesNotMatch(`${s.words} ${s.short}`, ISO);
    assert.doesNotMatch(`${s.words} ${s.short} ${s.leads.join(" ")}`, NO_PRAISE);
    assert.match(s.words, /^[A-Z0-9].*\.$/, "one full sentence");
  }
});

test("the walked stones: nothing outside the stretch, nothing without a goal to cross toward", () => {
  // The race run before the stretch, the long run after today: neither is on it.
  const out = journeyGround(
    input({
      finished: { event: "Riverside 10K", date: "2026-08-20", run_km: 10, finish_sec: 2900 },
      build: { review: { longest_well: { km: 14.2, date: "2026-09-30" } } },
      weight: { ...cut(), goal_date: null },
    })
  );
  assert.deepEqual(
    out.map((s) => s.kind),
    ["best"],
    "an undated weight goal sets no waypoint"
  );
  // A waypoint past the goal is never crossed "toward" it.
  assert.deepEqual(
    journeyGround(input({ finished: null, build: null, journeys: [], bests: [], weight: cut(181) })).map((s) => s.kind),
    [],
    "180 lies past a 181 lb goal"
  );
  // A trend that came back over the waypoint has not crossed it.
  const back = cut();
  back.points.push({ date: "2026-09-29", weight_lb: 184 });
  assert.equal(journeyGround(input({ finished: null, build: null, journeys: [], bests: [], weight: back })).length, 0);
  // Maintaining sets none.
  assert.equal(
    journeyGround(
      input({ finished: null, build: null, journeys: [], bests: [], weight: { ...cut(), mode: "maintain" } })
    ).length,
    0
  );
});

test("the walked stones: with no lift goal, the week's new bests on a main lift (weekBests)", () => {
  const stones = journeyGround(
    input({
      finished: null,
      build: null,
      weight: null,
      journeys: [],
      bests: [
        { exercise: "Hammer Curl", label: "35 lb × 8 — new best", date: "2026-09-28", weight_lb: 35, reps: 8 },
        {
          exercise: "Barbell Bench Press",
          label: "185 lb × 5 — new best",
          date: "2026-09-27",
          weight_lb: 185,
          reps: 5,
        },
      ],
    })
  );
  assert.deepEqual(
    stones.map((s) => [s.kind, s.short, s.words]),
    [["best", "185 lb × 5", "A new best on the bench on Sep 27: 185 lb × 5."]],
    "a curl is not a road's stone"
  );
});

test("the walked stones: in kilograms, waypoints every 2 kg", () => {
  const stones = journeyGround(input({ units: KG, finished: null, build: null, journeys: [], bests: [] }));
  // 184 → 179.2 lb on the trend is 83.5 → 81.3 kg: the 82 kg waypoint.
  assert.deepEqual(
    stones.map((s) => [s.short, s.words]),
    [["82 kg", `Your weight trend went under 82 kg on ${stones[0]?.date_words}.`]]
  );
  assert.doesNotMatch(stones[0].words, /\blb\b/);
});

test("the walked stones: capped, spaced and varied so the trail stays calm", () => {
  const stone = (date, kind, s) => ({
    date,
    kind,
    stone: s,
    short: date,
    words: `${date}.`,
    date_words: date,
    days_ago: 0,
    href: null,
  });
  const weights = Array.from({ length: 10 }, (_, i) =>
    stone(`2026-09-${String(2 + i * 3).padStart(2, "0")}`, "weight", "body")
  );
  const old = stone("2026-09-01", "best", "strength");
  const crowd = stone("2026-09-28", "longest_run", "endurance");
  const picked = pickJourneyStones([...weights, old, crowd], "2026-09-01", "2026-12-15");
  assert.ok(picked.length <= 6, `at most six, got ${picked.length}`);
  assert.ok(picked.includes(old), "a stone of another hue is kept even when older");
  assert.equal(picked.includes(crowd), false, "a stone a day from a newer one would sit on it: it gives way");
  const apart = stone("2026-09-12", "longest_run", "endurance");
  assert.ok(
    pickJourneyStones([...weights, old, apart], "2026-09-01", "2026-12-15").includes(apart),
    "a third hue with room is kept"
  );
  const days = picked.map((p) => Date.parse(p.date) / 864e5);
  for (let i = 1; i < days.length; i++)
    assert.ok(days[i] - days[i - 1] >= 3, `${picked[i - 1].date} and ${picked[i].date} would collide`);
  assert.deepEqual(
    picked.map((p) => p.date),
    [...picked.map((p) => p.date)].sort(),
    "ascending"
  );
  // Two on one day: one is kept, by priority (a race over a waypoint).
  const race = stone("2026-09-10", "race_done", "endurance");
  const same = stone("2026-09-10", "weight", "body");
  assert.deepEqual(pickJourneyStones([same, race], "2026-09-01", "2026-12-15"), [race]);
});

test("the trail's line names a fresh stone first, in a variant set; an older one never leads", () => {
  const marks = [
    { kind: "long_run", label: "Long run", days_away: 3, days_words: "in 3 days", summit: false },
    { kind: "goal", label: "Goal weight", days_away: 77, days_words: "in 11 weeks", summit: true },
  ];
  const fresh = journeyGround(input()).at(-1);
  const seen = new Set();
  for (let d = 20; d < 30; d++) {
    const line = journeyLine(null, marks, `2026-09-${d}`, fresh);
    assert.match(
      line,
      /^(A new best on the squat yesterday\.|You set a new best on the squat yesterday\.) Next, the long run in 3 days; your goal weight in 11 weeks\.$/
    );
    seen.add(line);
  }
  assert.ok(seen.size > 1, "the lead rotates by day");
  assert.doesNotMatch(journeyLine(null, marks, "2026-09-29", null), /new best/);
});

test("the week read sets the stones on the road and keeps the older behind-you list", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-22T12:00:00") });
  repo.setProfile({ goal_mode: "lose", goal_weight_lb: 165, goal_date: "2026-12-15", weight_lb: 184 });
  for (const [date, lb] of [
    ["2026-08-28", 184.2],
    ["2026-09-01", 184],
    ["2026-09-04", 183.4],
    ["2026-09-08", 182.6],
    ["2026-09-11", 181.8],
    ["2026-09-15", 180.8],
    ["2026-09-18", 179],
    ["2026-09-21", 179.2],
  ])
    seedWeight(date, lb);
  repo.logSetByName({ exercise: "Barbell Back Squat", weight: 225, reps: 5, rir: 2, date: "2026-08-01" });
  repo.setStrengthObjective({ exercise: "Barbell Back Squat", target_kind: "explicit_est_1rm", target_est_1rm: 330 });
  repo.logSetByName({ exercise: "Barbell Back Squat", weight: 245, reps: 5, rir: 2, date: "2026-09-21" });

  const j = weekRead().journey;
  assert.ok(j, "a dated weight goal draws a road");
  assert.ok(Array.isArray(j.behind), "the older list is still served");
  assert.ok(Array.isArray(j.walked), "the stones ride beside it");
  const kinds = j.walked.map((s) => s.kind);
  assert.ok(kinds.includes("best"), `a new squat best is a stone: ${JSON.stringify(j.walked)}`);
  assert.ok(kinds.includes("weight"), "the 180 lb waypoint is a stone");
  const best = j.walked.find((s) => s.kind === "best");
  assert.equal(best.date, "2026-09-21");
  assert.match(best.words, /^A new best on the squat on Sep 21, an estimated \d+ lb max\.$/);
  for (const s of j.walked) {
    assert.ok(s.date >= j.start_date && s.date <= j.today);
    assert.equal("leads" in s, false, "the line's leads stay on the server");
  }
  // The newest stone is a day old: it leads the line.
  assert.match(j.line, /new best on the squat yesterday\./);
});

// ---------- the road's other ground: health, endurance with no race, consistency, body ----------

const GRAMMAR_FREE = (s) => {
  assert.equal(violatesReadingGrammar(s), null, `reading grammar: ${s}`);
  assert.doesNotMatch(s, NO_PRAISE, s);
  assert.doesNotMatch(s, ISO, s);
  assert.doesNotMatch(s, /\bfixed\b|\bcured\b|\byou should\b|\bimpact\b/i, s);
};

/** The other reads, none of the four older sources: each source stands alone here. */
function bare(over = {}) {
  return input({ finished: null, build: null, journeys: [], bests: [], weight: null, ...over });
}

test("a lab marker a newer draw moved back inside, or toward, its optimal band: one heart stone a draw", () => {
  const markers = [
    { name: "LDL Cholesterol", date: "2026-09-18", prev_date: "2026-05-02", kind: "back", down: true },
    { name: "Ferritin", date: "2026-09-18", prev_date: "2026-05-02", kind: "toward", down: false },
    // A draw before the road began is not on it.
    { name: "HbA1c", date: "2026-08-20", prev_date: "2026-03-01", kind: "back", down: true },
  ];
  const stones = journeyGround(bare({ markers }));
  assert.deepEqual(
    stones.map((s) => [s.kind, s.stone, s.date, s.short, s.href]),
    [["health", "heart", "2026-09-18", "Labs", "/app/you/markers"]]
  );
  assert.equal(
    stones[0].words,
    "On the Sep 18 draw, LDL Cholesterol came down into its optimal band, and one other marker moved toward its optimal band."
  );
  for (const s of stones) [s.words, ...s.leads].forEach(GRAMMAR_FREE);
  // One marker: its own short name.
  const one = journeyGround(bare({ markers: [markers[0]] }));
  assert.equal(one[0].short, "LDL");
  assert.equal(one[0].words, "LDL Cholesterol came down into its optimal band on the Sep 18 draw.");
  // Silent with no move.
  assert.equal(journeyGround(bare({ markers: [] })).length, 0);
});

test("the Blood row's own read finds the move against the previous draw, never a worsening", () => {
  const meaningful = (prev) => Math.abs(prev) * 0.03;
  const lipid = (points, over = {}) => ({
    name: "LDL Cholesterol",
    group: "lipids",
    source: "lab",
    optimal: { low: 0, high: 100, dir: "high" },
    latest: points.at(-1),
    in_optimal: points.at(-1).value <= 100,
    points,
    ...over,
  });
  const back = bloodMarkerMoves(meaningful, [
    lipid([
      { date: "2026-05-02", value: 131 },
      { date: "2026-09-18", value: 96 },
    ]),
  ]);
  assert.deepEqual(back, [
    { name: "LDL Cholesterol", date: "2026-09-18", prev_date: "2026-05-02", kind: "back", down: true },
  ]);
  const toward = bloodMarkerMoves(meaningful, [
    lipid([
      { date: "2026-05-02", value: 150 },
      { date: "2026-09-18", value: 120 },
    ]),
  ]);
  assert.equal(toward[0]?.kind, "toward");
  // A hair's move is not material; a worsening, or one draw alone, is nothing.
  for (const pts of [
    [
      { date: "2026-05-02", value: 150 },
      { date: "2026-09-18", value: 149 },
    ],
    [
      { date: "2026-05-02", value: 96 },
      { date: "2026-09-18", value: 131 },
    ],
    [{ date: "2026-09-18", value: 96 }],
  ])
    assert.deepEqual(bloodMarkerMoves(meaningful, [lipid(pts)]), [], JSON.stringify(pts));
  // A wearable reading or a non-blood panel is never a lab stone.
  assert.deepEqual(
    bloodMarkerMoves(meaningful, [
      lipid(
        [
          { date: "2026-05-02", value: 131 },
          { date: "2026-09-18", value: 96 },
        ],
        { source: "wearable" }
      ),
    ]),
    []
  );
});

test("with no dated race, the stretch's longest run taken well is an endurance stone, never the race", () => {
  const stones = journeyGround(bare({ longestRun: { km: 16.4, date: "2026-09-20", longest: true } }));
  assert.deepEqual(
    stones.map((s) => [s.kind, s.stone, s.short, s.words]),
    [["longest_run", "endurance", "16.4 km", "16.4 km on Sep 20, your longest run since Sep 1."]]
  );
  // A longer run the body paid for is said plainly: this is the longest taken well.
  const paid = journeyGround(bare({ longestRun: { km: 14, date: "2026-09-20", longest: false } }));
  assert.match(paid[0].words, /that you came through well\.$/);
  // On a race's day the race stands, never a long run.
  const race = { event: "Riverside 10K", date: "2026-09-20", run_km: 10, finish_sec: 2900 };
  const both = journeyGround(
    bare({
      races: [race],
      longestRun: { km: 10, date: "2026-09-20", longest: true },
      build: { review: { longest_well: { km: 10, date: "2026-09-20" } } },
    })
  );
  assert.deepEqual(
    both.map((s) => [s.kind, s.date]),
    [["race_done", "2026-09-20"]]
  );
  for (const s of [...stones, ...paid]) [s.words, ...s.leads].forEach(GRAMMAR_FREE);
});

test("every race run on the stretch is a stone, even once the goal has moved on", () => {
  const races = [
    { event: "Riverside 10K", date: "2026-09-06", run_km: 10, finish_sec: 2900 },
    { event: null, date: "2026-09-27", run_km: 21.1, finish_sec: 7818 },
  ];
  const stones = journeyGround(bare({ races }));
  assert.deepEqual(
    stones.map((s) => [s.kind, s.date, s.short, s.words]),
    [
      ["race_done", "2026-09-06", "10K", "Riverside 10K run in 48:20 on Sep 6."],
      ["race_done", "2026-09-27", "Half", "Half marathon run in 2:10:18 on Sep 27."],
    ]
  );
  // The build's `finished` adds nothing a matched race already said.
  const dup = journeyGround(
    bare({ races, finished: { event: "Riverside 10K", date: "2026-09-06", run_km: 10, finish_sec: 2900 } })
  );
  assert.equal(dup.length, 2);
});

test("consistency as fact: the most recent block finished, and the first week that held every day set", () => {
  const blocks = [
    { focus: "strength", weeks: 6, end_date: "2026-09-20" },
    { focus: "hypertrophy", weeks: 4, end_date: "2026-08-09" },
    // Before the road began: not on it.
    { focus: "strength", weeks: 6, end_date: "2026-07-01" },
  ];
  const block = journeyGround(bare({ blocks }));
  assert.deepEqual(
    block.map((s) => [s.kind, s.date, s.short, s.words]),
    [["block", "2026-09-20", "Block", "A six-week strength block finished the week of Sep 14."]],
    "one block stone, the most recent"
  );
  // Three lifting days and two runs a week: the week of Sep 7 is short a run; Sep 14 holds
  // every day (a moved day counts), done on its Saturday; the week of Sep 21 holds them too
  // but is not the first.
  const weekDays = {
    lift_days: 3,
    run_days: 2,
    lift_dates: [
      "2026-09-07",
      "2026-09-09",
      "2026-09-11",
      "2026-09-14",
      "2026-09-16",
      "2026-09-17",
      "2026-09-21",
      "2026-09-23",
      "2026-09-25",
    ],
    run_dates: ["2026-09-08", "2026-09-15", "2026-09-19", "2026-09-22", "2026-09-26"],
  };
  const full = journeyGround(bare({ weekDays }));
  assert.deepEqual(
    full.map((s) => [s.kind, s.date, s.short, s.words]),
    [
      [
        "full_week",
        "2026-09-19",
        "Full week",
        "The week of Sep 14 was the first on this road to hold every day you set: three lifting days and two runs.",
      ],
    ]
  );
  // Nothing set: nothing to hold.
  assert.equal(journeyGround(bare({ weekDays: { ...weekDays, lift_days: 0, run_days: 0 } })).length, 0);
  assert.equal(journeyGround(bare({ weekDays: null })).length, 0);
  for (const s of [...block, ...full]) [s.words, ...s.leads].forEach(GRAMMAR_FREE);
});

test("a measured body change only while the one body-fat estimate is measured", () => {
  const waist = [
    { date: "2026-08-25", value: 36.4 },
    { date: "2026-09-12", value: 35.9 },
    { date: "2026-09-26", value: 35.2 },
  ];
  const lb = journeyGround(bare({ body: { measured: true, waist, fat: null } }));
  assert.deepEqual(
    lb.map((s) => [s.kind, s.stone, s.date, s.short, s.words]),
    [["waist", "body", "2026-09-26", "−1.2 in", "Your waist measured 1.2 in smaller on Sep 26 than on Aug 25."]]
  );
  const kg = journeyGround(bare({ units: KG, body: { measured: true, waist, fat: null } }));
  assert.equal(kg[0].words, "Your waist measured 3 cm smaller on Sep 26 than on Aug 25.");
  assert.doesNotMatch(kg[0].words, /\bin\b/);
  // An estimate from height and weight alone sets nothing.
  assert.equal(journeyGround(bare({ body: { measured: false, waist, fat: null } })).length, 0);
  // A re-measure's wobble is not a change.
  assert.equal(
    journeyGround(
      bare({
        body: {
          measured: true,
          waist: [
            { date: "2026-08-25", value: 36.4 },
            { date: "2026-09-26", value: 36.1 },
          ],
          fat: null,
        },
      })
    ).length,
    0
  );
  // Body fat: only when the new range clears the old one.
  const fat = (high) => ({
    measured: true,
    waist: [],
    fat: { now: { date: "2026-09-22", low: 17, high }, before: { date: "2026-06-02", low: 20, high: 23 } },
  });
  const leaner = journeyGround(bare({ body: fat(19) }));
  assert.deepEqual(
    leaner.map((s) => [s.kind, s.words]),
    [["body_fat", "Body fat measured lower on Sep 22 than on Jun 2."]]
  );
  assert.equal(journeyGround(bare({ body: fat(21) })).length, 0, "overlapping ranges are no change");
  for (const s of [...lb, ...kg, ...leaner]) {
    [s.words, ...s.leads].forEach(GRAMMAR_FREE);
    assert.doesNotMatch(s.words, /%/);
  }
});

test("one source that throws leaves every other stone standing", () => {
  const poisoned = {
    get name() {
      throw new Error("a broken marker row");
    },
    date: "2026-09-18",
    prev_date: "2026-05-02",
    kind: "back",
    down: true,
  };
  const blocks = [{ focus: "strength", weeks: 6, end_date: "2026-09-06" }];
  const stones = journeyGround(input({ markers: [poisoned], blocks }));
  const kinds = stones.map((s) => s.kind);
  assert.ok(!kinds.includes("health"), "the broken source sets nothing");
  for (const k of ["race_done", "best", "weight", "block"]) assert.ok(kinds.includes(k), `${k} still stands: ${kinds}`);
});

test("many sources at once: capped at six, each hue first, spread along the road, ascending", () => {
  const stones = journeyGround(
    input({
      markers: [{ name: "LDL Cholesterol", date: "2026-09-16", prev_date: "2026-05-02", kind: "back", down: true }],
      blocks: [{ focus: "strength", weeks: 6, end_date: "2026-09-06" }],
      body: {
        measured: true,
        waist: [
          { date: "2026-09-01", value: 37 },
          { date: "2026-09-23", value: 36 },
        ],
        fat: null,
      },
    })
  );
  assert.ok(stones.length <= JOURNEY_STONES_MAX);
  assert.deepEqual(
    new Set(stones.map((s) => s.stone)),
    new Set(["endurance", "body", "strength", "heart"]),
    "every hue"
  );
  assert.deepEqual(
    stones.map((s) => s.date),
    [...stones.map((s) => s.date)].sort()
  );
  for (let i = 1; i < stones.length; i++)
    assert.ok((Date.parse(stones[i].date) - Date.parse(stones[i - 1].date)) / 864e5 >= 3);
});

test("weight waypoints over a long road are spread along it, not only the newest", () => {
  // Five and a half months of a steady cut: 183 → 153 lb, a waypoint every 5 lb.
  const points = [];
  for (let d = 0; d <= 170; d += 3) {
    const date = new Date(Date.UTC(2026, 5, 6 + d)).toISOString().slice(0, 10);
    points.push({ date, weight_lb: Math.round((183 - (30 * d) / 170) * 10) / 10 });
  }
  const stones = journeyGround(
    bare({
      start: "2026-06-06",
      today: "2026-11-23",
      end: "2027-02-07",
      weight: { mode: "lose", current_lb: 153, goal_lb: 148, goal_date: "2027-02-07", points },
      races: [{ event: "Cambridge Half Marathon", date: "2026-11-01", run_km: 21.2, finish_sec: 7818 }],
    })
  );
  const ways = stones.filter((s) => s.kind === "weight").map((s) => s.short);
  assert.ok(ways.length >= 4, `most of the crossings: ${ways}`);
  assert.ok(ways.includes("180 lb") || ways.includes("175 lb"), `an early crossing is kept: ${ways}`);
  assert.ok(stones.some((s) => s.kind === "race_done"));
  assert.ok(stones.length <= JOURNEY_STONES_MAX);
});

test("the road starts at the earliest live goal's start, at most a year back", () => {
  const today = "2026-11-23";
  assert.deepEqual(roadStart(today, ["2026-10-26", "2026-06-06", null, "2026-09-19"], "2026-10-26"), {
    start: "2026-06-06",
    real: true,
  });
  assert.deepEqual(roadStart(today, ["2024-01-01"], "2026-10-26"), { start: "2025-11-23", real: true });
  assert.deepEqual(roadStart(today, [null, undefined, "2026-12-01"], "2026-10-26"), {
    start: "2026-10-26",
    real: false,
  });
  assert.equal(walkedSpanWords(9), "nine days");
  assert.equal(walkedSpanWords(28), "four weeks");
  assert.equal(walkedSpanWords(170), "five and a half months");
  assert.equal(walkedSpanWords(120), "four months");
  assert.equal(walkedSpanWords(365), "a year");
});

test("a race run under an old goal, a new race goal set: one race stone on race day, never a long run", (t) => {
  const RACE = "2026-11-01";
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Cambridge Half Marathon",
      date: RACE,
      distance_km: 21.1,
      target: "sub-2:00",
    },
  });
  repo.addActivity({ type: "run", duration_min: 95, distance_km: 16, date: "2026-10-18" });
  repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: "2026-10-27" });
  repo.addActivity({ type: "run", duration_min: 130.3, distance_km: 21.18, date: RACE });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-11-15" });
  // The athlete sets the next race after the half: the half lives on in completed_races.
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Spring 5K", date: "2027-05-16", distance_km: 5, target: "sub-20:00" },
  });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-23T12:00:00") });
  const build = raceBuild("2026-11-23", { describeRunning: true });
  assert.notEqual(build.review?.longest_well?.date, RACE, "the race effort is never the longest run taken well");
  const j = weekRead().journey;
  assert.ok(j, "the new race draws a road");
  assert.ok(j.start_date <= RACE, `the road reaches back to the race: ${j.start_date}`);
  const onRace = j.walked.filter((s) => s.date === RACE);
  assert.deepEqual(
    onRace.map((s) => [s.kind, s.words]),
    [["race_done", "Cambridge Half Marathon run in 2:10:18 on Nov 1."]]
  );
  assert.equal(
    j.walked.some((s) => s.kind === "longest_run" && s.date === RACE),
    false
  );
});
