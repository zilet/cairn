// People log food out of order. They remember last night's dinner over this
// morning's coffee, and they say so in ordinary words — "a late dinner last night
// around 9". These cases pin the whole path that has to hold for that to work:
// the wall-clock helpers, the write, the read, the correction, and — the one that
// bites hardest — the instant-capture lane, which runs with NO agent and would
// otherwise file last night's dinner under today.
//
// The governing product rule throughout: understand and approximate, never
// interrogate. An entry with no time is a first-class entry, everywhere.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { approxTimeForMealLabel, clockLabel, localDateISO, mealLabelForTime } from "../dist/repo/shared.js";
import { applyChatActions, isInstantFoodCaptureDecision, mentionsWhen } from "../dist/chatTurns.js";
import { classifyChatRoute } from "../dist/chatRouting.js";

beforeEach(() => {
  resetTables("food_notes", "chat_turns", "chat_messages", "day_reads");
  repo.setSettings({ enrich_enabled: false });
});

// ---------- the wall-clock helpers ----------

test("mealLabelForTime names the meal an hour belongs to, and refuses to guess from noise", () => {
  assert.equal(mealLabelForTime("08:00"), "breakfast");
  assert.equal(mealLabelForTime("12:30"), "lunch");
  assert.equal(mealLabelForTime("21:00"), "dinner", "a late plate is still dinner");
  assert.equal(mealLabelForTime("15:30"), "snack", "the between-meals hours are a snack, not a late lunch");
  assert.equal(mealLabelForTime("23:30"), "snack");
  // Nothing parseable means no answer at all — never a default slot.
  for (const bad of ["", null, undefined, "9pm", "25:00", "12:99", "noon"]) {
    assert.equal(mealLabelForTime(bad), null, `refuses to invent a slot from ${JSON.stringify(bad)}`);
  }
});

test("approxTimeForMealLabel approximates a named meal, and returns nothing when it cannot", () => {
  assert.equal(approxTimeForMealLabel("dinner"), "19:00");
  assert.equal(approxTimeForMealLabel("Breakfast"), "08:00", "case-insensitive");
  // "meal" and "snack" span disjoint hours — no honest single approximation exists,
  // and storing a fabricated time is worse than storing none.
  assert.equal(approxTimeForMealLabel("meal"), null);
  assert.equal(approxTimeForMealLabel("snack"), null);
  assert.equal(approxTimeForMealLabel(null), null);
});

test("clockLabel says a stored time the way a person does", () => {
  assert.equal(clockLabel("21:00"), "9:00 PM");
  assert.equal(clockLabel("08:05"), "8:05 AM");
  assert.equal(clockLabel("00:15"), "12:15 AM", "midnight reads as 12, never 0");
  assert.equal(clockLabel("12:00"), "12:00 PM", "noon reads as 12 PM, never 0 PM");
  assert.equal(clockLabel(null), "", "no time renders as nothing — never a dash or a placeholder");
});

// ---------- writing a meal that happened earlier ----------

test("a meal can be logged for the day it was actually eaten, with the hour it was eaten", () => {
  const yesterday = localDaysAgo(1);
  const row = repo.addFoodNote("dinner", "", { summary: "Steak and potatoes", kcal: 900 }, undefined, {
    date: yesterday,
    eaten_at: "21:00",
  });
  assert.equal(row.date, yesterday, "it lands on yesterday, not on the day it was typed");
  assert.equal(row.eaten_at, "21:00");

  const day = repo.getDayIntake(yesterday);
  assert.equal(day.count, 1);
  assert.equal(day.totals.kcal, 900);
  assert.equal(day.entries[0].eaten_at, "21:00");
  assert.match(
    day.entries[0].logged_at,
    /9:00\s*PM/i,
    "the displayed time speaks the eaten time, not the moment the row was written"
  );
  assert.equal(repo.getDayIntake(localDateISO()).count, 0, "and it is NOT on today");
});

test("an entry with no time is completely ordinary — stored, read, and rendered as nothing", () => {
  const row = repo.addFoodNote("lunch", "", { summary: "Leftovers", kcal: 500 });
  assert.equal(row.eaten_at, null);

  const entry = repo.getDayIntake(localDateISO()).entries[0];
  assert.equal(entry.eaten_at, null, "no time is recorded, and nothing is invented to fill the gap");
  assert.ok(entry.logged_at, "it still falls back to the write time, so the coach is never time-blind");
});

test("a garbled time is dropped and a future day is pulled back — neither costs the athlete the meal", () => {
  const noTime = repo.addFoodNote("meal", "", { kcal: 100 }, undefined, { eaten_at: "half past nine" });
  assert.equal(noTime.eaten_at, null, "unparseable time is simply not recorded");
  assert.equal(noTime.date, localDateISO(), "and the entry is still saved");

  const future = repo.addFoodNote("meal", "", { kcal: 100 }, undefined, { date: localDaysAgo(-3) });
  assert.equal(future.date, localDateISO(), "a meal cannot be eaten in the future");

  const garbled = repo.addFoodNote("meal", "", { kcal: 100 }, undefined, { date: "last tuesday" });
  assert.equal(garbled.date, localDateISO(), "an unparseable date falls back to today rather than throwing");
});

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

