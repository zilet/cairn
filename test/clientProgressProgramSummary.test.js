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
