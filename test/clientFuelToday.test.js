// Today · so far, the card Train › Intake opens on (fuel-today-model/-client/-controller.ts).
// Protein then energy as slim meters beside the day's number, carbs · fat · fiber as plain
// numbers, each with its unit and never a score; a partial day reads "in progress" and never "low"; the athlete's own
// observed intake band in the server's words only when there is one; and, today only,
// the big-day and carb-range lines (ported from the retired day-fuel card). Renderer,
// model and controller all run on the shared DOM harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-04-25";

function load(globals = {}) {
  const win = loadClientModule(
    ["html-utils", "date-utils", "ui-actions-client", "fuel-today-model", "fuel-today-client", "fuel-today-controller"],
    { globals }
  );
  return win;
}

function day(overrides = {}) {
  return {
    date: TODAY,
    count: 2,
    totals: { kcal: 844.4, protein_g: 77.6, carbs_g: 90, fat_g: 25, fiber_g: 9.2 },
    known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
    target: { kcal: 2600, protein_g: 175 },
    remaining: { kcal: 1756, protein_g: 97 },
    entries: [
      { id: 7, summary: "Eggs & oats", meal: "breakfast", kcal: 620, protein_g: 45 },
      { id: 8, summary: "Shake", meal: "snack", kcal: 224, protein_g: 33 },
    ],
    ...overrides,
  };
}

function band(overrides = {}) {
  return {
    kind: "observation",
    status: "ok",
    protein_anchor: { protein_g: 170, source: "formula", words: "Protein comes first: about 170 g a day." },
    band: { low_kcal: 1900, high_kcal: 2300, low_is_loss_edge: true, high_is_gain_edge: true, mixed: false },
    words:
      "Your weight trended down in weeks averaging up to 1,900 kcal. This is what your logged weeks showed, not a target.",
    ...overrides,
  };
}

function paint(win, d, b = null) {
  const model = win.CairnFuelTodayModel.todayModel(d, b, { today: TODAY });
  return renderHtml(win.CairnFuelToday.todayHtml(model), { document: win.document });
}

// ---------- model + renderer ----------

const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

test("protein then energy as slim meters beside the day's number; carbs, fat and fiber as plain numbers", () => {
  const win = load();
  const host = paint(win, day(), band());
  assert.equal(text(host.querySelector(".fuel-today-title")), "Today · so far");
  const labels = host.querySelectorAll(".fuel-today-m dt").map((dt) => dt.textContent);
  assert.deepEqual(labels, ["Protein", "Energy"]);
  const values = host.querySelectorAll(".fuel-today-meters .fuel-today-value").map(text);
  assert.deepEqual(values, ["78 / 170 g", "844 / 2,600 kcal"], "the band read's anchor, the day's energy target");
  // Each meter's text equivalent; the bar itself is hidden from assistive tech.
  const spoken = host.querySelectorAll(".fuel-today-meters .sr-only").map(text);
  assert.deepEqual(spoken, ["78 g logged of the day's 170 g", "844 kcal logged of the day's 2,600 kcal"]);
  const bars = host.querySelectorAll(".fuel-today-bar");
  assert.equal(bars.length, 2);
  assert.ok(bars.every((bar) => bar.getAttribute("aria-hidden") === "true"));
  assert.match(host.querySelector(".fuel-today-fill").getAttribute("style"), /^--p:0\.459$/);
  assert.equal(text(host.querySelector(".fuel-today-macros")), "Carbs 90 g · Fat 25 g · Fiber 9 g");
  assert.equal(host.querySelectorAll(".fuel-today-macros .fuel-today-bar").length, 0, "no bars on the plain numbers");
  assert.equal(host.querySelector(".fuel-today-togo").textContent, "92 g protein to go");
  assert.doesNotMatch(host.textContent, /\bscore\b|\/100|%/i, "no score, no percentage");
});

test("a macro with no day's number to set it against is the value alone, with no bar", () => {
  const win = load();
  const host = paint(win, day({ target: { protein_g: 175 } }), band());
  const energy = host.querySelectorAll(".fuel-today-m")[1];
  assert.equal(text(energy.querySelector(".fuel-today-value")), "844 kcal");
  assert.equal(energy.querySelectorAll(".fuel-today-bar").length, 0);
  assert.equal(text(energy.querySelector(".sr-only")), "844 kcal logged");
});

test("the protein anchor is a goal, not a line: within 10 g it reads about there, never a few grams to go", () => {
  const win = load();
  const near = paint(
    win,
    day({ totals: { kcal: 1898, protein_g: 168, carbs_g: 180, fat_g: 60, fiber_g: 30 } }),
    band()
  );
  assert.equal(near.querySelector(".fuel-today-togo").textContent, "About there");
  assert.doesNotMatch(near.textContent, /g protein to go/);
  const far = paint(win, day({ totals: { kcal: 1500, protein_g: 150, carbs_g: 150, fat_g: 50, fiber_g: 20 } }), band());
  assert.equal(far.querySelector(".fuel-today-togo").textContent, "20 g protein to go");
  const past = paint(
    win,
    day({ totals: { kcal: 2000, protein_g: 175, carbs_g: 180, fat_g: 60, fiber_g: 30 } }),
    band()
  );
  assert.equal(!!past.querySelector(".fuel-today-togo"), false, "met: nothing to say");
});

