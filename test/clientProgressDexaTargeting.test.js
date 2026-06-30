import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDexaTargeting() {
  const context = { Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-dexa-targeting-client.js"), "utf8"), context);
  return context;
}

test("progress DEXA targeting renders typed targets safely", () => {
  const context = loadDexaTargeting();
  const dexa = context.CairnProgressDexaTargeting;
  const html = dexa.dexaTargetingHtml({
    available: true,
    lead: { next_dexa_focus: "Scan focus <next>" },
    targets: [
      {
        informational: true,
        area: "BMD <hip>",
        signal: "Low trend <watch>",
        bias: "Clinician discussion <soon>",
        path: "Bring report <pdf>",
      },
      {
        domain: "nutrition",
        area: "Visceral fat <waist>",
        moves: ["Protein <target>", "Fiber > ultra processed"],
      },
      {
        domain: "training",
        area: "Left leg lean mass",
        moves: ["Split squat <left>", "Step-up"],
      },
    ],
  });

  assert.match(html, /Scan focus &lt;next&gt;/);
  assert.match(html, /pdexa-info/);
  assert.match(html, /worth discussing with your clinician/);
  assert.match(html, /pdexa-nut/);
  assert.match(html, /pdexa-train/);
  assert.match(html, /BMD &lt;hip&gt;/);
  assert.match(html, /Low trend &lt;watch&gt;/);
  assert.match(html, /Bring report &lt;pdf&gt;/);
  assert.match(html, /Protein &lt;target&gt;/);
  assert.match(html, /Fiber &gt; ultra processed/);
  assert.doesNotMatch(html, /<next>|<hip>|<watch>|<soon>|<pdf>|<target>/);
});

test("progress DEXA targeting exposes tone mappings and empty state", () => {
  const context = loadDexaTargeting();
  const dexa = context.CairnProgressDexaTargeting;

  assert.equal(dexa.dexaTargetToneCls({ informational: true }), "pdexa-info");
  assert.equal(dexa.dexaTargetToneCls({ domain: "nutrition" }), "pdexa-nut");
  assert.equal(dexa.dexaTargetToneCls({ domain: "training" }), "pdexa-train");
  assert.equal(dexa.dexaTargetingHtml({ available: false, targets: [] }), "");
  assert.equal(dexa.dexaTargetingHtml({ available: true, targets: [] }), "");
});

test("progress DEXA targeting loader hydrates a connected slot", async () => {
  const context = loadDexaTargeting();
  const slot = { isConnected: true, innerHTML: "" };
  context.document = {
    getElementById(id) {
      return id === "slot" ? slot : null;
    },
  };
  context.api = async () => ({
    available: true,
    next_dexa_focus: "Next scan <focus>",
    targets: [{ domain: "training", area: "Arms", moves: ["Carry <load>"] }],
  });

  await context.CairnProgressDexaTargeting.loadDexaTargeting("slot");

  assert.match(slot.innerHTML, /Next scan &lt;focus&gt;/);
  assert.match(slot.innerHTML, /Carry &lt;load&gt;/);
  assert.doesNotMatch(slot.innerHTML, /<focus>|<load>/);
});
