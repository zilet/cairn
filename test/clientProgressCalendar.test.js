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
