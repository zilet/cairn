// Wave 2 — the pre-session primer client renderers (src/client/session-primer-client.ts).
// Pure string renderers (cardHtml / freshChipHtml) built on the reading-grammar
// `.read-contrib` grammar. Run the compiled IIFE standalone with escHtml/escAttr
// injected and read the namespace it registers. No DOM, no fetch.
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

function loadPrimer() {
  const escHtml = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escAttr = (v) => escHtml(v).replace(/"/g, "&quot;");
  const context = {
    Object, Array, Number, Math, String, Set, Map, encodeURIComponent,
    escHtml, escAttr, globalThis: null, window: null,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(compileClientSource("src/client/session-primer-client.ts"), context, {
    filename: "session-primer-client.js",
  });
  return context.CairnSessionPrimer;
}

const FULL_PRIMER = {
  why_today: "You're recovered and due — good to go.",
  focus: "Lower body",
  changed: [
    { exercise: "Back Squat", kind: "target", text: "Back Squat — +5 lb" },
    { exercise: "Leg Press", kind: "recovery_cap", text: "Leg Press — easing the load" },
  ],
  watch: [
    { text: "Ease off heavy spinal loading.", soft: false },
    { text: "Left knee was grumbling recently.", soft: true },
  ],
  fresh: [{ exercise: "Bulgarian Split Squat", why: "New this week — log your real working weight." }],
  approach: "You've earned a step up — warm up properly, then chase the target.",
};

test("cardHtml renders the lead sentence, the three sections and the approach", () => {
  const primer = loadPrimer();
  const html = primer.cardHtml(FULL_PRIMER);
  assert.match(html, /recovered and due/, "the why_today lead sentence renders");
  assert.match(html, /What changed/);
  assert.match(html, /Keep an eye on/);
  assert.match(html, /Fresh today/);
  assert.match(html, /Back Squat/);
  assert.match(html, /Bulgarian Split Squat/);
  assert.match(html, /earned a step up/, "the approach line renders");
  assert.match(html, /read-contrib/, "sections use the reading-grammar rows");
  assert.match(html, /aria-expanded="true"/, "expanded by default");
  assert.doesNotMatch(html, /class="[^"]*\bcollapsed\b/, "not collapsed by default");
});

test("cardHtml collapses to a strip when the session already has logged sets", () => {
  const primer = loadPrimer();
  const html = primer.cardHtml(FULL_PRIMER, { collapsed: true });
  assert.match(html, /class="sess-primer reveal collapsed"/, "the collapsed class is applied");
  assert.match(html, /aria-expanded="false"/, "collapsed reads as not expanded");
});

test("cardHtml tones: an earned target is a sage 'ok' pip; a recovery cap and soft watch are 'quiet'; a hard watch is 'watch'", () => {
  const primer = loadPrimer();
  const html = primer.cardHtml(FULL_PRIMER);
  // Earned target → ok pip
  assert.match(html, /read-contrib-pip ok[^]*Back Squat/, "the earned target row carries a sage 'ok' pip");
  // A non-soft directive → watch pip
  assert.match(html, /read-contrib-pip watch[^]*spinal loading/, "the hard directive carries a terracotta 'watch' pip");
});

test("cardHtml escapes every server-supplied string", () => {
  const primer = loadPrimer();
  const xss = '<script>alert("x")</script>';
  const html = primer.cardHtml({
    why_today: xss,
    changed: [{ exercise: xss, kind: "target", text: xss }],
    watch: [{ text: xss }],
    fresh: [{ exercise: xss, why: xss }],
    approach: xss,
  });
  assert.doesNotMatch(html, /<script>/, "no raw script tag survives");
  assert.match(html, /&lt;script&gt;/, "the payload is HTML-escaped");
});

test("cardHtml returns '' for a null or empty primer (silence beats filler)", () => {
  const primer = loadPrimer();
  assert.equal(primer.cardHtml(null), "");
  assert.equal(primer.cardHtml({ why_today: "", changed: [], watch: [], fresh: [], approach: "" }), "");
});

test("freshChipHtml renders an escaped, titled chip carrying its rationale", () => {
  const primer = loadPrimer();
  const chip = primer.freshChipHtml('why "this" <b>');
  assert.match(chip, /sess-fresh-chip/);
  assert.match(chip, /new this week/);
  assert.match(chip, /data-fresh-why="why &quot;this&quot; &lt;b&gt;"/, "the rationale is attribute-escaped");
  assert.match(chip, /title="/, "a native tooltip carries the rationale");
  // No rationale → still a chip, but no title.
  const bare = primer.freshChipHtml("");
  assert.match(bare, /sess-fresh-chip/);
  assert.doesNotMatch(bare, /title="/);
});
