// Before this, no path in Cairn could log food for a past day and nothing recorded
// what time you actually ate — insertFoodNote hardcoded today and let created_at
// default to now. "I remembered last night's dinner" was unloggable, and a meal's
// only clock was the moment its row was written.
//
// So: `date` may be backdated, `eaten_at` carries the LOCAL wall-clock "HH:MM" when
// someone states one, and the two directions of meal-label inference fill blanks
// without ever overwriting what a person said. Absence stays first-class throughout
// — no time is the ordinary case and must degrade nothing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import {
  mealLabelForTime,
  approxTimeForMealLabel,
  normalizeWallClock,
  clockLabel,
  chatHistoryTimeLabel,
  partOfDay,
} from "../dist/repo/shared.js";
import { onBrainEvent, resetBrainEventsForTest, flushBrainEventsForTest } from "../dist/brainEvents.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { registerNutritionTools } from "../dist/surfaces/mcp/nutrition.js";

beforeEach(() => resetTables("food_notes", "chat_turns", "chat_messages", "profile"));

// Spread into a plain object: node:sqlite hands back null-prototype rows, which
// deepEqual refuses to match against an object literal.
const rowOf = (id) => ({ ...db.prepare(`SELECT date, eaten_at, meal FROM food_notes WHERE id = ?`).get(id) });

// ---- the wall-clock primitive ----

test("normalizeWallClock accepts local 24-hour times and refuses to guess at anything else", () => {
  assert.equal(normalizeWallClock("08:00"), "08:00");
  assert.equal(normalizeWallClock("8:05"), "08:05", "pads a single-digit hour");
  assert.equal(normalizeWallClock(" 19:30 "), "19:30", "tolerates surrounding space");
  assert.equal(normalizeWallClock("19:30:45"), "19:30", "drops seconds");
  assert.equal(normalizeWallClock("00:00"), "00:00", "midnight is a real stated time");
  assert.equal(normalizeWallClock("23:59"), "23:59");

  // 12-hour forms are ambiguous about which half of the day they mean; rejecting
  // beats silently filing dinner in the morning.
  assert.equal(normalizeWallClock("8:00 PM"), null);
  assert.equal(normalizeWallClock("24:00"), null);
  assert.equal(normalizeWallClock("19:60"), null);
  assert.equal(normalizeWallClock("evening"), null);
  assert.equal(normalizeWallClock(""), null);
  assert.equal(normalizeWallClock(null), null);
  assert.equal(normalizeWallClock(undefined), null);
});

// ---- label inference, both directions ----

test("mealLabelForTime names the slot from a time, and calls the gaps snacks", () => {
  assert.equal(mealLabelForTime("05:00"), "breakfast", "window opens at 05:00");
  assert.equal(mealLabelForTime("08:00"), "breakfast");
  assert.equal(mealLabelForTime("10:59"), "breakfast");
  assert.equal(mealLabelForTime("11:00"), "lunch", "breakfast hands off to lunch at 11:00");
  assert.equal(mealLabelForTime("12:30"), "lunch");
  assert.equal(mealLabelForTime("14:59"), "lunch");
  assert.equal(mealLabelForTime("17:00"), "dinner", "dinner opens at 17:00");
  assert.equal(mealLabelForTime("19:00"), "dinner");
  assert.equal(mealLabelForTime("21:00"), "dinner", "a late plate is still dinner");
  assert.equal(mealLabelForTime("21:59"), "dinner");

  // The gaps are deliberate: the between-meals hours are a snack, not a stretched
  // lunch, and 22:30 is a late snack rather than a very late dinner.
  assert.equal(mealLabelForTime("15:30"), "snack");
  assert.equal(mealLabelForTime("16:30"), "snack");
  assert.equal(mealLabelForTime("22:30"), "snack");
  assert.equal(mealLabelForTime("23:30"), "snack");
  assert.equal(mealLabelForTime("03:00"), "snack");

  assert.equal(mealLabelForTime("nope"), null, "an unreadable time names nothing");
  assert.equal(mealLabelForTime(null), null);
});

