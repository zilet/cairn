import { test } from "node:test";
import assert from "node:assert/strict";
import { seed } from "../dist/seed.js";
import * as repo from "../dist/repo.js";

test("the default seed opens on a coherent average male body near 20% tape body fat", () => {
  seed();
  const profile = repo.getProfile();
  const latest = repo.latestBodyMeasurement();
  const bodyFat = repo.getBodyIndicators(latest, profile).find((i) => i.key === "bodyfat");

  assert.equal(profile.sex, "male");
  assert.equal(profile.height_in, 70);
  assert.equal(profile.weight_lb, 185);
  assert.equal(latest.source, "seed");
  assert.deepEqual(
    [latest.neck_in, latest.shoulder_in, latest.chest_in, latest.waist_in, latest.hip_in, latest.thigh_in, latest.calf_in],
    [15.5, 46.2, 42.2, 35.8, 40.5, 24, 15.8]
  );
  assert.ok(bodyFat.value >= 19.5 && bodyFat.value <= 20.5, `expected ~20%, got ${bodyFat.value}`);
  assert.equal(repo.validateBodyMeasurementInput(latest).warnings.length, 0);
});
