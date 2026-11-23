// Horizon's road, the walked stones (week-read.ts journeyGround / pickJourneyStones,
// contract WeekReadJourneyStone): what the athlete actually did between the trail's start
// and today, each read from the source that owns it — the race run, a lift goal's new best
// (else the week's new bests on a main lift), the longest run taken well, a bodyweight
// waypoint the trend crossed — capped and spaced so the trail stays calm, in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedWeight } from "./_seed.js";
import { journeyGround, journeyLine, pickJourneyStones, weekRead } from "../dist/domain/training/week-read.js";

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
