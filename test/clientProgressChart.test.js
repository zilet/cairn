import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressChart(tokens = {}) {
  const context = {
    Number,
    Object,
    String,
    document: { documentElement: {} },
    getComputedStyle: () => ({
      getPropertyValue: (name) => tokens[name] || "",
    }),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-chart-client.js"), "utf8"), context);
  return context.CairnProgressChart;
}

test("progress chart alpha helper expands hex colors", () => {
  const chart = loadProgressChart();

  assert.equal(chart.withAlpha("#abc", 0.5), "rgba(170,187,204,0.5)");
  assert.equal(chart.withAlpha("#112233", 0.25), "rgba(17,34,51,0.25)");
  assert.equal(chart.withAlpha("zz", 0.4), "rgba(0,0,0,0.4)");
});

test("progress chart colors read CSS tokens with fallbacks", () => {
  const chart = loadProgressChart({
    "--accent": "#111111",
    "--line-2": "#eeeeee",
  });
  const colors = chart.chartColors();

  assert.equal(colors.accent, "#111111");
  assert.equal(colors.line2, "#eeeeee");
  assert.equal(colors.sage, "#6e7f5c");
  assert.equal(colors.paper, "#f4efe7");
});
