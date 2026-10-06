// marker-row (marker-row-client.ts, docs/V2-PLAN.md wave 3): the `.hmk` row. The lab's
// own flag and the "outside optimal" phrase are two different facts, so they render as
// two separate elements — never one merged word — and an optimal zone is never read as
// the lab range. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule, renderHtml } from "./_dom.mjs";
import { labRangeFields } from "../dist/repo/lab-range.js";

const MODULES = [
  "date-utils",
  "ui-format",
  "html-utils",
  "ui-components",
  "ui-reads",
  "ui-chart",
  "health-evidence-client",
  "health-marker-order-client",
  "health-client",
  "health-picture-client",
  "health-markers-client",
  "marker-row-client",
];

function load() {
  return loadClientModule(MODULES, {
    globals: {
      stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
      reducedMotion: () => true,
      requestAnimationFrame: () => 1,
    },
  });
}

function row(win, marker) {
  return renderHtml(win.CairnMarkerRow.rowHtml(marker, 0), { document: win.document });
}

// A document reading as GET /api/markers/priority serves it: the server's own lab-range
// read (src/repo/lab-range.ts) rides on the row, so the row never derives it.
function served(marker) {
  const m = { ...marker, latest: marker.latest ? { doc_id: 1, ...marker.latest } : marker.latest };
  return { ...m, ...labRangeFields(m) };
}

const SYNTH = served({
  key: "synth-a",
  name: "Synthetic Marker A",
  unit: "u/L",
  latest: { value: 150, date: "2031-03-02", flag: "high" },
  prev: { value: 120, date: "2030-09-01" },
  optimal: { low: 20, high: 100 },
  in_optimal: false,
  reference: { low: 10, high: 140 },
  points: [
    { value: 120, date: "2030-09-01", flag: "normal" },
    { value: 150, date: "2031-03-02", flag: "high" },
  ],
});

test("the lab flag and the optimal phrase are two separate elements, never one word", () => {
  const win = load();
  const host = row(win, SYNTH);
  const marks = host.querySelector(".hmk-marks");
  assert.ok(marks, "a flagged, off-optimal row carries its marks");
  const flag = marks.querySelector(".hmk-flag");
  const opt = marks.querySelector(".hmk-opt");
  assert.ok(flag && opt, "both marks are present");
  assert.notEqual(flag, opt);
  assert.equal(flag.contains(opt), false, "the optimal phrase is not inside the flag");
  assert.equal(opt.contains(flag), false, "the flag is not inside the optimal phrase");
  assert.equal(flag.dataset.flag, "high");
  assert.equal(flag.textContent.replace(/\s+/g, " ").trim(), "Lab high");
  assert.equal(opt.textContent, "above optimal");
  // Read aloud they stay two facts, never fused into one word.
  assert.doesNotMatch(marks.textContent, /highabove/i);
  assert.match(marks.textContent, /Lab high above optimal/);
});

test("a lab flag alone carries no optimal phrase, and an optimal miss alone no flag", () => {
  const win = load();
  const labOnly = row(win, served({ ...SYNTH, in_optimal: true, optimal: { low: 20, high: 200 } }));
  assert.ok(labOnly.querySelector(".hmk-flag"));
  assert.equal(labOnly.querySelector(".hmk-opt"), null);

  const optOnly = row(
    win,
    served({
      ...SYNTH,
      latest: { value: 120, date: "2031-03-02", flag: "normal" },
      points: [{ value: 120, date: "2031-03-02" }],
    })
  );
  assert.equal(optOnly.querySelector(".hmk-flag"), null, "in the lab range: no lab mark");
  assert.equal(optOnly.querySelector(".hmk-opt").textContent, "above optimal");
});