test("approxTimeForMealLabel is the inverse, and invents nothing for a snack", () => {
  assert.equal(approxTimeForMealLabel("breakfast"), "08:00");
  assert.equal(approxTimeForMealLabel("Lunch"), "12:30", "case-insensitive");
  assert.equal(approxTimeForMealLabel(" dinner "), "19:00", "trims");
  assert.equal(approxTimeForMealLabel("snack"), null, "a snack has no representative hour");
  assert.equal(approxTimeForMealLabel("post-workout"), null);
  assert.equal(approxTimeForMealLabel(""), null);
  assert.equal(approxTimeForMealLabel(null), null);
});

test("every representative time round-trips back to its own label", () => {
  for (const label of ["breakfast", "lunch", "dinner"]) {
    assert.equal(mealLabelForTime(approxTimeForMealLabel(label)), label, `${label} round-trips`);
  }
});

test("no meal window can contradict the coarse words partOfDay speaks", () => {
  // The windows are nested inside partOfDay's buckets on purpose — an inferred
  // label must never fight the prose the coach says out loud ("dinner" landing in
  // "morning" is the failure this pins).
  const allowed = {
    breakfast: new Set(["morning"]),
    lunch: new Set(["morning", "afternoon"]),
    dinner: new Set(["evening", "night"]),
  };
  for (let hour = 0; hour < 24; hour++) {
    const label = mealLabelForTime(`${String(hour).padStart(2, "0")}:00`);
    if (label === "snack") continue; // a snack is legitimate at any hour
    assert.ok(
      allowed[label].has(partOfDay(hour)),
      `${label} at ${hour}:00 reads as "${partOfDay(hour)}", which contradicts it`
    );
  }
});

// ---- writing: absence stays first-class ----

test("a plain food note still lands on today with no time at all", () => {
  const row = repo.addFoodNote("breakfast", "", { summary: "Eggs", kcal: 400, protein_g: 30 });
  assert.equal(row.date, localDaysAgo(0));
  assert.equal(row.eaten_at, null, "an unstated time stays unstated — not midnight, not a guess");
  assert.equal(row.meal, "breakfast");
});

test("existing positional callers keep working unchanged", () => {
  // The four production call sites pass 3 or 4 positional args and no options.
  const three = repo.addFoodNote("lunch", "chicken bowl", null);
  const four = repo.addFoodNote("dinner", "", { summary: "Salmon" }, undefined);
  assert.equal(three.date, localDaysAgo(0));
  assert.equal(three.eaten_at, null);
  assert.equal(four.date, localDaysAgo(0));
  assert.equal(four.eaten_at, null);
});

test("a note with no label and no time keeps the generic 'meal' slot", () => {
  const row = repo.addFoodNote("", "leftovers", null);
  assert.equal(row.meal, "meal");
  assert.equal(row.eaten_at, null);
});

// ---- writing: stating when ----

test("a food note can be created for a past day, with and without a time", () => {
  const withTime = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 }, undefined, {
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  assert.equal(withTime.date, localDaysAgo(1));
  assert.equal(withTime.eaten_at, "19:30");

  const withoutTime = repo.addFoodNote("snack", "", { summary: "Apple" }, undefined, { date: localDaysAgo(3) });
  assert.equal(withoutTime.date, localDaysAgo(3));
  assert.equal(withoutTime.eaten_at, null, "a snack has no representative hour to fall back on");

  // Persisted, not merely returned.
  assert.deepEqual(rowOf(withTime.id), { date: localDaysAgo(1), eaten_at: "19:30", meal: "dinner" });
});

test("a stated time names the meal when nobody named it", () => {
  const morning = repo.addFoodNote("meal", "", { summary: "Oats" }, undefined, { eaten_at: "07:15" });
  assert.equal(morning.meal, "breakfast");
  assert.equal(morning.eaten_at, "07:15");

  const evening = repo.addFoodNote("", "", { summary: "Pasta" }, undefined, { eaten_at: "19:45" });
  assert.equal(evening.meal, "dinner");

  const odd = repo.addFoodNote("food", "", { summary: "Handful of nuts" }, undefined, { eaten_at: "22:40" });
  assert.equal(odd.meal, "snack");
});

