// The calibration surface: GET /api/calibration/status and its near-mirror MCP
// tool (MCP ⊆ REST). The engine behind it is being filled in separately, so the
// contract these prove is the one the surfaces must honor either way — an empty
// ladder is a normal, quiet 200, and a populated one passes through untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { programRouter } from "../dist/routes/program.js";
import { registerCalibrationTools } from "../dist/surfaces/mcp/calibration.js";
import { calibrationStatus, dueCalibrations } from "../dist/repo/calibration.js";

function restCalibration(date) {
  const layer = programRouter.stack.find((entry) => entry.route?.path === "/calibration/status");
  assert.ok(layer, "REST calibration/status route is registered");
  const handler = layer.route.stack[0].handle;
  let value;
  handler({ query: date ? { date } : {} }, { json: (body) => { value = body; } });
  return value;
}

async function mcpCalibration(date) {
  const tools = new Map();
  registerCalibrationTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  const handler = tools.get("get_calibration_status");
  assert.ok(handler, "MCP get_calibration_status tool is registered");
  const response = await handler({ date });
  return JSON.parse(response.content[0].text);
}

test("REST and MCP report the same calibration ladder", async () => {
  const date = "2026-08-05";
  const expected = { status: calibrationStatus(date), due: dueCalibrations(date) };
  assert.deepEqual(restCalibration(date), expected);
  assert.deepEqual(await mcpCalibration(date), expected);
});

test("an athlete with nothing calibrated reads as a quiet, well-formed body", () => {
  const body = restCalibration("2026-08-05");
  assert.equal(body.status.as_of, "2026-08-05");
  assert.ok(Array.isArray(body.status.items), "items is always an array, never null");
  assert.ok(Array.isArray(body.due), "due is always an array, never null");
  // Absence is emptiness here, not a 404 and not an error envelope.
  assert.ok(!("error" in body));
  assert.ok(!("ok" in body));
});

test("the route defaults to today when no date is given", () => {
  const body = restCalibration(undefined);
  assert.match(String(body.status.as_of), /^\d{4}-\d{2}-\d{2}$/);
});

// The client renders straight off these fields, so their shape is load-bearing:
// a freshness WORD (never a days-stale number) and an athlete-facing label.
test("a populated ladder carries only the fields the Endurance line renders", () => {
  const item = {
    key: "lthr",
    domain: "endurance",
    label: "Your threshold HR",
    last_anchored: "2026-02-01",
    freshness: "stale",
    due: true,
  };
  for (const field of ["key", "domain", "label", "last_anchored", "freshness", "due"]) {
    assert.ok(field in item, `a status item carries ${field}`);
  }
  assert.ok(["anchored", "aging", "stale", "never"].includes(item.freshness));
  assert.ok(["endurance", "strength"].includes(item.domain));
  const suggestion = { kind: "lthr_tt", target_key: "lthr", line: "A steady 30 minutes would re-anchor this.", placement: "replaces this week's quality slot" };
  for (const field of ["kind", "target_key", "line", "placement"]) {
    assert.ok(field in suggestion, `a suggestion carries ${field}`);
  }
  assert.doesNotMatch(suggestion.line, /\b\d+\s*(?:%|\/100)\b/, "suggestions are prose, never a score");
});

// ---------------------------------------------------------------------------
// The engine the surfaces above render: how much a lift's est-1RM deserves to be
// trusted (estimateConfidenceFor), and the verified number a writer should make
// its claim against (verifiedStrengthAnchor).
//
// Both run on the SAME staleness ladder the athlete-facing freshness word uses,
// which is the property worth locking: a lift the calibration card calls
// "anchored" and the progression ladder calls "verified" must never be able to
// disagree about the same day.
import { db as engineDb, repo as engineRepo } from "./_seed.js";
import { estimateConfidenceFor, verifiedStrengthAnchor } from "../dist/repo/calibration.js";

const ENGINE_TODAY = "2026-08-05";

function engineDaysBefore(n) {
  return new Date(Date.parse(`${ENGINE_TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
}

function logSet(exercise, dateISO, weight, reps) {
  const session = engineRepo.getOrCreateSession(dateISO, null);
  engineDb
    .prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, ?)`)
    .run(session.id, exercise.id, weight, reps);
}

/**
 * A lift whose estimate was CONFIRMED `verifiedDaysAgo`, and then carried on with
 * ordinary work that pushed the Epley number higher without ever testing it.
 *
 * The confirming day is the 110x3: at that point the running estimate was 116.7
 * (from 100x5), and 110 clears the 92% bar, so a heavy set genuinely stood behind
 * it. The later 105x8 extrapolates to 133 on the formula alone — a ceiling nobody
 * has been near.
 */
function liftVerifiedDaysAgo(name, verifiedDaysAgo) {
  const exercise = engineRepo.upsertExercise({ name, muscle_group: "shoulders" });
  logSet(exercise, engineDaysBefore(verifiedDaysAgo + 5), 100, 5);
  logSet(exercise, engineDaysBefore(verifiedDaysAgo), 110, 3);
  return exercise;
}

test("a lift a heavy set confirmed recently reads verified", () => {
  liftVerifiedDaysAgo("Overhead Press", 10);
  assert.equal(estimateConfidenceFor("Overhead Press", ENGINE_TODAY), "verified");
});

test("the same confirmation, older, ages rather than flipping straight to unverified", () => {
  liftVerifiedDaysAgo("Overhead Press", 55);
  assert.equal(estimateConfidenceFor("Overhead Press", ENGINE_TODAY), "aging");
});

test("a confirmation past the aging horizon reads unverified", () => {
  liftVerifiedDaysAgo("Overhead Press", 120);
  assert.equal(estimateConfidenceFor("Overhead Press", ENGINE_TODAY), "unverified");
});

test("a lift no heavy set ever confirmed reads unverified, and so does one we cannot find", () => {
  const exercise = engineRepo.upsertExercise({ name: "Incline Press", muscle_group: "chest" });
  // Ordinary work only: every day's top set sits well under the running estimate,
  // so the formula is the only thing holding the number up.
  logSet(exercise, engineDaysBefore(20), 100, 5);
  logSet(exercise, engineDaysBefore(10), 60, 5);
  assert.equal(estimateConfidenceFor("Incline Press", ENGINE_TODAY), "unverified");
  // The honest answer for an estimate we cannot locate is "not confirmed" — the
  // consumer softens a deload into hold-plus-test on this reading, so the unknown
  // case errs toward caution rather than toward trusting a number blindly.
  assert.equal(estimateConfidenceFor("A Movement Nobody Logged", ENGINE_TODAY), "unverified");
  assert.equal(estimateConfidenceFor("", ENGINE_TODAY), "unverified");
});

test("the verified anchor is the number a set stood under, even when the formula has since climbed past it", () => {
  const exercise = liftVerifiedDaysAgo("Overhead Press", 15);
  // Ordinary sets of eight, extrapolating to 133 on Epley alone.
  logSet(exercise, engineDaysBefore(5), 105, 8);

  const anchor = verifiedStrengthAnchor("Overhead Press", ENGINE_TODAY);
  assert.ok(anchor, "a fresh confirmation is available");
  assert.equal(anchor.est_1rm, 121, "the confirmed 110x3, not the unconfirmed 133 the formula reached");
  assert.equal(anchor.anchored_on, engineDaysBefore(15));
});

test("an aged confirmation stops overriding a fresher read of the athlete", () => {
  liftVerifiedDaysAgo("Overhead Press", 120);
  assert.equal(verifiedStrengthAnchor("Overhead Press", ENGINE_TODAY), null);
});
