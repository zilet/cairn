import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let lastRoutes = null;
function loadRouter() {
  const routeStateSrc = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const src = readFileSync(new URL("../public/js/app-router.js", import.meta.url), "utf8");
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(routeStateSrc, context, { filename: "route-state.js" });
  vm.runInNewContext(src, context);
  lastRoutes = context.window.CairnRoutes;
  return context.window.CairnAppRouter;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const deps = {
  routeApi: { planSections: ["edit", "food", "meals", "coach"] },
  planSections: [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]],
  progressSections: [["sessions", "History"], ["program", "Program"], ["intake", "Intake"], ["energy", "Energy"]],
  standSections: ["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "domain"],
  meSections: [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"]],
  healthSections: [["read", "Read"], ["records", "Records"], ["markers", "Markers"]],
  settingsSections: [["agents", "Agents"], ["system", "System"], ["data", "Data"]],
};

test("app router derives tab names from the route contract", () => {
  const router = loadRouter();
  // The VIEWS (what renders). The five tab-bar homes are a layer over them.
  assert.deepEqual(plain(router.ROUTE_TABS), ["today", "session", "stand", "plan", "progress", "chat", "me", "settings", "horizon", "you", "day"]);
});

test("app router carries Horizon's and You's sub-views through state and back", () => {
  const router = loadRouter();
  const state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: "2026-06-29" };

  assert.equal(router.applyRouteState({ tab: "horizon", section: "goal" }, { state, ...deps }), "horizon");
  assert.equal(state.horizonSeg, "goal");
  assert.deepEqual(plain(router.currentRouteState({ state: { ...state, tab: "horizon" }, ...deps, defaultProgressSection: null })), {
    tab: "horizon",
    section: "goal",
  });
  assert.equal(router.applyRouteState({ tab: "horizon", section: null }, { state, ...deps }), "horizon");
  assert.equal(state.horizonSeg, null);

  assert.equal(router.applyRouteState({ tab: "you", section: "stone", id: "heart" }, { state, ...deps }), "you");
  assert.equal(state.youSeg, "stone");
  assert.equal(state.youStone, "heart");
  assert.deepEqual(plain(router.currentRouteState({ state: { ...state, tab: "you" }, ...deps, defaultProgressSection: null })), {
    tab: "you",
    section: "stone",
    id: "heart",
  });
  // A stone URL without a key is the landing.
  assert.equal(router.applyRouteState({ tab: "you", section: "stone", id: null }, { state, ...deps }), "you");
  assert.equal(state.youSeg, null);
  assert.equal(state.youStone, null);
});

// A day page is home-free (/app/day/<date>); the opener it is read under rides in the
// entry's history.state, so a reload or a Back into it keeps that tab lit. An old alias
// (/app/train/day?date=) names its home in the path instead.
test("app router restores a day page's opener from its history entry, or an old alias's home", () => {
  const router = loadRouter();
  const state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: "2026-06-29" };
  const day = { tab: "day", section: null, date: "2026-06-20" };
  // A reload / Back into a page Horizon opened in-app.
  assert.equal(router.applyRouteState(day, { state, ...deps, historyState: { cairn: true, from: "horizon", drill: 1 } }), "day");
  assert.equal(state.dayDate, "2026-06-20");
  assert.equal(state.drillFrom, "horizon");
  assert.equal(state.drillBack, true);
  // The URL written from state names no home.
  assert.deepEqual(plain(router.currentRouteState({ state: { ...state, tab: "day" }, ...deps, defaultProgressSection: null })), {
    tab: "day",
    date: "2026-06-20",
  });
  // An old alias: its home is the opener, and nothing in-app sits behind it.
  assert.equal(router.applyRouteState({ tab: "day", section: "train", date: "2026-06-20" }, { state, ...deps }), "day");
  assert.equal(state.drillFrom, "train");
  assert.equal(state.drillBack, false);
  // A cold deep link: Today, its default.
  assert.equal(router.applyRouteState(day, { state, ...deps, historyState: null }), "day");
  assert.equal(state.drillFrom, null);
  assert.equal(state.drillBack, false);
  // A junk opener in the entry is ignored.
  router.applyRouteState(day, { state, ...deps, historyState: { from: "<x>" } });
  assert.equal(state.drillFrom, null);
});

test("a day page's history entry carries its opener", () => {
  const router = loadRouter();
  const writes = [];
  const history = {
    pushState: (s, _t, url) => writes.push(["push", s, url]),
    replaceState: (s, _t, url) => writes.push(["replace", s, url]),
  };
  router.syncRouteFromState({
    routes: lastRoutes,
    route: { tab: "day", date: "2026-06-20" },
    location: { pathname: "/app/horizon", search: "" },
    history,
    historyState: { from: "horizon", drill: 1 },
  });
  assert.deepEqual(plain(writes), [["push", { from: "horizon", drill: 1, cairn: true }, "/app/day/2026-06-20"]]);
});

