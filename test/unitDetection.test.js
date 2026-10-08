// A fresh install's units start from the device (src/repo/unit-system.ts): the PWA sends
// its locale and zone once (POST /api/settings/units/detect), and a never-onboarded install
// still on the registry defaults adopts what they point at. A guess only — an explicit
// choice in Settings is never overridden, a detection never re-runs, and an install that
// onboarded before the hint existed keeps the units it reads in. Offline, no agents.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, repo } from "./_seed.js";
import { detectUnits, lengthUnitOf, localeRegion, unitSystemOf } from "../dist/repo/unit-system.js";
import { applyDetectedUnits, athleteUnits, setSettings, unitsSource } from "../dist/repo/settings.js";
import { operatorRouter } from "../dist/routes/operator.js";

const US = { distance: "mi", weight: "lb" };
const GB = { distance: "mi", weight: "kg" };
const METRIC = { distance: "km", weight: "kg" };

test("localeRegion reads the region subtag, past a script, and Burmese alone", () => {
  assert.equal(localeRegion("en-GB"), "GB");
  assert.equal(localeRegion("en_US"), "US");
  assert.equal(localeRegion("zh-Hant-TW"), "TW");
  assert.equal(localeRegion("es-419"), "419");
  assert.equal(localeRegion("de"), null);
  assert.equal(localeRegion("my"), "MM");
  assert.equal(localeRegion(""), null);
  assert.equal(localeRegion(undefined), null);
});

test("detectUnits: the zone leads, the locale decides without one", () => {
  // Locale alone.
  assert.deepEqual(detectUnits({ locale: "en-US" }), US);
  assert.deepEqual(detectUnits({ locale: "en-LR" }), US);
  assert.deepEqual(detectUnits({ locale: "my" }), US);
  assert.deepEqual(detectUnits({ locale: "en-GB" }), GB, "UK: miles on the road, kilograms on the scale");
  assert.deepEqual(detectUnits({ locale: "de-DE" }), METRIC);
  assert.deepEqual(detectUnits({ locale: "fr-CA" }), METRIC);
  // A European on an en-US browser: the clock says where they are.
  assert.deepEqual(detectUnits({ locale: "en-US", timeZone: "Europe/Berlin" }), METRIC);
  assert.deepEqual(detectUnits({ locale: "en-US", timeZone: "Europe/London" }), GB);
  assert.deepEqual(detectUnits({ locale: "en", timeZone: "Europe/Paris" }), METRIC);
  // US zones: imperial, unless the locale positively names another country (an expat).
  assert.deepEqual(detectUnits({ locale: "en-US", timeZone: "America/Chicago" }), US);
  assert.deepEqual(detectUnits({ locale: "en", timeZone: "America/Indiana/Indianapolis" }), US);
  assert.deepEqual(detectUnits({ timeZone: "Pacific/Honolulu" }), US);
  assert.deepEqual(detectUnits({ locale: "de-DE", timeZone: "America/New_York" }), METRIC);
  // The Americas are not all the US.
  assert.deepEqual(detectUnits({ locale: "en-US", timeZone: "America/Toronto" }), METRIC);
  assert.deepEqual(detectUnits({ locale: "es-MX", timeZone: "America/Mexico_City" }), METRIC);
  // A zone that names no country defers to the locale; nothing at all is no guess.
  assert.deepEqual(detectUnits({ locale: "en-US", timeZone: "UTC" }), US);
  assert.deepEqual(detectUnits({ locale: "nl-NL", timeZone: "Etc/GMT+1" }), METRIC);
  assert.equal(detectUnits({ locale: "en", timeZone: "UTC" }), null);
  assert.equal(detectUnits({}), null);
});

test("unitSystemOf / lengthUnitOf are weight-led: kg ⇒ metric/cm, lb ⇒ us/in", () => {
  assert.equal(unitSystemOf({ weight: "kg" }), "metric");
  assert.equal(unitSystemOf({ weight: "lb" }), "us");
  assert.equal(lengthUnitOf({ distance: "mi", weight: "kg" }), "cm");
  assert.equal(lengthUnitOf({ distance: "km", weight: "lb" }), "in");
});

