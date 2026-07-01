import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadTrendWeight(overrides = {}) {
  const calls = [];
  const elements = new Map();
  const view = {
    html: "",
    set innerHTML(value) {
      this.html = value;
    },
    get innerHTML() {
      return this.html;
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    },
  };
  const context = {
    Map,
    Math,
    Number,
    Object,
    Promise,
    String,
    encodeURIComponent,
    PROGRESS_HANDLERS: {},
    PROGRESS_SEG: [],
    api: async () => ({ points: [] }),
    art: (kind, label) => `<svg data-kind="${kind}" data-label="${label}"></svg>`,
    drawLineChart: (...args) => calls.push(["drawLineChart", ...args]),
    runCountUps: (...args) => calls.push(["runCountUps", ...args]),
    segBar: (active) => `<seg>${active}</seg>`,
    stagger: (idx) => `--i:${idx}`,
    state: {},
    view,
    wireSeg: (...args) => calls.push(["wireSeg", ...args]),
    $: (selector) => elements.get(selector) || null,
    ...overrides,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-data-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-components-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-trend-weight-client.js"), "utf8"), context);
  return { calls, context, elements, trendWeight: context.CairnProgressTrendWeight, view };
}

test("progress bodyweight helper renders chart input without owning the route", () => {
  const { calls, elements, trendWeight, view } = loadTrendWeight();
  const canvas = { kind: "canvas" };
  elements.set("#chart", canvas);

  trendWeight.paintWeightBody(
    [
      { date: "2026-06-01", weight_lb: 202.4 },
      { date: "2026-06-30", weight_lb: 198.1 },
    ],
    { goal_weight_lb: 190 },
  );

  assert.match(view.innerHTML, /Bodyweight/);
  assert.match(view.innerHTML, /-4.3/);
  assert.match(view.innerHTML, /goal 190 lb/);
  assert.ok(calls.some((call) => call[0] === "wireSeg"));
  assert.ok(calls.some((call) => call[0] === "runCountUps" && call[1] === view));

  const chartCall = calls.find((call) => call[0] === "drawLineChart");
  assert.equal(chartCall?.[1], canvas);
  assert.equal(JSON.stringify(chartCall?.[2]), JSON.stringify([
    { date: "2026-06-01", v: 202.4 },
    { date: "2026-06-30", v: 198.1 },
  ]));
  assert.equal(chartCall?.[3].goal, 190);
});

test("progress trend helper escapes API text and draws the peak chart", async () => {
  const apiPaths = [];
  const { calls, elements, trendWeight } = loadTrendWeight({
    api: async (path) => {
      apiPaths.push(path);
      return {
        unit: "lb<script>",
        points: [
          { date: "2026-06-01", best1rm: 200 },
          { date: "2026-06-15", best1rm: 215.5 },
        ],
      };
    },
  });
  const canvas = { isConnected: true, style: {} };
  const stats = { innerHTML: "" };
  const hero = { innerHTML: "" };
  elements.set("#chart", canvas);
  elements.set("#pstats", stats);
  elements.set("#trendHero", hero);

  await trendWeight.drawProgress("Bench <Press>");

  assert.deepEqual(apiPaths, ["/progress/Bench%20%3CPress%3E"]);
  assert.match(hero.innerHTML, /Estimated 1RM/);
  assert.match(stats.innerHTML, /lb&lt;script&gt;/);
  assert.doesNotMatch(stats.innerHTML, /lb<script>/);

  const chartCall = calls.find((call) => call[0] === "drawLineChart");
  assert.equal(chartCall?.[1], canvas);
  assert.equal(JSON.stringify(chartCall?.[2]), JSON.stringify([
    { date: "2026-06-01", v: 200 },
    { date: "2026-06-15", v: 215.5 },
  ]));
  assert.equal(JSON.stringify(chartCall?.[3]), JSON.stringify({ peak: true }));
});
