// The week's fuel strip under Train › Intake's energy meter (fuel-today-model's `week`,
// fuel-week-client.ts, fuel-today-controller.ts): seven columns around one average line,
// today marked, lived days told from days ahead, each day's work as one small word, the
// chosen day's number and sentence in place, and a complete logged day as a quiet tick —
// never a verdict. An older read without the week renders exactly as before. Renderer,
// model and controller on the shared DOM harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-04-25"; // a Saturday
const MONDAY = "2026-04-20";

function load() {
  return loadClientModule([
    "html-utils",
    "date-utils",
    "ui-actions-client",
    "fuel-today-model",
    "fuel-week-client",
    "fuel-today-client",
    "fuel-today-controller",
  ]);
}

const at = (i) => {
  const d = new Date(`${MONDAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fuelWeek(overrides = {}) {
  const shifts = [-100, 50, -100, 50, 0, 300, -200];
  const tags = ["Rest", "Lift", "Rest", "Lift", "Rest", "Long", "Rest"];
  const days = shifts.map((shift, i) => ({
    date: at(i),
    weekday: DOW[i],
    kcal: 2160 + shift,
    shift_kcal: shift,
    outcome_shift_kcal: 0,
    work: tags[i] === "Lift" ? ["lifting"] : tags[i] === "Long" ? ["the long run"] : [],
    outcome_work: [],
    tag: tags[i],
    words: shift ? `Day ${i} sentence.` : null,
    when: at(i) < TODAY ? "past" : at(i) === TODAY ? "today" : "ahead",
    logged_kcal: i === 0 ? 2240 : null,
  }));
  return {
    week_of: MONDAY,
    average_kcal: 2160,
    week_kcal: 15120,
    logged_extra_kcal: 0,
    days,
    words: "The week averages 2,160. Saturday carries more for the long run, Sunday less.",
    sum_words: "The seven days add up to 15,120, seven times the average.",
    ...overrides,
  };
}

function day(overrides = {}) {
  return {
    date: TODAY,
    count: 2,
    totals: { kcal: 844, protein_g: 78, carbs_g: 90, fat_g: 25, fiber_g: 9 },
    known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
    target: {
      kcal: 2460,
      protein_g: 175,
      average_kcal: 2160,
      day_shift_kcal: 300,
      day_words:
        "Today's number is about 2,460 kcal: your 2,160 average plus about 300 for the long run. The week still averages 2,160.",
    },
    remaining: { kcal: 1616, protein_g: 97 },
    entries: [
      { id: 7, summary: "Eggs & oats", meal: "breakfast", kcal: 620, protein_g: 45 },
      { id: 8, summary: "Shake", meal: "snack", kcal: 224, protein_g: 33 },
    ],
    ...overrides,
  };
}

const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

function paint(win, d, opts = {}) {
  const model = win.CairnFuelTodayModel.todayModel(d, null, { today: TODAY });
  return renderHtml(win.CairnFuelToday.todayHtml(model, opts), { document: win.document });
}

test("the strip draws seven days around one average line, today marked, lived days told from days ahead", () => {
  const win = load();
  const host = paint(win, day({ fuel_week: fuelWeek() }));
  const strip = host.querySelector(".fuel-week");
  assert.ok(strip, "the strip renders under the meters");
  assert.equal(text(host.querySelector(".fuel-week-words")).startsWith("The week averages 2,160."), true);
  assert.equal(host.querySelectorAll(".fuel-week-avg").length, 1, "one average line across");
  const cols = host.querySelectorAll(".fuel-week-day");
  assert.equal(cols.length, 7);
  assert.deepEqual(
    cols.map((c) => text(c.querySelector(".fuel-week-dow"))),
    DOW
  );
  assert.deepEqual(
    cols.map((c) => text(c.querySelector(".fuel-week-tag"))),
    ["Rest", "Lift", "Rest", "Lift", "Rest", "Long", "Rest"]
  );
  assert.ok(cols.every((c) => c.tagName === "BUTTON" && c.getAttribute("type") === "button"));
  const todayCol = host.querySelectorAll(".fuel-week-day.is-today");
  assert.equal(todayCol.length, 1);
  assert.equal(todayCol[0].getAttribute("data-fuel-week-day"), TODAY);
  assert.equal(todayCol[0].getAttribute("aria-pressed"), "true", "today is the chosen day until a tap");
  assert.equal(host.querySelectorAll(".fuel-week-day.is-past").length, 5);
  assert.equal(host.querySelectorAll(".fuel-week-day.is-ahead").length, 1);
  // The bars: up for more, down for less, a mark on the line at the average, to one scale.
  const bars = cols.map((c) => c.querySelector(".fuel-week-bar"));
  assert.ok(
    bars[5].classList.contains("is-up") &&
      bars[6].classList.contains("is-down") &&
      bars[4].classList.contains("is-flat")
  );
  assert.match(bars[5].getAttribute("style"), /^--h:0\.926$/, "the long run's 300 on a 324 scale (15% of 2,160)");
  // Today's sentence is said once, under the strip, with its number readable.
  assert.equal(text(host.querySelector(".fuel-week-pick")), "Today 2,460 kcal");
  assert.equal(text(host.querySelector(".fuel-week-say")), "Day 5 sentence.");
  assert.equal(host.querySelector(".fuel-today-daynum"), null, "the day's sentence is not printed twice");
  // Words for assistive tech: each column says its day, number and work; the bars are pictures.
  assert.equal(cols[5].getAttribute("aria-label"), "Saturday, today: 2,460 kcal, for the long run");
  assert.ok(host.querySelectorAll(".fuel-week-plot").every((p) => p.getAttribute("aria-hidden") === "true"));
  assert.match(text(host.querySelector(".fuel-week-words")), /seven times the average/);
});

test("a complete logged day is a quiet tick and a plain line, never a verdict", () => {
  const win = load();
  const host = paint(win, day({ fuel_week: fuelWeek() }));
  const ticks = host.querySelectorAll(".fuel-week-tick");
  assert.equal(ticks.length, 1, "only the complete day carries what was logged");
  assert.equal(ticks[0].closest(".fuel-week-day").getAttribute("data-fuel-week-day"), MONDAY);
  const monday = host.querySelector(`[data-fuel-week-day="${MONDAY}"]`);
  assert.equal(monday.getAttribute("aria-label"), "Monday: 2,060 kcal, about 2,240 logged");
  assert.doesNotMatch(text(host.querySelector(".fuel-week")), /%|score|\bover\b|\bunder\b|\blow\b|great|missed/i);
  // A day ahead never carries a logged amount, whatever the read says.
  const odd = fuelWeek();
  odd.days[6].logged_kcal = 1800;
  assert.equal(paint(win, day({ fuel_week: odd })).querySelectorAll(".fuel-week-tick").length, 1);
});

test("hostile text comes back as text", () => {
  const win = load();
  const w = fuelWeek({ words: "<b>bold</b> week", sum_words: "<i>sum</i>" });
  w.days[5].words = "<img src=x onerror=alert(1)>";
  w.days[5].tag = "<em>Long</em>";
  w.days[5].weekday = '"Sat"><b>x</b>';
  const host = paint(win, day({ fuel_week: w }));
  assert.deepEqual(
    host.querySelectorAll(".fuel-week b").map((b) => b.className),
    ["numeral"],
    "only the number's own bold"
  );
  assert.equal(host.querySelector(".fuel-week img"), null);
  assert.equal(host.querySelector(".fuel-week em"), null);
  assert.equal(host.querySelector(".fuel-week i.fuel-week-avg") != null, true);
  assert.match(text(host.querySelector(".fuel-week-words")), /<b>bold<\/b> week/);
  assert.equal(text(host.querySelector(".fuel-week-say")), "<img src=x onerror=alert(1)>");
});

test("a read without the week, or with a week that does not hold the day, renders exactly as before", () => {
  const win = load();
  const before = win.CairnFuelToday.todayHtml(win.CairnFuelTodayModel.todayModel(day(), null, { today: TODAY }));
  const host = renderHtml(before, { document: win.document });
  assert.equal(host.querySelector(".fuel-week"), null);
  assert.equal(text(host.querySelector(".fuel-today-daynum")), day().target.day_words);
  for (const fuel_week of [
    null,
    fuelWeek({ days: fuelWeek().days.slice(0, 6) }),
    fuelWeek({
      week_of: "2026-04-27",
      days: fuelWeek().days.map((d) => ({ ...d, date: d.date.replace("2026-04-2", "2026-05-0") })),
    }),
  ]) {
    const model = win.CairnFuelTodayModel.todayModel(day({ fuel_week }), null, { today: TODAY });
    assert.equal(model.week, null);
    assert.equal(win.CairnFuelToday.todayHtml(model), before, "the same markup as an older read");
  }
});

test("a day at the average says where it sits; an empty day still shows the week", () => {
  const win = load();
  const host = paint(
    win,
    day({
      fuel_week: fuelWeek(),
      count: 0,
      entries: [],
      totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    }),
    {
      selected: at(4),
    }
  );
  assert.ok(host.querySelector(".fuel-today-empty"));
  assert.equal(text(host.querySelector(".fuel-week-pick")), "Friday 2,160 kcal");
  assert.equal(text(host.querySelector(".fuel-week-say")), "That day sat at the week's 2,160 average.");
});

function harness(read) {
  const win = load();
  const store = new Map();
  const deps = {
    date: TODAY,
    today: TODAY,
    peekCached: (key) => store.get(key) ?? null,
    cachedApi: async (path, options) => {
      const data = path.startsWith("/nutrition/day") ? read() : { kind: "observation", status: "too_few_days" };
      store.set(options.key, { data, fresh: true });
      return data;
    },
    swrInvalidate: (key) => store.delete(key),
    reducedMotion: () => true,
  };
  const host = createHost(win.document);
  return { win, host, handle: () => win.CairnFuelTodayController.mount(host, deps) };
}

test("a tap on a day says its number and sentence in place, and a refresh keeps the chosen day", async () => {
  let current = day({ fuel_week: fuelWeek() });
  const h = harness(() => current);
  const handle = h.handle();
  await flush();
  assert.equal(text(h.host.querySelector(".fuel-week-say")), "Day 5 sentence.");
  const thursday = h.host.querySelector(`[data-fuel-week-day="${at(3)}"]`);
  await thursday.click();
  assert.equal(thursday.getAttribute("aria-pressed"), "true");
  assert.equal(h.host.querySelector(`[data-fuel-week-day="${TODAY}"]`).getAttribute("aria-pressed"), "false");
  assert.equal(text(h.host.querySelector(".fuel-week-pick")), "Thursday 2,210 kcal");
  assert.equal(text(h.host.querySelector(".fuel-week-say")), "Day 3 sentence.");
  assert.equal(
    h.host.querySelector(`[data-fuel-week-day="${at(3)}"]`),
    thursday,
    "the column itself stays, so focus does"
  );
  await h.host.querySelector(`[data-fuel-week-day="${MONDAY}"]`).click();
  assert.equal(text(h.host.querySelector(".fuel-week-logged")), "About 2,240 kcal logged.");
  // Something else on the card changes: the strip repaints and keeps Monday chosen.
  current = day({ fuel_week: fuelWeek(), totals: { ...day().totals, protein_g: 120 } });
  await handle.refresh();
  await flush();
  assert.equal(h.host.querySelector(`[data-fuel-week-day="${MONDAY}"]`).getAttribute("aria-pressed"), "true");
  assert.equal(text(h.host.querySelector(".fuel-week-pick")), "Monday 2,060 kcal");
});

test("the strip enters once, on a cold paint without reduced motion, and never on a repaint", () => {
  const win = load();
  const model = win.CairnFuelTodayModel.todayModel(day({ fuel_week: fuelWeek() }), null, { today: TODAY });
  assert.ok(
    renderHtml(win.CairnFuelToday.todayHtml(model, { countUp: true }), { document: win.document }).querySelector(
      ".fuel-week.is-entering"
    )
  );
  assert.equal(
    renderHtml(win.CairnFuelToday.todayHtml(model), { document: win.document }).querySelector(".fuel-week.is-entering"),
    null
  );
});
