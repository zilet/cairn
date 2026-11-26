// A stamp with no zone is a UTC instant (SQLite datetime('now')), never local time:
// isoDateTime (brain/contract-utils.ts) must not move it by the process's UTC offset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoDateTime } from "../dist/brain/contract-utils.js";

test("a zone-less SQLite stamp is read as UTC whatever the process time zone", () => {
  assert.equal(isoDateTime("2026-11-24 01:26:13"), "2026-11-24T01:26:13.000Z");
  assert.equal(isoDateTime("2026-11-24T01:26:13"), "2026-11-24T01:26:13.000Z");
  assert.equal(isoDateTime("2026-11-24T01:26:13.250"), "2026-11-24T01:26:13.250Z");
});

test("a zoned stamp and a bare date keep their meaning; junk is null", () => {
  assert.equal(isoDateTime("2026-11-24T01:26:13.000Z"), "2026-11-24T01:26:13.000Z");
  assert.equal(isoDateTime("2026-11-23T20:26:13-05:00"), "2026-11-24T01:26:13.000Z");
  assert.equal(isoDateTime("2026-11-24"), "2026-11-24T00:00:00.000Z");
  assert.equal(isoDateTime("not a date"), null);
  assert.equal(isoDateTime(42), null);
});
