import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthMarkers() {
  const context = {
    console,
    Date,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    String,
    JSON,
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    reducedMotion: () => true,
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  for (const file of [
    "public/js/date-utils.js",
    "public/js/html-utils.js",
    "public/js/ui-components.js",
    "public/js/health-client.js",
    "public/js/health-picture-client.js",
    "public/js/health-markers-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthMarkers;
}

function markerFixture() {
  return {
    key: 'ldl"bad',
    name: "LDL <bad>",
    unit: "mg/dL <unit>",
    latest: { value: 110, date: "2026-06-20", flag: "high" },
    prev: { value: 80, date: "2026-06-01" },
    optimal: { low: 70, high: 100 },
    points: [
      { value: 80, date: "2026-06-01", flag: "normal" },
      { value: 110, date: "2026-06-20", flag: "high" },
    ],
  };
}

test("health marker chart SVG escapes marker text and carries scrub data", () => {
  const markers = loadHealthMarkers();
  const svg = markers.markerChartSvg(markerFixture());

  assert.match(svg, /class="hchart"/);
  assert.match(svg, /class="hchart-band"/);
  assert.match(svg, /class="hchart-line"/);
  assert.match(svg, /fill="#b3402e"/);
  assert.match(svg, /data-pts="/);
  assert.match(svg, /mg\/dL &lt;unit&gt;/);
  assert.doesNotMatch(svg, /<unit>|<bad>/);
  assert.equal(markers.markerChartSvg({ points: [{ value: 1 }] }), "");
});

test("health marker row keeps expandable chart markup bounded and escaped", () => {
  const markers = loadHealthMarkers();
  const html = markers.hmkRowHtml(markerFixture(), 2);

  assert.match(html, /class="hmk reveal hmk-x"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-mkey="ldl&quot;bad"/);
  assert.match(html, /LDL &lt;bad&gt;/);
  assert.match(html, /mg\/dL &lt;unit&gt;/);
  assert.match(html, /hmk-delta/);
  assert.match(html, /▲ 30/);
  assert.match(html, /hchart-latest/);
  assert.match(html, /optimal 70–100/);
  assert.match(html, /holding steady/);
  assert.doesNotMatch(html, /<bad>|<unit>/);
});

test("health marker chart wiring is idempotent and updates the scrub affordance", () => {
  const markers = loadHealthMarkers();
  const listeners = new Map();
  const classes = new Set();
  const guide = fakeNode();
  const cursor = fakeNode();
  const tipRect = fakeNode();
  const tipText = fakeNode({ getComputedTextLength: () => 34 });
  const tip = fakeNode({ querySelector: (selector) => selector === "rect" ? tipRect : selector === "text" ? tipText : null });
  const svg = fakeNode({
    dataset: {
      pts: JSON.stringify([
        { x: 14, y: 60, t: "80 mg/dL" },
        { x: 286, y: 30, t: "110 mg/dL" },
      ]),
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    getBoundingClientRect: () => ({ left: 0, width: 300 }),
    querySelector: (selector) => {
      if (selector === ".hchart-guide") return guide;
      if (selector === ".hchart-cursor") return cursor;
      if (selector === ".hchart-tip") return tip;
      return null;
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    setPointerCapture: () => {},
  });

  markers.wireMarkerChart(svg);
  markers.wireMarkerChart(svg);

  assert.equal(svg._scrubWired, true);
  assert.equal(listeners.get("pointerdown").length, 1);
  listeners.get("pointerdown")[0]({ pointerType: "mouse", clientX: 290 });

  assert.equal(classes.has("scrubbing"), true);
  assert.equal(tipText.textContent, "110 mg/dL");
  assert.equal(guide.attrs.x1, "286.0");
  assert.equal(cursor.attrs.cx, "286.0");
  assert.equal(cursor.attrs.cy, "30.0");
  assert.equal(tip.attrs.transform, "translate(248.0,4.0)");
});

function fakeNode(overrides = {}) {
  return {
    attrs: {},
    textContent: "",
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    querySelector: () => null,
    ...overrides,
  };
}
