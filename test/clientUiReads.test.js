import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function compileClientSource(file) {
  const source = readFileSync(join(root, file), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
    reportDiagnostics: true,
  }).outputText;
}

// ui-reads.ts is a pure string-renderer module (no app globals beyond the escaping
// helpers), so run the compiled IIFE standalone with escHtml/escAttr injected and
// read the namespace it registers.
function loadUiReads() {
  const escHtml = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escAttr = (v) => escHtml(v).replace(/"/g, "&quot;");
  const context = { Object, Array, Number, Math, String, Set, escHtml, escAttr, globalThis: null, window: null };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(`(() => {\n${compileClientSource("src/client/ui-reads.ts").trimEnd()}\n})();\n`, context);
  return { reads: context.CairnUiReads, context };
}

const XSS = '<script>alert("x")</script>';

test("ui-reads registers the CairnUiReads namespace on globalThis and window", () => {
  const { reads, context } = loadUiReads();
  assert.ok(reads, "CairnUiReads is registered");
  assert.equal(reads, context.window.CairnUiReads, "same object on globalThis and window");
  assert.deepEqual(Object.keys(reads).sort(), [
    "baselineBandHtml",
    "contributorRowsHtml",
    "levelChipHtml",
    "trendLeadHtml",
  ]);
});

test("baselineBandHtml renders the range region, today dot, and phrase; hot retints the dot", () => {
  const { reads } = loadUiReads();
  const html = reads.baselineBandHtml({
    label: "Sleep",
    rangeStart: 0.4,
    rangeEnd: 0.8,
    position: 0.6,
    phrase: "in your range",
    hot: true,
  });
  assert.match(html, /class="read-band hot"/);
  assert.match(html, /class="read-band-track"/);
  assert.match(html, /class="read-band-range" style="left:40\.00%;width:40\.00%"/);
  assert.match(html, /class="read-band-dot" style="left:60\.00%"/);
  assert.match(html, /class="read-band-phrase">in your range</);
  assert.match(html, /class="read-band-label lbl">Sleep</);
});

test("baselineBandHtml clamps positions to [0,1] and normalizes an inverted range", () => {
  const { reads } = loadUiReads();
  const over = reads.baselineBandHtml({ rangeStart: 0.3, rangeEnd: 0.7, position: 2, phrase: "above your range" });
  assert.match(over, /class="read-band-dot" style="left:100\.00%"/);
  const under = reads.baselineBandHtml({ rangeStart: 0.3, rangeEnd: 0.7, position: -5, phrase: "below your range" });
  assert.match(under, /class="read-band-dot" style="left:0\.00%"/);
  // rangeEnd < rangeStart still yields a valid left/width (min..max).
  const inverted = reads.baselineBandHtml({ rangeStart: 0.8, rangeEnd: 0.5, position: 0.6, phrase: "x" });
  assert.match(inverted, /class="read-band-range" style="left:50\.00%;width:30\.00%"/);
});

test("baselineBandHtml degrades to just the phrase when range data is missing (null-safe)", () => {
  const { reads } = loadUiReads();
  const html = reads.baselineBandHtml({ label: "Recovery", phrase: "getting a read on you" });
  assert.doesNotMatch(html, /read-band-track/);
  assert.doesNotMatch(html, /read-band-range/);
  assert.doesNotMatch(html, /read-band-dot/);
  assert.match(html, /class="read-band"/);
  assert.match(html, /getting a read on you/);
  // A range present but no position → region, no dot.
  const noDot = reads.baselineBandHtml({ rangeStart: 0.2, rangeEnd: 0.6, phrase: "x" });
  assert.match(noDot, /read-band-range/);
  assert.doesNotMatch(noDot, /read-band-dot/);
  // Nothing at all → empty string.
  assert.equal(reads.baselineBandHtml({}), "");
  assert.equal(reads.baselineBandHtml(), "");
});

test("baselineBandHtml escapes caller strings", () => {
  const { reads } = loadUiReads();
  const html = reads.baselineBandHtml({ label: XSS, phrase: XSS, rangeStart: 0, rangeEnd: 1, position: 0.5 });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("contributorRowsHtml clamps tone to the allowlist and drops empty rows", () => {
  const { reads } = loadUiReads();
  const html = reads.contributorRowsHtml([
    { label: "Sleep", state: "above your range", tone: "ok" },
    { label: "HRV", state: "below your range", tone: "watch" },
    { label: "RHR", state: "thin data", tone: "bogus" }, // → quiet
    { label: "", state: "" }, // dropped
  ]);
  assert.match(html, /class="read-contribs"/);
  assert.match(html, /class="read-contrib-pip ok"/);
  assert.match(html, /class="read-contrib-pip watch"/);
  assert.match(html, /class="read-contrib-pip quiet"/);
  assert.doesNotMatch(html, /read-contrib-pip bogus/);
  // three rendered rows (the empty one is dropped)
  assert.equal((html.match(/class="read-contrib"/g) || []).length, 3);
  // missing tone also defaults to quiet
  assert.match(reads.contributorRowsHtml([{ label: "x", state: "y" }]), /read-contrib-pip quiet/);
  // empty / non-array → ""
  assert.equal(reads.contributorRowsHtml([]), "");
  assert.equal(reads.contributorRowsHtml(null), "");
});

test("contributorRowsHtml escapes caller strings", () => {
  const { reads } = loadUiReads();
  const html = reads.contributorRowsHtml([{ label: XSS, state: XSS, tone: "ok" }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("levelChipHtml renders label + optional detail, escapes, and blanks with no label", () => {
  const { reads } = loadUiReads();
  assert.match(
    reads.levelChipHtml({ label: "Intermediate", detail: "for your 40s" }),
    /class="level-chip">Intermediate<span class="level-chip-detail">for your 40s<\/span>/
  );
  const bare = reads.levelChipHtml({ label: "In your range" });
  assert.match(bare, /class="level-chip">In your range</);
  assert.doesNotMatch(bare, /level-chip-detail/);
  assert.equal(reads.levelChipHtml({}), "");
  assert.equal(reads.levelChipHtml(), "");
  const xss = reads.levelChipHtml({ label: XSS });
  assert.doesNotMatch(xss, /<script>/);
  assert.match(xss, /&lt;script&gt;/);
});

test("trendLeadHtml clamps tone, escapes, and blanks with no name", () => {
  const { reads } = loadUiReads();
  assert.match(
    reads.trendLeadHtml({ name: "ApoB", phrase: "falling toward your range", tone: "toward" }),
    /class="trend-lead-phrase toward">falling toward your range</
  );
  assert.match(reads.trendLeadHtml({ name: "LDL", phrase: "climbing", tone: "away" }), /trend-lead-phrase away/);
  // unknown tone → stable
  assert.match(
    reads.trendLeadHtml({ name: "Ferritin", phrase: "holding", tone: "sideways" }),
    /trend-lead-phrase stable/
  );
  assert.match(reads.trendLeadHtml({ name: "ApoB" }), /class="trend-lead-name">ApoB<\/span><\/div>/);
  assert.equal(reads.trendLeadHtml({}), "");
  assert.equal(reads.trendLeadHtml(), "");
  const xss = reads.trendLeadHtml({ name: XSS, phrase: XSS });
  assert.doesNotMatch(xss, /<script>/);
  assert.match(xss, /&lt;script&gt;/);
});
