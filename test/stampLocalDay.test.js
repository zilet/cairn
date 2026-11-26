// A stored stamp is a UTC instant; the day it belongs to is the athlete's own.
// Slicing the first ten characters answered in UTC, a day ahead every evening west
// of Greenwich. These two helpers are the replacement for that slice and for a SQL
// `date(col)` bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDayStartStamp, stampLocalDay } from "../dist/repo/shared.js";

const NY = "America/New_York";

test("an evening stamp belongs to the local day, in either stored shape", () => {
  // 9 PM in New York on the 25th is 02:00 UTC on the 26th.
  assert.equal(stampLocalDay("2026-11-26 02:00:00", NY), "2026-11-25");
  assert.equal(stampLocalDay("2026-11-26T02:00:00.000Z", NY), "2026-11-25");
  assert.equal(stampLocalDay("2026-11-26 12:00:00", NY), "2026-11-26");
});

test("a bare date is kept as written, and nothing parseable is no day", () => {
  assert.equal(stampLocalDay("2026-11-25", NY), "2026-11-25");
  assert.equal(stampLocalDay("", NY), "");
  assert.equal(stampLocalDay(null, NY), "");
  assert.equal(stampLocalDay("soon", NY), "");
});

test("a local day starts at its own midnight, through a clock change", () => {
  assert.equal(localDayStartStamp("2026-11-25", NY), "2026-11-25 05:00:00");
  assert.equal(localDayStartStamp("2026-07-01", NY), "2026-07-01 04:00:00");
  // The clocks go back on 2026-11-01 and forward on 2026-03-08.
  assert.equal(localDayStartStamp("2026-11-01", NY), "2026-11-01 04:00:00");
  assert.equal(localDayStartStamp("2026-11-02", NY), "2026-11-02 05:00:00");
  assert.equal(localDayStartStamp("2026-03-08", NY), "2026-03-08 05:00:00");
  assert.equal(localDayStartStamp("2026-03-09", NY), "2026-03-09 04:00:00");
  assert.equal(localDayStartStamp("2026-11-25", "UTC"), "2026-11-25 00:00:00");
  assert.equal(localDayStartStamp("2026-11-25", "Asia/Tokyo"), "2026-11-24 15:00:00");
});

test("the start stamp and the day agree: the first second is in, the one before is out", () => {
  const start = localDayStartStamp("2026-11-25", NY);
  assert.equal(stampLocalDay(start, NY), "2026-11-25");
  assert.equal(stampLocalDay("2026-11-25 04:59:59", NY), "2026-11-24");
});
