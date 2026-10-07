// The drill-down grammar (docs/IA.md, contract test 6 "drillGrammar"): ONE controller,
// CairnDrill (src/client/drill-controller.ts), opens an object inline, as a peek or as
// its page. A day's page is home-free (/app/day/<date>), the opener's tab stays lit,
// Back returns to the opener, and the back link names it. A peek adds ?peek= to history
// so Back closes it, and ends with one "Open day ›".
//
// Static scans over src/client (nothing but the drill builds a day URL or activates the
// day view), then the real shell modules (route-state, the app router, route sync, the
// tab switcher, the eager data-open-day opener and the drill) driven over a fake
// history: open a day from Horizon / Today, Back, land on the opener.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument, flush, loadClientModule, renderHtml } from "./_dom.mjs";
import { createNav } from "./_nav.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(root, "src/client");
const sources = readdirSync(clientDir, { recursive: true })
  .filter((f) => String(f).endsWith(".ts") && !String(f).endsWith(".d.ts"))
  .map((f) => String(f));
const read = (f) => readFileSync(join(clientDir, f), "utf8");

/** Code only: comments blanked, so prose naming a URL never trips a scan. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const TODAY = "2026-10-06";
const DAY = "2026-10-08";

// ---- static: one controller ----

test("only the drill controller activates the day view or renders it", () => {
  const activates = sources.filter((f) => /activateTab\(\s*["'`]day["'`]/.test(code(read(f))));
  assert.deepEqual(activates, ["drill-controller.ts"]);
  const renders = sources.filter((f) => /renderTab\(\s*["'`]day["'`]/.test(code(read(f))));
  assert.deepEqual(renders, ["drill-controller.ts"]);
  // The day page's date and opener are set by the drill (an in-app open) and restored by
  // the router (a reload, a Back, an old alias) — nowhere else.
  const writers = sources.filter((f) => /state\.(?:dayDate|drillFrom|drillBack)\s*=(?!=)/.test(code(read(f))));
  assert.deepEqual(writers.sort(), ["app/router.ts", "drill-controller.ts"]);
});

test("only the drill (through route-state, which owns the grammar) builds a day URL", () => {
  // A literal day path, old or new, or a routeToUrl call for the day view.
  // A literal app path naming the day (/app/day/…, /app/<home>/day?…), a templated one
  // (`${base}/day/…`), or a routeToUrl call for the day view.
  const DAY_URL = /\/app\/(?:[a-z]+\/)?day\b|\}\/day\b|routeToUrl\(\s*\{[^}]*tab:\s*["'`]day["'`]/;
  const builders = sources.filter((f) => DAY_URL.test(code(read(f))));
  assert.deepEqual(builders.sort(), ["drill-controller.ts", "route-state.ts"]);
  // Markup opens a day only declaratively (data-open-day), and ONE delegated opener reads it.
  const listeners = sources.filter((f) => /closest[^(]*\(\s*["'`]\[data-open-day\]/.test(code(read(f))));
  assert.deepEqual(listeners, ["day-open-client.ts"]);
  assert.match(code(read("day-open-client.ts")), /withBundle\("calendar",\s*\(\)\s*=>\s*CairnDrill\.open\("day"/);
  // The old opener and its globals are gone.
  for (const f of sources) {
    assert.doesNotMatch(code(read(f)), /CairnDayOpen|\bopenInHorizon\b|state\.dayHome/, f);
  }
});

test("startup's popstate asks the drill first, so a Back that only closes a peek re-renders nothing", () => {
  const src = code(read("app/startup.ts"));
  const hook = src.indexOf("CairnDrill.popped()");
  assert.ok(hook > 0, "the hook is there");
  assert.ok(hook < src.indexOf("parseRoute(location.href)", src.indexOf("popstate")), "and runs before the route is applied");
  assert.match(src, /typeof CairnDrill !== "undefined" && CairnDrill\.popped\(\)/, "guarded: the drill is lazy");
});

test("the drill and the day views format through CairnFmt only", () => {
  for (const f of ["drill-controller.ts", "day-detail-model.ts", "day-glance-model.ts", "day-detail-client.ts", "day-glance-view.ts", "day-record-client.ts", "day-open-client.ts"]) {
    const src = code(read(f));
    assert.doesNotMatch(src, /1\.609|toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat/, f);
  }
});

// ---- the shell, driven ----

const TAB_BAR = ["today", "train", "horizon", "ask", "you"]
  .map((t) => `<button class="tab" data-tab="${t}" aria-label="${t[0].toUpperCase()}${t.slice(1)}"></button>`)
  .join("");

function shell(start, { historyState = null } = {}) {
  const nav = createNav(start);
  if (historyState) nav.history.replaceState(historyState, "", start);
  const document = createDocument();
  const bar = renderHtml(TAB_BAR, { document, tag: "nav" });
  const view = renderHtml("", { document, id: "view" });
  const rendered = [];
  const closed = [];
  const w = loadClientModule(
    ["html-utils", "route-state", "app-router", "app-route-sync", "app-tabs", "day-open-client", "drill-controller"],
    {
      document,
      globals: {
        location: nav.location,
        history: nav.history,
        state: { tab: "today", planSeg: "edit", planJump: null },
        view,
        PROGRESS_SEG: [["overview", "Overview"]],
        isEndurance: () => false,
        renderTab: (tab) => rendered.push(tab),
        tabSwap: (fn) => fn(),
        teardownJobs: () => {},
        closeDetail: () => closed.push("detail"),
        peekCached: () => null,
        cachedApi: () => new Promise(() => {}),
        todaySkeleton: () => "",
        skelLines: () => "",
        segSkeleton: () => "",
        reducedMotion: () => true,
        viewHydrate: () => {},
        tabErrorState: () => {},
        localISO: () => TODAY,
        withBundle: (_name, fn) => fn(),
        scrollTo: () => {},
        CairnDayDetailController: {
          mount: (host, deps) => {
            host.innerHTML = `<p class="probe">${deps.date}</p>`;
            return () => {};
          },
        },
      },
    }
  );
  // startup.ts's popstate listener, line for line.
  nav.onPop = () => {
    if (typeof w.CairnDrill !== "undefined" && w.CairnDrill.popped()) return;
    const route = w.routeApi().parseRoute(nav.location.href);
    const tab = w.applyRouteState(route);
    w.activateTab(tab, route?.legacy ? { replace: true } : { syncRoute: false });
  };
  // startup.ts's landing, line for line.
  const landing = w.routeApi().parseRoute(nav.location.href);
  const landingTab = w.applyRouteState(landing);
  w.activateTab(landingTab, { replace: !!landing.legacy, syncRoute: !!landing.legacy });
  const lit = () => bar.querySelector(".tab.active")?.getAttribute("data-tab") || null;
  const last = () => rendered[rendered.length - 1];
  return { w, nav, document, bar, view, rendered, closed, lit, last };
}

/** Tap a `data-open-day` row the way a week list draws it (the eager delegated opener). */
async function tapDay(s, date) {
  const row = renderHtml(`<li class="pahead-day" data-open-day="${date}" role="link" tabindex="0">a day</li>`, {
    document: s.document,
  }).firstElementChild;
  await row.click();
  await flush();
}

