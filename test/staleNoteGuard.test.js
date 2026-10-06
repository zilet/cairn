// The stale-note guard (docs/IA.md contract test 7): a plan item's stored "Deload: …"
// note was written for the week it was written in. In a week that resolves as no deload
// (no block deload, no recovery week running), no day of it — ahead or already lived —
// prints that note as the day's guidance (src/domain/training/day-detail.ts currentNote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { addDaysISO, mondayOf } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";

const NOW = new Date("2026-09-22T12:00:00");

test("in a non-deload week no day-detail exercise note starts with Deload", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  // Every plan day carries a stored back-off note on its first lift, as an old deload left it.
  for (const day of repo.getPlan()) {
    const items = day.items.map((item, i) =>
      i === 0 ? { ...item, note: "Deload: backed off to 2 sets for a week." } : item
    );
    repo.savePlanDay(day.day_number, day.name, day.focus, items);
  }
  const today = localDateISO();
  let checked = 0;
  for (let d = mondayOf(today); d <= addDaysISO(mondayOf(today), 13); d = addDaysISO(d, 1)) {
    const read = dayDetail(d);
    if (!read?.lift || read.week.block?.phase === "deload") continue;
    for (const ex of read.lift.exercises) {
      assert.doesNotMatch(String(ex.note ?? ""), /^Deload/i, `${d} ${ex.name}: ${ex.note}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "lift days were read, lived and ahead");
  // The stored plan is untouched.
  assert.match(repo.getPlan()[0].items[0].note, /^Deload: backed off/);
});
