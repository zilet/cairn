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

function loadCapture() {
  const context = {
    Date,
    Number,
    String,
    Array,
    Math,
    isNaN,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-provenance-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/04-capture.js"), "utf8"), context);
  return context;
}

test("capture weekly range keeps the same Monday-Sunday framing", () => {
  const capture = loadCapture();

  assert.equal(capture.weekRangeLabel("2026-06-14T12:00:00Z"), "Jun 8–14");
  assert.equal(capture.weekRangeLabel("2026-07-01"), "Jun 29 – Jul 5");
  assert.equal(capture.weekRangeLabel("not-a-date"), "");
});

test("capture provenance line escapes directive and marker text", () => {
  const capture = loadCapture();
  const html = capture.provenanceLineHtml(
    {
      directive: `Tilt <easy> "today"`,
      marker: "ApoB <high>",
      uncertain: true,
    },
    `Training "why"`,
  );

  assert.match(html, /aria-label="Training &quot;why&quot;: Tilt &lt;easy&gt; &quot;today&quot;"/);
  assert.match(html, /Worth looking into/);
  assert.match(html, /Tilt &lt;easy&gt; "today"/);
  assert.match(html, /ApoB &lt;high&gt;/);
  assert.doesNotMatch(html, /Tilt <easy>/);
});
