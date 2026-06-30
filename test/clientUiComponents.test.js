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

function loadUiComponents() {
  const context = {
    Object,
    String,
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  return context.CairnUi;
}

test("empty state component escapes text and preserves explicit art HTML", () => {
  const ui = loadUiComponents();
  const html = ui.emptyStateHtml({
    artHtml: "<svg><circle /></svg>",
    title: "<No data>",
    body: "Use <docs> & records",
    action: {
      id: `go"now`,
      className: `logbtn "wide"`,
      label: "Add <record>",
      attrs: { "data-next": `a"b`, disabled: false, hidden: null },
    },
    style: `--i:0;"`,
  });

  assert.match(html, /<svg><circle \/><\/svg>/);
  assert.match(html, /&lt;No data&gt;/);
  assert.match(html, /Use &lt;docs&gt; &amp; records/);
  assert.match(html, /id="go&quot;now"/);
  assert.match(html, /class="logbtn &quot;wide&quot;"/);
  assert.match(html, /data-next="a&quot;b"/);
  assert.match(html, /Add &lt;record&gt;/);
  assert.doesNotMatch(html, /\sdisabled\b/);
  assert.doesNotMatch(html, /\shidden\b/);
});

test("action button component omits blank actions and supports boolean attributes", () => {
  const ui = loadUiComponents();
  assert.equal(ui.actionButtonHtml(null), "");
  assert.equal(ui.actionButtonHtml({ label: "" }), "");

  const html = ui.actionButtonHtml({
    label: "Save",
    attrs: { "aria-pressed": true, "bad attr": "dropped" },
  });

  assert.match(html, /class="logbtn"/);
  assert.match(html, /type="button"/);
  assert.match(html, /\saria-pressed\b/);
  assert.doesNotMatch(html, /bad attr/);
  assert.doesNotMatch(html, /badattr/);
});

test("text chip component escapes label, title, and attributes", () => {
  const ui = loadUiComponents();
  assert.equal(ui.textChipHtml({ label: "" }), "");

  const html = ui.textChipHtml({
    className: `chip "quiet"`,
    label: "Incline <press>",
    title: `same "pattern"`,
    attrs: { "data-kind": "vary", selected: true, "bad attr": "dropped" },
  });

  assert.match(html, /^<span /);
  assert.match(html, /class="chip &quot;quiet&quot;"/);
  assert.match(html, /title="same &quot;pattern&quot;"/);
  assert.match(html, /data-kind="vary"/);
  assert.match(html, /\sselected\b/);
  assert.match(html, />Incline &lt;press&gt;<\/span>/);
  assert.doesNotMatch(html, /bad attr/);
});

test("loading state component escapes labels and preserves status semantics", () => {
  const ui = loadUiComponents();
  const html = ui.loadingStateHtml({ label: "Reading <labs>", className: `load "wide"` });

  assert.match(html, /class="load &quot;wide&quot;"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Reading &lt;labs&gt;/);
  assert.doesNotMatch(html, /Reading <labs>/);

  const staticHtml = ui.loadingStateHtml({ label: "Syncing", live: false });
  assert.match(staticHtml, /role="status"/);
  assert.doesNotMatch(staticHtml, /aria-live=/);
});

test("segmented nav component escapes items and preserves active slider contract", () => {
  const ui = loadUiComponents();
  const html = ui.segmentedNavHtml({
    active: `food"`,
    items: [
      ["training", "Training"],
      [`food"`, "Food <today>"],
      ["coach", "Coach"],
    ],
  });

  assert.match(html, /^<div class="segwrap">/);
  assert.match(html, /class="seg seg-sliding"/);
  assert.match(html, /style="--segn:3;--segi:1"/);
  assert.match(html, /<span class="seg-thumb"><\/span>/);
  assert.match(html, /class="segbtn active" type="button" data-seg="food&quot;"/);
  assert.match(html, />Food &lt;today&gt;<\/button>/);
  assert.doesNotMatch(html, /Food <today>/);
  assert.equal((html.match(/type="button"/g) || []).length, 3);
});

test("job caption component preserves the reconnect selector and escapes text", () => {
  const ui = loadUiComponents();
  assert.equal(ui.jobCaptionHtml(), `<span class="job-cap"></span>`);

  const span = ui.jobCaptionHtml({
    text: "Reading <trend>",
    className: `meal-cap job-cap "wide"`,
    attrs: { "data-job": `abc"123`, "bad attr": "dropped" },
  });

  assert.match(span, /^<span /);
  assert.match(span, /class="meal-cap job-cap &quot;wide&quot;"/);
  assert.match(span, /data-job="abc&quot;123"/);
  assert.match(span, />Reading &lt;trend&gt;<\/span>/);
  assert.doesNotMatch(span, /bad attr/);
  assert.doesNotMatch(span, /Reading <trend>/);

  const div = ui.jobCaptionHtml({ tag: "div", className: "sug-loading-line job-cap" });
  assert.equal(div, `<div class="sug-loading-line job-cap"></div>`);
});

test("sheet chip component escapes value, label, classes, and attributes", () => {
  const ui = loadUiComponents();
  assert.equal(ui.sheetChipHtml({}), "");
  assert.equal(
    ui.sheetChipHtml({ label: "serves 2" }),
    `<span class="sheet-chip"><span class="lbl">serves 2</span></span>`
  );

  const html = ui.sheetChipHtml({
    className: `sheet-chip "wide"`,
    value: "12<3",
    label: `g protein "now"`,
    attrs: { "data-chip": `macro"p`, selected: true, "bad attr": "dropped" },
  });

  assert.match(html, /^<span /);
  assert.match(html, /class="sheet-chip &quot;wide&quot;"/);
  assert.match(html, /data-chip="macro&quot;p"/);
  assert.match(html, /\sselected\b/);
  assert.match(html, /<span class="numeral">12&lt;3<\/span>/);
  assert.match(html, /<span class="lbl">g protein "now"<\/span>/);
  assert.doesNotMatch(html, /bad attr/);
});
