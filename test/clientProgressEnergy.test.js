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

function fakeElement() {
  return {
    innerHTML: "",
    isConnected: true,
    listeners: {},
    querySelector(selector) {
      return this.children?.[selector] || null;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    children: {},
  };
}

function loadEnergySurface() {
  const hero = fakeElement();
  const card = fakeElement();
  const checkin = fakeElement();
  const runButton = fakeElement();
  const goMeals = fakeElement();
  const dismiss = fakeElement();
  const proposal = fakeElement();
  const caption = fakeElement();
  const calls = [];
  const state = {};
  const context = {
    Math,
    Number,
    Object,
    String,
    JSON,
    Array,
    escHtml,
    progressHero,
    CairnUi,
    state,
    view: {
      querySelector(selector) {
        if (selector === "#energyHero") return hero;
        if (selector === "#energyCard") return card;
        if (selector === "#checkinResult") return checkin;
        if (selector === "#runCheckin") return runButton;
        return null;
      },
    },
    runCountUps: (el) => calls.push(["runCountUps", el]),
    btnBusy: (btn, label) => {
      calls.push(["btnBusy", btn, label]);
      return () => calls.push(["restore"]);
    },
    runOp: (kind, body, options) => {
      calls.push(["runOp", kind, body, options]);
      return Promise.resolve(null);
    },
    thinkingCaption: (el, captionName) => {
      calls.push(["thinkingCaption", el, captionName]);
      return () => calls.push(["stopCaption"]);
    },
    activateTab: (tab) => calls.push(["activateTab", tab]),
    collapseEl: (_el, done) => {
      calls.push(["collapseEl"]);
      done?.();
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-energy-client.js"), "utf8"), context);
  checkin.children[".job-cap"] = caption;
  checkin.children["#ckGoMeals"] = goMeals;
  checkin.children["#ckDismiss"] = dismiss;
  checkin.children[".eb-proposal"] = proposal;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-energy-surface-client.js"), "utf8"), context);
  return { context, hero, card, checkin, runButton, goMeals, dismiss, calls, state };
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

test("progress energy surface paints and runs durable check-in handlers", async () => {
  const { context, hero, card, checkin, runButton, calls, state, goMeals, dismiss } = loadEnergySurface();

  context.paintEnergyBody({ tdee: 2800, confidence: "high", intake_avg_kcal: 2300, trend_lb_wk: -0.2, points: 21, window_days: 21 });
  assert.match(hero.innerHTML, /Energy Balance/);
  assert.match(card.innerHTML, /Run a check-in/);
  assert.equal(typeof runButton.listeners.click, "function");

  runButton.listeners.click();
  assert.match(checkin.innerHTML, /reading your trend/);
  const runCall = calls.find((call) => call[0] === "runOp");
  assert.equal(runCall[1], "nutrition_checkin");
  assert.equal(runCall[2].window, 21);

  runCall[3].render({ change: false, summary: "Keep steady" });
  assert.match(checkin.innerHTML, /No change needed/);
  assert.ok(calls.some((call) => call[0] === "restore"));

  runCall[3].render({
    change: true,
    proposal: { parsed: { nutrition: { target_kcal: 2400, prev_target_kcal: 2200, reason: "More fuel" } } },
  });
  assert.match(checkin.innerHTML, /A target worth considering/);
  goMeals.listeners.click();
  assert.equal(state.planJump, "meals");
  assert.ok(calls.some((call) => call[0] === "activateTab" && call[1] === "plan"));
  dismiss.listeners.click();
  assert.equal(checkin.innerHTML, "");
});

test("progress energy surface reconnects nutrition check-in jobs", () => {
  const { context, checkin, calls } = loadEnergySurface();

  const handlers = context.reconnectNutritionCheckin();
  assert.ok(handlers);
  assert.match(checkin.innerHTML, /reading your trend/);
  assert.ok(calls.some((call) => call[0] === "thinkingCaption" && call[2] === "nutrition_checkin"));

  handlers.onDone({ change: false, summary: "Still good" });
  assert.match(checkin.innerHTML, /No change needed/);
  assert.ok(calls.some((call) => call[0] === "stopCaption"));
});
