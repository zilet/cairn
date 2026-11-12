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
  vm.runInNewContext(readFileSync(join(root, "public/js/today-pair-groups-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-journey-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  // regroupPairs now lives on the pair-groups module the renderer delegates to.
  return { ...context.CairnTodayPlanSurfaceRenderer, regroupPairs: context.CairnTodayPairGroups.regroup };
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

test("the renderer sets head/tail position classes and the group key, so no :has() is needed", () => {
  const { cards } = render([
    { exercise: "A", superset_group: 2 },
    { exercise: "B", superset_group: 2 },
    { exercise: "C", superset_group: 2 },
  ]);
  assert.deepEqual(cards.map((c) => c.pairClasses), [" ex-in-group ex-group-head", " ex-in-group", " ex-in-group ex-group-tail"]);
  assert.deepEqual(cards.map((c) => c.pairGroup), [2, 2, 2]);
});

// A minimal DOM: just enough surface for regroupPairs (cards, captions, chips).
function fakeSurface(members) {
  const surface = { cards: [], caps: [] };
  const makeCap = (group, text) => ({
    dataset: { group: String(group) }, textContent: text,
    remove() { surface.caps.splice(surface.caps.indexOf(this), 1); },
  });
  surface.caps.push(makeCap(1, "Pair — alternate sets, rest after both"));
  for (const name of members) {
    const classes = new Set(["ex", "ex-in-group"]);
    const meta = { chip: { remove: () => { meta.chip = null; } }, querySelector: (sel) => (sel === ".ex-pair-chip" ? meta.chip : null), insertAdjacentHTML: () => {} };
    surface.cards.push({
      dataset: { card: name, group: "1" }, connected: true, meta, classes,
      attrs: new Map([["role", "group"], ["aria-labelledby", "ex-group-cap-1"]]),
      setAttribute(k, v) { this.attrs.set(k, v); },
      removeAttribute(k) { this.attrs.delete(k); },
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      querySelector: (sel) => (sel === ".ex-meta" ? meta : null),
      insertAdjacentHTML: () => surface.caps.push(makeCap(1, "")),
    });
  }
  surface.querySelectorAll = (sel) =>
    sel === ".ex[data-group]" ? surface.cards.filter((c) => c.connected) : sel === ".ex-group-cap[data-group]" ? surface.caps : [];
  return surface;
}

test("after one half of a pair leaves, the lone member is a plain card and the caption goes", () => {
  const surface = fakeSurface(["Curl", "Pushdown"]);
  surface.cards[1].connected = false;
  loadRenderer().regroupPairs(surface);
  assert.equal(surface.cards[0].classes.has("ex-in-group"), false);
  assert.equal(surface.cards[0].meta.chip, null, "no partner chip left");
  assert.equal(surface.caps.length, 0, "no caption left");
  assert.equal(surface.cards[0].attrs.has("role"), false, "a lone card is not a group");
  assert.equal(surface.cards[0].attrs.has("aria-labelledby"), false);
});

test("when the partner returns the group re-forms with its caption and position classes", () => {
  const surface = fakeSurface(["Curl", "Pushdown"]);
  const { regroupPairs } = loadRenderer();
  surface.cards[1].connected = false;
  regroupPairs(surface);
  surface.cards[1].connected = true;
  regroupPairs(surface);
  assert.equal(surface.caps.length, 1);
  assert.ok(surface.cards[0].classes.has("ex-group-head"));
  assert.ok(surface.cards[1].classes.has("ex-group-tail"));
  for (const card of surface.cards) {
    assert.equal(card.attrs.get("role"), "group", "a re-formed group is a group again");
    assert.equal(card.attrs.get("aria-labelledby"), "ex-group-cap-1");
  }
});

test("a group's caption carries the stable id its members are labelled by", () => {
  const { html } = render([
    { exercise: "A", superset_group: 4 },
    { exercise: "B", superset_group: 4 },
  ]);
  assert.match(html, /<div class="ex-group-cap" id="ex-group-cap-4" data-group="4">/);
});
