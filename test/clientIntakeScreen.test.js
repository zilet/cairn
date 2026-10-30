// Train › Intake, the ONE home for food (intake-screen.ts renderIntake), and the week menu
// it opens (coach-meals-screen.ts renderMeals). Intake opens on TODAY — the day so far,
// the meals logged today, one idea, the composer — then the days before today, then the
// group's deeper rows. Logging or correcting a meal refreshes every slot that reads the
// day without leaving the screen; "Start from this" opens the composer filled. The week
// menu steps back to Intake and keeps the past weeks in its own fold. Components are
// faked: their own tests drive them (clientFuelToday, clientFuelMeals, clientFuelLog,
// clientIdeaCard, clientProgressIntake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

const TODAY = "2026-04-25";
const WEEKS = { window_days: 35, coverage: { pending_entry_ids: [] } };

function load({ firstPaint = () => null, peekWeeks = WEEKS, module = "intake-screen" } = {}) {
  const mounts = {};
  const events = [];
  const fakeController = (name, extra = {}) => ({
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
  const state = { tab: "progress", progressSeg: "week", planSeg: "edit" };
  const tabs = [];
  const bundles = [];
  const journal = [];
  const weeks = [];
  const reads = [];
  const globals = {
    state,
    escHtml: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    escAttr: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    activateTab: (name) => tabs.push(name),
    openIntake: () => tabs.push("intake"),
    pollToken: 0,
    headerTitle: { textContent: "" },
    CairnUiHeader: { setEyebrowTitle: (el, text) => (el.textContent = text) },
    // Train's nav: the group bar plus the landing marker wireSeg lays the deeper rows from.
    segBar: (active) => `<div class="seg" data-active="${active}"></div><span hidden data-train-landing="${active}"></span>`,
    PROGRESS_SEG: [],
    PROGRESS_HANDLERS: {},
    wireSeg: () => {
      const slot = globals.view.querySelector("[data-train-deeper-slot]");
      if (slot) slot.innerHTML = `<nav class="train-deeper">Energy balance · This week's menu</nav>`;
      events.push("wireSeg");
    },
    localISO: () => TODAY,
    loadingState: (label) => `<p class="loadstate">${label}</p>`,
    skelLines: () => `<div class="skel-card"></div>`,
    reducedMotion: () => true,
    peekCached: (key) => (key === "progress:intake" && peekWeeks ? { data: peekWeeks, fresh: true } : null),
    cachedApi: (path, options) => {
      reads.push(options?.key || path);
      return new Promise(() => {});
    },
    api: () => new Promise(() => {}),
    swrInvalidate: (key) => events.push(`invalidate:${key}`),
    swrSet: () => {},
    markRefreshing: () => {},
    pollEnrichment: () => new Promise(() => {}),
    enrichmentActive: () => false,
    paintSWR: async () => undefined,
    MEALS_KEY: "meals:plans",
    withBundle: (name, fn) => {
      bundles.push(name);
      return fn();
    },
    CairnMealJournal: {
      menuPageHtml: () => `<section class="mmenu-page" id="mealMenu">
        <button type="button" data-mmenu-back>‹ Intake</button>
        <h1 class="sr-only">This week's menu</h1>
        <div id="mealMenuSlot"></div>
        <details class="mp-history fuel-history" id="fuelHistory"><summary>Earlier meal plans</summary><div id="fuelHistorySlot"></div></details>
      </section>`,
      paintMenu: async (token, slot) => journal.push({ kind: "menu", token, slot }),
      paintHistory: async (token, slot) => journal.push({ kind: "history", token, slot }),
    },
    CairnFuelDeps: {
      PROGRESS_PATH: "/nutrition/progress?days=35",
      PROGRESS_KEY: "progress:intake",
      today: (date, today) => ({ date, today }),
      meals: (date, today, token, onChanged) => ({ date, today, token, onChanged }),
      log: (onLogged) => ({ onLogged }),
      ideas: (date, onStart) => ({ date, onStart }),
      firstPaint: (date) => firstPaint(date),
    },
    CairnFuelToday: { skeletonHtml: () => `<div class="fuel-today-skel"></div>` },
    CairnFuelTodayController: fakeController("today"),
    CairnFuelMealsController: fakeController("meals"),
    CairnFuelLogController: fakeController("log", {
      open: (prefill) => events.push(`log:open:${prefill ?? ""}`),
    }),
    CairnIdeaCardController: fakeController("ideas"),
    CairnProgressIntake: {
      render: (root, progress) => {
        weeks.push(progress);
        root.innerHTML = `<div class="nprog"><h2 id="intakeWeeksTitle">Before today · ${progress.window_days} days</h2></div>`;
      },
      unavailableHtml: () => `<div class="empty">unavailable</div>`,
    },
  };
  const win = loadClientModule([module], { globals });
  const view = createHost(win.document);
  win.view = view;
  globals.view = view;
  return { win, view, mounts, events, state, tabs, bundles, journal, weeks, reads };
}

// Every slot's id in document order: the order the screen reads in.
function order(view) {
  return view.querySelectorAll("[id], [data-train-deeper-slot]").map((el) => el.id || "deeper");
}

test("Intake opens on today: the day so far, the meals, one idea, the composer — then the weeks, then the deeper rows", () => {
  const { win, view, mounts, state } = load();
  win.renderIntake();
  assert.equal(state.progressSeg, "intake");
  assert.equal(win.headerTitle.textContent, "Intake");
  assert.ok(view.querySelector('.seg[data-active="intake"]'), "it wears Train's group bar, Intake lit");
  const ids = order(view).filter((id) => ["dayFuelSlot", "fuelMealsSlot", "fuelIdeasSlot", "fuelLogSlot", "intakeProgress", "deeper"].includes(id));
  assert.deepEqual(ids, ["dayFuelSlot", "fuelMealsSlot", "fuelIdeasSlot", "fuelLogSlot", "intakeProgress", "deeper"]);
  assert.equal(mounts.today.host, view.querySelector("#dayFuelSlot"));
  assert.equal(mounts.meals.host, view.querySelector("#fuelMealsSlot"));
  assert.equal(mounts.ideas.host, view.querySelector("#fuelIdeasSlot"));
  assert.equal(mounts.log.host, view.querySelector("#fuelLogSlot"));
  // Today is today: every component reads the device's own date.
  for (const name of ["today", "meals", "ideas"]) assert.equal(mounts[name].deps.date, TODAY, name);
  assert.match(view.querySelector("[data-train-deeper-slot]").textContent, /Energy balance · This week's menu/);
  // No second "Log a meal" above it, and no separate Fuel frame or back link.
  assert.equal(view.querySelectorAll("[data-intake-log-btn], [data-home-back], .food-journal").length, 0);
});

test("the days before today paint under today's card from the week read", () => {
  const { win, view, weeks, reads } = load();
  win.renderIntake();
  assert.equal(weeks.length, 1, "a warm peek paints at once");
  assert.match(view.querySelector("#intakeProgress").textContent, /Before today · 35 days/);
  assert.ok(reads.includes("progress:intake"), "and revalidates through its own key");
});

test("a cold week read holds a calm loading line, never a zero", () => {
  const { win, view, weeks } = load({ peekWeeks: null });
  win.renderIntake();
  assert.equal(weeks.length, 0);
  assert.match(view.querySelector("#intakeProgress").textContent, /Reading the days before today/);
});

test("a meal logged from the composer refreshes every slot that reads the day, and the weeks", () => {
  const { win, mounts, events, reads } = load();
  win.renderIntake();
  events.length = 0;
  reads.length = 0;
  mounts.log.deps.onLogged({ turnId: 1, notes: [{ id: 9 }], reply: null });
  for (const e of ["meals:refresh", "today:refresh", "ideas:refresh", "invalidate:progress:intake", "invalidate:progress:energy"]) {
    assert.ok(events.includes(e), e);
  }
  assert.deepEqual(reads, ["progress:intake"], "the weeks re-read");
});

test("Start from this opens the composer filled — the surface never logs it", () => {
  const { win, mounts, events } = load();
  win.renderIntake();
  mounts.ideas.deps.onStart("Greek yogurt (a half portion)", { key: "yogurt@0.5" });
  assert.ok(events.includes("log:open:Greek yogurt (a half portion)"));
});

test("a correction in a meal card refreshes today's numbers, the idea and the weeks", () => {
  const { win, mounts, events } = load();
  win.renderIntake();
  events.length = 0;
  mounts.meals.deps.onChanged();
  for (const e of ["today:refresh", "ideas:refresh", "invalidate:progress:intake"]) assert.ok(events.includes(e), e);
  assert.ok(!events.includes("meals:refresh"), "the meal list updated itself in place");
});

test("a cold open holds the day card's skeleton and writes the surface once the slots' reads answer", async () => {
  let answer;
  const asked = [];
  const { win, view, mounts } = load({
    firstPaint: (date) => {
      asked.push(date);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  const painted = win.renderIntake();
  assert.ok(view.querySelector(".fuel-today-skel"));
  assert.equal(view.querySelectorAll("#dayFuelSlot").length, 0);
  assert.equal(mounts.today, undefined);
  assert.deepEqual(asked, [TODAY]);
  answer();
  await painted;
  assert.equal(mounts.today.host, view.querySelector("#dayFuelSlot"));
  assert.equal(view.querySelectorAll(".fuel-today-skel").length, 0);
});

test("a cold open whose person has left writes nothing when the reads answer", async () => {
  let answer;
  const { win, view, mounts, state } = load({ firstPaint: () => new Promise((resolve) => (answer = resolve)) });
  const painted = win.renderIntake();
  state.tab = "today";
  answer();
  await painted;
  assert.equal(mounts.today, undefined);
  assert.equal(view.querySelectorAll("#dayFuelSlot").length, 0);
});

test("a second visit tears the previous mounts down first", async () => {
  const { win, events } = load();
  win.renderIntake();
  events.length = 0;
  win.renderIntake();
  await flush();
  for (const name of ["today", "meals", "log", "ideas"]) assert.ok(events.includes(`${name}:teardown`), name);
});

// ---------- the week menu (coach-meals-screen.ts) ----------

test("Plan → Meals is the week menu: its own page that steps back to Intake", async () => {
  const { win, view, state, bundles, journal, tabs } = load({ module: "06-coach-meals" });
  await win.renderMeals();
  assert.equal(state.planSeg, "meals");
  assert.equal(win.headerTitle.textContent, "This week's menu");
  assert.ok(view.querySelector("#mealMenuSlot"));
  assert.deepEqual(bundles, ["meals"], "the planner is the lazy meals bundle's");
  assert.equal(journal[0]?.kind, "menu");
  const back = view.querySelector("[data-mmenu-back]");
  assert.match(back.textContent, /‹ Intake/);
  back.click();
  assert.deepEqual(tabs, ["intake"], "back is today's food's one home");
  assert.equal(typeof win.renderFoodJournal, "undefined", "the separate Fuel view is gone");
});

test("the week menu keeps the past weeks in its own fold, painted on first open", async () => {
  const { win, view, journal } = load({ module: "06-coach-meals" });
  await win.renderMeals();
  const fold = view.querySelector("#fuelHistory");
  assert.equal(fold.hasAttribute("open"), false);
  assert.equal(fold.dataset.painted, undefined);
  fold.setAttribute("open", "");
  fold.open = true;
  fold.dispatchEvent(new win.Event("toggle"));
  await flush();
  assert.equal(fold.dataset.painted, "1");
  assert.equal(journal.at(-1).kind, "history");
  assert.equal(journal.at(-1).slot, view.querySelector("#fuelHistorySlot"));
});

test("a meal-plan action on the week menu repaints it in place, never navigates", async () => {
  const { win, view, journal, tabs, events } = load({ module: "06-coach-meals" });
  await win.renderMeals();
  const slot = view.querySelector("#mealMenuSlot");
  journal.length = 0;
  await win.repaintMealHistory();
  assert.ok(events.includes("invalidate:meals:plans"));
  assert.deepEqual(journal.map((j) => [j.kind, j.slot === slot]), [["menu", true]]);
  assert.deepEqual(tabs, []);
});

test("off the week menu a meal-plan action only invalidates: it never pulls the athlete away", async () => {
  const { win, view, state, events, journal, tabs } = load({ module: "06-coach-meals" });
  view.innerHTML = `<div id="meallist"></div>`;
  await win.repaintMealHistory();
  assert.ok(events.includes("invalidate:meals:plans"));
  assert.deepEqual(journal, []);
  assert.deepEqual(tabs, []);
  assert.equal(state.planSeg, "edit");
});
