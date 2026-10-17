// Expected, non-defect outcomes must not fill diagnostic_events: an MCP GET probe's 405 and
// the Garmin write-back's "unchanged" no-op. Real failures stay visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../dist/db.js";
import { methodNotAllowed } from "../dist/mcp.js";
import { recordGarminExportOutcome } from "../dist/repo/garmin-export-telemetry.js";

function call(method) {
  const res = {
    code: 0,
    status(c) {
      this.code = c;
      return this;
    },
    json() {
      return this;
    },
  };
  methodNotAllowed({ method }, res);
  return res;
}

const events = (source) => db.prepare("SELECT level, kind, status FROM diagnostic_events WHERE source = ?").all(source);

test("an MCP GET probe still answers 405 but leaves no diagnostic row", () => {
  assert.equal(call("GET").code, 405);
  assert.equal(events("mcp").length, 0);
});

test("any other MCP 405 is recorded as info, never a warning", () => {
  assert.equal(call("DELETE").code, 405);
  const rows = events("mcp");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "info");
  assert.equal(rows[0].status, 405);
});

test("a garmin_export 'unchanged' skip writes no diagnostic row", () => {
  recordGarminExportOutcome(1, { ok: true, skipped: "unchanged" });
  assert.equal(events("worker").filter((r) => r.kind === "garmin_export").length, 0);
});

test("garmin_export successes and failures are still recorded", () => {
  recordGarminExportOutcome(1, { ok: true, exported_sets: 5, skipped_sets: 0, mode: "write" });
  recordGarminExportOutcome(1, { ok: true, skipped: "garmin_owns_sets" });
  recordGarminExportOutcome(1, { ok: false, error: "request timed out" });
  const rows = events("worker").filter((r) => r.kind === "garmin_export");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.level === "error").length, 1);
});