test("open a day page from Horizon, Back: land on Horizon (the tab stays lit throughout)", async () => {
  const s = shell("/app/horizon");
  assert.equal(s.last(), "horizon");
  assert.equal(s.lit(), "horizon");
  await tapDay(s, DAY);
  assert.equal(s.last(), "day");
  assert.equal(s.nav.url(), `/app/day/${DAY}`, "the canonical, home-free page");
  assert.equal(s.lit(), "horizon", "the opener's tab stays lit");
  assert.equal(s.w.state.drillFrom, "horizon");
  assert.equal(s.w.CairnDrill.fromLabel(), "Horizon", "the back link names the opener, never '‹ Today'");
  assert.deepEqual({ ...s.nav.history.state }, { from: "horizon", drill: 1, cairn: true }, "the entry remembers its opener");
  // The page's own back link.
  s.w.CairnDrill.back();
  await flush();
  assert.equal(s.nav.url(), "/app/horizon");
  assert.equal(s.last(), "horizon");
  assert.equal(s.lit(), "horizon");
  // The phone's Back does the same.
  await tapDay(s, DAY);
  s.nav.history.back();
  await flush();
  assert.equal(s.nav.url(), "/app/horizon");
  assert.equal(s.last(), "horizon");
  assert.equal(s.lit(), "horizon");
  // Forward into the page: the entry's opener keeps Horizon lit (no URL names it).
  s.nav.history.forward();
  await flush();
  assert.equal(s.last(), "day");
  assert.equal(s.lit(), "horizon");
  assert.equal(s.w.CairnDrill.fromLabel(), "Horizon");
});

test("open a day page from Today, Back: land on Today", async () => {
  const s = shell("/app/today");
  assert.equal(s.lit(), "today");
  await tapDay(s, DAY);
  assert.equal(s.nav.url(), `/app/day/${DAY}`);
  assert.equal(s.lit(), "today");
  assert.equal(s.w.CairnDrill.fromLabel(), "Today");
  s.w.CairnDrill.back();
  await flush();
  assert.equal(s.nav.url(), "/app/today");
  assert.equal(s.last(), "today");
  assert.equal(s.lit(), "today");
});

