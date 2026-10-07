// v2 wave 7, "Today is Home": the day page (src/client/day-record-client.ts) renders
// any day that is not today, read-only — a past day's record, a future day's preview —
// and one delegated opener takes every `data-open-day` in the app there through the
// drill controller (CairnDrill). Today itself always opens Today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-09-29";

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
const escAttr = (v) => escHtml(v).replace(/"/g, "&quot;");

function load() {
  const tabs = [];
  const listeners = {};
  const context = {
    Object,
    String,
    Number,
    Math,
    Date,
    JSON,
    RegExp,
    escHtml,
    escAttr,
    localISO: (d) => {
      if (!d) return TODAY;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },
    fmtDist: (km, units) => (units === "mi" ? `${(km / 1.609344).toFixed(1)} mi` : `${km} km`),
    CairnUiHeader: {
      shortDate: (iso) => `short(${iso})`,
      setEyebrowTitle: () => {},
    },
    state: { tab: "progress", planSeg: "edit", planJump: null },
    activateTab: (tab) => tabs.push(tab),
    syncRouteFromState: () => {},
    withBundle: (_name, fn) => fn(),
    document: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  context.window.scrollTo = () => {};
  context.window.CairnRoutes = { homeOf: (tab) => (tab === "progress" ? "train" : "today") };
  context.renderTab = () => {};
  // The eager opener (bundle-02) and the lazy page + drill (bundle-12-calendar), in load order.
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/day-open-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/day-record-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/drill-controller.js"), "utf8"), context);
  const openDay = (date) => context.CairnDrill.open("day", date, { mode: "page" });
  return { day: { ...context.CairnDayRecord, openDay }, context, tabs, listeners };
}

function record(over = {}) {
  return {
    date: "2026-09-28",
    relation: "past",
    today: TODAY,
    run_units: "km",
    session: null,
    activities: [],
    intake: null,
    read: null,
    weight_lb: null,
    lift: null,
    run: null,
    rest: false,
    caveats: [],
    line: "Nothing was logged this day.",
    ...over,
  };
}

test("a past day renders its record: the session's movements, a run, the food, the read, escaped", () => {
  const { day } = load();
  const html = day.dayHtml(
    record({
      session: {
        id: 7,
        title: "Pull <b>",
        finished: true,
        sets: 12,
        movements: [{ name: "Row", sets: 4, best: "135 × 8" }],
        skipped: ["Face Pull"],
        notes: "Felt strong",
      },
      activities: [
        {
          id: 1,
          title: "run",
          run: true,
          distance_km: 6.2,
          duration_min: 35,
          pace: null,
          note: "easy run",
          source: null,
        },
      ],
      intake: {
        coverage: "complete",
        entries: 2,
        kcal: 2000,
        protein_g: 130,
        carbs_g: null,
        fat_g: null,
        meals: [
          { meal: "breakfast", summary: "Oats", logged_at: null },
          { meal: "Chicken & rice bowl", summary: "Chicken & rice bowl", logged_at: "7:10 PM" },
        ],
      },
      read: { kind: "train", headline: "A strong Pull day.", why: "The back was due." },
      weight_lb: 184.6,
      line: "Pull, and a run.",
    }),
    { backLabel: "Train" }
  );
  assert.match(html, /‹ Train/);
  assert.match(html, /Yesterday · the day's record/);
  assert.match(html, /Pull &lt;b&gt;/, "every string is escaped");
  assert.match(html, /Row<\/span><span class="dayrec-mv-best">135 × 8/);
  assert.match(html, /Set aside that day: Face Pull\./);
  assert.match(html, /6\.2 km · 35 min · easy run/);
  assert.match(html, /2,000 kcal · 130 g protein/);
  assert.doesNotMatch(html, /g carbs|g fat/, "a sum an entry did not carry is never spoken");
  assert.match(html, /The whole day logged/);
  // A slot word keys its meal; a free-text label falls back to the stated time.
  assert.match(html, /dayrec-meal-k">Breakfast</);
  assert.match(html, /dayrec-meal-k">7:10 PM</);
  assert.match(html, /The read that day[\s\S]*A strong Pull day\./);
  assert.match(html, /Weighed 184\.6 lb/);
  assert.match(html, /data-day-log="2026-09-28">Edit this day's session/);
  assert.doesNotMatch(html, /Planned/);
});

test("a past day with nothing logged says so calmly, and offers to log a session there", () => {
  const { day } = load();
  const html = day.dayHtml(record(), { backLabel: "Today" });
  assert.match(html, /No training logged\./);
  assert.match(html, /Nothing logged, so the day's intake is unknown\./);
  assert.match(html, /Log a session to this day/);
  assert.doesNotMatch(html, /\b(low|behind|missed)\b/i);
});

test("a future day renders its preview in the athlete's run units, with its caveats", () => {
  const { day } = load();
  const html = day.dayHtml(
    record({
      date: "2026-10-01",
      relation: "future",
      run_units: "mi",
      lift: { title: "Push", focus: "chest / shoulders", purpose: null },
      run: { kind: "easy", label: "Easy run", km: 8.05 },
      caveats: ["Lisbon — design offsite"],
      line: "Push, then an easy run.",
    }),
    { backLabel: "Horizon" }
  );
  assert.match(html, /In 2 days · a preview/);
  assert.match(html, /Planned/);
  assert.match(html, /Push<\/span><span class="dayrec-row-s">chest \/ shoulders/);
  assert.match(html, /Easy run<\/span><span class="dayrec-row-s">5 mi/);
  assert.match(html, /Lisbon — design offsite/);
  assert.doesNotMatch(html, /Training|Fuel|data-day-log/, "a future day has no log half");
});

test("the stepper walks to the neighbouring days; relative words read plainly", () => {
  const { day, context } = load();
  const html = day.dayHtml(record({ date: "2026-09-27" }), { backLabel: "Today" });
  assert.match(html, /data-open-day="2026-09-26"/);
  assert.match(html, /data-open-day="2026-09-28"/);
  assert.equal(context.CairnFmt.relDay("2026-09-28", TODAY), "Yesterday");
  assert.equal(context.CairnFmt.relDay("2026-09-30", TODAY), "Tomorrow");
  assert.equal(context.CairnFmt.relDay("2026-09-25", TODAY), "4 days ago");
  assert.equal(context.CairnFmt.relDay("2026-10-20", TODAY), "In 3 weeks");
});

test("opening a day: today opens Today, another day its own view; junk opens nothing", () => {
  const { day, context, tabs, listeners } = load();
  day.openDay(TODAY);
  assert.deepEqual(tabs, ["today"]);
  day.openDay("2026-09-27");
  assert.equal(context.state.dayDate, "2026-09-27");
  assert.deepEqual(tabs, ["today", "day"]);
  day.openDay("not-a-date");
  assert.deepEqual(tabs, ["today", "day"]);

  // One delegated opener serves every data-open-day in the app.
  const el = { dataset: { openDay: "2026-09-26" }, hasAttribute: () => false };
  const target = { closest: (sel) => (sel === "[data-open-day]" ? el : null) };
  context.Element = function Element() {};
  Object.setPrototypeOf(target, context.Element.prototype);
  let prevented = false;
  listeners.click({ target, preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(context.state.dayDate, "2026-09-26");
});

// One day, one place: a day opened from Train is read UNDER Train. The page is
// home-free (/app/day/<date>); the opener rides in state.drillFrom (and the entry's
// history.state), so the lit tab and the "‹ Train" back link agree.
test("a day opened from Train lives under Train: its opener rides in state, its back link names it", () => {
  const { day, context } = load();
  day.openDay("2026-09-27");
  assert.equal(context.state.drillFrom, "train");
  assert.equal(context.state.drillBack, true, "an in-app opener sits behind the page");
  assert.equal(context.CairnDrill.fromLabel(), "Train");
  assert.equal(context.CairnDrill.homeLabel("horizon"), "Horizon");
  // Stepping to another day keeps the opener (and replaces, never stacks, history).
  day.openDay("2026-09-26");
  assert.equal(context.state.drillFrom, "train");
  // The page's back link and its label are the drill's.
  const src = readFileSync(join(root, "src/client/day-record-client.ts"), "utf8");
  assert.match(src, /CairnDrill\.back\(\)/);
  assert.match(src, /CairnDrill\.fromLabel\(\)/);
});
