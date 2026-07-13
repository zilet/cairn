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
  const context = { Math, Number, Object, String, JSON, Array, Set, escHtml, progressHero, CairnUi };
  context.window = context;
  context.globalThis = context;
  // The card composes the shared §04d reading primitives; load the real renderers.
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-reads.js"), "utf8"), context);
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
  context.Set = Set;
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-reads.js"), "utf8"), context);
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

test("progress energy read summarizes intake and trend (no goal → maintenance grammar)", () => {
  const energy = loadEnergy();

  // No projection_text → no active loss goal → a calm maintenance-framed read.
  const read = energy.energyRead({ tdee: 2800, confidence: "high", intake_avg_kcal: 2300, trend_lb_wk: -0.26 });
  assert.equal(read.lead, "Drifting down gently, about 0.3 lb/week, eating ~2,300 kcal/day.");
  assert.equal(read.body, "");
  assert.equal(read.tone, "read");
  assert.equal(read.dir, "down");
  assert.equal(read.lever, false);
  assert.equal(
    energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.01 }).lead,
    "Holding steady around ~2,700 kcal/day — right about where maintenance sits."
  );
  assert.equal(energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.12 }).dir, "up");
  assert.equal(
    energy.energyRead({ tdee: 2700, confidence: "medium", intake_avg_kcal: 3000, trend_lb_wk: 0.4 }).lead,
    "Trending up gently, about 0.4 lb/week, eating ~3,000 kcal/day."
  );
});

