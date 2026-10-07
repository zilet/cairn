// The v2 URL contract and the v1 -> v2 redirect table (v2 wave 5 acceptance: "a
// redirect table test covers every v1 /app/<tab>/<section> path"). Eight v1 tabs
// became five homes (Today, Train, Horizon, Ask, You); every old address still
// parses, lands on the same surface, and is rewritten to its v2 form in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CLIENT_ROUTE_DEFINITIONS } from "../dist/contracts/client.js";

function loadRoutes() {
  const src = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(src, context);
  return context.window.CairnRoutes;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Where a parsed URL lands, then the canonical URL the shell rewrites it to.
function landing(routes, url) {
  const r = routes.parseRoute(url);
  return {
    view: r.tab,
    section: r.section,
    home: r.home,
    legacy: r.legacy,
    canonical: routes.routeToUrl(r),
  };
}

// ---- The redirect table: one row per v1 path (docs: wave5 design section 2) ----
// [v1 url, view, section, home, v2 canonical]
const REDIRECTS = [
  // Default
  ["/app", "today", null, "today", "/app/today"],
  ["/app/nowhere", "today", null, "today", "/app/today"],
  ["/?tab=bogus", "today", null, "today", "/app/today"],
  // Session moves under Today
  ["/app/session", "session", null, "today", "/app/today/session"],
  ["/app/session?date=2026-06-29", "session", null, "today", "/app/today/session?date=2026-06-29"],
  // Plan splits across four homes
  ["/app/plan", "plan", "edit", "train", "/app/train/plan"],
  ["/app/plan/edit", "plan", "edit", "train", "/app/train/plan"],
  ["/app/plan/endurance", "plan", "endurance", "horizon", "/app/horizon/race"],
  ["/app/plan/food", "plan", "food", "today", "/app/today/fuel"],
  ["/app/plan/food?date=2026-06-28", "plan", "food", "today", "/app/today/fuel?date=2026-06-28"],
  // Plan → Meals is the week menu, under Today.
  ["/app/plan/meals", "plan", "meals", "today", "/app/today/menu"],
  ["/app/plan/coach", "plan", "coach", "ask", "/app/ask/changes"],
  ["/app/plan?jump=edit", "plan", "edit", "train", "/app/train/plan"],
  ["/app/plan?jump=endurance", "plan", "endurance", "horizon", "/app/horizon/race"],
  ["/app/plan?jump=food", "plan", "food", "today", "/app/today/fuel"],
  ["/app/plan?jump=meals", "plan", "meals", "today", "/app/today/menu"],
  ["/app/plan?jump=coach", "plan", "coach", "ask", "/app/ask/changes"],
  // Progress is Train, leaf for leaf
  ["/app/progress", "progress", null, "train", "/app/train"],
  ...CLIENT_ROUTE_DEFINITIONS.sections.progress.map((leaf) => [
    `/app/progress/${leaf}`,
    "progress",
    leaf,
    "train",
    `/app/train/${leaf}`,
  ]),
  // Stand is Health, under You
  ["/app/stand", "stand", null, "you", "/app/you/health"],
  ...["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup"].map(
    (section) => [`/app/stand/${section}`, "stand", section, "you", `/app/you/${section}`]
  ),
  ["/app/stand/records?id=doc_42", "stand", "records", "you", "/app/you/records?id=doc_42"],
  ["/app/stand/domain?id=heart", "stand", "domain", "you", "/app/you/domain?id=heart"],
  ["/app/stand/domain", "stand", null, "you", "/app/you/health"],
  // Me is About you, under You
  ["/app/me", "me", "profile", "you", "/app/you/profile"],
  ["/app/me/profile", "me", "profile", "you", "/app/you/profile"],
  ["/app/me/memory", "me", "memory", "you", "/app/you/memory"],
  ["/app/me/life", "me", "life", "you", "/app/you/life"],
  ["/app/me/family", "me", "family", "you", "/app/you/family"],
  ["/app/me/standing", "stand", "age", "you", "/app/you/age"],
  ["/app/me/health", "stand", null, "you", "/app/you/health"],
  ["/app/me/health/read", "stand", null, "you", "/app/you/health"],
  ["/app/me?health=read", "me", "profile", "you", "/app/you/profile"],
  ["/app/me/health?health=read", "stand", null, "you", "/app/you/health"],
  ["/app/me/health/markers", "stand", "markers", "you", "/app/you/markers"],
  ["/app/me/health/records", "stand", "records", "you", "/app/you/records"],
  ["/app/me/health/records?id=doc_42", "stand", "records", "you", "/app/you/records?id=doc_42"],
  ["/app/me/health/share", "stand", "share", "you", "/app/you/share"],
  ["/app/me/health/learned", "stand", "learned", "you", "/app/you/learned"],
  ["/app/me/health?health=markers", "stand", "markers", "you", "/app/you/markers"],
  ["/app/me/health/not-real", "stand", null, "you", "/app/you/health"],
  // Chat is Ask
  ["/app/chat", "chat", null, "ask", "/app/ask"],
  ["/app/chat?session=chat_17", "chat", null, "ask", "/app/ask?session=chat_17"],
  // Settings lives in You; its old landing slice IS the You landing
  ["/app/settings", "you", null, "you", "/app/you"],
  ["/app/settings/you", "you", null, "you", "/app/you"],
  ...["sources", "automation", "data", "agents", "devices", "system"].map((section) => [
    `/app/settings/${section}`,
    "settings",
    section,
    "you",
    `/app/you/settings/${section}`,
  ]),
  // The bare /<tab>/<section> and ?tab=<tab> forms the v1 parser accepted
  ["/plan/food", "plan", "food", "today", "/app/today/fuel"],
  ["/stand/records?id=doc_42", "stand", "records", "you", "/app/you/records?id=doc_42"],
  ["/progress/program", "progress", "program", "train", "/app/train/program"],
  ["/?tab=chat", "chat", null, "ask", "/app/ask"],
  ["/?tab=settings", "you", null, "you", "/app/you"],
  ["/?tab=session&date=2026-06-29", "session", null, "today", "/app/today/session?date=2026-06-29"],
];

test("the redirect table: every v1 path lands on its surface and rewrites to v2", () => {
  const routes = loadRoutes();
  for (const [url, view, section, home, canonical] of REDIRECTS) {
    assert.deepEqual(
      landing(routes, url),
      { view, section, home, legacy: true, canonical },
      `v1 ${url}`
    );
  }
});

test("the redirect table covers every v1 tab and every v1 section", () => {
  const v1 = {
    plan: ["edit", "endurance", "food", "meals", "coach"],
    progress: CLIENT_ROUTE_DEFINITIONS.sections.progress,
    stand: CLIENT_ROUTE_DEFINITIONS.sections.stand,
    me: ["standing", "profile", "memory", "health", "life", "family"],
    settings: ["you", "sources", "automation", "data", "agents", "devices", "system"],
  };
  const paths = new Set(REDIRECTS.map(([url]) => new URL(url, "http://x").pathname));
  for (const tab of ["session", "plan", "progress", "stand", "me", "chat", "settings"]) {
    assert.ok(paths.has(`/app/${tab}`), `/app/${tab} has a row`);
  }
  for (const [tab, sections] of Object.entries(v1)) {
    for (const section of sections) assert.ok(paths.has(`/app/${tab}/${section}`), `/app/${tab}/${section} has a row`);
  }
});

// Today is Home (v2 wave 7): Today never carries a date. An old dated Today link is
// flagged for the in-place rewrite; the router opens that day's own page.
test("a dated Today link is rewritten, and a day page keeps its date in its path", () => {
  const routes = loadRoutes();
  const old = routes.parseRoute("/app/today?date=2026-06-27");
  assert.equal(old.tab, "today");
  assert.equal(old.date, "2026-06-27");
  assert.equal(old.legacy, true);
  // The canonical day page is home-free: /app/day/<date>.
  const day = routes.parseRoute("/app/day/2026-06-27");
  assert.equal(day.tab, "day");
  assert.equal(day.home, "today", "a cold day page reads under Today");
  assert.equal(day.date, "2026-06-27");
  assert.equal(day.section, null);
  assert.equal(day.legacy, false, "canonical, never rewritten");
  assert.equal(routes.routeToUrl({ tab: "day", date: "2026-06-27" }), "/app/day/2026-06-27");
  assert.equal(routes.routeToUrl({ tab: "day", section: "horizon", date: "2026-06-27" }), "/app/day/2026-06-27", "the URL names no home");
  assert.equal(routes.homeOf("day"), "today");
  // A day page with no valid date has nothing to show (the router lands it on Today).
  assert.equal(routes.parseRoute("/app/day/not-a-date").date, null);
});

// The old day URLs keep working (docs/IA.md): each parses to the day page, carries the
// home it named (the opener the page is read under) and is flagged for the in-place
// rewrite to /app/day/<date>.
test("old day URLs are aliases of the home-free day page", () => {
  const routes = loadRoutes();
  for (const home of ["today", "train", "horizon", "ask", "you"]) {
    const day = routes.parseRoute(`/app/${home}/day?date=2026-06-27`);
    assert.equal(day.tab, "day", home);
    assert.equal(day.home, home);
    assert.equal(day.section, home === "today" ? null : home);
    assert.equal(day.date, "2026-06-27");
    assert.equal(day.legacy, true, "rewritten in place");
    assert.equal(routes.routeToUrl(day), "/app/day/2026-06-27");
    assert.equal(routes.homeOf("day", home), home);
  }
  for (const url of ["/app/day?date=2026-06-27", "/day?date=2026-06-27", "/?tab=day&date=2026-06-27"]) {
    const day = routes.parseRoute(url);
    assert.equal(day.tab, "day", url);
    assert.equal(day.date, "2026-06-27", url);
    assert.equal(day.legacy, true, url);
    assert.equal(routes.routeToUrl(day), "/app/day/2026-06-27", url);
  }
  // A peek in the address is not a reason to rewrite (the drill owns it).
  assert.equal(routes.parseRoute("/app/today?peek=2026-06-27").legacy, false);
  assert.equal(routes.homeOf("day", "bogus"), "today");
});

test("a canonical v2 URL parses to its surface and is never re-redirected", () => {
  const routes = loadRoutes();
  const V2 = [
    ["/app/today", "today", null, "today"],
    ["/app/day/2026-06-27", "day", null, "today"],
    ["/app/today/session?date=2026-06-29", "session", null, "today"],
    ["/app/today/fuel?date=2026-06-28", "plan", "food", "today"],
    ["/app/today/menu", "plan", "meals", "today"],
    ["/app/train", "progress", null, "train"],
    ...CLIENT_ROUTE_DEFINITIONS.sections.progress.map((leaf) => [`/app/train/${leaf}`, "progress", leaf, "train"]),
    ["/app/train/plan", "plan", "edit", "train"],
    ["/app/horizon", "horizon", null, "horizon"],
    ["/app/horizon/race", "plan", "endurance", "horizon"],
    ["/app/horizon/goal", "horizon", "goal", "horizon"],
    ["/app/ask", "chat", null, "ask"],
    ["/app/ask?session=chat_17", "chat", null, "ask"],
    ["/app/ask/changes", "plan", "coach", "ask"],
    ["/app/you", "you", null, "you"],
    ["/app/you/stone?id=heart", "you", "stone", "you"],
    ["/app/you/health", "stand", null, "you"],
    ["/app/you/domain?id=heart", "stand", "domain", "you"],
    ...["records", "share", "learned", "connections", "markers", "body", "recovery", "supplements", "age", "checkup"].map(
      (s) => [`/app/you/${s}`, "stand", s, "you"]
    ),
    ...["profile", "life", "family", "memory"].map((s) => [`/app/you/${s}`, "me", s, "you"]),
    ["/app/you/settings", "settings", null, "you"],
    ...CLIENT_ROUTE_DEFINITIONS.sections.settings.map((s) => [`/app/you/settings/${s}`, "settings", s, "you"]),
  ];
  for (const [url, view, section, home] of V2) {
    assert.deepEqual(landing(routes, url), { view, section, home, legacy: false, canonical: url }, `v2 ${url}`);
  }
  // Unrelated query params (a manifest shortcut's ?source=) are not a reason to rewrite.
  assert.equal(routes.parseRoute("/app/ask?source=shortcut").legacy, false);
  assert.equal(routes.parseRoute("/app/train/sessions?source=shortcut").legacy, false);
});

test("a v2 path that names nothing valid lands on its home and is tidied", () => {
  const routes = loadRoutes();
  assert.deepEqual(landing(routes, "/app/train/bogus"), {
    view: "progress", section: null, home: "train", legacy: true, canonical: "/app/train",
  });
  assert.deepEqual(landing(routes, "/app/you/domain"), {
    view: "stand", section: null, home: "you", legacy: true, canonical: "/app/you/health",
  });
  assert.deepEqual(landing(routes, "/app/you/settings/you"), {
    view: "settings", section: null, home: "you", legacy: true, canonical: "/app/you/settings",
  });
  assert.deepEqual(landing(routes, "/app/horizon/nope"), {
    view: "horizon", section: null, home: "horizon", legacy: true, canonical: "/app/horizon",
  });
});

test("route-state mirrors the route definitions and parses the full route shape", () => {
  const routes = loadRoutes();
  assert.deepEqual(plain(routes.routeDefinitions), plain(CLIENT_ROUTE_DEFINITIONS));
  assert.deepEqual(plain(routes.parseRoute("/app/today/fuel?date=2026-06-29")), {
    home: "today", tab: "plan", section: "food", healthSection: null, date: "2026-06-29", id: null, session: null, jump: null, legacy: false,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/me/health/markers?id=42")), {
    home: "you", tab: "stand", section: "markers", healthSection: null, date: null, id: "42", session: null, jump: null, legacy: true,
  });
  assert.equal(routes.parseRoute("/").tab, "today");
  assert.equal(routes.parseRoute("/not-real").tab, "today");
  assert.equal(routes.routeToUrl({ tab: "nope", section: "bad", date: "tomorrow" }), "/app/today");
});

test("routeToUrl writes view-keyed routes in the v2 grammar only", () => {
  const routes = loadRoutes();
  const cases = [
    [{ tab: "today", date: "2026-06-29" }, "/app/today?date=2026-06-29"],
    [{ tab: "session", date: "2026-06-29" }, "/app/today/session?date=2026-06-29"],
    [{ tab: "plan", section: "edit" }, "/app/train/plan"],
    [{ tab: "plan", section: "endurance" }, "/app/horizon/race"],
    [{ tab: "plan", section: "food", date: "2026-06-28" }, "/app/today/fuel?date=2026-06-28"],
    [{ tab: "plan", section: "coach" }, "/app/ask/changes"],
    [{ tab: "plan", jump: "food" }, "/app/today/fuel"],
    [{ tab: "plan", section: "meals" }, "/app/today/menu"],
    [{ tab: "plan", jump: "meals" }, "/app/today/menu"],
    [{ tab: "progress", section: "program" }, "/app/train/program"],
    [{ tab: "stand" }, "/app/you/health"],
    [{ tab: "stand", section: "records", id: "doc_42" }, "/app/you/records?id=doc_42"],
    [{ tab: "stand", section: "domain" }, "/app/you/health"],
    [{ tab: "me", section: "memory" }, "/app/you/memory"],
    [{ tab: "me", section: "standing" }, "/app/you/age"],
    [{ tab: "me", section: "health", healthSection: "records", id: 42 }, "/app/you/records?id=42"],
    [{ tab: "chat", session: "chat_17" }, "/app/ask?session=chat_17"],
    [{ tab: "settings", section: "system" }, "/app/you/settings/system"],
    [{ tab: "settings", section: "you" }, "/app/you"],
    [{ tab: "horizon", section: "goal" }, "/app/horizon/goal"],
    [{ tab: "you", section: "stone", id: "fuel" }, "/app/you/stone?id=fuel"],
    // A home key names its landing view.
    [{ tab: "train" }, "/app/train"],
    [{ tab: "ask" }, "/app/ask"],
  ];
  for (const [route, url] of cases) assert.equal(routes.routeToUrl(route), url, JSON.stringify(route));
  // jump never reaches a v2 URL.
  assert.doesNotMatch(routes.routeToUrl({ tab: "plan", section: "food", jump: "food" }), /jump/);
});

test("a cold /app/you/settings/devices load applies the devices segment (boot path, settings bundle not loaded)", () => {
  const routes = loadRoutes();
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8"), context);
  vm.runInNewContext(readFileSync(new URL("../public/js/app-router.js", import.meta.url), "utf8"), context);
  const state = {};
  const route = routes.parseRoute("https://cairn.local/app/you/settings/devices");
  const tab = context.window.CairnAppRouter.applyRouteState(route, {
    state,
    historyState: null,
    routeApi: context.window.CairnRoutes,
    planSections: [],
    progressSections: [],
    standSections: context.window.CairnRoutes.standSections,
    meSections: context.window.CairnRoutes.meSections,
    healthSections: context.window.CairnRoutes.healthSections,
    settingsSections: context.window.CairnRoutes.settingsSections,
  });
  assert.equal(tab, "settings");
  assert.equal(state.setSeg, "devices");
});

test("the server returns the app shell for every /app deep link", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const m = /app\.get\((\/\^\\\/app[^,]*\/),/.exec(src);
  assert.ok(m, "SPA fallback route present");
  const re = new RegExp(m[1].slice(1, -1));
  assert.ok(re.test("/app/you/settings/devices"));
});

test("homeOf maps every view (and each Plan section) to its tab-bar home", () => {
  const routes = loadRoutes();
  assert.deepEqual(plain(routes.homes), ["today", "train", "horizon", "ask", "you"]);
  const expected = {
    today: "today",
    session: "today",
    progress: "train",
    horizon: "horizon",
    chat: "ask",
    stand: "you",
    me: "you",
    settings: "you",
    you: "you",
  };
  for (const [view, home] of Object.entries(expected)) assert.equal(routes.homeOf(view), home, view);
  assert.equal(routes.homeOf("plan", "edit"), "train");
  assert.equal(routes.homeOf("plan", "endurance"), "horizon");
  assert.equal(routes.homeOf("plan", "food"), "today");
  assert.equal(routes.homeOf("plan", "meals"), "today");
  assert.equal(routes.homeOf("plan", "coach"), "ask");
  assert.equal(routes.homeOf("plan"), "train");
  for (const home of routes.homes) assert.equal(routes.homeOf(routes.viewFor(home)), home, `${home} round-trips`);
  assert.equal(routes.viewFor("train"), "progress");
  assert.equal(routes.viewFor("ask"), "chat");
  assert.equal(routes.viewFor("bogus"), "today");
});
