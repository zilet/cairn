// The Fuel surface's composition (coach-meals-screen.ts renderFoodJournal/renderMeals,
// docs/V2-PLAN.md wave 2). Fuel (/app/today/fuel, opened from Today) paints its
// shell at once, titled "Fuel" with a "‹ Today" back link, and mounts each Fuel
// component into its own slot; a meal logged from the composer refreshes every slot
// that reads the day without leaving the screen; "Start from this" opens the composer
// filled. "This week's menu" (the lazy meals bundle's card) sits above the day's
// journal and opens Plan → Meals, the week menu (/app/today/menu), which steps back to
// Fuel; past weeks stay in Fuel's history fold. Components are faked: their own tests
// drive them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

const TODAY = "2026-04-25";

function load({ logDate = "", firstPaint = () => null } = {}) {
  const mounts = {};
  const events = [];
  const fakeController = (name, extra = {}) => ({
    // The read keys Fuel primes on a cold open (the real controllers' own spelling).
    dayKey: (date) => `food:day:${date}`,
    bandKey: (date) => `fuel:band:${date}`,
    dayPath: (date) => `/nutrition/day?date=${date}`,
    bandPath: (date) => `/nutrition/intake-band?date=${date}`,
    key: (date) => `fuel:ideas:${date}`,
    path: (date, hour) => `/fuel/ideas?date=${date}&hour=${hour}`,
    mount: (host, deps) => {
      mounts[name] = { host, deps };
      const handle = () => events.push(`${name}:teardown`);
      handle.refresh = async () => {
        events.push(`${name}:refresh`);
      };
      Object.assign(handle, extra);
      return handle;
    },
  });
  const state = { logDate, planSeg: "edit", tab: "plan" };
  const routes = [];
  const tabs = [];
  const bundles = [];
  const journal = [];
  const menuCards = [];
  const bundleReturns = [];
  const globals = {
    state,
    escHtml: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    activateTab: (name) => tabs.push(name),
    // The shell's home-back helpers (ui-shell.ts), faked the way they behave.
    homeBackHtml: (home, label) => `<button class="home-back" type="button" data-home-back="${home}">‹ ${label}</button>`,
    wireHomeBack: (root) =>
      root.querySelector("[data-home-back]")?.addEventListener("click", (e) => tabs.push(e.currentTarget.dataset.homeBack)),
    pollToken: 0,
    headerTitle: { textContent: "" },
    CairnUiHeader: {
      shortDate: (iso) => `short(${iso})`,
      setEyebrowTitle: (el, text) => {
        el.textContent = text;
      },
    },
    segBar: (active) => `<div class="seg" data-active="${active}"></div>`,
    planSeg: () => [],
    wireSeg: () => {},
    localISO: () => TODAY,
    loadingState: (label) => `<p>${label}</p>`,
    skelLines: () => `<div class="skel-card"></div>`,
    reducedMotion: () => true,
    peekCached: () => null,
    cachedApi: () => new Promise(() => {}),
    paintSWR: async () => undefined,
    swrInvalidate: (key) => events.push(`invalidate:${key}`),
    markRefreshing: () => {},
    runCountUps: () => {},
    syncRouteFromState: (mode) => routes.push(mode),
    // The meal-plan journal lives in the lazy meals bundle, reached through withBundle.
    withBundle: (name, fn) => {
      bundles.push(name);
      const painted = fn();
      bundleReturns.push(painted);
      return painted;
    },
    CairnMealJournal: {
      // The page frame is the bundle's (meal-journal-client.ts menuPageHtml); this fake
      // carries the same hooks the eager wiring looks for.
      menuPageHtml: () => `<section class="mmenu-page" id="mealMenu">
        <button type="button" data-mmenu-back>‹ Fuel</button>
        <h1 class="sr-only">This week's menu</h1>
        <div id="mealMenuSlot"></div>
        <button type="button" data-mmenu-history>Earlier meal plans are kept in Fuel</button>
      </section>`,
      paintMenu: async (token, slot, _peek, focus) => {
        journal.push({ kind: "menu", token, slot, focus });
      },
      paintHistory: async (token, slot) => {
        journal.push({ kind: "history", token, slot });
      },
    },
    CairnMealMenuCardController: {
      mount: (host, deps) => {
        const handle = () => events.push("menu:teardown");
        handle.refresh = async () => {
          events.push("menu:refresh");
        };
        handle.ready = Promise.resolve();
        menuCards.push({ host, deps, handle });
        return handle;
      },
    },
    CairnFuelDeps: {
      today: (date, today) => ({ date, today }),
      meals: (date, today, _token, onChanged) => ({ date, today, onChanged }),
      log: (onLogged) => ({ onLogged }),
      ideas: (date, onStart) => ({ date, onStart }),
      // Warm by default (null: paint at once); a test hands in a pending first paint.
      firstPaint: (date, isToday) => firstPaint(date, isToday),
    },
    CairnFuelToday: { skeletonHtml: () => `<div class="fuel-today-skel"></div>` },
    CairnFuelTodayController: fakeController("today"),
    CairnFuelMealsController: fakeController("meals"),
    CairnFuelLogController: fakeController("log", {
      open: (prefill) => events.push(`log:open:${prefill ?? ""}`),
    }),
    CairnIdeaCardController: fakeController("ideas"),
  };
  const win = loadClientModule(["06-coach-meals"], { globals });
  const view = createHost(win.document);
  win.view = view;
  win.$ = (sel) => view.querySelector(sel);
  return { win, view, mounts, events, state, routes, tabs, bundles, bundleReturns, journal, menuCards };
}

