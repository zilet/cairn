import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const escHtml = (value) =>
  String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escAttr = (value) => escHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function loadRenderer() {
  const context = { Array, Date, Map, Set, Number, Object, String, window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/decision-undo-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  return context.CairnTodayPlanSurfaceRenderer;
}

// Renders the session surface with a recording exCard: the card markup itself is
// covered by clientTodayCards.test.js, this proves WHICH items reach it, in what
// order, and with which partners.
function render(items) {
  const cards = [];
  const html = loadRenderer().buildHtml(
    {
      showDone: false, showPlan: true, focus: true, session: null,
      day: { day_number: 1, name: "Full body", items }, isToday: true, plan: [], activeDay: 1,
      logDate: "2026-07-29", strengthItems: items, activeItems: items, skippedItems: [],
      loggedByEx: {}, offPlanEx: [], pendingOffPlan: [], lastSets: {}, rxByEx: {}, strengthJourney: null,
      exDone: 0, exTotal: items.length, hasSyncedCardioToday: false, hasLoggedSets: false, hasGarmin: false,
      isRunDay: false, prefillFor: () => ({}), rxFor: () => null,
    },
    {
      planSurface: { daySwitchHtml: () => "", rxBannerHtml: () => "", sessionHeadHtml: () => "", addExerciseFormHtml: () => "", finishHtml: () => "" },
      planSurfaceDeps: () => ({ escapeHtml: escHtml, escapeAttr: escAttr }),
      exCard: (item) => {
        // Arrays built inside the vm realm are not deepStrictEqual to this realm's.
        cards.push({ ...item, pairPartners: item.pairPartners ? Array.from(item.pairPartners) : undefined });
        return `<div class="ex" data-card="${escAttr(item.exercise)}"></div>`;
      },
      garminSessionCard: () => "", sessionDoneCard: () => "", skipLineHtml: () => "",
    },
  );
  return { html, cards };
}

test("two items sharing a group render as one group with one caption and name each other", () => {
  const { html, cards } = render([
    { exercise: "Curl", superset_group: 1 },
    { exercise: "Pushdown", superset_group: 1 },
    { exercise: "Squat", superset_group: null },
  ]);
  assert.equal((html.match(/class="ex-group-cap"/g) || []).length, 1);
  assert.match(html, /Pair — alternate sets, rest after both/);
  assert.deepEqual(cards.map((c) => c.exercise), ["Curl", "Pushdown", "Squat"]);
  assert.deepEqual(cards[0].pairPartners, ["Pushdown"]);
  assert.deepEqual(cards[1].pairPartners, ["Curl"]);
  assert.equal(cards[2].pairPartners, undefined);
  assert.ok(html.indexOf("ex-group-cap") < html.indexOf('data-card="Curl"'), "caption leads the group");
});

test("non-adjacent members render adjacent, at the first member's position", () => {
  const { cards } = render([
    { exercise: "Curl", superset_group: 4 },
    { exercise: "Squat" },
    { exercise: "Row" },
    { exercise: "Pushdown", superset_group: 4 },
  ]);
  assert.deepEqual(cards.map((c) => c.exercise), ["Curl", "Pushdown", "Squat", "Row"]);
});

test("a group of three says Group and each card lists the other two", () => {
  const { html, cards } = render([
    { exercise: "A", superset_group: 2 },
    { exercise: "B", superset_group: 2 },
    { exercise: "C", superset_group: 2 },
  ]);
  assert.match(html, /Group — rotate sets, rest after all/);
  assert.deepEqual(cards[1].pairPartners, ["A", "C"]);
});

test("a lone member renders as a plain card with no caption or partners", () => {
  const { html, cards } = render([{ exercise: "Curl", superset_group: 3 }, { exercise: "Squat" }]);
  assert.doesNotMatch(html, /ex-group-cap/);
  assert.equal(cards[0].pairPartners, undefined);
});

test("the group caption never carries exercise text; partner names reach the card raw for it to escape", () => {
  const nasty = `Curl <b> & "Q"`;
  const { html, cards } = render([
    { exercise: nasty, superset_group: 1 },
    { exercise: "Pushdown", superset_group: 1 },
  ]);
  assert.doesNotMatch(html, /<b>/);
  assert.deepEqual(cards[1].pairPartners, [nasty]);
});