test("a parsed v1 URL applies to the same state its v2 twin does", () => {
  const router = loadRouter();
  const pairs = [
    ["/app/train/program", "/app/train/program"],
    ["/app/you/settings/data", "/app/you/settings/data"],
    ["/app/plan/food?date=2026-06-30", "/app/today/fuel?date=2026-06-30"],
    ["/app/me/health/records?id=7", "/app/you/records?id=7"],
    ["/app/me/standing", "/app/you/age"],
    ["/app/chat?session=s1", "/app/ask?session=s1"],
  ];
  for (const [v1, v2] of pairs) {
    const a = { tab: "today", logDate: "2026-06-29" };
    const b = { tab: "today", logDate: "2026-06-29" };
    const tabA = router.applyRouteState(lastRoutes.parseRoute(v1), { state: a, ...deps, routeApi: lastRoutes });
    const tabB = router.applyRouteState(lastRoutes.parseRoute(v2), { state: b, ...deps, routeApi: lastRoutes });
    assert.equal(tabA, tabB, v1);
    assert.deepEqual(plain(a), plain(b), v1);
    // And the state writes back as the v2 URL.
    const url = lastRoutes.routeToUrl(router.currentRouteState({ state: { ...a, tab: tabA }, ...deps, settingsSections: lastRoutes.settingsSections, defaultProgressSection: null }));
    assert.equal(url, v2, `${v1} canonicalises`);
  }
});

