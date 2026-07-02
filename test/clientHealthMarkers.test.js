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
    "public/js/health-evidence-client.js",
    "public/js/health-marker-order-client.js",
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

test("single-reading marker with an optimal band expands to a gauge with the target", () => {
  const markers = loadHealthMarkers();
  const single = {
    key: "apob",
    name: "ApoB",
    unit: "mg/dL",
    latest: { value: 105, date: "2026-06-20", flag: null },
    optimal: { low: 0, high: 80, dir: "high" },
    in_optimal: false,
    points: [{ value: 105, date: "2026-06-20", flag: null }],
  };
  const html = markers.hmkRowHtml(single, 0);

  assert.match(html, /hmk-x/); // expandable even with one reading
  assert.match(html, /hgauge/); // band gauge, not a trend chart
  assert.doesNotMatch(html, /hchart-line/);
  assert.match(html, /single reading/);
  assert.match(html, /optimal ≤ 80 mg\/dL/); // dir-aware target phrase
  assert.match(html, /above optimal/);
  assert.match(html, /fill="#b3402e"/); // out-of-band dot reads warn
  // dir 'high': only the edge that matters gets a label (no "0" noise).
  const gauge = html.slice(html.indexOf("<svg"));
  assert.doesNotMatch(gauge, />0</);
  assert.match(gauge, />80</);
});

test("single-reading marker without an optimal band stays a plain row", () => {
  const markers = loadHealthMarkers();
  const html = markers.hmkRowHtml({
    name: "Blood Type",
    latest: { value: "O+", date: "2026-01-10" },
    points: [{ value: "O+", date: "2026-01-10" }],
  }, 0);

  assert.doesNotMatch(html, /hmk-x/);
  assert.doesNotMatch(html, /hgauge/);
  assert.match(html, /hmk-chev-ghost/);
});

test("optimal phrasing and side words honor the zone direction", () => {
  const markers = loadHealthMarkers();
  assert.equal(markers.optimalPhrase({ optimal: { low: 40, high: 200, dir: "low" }, unit: "ng/mL" }), "≥ 40 ng/mL");
  assert.equal(markers.optimalPhrase({ optimal: { low: 70, high: 100 } }), "70–100");
  assert.equal(markers.optimalPhrase({ optimal: null }), "");
  assert.equal(markers.optimalSideWord({ optimal: { low: 40, high: 60 }, latest: { value: 20 } }), "below optimal");
  assert.equal(markers.optimalSideWord({ optimal: { low: 40, high: 60 }, latest: { value: 50 } }), "");
  assert.equal(markers.markerOutOfRange({ latest: { flag: "low" } }), true);
  assert.equal(markers.markerOutOfRange({ latest: { flag: null }, in_optimal: false }), true);
  assert.equal(markers.markerOutOfRange({ latest: { flag: "normal" }, in_optimal: true }), false);
});

test("expanded markers carry an 'ask the coach' deep-link with a grounded question", () => {
  const markers = loadHealthMarkers();
  const html = markers.hmkRowHtml(markerFixture(), 0);
  assert.match(html, /class="[^"]*\blinkbtn\b[^"]*\bhmk-ask\b[^"]*"/);
  assert.match(html, /data-ask="/);
  // The question names the marker, its value, where it sits, and the target.
  const q = markers.markerAskQuestion(markerFixture());
  assert.match(q, /LDL <bad>/);
  assert.match(q, /110 mg\/dL <unit>/);
  assert.match(q, /above optimal/);
  assert.match(q, /optimal 70–100/);
  assert.match(q, /what should I focus on/i);
  // An in-range marker asks a lighter "keep an eye on it" question.
  const calm = markers.markerAskQuestion({ name: "HDL", unit: "mg/dL", latest: { value: 62 }, optimal: { low: 40, high: 100 }, in_optimal: true });
  assert.match(calm, /keep an eye on/i);
  assert.doesNotMatch(calm, /what's likely driving/i);
});

test("every row states its reference inline — optimal, else lab range, else flag word", () => {
  const markers = loadHealthMarkers();
  // Out of optimal → the optimal band.
  const offRow = markers.hmkRowHtml(markerFixture(), 0);
  assert.match(offRow.slice(0, offRow.indexOf("hmk-panel")), /optimal 70–100 mg\/dL/);

  // In optimal → still shows the band (this is the fix: references are always visible).
  const inRange = markers.hmkRowHtml({
    name: "HDL", unit: "mg/dL",
    latest: { value: 62, date: "2026-06-20", flag: "normal" },
    optimal: { low: 40, high: 100 }, in_optimal: true,
    points: [{ value: 58, date: "2026-05-01" }, { value: 62, date: "2026-06-20" }],
  }, 0);
  assert.match(inRange.slice(0, inRange.indexOf("hmk-panel")), /optimal 40–100 mg\/dL/);

  // No optimal zone but a lab reference range → "range 65–175 mcg/dL".
  const labRange = markers.hmkRowHtml({
    name: "Iron", unit: "mcg/dL",
    latest: { value: 76, date: "2026-06-20", flag: "normal" },
    reference: { low: 65, high: 175 },
    points: [{ value: 76, date: "2026-06-20" }],
  }, 0);
  assert.match(labRange, /range 65–175 mcg\/dL/);

  // No zone, no range, but a flag → the flag in plain words.
  const flagOnly = markers.hmkRowHtml({
    name: "Iron % Saturation", unit: "%",
    latest: { value: 24, date: "2026-06-20", flag: "normal" },
    points: [{ value: 24, date: "2026-06-20" }],
  }, 0);
  assert.match(flagOnly, /in range/);
});

test("reference phrases: optimal beats lab range beats flag; one-sided and unitless handled", () => {
  const markers = loadHealthMarkers();
  assert.equal(markers.referenceRangePhrase({ reference: { low: 65, high: 175 }, unit: "mcg/dL" }), "65–175 mcg/dL");
  assert.equal(markers.referenceRangePhrase({ reference: { low: null, high: 3 }, unit: "mg/L" }), "≤ 3 mg/L");
  assert.equal(markers.referenceRangePhrase({ reference: { low: 40, high: null } }), "≥ 40");
  assert.equal(markers.referenceRangePhrase({ reference: null }), "");
  // optimal zone wins over a lab range when both are present.
  assert.equal(markers.markerReferenceSub({ optimal: { low: 70, high: 100 }, reference: { low: 60, high: 110 } }), "optimal 70–100");
  assert.equal(markers.markerReferenceSub({ reference: { low: 65, high: 175 }, unit: "mcg/dL" }), "range 65–175 mcg/dL");
  assert.equal(markers.markerReferenceSub({ latest: { flag: "high" } }), "above range");
  assert.equal(markers.markerReferenceSub({ latest: { flag: null } }), "");
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
