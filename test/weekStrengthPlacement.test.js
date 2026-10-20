// weekStrengthPlacement (src/repo/week-strength-placement.ts): the one answer to which
// plan day sits on which date of this week. Pure over the map, the week's sessions and
// today's line when the caller hands them in — so these cases need no plan at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekStrengthPlacement } from "../dist/repo/week-strength-placement.js";

const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";

const day = (n) => ({ id: n, day_number: n, name: `Day ${n}`, focus: null, day_type: "strength", names: ["Lift"] });
/** dow (1 = Monday) → plan day number. */
const mapOf = (entries) => new Map(entries.map(([dow, n]) => [dow, day(n)]));
const line = (n) => ({ role: "strength", day_number: n });
const session = (date, placed, resolved = placed, title = `Day ${placed}`) => ({
  id: 1,
  date,
  plan_day_id: placed,
  day_number: placed,
  day_name: `Day ${placed}`,
  finished: true,
  resolved_day_number: resolved,
  placed_day_number: placed,
  title,
});
const numbers = (placement) => Object.fromEntries(placement.days.map((d) => [d.date, d.day_number]));

test("a straight trade: the map's day for today takes the later weekday that held the line's day", () => {
  const p = weekStrengthPlacement(TUE, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]),
    sessions: [],
    strengthLine: line(4),
  });
  assert.equal(p.moved_to, THU);
  assert.equal(p.unplaced_day_number, null);
  assert.equal(numbers(p)[TUE], 4);
  assert.equal(numbers(p)[THU], 2);
});

test("no later weekday holds the line's day: the bumped day takes the nearest later weekday whose day repeats", () => {
  // A three-day pool over five lifting weekdays repeats: Thursday's day 1 is Monday's too,
  // and Monday already lifted it (a date missed holds nothing, so only a logged repeat frees a slot).
  const p = weekStrengthPlacement(WED, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 1],
      [5, 2],
    ]),
    sessions: [session(MON, 1), session(TUE, 2)],
    strengthLine: line(4),
  });
  assert.equal(p.moved_to, THU, "the nearest later weekday whose day the week already holds");
  assert.equal(p.unplaced_day_number, null);
  const n = numbers(p);
  assert.equal(n[WED], 4, "today names the line's day");
  assert.equal(n[THU], 3, "the bumped day is still in the week");
  assert.equal(n[FRI], 2);
  assert.equal(p.on(THU).mapped_day_number, 3);
});

test("a later repeat of a day logged earlier in the week takes the bumped day too", () => {
  const p = weekStrengthPlacement(TUE, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 1],
      [5, 4],
    ]),
    sessions: [session(MON, 1)],
    strengthLine: line(5),
  });
  assert.equal(p.moved_to, THU);
  assert.equal(numbers(p)[THU], 2);
});

test("the bumped day still on another date this week moves nothing", () => {
  const p = weekStrengthPlacement(MON, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 1],
      [5, 2],
    ]),
    sessions: [],
    strengthLine: line(4),
  });
  assert.equal(p.moved_to, null);
  assert.equal(p.unplaced_day_number, null, "day 1 still lifts on Thursday");
  assert.equal(numbers(p)[MON], 4);
  assert.equal(numbers(p)[THU], 1);
});

test("no weekday can take the bumped day: it is named as not fitting this week, never silently dropped", () => {
  const p = weekStrengthPlacement(TUE, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]),
    sessions: [session(MON, 1)],
    strengthLine: line(1),
  });
  assert.equal(p.moved_to, null);
  assert.equal(p.unplaced_day_number, 2, "Tuesday's day 2 does not fit this week, and says so");
  const n = numbers(p);
  assert.equal(n[TUE], 1);
  assert.deepEqual([n[WED], n[THU], n[FRI]], [3, 4, 5], "no other day was pushed out for it");
});

