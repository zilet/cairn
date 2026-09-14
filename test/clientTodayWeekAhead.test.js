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
  return escHtml(value).replaceAll('"', "&quot;");
}

function loadTodayWeekAhead() {
  const context = { Object, Array, String, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-week-ahead-client.js"), "utf8"), context);
  return context.CairnTodayWeekAhead;
}

test("Today week-ahead renders calm rows with escaped values", () => {
  const weekAhead = loadTodayWeekAhead();
  const html = weekAhead.cardHtml({
    ok: true,
    days: [
      { day: "Mon", kind: "lift", label: "Upper <push>", note: "Keep it easy" },
      { day: "Tue", kind: "run", label: "Z2 run", note: "30 < 45 min" },
      { day: "Wed", kind: "surprise", label: "Fallback kind" },
    ],
    summary: "Two training anchors <steady>",
  });

  assert.match(html, /The week ahead/);
  assert.match(html, /wa-lift/);
  assert.match(html, /wa-run/);
  assert.match(html, /Upper &lt;push&gt;/);
  assert.match(html, /30 &lt; 45 min/);
  assert.match(html, /Two training anchors &lt;steady&gt;/);
  assert.match(html, /Fallback kind/);
  assert.doesNotMatch(html, /Upper <push>|30 < 45|anchors <steady>/);
  assert.equal(weekAhead.kind("rest"), "rest");
  assert.equal(weekAhead.kind("unknown"), "lift");
});

test("Today week-ahead omits empty or failed reads", () => {
  const weekAhead = loadTodayWeekAhead();

  assert.equal(weekAhead.cardHtml(null), "");
  assert.equal(weekAhead.cardHtml({ ok: false, days: [{ label: "Nope" }] }), "");
  assert.equal(weekAhead.cardHtml({ ok: true, days: [] }), "");
});

test("Today week-ahead renders the quiet race line, with the date tucked into a title", () => {
  const weekAhead = loadTodayWeekAhead();
  const html = weekAhead.cardHtml({
    ok: true,
    days: [{ day: "Mon", kind: "run", label: "Z2 run" }],
    summary: "",
    race: { label: "Half marathon", date: "2026-10-26", weeks_to_race: 6, days_to_race: 42, phase: "build", text: "Half marathon · 6 weeks out · building" },
  });

  assert.match(html, /weekahead-race/);
  assert.match(html, /Half marathon · 6 weeks out · building/);
  assert.match(html, /title="2026-10-26"/);
});

test("Today week-ahead still renders the card with only a race line and no days", () => {
  const weekAhead = loadTodayWeekAhead();
  const html = weekAhead.cardHtml({
    ok: true,
    days: [],
    summary: "",
    race: { label: "Half marathon", date: "2026-10-26", weeks_to_race: 1, days_to_race: 3, phase: "taper", text: "Half marathon · race week" },
  });

  assert.match(html, /The week ahead/);
  assert.match(html, /Half marathon · race week/);
});

test("Today week-ahead renders nothing when there are neither days nor a race", () => {
  const weekAhead = loadTodayWeekAhead();
  assert.equal(weekAhead.cardHtml({ ok: true, days: [], summary: "", race: null }), "");
});
