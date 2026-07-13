import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escAttr(value) {
  return escHtml(value).replaceAll("\"", "&quot;");
}

function loadTodayCompass() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    escHtml,
    escAttr,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-compass-client.js"), "utf8"), context);
  return context.CairnTodayCompass;
}

const deps = {
  escapeHtml: escHtml,
  escapeAttr: escAttr,
  formatKm: (value) => String(Math.round(Number(value) * 10) / 10),
};

test("Today compass renders discipline-aware week cells and recap", () => {
  const compass = loadTodayCompass();
  const stats = {
    week_planned: 4,
    week_done: 2,
    week_cardio: 1,
    goal_mode: "lose",
    pace_status: "on",
    trend_lb_wk: -0.7,
    needed_lb_wk: -0.5,
    goal_weight_lb: 180,
    endurance: { week_km: 12.4, week_moving_min: 72 },
  };

  const strength = compass.build(stats, deps, { currentWeight: 184, isToday: true });
  assert.match(strength.cellsHtml, /data-cu="2">0<\/span><span class="stat-frac">\/4/);
  assert.match(strength.cellsHtml, /pace-on/);
  assert.match(strength.cellsHtml, /lb → 180/);
  assert.equal(strength.weekRecap, "2 lifts · 1 cardio · run 12.4 km");

  const endurance = compass.build(stats, deps, { currentWeight: 184, isToday: true, isEndurance: true });
  assert.match(endurance.cellsHtml, /Endurance volume by sport this week[\s\S]*12.4/);
  assert.equal(endurance.weekRecap, "1 cardio · run 12.4 km · 2 lifts");
});

test("Today compass pace offer is mode-aware and suppressed for maintain", () => {
  const compass = loadTodayCompass();

  assert.equal(
    compass.build({ goal_mode: "maintain", pace_status: "drifting_up", trend_lb_wk: 0.3, needed_lb_wk: 0 }, deps, { isToday: true }).paceOffer,
    null,
  );

  const gain = compass.build({ goal_mode: "gain", pace_status: "behind", trend_lb_wk: 0, needed_lb_wk: 0.4 }, deps, { isToday: true });
  assert.equal(gain.paceOffer?.status, "behind");
  assert.match(gain.paceOfferHtml, /Not building yet/);
  assert.match(gain.paceOffer?.ask || "", /lean gain/);

  const notToday = compass.build({ goal_mode: "lose", pace_status: "behind", trend_lb_wk: -0.1, needed_lb_wk: -0.6 }, deps, { isToday: false });
  assert.equal(notToday.paceOffer, null);
  assert.equal(notToday.paceOfferHtml, "");
});