test("a day still being eaten reads in progress — never low", () => {
  const win = load();
  const host = paint(win, day({ count: 1, totals: { kcal: 180, protein_g: 6, fiber_g: 1 } }));
  assert.equal(host.querySelector(".fuel-today-state").textContent, "In progress");
  assert.doesNotMatch(host.textContent, /\blow\b|behind|short|under/i);
});

test("an unknown sum prints no number, never a zero standing in for it", () => {
  const win = load();
  const host = paint(
    win,
    day({
      count: 1,
      totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
      known: { kcal: false, protein_g: false, carbs_g: false, fat_g: false, fiber_g: false },
      entries: [{ id: 1, summary: "Photo meal", enrichment_status: "pending" }],
    }),
    band()
  );
  const unknown = host.querySelectorAll(".fuel-today-value.is-unknown");
  assert.equal(unknown.length, 5);
  assert.equal(unknown[0].querySelector(".sr-only").textContent, "not estimated yet");
  assert.equal(!!host.querySelector("[data-cu]"), false);
  assert.equal(!!host.querySelector(".fuel-today-togo"), false, "no 'to go' against an unknown");
  assert.match(host.querySelector(".fuel-today-pending").textContent, /One meal is still being estimated/);
});

test("nothing logged today is a calm invitation: no meter at zero", () => {
  const win = load();
  const empty = paint(win, day({ count: 0, entries: [], totals: {} }));
  assert.match(empty.querySelector(".fuel-today-empty").textContent, /Nothing logged yet today/);
  assert.equal(empty.querySelectorAll(".fuel-today-meters, .fuel-today-bar, .fuel-today-macros").length, 0, "no meter at zero");
  assert.doesNotMatch(empty.textContent, /\b0\b|no data/i);
  assert.equal(empty.querySelector(".fuel-today-title").textContent, "Today · so far");
  assert.equal(!!empty.querySelector(".fuel-today-state"), false, "an empty day has no state word");
});

test("the observed band shows in the server's words only when there is one", () => {
  const win = load();
  const withBand = paint(win, day(), band());
  assert.match(withBand.querySelector(".fuel-today-band").textContent, /not a target/);

  for (const status of ["too_few_days", "no_weight_response"]) {
    const none = paint(win, day(), band({ status, band: null, words: "Too few complete days yet." }));
    assert.equal(!!none.querySelector(".fuel-today-band"), false, `${status}: no band, and no guessed one`);
  }
  // With no band read at all, the day's own target still anchors protein.
  const noBand = paint(win, day(), null);
  assert.equal(text(noBand.querySelector(".fuel-today-value")), "78 / 175 g");
});

test("hostile text comes back as text", () => {
  const win = load();
  const host = paint(win, day(), band({ words: "<i>bold</i><img src=x>" }));
  // Counted, never compared as nodes: a failing compare would inspect the harness DOM.
  assert.equal(host.querySelectorAll(".fuel-today-band i, img").length, 0);
  assert.equal(host.querySelector(".fuel-today-band").textContent, "<i>bold</i><img src=x>");
});

// ---------- the big-day and carb-range lines (today only) ----------

const BIG_LONG_RUN = { date: TODAY, demand: "big", drivers: ["long run on this day"], evidence: [] };

function lines(win, d, today = TODAY) {
  const model = win.CairnFuelTodayModel.todayModel(d, null, { today });
  return { demand: win.CairnFuelToday.demandHtml(model), carbs: win.CairnFuelToday.carbsHtml(model), model };
}

test("a big day gets one quiet line that shapes the day and never moves the number", () => {
  const drivers = [
    "long run on this day",
    "quality run on this day",
    "heavy lower-body strength day",
    "strength and running on the same day",
    "something the card has no register for",
  ];
  const win = load();
  const seen = new Set();
  for (const date of ["2026-04-25", "2026-04-26", "2026-04-27", "2026-04-28"]) {
    for (const driver of drivers) {
      const { demand } = lines(win, day({ date, fuel_demand: { date, demand: "big", drivers: [driver] } }), date);
      assert.match(demand, /target|number stays as it is/i, `${driver} on ${date}`);
      assert.doesNotMatch(demand, /\d/, "the line never carries a number of its own");
      if (driver === "long run on this day") seen.add(demand);
    }
  }
  assert.ok(seen.size > 1, "a stable input rotates through a variant set");
  for (const d of ["standard", "light"]) {
    assert.equal(lines(win, day({ fuel_demand: { date: TODAY, demand: d, drivers: [] } })).demand, "");
  }
});

test("a day-shape read dated another day never speaks on this one", () => {
  const win = load();
  const ranged = {
    ...BIG_LONG_RUN,
    date: "2026-04-24",
    carbs: { tier: "high", g_per_kg: { low: 3.8, high: 4.2 }, grams: { low: 275, high: 305 }, basis: "within_target" },
  };
  const { demand, carbs, model } = lines(win, day({ fuel_demand: ranged }));
  assert.equal(demand, "");
  assert.equal(carbs, "");
  assert.equal(model.demand, null);
});

