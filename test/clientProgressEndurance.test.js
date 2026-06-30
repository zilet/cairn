import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProgressEndurance() {
  const context = {
    Math,
    Number,
    Object,
    String,
    fmtKm: (km) => Number(km).toFixed(1),
    fmtPaceKm: (pace) => `${Number(pace).toFixed(2)}`,
    fmtSpeedKmh: (speed) => Number(speed).toFixed(1),
    prDistLabel: (km) => `${Number(km).toFixed(1)} km`,
    absDate: (date) => `abs ${date}`,
    relAge: (date) => `age ${date}`,
    stagger: (idx) => `--i:${idx}`,
  };
  context.HR_ZONE_COLORS = ["#111", "#222", "#333", "#444", "#555"];
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

test("progress endurance trend and zone helpers stay calm", () => {
  const endurance = loadProgressEndurance();

  assert.equal(
    endurance.paceTrendWord({ dir: "steady", this_min_per_km: 5.25 }),
    "holding about the same pace as last week",
  );
  assert.equal(
    endurance.paceTrendWord({ dir: "faster", this_min_per_km: 5.0, prev_min_per_km: 5.4 }),
    "a little faster than last week",
  );
  assert.equal(
    endurance.paceTrendWord({ dir: "slower", this_min_per_km: 6.1, prev_min_per_km: 5.3 }),
    "noticeably easier than last week",
  );
  assert.equal(endurance.paceTrendWord({ dir: "faster", this_min_per_km: 5.5 }), "averaging 5.50/km");
  assert.equal(endurance.paceTrendWord(null), "");

  const html = endurance.zoneBarHtml({ Z3: 1800, Z1: 600, Z9: 0 });
  assert.match(html, /Time in heart-rate zones/);
  assert.match(html, /width:25\.0%;background:#111/);
  assert.match(html, /width:75\.0%;background:#333/);
  assert.match(html, /Z1 10m · Z3 30m/);
  assert.equal(endurance.zoneBarHtml({}), "");
});

test("progress endurance best rows and sport card render safely", () => {
  const endurance = loadProgressEndurance();
  const pacedRows = endurance.enduranceBestRows({
    paced: true,
    longest_km: { value: 12.3, date: "2026-06-01", type: "trail <run>" },
    best_pace: [{ distance_km: 10, min_per_km: 4.8, date: "2026-06-02", type: "race <official>" }],
  });
  const speedRows = endurance.enduranceBestRows({
    paced: false,
    longest_min: { value: 92.4, date: "2026-05-30", type: "ride <long>" },
    best_speed_kmh: { value: 31.27, date: "2026-06-03", type: "ride <fast>" },
  });

  assert.deepEqual(Array.from(pacedRows, (row) => row.label), ["Longest distance", "Best 10.0 km pace"]);
  assert.deepEqual(Array.from(speedRows, (row) => row.val), ["92 min", "31.3 km/h"]);

  const html = endurance.enduranceSportCardHtml(
    {
      label: "Run <road>",
      paced: true,
      longest_km: { value: 12.3, date: "2026-06-01", type: "trail <run>" },
      best_pace: [{ distance_km: 10, min_per_km: 4.8, date: "2026-06-02", type: "race <official>" }],
    },
    4,
  );

  assert.match(html, /Run &lt;road&gt;/);
  assert.match(html, /Longest distance/);
  assert.match(html, /12\.3 km/);
  assert.match(html, /title="abs 2026-06-01"/);
  assert.match(html, /age 2026-06-02 · race &lt;official&gt;/);
  assert.match(html, /--i:4/);
  assert.doesNotMatch(html, /<road>|<run>|<official>/);
  assert.equal(endurance.enduranceSportCardHtml({ label: "Empty" }, 1), "");
});
