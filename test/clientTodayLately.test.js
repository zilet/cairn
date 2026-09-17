import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadTodayLately() {
  class FixedDate extends Date {
    static now() {
      return Date.parse("2026-06-30T12:00:00.000Z");
    }
  }

  const context = {
    Date: FixedDate,
    Math,
    Number,
    Object,
    String,
    Array,
    HR_ZONE_COLORS: ["#111", "#222", "#333", "#444", "#555"],
    escHtml: escapeHtml,
    escAttr: escapeHtml,
    relTime: (iso) => `rel:${iso}`,
    humanDate: (iso) => `human:${iso}`,
    art: (kind, text) => `art:${kind}:${text}`,
    artImg: (kind, text, className, svg) =>
      `<span class="${escapeHtml(className)}" data-kind="${escapeHtml(kind)}" data-text="${escapeHtml(text)}">${escapeHtml(svg)}</span>`,
    actArtText: (activity) => `activity:${activity.type || ""}`,
  };
  context.window = context;
  // date-utils publishes pickDayVariant, which the export receipt rotates through.
  // It also publishes the real relTime/humanDate; the fixture's stubs win, as before.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  context.relTime = (iso) => `rel:${iso}`;
  context.humanDate = (iso) => `human:${iso}`;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-lately-client.js"), "utf8"), context);
  return context.CairnTodayLately;
}

test("today lately renders Garmin reaction cards with escaped text and shared HR-zone colors", () => {
  const lately = loadTodayLately();

  const html = lately.garminSessionCard({
    duration_min: 42.2,
    avg_hr: 138,
    training_effect: 3.25,
    hr_zones: [{ zone: 2, secs: 60 }, { zone: 4, secs: 180 }],
    summary: "Strong <steady> work",
    extrapolated: true,
  });

  assert.match(html, /Garmin · body's reaction/);
  assert.match(html, /42\.2/);
  assert.match(html, /background:#222/);
  assert.match(html, /background:#444/);
  assert.match(html, /width:25\.0%/);
  assert.match(html, /width:75\.0%/);
  assert.match(html, /Strong &lt;steady&gt; work/);
  assert.doesNotMatch(html, /Strong <steady> work/);
});

test("today lately renders expandable strength rows without leaking raw markup", () => {
  const lately = loadTodayLately();

  const html = lately.rowHtml({
    kind: "strength",
    title: "Push <day>",
    date: "2026-06-29",
    at: "2026-06-30T10:00:00.000Z",
    stats: "3 sets",
    movements: [{ name: "Bench <press>", best: "185 x 5", sets: 3 }],
    detail: { avg_hr: 122 },
  });

  assert.match(html, /lately-strength/);
  assert.match(html, /role="button"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Push &lt;day&gt;/);
  assert.match(html, /Bench &lt;press&gt;/);
  assert.match(html, /3×/);
  assert.match(html, /rel:2026-06-30T10:00:00\.000Z/);
  assert.doesNotMatch(html, /Push <day>|Bench <press>/);
});

// ---- the Garmin export receipt --------------------------------------------------
// A lift the FIT catalog has no enum for is left out of the write-back on purpose, and
// that used to be silent: a 14-set session landed as 8 with nothing anywhere saying so.

test("the Garmin card names the lifts that never reached Garmin", () => {
  const lately = loadTodayLately();

  const html = lately.garminSessionCard({
    duration_min: 34,
    export: {
      activity_id: "24386427797",
      exported_at: "2026-09-16T18:04:00.000Z",
      exported_sets: 8,
      skipped_sets: 6,
      skipped_exercises: ["Pallof <Press>", "Reverse Pec Deck"],
    },
  });

  assert.match(html, /garmin-receipt/);
  assert.match(html, /8 of 14 sets/);
  assert.match(html, /Pallof &lt;Press&gt;/);
  assert.doesNotMatch(html, /Pallof <Press>/);
});

test("a write that landed whole says nothing — a receipt for complete work is noise", () => {
  const lately = loadTodayLately();

  const html = lately.garminSessionCard({
    duration_min: 34,
    export: { activity_id: "9001", exported_at: "2026-09-16T18:04:00.000Z", exported_sets: 14, skipped_sets: 0 },
  });

  assert.doesNotMatch(html, /garmin-receipt/);
});