test("stepping between days on the page replaces history, so Back still returns to the opener", async () => {
  const s = shell("/app/train");
  await tapDay(s, DAY);
  const depth = s.nav.history.length;
  s.w.CairnDrill.open("day", "2026-10-09", { mode: "page" });
  await flush();
  assert.equal(s.nav.url(), "/app/day/2026-10-09");
  assert.equal(s.nav.history.length, depth, "no entry per day");
  assert.equal(s.lit(), "train");
  s.nav.history.back();
  await flush();
  assert.equal(s.nav.url(), "/app/train");
  assert.equal(s.lit(), "train");
});

test("a day that is today opens Today itself; a malformed id opens nothing", async () => {
  const s = shell("/app/horizon");
  s.w.CairnDrill.open("day", TODAY, { mode: "page" });
  await flush();
  assert.equal(s.last(), "today");
  assert.equal(s.nav.url(), "/app/today");
  const before = s.rendered.length;
  s.w.CairnDrill.open("day", "not-a-date", { mode: "page" });
  await tapDay(s, "2026-13-xx");
  assert.equal(s.rendered.length, before);
});

test("a cold deep link reads under Today and its back link lands on Today's root", async () => {
  const s = shell(`/app/day/${DAY}`);
  assert.equal(s.last(), "day");
  assert.equal(s.w.state.dayDate, DAY);
  assert.equal(s.lit(), "today");
  assert.equal(s.w.CairnDrill.fromLabel(), "Today");
  s.w.CairnDrill.back();
  await flush();
  assert.equal(s.nav.url(), "/app/today", "nothing in-app behind it: the opener tab's root, not out of the app");
});

test("route aliases resolve: an old /app/horizon/day link opens the page under Horizon and is rewritten", async () => {
  const s = shell(`/app/horizon/day?date=${DAY}`);
  assert.equal(s.last(), "day");
  assert.equal(s.nav.url(), `/app/day/${DAY}`, "rewritten in place");
  assert.equal(s.nav.history.length, 1, "replaceState, never a new entry");
  assert.equal(s.lit(), "horizon");
  assert.equal(s.w.CairnDrill.fromLabel(), "Horizon");
  assert.equal(s.nav.history.state.from, "horizon");
  // A reload of the rewritten URL keeps the opener (it rides the entry's state).
  const reload = shell(`/app/day/${DAY}`, { historyState: s.nav.history.state });
  assert.equal(reload.lit(), "horizon");
  assert.equal(reload.w.CairnDrill.fromLabel(), "Horizon");
  // The other aliases land on the same page.
  for (const url of [`/app/today/day?date=${DAY}`, `/app/day?date=${DAY}`, `/app/today?date=${DAY}`, `/app/train/day?date=${DAY}`]) {
    const other = shell(url);
    assert.equal(other.last(), "day", url);
    assert.equal(other.nav.url(), `/app/day/${DAY}`, url);
  }
  assert.equal(shell(`/app/train/day?date=${DAY}`).lit(), "train");
});

test("a peek adds ?peek= to history, ends with one 'Open day ›', and Back closes it without re-rendering", async () => {
  const s = shell("/app/today");
  const host = renderHtml("", { document: s.document });
  const closes = [];
  s.w.CairnDrill.open("day", DAY, { mode: "peek", host, onClose: () => closes.push("closed") });
  assert.equal(s.nav.url(), `/app/today?peek=${DAY}`);
  assert.equal(s.nav.history.length, 2);
  assert.equal(host.querySelector(".probe").textContent, DAY, "the compact view mounted");
  const full = host.querySelectorAll("[data-drill-full]");
  assert.equal(full.length, 1);
  assert.equal(full[0].textContent, "Open day ›");
  assert.equal(full[0].getAttribute("data-drill-id"), DAY);
  assert.equal(s.w.CairnDrill.owns(host), true);
  const renders = s.rendered.length;
  s.nav.history.back();
  await flush();
  assert.equal(s.nav.url(), "/app/today");
  assert.deepEqual(closes, ["closed"]);
  assert.equal(s.rendered.length, renders, "closing a peek is not a navigation");
  assert.equal(s.w.CairnDrill.owns(host), false);
  // "Open day ›" from a peek opens the page under the peek's opener.
  s.w.CairnDrill.open("day", DAY, { mode: "peek", host, onClose: () => closes.push("closed") });
  await host.querySelector("[data-drill-full]").click();
  await flush();
  assert.equal(s.nav.url(), `/app/day/${DAY}`);
  assert.equal(s.lit(), "today");
  s.nav.history.back();
  await flush();
  assert.equal(s.nav.url(), `/app/today?peek=${DAY}`, "Back returns to the opener with its peek");
  assert.equal(s.last(), "today", "a real navigation: Today repaints (and its strip reopens the named peek)");
});

