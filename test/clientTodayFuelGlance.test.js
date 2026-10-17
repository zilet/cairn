// Fuel today, the glance under Today's NOW card (today-fuel-glance-client.ts): protein
// and energy as slim meters beside the day's numbers, ONE idea for later, and the
// laws it holds — an unlogged day is absent (no meters at zero), nothing is graded,
// every tap opens Fuel, and the model never works a number out of thin air.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const DATE = "2026-09-26";

function load(globals = {}) {
  return loadClientModule(["html-utils", "today-fuel-glance-client"], { globals });
}

function day(overrides = {}) {
  return {
    date: DATE,
    totals: { kcal: 640, protein_g: 42, carbs_g: 68, fat_g: 20, fiber_g: 7 },
    known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
    entries: [{ id: 1, summary: "Salmon rice bowl" }],
    count: 1,
    target: { kcal: 2050, protein_g: 170, mode: "cut" },
    remaining: { kcal: 1410, protein_g: 128 },
    ...overrides,
  };
}

const IDEAS = {
  kind: "ideas",
  date: DATE,
  protein_anchor: { protein_g: 185, source: "formula", words: "" },
  ideas: [
    { key: "steak", title: "Steak & eggs <hash>", protein_g: 42, kcal: 560 },
    { key: "salad", title: "Chicken salad", protein_g: 40, kcal: 540 },
  ],
};

test("a logged day shows protein then energy against the day's numbers, and one idea", () => {
  const win = load();
  const model = win.CairnTodayFuelGlance.model(day(), IDEAS);
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.protein)),
    { value: 42, of: 185 },
    "the protein anchor leads the target"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(model.energy)), { value: 640, of: 2050 });
  const host = renderHtml(win.CairnTodayFuelGlance.html(model), { document: win.document });
  const values = host.querySelectorAll(".tfuel-v").map((el) => el.textContent);
  assert.deepEqual(values, ["42 / 185 g", "640 / 2,050"]);
  assert.deepEqual(
    host.querySelectorAll(".tfuel-k").map((el) => el.textContent),
    ["Protein", "Energy"]
  );
  assert.equal(host.querySelectorAll(".tfuel-idea").length, 1, "one idea, never a list");
  assert.equal(host.querySelector(".tfuel-idea-t").textContent, "Steak & eggs <hash>");
  assert.equal(host.querySelector(".tfuel-idea-n").textContent, "42 g protein · ~560 kcal");
  assert.equal(
    host.querySelector(".tfuel-idea").getAttribute("aria-label"),
    "An idea for later Steak & eggs <hash> 42 g protein · ~560 kcal. Open Fuel"
  );
  assert.doesNotMatch(win.CairnTodayFuelGlance.html(model), /<hash>/, "the idea's words are escaped");
  assert.doesNotMatch(win.CairnTodayFuelGlance.html(model), /score|%|low\b|behind/i);
});

test("nothing logged yet is absent, never empty bars", () => {
  const win = load();
  const model = win.CairnTodayFuelGlance.model(day({ entries: [], count: 0, totals: {} }), IDEAS);
  const html = win.CairnTodayFuelGlance.html(model);
  assert.doesNotMatch(html, /tfuel-m\b|tfuel-bar/);
  assert.match(html, /Nothing logged yet today\./);
  assert.match(html, /data-tfuel-open/, "the way in stays");
});

test("an unknown macro is not drawn, and no target means the value alone", () => {
  const win = load();
  const model = win.CairnTodayFuelGlance.model(day({ known: { kcal: false, protein_g: true }, target: null }), {
    kind: "ideas",
    ideas: [],
  });
  const host = renderHtml(win.CairnTodayFuelGlance.html(model), { document: win.document });
  assert.deepEqual(
    host.querySelectorAll(".tfuel-v").map((el) => el.textContent),
    ["42 g"]
  );
  assert.equal(host.querySelector(".tfuel-idea"), null, "no idea, no row");
  assert.equal(win.CairnTodayFuelGlance.model(null, IDEAS), null);
  assert.equal(win.CairnTodayFuelGlance.html(null), "");
});

test("Today mounts the glance under the NOW card's steer line, paints from the warm cache, and opens Fuel", async () => {
  const calls = { loads: [], tabs: [] };
  const win = load({
    peekCached: (key) => (key === `food:day:${DATE}` ? { data: day(), fresh: true } : null),
    cachedApi: (path, options) => {
      calls.loads.push(options.key);
      return Promise.resolve(options.key.startsWith("fuel:ideas") ? IDEAS : day());
    },
  });
  const view = createHost(win.document, {
    html: `<div class="today-main"><section class="brief"><div class="brief-now"></div><div class="brief-steer"></div><details class="brief-around"></details></section></div>`,
  });
  const state = {};
  win.CairnTodayFuelGlance.mountToday(view, { date: DATE, state, activateTab: (tab) => calls.tabs.push(tab) });
  const kids = view.querySelector(".brief").children.map((el) => el.id || el.className.split(" ")[0]);
  assert.deepEqual(kids, ["brief-now", "brief-steer", "todayFuelSlot", "brief-around"]);
  const slot = view.querySelector("#todayFuelSlot");
  assert.equal(slot.getAttribute("aria-live"), "off", "the Brief's live region never announces the card filling in");
  assert.ok(slot.querySelector(".tfuel"), "the warm day paints at once, no shimmer");
  await flush();
  assert.deepEqual(calls.loads.sort(), [`food:day:${DATE}`, `fuel:ideas:${DATE}`], "the Fuel view's own SWR keys");
  assert.ok(slot.querySelector(".tfuel-idea"), "the idea lands when its read does");
  await slot.querySelector(".tfuel-log").click();
  assert.deepEqual(calls.tabs, ["plan"]);
  assert.equal(state.planJump, "food");
});

test("a day read that fails takes the glance off the page, so the rail keeps its own fuel card", async () => {
  const win = load({
    peekCached: () => null,
    cachedApi: () => Promise.reject(new Error("offline")),
  });
  const view = createHost(win.document, {
    html: `<div class="today-main"><section class="brief"><div class="brief-now"></div><div class="brief-steer"></div></section></div>`,
  });
  win.CairnTodayFuelGlance.mountToday(view, { date: DATE, state: {}, activateTab: () => {} });
  assert.ok(view.querySelector("#todayFuelSlot .tfuel-skel"), "the cold start holds the card's shape");
  await flush();
  assert.equal(view.querySelector("#todayFuelSlot"), null);
});