test("a logged session titled as itself still files under the plan day its work resolves to", () => {
  const p = weekStrengthPlacement(THU, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]),
    sessions: [session(WED, 3, null, "Legs, short")],
    strengthLine: line(4),
  });
  const wed = p.on(WED);
  assert.equal(wed.logged, true);
  assert.equal(wed.day_number, null, "it shows as itself");
  assert.equal(wed.placed_day_number, 3, "but its work is day 3's");
  assert.equal(wed.logged_title, "Legs, short");
  assert.equal(p.on(FRI).placed_day_number, 5, "an unlogged date files under its own day");
});

// ---------- a LOGGED day in place of the map's day (2026-10-20, live) ----------
//
// Tuesday's Lower was swapped for Push B after a morning run, and Push B was then LOGGED.
// The trade only ran for today's unlogged line, so once the session landed the week read
// Mon Upper · Tue Push B · Wed Pull · Thu Push A · Fri Push B — Lower gone, Push B twice.

const SUN = 0;
const THU_DOW = 4;
const liveDay = (n, name, groups) => ({
  id: n,
  day_number: n,
  name,
  focus: null,
  day_type: "strength",
  names: groups.includes("quads") ? ["Back Squat", "Romanian Deadlift"] : ["Press"],
  groups,
});
const LIVE = {
  1: liveDay(1, "Push A", ["chest", "shoulders"]),
  2: liveDay(2, "Lower", ["quads", "hamstrings", "glutes"]),
  3: liveDay(3, "Upper back & arms", ["back", "biceps"]),
  4: liveDay(4, "Push B", ["shoulders", "chest"]),
  5: liveDay(5, "Pull", ["back"]),
};
// The key-run-aware weekday map for the week: Mon Upper, Tue Lower, Wed Pull, Thu Push A, Fri Push B.
const liveMap = () =>
  new Map([
    [1, LIVE[3]],
    [2, LIVE[2]],
    [3, LIVE[5]],
    [4, LIVE[1]],
    [5, LIVE[4]],
  ]);
const KEY_RUNS = [THU_DOW, SUN]; // quality Thursday, long Sunday

test("live: Push B logged on Tuesday's Lower puts Lower on Friday — no day twice, none dropped", () => {
  const p = weekStrengthPlacement(TUE, {
    map: liveMap(),
    sessions: [session(MON, 3), session(TUE, 4)],
    strengthLine: line(4),
    keyRunDows: KEY_RUNS,
  });
  const n = numbers(p);
  assert.deepEqual([n[MON], n[TUE], n[WED], n[THU], n[FRI]], [3, 4, 5, 1, 2]);
  assert.equal(p.moved_to, FRI, "today's displaced Lower landed on Friday");
  assert.deepEqual(p.moves, [{ day_number: 2, from_date: TUE, to_date: FRI, by_day_number: 4 }]);
  assert.equal(p.unplaced_day_number, null);
  assert.equal(p.on(FRI).placed_day_number, 2);
  const lifted = p.days.map((d) => d.placed_day_number).filter((x) => x != null);
  assert.equal(new Set(lifted).size, lifted.length, "no plan day twice");
});

test("the same week with today's line not yet logged trades the same way", () => {
  const p = weekStrengthPlacement(TUE, {
    map: liveMap(),
    sessions: [session(MON, 3)],
    strengthLine: line(4),
    keyRunDows: KEY_RUNS,
  });
  assert.equal(p.moved_to, FRI);
  assert.equal(numbers(p)[FRI], 2);
});

test("a heavy-lower day never lands on a key-run day; with that the only slot it does not fit, and says so", () => {
  // Push A logged on Tuesday's Lower: Thursday's Push A is the only duplicate — the quality run.
  const p = weekStrengthPlacement(TUE, {
    map: liveMap(),
    sessions: [session(MON, 3), session(TUE, 1)],
    strengthLine: null,
    keyRunDows: KEY_RUNS,
  });
  assert.equal(p.moved_to, null);
  assert.deepEqual(p.moves, []);
  assert.equal(p.unplaced_day_number, 2, "Lower does not fit this week, and says so");
  assert.deepEqual(p.unplaced_day_numbers, [2]);
  assert.equal(numbers(p)[THU], 1, "the quality-run day keeps its upper day");
});

