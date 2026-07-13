import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the compiled Progress route module (IIFE-wrapped; it exposes its helpers
// via Object.assign(globalThis, …)) over the real html/data helpers, so escaping
// and normalization are exercised for real. goalPaceChartHtml is a pure
// payload-in → SVG-card-string-out function, which is the goal-pace chart's
// load-bearing unit.
function loadProgressScreen() {
  const context = {
    Object,
    Math,
    Number,
    String,
    Array,
    Date,
    JSON,
    Map,
    Promise,
    isFinite,
    isNaN,
    stagger: (i) => `--i:${i}`,
    state: {},
    view: { querySelector: () => null },
    pollToken: 0,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-data-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/05-progress.js"), "utf8"), context);
  return context;
}

const ON_PACE = {
  points: [
    { date: "2026-05-01", weight_lb: 200 },
    { date: "2026-06-01", weight_lb: 196.5 },
    { date: "2026-07-01", weight_lb: 193 },
  ],
  trend: { lb_wk: -0.8, line: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 193 }] },
  needed: { lb_wk: -0.8, line: [{ date: "2026-07-01", weight_lb: 193 }, { date: "2026-10-04", weight_lb: 172 }] },
  goal: { weight_lb: 172, date: "2026-10-04" },
  window_days: 90,
};

test("goal-pace chart draws the trend, needed pace, goal ring and an on-pace read", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  const html = goalPaceChartHtml(ON_PACE);
  assert.match(html, /<svg[^>]*class="gpace-chart"/); // one responsive SVG chart
  assert.match(html, /#b4552d/); // trend line — terracotta, solid, heavier
  assert.match(html, /stroke-dasharray="5 4"/); // needed pace — sage, dashed
  assert.match(html, /gpace-goal-ring/); // the quiet goal ring marker
  assert.match(html, /172 lb · Oct 4/); // its small label
  assert.match(html, /Trending −0\.8 lb\/wk — on pace for Oct 4\./); // calm, adherence-neutral read
});

test("an absent endpoint (or no weigh-ins) leaves the Weight view unchanged", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  // "" means nothing is injected, so the existing canvas view is untouched.
  assert.equal(goalPaceChartHtml(null), "");
  assert.equal(goalPaceChartHtml(undefined), "");
  assert.equal(goalPaceChartHtml({}), "");
  assert.equal(goalPaceChartHtml({ points: [] }), "");
  // A single weigh-in with nothing to aim at has no honest pace story.
  assert.equal(goalPaceChartHtml({ points: [{ date: "2026-07-01", weight_lb: 193 }] }), "");
});

test("behind pace states the needed rate as information, never blame", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  const html = goalPaceChartHtml({
    points: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 199 }],
    trend: { lb_wk: -0.3, line: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 199 }] },
    needed: { lb_wk: -0.9, line: [{ date: "2026-07-01", weight_lb: 199 }, { date: "2026-10-04", weight_lb: 172 }] },
    goal: { weight_lb: 172, date: "2026-10-04" },
    window_days: 90,
  });
  assert.match(html, /Trending −0\.3 lb\/wk; −0\.9 would meet Oct 4\./);
  assert.match(html, /gpace-read-behind/);
});

test("a cut running well past the needed rate reads calmly as ahead of pace, not blamed or alarmed", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  const html = goalPaceChartHtml({
    points: [{ date: "2026-05-01", weight_lb: 210 }, { date: "2026-07-01", weight_lb: 185.6 }],
    trend: { lb_wk: -3.1, line: [{ date: "2026-05-01", weight_lb: 210 }, { date: "2026-07-01", weight_lb: 185.6 }] },
    needed: { lb_wk: -0.9, line: [{ date: "2026-07-01", weight_lb: 185.6 }, { date: "2026-10-04", weight_lb: 172 }] },
    goal: { weight_lb: 172, date: "2026-10-04" },
    window_days: 90,
  });
  assert.match(html, /Trending −3\.1 lb\/wk — ahead of the needed pace for Oct 4\./);
  assert.match(html, /gpace-read-on/); // still the calm on-pace styling, never alarming
});

