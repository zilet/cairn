import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const todayScreenSource = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");

function loadMainShell() {
  const context = { Object, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-main-shell-client.js"), "utf8"), context);
  return context.CairnTodayMainShell;
}

test("Today lead keeps bodyweight capture reachable and omits standalone typed, mic, and goal controls", () => {
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

  assert.match(html, /id="wtChipMini"/);
  assert.match(html, /id="wtInlineInput"/);
  assert.match(html, /172\.4<span class="wt-mini-unit">lb/);
  assert.doesNotMatch(html, /id="qlInput"|id="qlMic"|id="qlBtn"/);
  assert.doesNotMatch(html, /id="goalSlot"|id="goalLine"/);
});

test("Today lead carries the quiet check-in slot on today's own date, without the retired frequents strip", () => {
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
  assert.match(html, /id="checkinSlot" class="checkin-slot"/);
});

test("Today lead omits the check-in slot when browsing a day other than today", () => {
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
  assert.doesNotMatch(html, /id="checkinSlot"/);
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

  assert.match(html, /^<details class="weekfold"/);
  assert.match(html, /pace-fast/);
  assert.doesNotMatch(html, /paceOffer|ask the coach/);
});

test("Today exact-HTML snapshots use the v2 namespace after removing legacy controls", () => {
  assert.match(todayScreenSource, /const TODAY_PLAN_SNAP_KEY = "cairn\.today\.plan\.v2";/);
  assert.doesNotMatch(todayScreenSource, /cairn\.today\.plan\.v1/);
});