test("Fuel paints its shell under Today and mounts every component into its slot", () => {
  const { win, view, mounts, state, tabs } = load();
  win.renderFoodJournal();
  assert.equal(state.planSeg, "food");
  // Fuel lives under Today: its own title, no Plan seg bar, one quiet way back.
  // v2 wave 7: Fuel wears the Today home's mono eyebrow and names the day it shows.
  assert.equal(win.headerTitle.textContent, `Fuel · short(${TODAY})`);
  assert.equal(view.querySelector(".seg"), null);
  const back = view.querySelector("[data-home-back]");
  assert.equal(back.getAttribute("data-home-back"), "today");
  assert.match(back.textContent, /‹ Today/);
  back.click();
  assert.deepEqual(tabs, ["today"]);
  for (const id of ["dayFuelSlot", "fuelLogSlot", "fuelMenuSlot", "fuelMealsSlot", "fuelIdeasSlot", "energyCard", "fuelHistory"]) {
    assert.ok(view.querySelector(`#${id}`), `#${id}`);
  }
  assert.equal(mounts.today.host, view.querySelector("#dayFuelSlot"));
  assert.equal(mounts.log.host, view.querySelector("#fuelLogSlot"));
  assert.equal(mounts.meals.host, view.querySelector("#fuelMealsSlot"));
  assert.equal(mounts.ideas.host, view.querySelector("#fuelIdeasSlot"));
  assert.equal(mounts.today.deps.date, TODAY);
  assert.equal(view.querySelector("#fuelHistory").hasAttribute("open"), false, "history stays folded");
});

test("This week's menu mounts from the lazy meals bundle into its own slot, below what was logged today", () => {
  const { win, view, bundles, bundleReturns, menuCards, mounts } = load();
  win.renderFoodJournal();
  const slots = [...view.querySelectorAll(".fuel-slot")].map((el) => el.id);
  assert.ok(slots.indexOf("fuelMealsSlot") < slots.indexOf("fuelMenuSlot"), "what was logged today comes before the menu");
  assert.ok(slots.indexOf("fuelLogSlot") < slots.indexOf("fuelMealsSlot"), "logging stays ahead of the logged list");
  assert.deepEqual(bundles, ["meals"], "only the card reaches the planner bundle; the fold stays unpainted");
  assert.equal(menuCards.length, 1);
  assert.equal(menuCards[0].host, view.querySelector("#fuelMenuSlot"));
  assert.equal(menuCards[0].deps.isCurrent(), true);
  assert.equal(bundleReturns[0], menuCards[0].handle.ready, "the owed reconnect sweep waits for the card's first paint");
  // The eager slots never wait on it.
  assert.equal(mounts.meals.host, view.querySelector("#fuelMealsSlot"));
  assert.equal(view.querySelector("#fuelHistory").dataset.painted, undefined);
});

test("a stale Fuel paint never mounts the menu card once its bundle lands", async () => {
  const { win, view, menuCards } = load();
  let land;
  win.withBundle = (_name, fn) => new Promise((resolve) => (land = () => resolve(fn())));
  win.renderFoodJournal();
  // The placeholder holds the card's place while the bundle loads.
  assert.ok(view.querySelector("#fuelMenuSlot .mmenu-skel"));
  win.pollToken += 1; // the athlete moved on
  land();
  await flush();
  assert.equal(menuCards.length, 0);
});

