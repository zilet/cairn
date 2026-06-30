import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadRoutes() {
  const src = readFileSync(new URL("../public/js/route-state.js", import.meta.url), "utf8");
  const context = { window: {}, URL, URLSearchParams };
  vm.runInNewContext(src, context);
  return context.window.CairnRoutes;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("route-state parses canonical deep links", () => {
  const routes = loadRoutes();
  assert.deepEqual(plain(routes.routeDefinitions), {
    appBasePath: "/app",
    defaults: {
      tab: "today",
      planSection: "edit",
      meSection: "standing",
      healthSection: "read",
      settingsSection: "agents",
    },
    tabs: ["today", "plan", "progress", "chat", "me", "settings"],
    sections: {
      plan: ["edit", "endurance", "food", "meals", "coach"],
      progress: ["trend", "volume", "endurance", "weight", "calendar", "sessions", "program", "energy"],
      me: ["standing", "profile", "memory", "health", "life", "family"],
      health: ["read", "markers", "records", "share", "learned"],
      settings: ["agents", "sources", "automation", "data"],
    },
  });
  assert.deepEqual(plain(routes.parseRoute("/app/today?date=2026-06-29")), {
    tab: "today", section: null, healthSection: null, date: "2026-06-29", id: null, session: null, jump: null,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/plan/meals?date=2026-06-29")), {
    tab: "plan", section: "meals", healthSection: null, date: "2026-06-29", id: null, session: null, jump: null,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/plan/food?date=2026-06-28")), {
    tab: "plan", section: "food", healthSection: null, date: "2026-06-28", id: null, session: null, jump: null,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/me/health/markers?id=42")), {
    tab: "me", section: "health", healthSection: "markers", date: null, id: "42", session: null, jump: null,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/chat?session=chat_17")), {
    tab: "chat", section: null, healthSection: null, date: null, id: null, session: "chat_17", jump: null,
  });
  assert.deepEqual(plain(routes.parseRoute("/app/settings/data")), {
    tab: "settings", section: "data", healthSection: null, date: null, id: null, session: null, jump: null,
  });
});

test("route-state serializes stable canonical links", () => {
  const routes = loadRoutes();
  assert.equal(routes.routeToUrl({ tab: "progress", section: "program" }), "/app/progress/program");
  assert.equal(routes.routeToUrl({ tab: "me", section: "health", healthSection: "records", id: 42 }), "/app/me/health/records?id=42");
  assert.equal(routes.routeToUrl({ tab: "plan", section: "coach" }), "/app/plan/coach");
  assert.equal(routes.routeToUrl({ tab: "plan", section: "food", date: "2026-06-28" }), "/app/plan/food?date=2026-06-28");
  assert.equal(routes.routeToUrl({ tab: "today", date: "2026-06-29" }), "/app/today?date=2026-06-29");
  assert.equal(routes.routeToUrl({ tab: "chat", session: "chat_17" }), "/app/chat?session=chat_17");
});

test("route-state normalizes invalid or legacy-ish input safely", () => {
  const routes = loadRoutes();
  assert.equal(routes.parseRoute("/").tab, "today");
  assert.equal(routes.parseRoute("/not-real").tab, "today");
  assert.deepEqual(plain(routes.parseRoute("/app/me/health/not-real")), {
    tab: "me", section: "health", healthSection: "read", date: null, id: null, session: null, jump: null,
  });
  assert.equal(routes.routeToUrl({ tab: "nope", section: "bad", date: "tomorrow" }), "/app/today");
});

test("route-state preserves every canonical app route family", () => {
  const routes = loadRoutes();
  const defs = routes.routeDefinitions;

  assert.equal(routes.parseRoute("/").tab, "today");
  assert.equal(routes.routeToUrl({ tab: "today", date: "2026-06-30" }), "/app/today?date=2026-06-30");

  for (const section of defs.sections.plan) {
    const path = `/app/plan/${section}`;
    assert.equal(routes.parseRoute(path).section, section);
    assert.equal(routes.routeToUrl({ tab: "plan", section }), path);
  }

  for (const section of defs.sections.progress) {
    const path = `/app/progress/${section}`;
    assert.equal(routes.parseRoute(path).section, section);
    assert.equal(routes.routeToUrl({ tab: "progress", section }), path);
  }

  for (const section of defs.sections.me) {
    const path = `/app/me/${section}`;
    assert.equal(routes.parseRoute(path).section, section);
    assert.equal(routes.routeToUrl({ tab: "me", section }), path);
  }

  for (const healthSection of defs.sections.health) {
    const path = `/app/me/health/${healthSection}`;
    assert.deepEqual(plain(routes.parseRoute(`${path}?id=doc_42`)), {
      tab: "me",
      section: "health",
      healthSection,
      date: null,
      id: "doc_42",
      session: null,
      jump: null,
    });
    assert.equal(routes.routeToUrl({ tab: "me", section: "health", healthSection, id: "doc_42" }), `${path}?id=doc_42`);
  }

  assert.equal(routes.routeToUrl({ tab: "chat", session: "chat_17" }), "/app/chat?session=chat_17");

  for (const section of defs.sections.settings) {
    const path = `/app/settings/${section}`;
    assert.equal(routes.parseRoute(path).section, section);
    assert.equal(routes.routeToUrl({ tab: "settings", section }), path);
  }
});