test("a label someone actually said is never overwritten by the clock", () => {
  // Night-shift breakfast at 22:00 stays breakfast. The windows are defaults for a
  // blank, not a verdict on when a person ought to eat.
  const row = repo.addFoodNote("breakfast", "", { summary: "Eggs" }, undefined, { eaten_at: "22:00" });
  assert.equal(row.meal, "breakfast");
  assert.equal(row.eaten_at, "22:00");

  const custom = repo.addFoodNote("post-workout", "", { summary: "Shake" }, undefined, { eaten_at: "12:10" });
  assert.equal(custom.meal, "post-workout", "an unrecognized label is still the athlete's word");
});

test("a stated meal label is never turned into a stored time", () => {
  // The honest direction only. A label is a CATEGORY — 21:00 genuinely is dinner —
  // but a clock time is a MEASUREMENT, and `eaten_at` renders straight to the
  // athlete. Deriving "12:30" from the word "lunch" would put a minute on screen
  // that nobody said, indistinguishable from one they did. getDayIntake still
  // places such an entry sensibly; it just does it with a read-time sort key.
  const back = repo.addFoodNote("dinner", "", { summary: "Curry" }, undefined, { date: localDaysAgo(2) });
  assert.equal(back.eaten_at, null, "a backdated named meal keeps an unknown time unknown");

  const live = repo.addFoodNote("dinner", "", { summary: "Curry" });
  assert.equal(live.eaten_at, null);

  // Only a time the athlete actually stated is ever stored.
  const stated = repo.addFoodNote("dinner", "", { summary: "Curry" }, undefined, {
    date: localDaysAgo(2),
    eaten_at: "20:45",
  });
  assert.equal(stated.eaten_at, "20:45");
});

// ---- validation ----
// The repo DEGRADES by default: most callers are model-driven, and a timestamp the
// model guessed wrong must never cost the athlete the meal. Strict rejection is
// opt-in via `lenient: false`, which the REST routes pass (asserted further down).

