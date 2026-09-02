// The composite side-read prefetch the Today loaders consume
// (primeTodaySide / the loaders in src/client/today-side-loaders.ts).
//
// The prefetch (GET /today-side) is an optimization, never a dependency: what
// these pin is that a primed render costs no per-panel GET, that anything else —
// no prime, a prime for another date, a key the server could not read, a prime
// already spent — falls straight back to the panel's own request, and that a
// panel never draws from a prime twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadSideLoaders() {
  const context = {
    Math,
    Number,
    Object,
    String,
    Array,
    Promise,
    Set,
    Date,
    escHtml: escapeHtml,
    escAttr: escapeHtml,
    relAge: (iso) => `rel:${iso}`,
    CairnTodayLately: { garminSessionCard: () => "" },
    CairnTodayContext: {
      contextBannerHtml: (events) => `events:${events.length}`,
      healthFocusBannerHtml: (data) => (data ? `focus:${data.marker}` : ""),
    },
    CairnUiReads: { baselineBandHtml: (options) => `<div>${escapeHtml(options.label)}</div>` },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-side-loaders.js"), "utf8"), context);
  return context.CairnTodaySideLoaders;
}

// A deps object whose api() records every path it is asked for.
function makeDeps(slotId, apiResponse) {
  // querySelector answers null: these panels only look for their own buttons to
  // wire, and none of these assertions are about wiring.
  const slot = { innerHTML: "", isConnected: true, querySelector: () => null };
  const asked = [];
  return {
    slot,
    asked,
    deps: {
      root: { querySelector: (sel) => (sel === slotId ? slot : null) },
      state: { tab: "today", logDate: "2026-07-30" },
      api: async (path) => {
        asked.push(path);
        return typeof apiResponse === "function" ? apiResponse(path) : apiResponse;
      },
      activateTab() {},
      runCountUps() {},
      escapeHtml,
      localISO: () => "2026-07-30",
      stagger: () => "",
    },
  };
}

const COMPOSITE = {
  date: "2026-07-30",
  context_events: [
    { kind: "travel", title: "Trip" },
    { kind: "illness", title: "Cold" },
  ],
  recovery_baseline: {
    dimensions: [{ label: "HRV", position: 0.5, range_start: 0.2, range_end: 0.8, phrase: "usual" }],
  },
  health_synthesis: { marker: "apoB" },
};

test("a primed render draws the panel without asking for its own endpoint", async () => {
  const loaders = loadSideLoaders();
  const { slot, asked, deps } = makeDeps("#ctxEvents", []);

  loaders.primeTodaySide("2026-07-30", Promise.resolve(COMPOSITE));
  await loaders.loadContextBanner(deps);

  assert.deepEqual(asked, [], "no /context-events request");
  assert.equal(slot.innerHTML, "events:2", "and the panel drew from the composite");
});

test("with no prime the panel fetches exactly as it always did", async () => {
  const loaders = loadSideLoaders();
  const { asked, deps } = makeDeps("#ctxEvents", []);

  await loaders.loadContextBanner(deps);

  assert.deepEqual(asked, ["/context-events?active=1"]);
});

test("a prime for another date is not consumed", async () => {
  const loaders = loadSideLoaders();
  const { asked, deps } = makeDeps("#ctxEvents", []);

  loaders.primeTodaySide("2026-07-29", Promise.resolve(COMPOSITE));
  await loaders.loadContextBanner(deps);

  assert.deepEqual(asked, ["/context-events?active=1"], "yesterday's prefetch never lands on today's panel");
});

test("a key the server could not read falls back to the individual route", async () => {
  const loaders = loadSideLoaders();
  const { asked, deps } = makeDeps("#ctxEvents", []);

  loaders.primeTodaySide("2026-07-30", Promise.resolve({ ...COMPOSITE, context_events: null }));
  await loaders.loadContextBanner(deps);

  assert.deepEqual(asked, ["/context-events?active=1"], "per-key degradation costs a request, never the panel");
});

test("a failed composite costs nothing but the trip it saved", async () => {
  const loaders = loadSideLoaders();
  const { asked, deps } = makeDeps("#ctxEvents", []);

  loaders.primeTodaySide("2026-07-30", Promise.reject(new Error("offline")));
  await loaders.loadContextBanner(deps);

  assert.deepEqual(asked, ["/context-events?active=1"]);
});

test("each key is handed out once — a second draw refetches", async () => {
  const loaders = loadSideLoaders();
  const first = makeDeps("#ctxEvents", []);
  const second = makeDeps("#ctxEvents", []);

  loaders.primeTodaySide("2026-07-30", Promise.resolve(COMPOSITE));
  await loaders.loadContextBanner(first.deps);
  await loaders.loadContextBanner(second.deps);

  assert.deepEqual(first.asked, []);
  assert.deepEqual(second.asked, ["/context-events?active=1"], "a redraw is a deliberate refresh");
});

test("one prime feeds several different panels", async () => {
  const loaders = loadSideLoaders();
  const bands = makeDeps("#wearBands", { dimensions: [] });
  const health = makeDeps("#ctxHealth", null);

  loaders.primeTodaySide("2026-07-30", Promise.resolve(COMPOSITE));
  await loaders.loadRecoveryBands(bands.deps);
  await loaders.loadHealthFocusBanner(health.deps);

  assert.deepEqual(bands.asked, [], "no /recovery/baseline request");
  assert.deepEqual(health.asked, [], "no /health/synthesis request");
  assert.match(bands.slot.innerHTML, /HRV/);
  assert.equal(health.slot.innerHTML, "focus:apoB");
});