test("app router applies canonical route state without rendering", () => {
  const router = loadRouter();
  const state = {
    tab: "today",
    day: null,
    dayPicked: false,
    plan: [],
    today: {},
    logDate: "2026-06-29",
  };

  assert.equal(
    router.applyRouteState({ tab: "plan", section: "food", date: "2026-06-30" }, { state, ...deps }),
    "plan",
  );
  assert.equal(state.logDate, "2026-06-30");
  assert.equal(state.planSeg, "food");
  assert.equal(state.planJump, "food");

  assert.equal(
    router.applyRouteState({ tab: "progress", section: "energy" }, { state, ...deps }),
    "progress",
  );
  assert.equal(state.progressSeg, "energy");

  assert.equal(
    router.applyRouteState({ tab: "progress", section: "intake" }, { state, ...deps }),
    "progress",
  );
  assert.equal(state.progressSeg, "intake");

  // Stand sub-views are first-class routes.
  assert.equal(
    router.applyRouteState({ tab: "stand", section: "records", id: "7" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "records");
  assert.equal(state.pendingHealthDocId, "7");

  // Legacy me/health deep links redirect into the Stand tab (health home).
  assert.equal(
    router.applyRouteState({ tab: "me", section: "health", healthSection: "records", id: "42" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "records");
  assert.equal(state.pendingHealthDocId, "42");

  assert.equal(
    router.applyRouteState({ tab: "me", section: "health", healthSection: "read" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, null);

  // Legacy me/standing lands on the hosted bio-age read.
  assert.equal(
    router.applyRouteState({ tab: "me", section: "standing" }, { state, ...deps }),
    "stand",
  );
  assert.equal(state.standSeg, "age");

  // Me stays the about-you home.
  assert.equal(
    router.applyRouteState({ tab: "me", section: "profile" }, { state, ...deps }),
    "me",
  );
  assert.equal(state.meSeg, "profile");

  assert.equal(
    router.applyRouteState({ tab: "settings", section: "system" }, { state, ...deps }),
    "settings",
  );
  assert.equal(state.setSeg, "system");
});

test("app router derives current route state from app state", () => {
  const router = loadRouter();
  const route = router.currentRouteState({
    state: {
      tab: "stand",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      standSeg: "records",
      pendingHealthDocId: "99",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });

  assert.deepEqual(plain(route), {
    tab: "stand",
    section: "records",
    id: "99",
  });

  const meRoute = router.currentRouteState({
    state: {
      tab: "me",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      meSeg: "profile",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });

  assert.deepEqual(plain(meRoute), { tab: "me", section: "profile" });

  const settingsRoute = router.currentRouteState({
    state: {
      tab: "settings",
      day: null,
      dayPicked: false,
      plan: [],
      today: {},
      logDate: "2026-06-29",
      setSeg: "system",
    },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(settingsRoute), { tab: "settings", section: "system" });
});

// "Today" is a moving target, not a bookmark. Writing it into the URL as an absolute
// ?date= meant the next cold launch restored a date that had since become yesterday,
// and the Today header opened reading "Yesterday".
function loadRouterWithClock(todayISO) {
  const routeStateSrc = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const src = readFileSync(new URL("../public/js/app-router.js", import.meta.url), "utf8");
  const context = { window: { localISO: () => todayISO }, URL, URLSearchParams };
  vm.runInNewContext(routeStateSrc, context, { filename: "route-state.js" });
  vm.runInNewContext(src, context);
  return context.window.CairnAppRouter;
}

test("app router never pins today's own date into the Today route", () => {
  const router = loadRouterWithClock("2026-06-29");
  const baseState = { tab: "today", day: null, dayPicked: false, plan: [], today: {} };

  const todayRoute = router.currentRouteState({
    state: { ...baseState, logDate: "2026-06-29" },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(todayRoute), { tab: "today" });

  // Today is Home (v2 wave 7): Today never carries a date, whatever logDate says...
  const pastRoute = router.currentRouteState({
    state: { ...baseState, logDate: "2026-06-27", dayPicked: true },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(pastRoute), { tab: "today" });

  // ...another day is its own destination, and IT carries the date.
  const dayRoute = router.currentRouteState({
    state: { ...baseState, tab: "day", dayDate: "2026-06-27" },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(dayRoute), { tab: "day", date: "2026-06-27" });

  // The open session destination keeps its explicit date either way.
  const sessionRoute = router.currentRouteState({
    state: { ...baseState, tab: "session", logDate: "2026-06-29" },
    ...deps,
    defaultProgressSection: "sessions",
  });
  assert.deepEqual(plain(sessionRoute), { tab: "session", date: "2026-06-29" });
});

// The other half of that rule: if today never carries a ?date=, then a dateless Today
// URL IS today. Reading only route.date left Back out of a ?date= day on the Today tab
// still showing that day, with no history entry left to get home.
test("app router returns a dateless Today route to the measured day", () => {
  const router = loadRouterWithClock("2026-06-29");
  const state = {
    tab: "today",
    day: 3,
    dayPicked: true,
    dayPickedOn: "2026-06-29",
    plan: [],
    today: {},
    logDate: "2026-06-29",
  };

  // An old dated Today link opens that day's own view, never Today wearing the date,
  // and it leaves Today's log date alone.
  assert.equal(router.applyRouteState({ tab: "today", date: "2026-06-27" }, { state, ...deps }), "day");
  assert.equal(state.dayDate, "2026-06-27");
  assert.equal(state.logDate, "2026-06-29");
  // A day link that names today IS Today.
  assert.equal(router.applyRouteState({ tab: "day", date: "2026-06-29" }, { state, ...deps }), "today");
  assert.equal(router.applyRouteState({ tab: "day", date: null }, { state, ...deps }), "today");
  assert.equal(router.applyRouteState({ tab: "day", date: "2026-07-02" }, { state, ...deps }), "day");
  assert.equal(state.dayDate, "2026-07-02");
  state.logDate = "2026-06-27";

  // Back: the popped entry is the dateless Today URL.
  assert.equal(router.applyRouteState({ tab: "today" }, { state, ...deps }), "today");
  assert.equal(state.logDate, "2026-06-29");
  assert.equal(state.dayPicked, false);
  assert.equal(state.dayPickedOn, null);

  // Another tab without a date says nothing about the log date.
  state.logDate = "2026-06-27";
  assert.equal(router.applyRouteState({ tab: "progress", section: "energy" }, { state, ...deps }), "progress");
  assert.equal(state.logDate, "2026-06-27");
});

test("app router syncs canonical URLs through push and replace history", () => {
  const router = loadRouter();
  const calls = [];
  const routes = { routeToUrl: (route) => lastRoutes.routeToUrl(route) };
  const history = {
    pushState(state, title, url) { calls.push(["push", state, title, url]); },
    replaceState(state, title, url) { calls.push(["replace", state, title, url]); },
  };

  assert.equal(
    router.syncRouteFromState({
      routes,
      route: { tab: "progress", section: "program" },
      location: { pathname: "/app/today", search: "" },
      history,
    }),
    "/app/train/program",
  );
  assert.deepEqual(plain(calls[0]), ["push", { cairn: true }, "", "/app/train/program"]);

  assert.equal(
    router.syncRouteFromState({
      mode: "replace",
      routes,
      route: { tab: "settings", section: "data" },
      location: { pathname: "/app/train/program", search: "" },
      history,
    }),
    "/app/you/settings/data",
  );
  assert.deepEqual(plain(calls[1]), ["replace", { cairn: true }, "", "/app/you/settings/data"]);

  assert.equal(
    router.syncRouteFromState({
      routes,
      route: { tab: "settings", section: "data" },
      location: { pathname: "/app/you/settings/data", search: "" },
      history,
    }),
    null,
  );
});

test("the Stand domain drill-in is a real route that carries its domain key", () => {
  const router = loadRouter();
  const state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: "2026-06-29" };

  assert.equal(router.applyRouteState({ tab: "stand", section: "domain", id: "lipids" }, { state, ...deps }), "stand");
  assert.equal(state.standSeg, "domain");
  assert.equal(state.standDomain, "lipids");
  assert.deepEqual(plain(router.currentRouteState({ state: { ...state, tab: "stand" }, ...deps, defaultProgressSection: null })), {
    tab: "stand",
    section: "domain",
    id: "lipids",
  });

  // A domain URL with no key parses; the Stand screen falls back to the overview.
  assert.equal(router.applyRouteState({ tab: "stand", section: "domain" }, { state, ...deps }), "stand");
  assert.equal(state.standDomain, null);
  assert.deepEqual(plain(router.currentRouteState({ state: { ...state, tab: "stand" }, ...deps, defaultProgressSection: null })), {
    tab: "stand",
    section: "domain",
  });
});
