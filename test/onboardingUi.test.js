import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("leaving the first-run welcome clears any shared save bar before Today paints", () => {
  const welcome = readFileSync(new URL("../public/js/welcome-screen.js", import.meta.url), "utf8");
  assert.match(
    welcome,
    /hideSaveBar\(\);\s*activateTab\("today", \{ replace: true \}\)/,
    "the welcome's exit hides the body-level save affordance, then opens Today"
  );
});

test("the old form-sheet onboarding is gone: no questionnaire, no fields", () => {
  const boot = readFileSync(new URL("../public/js/app-onboarding.js", import.meta.url), "utf8");
  assert.doesNotMatch(boot, /CairnUiSheet|obSex|obAge|obDays|obGoal/);
  assert.match(boot, /openWelcome/);
});
