import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCalendar() {
  const context = {
    Date,
    Map,
    Number,
    Object,
    String,
    stagger: (idx) => `--i:${idx}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-calendar-client.js"), "utf8"), context);
  return context.CairnProgressCalendar;
}

test("progress calendar renders a month grid with safe day metadata", () => {
  const calendar = loadCalendar();
  const byDate = new Map([
    ["2026-06-02", { level: 3, sets: 4, tonnage: 12345, activity: true }],
    ["2026-06-30", { level: 2, sets: 2, tonnage: 1000 }],
  ]);
  const html = calendar.calMonthHtml("2026-06", byDate, "2026-06-15", 2);

  assert.match(html, /June 2026/);
  assert.match(html, /style="--i:2"/);
  assert.match(html, /data-goto="2026-06-02"/);
  assert.match(html, /2026-06-02 · 4 sets · 12,345 lb · activity/);
  assert.match(html, /cal-today/);
  assert.doesNotMatch(html, /data-goto="2026-06-30"/);
});

test("progress calendar shows a rolling 7-day consistency line only above the first (newest) month grid", () => {
  const calendar = loadCalendar();
  const byDate = new Map([
    ["2026-06-15", { sets: 3 }], // today
    ["2026-06-14", { activity: true }],
    ["2026-06-10", { sets: 5 }],
    ["2026-06-09", { sets: 0 }], // no sets logged and no activity -> not "trained"
    ["2026-06-08", { sets: 4 }], // 7 days ago -> just outside the rolling window
  ]);

  const first = calendar.calMonthHtml("2026-06", byDate, "2026-06-15", 1);
  assert.match(first, /^<p class="cal-consistency">Trained 3 of the last 7 days\.<\/p>/);

  const second = calendar.calMonthHtml("2026-06", byDate, "2026-06-15", 2);
  assert.doesNotMatch(second, /cal-consistency/);
});

test("progress calendar omits the consistency line entirely at zero trained days (never guilt-trips)", () => {
  const calendar = loadCalendar();
  const html = calendar.calMonthHtml("2026-06", new Map(), "2026-06-15", 1);
  assert.doesNotMatch(html, /cal-consistency/);
});

test("calTrainedDaysInLast7 counts a rolling 7-day window ending today; calConsistencyLineHtml never renders zero", () => {
  const calendar = loadCalendar();
  const byDate = new Map([
    ["2026-06-15", { sets: 1 }],
    ["2026-06-09", { sets: 1 }], // 6 days ago -> inside the window
    ["2026-06-08", { sets: 1 }], // 7 days ago -> outside the window
  ]);
  assert.equal(calendar.calTrainedDaysInLast7(byDate, "2026-06-15"), 2);
  assert.equal(calendar.calConsistencyLineHtml(0), "");
  assert.equal(calendar.calConsistencyLineHtml(4), `<p class="cal-consistency">Trained 4 of the last 7 days.</p>`);
});
