import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressChart(tokens = {}) {
  const context = {
    Math,
    Number,
    Object,
    String,
    document: { documentElement: {} },
    getComputedStyle: () => ({
      getPropertyValue: (name) => tokens[name] || "",
    }),
    window: { devicePixelRatio: 2 },
    reducedMotion: () => true,
    fmtShortDate: (value) => `short ${value}`,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  context.window = Object.assign(context.window, context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-line-chart-model.js"), "utf8"), context);
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

function fakeCanvas() {
  const calls = [];
  const listeners = {};
  const ctx = {
    calls,
    setTransform: (...args) => calls.push(["setTransform", ...args]),
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: () => calls.push(["stroke"]),
    fill: () => calls.push(["fill"]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    setLineDash: (...args) => calls.push(["setLineDash", ...args]),
    bezierCurveTo: (...args) => calls.push(["bezierCurveTo", ...args]),
    closePath: () => calls.push(["closePath"]),
    arc: (...args) => calls.push(["arc", ...args]),
    roundRect: (...args) => calls.push(["roundRect", ...args]),
    measureText: (text) => ({ width: String(text).length * 6 }),
    createLinearGradient: (...args) => {
      calls.push(["createLinearGradient", ...args]);
      return { addColorStop: (...stopArgs) => calls.push(["addColorStop", ...stopArgs]) };
    },
  };
  const canvas = {
    clientWidth: 320,
    clientHeight: 180,
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0 }),
    setPointerCapture: () => {},
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    listeners,
  };
  return { canvas, calls, listeners };
}

test("progress line chart draws and wires one canvas", () => {
  const chart = loadProgressChart({ "--accent": "#112233", "--ink": "#111111" });
  const { canvas, calls, listeners } = fakeCanvas();

  chart.drawLineChart(
    canvas,
    [
      { date: "2026-06-01", v: 180 },
      { date: "2026-06-08", v: 190 },
      { date: "2026-06-15", v: 185 },
    ],
    { goal: 200, peak: true, fmt: (value) => `${value} lb` },
  );

  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 360);
  assert.equal(canvas._chartXs.length, 3);
  assert.equal(typeof canvas._setTarget, "function");
  assert.equal(canvas._scrubWired, true);
  assert.ok(listeners.pointerdown);
  assert.ok(listeners.pointermove);
  assert.ok(calls.some((call) => call[0] === "setTransform" && call[1] === 2));
  assert.ok(calls.some((call) => call[0] === "fillText" && String(call[1]).includes("GOAL 200")));
  assert.ok(calls.some((call) => call[0] === "fillText" && String(call[1]).includes("short 2026-06-01")));

  canvas._setTarget(1, true);
  assert.ok(calls.some((call) => call[0] === "fillText" && String(call[1]).includes("190 lb · short 2026-06-08")));
});