test("a fresh install adopts the detected units once, and says so", () => {
  assert.equal(unitsSource(), null);
  assert.deepEqual({ ...athleteUnits() }, { distance: "km", weight: "lb" }, "registry defaults before the hint");
  const out = applyDetectedUnits({ locale: "en-US", timeZone: "Europe/Madrid" });
  assert.equal(out.applied, true);
  assert.deepEqual({ ...out.units }, METRIC);
  assert.equal(out.source, "detected");
  assert.deepEqual({ ...athleteUnits() }, METRIC);
  // A second hint (another device) never re-runs it.
  const again = applyDetectedUnits({ locale: "en-US", timeZone: "America/Denver" });
  assert.equal(again.applied, false);
  assert.deepEqual({ ...athleteUnits() }, METRIC);
});

test("a hint with no signal leaves the install pending, so a later boot can still try", () => {
  const out = applyDetectedUnits({ locale: "en", timeZone: "UTC" });
  assert.equal(out.applied, false);
  assert.equal(unitsSource(), null);
  assert.equal(applyDetectedUnits({ locale: "en-GB" }).applied, true);
  assert.deepEqual({ ...athleteUnits() }, GB);
});

test("an explicit Settings choice is never overridden by detection", () => {
  setSettings({ run_units: "km", weight_units: "lb" }); // the defaults, but chosen
  assert.equal(unitsSource(), "explicit");
  const out = applyDetectedUnits({ locale: "de-DE", timeZone: "Europe/Berlin" });
  assert.equal(out.applied, false);
  assert.deepEqual({ ...athleteUnits() }, { distance: "km", weight: "lb" });
  // ...and a later change of mind is simply saved.
  setSettings({ weight_units: "kg" });
  assert.equal(athleteUnits().weight, "kg");
});

test("a choice after detection is the person's; detection does not return", () => {
  applyDetectedUnits({ locale: "en-US", timeZone: "America/Chicago" });
  assert.deepEqual({ ...athleteUnits() }, US);
  setSettings({ run_units: "km", weight_units: "kg" });
  assert.equal(unitsSource(), "explicit");
  applyDetectedUnits({ locale: "en-US", timeZone: "America/Chicago" });
  assert.deepEqual({ ...athleteUnits() }, METRIC);
});

test("an install that onboarded before the hint keeps the units it reads in", () => {
  repo.getSettings();
  db.prepare(`UPDATE settings SET onboarded = 1 WHERE id = 1`).run();
  const out = applyDetectedUnits({ locale: "de-DE", timeZone: "Europe/Berlin" });
  assert.equal(out.applied, false);
  assert.deepEqual({ ...athleteUnits() }, { distance: "km", weight: "lb" });
});

test("an install whose units already differ from the defaults is never touched", () => {
  repo.getSettings();
  db.prepare(`UPDATE settings SET weight_units = 'kg' WHERE id = 1`).run();
  assert.equal(applyDetectedUnits({ locale: "en-US", timeZone: "America/Chicago" }).applied, false);
  assert.deepEqual({ ...athleteUnits() }, { distance: "km", weight: "kg" });
});

let server = null;
after(() => server?.close());

async function call(method, path, body) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use("/api", operatorRouter);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("REST: settings carries units_source; the detect door applies once; a PUT makes units explicit", async () => {
  assert.equal((await call("GET", "/settings")).settings.units_source, null);
  const detected = await call("POST", "/settings/units/detect", { locale: "en-US", time_zone: "Europe/Rome" });
  assert.equal(detected.applied, true);
  assert.equal(detected.settings.run_units, "km");
  assert.equal(detected.settings.weight_units, "kg");
  assert.equal(detected.settings.units_source, "detected");
  const put = await call("PUT", "/settings", { run_units: "mi", weight_units: "kg" });
  assert.equal(put.settings.units_source, "explicit");
  const noop = await call("POST", "/settings/units/detect", { locale: "en-US", time_zone: "America/Chicago" });
  assert.equal(noop.applied, false);
  assert.equal(noop.settings.run_units, "mi");
  assert.equal(noop.settings.weight_units, "kg");
});

test("REST: a settings save that sends no unit leaves detection pending", async () => {
  await call("PUT", "/settings", { meal_plan_auto_draft: true });
  assert.equal((await call("GET", "/settings")).settings.units_source, null);
});
