import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgramSummaryClient() {
  const context = {
    Math,
    Number,
    Object,
    String,
    stagger(index) {
      return `--i:${index}`;
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-summary-client.js"), "utf8"), context);
  return context.CairnProgressProgramSummary;
}

test("progress program summary maps lift words and figures", () => {
  const summary = loadProgramSummaryClient();

  assert.equal(summary.liftStatusWord({ status: "progressing" }), "climbing");
  assert.equal(summary.liftStatusWord({ status: "plateaued", weeks_static: 3 }), "stalled ~3 wk");
  assert.equal(summary.liftStatusWord({ status: "regressing" }), "trending down");
  assert.equal(summary.liftTrendFig({ trend_per_wk: 2.48 }), "+2.5 lb/wk");
  assert.equal(summary.liftTrendFig({ trend_per_wk: -4.2, mode: "timed" }), "−4 sec/wk");
  assert.equal(summary.liftBestFig({ est_1rm: 184.6 }), "185 lb");
  assert.equal(summary.liftBestFig({ mode: "timed", best_seconds: 105 }), "1:45");
  assert.equal(summary.volBandWord("low"), "below productive range");
  assert.equal(summary.volTrendGlyph("rising"), " ↑");
  assert.equal(summary.phaseWord("deload-due"), "Deload due");

  const sorted = summary.sortLifts([
    { exercise: "New", status: "new" },
    { exercise: "Up", status: "progressing" },
    { exercise: "Stalled", status: "plateaued" },
    { exercise: "Down", status: "regressing" },
  ]);
  assert.deepEqual(sorted.map((lift) => lift.exercise), ["Stalled", "Down", "Up", "New"]);
});

test("progress program summary renders rows safely", () => {
  const summary = loadProgramSummaryClient();
  const html = summary.liftRowHtml(
    {
      exercise: "Bench <press>",
      status: "plateaued",
      weeks_static: 2,
      est_1rm: 185,
      trend_per_wk: 2.5,
      why: "Top set stuck <twice>",
    },
    7,
  );

  assert.match(html, /prow-stalled/);
  assert.match(html, /Bench &lt;press&gt;/);
  assert.match(html, /stalled ~2 wk/);
  assert.match(html, /185 lb · \+2\.5 lb\/wk/);
  assert.match(html, /Top set stuck &lt;twice&gt;/);
  assert.match(html, /--i:7/);
  assert.doesNotMatch(html, /<press>|<twice>/);
});

function liftFixture(overrides) {
  return {
    exercise: "Lift",
    muscle_group: "chest",
    mode: "reps",
    sessions: 6,
    est_1rm: 200,
    best_seconds: null,
    trend_per_wk: null,
    status: "maintaining",
    stall_signals: [],
    weeks_static: null,
    suggested_action: "overload",
    why: "",
    family_key: "lift",
    family_label: "Lift",
    last_trained: "2026-04-10",
    ...overrides,
  };
}

test("curated read: needs-a-look sorts urgent-first, caps at 4, folds the rest", () => {
  const summary = loadProgramSummaryClient();
  const lifts = [];
  for (let i = 1; i <= 5; i++)
    lifts.push(liftFixture({ exercise: `Stall ${i}`, status: "plateaued", weeks_static: i, family_key: `stall ${i}`, family_label: `Stall ${i}` }));
  lifts.push(liftFixture({ exercise: "Slipping", status: "regressing", family_key: "slipping", family_label: "Slipping" }));

  const needs = summary.needsLookLifts(lifts);
  assert.equal(needs.length, 6);
  assert.equal(needs[0].exercise, "Slipping", "regressing (declining) sorts ahead of merely-flat");
  assert.equal(needs[1].exercise, "Stall 5", "then the longest-static plateau");

  const html = summary.curatedLiftsHtml(lifts);
  assert.match(html, /Needs a look/);
  // 4 shown as full .prow rows outside the fold, the other 2 inside it — 6 total.
  assert.equal((html.match(/class="prow reveal/g) || []).length, 6);
  assert.match(html, /prow-more-fold/);
  assert.match(html, /Show 2 more to look at/);
});

test("curated read: climbing shows the steepest three, then a calm summary line", () => {
  const summary = loadProgramSummaryClient();
  const lifts = [];
  for (let i = 1; i <= 5; i++)
    lifts.push(liftFixture({ exercise: `Climb ${i}`, status: "progressing", trend_per_wk: i, family_key: `climb ${i}`, family_label: `Climb ${i}` }));

  const climbing = summary.climbingLifts(lifts);
  assert.deepEqual(climbing.map((l) => l.exercise), ["Climb 5", "Climb 4", "Climb 3", "Climb 2", "Climb 1"]);

  const html = summary.curatedLiftsHtml(lifts);
  assert.match(html, /Climbing/);
  assert.equal((html.match(/prow-compact /g) || []).length, 3, "only the top three render as compact rows");
  assert.ok(html.indexOf("Climb 5") < html.indexOf("Climb 4"), "steepest climb first");
  assert.match(html, /2 more lifts are climbing/);
});

test("curated read: the long tail groups by movement family, single-lift families stay plain", () => {
  const summary = loadProgramSummaryClient();
  const lifts = [
    liftFixture({ exercise: "Barbell Bench Press", family_key: "bench press", family_label: "Bench Press", last_trained: "2026-04-15" }),
    liftFixture({ exercise: "DB Bench Press", status: "progressing", trend_per_wk: 2, family_key: "bench press", family_label: "Bench Press", last_trained: "2026-04-12" }),
    liftFixture({ exercise: "Back <Squat>", family_key: "back squat", family_label: "Back Squat", last_trained: "2026-04-10" }),
  ];

  const groups = summary.familyGroups(lifts);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.key === "bench press").lifts.length, 2, "both bench variants share a family");
  assert.equal(groups.find((g) => g.key === "back squat").lifts.length, 1, "the squat is its own family");

  const html = summary.curatedLiftsHtml(lifts);
  assert.match(html, /prow-all-fold/, "the long tail is collapsed behind a details fold");
  assert.match(html, /Everything you train \(3\)/);
  assert.match(html, /prow-fam-head/, "the multi-variant bench family shows a family header");
  // Every row is tappable to the exercise guide.
  assert.match(html, /data-guide="Barbell%20Bench%20Press"/);
  // Server strings are escaped.
  assert.match(html, /Back &lt;Squat&gt;/);
  assert.doesNotMatch(html, /<Squat>/);
});

test("curated read: the long tail opens by default only when there are no highlights", () => {
  const summary = loadProgramSummaryClient();

  // No highlights (everything maintaining/new) → the long tail opens so the
  // training home is never visually empty.
  const calmHtml = summary.curatedLiftsHtml([
    liftFixture({ exercise: "Row", status: "maintaining", family_key: "row", family_label: "Row" }),
    liftFixture({ exercise: "Curl", status: "new", family_key: "curl", family_label: "Curl" }),
  ]);
  assert.doesNotMatch(calmHtml, /Needs a look/);
  assert.doesNotMatch(calmHtml, /Climbing/);
  assert.match(calmHtml, /<details class="full-read prow-all-fold reveal" open /, "the long tail is open when it stands alone");

  // A highlight exists (one plateaued lift) → the long tail stays collapsed.
  const withHighlightHtml = summary.curatedLiftsHtml([
    liftFixture({ exercise: "Bench", status: "plateaued", weeks_static: 3, family_key: "bench", family_label: "Bench" }),
    liftFixture({ exercise: "Row", status: "maintaining", family_key: "row", family_label: "Row" }),
  ]);
  assert.match(withHighlightHtml, /Needs a look/);
  assert.doesNotMatch(withHighlightHtml, /prow-all-fold reveal" open /, "the long tail stays collapsed when a highlight leads");
});

test("progress program summary renders volume, mesocycle, and adaptations safely", () => {
  const summary = loadProgramSummaryClient();
  const volume = summary.volumeBlockHtml(
    [
      { muscle_group: "Chest <push>", weekly_sets: "12<script>", band: "low", trend: "rising" },
      { muscle_group: "Back <pull>", weekly_sets: 18, band: "productive", trend: "falling" },
    ],
    3,
  );
  const meso = summary.mesoBlockHtml(
    { phase: "intensification", weeks_since_deload: 5, note: "Hold one hard week <then deload>" },
    4,
  );
  const adaptations = summary.adaptationsHtml(["Add core <carry>", "Rotate press <angle>"], 5);

  assert.match(volume, /Chest &lt;push&gt;/);
  assert.match(volume, /12&lt;script&gt;/);
  assert.match(volume, /↑ below productive range/);
  assert.match(volume, /↓ in the productive zone/);
  assert.match(meso, /Intensification · 5 wk since deload/);
  assert.match(meso, /Hold one hard week &lt;then deload&gt;/);
  assert.match(adaptations, /What to evolve next/);
  assert.match(adaptations, /Add core &lt;carry&gt;/);
  assert.doesNotMatch(`${volume}${meso}${adaptations}`, /<push>|<script>|<then deload>|<carry>|<angle>/);
});
