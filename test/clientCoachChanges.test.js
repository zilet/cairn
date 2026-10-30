import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/client/coach-meals-screen.ts"), "utf8");
// Ask → Changes is the lazy ask bundle's screen (renderCoach lives there, not in the eager shell).
const changes = readFileSync(join(root, "src/client/coach-changes-screen.ts"), "utf8");

test("Plan Changes is history-first and keeps manual reviews secondary", () => {
  assert.match(changes, /headerTitle\.textContent = "Changes"/);
  assert.match(changes, /Program change history/);
  assert.match(changes, /Meal-plan change history/);
  assert.match(changes, /<details class="changes-manual"/);
  assert.match(changes, /<summary class="lbl">Manual review<\/summary>/);
  assert.ok(changes.indexOf("Program change history") < changes.indexOf("Manual review"));
  assert.match(changes, /state\.planSeg = "coach"/, "the internal review route remains stable");
  assert.match(changes, /id="runbtn" class="pillbtn pill-accent"/);
  assert.match(changes, /Ask team to review program/);
  assert.match(changes, /id="mealbtn" class="pillbtn pill-accent"/);
  assert.match(changes, /Ask team to refresh meals/);
  assert.doesNotMatch(source, /function renderCoach\(/, "the eager shell no longer carries Changes");
  assert.doesNotMatch(changes, /ASK TEAM TO REVIEW PROGRAM|ASK TEAM TO REFRESH MEALS|class="logbtn"/);
});

test("Changes lives under Ask: no Plan seg bar, one quiet way back to Ask", () => {
  const coach = changes.slice(changes.indexOf("async function renderCoach"), changes.indexOf("wireHomeBack(view);\n  mountCoachChanges();"));
  assert.match(coach, /homeBackHtml\("ask", "Ask"\)/);
  assert.doesNotMatch(coach, /segBar\(|planSeg\(\)/);
  assert.match(changes, /wireHomeBack\(view\)/);
  // The shared helper lives in the shell and opens the named home's landing view.
  const shell = readFileSync(join(root, "src/client/ui-shell.ts"), "utf8");
  assert.match(shell, /function homeBackHtml\(home: ClientHomeName, label: string\): string/);
  assert.match(shell, /activateTab\(\(e\.currentTarget as HTMLElement \| null\)\?\.dataset\.homeBack \|\| "today"\)/);
  assert.doesNotMatch(source + changes, /wireSeg\(PLAN_HANDLERS\)/, "neither Fuel nor Changes wears the Plan bar");
});

test("meal-plan Hold and Undo use the durable decision rollback path", () => {
  // The revert POST itself is the shared decision-undo component's
  // (test/decisionUndo.test.js drives it); the meal-plan journal (the lazy meals
  // bundle's meal-journal-client.ts) mounts it for both actions.
  const journal = readFileSync(join(root, "src/client/meal-journal-client.ts"), "utf8");
  assert.match(journal, /CairnDecisionUndoController\.mount\(\s*host,/);
  assert.match(journal, /"meal-decision-hold": \{/);
  assert.match(journal, /"meal-decision-undo": \{/);
  assert.match(journal, /swrInvalidate\(MEALS_KEY\)/);
  assert.match(journal, /await repaintMealHistory\(\)/);
  assert.match(journal, /Undo recorded — showing your current meals/);
  assert.doesNotMatch(journal + source, /Put back the previous meal plan/);
  // The week menu and its past-weeks fold reach the journal through withBundle.
  assert.match(source, /withBundle\("meals", \(\) => CairnMealJournal\.paintMenu\(token, slot, peek\)\)/);
  // The week menu's page frame is the bundle's too: the eager screen only wires its hooks.
  assert.match(source, /view\.innerHTML = CairnMealJournal\.menuPageHtml\(\)/);
  for (const hook of ["data-mmenu-back", 'id="fuelHistory"', 'id="mealMenuSlot"', "‹ Intake"]) {
    assert.ok(journal.includes(hook), `menuPageHtml carries ${hook}`);
  }
  assert.match(source, /withBundle\("meals", \(\) => CairnMealJournal\.paintHistory\(token, slot, peek\)\)/);
});
