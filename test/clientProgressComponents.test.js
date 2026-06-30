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
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
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
    ["volume", 1200, { k: true }],
    null,
  ]);

  assert.match(html, /&lt;Progress&gt;/);
  assert.match(html, /tracked &lt;label&gt;/);
  assert.match(html, /data-cu="7"/);
  assert.match(html, /phero-n-sm/);
  assert.match(html, /data-cufmt="k"/);
  assert.doesNotMatch(html, /<Progress>|<label>/);
});

test("progress empty state keeps trusted art raw and escapes copy", () => {
  const components = loadProgressComponents();
  const html = components.emptyStateHtml("<svg data-kind=\"exercise\"></svg>", "No <sets> yet");

  assert.match(html, /<svg data-kind="exercise"><\/svg>/);
  assert.match(html, /No &lt;sets&gt; yet/);
  assert.doesNotMatch(html, /No <sets> yet/);
});
