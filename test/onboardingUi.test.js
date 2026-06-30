import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("first-run onboarding clears any shared save bar before entering the app", () => {
  const onboarding = readFileSync(new URL("../public/js/app-onboarding.js", import.meta.url), "utf8");
  assert.match(onboarding, /modal\.remove\(\);\s*hideSaveBar\(\);/, "onboarding exit hides the body-level save affordance");
});
