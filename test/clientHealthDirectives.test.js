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

function loadHealthDirectives() {
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
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  for (const file of [
    "public/js/html-utils.js",
    "public/js/ui-components.js",
    "public/js/health-evidence-client.js",
    "public/js/health-client.js",
    "public/js/health-directives-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthDirectives;
}

test("health directives filters active rows and normalizes evidence counts", () => {
  const directives = loadHealthDirectives();
  const active = directives.activeDirectives([
    { id: 1, status: "active" },
    { id: 2 },
    { id: 3, status: "resolved" },
    null,
  ]);
  const evMap = directives.evidenceCountMap({
    by_marker: [
      { marker: "ApoB", count: 2 },
      { marker: "Vitamin D", count: "3" },
    ],
  });

  assert.deepEqual(active.map((row) => row.id), [1, 2]);
  assert.equal(evMap.get("apob"), 2);
  assert.equal(evMap.get("vitamin d"), 3);
});

test("health directives empty state preserves refresh affordance", () => {
  const directives = loadHealthDirectives();
  const html = directives.directivesSectionHtml([], { research_enabled: false });

  assert.match(html, /Across your life/);
  assert.match(html, /id="hbDerive"/);
  assert.match(html, /Nothing to carry across domains right now/);
  assert.doesNotMatch(html, /hbResearchNudge/);
});

test("health directives groups rows and exposes evidence affordances", () => {
  const directives = loadHealthDirectives();
  const html = directives.directivesSectionHtml(
    [
      {
        id: 'nut"1',
        domain: "nutrition",
        marker: "ApoB <risk>",
        directive: "Lower saturated fat <now>",
        rationale: "Particle burden <watch>",
      },
      {
        id: "train1",
        domain: "training",
        marker: "Vitamin D",
        citation: "Endocrine Society",
        directive: "Keep strength training steady",
      },
      {
        id: "old",
        domain: "watch",
        status: "dismissed",
        directive: "Do not render",
      },
    ],
    {
      research_enabled: false,
      by_marker: [{ marker: "Vitamin D", count: 1 }],
    },
  );

  assert.match(html, /hb-dgname">Nutrition/);
  assert.match(html, /hb-dgname">Training/);
  assert.doesNotMatch(html, /Do not render/);
  assert.match(html, /data-dir="nut&quot;1"/);
  assert.match(html, /ApoB &lt;risk&gt;/);
  assert.match(html, /Lower saturated fat &lt;now&gt;/);
  assert.match(html, /Particle burden &lt;watch&gt;/);
  assert.match(html, /see the evidence/);
  assert.match(html, /turn on research in Settings/);
  assert.doesNotMatch(html, /<risk>|<now>|<watch>/);
});

test("health directives suppresses research nudge when sourced or research enabled", () => {
  const directives = loadHealthDirectives();
  const active = [{ marker: "ApoB", directive: "Keep fiber up" }];
  const evMap = new Map([["apob", 1]]);

  assert.equal(directives.directiveResearchNudgeHtml(active, evMap, { research_enabled: false }), "");
  assert.equal(directives.directiveResearchNudgeHtml(active, new Map(), { research_enabled: true }), "");
});
