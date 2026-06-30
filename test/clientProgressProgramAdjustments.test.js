import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgramAdjustmentsClient() {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-adjustments-client.js"), "utf8"), context);
  return context;
}

test("progress program adjustments render digest safely", () => {
  const context = loadProgramAdjustmentsClient();
  const adjustments = context.CairnProgressProgramAdjustments;
  const html = adjustments.programAdjustmentsHtml([
    { kind: "progression", title: "Bench +5 <lb>", why: "Top set moved <cleanly>" },
    { kind: "dexa", title: "Left leg bias <scan>", why: "Regional lean mass <gap>" },
    { kind: "unknown", title: "Quiet gap <note>", why: "Fill it gently <soon>" },
    { kind: "test", title: "Retest deadlift <heavy>", why: "Last heavy set is stale <old>" },
    { kind: "cardio", title: "Run mix <week>", why: "Long run due <base>" },
    { kind: "balance", title: "Pulling work <back>", why: "Press leads pull <gap>" },
    { kind: "deload", title: "Hidden seventh", why: "Should not render" },
  ]);

  assert.match(html, /What changed &amp; why/);
  assert.match(html, /padj-prog/);
  assert.match(html, /padj-dexa/);
  assert.match(html, /padj-gap/);
  assert.match(html, /padj-test/);
  assert.match(html, /padj-cardio/);
  assert.match(html, /padj-bal/);
  assert.match(html, /Bench \+5 &lt;lb&gt;/);
  assert.match(html, /Top set moved &lt;cleanly&gt;/);
  assert.match(html, /Regional lean mass &lt;gap&gt;/);
  assert.doesNotMatch(html, /Hidden seventh/);
  assert.doesNotMatch(html, /<lb>|<cleanly>|<scan>|<gap>|<note>|<soon>|<heavy>|<old>|<week>|<base>|<back>/);
});

test("progress program adjustments expose mappings and empty state", () => {
  const context = loadProgramAdjustmentsClient();
  const adjustments = context.CairnProgressProgramAdjustments;

  assert.equal(adjustments.PADJ_KIND.progression.cls, "padj-prog");
  assert.equal(adjustments.PADJ_KIND.test.glyph, "✦");
  assert.equal(adjustments.programAdjustmentsHtml([]), "");
  assert.equal(adjustments.programAdjustmentsHtml(null), "");
});

test("progress program adjustments loader hydrates only the active Program view", async () => {
  const context = loadProgramAdjustmentsClient();
  const slot = { isConnected: true, innerHTML: "" };
  context.state = { tab: "progress", progressSeg: "program" };
  context.view = {
    querySelector(selector) {
      return selector === "#progAdjustSlot" ? slot : null;
    },
  };
  context.api = async () => [{ kind: "progression", title: "Load moved <up>", why: "RIR held <steady>" }];

  await context.CairnProgressProgramAdjustments.loadProgramAdjustments();

  assert.match(slot.innerHTML, /Load moved &lt;up&gt;/);
  assert.match(slot.innerHTML, /RIR held &lt;steady&gt;/);
  assert.doesNotMatch(slot.innerHTML, /<up>|<steady>/);
});