test("you cannot have eaten tomorrow — the day is pulled back, the meal is kept", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Steak" }, undefined, { date: localDaysAgo(-1) });
  assert.equal(row.date, localDaysAgo(0), "a future day falls back to today");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM food_notes`).get().n, 1, "and the entry is still saved");

  assert.throws(
    () => repo.addFoodNote("dinner", "", null, undefined, { date: localDaysAgo(-1), lenient: false }),
    /future/,
    "a caller that asked to be told is told"
  );
});

test("a malformed date or time is dropped, never silently reframed into something else", () => {
  const garbled = repo.addFoodNote("meal", "", { kcal: 100 }, undefined, { date: "last tuesday" });
  assert.equal(garbled.date, localDaysAgo(0), "an unparseable date falls back to today rather than throwing");

  const noTime = repo.addFoodNote("meal", "", { kcal: 100 }, undefined, { eaten_at: "half past nine" });
  assert.equal(noTime.eaten_at, null, "an unparseable time is simply not recorded");
  assert.equal(noTime.date, localDaysAgo(0));

  // Strict callers still get the reason.
  for (const [opts, pattern] of [
    [{ date: "07/24/2026" }, /YYYY-MM-DD/],
    [{ date: "2026-02-30" }, /real calendar date/],
    [{ eaten_at: "7:30 PM" }, /HH:MM/],
    [{ eaten_at: "25:00" }, /HH:MM/],
  ]) {
    assert.throws(() => repo.addFoodNote("dinner", "", null, undefined, { ...opts, lenient: false }), pattern);
  }
});

test("backdating is bounded at a year — far enough for any real catch-up", () => {
  const justInside = repo.addFoodNote("lunch", "", { summary: "Old entry" }, undefined, { date: localDaysAgo(365) });
  assert.equal(justInside.date, localDaysAgo(365));

  const tooOld = repo.addFoodNote("lunch", "", { summary: "Older" }, undefined, { date: localDaysAgo(366) });
  assert.equal(tooOld.date, localDaysAgo(0), "past the bound the date is dropped, not the meal");
  assert.throws(
    () => repo.addFoodNote("lunch", "", null, undefined, { date: localDaysAgo(366), lenient: false }),
    /365 days/
  );
});

test("empty-string date and time read as 'not stated', not as malformed", () => {
  // Form fields come back as "" when left blank; that is an omission, not an error.
  const row = repo.addFoodNote("lunch", "", { summary: "Salad" }, undefined, { date: "", eaten_at: "" });
  assert.equal(row.date, localDaysAgo(0));
  assert.equal(row.eaten_at, null);
});

// ---- the day's read sees it ----

test("a backdated entry lands in its own day's intake, not today's", () => {
  repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700, protein_g: 55 }, undefined, {
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  const yesterday = repo.getDayIntake(localDaysAgo(1));
  assert.equal(yesterday.count, 1);
  assert.equal(yesterday.totals.kcal, 700);
  assert.equal(yesterday.entries[0].eaten_at, "19:30", "the stated time reaches the day's entries");
  assert.equal(repo.getDayIntake(localDaysAgo(0)).count, 0, "and does not leak into today");
});

test("an entry with no stated time reads as null in the day's intake, never as midnight", () => {
  repo.addFoodNote("lunch", "", { summary: "Salad", kcal: 300 });
  assert.equal(repo.getDayIntake(localDaysAgo(0)).entries[0].eaten_at, null);
});

test("the displayed time is the time you ATE, not the moment you remembered it", () => {
  // This is the one that would ship visibly wrong: log last night's dinner this
  // morning and created_at is this morning. Showing that as the meal time is
  // simply false, so logged_at prefers the stated eating time.
  const row = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 }, undefined, {
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  const entry = repo.getDayIntake(localDaysAgo(1)).entries[0];
  assert.equal(entry.eaten_at, "19:30");
  assert.match(entry.logged_at, /^7:30\s?PM$/, "shows 7:30 PM, not this morning's capture time");
  assert.ok(
    !entry.logged_at.includes("yesterday"),
    "and not the write-time label, which would read as today's clock on yesterday's row"
  );
  assert.equal(entry.created_at, row.created_at, "the raw write instant is still there for anyone who needs it");
});

test("with no stated time the displayed time is exactly what it always was", () => {
  repo.addFoodNote("lunch", "", { summary: "Salad", kcal: 300 });
  const entry = repo.getDayIntake(localDaysAgo(0)).entries[0];
  assert.equal(entry.eaten_at, null);
  assert.equal(
    entry.logged_at,
    chatHistoryTimeLabel(entry.created_at),
    "an unstated time degrades to the write-time label — no behavior change at all"
  );
});

// ---- the day reads in the order it was eaten ----

test("a day is read in the order it was EATEN, not the order it was typed", () => {
  const d = localDaysAgo(1);
  // Deliberately inserted out of order: the dinner is remembered first.
  repo.addFoodNote("dinner", "", { summary: "Dinner", kcal: 800 }, undefined, { date: d, eaten_at: "20:30" });
  repo.addFoodNote("breakfast", "", { summary: "Breakfast", kcal: 400 }, undefined, { date: d, eaten_at: "07:15" });
  repo.addFoodNote("lunch", "", { summary: "Lunch", kcal: 600 }, undefined, { date: d, eaten_at: "12:45" });

  assert.deepEqual(
    repo.getDayIntake(d).entries.map((e) => e.summary),
    ["Breakfast", "Lunch", "Dinner"]
  );
});

test("a named meal with no time still sorts into its slot, and never gains a stored time", () => {
  const d = localDaysAgo(1);
  repo.addFoodNote("dinner", "", { summary: "Dinner" }, undefined, { date: d });
  repo.addFoodNote("breakfast", "", { summary: "Breakfast" }, undefined, { date: d });

  const order = repo.getDayIntake(d).entries.map((e) => e.summary);
  assert.deepEqual(order, ["Breakfast", "Dinner"], "the label's hour places it — for sorting only");
  for (const entry of repo.getDayIntake(d).entries) {
    assert.equal(entry.eaten_at, null, "sorting never writes an approximated time back to the row");
    assert.ok(!/AM|PM/.test(entry.logged_at) || entry.logged_at === chatHistoryTimeLabel(entry.created_at));
  }
});

test("entries nothing can place stay exactly where they were logged", () => {
  const d = localDaysAgo(1);
  repo.addFoodNote("dinner", "", { summary: "Dinner" }, undefined, { date: d });
  repo.addFoodNote("breakfast", "", { summary: "Breakfast" }, undefined, { date: d });
  repo.addFoodNote("meal", "", { summary: "Something" }, undefined, { date: d });
  repo.addFoodNote("meal", "", { summary: "Something else" }, undefined, { date: d });

  const order = repo.getDayIntake(d).entries.map((e) => e.summary);
  assert.ok(order.indexOf("Breakfast") < order.indexOf("Dinner"), "a named meal still sorts sensibly");
  assert.ok(
    order.indexOf("Something") < order.indexOf("Something else"),
    "two unplaceable entries keep the order they were logged in"
  );
});

test("a day where nothing can be placed keeps its exact previous order", () => {
  // "meal" and "snack" span disjoint hours, so neither has an honest approximate
  // time. Such a day must read exactly as it did before any of this existed.
  const d = localDaysAgo(1);
  for (const summary of ["First", "Second", "Third", "Fourth"]) {
    repo.addFoodNote(summary === "Second" ? "snack" : "meal", "", { summary }, undefined, { date: d });
  }
  assert.deepEqual(
    repo.getDayIntake(d).entries.map((e) => e.summary),
    ["First", "Second", "Third", "Fourth"]
  );
});

test("ordering is deterministic — the same day sorts the same way every time", () => {
  const d = localDaysAgo(1);
  repo.addFoodNote("meal", "", { summary: "Untimed A" }, undefined, { date: d });
  repo.addFoodNote("dinner", "", { summary: "Dinner" }, undefined, { date: d, eaten_at: "19:00" });
  repo.addFoodNote("meal", "", { summary: "Untimed B" }, undefined, { date: d });
  repo.addFoodNote("breakfast", "", { summary: "Breakfast" }, undefined, { date: d, eaten_at: "08:00" });

  const once = repo.getDayIntake(d).entries.map((e) => e.summary);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(
      repo.getDayIntake(d).entries.map((e) => e.summary),
      once,
      "no clock is read while sorting"
    );
  }
  // A leading unplaceable row stays first; the rest carry forward from the last
  // entry that could be placed.
  assert.equal(once[0], "Untimed A");
  assert.ok(once.indexOf("Breakfast") < once.indexOf("Dinner"));
  assert.ok(once.indexOf("Dinner") < once.indexOf("Untimed B"), "it was logged after the dinner, so it stays after");
});

test("a stated eating time renders the same shape as the write-time label", () => {
  // Both clocks land in one list, so "7:30 PM" from either source must be
  // character-identical — including en-US's narrow no-break space.
  const noon = new Date();
  noon.setHours(19, 30, 0, 0);
  assert.equal(clockLabel("19:30"), chatHistoryTimeLabel(noon, noon));
  assert.equal(clockLabel("nope"), "", "an unusable clock renders nothing to fall past");
});

test("a backdated write reaches the brain with the day it was EATEN, not the day it was typed", () => {
  resetBrainEventsForTest();
  const seen = [];
  const off = onBrainEvent((e) => seen.push(e));
  try {
    repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 }, undefined, {
      date: localDaysAgo(1),
      eaten_at: "19:30",
    });
    flushBrainEventsForTest(Date.now(), 0);
    const logged = seen.filter((e) => e.kind === "food_logged");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].date, localDaysAgo(1), "the event carries the meal's own day");
  } finally {
    off();
    resetBrainEventsForTest();
  }
});

// ---- the chat capture lane ----

test("the atomic chat capture can backdate and state a time too", () => {
  const turn = repo.createChatTurn({ message: "forgot to log last night's dinner" });
  const row = repo.addChatCaptureFoodNote({
    turn_id: turn.id,
    meal: "dinner",
    raw: "steak and potatoes",
    parsed: { summary: "Steak and potatoes", kcal: 800 },
    kind: "text",
    date: localDaysAgo(1),
    eaten_at: "20:15",
  });
  assert.deepEqual(rowOf(row.id), { date: localDaysAgo(1), eaten_at: "20:15", meal: "dinner" });
});

// ---- both protocol surfaces ----
// MCP ⊆ REST and the two stay near-mirror wrappers, so the FIELDS are asserted on
// both rather than trusted to stay in step. Their posture toward a bad value is
// deliberately different, and that difference is pinned here too: REST is where a
// person types a date, so it refuses and says why; MCP and chat are where a MODEL
// resolved one out of a sentence, so they drop it and still record the meal.

function restHandler(method, path) {
  for (const layer of nutritionRouter.stack) {
    const r = layer.route;
    if (r && r.path === path && r.methods[method]) return r.stack[r.stack.length - 1].handle;
  }
  throw new Error(`no ${method.toUpperCase()} ${path} route`);
}

const postFoodNote = (body) =>
  new Promise((resolve) => {
    const handle = restHandler("post", "/food-notes");
    let status = 200;
    handle(
      { body },
      {
        status(s) {
          status = s;
          return this;
        },
        json(payload) {
          resolve([status, payload]);
        },
      }
    );
  });

function mcpTool(name) {
  const tools = new Map();
  registerNutritionTools({ tool: (n, _desc, schema, handler) => tools.set(n, { schema, handler }) });
  const tool = tools.get(name);
  if (!tool) throw new Error(`no MCP tool ${name}`);
  return tool;
}

const callLogFoodNote = async (args) => JSON.parse((await mcpTool("log_food_note").handler(args)).content[0].text);
const callUpdateFoodNote = async (args) =>
  JSON.parse((await mcpTool("update_food_note").handler(args)).content[0].text);

const putFoodNote = (id, body) =>
  new Promise((resolve) => {
    const handle = restHandler("put", "/food-notes/:id");
    let status = 200;
    handle(
      { params: { id: String(id) }, body },
      {
        status(s) {
          status = s;
          return this;
        },
        json(payload) {
          resolve([status, payload]);
        },
      }
    );
  });

test("REST accepts date + eaten_at, and rejects an impossible one as a 400 with the reason", async () => {
  const [okStatus, created] = await postFoodNote({
    meal: "dinner",
    parsed: { summary: "Steak", kcal: 700 },
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  assert.equal(okStatus, 200);
  assert.equal(created.date, localDaysAgo(1));
  assert.equal(created.eaten_at, "19:30");

  const [plainStatus, plain] = await postFoodNote({ meal: "lunch", parsed: { summary: "Salad" } });
  assert.equal(plainStatus, 200);
  assert.equal(plain.date, localDaysAgo(0));
  assert.equal(plain.eaten_at, null, "omitting both keeps the old behavior exactly");

  // A 400 with the reason, not the global handler's opaque 500 — this is a rejected
  // input, not an unexpected server fault.
  const [futureStatus, future] = await postFoodNote({ meal: "dinner", date: localDaysAgo(-1) });
  assert.equal(futureStatus, 400);
  assert.match(future.error, /future/);

  const [timeStatus, badTime] = await postFoodNote({ meal: "dinner", eaten_at: "7:30 PM" });
  assert.equal(timeStatus, 400);
  assert.match(badTime.error, /HH:MM/);
});

test("the MCP log_food_note tool carries the same fields, but degrades where REST refuses", async () => {
  assert.deepEqual(Object.keys(mcpTool("log_food_note").schema).sort(), [
    "date",
    "eaten_at",
    "image_path",
    "meal",
    "parsed",
    "raw",
  ]);

  const created = await callLogFoodNote({
    meal: "dinner",
    parsed: { summary: "Steak", kcal: 700 },
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  assert.equal(created.date, localDaysAgo(1));
  assert.equal(created.eaten_at, "19:30");

  const inferred = await callLogFoodNote({ meal: "meal", parsed: { summary: "Oats" }, eaten_at: "07:15" });
  assert.equal(inferred.meal, "breakfast");

  const plain = await callLogFoodNote({ meal: "lunch", parsed: { summary: "Salad" } });
  assert.equal(plain.date, localDaysAgo(0));
  assert.equal(plain.eaten_at, null);

  // MCP is the MODEL's surface, so it degrades rather than refusing: a guessed
  // date that can't be true is dropped and the meal is still recorded. REST — the
  // surface a person fills in by hand — keeps its 400 (asserted above).
  const guessed = await callLogFoodNote({ meal: "dinner", parsed: { summary: "Steak" }, date: localDaysAgo(-1) });
  assert.equal(guessed.error, undefined, "a bad guess must never cost the athlete the entry");
  assert.equal(guessed.date, localDaysAgo(0));
  assert.equal((await callLogFoodNote({ meal: "dinner", eaten_at: "25:00" })).eaten_at, null);
});

test("REST can correct an entry's day and time, and refuses an impossible one", async () => {
  const created = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 });

  const [okStatus, moved] = await putFoodNote(created.id, { date: localDaysAgo(1), eaten_at: "19:30" });
  assert.equal(okStatus, 200);
  assert.equal(moved.date, localDaysAgo(1));
  assert.equal(moved.eaten_at, "19:30");

  const [badStatus, bad] = await putFoodNote(created.id, { date: localDaysAgo(-1) });
  assert.equal(badStatus, 400);
  assert.match(bad.error, /future/);
  assert.equal(rowOf(created.id).date, localDaysAgo(1), "the refused correction moved nothing");

  const [missingStatus] = await putFoodNote(999999, { eaten_at: "08:00" });
  assert.equal(missingStatus, 404, "an unknown id is still a 404, not a 400");
});

test("the MCP update tool carries the same fields and degrades on a bad guess", async () => {
  assert.ok(Object.keys(mcpTool("update_food_note").schema).includes("date"));
  assert.ok(Object.keys(mcpTool("update_food_note").schema).includes("eaten_at"));

  const created = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 });
  const moved = await callUpdateFoodNote({ id: created.id, date: localDaysAgo(1), eaten_at: "19:30" });
  assert.equal(moved.date, localDaysAgo(1));
  assert.equal(moved.eaten_at, "19:30");

  const guessed = await callUpdateFoodNote({ id: created.id, date: localDaysAgo(-1), kcal: 750 });
  assert.equal(guessed.error, undefined);
  assert.equal(guessed.date, localDaysAgo(1), "the impossible move is ignored");
  assert.equal(guessed.parsed.kcal, 750, "and the rest of the correction still lands");
});

test("a bad date in the chat capture degrades to today — the meal is never lost", () => {
  // The model resolves "when" from a whole sentence, so its date is the untrusted
  // edge. Losing the food entry over a guessed timestamp would be far worse than
  // filing it on the day it was mentioned, so this lane degrades instead of throwing.
  const turn = repo.createChatTurn({ message: "log this" });
  const row = repo.addChatCaptureFoodNote({
    turn_id: turn.id,
    meal: "dinner",
    raw: "steak",
    parsed: { summary: "Steak", kcal: 700 },
    kind: "text",
    date: localDaysAgo(-1), // tomorrow — impossible
    eaten_at: "half past six", // and not a wall clock either
  });
  assert.equal(row.date, localDaysAgo(0), "the impossible date falls back to today");
  assert.equal(row.eaten_at, null, "the unusable time is simply dropped");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM food_notes`).get().n, 1, "the meal is still captured");
  assert.equal(
    db.prepare(`SELECT capture_food_note_id AS id FROM chat_turns WHERE id = ?`).get(turn.id).id,
    row.id,
    "and the turn is still linked to it"
  );
});