test("entries with no time keep their original order and sort by their meal slot", () => {
  const d = localDaysAgo(1);
  repo.addFoodNote("dinner", "", { summary: "Dinner" }, undefined, { date: d });
  repo.addFoodNote("breakfast", "", { summary: "Breakfast" }, undefined, { date: d });
  repo.addFoodNote("meal", "", { summary: "Something" }, undefined, { date: d });
  repo.addFoodNote("meal", "", { summary: "Something else" }, undefined, { date: d });

  const order = repo.getDayIntake(d).entries.map((e) => e.summary);
  assert.ok(
    order.indexOf("Breakfast") < order.indexOf("Dinner"),
    "a named meal still sorts sensibly without a recorded time"
  );
  assert.ok(
    order.indexOf("Something") < order.indexOf("Something else"),
    "two unplaceable entries keep the order they were logged in"
  );
  for (const entry of repo.getDayIntake(d).entries) {
    assert.equal(entry.eaten_at, null, "sorting never writes an approximated time back to the row");
  }
});

// ---------- correcting an entry after the fact ----------

test("an entry's day and time can both be corrected later", () => {
  const row = repo.addFoodNote("dinner", "", { summary: "Curry", kcal: 700 });
  const yesterday = localDaysAgo(1);

  const moved = repo.updateFoodNote(row.id, { date: yesterday, eaten_at: "21:30" });
  assert.equal(moved.date, yesterday);
  assert.equal(moved.eaten_at, "21:30");
  assert.equal(repo.getDayIntake(yesterday).count, 1, "it moved to the right day");
  assert.equal(repo.getDayIntake(localDateISO()).count, 0, "and left the day it was on");

  const retimed = repo.updateFoodNote(row.id, { eaten_at: "20:00" });
  assert.equal(retimed.eaten_at, "20:00");
  assert.equal(retimed.date, yesterday, "correcting only the time leaves the day alone");

  const cleared = repo.updateFoodNote(row.id, { eaten_at: null });
  assert.equal(cleared.eaten_at, null, "an explicit null clears a time that turned out to be wrong");
  assert.equal(cleared.date, yesterday);
});

test("correcting only the food leaves an entry's recorded day and time untouched", () => {
  const yesterday = localDaysAgo(1);
  const row = repo.addFoodNote("dinner", "", { summary: "Curry" }, undefined, {
    date: yesterday,
    eaten_at: "21:00",
  });
  const updated = repo.updateFoodNote(row.id, { summary: "Chicken curry", kcal: 750 });
  assert.equal(updated.date, yesterday, "an omitted field means 'leave it alone', not 'clear it'");
  assert.equal(updated.eaten_at, "21:00");
  assert.equal(updated.parsed.summary, "Chicken curry");
});

test("moving an entry between days busts the cached Brief for BOTH days", () => {
  const yesterday = localDaysAgo(1);
  const today = localDateISO();
  const row = repo.addFoodNote("dinner", "", { summary: "Curry", kcal: 700 });

  // Place a cached read on each day, then move the entry off today and onto
  // yesterday. The day it LEFT is the one a naive implementation forgets.
  for (const date of [today, yesterday]) {
    repo.saveDayRead(date, { kind: "train", headline: "Old read", why: "stale" });
    assert.ok(repo.getCachedDayRead(date), `precondition: a read is cached for ${date}`);
  }
  repo.updateFoodNote(row.id, { date: yesterday });

  assert.equal(repo.getCachedDayRead(yesterday), null, "the day it moved TO is recomputed");
  assert.equal(repo.getCachedDayRead(today), null, "and so is the day it LEFT, which no longer has that meal");
});

// ---------- the instant-capture lane (no agent runs here) ----------

test("a plain right-now log still takes the fast receipt path", () => {
  const message = "Log turkey and rice for lunch";
  assert.equal(mentionsWhen(message), false);
  assert.equal(isInstantFoodCaptureDecision(classifyChatRoute({ message, has_image: false }), message), true);
});

test("a meal placed in time never takes the agent-free bypass", () => {
  // Each of these would otherwise be filed under TODAY with no time, because the
  // instant lane stamps localDateISO() and runs no model at all.
  const timed = [
    "I had a late dinner last night around 9",
    "ate a burrito yesterday at 8",
    "had eggs this morning",
    "logged a protein shake a couple hours ago",
    "had lunch yesterday",
    "ate a sandwich at 1:30",
    "had a bowl of soup 20 minutes ago",
  ];
  for (const message of timed) {
    assert.equal(mentionsWhen(message), true, `"${message}" mentions when`);
    const routing = classifyChatRoute({ message, has_image: false });
    assert.equal(
      isInstantFoodCaptureDecision(routing, message),
      false,
      `"${message}" must reach the agent, which resolves the day and hour from DATA.now`
    );
  }
});