test("a peek with no host opens in a sheet, and Back closes the sheet", async () => {
  const s = shell("/app/horizon");
  const sheets = [];
  s.w.CairnDetailOverlay = {
    mountDetail: (html) => {
      const el = renderHtml(html, { document: s.document });
      el.className = "detail";
      sheets.push(el);
      return el;
    },
  };
  s.w.CairnDrill.open("day", DAY, { mode: "peek" });
  assert.equal(sheets.length, 1);
  assert.equal(s.nav.url(), `/app/horizon?peek=${DAY}`);
  assert.equal(sheets[0].querySelectorAll("[data-drill-full]").length, 1);
  assert.equal(sheets[0].querySelector("[data-drill-close]"), null, "the sheet's own × closes it");
  s.closed.length = 0; // the landing's tab switch closed any open detail too
  s.nav.history.back();
  await flush();
  assert.equal(s.nav.url(), "/app/horizon");
  assert.deepEqual(s.closed, ["detail"]);
});

test("an inline open mounts the compact view and leaves history alone", () => {
  const s = shell("/app/train");
  const host = renderHtml("", { document: s.document });
  const depth = s.nav.history.length;
  s.w.CairnDrill.open("day", DAY, { mode: "inline", host });
  assert.equal(host.querySelector(".probe").textContent, DAY);
  assert.equal(s.nav.history.length, depth);
  assert.equal(s.nav.url(), "/app/train");
});

// ---- the chip and the row say a day in the same words ----

function loadViews() {
  return loadClientModule(["html-utils", "ui-format", "format-utils", "ui-format", "ui-reads", "day-detail-model", "day-glance-model", "day-detail-run-client", "day-detail-client", "day-glance-view"]);
}

test("the chip and the row read one glance: the same lift and run words, CairnFmt units, no raw dates", () => {
  const w = loadViews();
  const M = w.CairnDayDetailModel;
  const V = w.CairnDayDetailView;
  // The same Thursday from the week read (Today's strip, Horizon) and the look-ahead (Program).
  const weekDay = {
    date: DAY,
    weekday: "Thu",
    dow: 4,
    status: "upcoming",
    plan_day: { day_number: 3, name: "Lower B", role: "strength", day_type: "training" },
    session: null,
    run: { kind: "quality", label: "Threshold", status: "open", km: 9.5 },
    hard: false,
  };
  const lookAheadDay = {
    date: DAY,
    weekday: "Thu",
    today: false,
    lift: { title: "Lower B", focus: null, lifts: ["Squat"], more: 0, done: false },
    run: { kind: "quality", label: "Threshold", km: 9.5, done: false },
    rest: false,
    hard: false,
  };
  for (const units of ["km", "mi"]) {
    const a = M.glanceOfWeekDay(weekDay, TODAY, units);
    const b = M.glanceOfLookAheadDay(lookAheadDay, units);
    assert.equal(a.lift.words, b.lift.words);
    assert.equal(a.run.words, b.run.words);
    assert.equal(a.run.words, `Threshold · ${w.CairnFmt.distance(9.5, units)}`);
    assert.match(a.run.words, units === "mi" ? /5\.9 mi$/ : /9\.5 km$/);
    const chip = V.chipHtml(a, { selected: null });
    const row = V.rowHtml(b, {});
    // The chip carries the words in its accessible name; the row prints them.
    assert.ok(chip.includes(`Lower B, planned; ${a.run.words}, planned`), chip);
    assert.ok(row.includes("Lower B") && row.includes(a.run.words), row);
    const text = (html) => html.replace(/<[^>]*>/g, " ");
    assert.doesNotMatch(text(chip) + text(row), /\b\d{4}-\d{2}-\d{2}\b/, "no raw ISO date in text");
    assert.doesNotMatch(text(row), /\b(km|mi)\s*\1\b/);
  }
  // A run behind is named by its kind on both, so a morning's label never outlives it.
  const past = M.glanceOfWeekDay({ ...weekDay, date: "2026-10-05" }, TODAY, "km");
  assert.equal(past.run.words, "Quality run · 9.5 km");
  assert.equal(past.run.state, "open");
  // Escaped everywhere.
  const hostile = M.glanceOfWeekDay({ ...weekDay, plan_day: { ...weekDay.plan_day, name: "<b>x</b>" } }, TODAY, "km");
  assert.doesNotMatch(V.chipHtml(hostile, {}) + V.rowHtml(hostile, {}), /<b>x/);
});
