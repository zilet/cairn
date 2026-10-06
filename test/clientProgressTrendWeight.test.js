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
    pollToken: 0,
    peekCached: () => null,
    setTimeout,
    ...overrides,
  };
  // The 1RM series rides the SWR layer; in these tests it is a plain read of `api`.
  if (!overrides.cachedApi) context.cachedApi = (path) => context.api(path);
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-chart.js"), "utf8"), context);
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

  // One voice line and one fact, never a stat wall.
  assert.match(view.innerHTML, /class="phero-line">198\.1 lb, 8\.1 to go\.</);
  assert.match(view.innerHTML, /class="phero-fact lbl">−4\.3 lb since /);
  assert.doesNotMatch(view.innerHTML, /phero-stats/);
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

  // The goal-pace read (mounted by progress-screen.ts's mountGoalPaceChart) is
  // unified to LEAD, ahead of the numeral hero — this anchor is where it lands.
  assert.ok(view.innerHTML.indexOf('id="weightLeadMount"') < view.innerHTML.indexOf("phero-voice"));
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
  assert.match(hero.innerHTML, /Bench &lt;Press&gt;/);
  assert.match(hero.innerHTML, /lb&lt;script&gt;/);
  assert.doesNotMatch(hero.innerHTML, /<Press>|lb<script>/);
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

test("progress trend helper speaks the read as the hero's voice line, with one fact", async () => {
  const { elements, trendWeight } = loadTrendWeight({
    api: async () => ({
      unit: "lb",
      points: [
        { date: "2026-06-01", best1rm: 200 },
        { date: "2026-06-15", best1rm: 215.5 },
      ],
    }),
  });
  const canvas = { isConnected: true, style: {} };
  const hero = { innerHTML: "" };
  elements.set("#chart", canvas);
  elements.set("#pstats", { innerHTML: "" });
  elements.set("#trendHero", hero);

  await trendWeight.drawProgress("Bench Press");

  assert.match(hero.innerHTML, /class="phero-line">[^<]*Bench Press/);
  assert.match(hero.innerHTML, /class="phero-fact lbl">est\. 1RM 216 lb · \+15\.5 since the first</);
  assert.doesNotMatch(hero.innerHTML, /phero-stats|behind|low/i);
});

test("progress trend helper shows the plain title when there's no data for the exercise", async () => {
  const { elements, trendWeight } = loadTrendWeight({ api: async () => ({ points: [] }) });
  const canvas = { isConnected: true, style: {} };
  const hero = { innerHTML: "should be replaced" };
  elements.set("#chart", canvas);
  elements.set("#pstats", { innerHTML: "" });
  elements.set("#trendHero", hero);

  await trendWeight.drawProgress("New Exercise");

  assert.match(hero.innerHTML, /Estimated 1RM/);
  assert.doesNotMatch(hero.innerHTML, /phero-line/);
});

test("oneRmReadLine: thin data reads as early, never a fabricated trend", () => {
  const { trendWeight } = loadTrendWeight();
  const line = trendWeight.oneRmReadLine("Deadlift", [{ date: "2026-06-01", v: 300 }]);
  assert.match(line, /Deadlift/);
  assert.match(line, /early|getting started/i);
});

test("oneRmReadLine: a real climb, hold, and slide each read distinctly and name the count this month", () => {
  const { trendWeight } = loadTrendWeight();
  const climb = trendWeight.oneRmReadLine("Bench", [
    { date: "2026-06-01", v: 200 },
    { date: "2026-06-10", v: 205 },
    { date: "2026-06-20", v: 210 },
  ]);
  assert.match(climb, /Bench/);
  assert.match(climb, /climbing|rise|trending up/i);
  assert.match(climb, /3 best-sets this month/);

  const hold = trendWeight.oneRmReadLine("Squat", [
    { date: "2026-06-01", v: 300 },
    { date: "2026-06-20", v: 300.5 },
  ]);
  assert.match(hold, /holding|level/i);

  const slide = trendWeight.oneRmReadLine("Overhead Press", [
    { date: "2026-05-01", v: 120 },
    { date: "2026-06-20", v: 110 },
  ]);
  assert.match(slide, /eased back|drifted down|lighter/i);
  assert.doesNotMatch(slide, /behind|low\b/i);
});

test("oneRmReadLine escapes an exercise name safely at the render site", () => {
  const { trendWeight, context } = loadTrendWeight();
  const line = trendWeight.oneRmReadLine("Bench <Press>", [
    { date: "2026-06-01", v: 200 },
    { date: "2026-06-10", v: 205 },
  ]);
  const html = context.escHtml(line);
  assert.doesNotMatch(html, /<Press>/);
  assert.match(html, /&lt;Press&gt;/);
});

