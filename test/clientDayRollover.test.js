// Client midnight/resume rollover (Track A / A3). state.logDate is set once at boot,
// so a PWA resumed after midnight keeps yesterday's date + Brief. The rollover
// decision is extracted as a pure function so the rule is deterministically tested
// without DOM, timers, or a real clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadRollover() {
  // The module block only touches globalThis/window (via typeof) + Object.assign at
  // load; document/window/setTimeout are referenced only inside the installer, which
  // we never call here. So a minimal context is enough.
  const context = { Date, Math, Object };
  vm.runInNewContext(readFileSync(join(root, "public/js/app-day-rollover.js"), "utf8"), context);
  return context;
}

test("dayRolloverTarget rolls only when the day changed and the user hasn't picked a date", () => {
  const { dayRolloverTarget } = loadRollover();
  assert.equal(typeof dayRolloverTarget, "function");

  // Still the same calendar day -> nothing to do.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-09", false), null);
  // The day genuinely rolled and the user hasn't steered -> roll to the new day.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-10", false), "2026-07-10");
  // The user manually picked a date -> never override it, even across a rollover.
  assert.equal(dayRolloverTarget("2026-07-09", "2026-07-10", true), null);
  // No measurable date -> no-op (defensive).
  assert.equal(dayRolloverTarget("2026-07-09", "", false), null);
});