// ---- correcting an entry after the fact ----

test("updateFoodNote moves an entry to the day and time it actually happened", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 });
  assert.equal(row.date, localDaysAgo(0));

  const moved = repo.updateFoodNote(row.id, { date: localDaysAgo(1), eaten_at: "19:30" });
  assert.deepEqual(rowOf(moved.id), { date: localDaysAgo(1), eaten_at: "19:30", meal: "dinner" });
  assert.equal(repo.getDayIntake(localDaysAgo(1)).count, 1, "it now counts toward the day it was eaten");
  assert.equal(repo.getDayIntake(localDaysAgo(0)).count, 0, "and no longer toward the day it was typed");
});

test("each half of the correction moves independently, and a macro fix restamps neither", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Steak", kcal: 700 }, undefined, {
    date: localDaysAgo(2),
    eaten_at: "19:30",
  });

  // Time only — the day stays put.
  repo.updateFoodNote(row.id, { eaten_at: "20:15" });
  assert.deepEqual(rowOf(row.id), { date: localDaysAgo(2), eaten_at: "20:15", meal: "dinner" });

  // Day only — the time stays put.
  repo.updateFoodNote(row.id, { date: localDaysAgo(3) });
  assert.deepEqual(rowOf(row.id), { date: localDaysAgo(3), eaten_at: "20:15", meal: "dinner" });

  // Neither — correcting a macro must not restamp the clock.
  const fixed = repo.updateFoodNote(row.id, { kcal: 750 });
  assert.deepEqual(rowOf(row.id), { date: localDaysAgo(3), eaten_at: "20:15", meal: "dinner" });
  assert.equal(fixed.parsed.kcal, 750);
});

