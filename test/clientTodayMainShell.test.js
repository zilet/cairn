import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHost, loadClientModule } from "./_dom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const todayScreenSource = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");

function loadMainShell() {
  const context = { Object, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-main-shell-client.js"), "utf8"), context);
  return context.CairnTodayMainShell;
}

test("Today lead omits standalone typed, mic, and goal controls; the weigh-in rides This week", () => {
  const shell = loadMainShell();
  const html = shell.leadHtml(
    {
      isToday: true,
      briefHtml: `<section id="brief">Rest today.</section>`,
      conductorHtml: "",
      currentWeight: 172.4,
    },
    { escapeHtml: String }
  );

  // The bodyweight tile lives in This week's tallies, so the lead says it nowhere.
  assert.doesNotMatch(html, /id="wtChipMini"|id="wtInlineInput"/);
  assert.doesNotMatch(html, /id="qlInput"|id="qlMic"|id="qlBtn"/);
  assert.doesNotMatch(html, /id="goalSlot"|id="goalLine"/);
  // Today only ever shows today: there is no way back to it from inside itself.
  assert.doesNotMatch(html, /backToday|Back to today/);
});

test("Body & recovery: ONE week view on Today — no second Mon–Sun strip, no lifts/km tallies; the weigh-in tile, gauges, the old detail folded", () => {
  const shell = loadMainShell();
  const html = shell.weekFoldHtml(
    { weekRecap: "2 lifts", cellsHtml: `<div class="stat">x</div>`, planned: 5, done: 4, weekKm: 22.34 },
    { escapeHtml: (v) => String(v).replace(/</g, "&lt;") },
    // The trend is the ONE weight-trend read's words (stats.weight_trend.rate_words), never a re-derived slope.
    { currentWeight: 172.4, trendWords: "−0.8 lb/wk", runs: true }
  );
  assert.match(html, /<section class="tweek" id="todayWeek" aria-label="Body and recovery">/);
  assert.match(html, /<span class="lbl">Body &amp; recovery<\/span>/);
  // The week's days and its counts (lifting days, km, the block clock) are the
  // "What's ahead" strip's header now: nothing here repeats them.
  assert.doesNotMatch(html, /id="tweekStrip"|twk-|id="tweekKmNote"|id="tweekBlock"|lifts · |\/5<\/span>/);
  // A runner's distance rides the strip; no cardio tile.
  assert.doesNotMatch(html, /cardio/);
  // The weigh-in tile keeps the inline capture's id; its number has its own node so
  // a save rewrites it without dropping the sparkline beside it.
  assert.match(html, /<div class="tweek-tallies is-one"><button id="wtChipMini" class="tweek-tally tweek-wt"[^>]*><span class="tweek-n num" data-wtval>172\.4<span class="tweek-u">lb<\/span><\/span><small>−0\.8 lb\/wk<\/small><span class="tweek-spark" id="tweekSpark"/);
  assert.match(html, /id="tweekGauges"/);
  // The weight input opens under the tallies, outside the fold.
  assert.ok(html.indexOf('id="wtInlineInput"') < html.indexOf("<details"));
  // The older detail stays one tap away.
  assert.match(html, /<details class="weekfold tweek-more" id="weekFold">[\s\S]*More about this week[\s\S]*class="stat"[\s\S]*id="wearStrip"/);
  assert.doesNotMatch(html, /id="wtChip"/);
});

test("Body & recovery keeps a cardio count only for an athlete with no running", () => {
  const shell = loadMainShell();
  const html = shell.weekFoldHtml({ planned: 3, done: 1, weekKm: 0 }, { escapeHtml: String }, { weekCardio: 2, runs: false });
  assert.match(html, /data-cu="2">0<\/span><\/div><small>cardio this week/);
  assert.match(html, /class="tweek-tallies"/);
  assert.match(html, /weight · tap to log/);
  const none = shell.weekFoldHtml({ weekKm: 0 }, { escapeHtml: String }, { weekCardio: 0, runs: false });
  assert.doesNotMatch(none, /cardio/, "no '0 cardio' tile");
});

test("the redesigned Today's async slots: the digest before the week, the one new connection after", () => {
  const shell = loadMainShell();
  assert.equal(shell.digestSlotHtml(), `<div id="todayDigestSlot" class="tdg-slot"></div>`);
  // Coming up left Today for Horizon: no slot for it.
  assert.equal(shell.aheadSlotsHtml(), `<div id="todayHeadingSlot" class="thd-slot"></div>`);
});

test("a kg athlete reads and types bodyweight in kg: the tile and the weigh-in input follow the unit", () => {
  const context = { Object, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-main-shell-client.js"), "utf8"), context);
  context.CairnFmt.set({ weight_units: "kg" });
  const html = context.CairnTodayMainShell.weekFoldHtml({}, { escapeHtml: String }, { currentWeight: 176.37, trendWords: "−0.4 kg/wk", runs: true });
  assert.match(html, /data-wtval>80<span class="tweek-u">kg<\/span><\/span><small>−0\.4 kg\/wk<\/small>/);
  assert.match(html, /<input id="wtInlineInput"[^>]*placeholder="Weight \(kg\)" aria-label="Bodyweight in kg" data-unit="kg">/);
  assert.doesNotMatch(html, /\blb\b/);
});

test("Today lead leaves the check-in to the Brief and keeps the tag chips, without the retired frequents strip", () => {
  const shell = loadMainShell();
  const html = shell.leadHtml(
    {
      isToday: true,
      briefHtml: `<section id="brief">Rest today.</section>`,
      conductorHtml: "",
      currentWeight: 172.4,
    },
    { escapeHtml: String }
  );

  assert.doesNotMatch(html, /id="freqFoods"/);
  assert.match(html, /id="tagsSlot" class="tags-slot"/);
  // The check-in moved under the Brief's own sentence (today-brief-client.ts) —
  // a footer three surfaces below the question was never where it belonged.
  assert.doesNotMatch(html, /id="checkinSlot"/);
});

test("Today lead omits the day-scoped slots when browsing a day other than today", () => {
  const shell = loadMainShell();
  const html = shell.leadHtml(
    {
      isToday: false,
      briefHtml: `<section id="brief">Rest today.</section>`,
      conductorHtml: "",
      currentWeight: 172.4,
    },
    { escapeHtml: String }
  );

  assert.doesNotMatch(html, /id="freqFoods"/);
  assert.doesNotMatch(html, /id="checkinSlot"|id="tagsSlot"/);
});

test("This week owns trajectory stats without rendering a standalone pace offer", () => {
  const shell = loadMainShell();
  const html = shell.weekFoldHtml(
    {
      weekRecap: "2 lifts",
      cellsHtml: `<div class="stat stat-pace pace-fast">-1.7</div>`,
      paceOfferHtml: `<button id="paceOffer">ask the coach</button>`,
    },
    { escapeHtml: String }
  );

  assert.match(html, /^<section class="tweek"/);
  assert.match(html, /pace-fast/);
  assert.doesNotMatch(html, /paceOffer|ask the coach/);
});

// The Brief's in-place upgrade (today-brief-controller.ts upgradeBriefInPlace) swaps the
// <section class="brief"> node; the strip and Path slots are the nodes their controllers
// mounted on, so they ride across — ALWAYS, painted or not. An empty strip left behind
// was a detached node its controller painted into, and the fresh Brief kept an empty,
// never-wired slot.
test("carryBriefSlots carries the strip and Path slots across a Brief swap even before they paint", () => {
  const win = loadClientModule(["today-main-shell-client"]);
  const view = createHost(win.document, {
    html: `<section class="brief"><div id="todayStripSlot" class="tstrip-slot"></div><div id="todayPathSlot" class="tpath-slot"><div class="tpath">trail</div></div><div id="briefProvenance"></div></section>`,
  });
  const old = view.querySelector(".brief");
  const strip = old.querySelector("#todayStripSlot");
  const path = old.querySelector("#todayPathSlot");
  let clicks = 0;
  strip.addEventListener("click", () => clicks++);
  const carry = win.CairnTodayMainShell.carryBriefSlots(old);
  const tmp = win.document.createElement("div");
  tmp.innerHTML = `<section class="brief fresh"><div id="todayStripSlot" class="tstrip-slot"></div><div id="todayPathSlot" class="tpath-slot"></div><div id="briefProvenance"></div></section>`;
  const fresh = tmp.firstElementChild;
  old.replaceWith(fresh);
  carry(fresh);
  // The very nodes the controllers hold are in the new Brief, still connected.
  assert.equal(fresh.querySelector("#todayStripSlot"), strip, "the EMPTY strip slot rides too");
  assert.equal(fresh.querySelector("#todayPathSlot"), path);
  assert.ok(strip.isConnected && path.isConnected);
  assert.equal(view.querySelectorAll("#todayStripSlot").length, 1);
  // A paint that lands after the swap lands on screen, and its listeners still answer.
  strip.innerHTML = `<section class="tstrip" data-wired><button data-tstrip-day="2026-10-06">6</button></section>`;
  view.querySelector("[data-tstrip-day]").click();
  assert.equal(clicks, 1);
});

test("a saved first-paint snapshot freezes lazily wired sections: never a live-looking dead control", () => {
  const win = loadClientModule(["today-main-shell-client"]);
  const copy = createHost(win.document, {
    html: `<div class="brief"><div id="todayStripSlot"><section class="tstrip" data-wired><button data-tstrip-day="x">6</button></section></div><div id="todayPushOfferSlot"><section class="tpush-offer" data-wired><button data-tpush-accept>Yes</button></section></div><button data-briefwhy>tap to see why</button></div>`,
  });
  win.CairnTodayMainShell.freezeSnapshot(copy);
  for (const el of copy.querySelectorAll("[data-wired]")) {
    assert.ok(el.hasAttribute("inert"), "inert until the real render wires it");
    assert.equal(el.getAttribute("aria-busy"), "true");
  }
  // Only the lazily wired sections: the Brief's own controls are untouched.
  assert.equal(copy.querySelector("[data-briefwhy]").hasAttribute("inert"), false);
  // today-screen.ts freezes every saved hydrated snapshot.
  assert.match(todayScreenSource, /todayMainShell\.freezeSnapshot\(copy\)[\s\S]{0,200}todaySaveSurfaceSnapshot\(at\.date, copy\.innerHTML\)/);
});

test("the slot hold covers the lazy Brief slots, so a reload's real write never blanks the strip into an unwired gap", () => {
  const win = loadClientModule(["today-slot-hold"]);
  for (const id of ["todayStripSlot", "todayPushSlot", "todayPushOfferSlot"])
    assert.ok(win.CairnTodaySlotHold.SLOT_IDS.includes(id), id);
});

test("Today exact-HTML snapshots use the v2 namespace after removing legacy controls", () => {
  assert.match(todayScreenSource, /const TODAY_PLAN_SNAP_KEY = "cairn\.today\.plan\.v2";/);
  assert.doesNotMatch(todayScreenSource, /cairn\.today\.plan\.v1/);
});