test("a week-basis wearable marker takes its side from the week, never one night", () => {
  const win = load();
  // The week's mean sits below the band (the status), last night above it.
  const weekly = {
    name: "Synthetic HRV",
    unit: "ms",
    source: "wearable",
    latest: { value: 70, date: "2031-09-21", flag: null },
    optimal: { low: 44, high: 54, dir: "low" },
    in_optimal: false,
    status_basis: "week",
    status_note: "this week's average (6 nights)",
    trend_window: { value: 38, nights: 6 },
    points: [
      { value: 36, date: "2031-09-20" },
      { value: 70, date: "2031-09-21" },
    ],
  };
  const host = row(win, weekly);
  assert.equal(host.querySelector(".hmk-opt").textContent, "below optimal");
  const ask = win.CairnHealthMarkers.markerAskQuestion(weekly);
  assert.match(ask, /38 ms on average this week, below optimal/);
  assert.doesNotMatch(ask, /\b70\b/, "the one night is never quoted as the status");
  // No week mean to judge a side from: the plain phrase, never a guess off the night.
  const noMean = row(win, { ...weekly, trend_window: null });
  assert.equal(noMean.querySelector(".hmk-opt").textContent, "outside optimal");
});

test("a value outside the lab's printed range reads as the lab mark even without a flag", () => {
  const win = load();
  const marker = served({
    name: "Synthetic Marker B",
    unit: "mg/dL",
    latest: { value: 4, date: "2031-03-02", flag: null },
    reference: { low: 5, high: 9 },
    reference_source: "source_lab",
    points: [{ value: 4, date: "2031-03-02" }],
  });
  const host = row(win, marker);
  assert.equal(host.querySelector(".hmk-flag").dataset.flag, "low");
  assert.equal(host.querySelector(".hmk-opt"), null, "no optimal band, no optimal phrase");
  // The rule is the server's: the same row without its read carries no lab mark.
  const { lab_out_of_range: _o, lab_out_of_range_side: _s, lab_range: _r, ...bare } = marker;
  assert.equal(row(win, bare).querySelector(".hmk-flag"), null, "the row never derives the lab's range");
});

test("a value outside a curated (not the lab's) reference range carries no lab mark", () => {
  const win = load();
  const host = row(
    win,
    served({
      name: "Synthetic Marker B2",
      unit: "mg/dL",
      latest: { value: 4, date: "2031-03-02", flag: null },
      reference: { low: 5, high: 9 },
      reference_source: "Synthetic curated source",
      points: [{ value: 4, date: "2031-03-02" }],
    })
  );
  assert.equal(host.querySelector(".hmk-flag"), null);
});

test("a calm reading carries no marks, and the dot's colour is never the only signal", () => {
  const win = load();
  const host = row(win, {
    name: "Synthetic Marker C",
    unit: "ng/mL",
    latest: { value: 50, date: "2031-03-02", flag: "normal" },
    optimal: { low: 40, high: 60 },
    in_optimal: true,
    points: [
      { value: 45, date: "2030-09-02" },
      { value: 50, date: "2031-03-02" },
    ],
  });
  assert.equal(host.querySelector(".hmk-marks"), null);
  assert.equal(host.querySelector(".hdot").getAttribute("aria-hidden"), "true");
  assert.match(host.querySelector(".hmk-when").textContent, /optimal 40–60 ng\/mL/);
});

test("the expandable row is a delegating button, and hostile text comes back as text", () => {
  const win = load();
  const host = row(win, { ...SYNTH, name: "<b>X</b>", unit: "<i>u</i>", active_directive: "<img src=x>" });
  const btn = host.querySelector("button.hmk-row");
  assert.equal(btn.getAttribute("type"), "button");
  assert.ok(btn.hasAttribute("data-hmk-toggle"));
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector("i"), null);
  assert.equal(host.querySelector("img"), null);
  assert.match(host.querySelector(".trend-lead-name").textContent, /<b>X<\/b>/);
});

test("the older entry point prints the same row", () => {
  const win = load();
  assert.equal(win.CairnHealthMarkers.hmkRowHtml(SYNTH, 3), win.CairnMarkerRow.rowHtml(SYNTH, 3));
});