test("today's carb range is one calm line inside the target, never set against the log", () => {
  const win = load();
  const ranged = {
    ...BIG_LONG_RUN,
    carbs: { tier: "high", g_per_kg: { low: 3.8, high: 4.2 }, grams: { low: 275, high: 305 }, basis: "within_target" },
  };
  const host = paint(win, day({ fuel_demand: ranged }));
  const line = host.querySelector(".fuel-today-carbs").textContent;
  assert.equal(line, "Carbs around 275–305 g suit today's endurance work, inside today's target.");
  assert.doesNotMatch(line, /\b(?:under|over|short|behind|left)\b/i);
  // The empty card still shows the day's shape without turning it into a nudge.
  const empty = paint(win, day({ count: 0, entries: [], fuel_demand: BIG_LONG_RUN }));
  assert.ok(empty.querySelector(".fuel-today-demand"));
  assert.doesNotMatch(empty.textContent, /you should have|behind|missed/i);
});

// ---------- controller ----------

function harness({
  peekDay = null,
  peekBand = null,
  fresh = true,
  dayRead = () => day(),
  bandRead = () => band(),
  reduced = false,
} = {}) {
  const win = load();
  const store = new Map();
  if (peekDay) store.set(`food:day:${TODAY}`, { data: peekDay, fresh });
  if (peekBand) store.set(`fuel:band:${TODAY}`, { data: peekBand, fresh });
  const reads = [];
  const invalidated = [];
  const counted = [];
  const deps = {
    date: TODAY,
    today: TODAY,
    peekCached: (key) => store.get(key) ?? null,
    cachedApi: async (path, options) => {
      reads.push(path);
      const data = path.startsWith("/nutrition/day") ? await dayRead() : await bandRead();
      store.set(options.key, { data, fresh: true });
      return data;
    },
    swrInvalidate: (key) => {
      invalidated.push(key);
      store.delete(key);
    },
    reducedMotion: () => reduced,
    runCountUps: (scope) => counted.push(scope),
  };
  const host = createHost(win.document);
  return { win, host, deps, reads, invalidated, counted, mount: () => win.CairnFuelTodayController.mount(host, deps) };
}

test("a warm read paints at once with no shimmer, then counts up only once", async () => {
  const h = harness({ peekDay: day(), peekBand: band() });
  h.mount();
  assert.equal(!!h.host.querySelector(".skel-card"), false, "warm: no skeleton");
  assert.equal(text(h.host.querySelector(".fuel-today-value")), "78 / 170 g");
  assert.equal(h.counted.length, 1, "the mount's first paint counts up");
  await flush();
  assert.deepEqual(h.reads.sort(), [`/nutrition/day?date=${TODAY}`, `/nutrition/intake-band?date=${TODAY}`].sort());
  assert.equal(h.counted.length, 1, "an unchanged network read never repaints or re-animates");
});

test("a cold start shows the shimmer, then the day; reduced motion never counts up", async () => {
  const h = harness({ reduced: true });
  h.mount();
  assert.ok(h.host.querySelector(".skel-card"), "cold: the house shimmer");
  await flush();
  assert.equal(!!h.host.querySelector(".skel-card"), false);
  assert.ok(h.host.querySelector(".fuel-today-meters"));
  assert.equal(!!h.host.querySelector("[data-cu]"), false);
  assert.equal(h.counted.length, 0);
});

test("a failed read says so calmly and Try again reads once more", async () => {
  let fail = true;
  const h = harness({
    dayRead: () => {
      if (fail) throw new Error("offline");
      return day();
    },
  });
  h.mount();
  await flush();
  assert.match(h.host.querySelector(".fuel-today-empty").textContent, /couldn't be read just now/);
  fail = false;
  await h.host.querySelector("[data-fuel-today-retry]").click();
  await flush();
  assert.ok(h.host.querySelector(".fuel-today-meters"));
});

test("refresh re-reads the day and repaints what changed, without a second count-up", async () => {
  let current = day();
  const h = harness({ dayRead: () => current });
  const handle = h.mount();
  await flush();
  current = day({ totals: { ...day().totals, protein_g: 110 } });
  await handle.refresh();
  await flush();
  assert.ok(h.invalidated.includes(`food:day:${TODAY}`));
  assert.equal(text(h.host.querySelector(".fuel-today-value")), "110 / 170 g");
  assert.equal(h.counted.length, 1);
});

test("a read that lands after the athlete left never writes into the old host", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ dayRead: () => gate.then(() => day()) });
  h.mount();
  const before = h.host.innerHTML;
  h.host.remove();
  release();
  await flush();
  assert.equal(h.host.innerHTML, before);
});

test("mounting twice on one host leaves one listener", async () => {
  let reads = 0;
  const h = harness({
    dayRead: () => {
      reads++;
      throw new Error("offline");
    },
  });
  h.mount();
  h.mount();
  await flush();
  const before = reads;
  await h.host.querySelector("[data-fuel-today-retry]").click();
  await flush();
  assert.equal(reads - before, 1, "one tap, one read");
});