test("mentionsWhen does not fire on ordinary food words that merely look numeric", () => {
  for (const message of ["ate 2 eggs and toast", "had a protein shake", "log 200g chicken"]) {
    assert.equal(mentionsWhen(message), false, `"${message}" places nothing in time`);
  }
});

// ---------- the whole path, as the athlete experiences it ----------

test("'I had a late dinner last night around 9' lands on yesterday, at 9, with no follow-up question", () => {
  const message = "I had a late dinner last night around 9 — steak and potatoes";
  const yesterday = localDaysAgo(1);

  // 1. It must not be swallowed by the agent-free receipt lane.
  assert.equal(isInstantFoodCaptureDecision(classifyChatRoute({ message, has_image: false }), message), false);

  // 2. The agent resolves the words against DATA.now and emits the day and hour.
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "log_food",
          meal: "dinner",
          summary: "Steak and potatoes",
          kcal: 900,
          protein_g: 60,
          date: yesterday,
          eaten_at: "21:00",
        },
      ],
    },
    { agent: "stub", message }
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "log_food");
  assert.equal(applied[0].result.date, yesterday, "filed under the night it was eaten");
  assert.equal(applied[0].result.eaten_at, "21:00");

  const day = repo.getDayIntake(yesterday);
  assert.equal(day.count, 1);
  assert.equal(day.entries[0].eaten_at, "21:00");
  assert.equal(repo.getDayIntake(localDateISO()).count, 0);
});

test("an agent that says nothing about when still logs a perfectly good entry", () => {
  // The contract has to survive the model omitting both fields entirely — that is
  // the common case, not an error path.
  const { applied } = applyChatActions(
    { actions: [{ type: "log_food", meal: "lunch", summary: "Chicken bowl", kcal: 600 }] },
    { agent: "stub", message: "chicken bowl for lunch" }
  );

  assert.equal(applied[0].result.date, localDateISO(), "today, as before");
  assert.equal(applied[0].result.eaten_at, null, "and simply no time");
  assert.equal(repo.getDayIntake(localDateISO()).entries[0].eaten_at, null);
});

test("a time with no meal name lands in the right slot without anyone being asked", () => {
  const { applied } = applyChatActions(
    { actions: [{ type: "log_food", summary: "Bowl of chili", kcal: 500, eaten_at: "20:30" }] },
    { agent: "stub", message: "had a bowl of chili at 8:30" }
  );

  assert.equal(applied[0].result.meal, "dinner", "the hour names the meal");
  assert.equal(applied[0].result.eaten_at, "20:30");
});

test("'that was actually yesterday' moves an existing entry through the ordinary update path", () => {
  const note = repo.addFoodNote("dinner", "", { summary: "Curry", kcal: 700 });
  const yesterday = localDaysAgo(1);

  const { applied } = applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, date: yesterday, eaten_at: "21:30" }] },
    { agent: "stub", message: "that curry was actually last night around 9:30" }
  );

  assert.equal(applied[0].result.date, yesterday);
  assert.equal(applied[0].result.eaten_at, "21:30");
  assert.equal(repo.getDayIntake(yesterday).count, 1);
  assert.equal(repo.getDayIntake(localDateISO()).count, 0, "and it is gone from the day it was wrongly on");
});

test("'actually I don't remember when' can unstate a time from chat", () => {
  // updateFoodNote treats an explicit null as "unstate", and the action contract
  // offers it — but only if null SURVIVES the action lane. Collapsing it to
  // undefined on the way through would silently make this correction unreachable
  // from the one surface capture actually lives on.
  const yesterday = localDaysAgo(1);
  const note = repo.addFoodNote("dinner", "", { summary: "Curry" }, undefined, {
    date: yesterday,
    eaten_at: "21:00",
  });

  const { applied } = applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, eaten_at: null }] },
    { agent: "stub", message: "actually I don't remember when I had that curry" }
  );

  assert.equal(applied[0].result.eaten_at, null, "the time is unstated");
  assert.equal(applied[0].result.date, yesterday, "and the day it belongs to is untouched");
});

test("a macro-only correction from chat never restamps the clock", () => {
  const yesterday = localDaysAgo(1);
  const note = repo.addFoodNote("dinner", "", { summary: "Curry" }, undefined, {
    date: yesterday,
    eaten_at: "21:00",
  });

  const { applied } = applyChatActions(
    { actions: [{ type: "update_food_note", id: note.id, kcal: 820 }] },
    { agent: "stub", message: "that curry was more like 820 calories" }
  );

  assert.equal(applied[0].result.eaten_at, "21:00", "an omitted field is 'leave it alone', not 'clear it'");
  assert.equal(applied[0].result.date, yesterday);
});