test("progress energy read speaks the intended outcome when a loss goal is active", () => {
  const energy = loadEnergy();
  const goal = { projection_text: "At your current trend, ~Aug 12." };

  // Intentional deficit, inside lean-safe → the reframe: the outcome you intended.
  const onPace = energy.energyRead({ ...goal, tdee: 2400, confidence: "high", intake_avg_kcal: 1900, trend_lb_wk: -1.1 });
  assert.equal(onPace.lead, "You're running the deficit you set — down about 1.1 lb/week, a steady lean-safe pace.");
  assert.equal(onPace.dir, "down");
  assert.equal(onPace.lever, false);

  // Brisk but sustainable — informational, no alarm, not a lever.
  const brisk = energy.energyRead({ ...goal, tdee: 2400, confidence: "high", intake_avg_kcal: 1700, trend_lb_wk: -1.8 });
  assert.match(brisk.lead, /Losing at a good clip — down about 1\.8 lb\/week/);
  assert.equal(brisk.lever, false);

  // Faster than lean-safe → the calm lever (terracotta), never punishment.
  const fast = energy.energyRead({ ...goal, tdee: 2400, confidence: "high", intake_avg_kcal: 1500, trend_lb_wk: -2.6 });
  assert.match(fast.lead, /faster than lean-safe — down about 2\.6 lb\/week/);
  assert.equal(fast.lever, true);

  // Intake above a loss (weight edged up) → calm information + the next small move.
  const above = energy.energyRead({ ...goal, tdee: 2400, confidence: "high", intake_avg_kcal: 2600, trend_lb_wk: 0.3 });
  assert.match(above.lead, /eating a little above a loss right now — weight's edged up about 0\.3 lb\/week/);
  assert.doesNotMatch(above.lead, /fail|behind|should/i);
  assert.equal(above.lever, false);

  // Holding steady with a goal → a small trim, never blame.
  const flat = energy.energyRead({ ...goal, tdee: 2400, confidence: "high", intake_avg_kcal: 2400, trend_lb_wk: 0 });
  assert.match(flat.lead, /holding steady at ~2,400 kcal\/day — a small trim/);
});

test("progress energy read stays calm and honest when the picture is loose or still forming", () => {
  const energy = loadEnergy();

  // Low confidence dominates — never a confident pace claim on thin data.
  const loose = energy.energyRead({ tdee: 2500, confidence: "low", intake_avg_kcal: 2100, trend_lb_wk: -1.4, projection_text: "x" });
  assert.equal(loose.lead, "The picture's a little loose this week — a few more logged days will sharpen it.");
  assert.equal(loose.tone, "read");

  // Starting estimate (profile seed) — a few weeks of logging turns it real.
  const seed = energy.energyRead({ tdee: 2450, confidence: "none", tdee_basis: "profile_seed" });
  assert.match(seed.lead, /Starting around 2,450 kcal\/day — a few weeks of logging/);

  // Confident intake but no scale trend yet → a steady read, not a forced direction.
  const noTrend = energy.energyRead({ tdee: 2600, confidence: "high", intake_avg_kcal: 2600, trend_lb_wk: null });
  assert.match(noTrend.lead, /about 2,600 kcal\/day to hold steady — a few weigh-ins/);
  assert.equal(noTrend.dir, null);
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
  assert.match(html.cardHtml, /well-established · 21 outcome days · 21-day window/);
  assert.match(html.cardHtml, /Run a check-in/);
  // High confidence → a crisp, narrow maintenance-zone band (40%–60%), no quiet rows.
  assert.match(html.cardHtml, /class="eb-zone eb-zone--high"/);
  assert.match(html.cardHtml, /read-band-range" style="left:40\.00%;width:20\.00%"/);
  assert.match(html.cardHtml, /Your maintenance zone is dialed in\./);
  assert.doesNotMatch(html.cardHtml, /read-contribs/);
});

test("progress energy renders confidence as band geometry — wider + quiet rows when loose", () => {
  const energy = loadEnergy();

  // Low confidence → a WIDER band (20%–80%) plus a quiet "read is looser" contributor.
  const low = energy.energyCardHtml({
    tdee: 2500,
    confidence: "low",
    intake_avg_kcal: 2100,
    trend_lb_wk: -0.4,
    points: 4,
    window_days: 21,
    coverage: { intake_days: 4, weigh_in_days: 2 },
  });
  assert.match(low, /class="eb-zone eb-zone--low"/);
  assert.match(low, /read-band-range" style="left:20\.00%;width:60\.00%"/);
  assert.match(low, /read-contribs/);
  assert.match(low, /read-contrib-pip quiet/);
  assert.match(low, /light this week — the read stays looser/);

  // None → phrase-only band (no track drawn), still calm + quiet rows.
  const none = energy.energyCardHtml({ tdee: 2450, confidence: "none", tdee_basis: "profile_seed", points: 0, window_days: 21 });
  assert.match(none, /class="eb-zone eb-zone--none"/);
  assert.doesNotMatch(none, /read-band-track/);
  assert.match(none, /Not enough yet to place your maintenance zone\./);

  // Faster than lean-safe → the terracotta lever class on the card.
  const lever = energy.energyCardHtml({
    tdee: 2400,
    confidence: "high",
    intake_avg_kcal: 1500,
    trend_lb_wk: -2.6,
    projection_text: "on pace",
    points: 21,
    window_days: 21,
  });
  assert.match(lever, /class="eb-card reveal eb-card--lever"/);
});

test("progress energy card escapes server-supplied provenance text", () => {
  const energy = loadEnergy();
  const html = energy.energyCardHtml({
    tdee: 2400,
    confidence: "high",
    intake_avg_kcal: 1900,
    trend_lb_wk: -1.1,
    projection_text: "on pace",
    basis: "Learned from <script>alert(1)</script>",
    points: 21,
    window_days: 21,
  });
  assert.match(html, /Learned from &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("progress energy presents a prior-backed starting estimate honestly", () => {
  const energy = loadEnergy();
  const html = energy.energyBodyHtml({
    tdee: 2450,
    confidence: "none",
    tdee_basis: "profile_seed",
    basis: "Starting estimate from the profile and activity setting.",
    points: 0,
    window_days: 21,
  });
  assert.match(html.heroHtml, /2450/);
  assert.match(html.cardHtml, /Starting around 2,450 kcal\/day/);
  assert.match(html.cardHtml, /Starting estimate from the profile and activity setting/);
  assert.match(html.cardHtml, /starting estimate · 21-day window/);
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
  assert.match(html, /Open meals/);
  assert.match(html, /review posture/);
  assert.match(html, /Got it/);
  assert.doesNotMatch(html, /<fuel>|<rush>/);
});

test("progress energy surface paints and runs durable check-in handlers", async () => {
  const { context, hero, card, checkin, runButton, calls, state, goMeals, dismiss } = loadEnergySurface();

  context.paintEnergyBody({
    tdee: 2800,
    confidence: "high",
    intake_avg_kcal: 2300,
    trend_lb_wk: -0.2,
    points: 21,
    window_days: 21,
  });
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
