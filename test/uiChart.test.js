// The one chart module (src/client/ui-chart.ts, CairnUiChart): shared scale and
// date label, the sparkline, the dated line chart, the band gauge and the zone
// bar. Colour is a class, never a hex literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClientModule, renderHtml } from "./_dom.mjs";

function load() {
  return loadClientModule(["html-utils", "ui-format", "ui-chart"]);
}

test("the chart module source carries no hex colour", () => {
  const source = readFileSync(new URL("../src/client/ui-chart.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/);
});

test("linear scale, padded domain and date labels are shared", () => {
  const { CairnUiChart: chart } = load();
  const x = chart.linearScale(0, 10, 100, 200);
  assert.equal(x(5), 150);
  assert.equal(chart.linearScale(3, 3, 7, 9)(3), 7, "a zero-width domain maps to the range start");
  assert.deepEqual({ ...chart.domain([10, 20], 0.1) }, { min: 9, max: 21 });
  assert.deepEqual({ ...chart.domain([5, 5], 0) }, { min: 4, max: 6 }, "a flat series opens to ±1");
  assert.deepEqual({ ...chart.domain([10], 0, [0, 20]) }, { min: 0, max: 20 });

  assert.match(chart.dateLabel("2026-06-29"), /Jun 29|29 Jun/);
  assert.doesNotMatch(chart.dateLabel("2026-06-29"), /26\b/);
  assert.match(chart.dateLabel("2026-06-29", { year: true }), /26/);
  assert.equal(chart.dateLabel("not-a-date"), "not-a-date");
  assert.equal(chart.dateLabel(null), "");
  assert.equal(chart.dateLabel(""), "");
});

test("line chart: band, toned dots, escaped endpoint labels and scrub data", () => {
  const win = load();
  const svg = win.CairnUiChart.lineChartSvg({
    band: { low: 70, high: 100 },
    points: [
      { value: 80, label: "Jun 1", tip: "80 <mg> · Jun 1", tone: "ok" },
      { value: 110, label: "Jun <20>", tip: "110 · Jun 20", tone: "watch" },
    ],
  });
  const host = renderHtml(svg, { document: win.document });
  const root = host.querySelector("svg.hchart");
  assert.ok(root.querySelector("rect.hchart-band"));
  assert.ok(root.querySelector("path.hchart-line"));
  assert.equal(root.querySelector("path.hchart-line").getAttribute("stroke"), null, "the line is toned by CSS");
  const dots = [...root.querySelectorAll("circle.hchart-dot")];
  assert.deepEqual(
    dots.map((d) => [
      d.classList.contains("hchart-dot-ok"),
      d.classList.contains("hchart-dot-watch"),
      d.getAttribute("fill"),
    ]),
    [
      [true, false, null],
      [false, true, null],
    ]
  );
  const labels = [...root.querySelectorAll("text.hchart-txt")].map((t) => t.textContent);
  assert.deepEqual(labels, ["Jun 1", "Jun <20>"]);
  const pts = JSON.parse(root.dataset.pts);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].t, "80 <mg> · Jun 1");
  assert.ok(pts[1].y < pts[0].y, "a higher value sits higher");
  assert.ok(
    root.querySelector(".hchart-guide") && root.querySelector(".hchart-cursor") && root.querySelector(".hchart-tip")
  );
  assert.equal(win.CairnUiChart.lineChartSvg({ points: [{ value: 1 }] }), "", "one reading is not a line");
});

test("gauge: the band and a toned dot, only the edge labels given", () => {
  const win = load();
  const host = renderHtml(
    win.CairnUiChart.gaugeSvg({ value: 105, low: 0, high: 80, tone: "watch", lowLabel: "", highLabel: "80" }),
    { document: win.document }
  );
  const root = host.querySelector("svg.hchart.hgauge");
  assert.ok(root.querySelector(".hgauge-track"));
  assert.ok(root.querySelector("rect.hchart-band"));
  assert.ok(root.querySelector("circle.hchart-dot-watch"));
  assert.deepEqual(
    [...root.querySelectorAll("text")].map((t) => t.textContent),
    ["80"]
  );
  assert.equal(win.CairnUiChart.gaugeSvg({ value: Number.NaN, low: 0, high: 1 }), "");
});

test("zone bar: toned bands, the optimal band stronger, now and pace dots, one accessible name", () => {
  const win = load();
  const svg = win.CairnUiChart.zoneBarSvg({
    min: 0,
    max: 40,
    bands: [
      { from: 0, to: 10, tone: "ok" },
      { from: 10, to: 25, tone: "watch" },
      { from: 25, to: 40, tone: "nope" },
    ],
    optimal: { from: 0, to: 10 },
    value: 20,
    projected: 12,
    label: `Waist: 20in <now>`,
  });
  const host = renderHtml(svg, { document: win.document });
  const root = host.querySelector("svg.zonebar");
  assert.equal(root.getAttribute("role"), "img");
  assert.equal(root.getAttribute("aria-label"), "Waist: 20in <now>");
  const segs = [...root.querySelectorAll("rect.zonebar-seg")];
  assert.deepEqual(
    segs.map((s) => [s.getAttribute("class"), s.getAttribute("fill")]),
    [
      ["zonebar-seg zonebar-seg-ok is-optimal", null],
      ["zonebar-seg zonebar-seg-watch", null],
      ["zonebar-seg zonebar-seg-info", null],
    ]
  );
  assert.equal(root.querySelector(".zonebar-optimal").textContent, "optimal");
  assert.ok(root.querySelector("circle.zonebar-now"));
  assert.ok(root.querySelector("line.zonebar-pace") && root.querySelector("circle.zonebar-ahead"));

  const still = win.CairnUiChart.zoneBarSvg({
    min: 0,
    max: 40,
    bands: [],
    optimal: { from: 0, to: 10 },
    value: 20,
    projected: 20,
    label: "x",
  });
  assert.doesNotMatch(still, /zonebar-pace/, "no pace line when the pace lands where you are");
  const unmeasured = win.CairnUiChart.zoneBarSvg({
    min: 0,
    max: 40,
    bands: [],
    optimal: { from: 0, to: 10 },
    value: null,
    projected: null,
    label: "x",
  });
  assert.doesNotMatch(unmeasured, /zonebar-now/);
});

test("every chart class the module emits is styled in styles.css", () => {
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const cls of [
    "hchart-line",
    "hchart-dot-ok",
    "hchart-dot-watch",
    "zonebar-seg-ok",
    "zonebar-seg-watch",
    "zonebar-seg-warn",
    "zonebar-seg-info",
    "zonebar-optimal",
    "zonebar-pace",
    "zonebar-ahead",
    "zonebar-now",
  ]) {
    assert.match(styles, new RegExp(`\\.${cls}\\b[^{]*\\{`), `.${cls} is styled`);
  }
});
