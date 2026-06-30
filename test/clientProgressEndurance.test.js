import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressEndurance() {
  const context = {
    Object,
    String,
    fmtKm: (km) => Number(km).toFixed(1),
    stagger: (idx) => `--i:${idx}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-endurance-client.js"), "utf8"), context);
  return context.CairnProgressEndurance;
}

test("program endurance block uses calm status words", () => {
  const endurance = loadProgressEndurance();

  assert.equal(endurance.enduranceStatusWord("building"), "Building");
  assert.equal(endurance.enduranceStatusWord("maintaining"), "Ticking over");
  assert.equal(endurance.enduranceStatusWord("detraining"), "Fading");
  assert.equal(endurance.enduranceStatusWord("spiking"), "Load spiked");
  assert.equal(endurance.enduranceStatusWord("unknown"), "");
});

test("program endurance block renders figures safely", () => {
  const endurance = loadProgressEndurance();
  const html = endurance.enduranceBlockHtml(
    {
      status: "spiking",
      last_week_km: 32.42,
      longest_km_4wk: 14,
      why: "Long run rose <fast>",
    },
    5,
  );

  assert.match(html, /class="pend reveal"/);
  assert.match(html, /style="--i:5"/);
  assert.match(html, /Load spiked/);
  assert.match(html, /32\.4 km last week · 14\.0 km longest · 4wk/);
  assert.match(html, /Long run rose &lt;fast&gt;/);
  assert.doesNotMatch(html, /<fast>/);
  assert.equal(endurance.enduranceBlockHtml(null, 1), "");
});
