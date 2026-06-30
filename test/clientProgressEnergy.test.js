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

function progressHero(title, stats) {
  const rows = (stats || [])
    .filter(Boolean)
    .map(([label, value]) => `<span class="hero-stat"><span>${escHtml(label)}</span><b>${escHtml(value)}</b></span>`)
    .join("");
  return `<section class="progress-hero"><h2>${escHtml(title)}</h2>${rows}</section>`;
}

const CairnUi = {
  jobCaptionHtml({ text = "", tag = "span", className = "job-cap" } = {}) {
    return `<${tag} class="${className}">${escHtml(text)}</${tag}>`;
  },
};

function loadEnergy() {
  const context = { Math, Number, Object, String, JSON, Array, escHtml, progressHero, CairnUi };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-energy-client.js"), "utf8"), context);
  return context.CairnProgressEnergy;
}

test("progress energy read stays quiet without enough data", () => {
  const energy = loadEnergy();
  const read = energy.energyRead({ confidence: "none" });

  assert.equal(read.tone, "quiet");
  assert.match(read.lead, /Not enough logged/);
  assert.match(read.body, /Keep logging meals/);
  assert.equal(energy.kcalFmt(2432.7), "2,433");
  assert.equal(energy.CONF_WORD.high, "well-established");
});

test("progress energy read summarizes intake and trend", () => {
  const energy = loadEnergy();

  const read = energy.energyRead({ tdee: 2800, confidence: "high", intake_avg_kcal: 2300, trend_lb_wk: -0.26 });
  assert.equal(read.lead, "Eating ~2,300 kcal/day, trending down about 0.3 lb/week.");
  assert.equal(read.body, "");
  assert.equal(read.tone, "read");
  assert.equal(read.dir, "down");
  assert.equal(energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.01 }).lead, "Holding steady.");
  assert.equal(energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.12 }).dir, "up");
});

test("progress energy helper renders the hero and reviewed check-in card", () => {
  const energy = loadEnergy();
  const html = energy.energyBodyHtml({
    tdee: 2800,
    confidence: "high",
    intake_avg_kcal: 2300,
    trend_lb_wk: -0.24,
    points: 21,
    window_days: 21,
  });

  assert.match(html.heroHtml, /Energy Balance/);
  assert.match(html.heroHtml, /est\. expenditure/);
  assert.match(html.cardHtml, /How you're tracking/);
  assert.match(html.cardHtml, /well-established · 21 days of data · 21-day window/);
  assert.match(html.cardHtml, /Run a check-in/);
});

test("progress energy helper renders check-in states safely", () => {
  const energy = loadEnergy();

  assert.match(energy.nutritionCheckinLoadingHtml(), /job-cap/);
  assert.match(energy.nutritionCheckinLoadingHtml(), /reading your trend/);
  assert.match(energy.nutritionCheckinFailHtml(), /Couldn't run a check-in/);

  const ok = energy.nutritionCheckinOkHtml({ summary: "Keep <steady> & review later" });
  assert.match(ok, /No change needed/);
  assert.match(ok, /Keep &lt;steady&gt; &amp; review later/);
  assert.doesNotMatch(ok, /<steady>/);
});

test("progress energy helper renders advisory proposal markup and escapes agent text", () => {
  const energy = loadEnergy();
  const html = energy.nutritionCheckinProposalHtml({
    proposal: {
      parsed: {
        nutrition: {
          target_kcal: 2400,
          prev_target_kcal: 2200,
          protein_g: 180,
          carbs_g: 250,
          fat_g: 70,
          reason: "Add <fuel> around training",
        },
        notes: "No <rush> needed",
      },
    },
  });

  assert.match(html, /data-cu="2400"/);
  assert.match(html, /\+200 vs now/);
  assert.match(html, /180g protein · 250g carbs · 70g fat/);
  assert.match(html, /Add &lt;fuel&gt; around training/);
  assert.match(html, /No &lt;rush&gt; needed/);
  assert.match(html, /Regenerate meal plan around this/);
  assert.match(html, /Got it/);
  assert.doesNotMatch(html, /<fuel>|<rush>/);
});
