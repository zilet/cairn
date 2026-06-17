// Family-nutrition: structured allergies + dietary restrictions for the athlete
// AND each family member, and the household-diet awareness that flows into the
// meal prompts. The constitution bans scores/gates, but an ALLERGY is a safety
// HARD exclusion — so this suite pins that meals exclude declared allergens while
// staying quiet (renderHouseholdDiet -> "") when nothing is declared.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import * as prompt from "../dist/prompt.js";

beforeEach(() => {
  // Family roster + the profile's diet fields reset so each case starts clean.
  try { db.prepare("DELETE FROM family_members").run(); } catch {}
  try { db.prepare("UPDATE profile SET allergies = NULL, dietary_restrictions = NULL WHERE id = 1").run(); } catch {}
});

test("profile allergies + dietary_restrictions round-trip; undefined leaves intact, '' clears", () => {
  repo.setProfile({ allergies: "peanuts, shellfish", dietary_restrictions: "pescatarian" });
  let p = repo.getProfile();
  assert.equal(p.allergies, "peanuts, shellfish");
  assert.equal(p.dietary_restrictions, "pescatarian");

  // An unrelated update must NOT disturb the diet fields (undefined = leave intact).
  repo.setProfile({ age: 41 });
  p = repo.getProfile();
  assert.equal(p.allergies, "peanuts, shellfish");
  assert.equal(p.dietary_restrictions, "pescatarian");

  // Empty string clears (treated as "nothing declared" everywhere downstream).
  repo.setProfile({ allergies: "" });
  p = repo.getProfile();
  assert.ok(!p.allergies, "empty allergies reads as cleared");
  assert.equal(p.dietary_restrictions, "pescatarian", "other field untouched");
});

test("addFamily / updateFamily carry allergies + dietary_restrictions (clamped at 500)", () => {
  const f = repo.addFamily({ name: "Mara", relationship: "daughter", allergies: "eggs", dietary_restrictions: "mild spice only" });
  assert.equal(f.allergies, "eggs");
  assert.equal(f.dietary_restrictions, "mild spice only");

  const list = repo.listFamily();
  assert.equal(list.length, 1);
  assert.equal(list[0].allergies, "eggs");

  const u = repo.updateFamily(f.id, { allergies: "egg, dairy" });
  assert.equal(u.allergies, "egg, dairy");
  assert.equal(u.dietary_restrictions, "mild spice only", "unspecified field left intact");

  const big = repo.addFamily({ name: "X", allergies: "a".repeat(600) });
  assert.equal(big.allergies.length, 500, "allergies clamped to 500 chars");
});

test("meal-plan prompt hard-excludes the athlete's allergens, and is silent when none", () => {
  repo.setProfile({ allergies: "", dietary_restrictions: "" });
  let p = prompt.buildMealPlanPrompt();
  assert.ok(!/HARD EXCLUSION/.test(p), "no exclusion block when nothing is declared");

  repo.setProfile({ allergies: "peanuts" });
  p = prompt.buildMealPlanPrompt();
  assert.match(p, /HARD EXCLUSION/);
  assert.match(p, /peanuts/);
});

test("a family member's allergy surfaces as an optional household mod in the meal prompt", () => {
  repo.setProfile({ allergies: "", dietary_restrictions: "" });
  repo.addFamily({ name: "Mara", relationship: "daughter", birthdate: "2019-05-01", allergies: "eggs" });
  const p = prompt.buildMealPlanPrompt();
  assert.match(p, /HOUSEHOLD/);
  assert.match(p, /Mara/);
  assert.match(p, /eggs/);
});
