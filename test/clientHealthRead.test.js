import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthRead() {
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
    fmtK: (value) => `${Math.round(Number(value) / 1000)}k`,
    sparklineSvg: (values) => `<svg class="spark">${values.join(",")}</svg>`,
    stagger: (i) => `--i:${Math.min(i ?? 0, 12)}`,
  };
  context.window = context;
  for (const file of [
    "public/js/date-utils.js",
    "public/js/html-utils.js",
    "public/js/health-evidence-client.js",
    "public/js/health-marker-order-client.js",
    "public/js/health-client.js",
    "public/js/health-read-client.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return context.CairnHealthRead;
}

function localISODaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("health read recovery renderer speaks in plain phrases and escapes sources", () => {
  const read = loadHealthRead();
  const html = read.recoveryHtml({
    sources: ["garmin", "apple", "watch <raw>"],
    delta: { sleep: -32.5, hrv: 4.2, rhr: 2.4 },
    recovery: {
      last_date: localISODaysAgo(0),
      avg_sleep_min: 452,
      avg_deep_sleep_min: 72,
      avg_rem_sleep_min: 88,
      avg_resting_hr: 52,
      avg_hrv_ms: 61,
      hrv_status: "balanced",
      avg_stress: 20,
      avg_body_battery: 72,
      avg_respiration: 14,
      avg_spo2: 92,
      skin_temp_dev_c: 0.4,
      avg_training_readiness: 82,
      vo2max: 51,
      training_status: "productive",
      avg_steps: 9234,
      weight_kg: 84.2,
      body_fat_pct: 17.3,
      muscle_mass_kg: 39.4,
    },
  });

  assert.match(html, /Recovery · last 2 weeks/);
  assert.match(html, /Garmin · Apple Health · watch &lt;raw&gt;/);
  assert.match(html, /Last logged today/);
  assert.doesNotMatch(html, /last synced stretch/);
  assert.match(html, /Sleeping well/);
  assert.match(html, /7h 32m a night · 72m deep · 88m REM · −33 min vs your month/);
  assert.match(html, /Resting heart rate up a touch/);
  assert.match(html, /~52 bpm · \+2 bpm vs your month/);
  assert.match(html, /Heart-rate variability balanced/);
  assert.match(html, /~61 ms · \+4 ms vs your month/);
  assert.match(html, /Blood oxygen ran low overnight/);
  assert.match(html, /Skin temp ran warm overnight/);
  assert.match(html, /Primed to train/);
  assert.match(html, /VO₂max ~51 · productive/);
  assert.match(html, /~9k steps/);
  assert.match(html, /Body composition/);
  assert.doesNotMatch(html, /<raw>/);
});

test("health read recovery dates a gone-quiet wearable honestly and mutes small drift", () => {
  const read = loadHealthRead();
  const html = read.recoveryHtml({
    sources: ["garmin"],
    delta: { sleep: 4, hrv: -1.2, rhr: 0.5 },
    recovery: { last_date: localISODaysAgo(5), avg_sleep_min: 430, avg_resting_hr: 52, avg_hrv_ms: 60 },
  });

  assert.match(html, /hb-rlast-stale/);
  assert.match(html, /Last logged 5 days ago — this read reflects your last synced stretch, not today/);
  // Drift under the calm floors stays silent, and resting HR reads steady.
  assert.doesNotMatch(html, /vs your month/);
  assert.match(html, /Resting heart rate steady/);
});

test("health read recovery keeps quiet empty states", () => {
  const read = loadHealthRead();

  assert.match(read.recoveryNoDataHtml(), /No sleep or recovery signal yet/);
  assert.match(read.recoveryHtml({ recovery: {} }), /Recovery data's coming in but nothing to call out yet/);
});

test("health read marker phrasing never renders scores and escapes marker data", () => {
  const read = loadHealthRead();
  const html = read.priorityMarkersSectionHtml([
    {
      key: "apob",
      name: "ApoB <risk>",
      unit: "mg/dL <unit>",
      impact_score: 999,
      in_optimal: false,
      optimal: { low: 40, high: 80 },
      latest: { value: 111, date: "2026-06-20", flag: "high" },
      points: [{ value: 80 }, { value: 111 }],
    },
    {
      key: "vit-d",
      name: "Vitamin D",
      in_optimal: true,
      optimal: { low: 30, high: 60 },
      latest: { value: 44, date: "2026-06-18", flag: "normal" },
    },
    {
      key: "ferritin",
      name: "Ferritin",
      latest: { value: 12, flag: "low" },
    },
  ]);

  assert.match(html, /What matters now/);
  assert.match(html, /2 to keep an eye on/);
  assert.match(html, /ApoB &lt;risk&gt;/);
  assert.match(html, /above optimal/);
  assert.match(html, /mg\/dL &lt;unit&gt;/);
  assert.match(html, /optimal 40–80/);
  assert.match(html, /<svg class="spark">80,111<\/svg>/);
  assert.match(html, /Everything else \(1\)/);
  assert.match(html, /in your optimal range/);
  assert.match(html, /See every trend/);
  assert.doesNotMatch(html, /impact_score|999|<risk>|<unit>/);
});

test("health read marker helper handles empty and lab-flagged rows", () => {
  const read = loadHealthRead();

  assert.equal(read.optimalPhrase({ latest: { flag: "high" } }).word, "running high");
  assert.equal(read.optimalPhrase({ latest: { flag: "high" } }).tone, "warn");
  assert.equal(read.optimalPhrase({ latest: { flag: "normal" } }).word, "in range");
  assert.equal(read.optimalPhrase({ latest: { flag: "normal" } }).tone, "ok");
  assert.match(read.priorityMarkersSectionHtml([]), /No markers yet/);
});
