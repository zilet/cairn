// Time-of-day awareness (src/repo/shared.ts). Without these the coaching agent
// is temporally blind — it would ask "how'd dinner land last night?" at 5 PM
// because the conversation thread it's handed carries no clock. These pin the
// pure pieces: the part-of-day buckets, the local "now" snapshot folded into
// getCoachContext, the UTC-aware DB-timestamp parse, and the relative chat label.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  partOfDay,
  nowContext,
  parseDbTime,
  chatHistoryTimeLabel,
  localDateISO,
} from "../dist/repo/shared.js";
import { runWithTimeZone, activeTimeZone, isValidTimeZone } from "../dist/tz.js";

test("partOfDay buckets the hour into plain words", () => {
  assert.equal(partOfDay(2), "the middle of the night");
  assert.equal(partOfDay(8), "morning");
  assert.equal(partOfDay(13), "afternoon");
  assert.equal(partOfDay(17), "evening"); // 5 PM — the symptom hour
  assert.equal(partOfDay(20), "evening");
  assert.equal(partOfDay(22), "night");
});

test("nowContext snapshots the LOCAL date/weekday/time/part-of-day", () => {
  // Constructed as local time, so getHours()/getDay() read 17h / Tuesday on any
  // machine TZ (no toISOString involved) — deterministic.
  const n = nowContext(new Date(2026, 5, 23, 17, 15)); // Tue Jun 23 2026, 5:15 PM
  assert.equal(n.date, "2026-06-23");
  assert.equal(n.weekday, "Tuesday");
  assert.equal(n.hour, 17);
  assert.equal(n.part_of_day, "evening");
  // Don't pin the exact AM/PM spacing (ICU uses a narrow no-break space) — just
  // assert it reads as a 5:15 PM clock.
  assert.match(n.time, /5:15/);
  assert.match(n.time.toUpperCase(), /PM/);
});

test("parseDbTime reads a SQLite datetime('now') string as UTC, not local", () => {
  // "YYYY-MM-DD HH:MM:SS" with no zone marker IS UTC; new Date(that) would read
  // it as LOCAL. The instant must be 21:15 UTC regardless of the machine's TZ.
  const d = parseDbTime("2026-06-23 21:15:00");
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), Date.UTC(2026, 5, 23, 21, 15, 0));
  // An already-zoned ISO string passes through unchanged.
  assert.equal(parseDbTime("2026-06-23T21:15:00Z").getTime(), Date.UTC(2026, 5, 23, 21, 15, 0));
  // A Date passes through; junk/empty → null.
  const now = new Date(2026, 0, 1, 0, 0);
  assert.equal(parseDbTime(now), now);
  assert.equal(parseDbTime(null), null);
  assert.equal(parseDbTime(""), null);
  assert.equal(parseDbTime("not a date"), null);
});

test("chatHistoryTimeLabel reads recency relative to now", () => {
  // Pass Date objects (parseDbTime passthrough) so the local-day diff is TZ-stable.
  const now = new Date(2026, 5, 23, 17, 0); // Tue Jun 23 2026, 5 PM

  // Same local day → just the clock time, no day prefix.
  const sameDay = chatHistoryTimeLabel(new Date(2026, 5, 23, 8, 12), now);
  assert.match(sameDay, /8:12/);
  assert.ok(!/yesterday/i.test(sameDay) && !/Tuesday/i.test(sameDay), `same-day label should be time-only, got "${sameDay}"`);

  // Yesterday → "yesterday <time>".
  assert.match(chatHistoryTimeLabel(new Date(2026, 5, 22, 21, 40), now), /^yesterday /);

  // Earlier this week (3 days back, a Saturday) → the weekday name.
  assert.match(chatHistoryTimeLabel(new Date(2026, 5, 20, 9, 0), now), /^Saturday /);

  // Older than a week → a calendar date.
  assert.match(chatHistoryTimeLabel(new Date(2026, 4, 1, 9, 0), now), /^May 1 /);

  // Unparseable → empty (caller appends blindly).
  assert.equal(chatHistoryTimeLabel(null, now), "");
});

// --- timezone-aware framing (the "one local clock that follows the device") ---

test("nowContext frames a fixed instant differently per zone (the travel case)", () => {
  const instant = new Date(Date.UTC(2026, 5, 23, 23, 30)); // 23:30 UTC, Jun 23
  const ny = nowContext(instant, "America/New_York"); // UTC-4 → 7:30 PM Jun 23
  assert.equal(ny.date, "2026-06-23");
  assert.equal(ny.hour, 19);
  assert.equal(ny.part_of_day, "evening");
  assert.equal(ny.tz, "America/New_York");

  const tokyo = nowContext(instant, "Asia/Tokyo"); // UTC+9 → 8:30 AM Jun 24
  assert.equal(tokyo.date, "2026-06-24");
  assert.equal(tokyo.hour, 8);
  assert.equal(tokyo.part_of_day, "morning");
});

test("localDateISO honors an explicit zone (a meal's day depends on where you are)", () => {
  const instant = new Date(Date.UTC(2026, 5, 23, 23, 30));
  assert.equal(localDateISO(instant, "America/New_York"), "2026-06-23");
  assert.equal(localDateISO(instant, "Asia/Tokyo"), "2026-06-24");
});

test("runWithTimeZone scopes the active zone for default-arg helpers", () => {
  const instant = new Date(Date.UTC(2026, 5, 23, 23, 30));
  assert.equal(activeTimeZone(), undefined); // none in scope
  runWithTimeZone("Asia/Tokyo", () => {
    assert.equal(activeTimeZone(), "Asia/Tokyo");
    assert.equal(localDateISO(instant), "2026-06-24"); // picks up the scoped zone
    assert.equal(nowContext(instant).part_of_day, "morning");
  });
  assert.equal(activeTimeZone(), undefined); // restored after the scope
});

test("runWithTimeZone ignores an invalid/absent zone → server-local fallback", () => {
  runWithTimeZone("Not/AReal_Zone", () => assert.equal(activeTimeZone(), undefined));
  runWithTimeZone(null, () => assert.equal(activeTimeZone(), undefined));
});

test("isValidTimeZone accepts real IANA zones, rejects junk", () => {
  assert.ok(isValidTimeZone("America/New_York"));
  assert.ok(isValidTimeZone("Asia/Tokyo"));
  assert.ok(isValidTimeZone("UTC"));
  assert.ok(!isValidTimeZone("Not/AReal_Zone"));
  assert.ok(!isValidTimeZone(""));
  assert.ok(!isValidTimeZone("x".repeat(80)));
  assert.ok(!isValidTimeZone(null));
  assert.ok(!isValidTimeZone(123));
});