test("a heavy-lower day prefers a duplicate clear of the key runs over the straight trade beside one", () => {
  // Pull laid Monday and Wednesday (a repeat), Monday lifted it; Push B logged on Tuesday's
  // Lower. Friday (the straight trade) sits the day before a Saturday key run; Wednesday's
  // repeat of Pull is clear of it.
  const map = liveMap();
  map.set(1, LIVE[5]);
  const p = weekStrengthPlacement(TUE, {
    map,
    sessions: [session(MON, 5), session(TUE, 4)],
    strengthLine: null,
    keyRunDows: [6],
  });
  assert.equal(p.moved_to, WED);
  // With the key run elsewhere the straight trade wins.
  const plain = weekStrengthPlacement(TUE, {
    map,
    sessions: [session(MON, 5), session(TUE, 4)],
    strengthLine: null,
    keyRunDows: [],
  });
  assert.equal(plain.moved_to, FRI);
});

test("a logged swap with no open later slot is named as not fitting this week", () => {
  const p = weekStrengthPlacement(TUE, {
    map: mapOf([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]),
    sessions: [session(MON, 1), session(TUE, 1)],
    strengthLine: null,
    keyRunDows: [],
  });
  assert.equal(p.moved_to, null);
  assert.equal(p.unplaced_day_number, 2);
  const n = numbers(p);
  assert.deepEqual([n[WED], n[THU], n[FRI]], [3, 4, 5], "nothing else was pushed out for it");
});

test("a logged day matching the map moves nothing", () => {
  const p = weekStrengthPlacement(TUE, {
    map: liveMap(),
    sessions: [session(MON, 3), session(TUE, 2)],
    strengthLine: line(2),
    keyRunDows: KEY_RUNS,
  });
  assert.deepEqual(p.moves, []);
  assert.equal(p.moved_to, null);
  assert.equal(p.unplaced_day_number, null);
  const n = numbers(p);
  assert.deepEqual([n[MON], n[TUE], n[WED], n[THU], n[FRI]], [3, 2, 5, 1, 4]);
});

test("a day logged on an unstated weekday is an extra: it displaces nothing", () => {
  const SAT = "2026-10-24";
  const p = weekStrengthPlacement(SAT, {
    map: liveMap(),
    sessions: [session(MON, 3), session(TUE, 2), session(WED, 5), session(THU, 1), session(FRI, 4), session(SAT, 2)],
    strengthLine: null,
    keyRunDows: KEY_RUNS,
  });
  assert.deepEqual(p.moves, []);
  assert.equal(p.unplaced_day_number, null);
  assert.equal(p.on(SAT).placed_day_number, 2);
});

test("a day already logged earlier this week is never placed again", () => {
  // Lower logged Monday on Upper's day, then Upper logged on Tuesday's Lower: Lower is done.
  const p = weekStrengthPlacement(TUE, {
    map: liveMap(),
    sessions: [session(MON, 2), session(TUE, 3)],
    strengthLine: null,
    keyRunDows: KEY_RUNS,
  });
  assert.deepEqual(p.moves, [], "Monday's Upper was made up on Tuesday and Tuesday's Lower was done on Monday");
  assert.equal(p.unplaced_day_number, null);
});

test("a date missed (nothing logged) displaces nothing", () => {
  const p = weekStrengthPlacement(WED, {
    map: liveMap(),
    sessions: [session(MON, 3)],
    strengthLine: null,
    keyRunDows: KEY_RUNS,
  });
  assert.deepEqual(p.moves, []);
  assert.equal(numbers(p)[TUE], 2, "Tuesday still reads as the day it was laid with");
});
