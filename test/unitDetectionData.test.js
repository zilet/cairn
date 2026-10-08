// First-run unit detection refuses an install that holds data, so "Re-run first-time setup"
// cannot flip a long-used install's units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker, seedWeight, localDaysAgo } from "./_seed.js";
import { applyDetectedUnits, athleteUnits, installHasData, unitsSource } from "../dist/repo/settings.js";

test("an install with data refuses unit detection, even after Re-run first-time setup", () => {
  assert.equal(installHasData(), false, "a fresh install holds nothing");
  seedWeight(localDaysAgo(3), 180);
  assert.equal(installHasData(), true);
  repo.setSettings({ onboarded: true });
  // The Settings button: onboarded:false, with units never explicitly chosen.
  assert.equal(unitsSource(), null);
  repo.setSettings({ onboarded: false });
  assert.equal(unitsSource(), "explicit", "re-run stamps the units a used install reads in");
  const out = applyDetectedUnits({ locale: "de-DE", timeZone: "Europe/Berlin" });
  assert.equal(out.applied, false);
  assert.deepEqual({ ...athleteUnits() }, { distance: "km", weight: "lb" }, "lb stays lb");
});

test("detection also refuses on data alone (no stamp yet), and a truly empty re-run still detects", () => {
  seedHealthDoc("2026-06-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL" })]);
  assert.equal(unitsSource(), null);
  assert.equal(applyDetectedUnits({ locale: "de-DE", timeZone: "Europe/Berlin" }).applied, false);
  db.prepare("DELETE FROM health_documents").run();
  repo.setSettings({ onboarded: false });
  assert.equal(unitsSource(), null, "nothing to protect: no stamp");
  assert.equal(applyDetectedUnits({ locale: "de-DE", timeZone: "Europe/Berlin" }).applied, true);
});

test("a filled-in profile counts as data", () => {
  assert.equal(installHasData(), false);
  repo.setProfile({ name: "A. Athlete" });
  assert.equal(installHasData(), true);
});

