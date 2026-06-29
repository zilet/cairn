import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function loadHealthClient() {
  const context = {
    Math,
    Number,
    String,
    Map,
    RegExp,
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-client.js"), "utf8"), context);
  return context.CairnHealthClient;
}

test("health evidence URLs are http-only and quote-safe", () => {
  const health = loadHealthClient();
  assert.equal(health.evidenceSafeUrl("https://example.com/a?x=1"), "https://example.com/a?x=1");
  assert.equal(health.evidenceSafeUrl(`http://example.com/"quote"`), "http://example.com/&quot;quote&quot;");
  assert.equal(health.evidenceSafeUrl("javascript:alert(1)"), null);
  assert.equal(health.evidenceSafeUrl("mailto:doctor@example.com"), null);
});

test("health evidence list escapes text, truncates body, and limits rows", () => {
  const health = loadHealthClient();
  const longBody = `${"x".repeat(260)}<script>`;
  const rows = Array.from({ length: 8 }, (_, i) => ({
    source_title: i === 0 ? "<AHA>" : `Source ${i}`,
    source_url: i === 0 ? "javascript:bad()" : `https://example.com/${i}`,
    claim: i === 0 ? "Guideline <claim>" : "",
    body: i === 0 ? longBody : `Body ${i}`,
    confidence: i === 0 ? "high" : "",
  }));

  const html = health.evidenceListHtml(rows);
  assert.match(html, /&lt;AHA&gt;/);
  assert.match(html, /Guideline &lt;claim&gt;/);
  assert.match(html, /high confidence/);
  assert.match(html, /xxx…/);
  assert.doesNotMatch(html, /javascript:bad/);
  assert.equal((html.match(/class="hb-ev-row"/g) || []).length, 6);
});

test("health evidence count map normalizes marker keys", () => {
  const health = loadHealthClient();
  const map = health.evidenceCountMap({
    by_marker: [
      { marker: "ApoB", count: 3 },
      { marker: "Vitamin D", count: "2" },
      { marker: "", count: 9 },
      { count: 7 },
    ],
  });

  assert.equal(map.get("apob"), 3);
  assert.equal(map.get("vitamin d"), 2);
  assert.equal(map.has(""), false);
});

test("health markers empty state preserves add-document affordance", () => {
  const health = loadHealthClient();
  const html = health.markersEmptyHtml("<svg></svg>");
  assert.match(html, /<svg><\/svg>/);
  assert.match(html, /No markers yet/);
  assert.match(html, /id="hMkToRecords"/);
  assert.match(html, /type="button"/);
  assert.match(html, /ADD A DOCUMENT/);
});

test("health marker display helpers keep number, date, span, and trend words stable", () => {
  const health = loadHealthClient();

  assert.equal(health.formatMarkerNumber(123.6), "124");
  assert.equal(health.formatMarkerNumber(12.34), "12.3");
  assert.equal(health.formatMarkerNumber(1.236), "1.24");
  assert.equal(health.formatMarkerNumber("not numeric"), "not numeric");

  assert.match(health.sparkDateLabel("2026-06-29"), /Jun 29, 26|Jun 29, 2026/);
  assert.equal(health.sparkDateLabel("not-a-date"), "not-a-date");
  assert.equal(health.sparkDateLabel(null), "");

  assert.equal(health.markerSpanWord(9), "~9 days");
  assert.equal(health.markerSpanWord(28), "~4 wk");
  assert.equal(health.markerSpanWord(420), "~14 mo");
  assert.equal(health.markerSpanWord(0), "");

  assert.equal(health.markerTrendWord({ trend: { dir: "rising", span_days: 28 } }), "rising over ~4 wk");
  assert.equal(health.markerTrendWord({ trend: { dir: "stable" } }), "holding steady");
  assert.equal(health.markerTrendWord({ points: [{ value: 1 }, { value: "2" }] }), "holding steady");
  assert.equal(health.markerTrendWord({ points: [{ value: "x" }] }), "");
});

test("health marker ordering keeps clinical scan order before server order", () => {
  const health = loadHealthClient();
  const rows = [
    { name: "LDL Particle Number" },
    { name: "Triglycerides" },
    { name: "LDL Cholesterol" },
    { name: "Apolipoprotein B" },
    { name: "Direct LDL-C" },
    { name: "HDL Cholesterol" },
  ];

  assert.deepEqual(
    health.orderMarkersForDisplay("lipids", rows).map((m) => m.name),
    ["LDL Cholesterol", "Direct LDL-C", "HDL Cholesterol", "Triglycerides", "Apolipoprotein B", "LDL Particle Number"],
  );

  assert.deepEqual(
    health.orderMarkersForDisplay("unknown", rows).map((m) => m.name),
    rows.map((m) => m.name),
  );
});

test("health lipid subgroup labels and assay note are bounded and escaped", () => {
  const health = loadHealthClient();
  assert.equal(health.markerSubgroup("lipids", "LDL Cholesterol"), "Standard lipid panel");
  assert.equal(health.markerSubgroup("lipids", "ApoB"), "Atherogenic particle risk");
  assert.equal(health.markerSubgroup("lipids", "LDL Particle Number"), "Advanced lipoprotein detail");
  assert.equal(health.markerSubgroup("kidney", "Creatinine"), "");

  const note = health.lipidGroupNoteHtml([
    { name: "LDL Cholesterol <std>", latest: { date: "2026-06-01" } },
    { name: "Direct LDL-C <direct>", latest: { date: "2026-06-15" } },
  ], { relAge: (date) => `age<${date}>` });

  assert.match(note, /LDL-C is separated by assay/);
  assert.match(note, /LDL Cholesterol &lt;std&gt;/);
  assert.match(note, /Direct LDL-C &lt;direct&gt;/);
  assert.match(note, /age&lt;2026-06-01&gt;/);
});
