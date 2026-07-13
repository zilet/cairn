// The Brief warm must compute "today" in the DEVICE's zone, not the server's, so
// a traveling owner's morning open still lands on a cached read. These pin the
// last-seen-zone recorder (record only on change, invalid ignored) and the pure
// warm-date selection (device zone in, falls back to server-local).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { warmDate } from "../dist/dayread.js";
import { weeklySlotStamp } from "../dist/scheduler.js";
import { localDateISO } from "../dist/repo/shared.js";

beforeEach(() => resetTables("app_state"));

const storedTz = () => {
  const row = db.prepare(`SELECT value FROM app_state WHERE key='client_tz'`).get();
  return row ? row.value : null;
};

test("recordClientTimeZone stores a valid zone and reads it back", () => {
  assert.equal(repo.recordedClientTimeZone(), undefined);
  repo.recordClientTimeZone("America/New_York");
  assert.equal(storedTz(), "America/New_York");
  assert.equal(repo.recordedClientTimeZone(), "America/New_York");
});

test("recordClientTimeZone ignores an absent or invalid zone (keeps the last good one)", () => {
  repo.recordClientTimeZone("Europe/Paris");
  repo.recordClientTimeZone(undefined);
  repo.recordClientTimeZone("");
  repo.recordClientTimeZone("Not/ARealZone");
  repo.recordClientTimeZone(null);
  assert.equal(repo.recordedClientTimeZone(), "Europe/Paris");
});

test("recordClientTimeZone only writes when the zone actually changes", () => {
  repo.recordClientTimeZone("Asia/Tokyo");
  const first = db.prepare(`SELECT updated_at FROM app_state WHERE key='client_tz'`).get().updated_at;
  // A repeat of the same zone must be a no-op (no new write): the timestamp holds.
  repo.recordClientTimeZone("Asia/Tokyo");
  const second = db.prepare(`SELECT updated_at FROM app_state WHERE key='client_tz'`).get().updated_at;
  assert.equal(first, second);
  // A different zone rewrites.
  repo.recordClientTimeZone("Asia/Kolkata");
  assert.equal(repo.recordedClientTimeZone(), "Asia/Kolkata");
});

test("recordedClientTimeZone falls back to undefined when a stored value is invalid", () => {
  // A junk value that slipped past somehow reads back as no-zone (server-local).
  repo.setAppState("client_tz", "garbage/zone");
  assert.equal(repo.recordedClientTimeZone(), undefined);
});

test("warmDate computes the calendar date in the given zone", () => {
  // 02:30 UTC on Jul 2 is still Jul 1 in New York (UTC-4 in summer) but Jul 2 in UTC.
  const instant = new Date("2026-07-02T02:30:00Z");
  assert.equal(warmDate("America/New_York", instant), "2026-07-01");
  assert.equal(warmDate("UTC", instant), "2026-07-02");
  assert.equal(warmDate("Asia/Tokyo", instant), "2026-07-02"); // UTC+9 → already Jul 2 11:30
});

test("warmDate falls back to server-local for an absent or invalid zone", () => {
  const instant = new Date("2026-07-02T02:30:00Z");
  assert.equal(warmDate(undefined, instant), localDateISO(instant));
  assert.equal(warmDate("Not/AZone", instant), localDateISO(instant));
});

test("warmToday resolves through the recorded zone, else server-local", () => {
  const instant = new Date("2026-07-02T02:30:00Z");
  // No zone recorded → server-local.
  assert.equal(warmDate(repo.recordedClientTimeZone(), instant), localDateISO(instant));
  // Once recorded, warm follows the device zone.
  repo.recordClientTimeZone("America/New_York");
  assert.equal(warmDate(repo.recordedClientTimeZone(), instant), "2026-07-01");
});

test("weekly scheduler slots use the owner's wall clock rather than the server clock", () => {
  // Sunday 23:30 UTC is still Sunday 19:30 in New York (before a 20:00 slot),
  // but already Monday morning in Tokyo (after its Sunday 20:00 slot).
  const instant = new Date("2026-07-12T23:30:00Z");
  assert.equal(weeklySlotStamp(instant, 0, 20, "America/New_York"), "2026-07-05");
  assert.equal(weeklySlotStamp(instant, 0, 20, "Asia/Tokyo"), "2026-07-12");

  // An hour later, New York has crossed its own 20:00 boundary.
  assert.equal(weeklySlotStamp(new Date("2026-07-13T00:30:00Z"), 0, 20, "America/New_York"), "2026-07-12");
});