test("an explicit blank unstates a time; a blank date is not a way to unstate a day", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Steak" }, undefined, {
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });
  repo.updateFoodNote(row.id, { eaten_at: "" });
  assert.equal(rowOf(row.id).eaten_at, null, "'I don't actually recall when' is a real correction");

  repo.updateFoodNote(row.id, { date: "" });
  assert.equal(rowOf(row.id).date, localDaysAgo(1), "every entry belongs to some day — a blank changes nothing");
});

test("correcting the time never renames the meal", () => {
  // The row already carries a label someone chose. Inference fills blanks on
  // create; it must not reach back and overwrite an existing label later.
  const row = repo.addFoodNote("breakfast", "", { summary: "Eggs" });
  repo.updateFoodNote(row.id, { eaten_at: "19:30" });
  assert.equal(rowOf(row.id).meal, "breakfast");
});

test("an impossible correction is ignored while the rest of it still lands", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Steak" }, undefined, {
    date: localDaysAgo(1),
    eaten_at: "19:30",
  });

  const degraded = repo.updateFoodNote(row.id, { date: localDaysAgo(-1), eaten_at: "nope", kcal: 750 });
  assert.equal(degraded.date, localDaysAgo(1), "the impossible move is ignored — the row keeps its day");
  assert.equal(degraded.eaten_at, "19:30", "and its stored time");
  assert.equal(degraded.parsed.kcal, 750, "while the rest of the correction still applies");

  // A caller that asked to be told is told, and nothing moves.
  assert.throws(() => repo.updateFoodNote(row.id, { date: localDaysAgo(-1), lenient: false }), /future/);
  assert.throws(() => repo.updateFoodNote(row.id, { eaten_at: "7:30 PM", lenient: false }), /HH:MM/);
  assert.deepEqual(rowOf(row.id), { date: localDaysAgo(1), eaten_at: "19:30", meal: "dinner" });
});

test("editing an old entry never trips the backdate bound", () => {
  // The bound guards what a caller may newly STATE, not what is already stored —
  // an entry older than the window has to stay editable.
  const row = repo.addFoodNote("lunch", "", { summary: "Old" }, undefined, { date: localDaysAgo(365) });
  const fixed = repo.updateFoodNote(row.id, { kcal: 500 });
  assert.equal(fixed.date, localDaysAgo(365));
  assert.equal(fixed.parsed.kcal, 500);
});