test("the 1RM picker lists loaded lifts and opens on the one trained last", async () => {
  const { view, trendWeight } = loadTrendWeight({ state: { tab: "progress", progressSeg: "trend" } });
  trendWeight.paintProgressBody([
    { name: "90/90 Hip Switch", muscle_group: "mobility", last_logged: "2026-09-21" },
    { name: "Dead Bug", muscle_group: "core", last_logged: "2026-09-21" },
    { name: "Plank", muscle_group: "core", mode: "timed", last_logged: null },
    { name: "Back Squat", muscle_group: "quads", last_logged: "2026-09-18" },
    { name: "Barbell Bench Press", muscle_group: "chest", last_logged: "2026-09-21" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(view.html, /90\/90 Hip Switch|Dead Bug|Plank/);
  assert.match(view.html, /<option selected>Barbell Bench Press<\/option>/);
  assert.match(view.html, /<option >Back Squat<\/option>/);
});

test("the bodyweight line measures 'to go' in the goal's own direction", () => {
  const paint = (rows, profile) => {
    const { elements, trendWeight, view } = loadTrendWeight();
    elements.set("#chart", { kind: "canvas" });
    trendWeight.paintWeightBody(rows, profile);
    return view.innerHTML;
  };
  const gain = [
    { date: "2026-06-01", weight_lb: 146 },
    { date: "2026-06-30", weight_lb: 150 },
  ];
  // A gain still short of its goal is never "at your goal".
  assert.match(paint(gain, { goal_weight_lb: 160 }), /class="phero-line">150 lb, 10 to go\.</);
  assert.match(paint(gain, { goal_weight_lb: 160, goal_mode: "gain" }), /150 lb, 10 to go\./);
  // A cut that has passed its goal, or a reading within half a pound, is there.
  const cut = [
    { date: "2026-06-01", weight_lb: 160 },
    { date: "2026-06-30", weight_lb: 153 },
  ];
  assert.match(paint(cut, { goal_weight_lb: 154 }), /153 lb — at your goal\./);
  assert.match(paint(cut, { goal_weight_lb: 153.4, goal_mode: "lose" }), /153 lb — at your goal\./);
  // Maintenance reads the distance either way, without "to go".
  assert.match(paint(cut, { goal_weight_lb: 150, goal_mode: "maintain" }), /153 lb, 3 from your goal\./);
});

test("a warm 1RM series paints the picker, hero and chart in one write; a cold one waits for the read", async () => {
  const series = { points: [{ date: "2026-06-01", best1rm: 200 }, { date: "2026-06-10", best1rm: 210 }], unit: "lb" };
  const exercises = [{ name: "Bench", muscle_group: "chest", last_logged: "2026-06-10" }];
  const state = { tab: "progress", progressSeg: "trend" };

  // Warm: the shell and the hero land together, before any read answers.
  let pendingWarm = null;
  const warm = loadTrendWeight({
    state,
    peekCached: (key) => (key === "progress:1rm:Bench" ? { data: series, fresh: true } : null),
    cachedApi: () => new Promise((resolve) => (pendingWarm = resolve)),
  });
  const heroWarm = { innerHTML: "" };
  warm.elements.set("#trendHero", heroWarm);
  warm.elements.set("#chart", { isConnected: true, style: {} });
  warm.elements.set("#pstats", { innerHTML: "" });
  warm.trendWeight.paintProgressBody(exercises);
  assert.match(warm.view.html, /<option selected>Bench<\/option>/);
  assert.match(heroWarm.innerHTML, /phero-line/);
  assert.ok(pendingWarm, "the warm series still revalidates behind");

  // Cold: nothing is written until the series answers, then all of it at once.
  let answer = null;
  const cold = loadTrendWeight({ state, cachedApi: () => new Promise((resolve) => (answer = resolve)) });
  const heroCold = { innerHTML: "" };
  cold.elements.set("#trendHero", heroCold);
  cold.elements.set("#chart", { isConnected: true, style: {} });
  cold.elements.set("#pstats", { innerHTML: "" });
  cold.trendWeight.paintProgressBody(exercises);
  assert.equal(cold.view.html, "");
  answer(series);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(cold.view.html, /<option selected>Bench<\/option>/);
  assert.match(heroCold.innerHTML, /phero-line/);
});

test("the weigh-in count and goal sit under the headline as its meta, not under the chart", () => {
  const { elements, trendWeight, view } = loadTrendWeight();
  elements.set("#chart", { kind: "canvas" });
  trendWeight.paintWeightBody(
    [
      { date: "2026-06-01", weight_lb: 202.4 },
      { date: "2026-06-30", weight_lb: 198.1 },
    ],
    { goal_weight_lb: 190 },
  );
  assert.match(view.innerHTML, /class="phero-meta lbl">2 weigh-ins · goal 190 lb</);
  assert.doesNotMatch(view.innerHTML, /chart-foot/);
});
