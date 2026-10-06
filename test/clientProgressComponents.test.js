import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressComponents() {
  const context = {
    Date,
    Number,
    Object,
    String,
    art: () => "<svg></svg>",
    stagger: (idx) => `--i:${idx}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-chart.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-components-client.js"), "utf8"), context);
  return context.CairnProgressComponents;
}

test("progress components format dates and hero stats safely", () => {
  const components = loadProgressComponents();

  assert.match(components.fmtShortDate("2026-06-30"), /Jun|30/);
  assert.equal(components.fmtShortDate("bad-date"), "bad-date");

  const html = components.progressHero("<Progress>", [
    ["tracked <label>", 7],
    ["long text", "1234567", { text: true }],
    null,
  ]);

  assert.match(html, /&lt;Progress&gt;/);
  assert.match(html, /tracked &lt;label&gt;/);
  assert.match(html, /data-cu="7"/);
  assert.match(html, /phero-n-sm/);
  assert.doesNotMatch(html, /data-cufmt/);
  assert.doesNotMatch(html, /<Progress>|<label>/);
});

test("progress empty state keeps trusted art raw and escapes copy", () => {
  const components = loadProgressComponents();
  const html = components.emptyStateHtml("<svg data-kind=\"exercise\"></svg>", "No <sets> yet");

  assert.match(html, /<svg data-kind="exercise"><\/svg>/);
  assert.match(html, /No &lt;sets&gt; yet/);
  assert.doesNotMatch(html, /No <sets> yet/);
});

test("a voice header is one serif line and at most one mono fact, escaped; units ride inside a value", () => {
  const components = loadProgressComponents();
  const voice = components.progressHero("History", [["sets", 9]], { line: "Fifteen <sessions>.", fact: "222 sets · 30 <days>" });
  assert.match(voice, /class="phero-line">Fifteen &lt;sessions&gt;\.</);
  assert.match(voice, /class="phero-fact lbl">222 sets · 30 &lt;days&gt;</);
  assert.doesNotMatch(voice, /phero-stats|phero-title|data-cu/, "a voice header never paints a stat row");
  assert.doesNotMatch(components.progressHero("History", [], { line: "One line." }), /phero-fact/);

  const energy = components.progressHero("Energy Balance", [["est. burn", 2417, { unit: "kcal" }], ["trend", "−1", { text: true, unit: "lb/wk" }]]);
  assert.match(energy, /<span class="phero-n numeral"><span data-cu="2417">0<\/span><span class="phero-u">kcal<\/span><\/span>/);
  assert.match(energy, />−1<span class="phero-u">lb\/wk<\/span>/);

  assert.equal(components.countWord(15, true), "Fifteen");
  assert.equal(components.countWord(0), "no");
  assert.equal(components.countWord(42), "42");
});