test("no goal → no needed-pace line and no read line (the chart still shows the trend)", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  const html = goalPaceChartHtml({
    points: [
      { date: "2026-05-01", weight_lb: 200 },
      { date: "2026-06-01", weight_lb: 197 },
      { date: "2026-07-01", weight_lb: 194 },
    ],
    trend: { lb_wk: -0.7, line: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 194 }] },
    needed: { lb_wk: null, line: null },
    goal: null,
    window_days: 90,
  });
  assert.match(html, /#b4552d/); // trend line still drawn
  assert.doesNotMatch(html, /stroke-dasharray="5 4"/); // no needed pace line
  assert.doesNotMatch(html, /gpace-read/); // no read line at all
});

test("the server's null-field shapes read as absent, never as a real 0", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  // goalPace() returns {weight_lb:null,date:null}/{lb_wk:null,line:null} objects
  // rather than dropping the keys — Number(null) is 0, so these must NOT invent a
  // "0 lb" goal ring or a "Trending 0 lb/wk" read.
  assert.equal(
    goalPaceChartHtml({ points: [{ date: "2026-07-01", weight_lb: 193 }], trend: { lb_wk: null, line: null }, needed: { lb_wk: null, line: null }, goal: { weight_lb: null, date: null }, window_days: 90 }),
    "",
  );
  const noGoal = goalPaceChartHtml({
    points: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 194 }],
    trend: { lb_wk: -0.7, line: [{ date: "2026-05-01", weight_lb: 200 }, { date: "2026-07-01", weight_lb: 194 }] },
    needed: { lb_wk: null, line: null },
    goal: { weight_lb: null, date: null },
    window_days: 90,
  });
  assert.match(noGoal, /#b4552d/); // trend still drawn
  assert.doesNotMatch(noGoal, /gpace-goal-ring/); // no phantom 0-lb goal
  assert.doesNotMatch(noGoal, /gpace-read/);
});

test("a goal with a not-yet-trustworthy trend shows the target without inventing a trend", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  // Short span → trend {lb_wk:null,line:null}, but a goal + needed pace exist.
  const html = goalPaceChartHtml({
    points: [{ date: "2026-06-29", weight_lb: 181 }, { date: "2026-07-01", weight_lb: 180 }],
    trend: { lb_wk: null, line: null },
    needed: { lb_wk: -0.9, line: [{ date: "2026-07-01", weight_lb: 180 }, { date: "2026-10-04", weight_lb: 172 }] },
    goal: { weight_lb: 172, date: "2026-10-04" },
    window_days: 90,
  });
  assert.match(html, /gpace-goal-ring/); // the goal to aim at
  assert.match(html, /stroke-dasharray="5 4"/); // the pace it needs
  assert.doesNotMatch(html, /class="gpace-trend"/); // no trend line
  assert.doesNotMatch(html, /Trending/); // and no "Trending 0 lb/wk" read
});

test("the y-range is floored so a small weight wiggle never fills the height", () => {
  const { goalPaceChartHtml } = loadProgressScreen();
  const html = goalPaceChartHtml({
    points: [
      { date: "2026-06-01", weight_lb: 199.4 },
      { date: "2026-06-15", weight_lb: 200.1 },
      { date: "2026-07-01", weight_lb: 199.8 },
    ],
    trend: { lb_wk: 0.1, line: [{ date: "2026-06-01", weight_lb: 199.4 }, { date: "2026-07-01", weight_lb: 199.8 }] },
    needed: null,
    goal: null,
    window_days: 90,
  });
  const m = html.match(/data-yspan="([\d.]+)"/);
  assert.ok(m, "chart exposes its visible y-span");
  // Raw span is 0.7 lb; the floor (≥8 lb / 5% of bodyweight) keeps it honest.
  assert.ok(Number(m[1]) >= 8, `expected a floored y-span ≥8, got ${m && m[1]}`);
});