test("the menu card opens the week menu, scrolled to today when a meal was tapped", async () => {
  const { win, view, state, tabs, menuCards, journal } = load();
  win.renderFoodJournal();
  menuCards[0].deps.openMenu("today");
  assert.equal(state.planJump, "meals");
  assert.deepEqual(tabs, ["plan"]);
  // The dispatcher then renders the menu (lazy("meals", () => renderMeals())).
  await win.renderMeals();
  assert.equal(state.planSeg, "meals");
  assert.equal(journal.at(-1).kind, "menu");
  assert.equal(journal.at(-1).focus, "today");
  assert.equal(journal.at(-1).slot, view.querySelector("#mealMenuSlot"));
  // The hand-off is spent: a later visit opens at the top of the week.
  await win.renderMeals();
  assert.equal(journal.at(-1).focus, "week");
});

test("another day carries no menu card", () => {
  const { win, view, menuCards } = load({ logDate: "2026-04-20" });
  win.renderFoodJournal();
  assert.equal(view.querySelector("#fuelMenuSlot"), null);
  assert.equal(menuCards.length, 0);
});

test("a cold open holds the day card's skeleton and writes the surface once the slots' reads answer", async () => {
  let answer;
  const asked = [];
  const { win, view, mounts, state } = load({
    firstPaint: (date, isToday) => {
      asked.push([date, isToday]);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  const painted = win.renderFoodJournal();
  // The day card's own skeleton holds the top; no slot is mounted yet, so nothing
  // can fill in and push the others down one by one.
  assert.ok(view.querySelector(".fuel-today-skel"));
  assert.equal(view.querySelector("#dayFuelSlot"), null);
  assert.equal(mounts.today, undefined);
  assert.deepEqual(asked, [[TODAY, true]]);
  answer();
  await painted;
  assert.equal(state.planSeg, "food");
  assert.equal(mounts.today.host, view.querySelector("#dayFuelSlot"));
  assert.equal(mounts.ideas.host, view.querySelector("#fuelIdeasSlot"));
  assert.equal(view.querySelector(".fuel-today-skel"), null);
});

test("a cold open whose person has left writes nothing when the reads answer", async () => {
  let answer;
  const { win, view, mounts, state } = load({ firstPaint: () => new Promise((resolve) => (answer = resolve)) });
  const painted = win.renderFoodJournal();
  state.tab = "today";
  answer();
  await painted;
  assert.equal(mounts.today, undefined);
  assert.equal(view.querySelector("#dayFuelSlot"), null);
});

test("a meal logged from the composer refreshes every slot that reads the day", () => {
  const { win, mounts, events } = load();
  win.renderFoodJournal();
  events.length = 0;
  mounts.log.deps.onLogged({ turnId: 1, notes: [{ id: 9 }], reply: null });
  assert.ok(events.includes("meals:refresh"));
  assert.ok(events.includes("today:refresh"));
  assert.ok(events.includes("ideas:refresh"));
  assert.ok(events.includes("invalidate:progress:intake"));
});

test("Start from this opens the composer filled — the surface never logs it", () => {
  const { win, mounts, events } = load();
  win.renderFoodJournal();
  mounts.ideas.deps.onStart("Greek yogurt (a half portion)", { key: "yogurt@0.5" });
  assert.ok(events.includes("log:open:Greek yogurt (a half portion)"));
});

test("a correction in a meal card refreshes today's numbers and the ideas", () => {
  const { win, mounts, events } = load();
  win.renderFoodJournal();
  events.length = 0;
  mounts.meals.deps.onChanged();
  assert.ok(events.includes("today:refresh"));
  assert.ok(events.includes("ideas:refresh"));
});

test("another day is read and corrected only: no composer, no ideas", () => {
  const { win, view, mounts } = load({ logDate: "2026-04-20" });
  win.renderFoodJournal();
  assert.equal(view.querySelector("#fuelLogSlot"), null);
  assert.equal(view.querySelector("#fuelIdeasSlot"), null);
  assert.equal(mounts.log, undefined);
  assert.equal(mounts.ideas, undefined);
  assert.equal(mounts.today.deps.date, "2026-04-20");
});

test("Plan → Meals is the week menu: its own page under Today that steps back to Fuel", async () => {
  const { win, view, state, routes, bundles, journal, tabs } = load();
  await win.renderMeals();
  assert.equal(state.planSeg, "meals");
  assert.equal(win.headerTitle.textContent, "This week's menu");
  assert.equal(view.querySelector(".food-journal"), null, "not Fuel");
  assert.ok(view.querySelector("#mealMenuSlot"));
  assert.match(view.querySelector("h1").textContent, /This week's menu/);
  assert.deepEqual(bundles, ["meals"], "the planner is the lazy meals bundle's");
  assert.equal(journal[0]?.kind, "menu");
  assert.deepEqual(routes, [], "the route is its own (/app/today/menu): no redirect");
  const back = view.querySelector("[data-mmenu-back]");
  assert.match(back.textContent, /‹ Fuel/);
  back.click();
  assert.equal(state.planJump, "food");
  assert.deepEqual(tabs, ["plan"]);
});

test("Earlier meal plans on the week menu opens Fuel with its history fold open", async () => {
  const { win, view, state, tabs, journal } = load();
  await win.renderMeals();
  view.querySelector("[data-mmenu-history]").click();
  assert.equal(state.planJump, "food");
  assert.deepEqual(tabs, ["plan"]);
  await win.renderFoodJournal();
  assert.equal(view.querySelector("#fuelHistory").hasAttribute("open"), true);
  assert.equal(view.querySelector("#fuelHistory").dataset.painted, "1");
  assert.equal(journal.at(-1).kind, "history");
  assert.equal(journal.at(-1).slot, view.querySelector("#fuelHistorySlot"));
  // The hand-off is spent: the next Fuel opens folded.
  win.renderFoodJournal();
  assert.equal(view.querySelector("#fuelHistory").hasAttribute("open"), false);
});

test("a second visit tears the previous mounts down first", async () => {
  const { win, events } = load();
  win.renderFoodJournal();
  events.length = 0;
  win.renderFoodJournal();
  await flush();
  for (const name of ["today", "meals", "log", "ideas"]) assert.ok(events.includes(`${name}:teardown`), name);
});

test("a meal-plan action on Fuel refreshes the menu card and an opened fold in place", async () => {
  const { win, view, mounts, events, routes, journal } = load();
  await win.renderFoodJournal({ history: true });
  const todaySlot = view.querySelector("#dayFuelSlot");
  const logSlot = view.querySelector("#fuelLogSlot");
  routes.length = 0;
  events.length = 0;
  journal.length = 0;
  const token = win.pollToken;
  await win.repaintMealHistory();
  assert.deepEqual(
    events.filter((e) => e.endsWith(":teardown")),
    [],
    "no component is torn down by a meal-plan action"
  );
  assert.ok(events.includes("invalidate:meals:plans"), "the plans re-read");
  assert.ok(events.includes("menu:refresh"), "the card repaints in place");
  assert.deepEqual(journal.map((j) => j.kind), ["history"], "the opened fold repaints");
  assert.equal(view.querySelector("#dayFuelSlot"), todaySlot, "the shell is the same node");
  assert.equal(view.querySelector("#fuelLogSlot"), logSlot);
  assert.equal(mounts.log.host, logSlot);
  assert.equal(win.pollToken, token, "no re-render, so no watcher is orphaned");
  assert.deepEqual(routes, [], "and no navigation");
});

test("a meal-plan action on the week menu repaints the menu, never navigates", async () => {
  const { win, view, journal, routes, tabs } = load();
  await win.renderMeals();
  const slot = view.querySelector("#mealMenuSlot");
  journal.length = 0;
  await win.repaintMealHistory();
  assert.deepEqual(journal.map((j) => [j.kind, j.slot === slot]), [["menu", true]]);
  assert.deepEqual(routes, []);
  assert.deepEqual(tabs, []);
});

test("off both surfaces a meal-plan action only invalidates: it never pulls the athlete away", async () => {
  const { win, view, state, events, journal, tabs } = load();
  view.innerHTML = `<div id="meallist"></div>`;
  await win.repaintMealHistory();
  assert.ok(events.includes("invalidate:meals:plans"));
  assert.deepEqual(journal, []);
  assert.deepEqual(tabs, []);
  assert.equal(state.planSeg, "edit");
});
