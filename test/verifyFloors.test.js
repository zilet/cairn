// The deterministic half of the self-critique verify pass.
//
// The numeric floors a draft has to clear — lean-safe calories, the protein
// target, fiber, a session's time budget — used to be questions asked of a model
// whose inputs already determined the answer. They are computed on the server
// now, and the model is handed the findings. These tests pin BOTH halves of that:
// the arithmetic itself, and the rule that the pre-check outranks the model's
// verdict, so an "ok:true" over a real calorie breach can never come out clean.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runVerify, validateMealPlanDraftForPersistence } from "../dist/coachOps.js";
import { buildPlanVerifyPrompt, buildSessionVerifyPrompt } from "../dist/prompt.js";
import { isMealPlanStructureResult } from "../dist/agent-contracts.js";
import {
  mealPlanFloorPrecheck,
  mealPlanFloorViolations,
  sessionFloorPrecheck,
  sessionFloorViolations,
} from "../dist/repo/verify-floors.js";
import { repo } from "./_seed.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const REFS = { kcalFloor: 2000, proteinFloor: 170, fiberFloor: 30 };

// One meal per day carrying the whole day, so a per-day override is one number.
function week({ kcal = 2200, protein = 170, fiber = 30, days = {} } = {}) {
  return {
    daily_kcal: kcal,
    daily_protein_g: protein,
    daily_fiber_g: fiber,
    days: WEEKDAYS.map((day) => {
      const override = days[day] ?? {};
      return {
        day,
        meals: [
          {
            name: "Tofu grain bowl",
            items: "tofu, brown rice, lentils, spinach",
            kcal: override.kcal ?? kcal,
            protein_g: override.protein_g ?? protein,
            carbs_g: 240,
            fat_g: 70,
            fiber_g: override.fiber_g ?? fiber,
          },
        ],
      };
    }),
    shopping: ["tofu", "brown rice", "lentils", "spinach"],
  };
}

const codes = (violations) => violations.map((v) => v.code);

// ------------------------------------------------------------ pure floor math

test("a clean week breaches no floor", () => {
  assert.deepEqual(mealPlanFloorViolations(week(), REFS), []);
});

test("a headline below the lean-safe floor is a violation carrying both numbers", () => {
  const found = mealPlanFloorViolations(week({ kcal: 1400 }), REFS);
  const headline = found.find((v) => v.code === "meal_plan_kcal_below_floor");
  assert.ok(headline, "the headline breach must be reported");
  assert.equal(headline.field, "daily_kcal");
  assert.equal(headline.observed, 1400);
  assert.equal(headline.floor, 2000);
  assert.match(headline.message, /1400 kcal\/day is below the lean-safe floor of 2000 kcal/);
  // Every day carries the same low number, so each day breaches too.
  assert.equal(found.filter((v) => v.code === "meal_plan_day_kcal_below_floor").length, 7);
});

test("one underfed day is caught on its own even when the headline is honest", () => {
  const found = mealPlanFloorViolations(week({ days: { Wed: { kcal: 1200 } } }), REFS);
  assert.deepEqual(codes(found), ["meal_plan_day_kcal_below_floor"]);
  assert.equal(found[0].day, "Wed");
  assert.equal(found[0].observed, 1200);
  assert.equal(found[0].floor, 2000);
});

test("protein under the target is a violation at the headline and on the day", () => {
  const found = mealPlanFloorViolations(week({ protein: 120 }), REFS);
  assert.ok(found.some((v) => v.code === "meal_plan_protein_below_target" && v.observed === 120));
  assert.equal(found.filter((v) => v.code === "meal_plan_day_protein_below_target").length, 7);

  // A thin profile carries no protein recommendation — absence is not a breach.
  assert.deepEqual(mealPlanFloorViolations(week({ protein: 120 }), { ...REFS, proteinFloor: null }), []);
});

test("fiber is checked against the 30 g floor and the 80% minimum day", () => {
  assert.deepEqual(codes(mealPlanFloorViolations(week({ fiber: 23 }), REFS)), [
    "meal_plan_fiber_below_floor",
    ...Array(7).fill("meal_plan_day_fiber_below_minimum"),
  ]);

  // A single low day fails the minimum without dragging the week's average under.
  const lowDayWeek = week({ fiber: 34, days: { Fri: { fiber_g: 12 } } });
  lowDayWeek.daily_fiber_g = 30;
  const oneLowDay = mealPlanFloorViolations(lowDayWeek, REFS);
  assert.deepEqual(codes(oneLowDay), ["meal_plan_day_fiber_below_minimum"]);
  assert.equal(oneLowDay[0].day, "Fri");
  assert.equal(oneLowDay[0].floor, 24);

  // The plan's own higher declared target raises the floor rather than replacing it.
  const declaredHigher = week({ fiber: 32 });
  declaredHigher.daily_fiber_g = 40;
  assert.ok(mealPlanFloorViolations(declaredHigher, REFS).some((v) => v.code === "meal_plan_fiber_below_floor"));
});

test("an untracked-fiber week is unverified, never deficient", () => {
  const untracked = week();
  for (const day of untracked.days) day.meals[0].fiber_g = null;
  assert.deepEqual(mealPlanFloorViolations(untracked, REFS), []);
});

test("a session over its time budget is the one numeric session floor", () => {
  const over = sessionFloorViolations({ est_minutes: 70 }, { minutes: 45 });
  assert.deepEqual(codes(over), ["session_over_time_budget"]);
  assert.equal(over[0].field, "est_minutes");
  assert.equal(over[0].observed, 70);
  assert.equal(over[0].floor, 45);

  assert.deepEqual(sessionFloorViolations({ est_minutes: 45 }, { minutes: 45 }), [], "at budget is not over budget");
  assert.deepEqual(sessionFloorViolations({ est_minutes: 90 }, {}), [], "no budget requested, nothing to check");
  assert.deepEqual(sessionFloorViolations({}, { minutes: 45 }), [], "no estimate is absence, not a breach");
});

// ------------------------------------------------------- the live pre-checks

test("the live meal pre-check reads the server's own goal floors", () => {
  repo.setProfile({ dietary_restrictions: null });
  const clean = mealPlanFloorPrecheck(week({ kcal: 4000, protein: 400 }));
  assert.deepEqual(clean.violations, [], "a plan far above every floor breaches nothing");

  const starved = mealPlanFloorPrecheck(week({ kcal: 900, protein: 20 }));
  assert.ok(starved.violations.some((v) => v.code === "meal_plan_kcal_below_floor"));
  // The universal 1500 kcal floor holds whatever the goal math says.
  assert.ok(starved.violations.every((v) => v.floor >= 1500 || v.code.includes("protein") || v.code.includes("fiber")));
});

test("a declared dietary restriction is what keeps the judgement turn alive", () => {
  repo.setProfile({ dietary_restrictions: "vegan" });
  const pre = mealPlanFloorPrecheck(week());
  assert.equal(pre.judgment_applies, true);
  assert.ok(pre.judgment_reasons.some((r) => /dietary restrictions/.test(r)));
});

test("a session pre-check treats a stated constraint as judgement material", () => {
  const withConstraint = sessionFloorPrecheck(
    { est_minutes: 40, items: [] },
    { minutes: 45, constraints: "no jumping" }
  );
  assert.deepEqual(withConstraint.violations, []);
  assert.equal(withConstraint.judgment_applies, true);

  const bare = sessionFloorPrecheck({ est_minutes: 40, items: [] }, { minutes: 45 });
  assert.deepEqual(bare.violations, []);
  assert.equal(
    bare.judgment_applies,
    false,
    "nothing numeric breached and nothing to judge — the agent turn is skippable"
  );
});

// ------------------------------------------------------------- the prompt

test("the verify prompt hands over the server's findings instead of asking for arithmetic", () => {
  const violations = mealPlanFloorViolations(week({ kcal: 1400 }), REFS);
  const prompt = buildPlanVerifyPrompt(week({ kcal: 1400 }), violations);
  assert.match(prompt, /SERVER FLOOR CHECK: \d+ BREACHES/);
  assert.match(prompt, /meal_plan_kcal_below_floor/);
  assert.match(prompt, /Do NOT\s+recompute the listed numbers/);
  assert.doesNotMatch(prompt, /NEVER below ~1500 kcal regardless of math/);

  const clean = buildPlanVerifyPrompt(week(), []);
  assert.match(clean, /SERVER FLOOR CHECK: PASSED/);

  // The session's time budget is a computed finding now, not a prose instruction.
  const session = buildSessionVerifyPrompt({ name: "Lower body", items: [] }, { minutes: 45 }, []);
  assert.doesNotMatch(session, /TIME BUDGET/);
  assert.match(session, /never program loaded movement through an injured area/);
});

// --------------------------------------------- the pre-check outranks a model

// A one-off agents.json whose single agent answers with `body` for any prompt.
function fakeAgent(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-verify-agent-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [name]: {
        command: "sh",
        args: ["-c", `printf '%s' ${JSON.stringify(body)}`],
        input: "arg",
        description: "test double",
        env_required: [],
        capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      },
    })
  );
  return file;
}

async function withAgent(name, body, run) {
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = fakeAgent(name, body);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
  }
}

const planSane = (m) => isMealPlanStructureResult(m);

test("an ok:true verdict over a calorie breach never comes back as a clean check", async () => {
  repo.setProfile({ dietary_restrictions: null });
  const breached = week({ kcal: 1200, protein: 60 });
  const pre = mealPlanFloorPrecheck(breached);
  assert.ok(pre.violations.length, "fixture must actually breach a floor");

  const outcome = await withAgent("dishonest", '{"ok":true,"violations":[],"fixed_draft":null}', () =>
    runVerify(
      "dishonest",
      breached,
      (d) => mealPlanFloorPrecheck(d),
      (d, violations) => buildPlanVerifyPrompt(d, violations),
      planSane,
      "meal_plan_verify"
    )
  );

  assert.equal(outcome.verified.checked, true);
  assert.equal(outcome.verified.by, "agent");
  assert.ok(outcome.verified.unresolved?.length, "the unrepaired breach must be surfaced, not swallowed");
  assert.match(outcome.verified.unresolved.join(" "), /below the lean-safe floor/);
  assert.deepEqual(outcome.verified.adjustments, [], "nothing was actually adjusted");
  assert.equal(outcome.draft.daily_kcal, 1200, "an unrepaired draft is returned unchanged, not laundered");

  // And the authoritative write gate still refuses it outright.
  const gate = validateMealPlanDraftForPersistence(outcome.draft);
  assert.equal(gate.ok, false);
});

test("a verify with nothing to compute and nothing to judge skips the agent entirely", async () => {
  // The fake agent would return unparseable garbage, so reaching it at all would
  // fail open with verified:null. A `by:"server"` outcome proves it was skipped.
  const outcome = await withAgent("never-called", "not json at all", () =>
    runVerify(
      "never-called",
      { name: "Lower body", est_minutes: 40, items: [] },
      (d) => sessionFloorPrecheck(d, { minutes: 45 }),
      (d, violations) => buildSessionVerifyPrompt(d, { minutes: 45 }, violations),
      () => true,
      "session_verify"
    )
  );
  assert.deepEqual(outcome.verified, { checked: true, adjustments: [], by: "server" });
});

test("a dead verifier fails open but keeps the floors the server already computed", async () => {
  const draft = { name: "Lower body", est_minutes: 70, items: [] };
  const outcome = await withAgent("broken", "not json at all", () =>
    runVerify(
      "broken",
      draft,
      (d) => sessionFloorPrecheck(d, { minutes: 45 }),
      (d, violations) => buildSessionVerifyPrompt(d, { minutes: 45 }, violations),
      () => true,
      "session_verify"
    )
  );
  assert.equal(outcome.draft, draft, "fail-open still ships the original draft");
  assert.equal(outcome.verified.checked, false, "an unusable verdict is never reported as checked");
  assert.equal(outcome.verified.by, "server");
  assert.deepEqual(outcome.verified.adjustments, []);
  assert.match(outcome.verified.unresolved.join(" "), /45-minute budget/);
});

test("a dead verifier with nothing to report stays silent", async () => {
  const draft = { name: "Lower body", est_minutes: 40, items: [] };
  const outcome = await withAgent("broken", "not json at all", () =>
    runVerify(
      "broken",
      draft,
      // Judgement applies (so the turn runs and dies), but no floor was breached,
      // so the server has nothing of its own to say.
      (d) => sessionFloorPrecheck(d, { minutes: 45, constraints: "no jumping" }),
      (d, violations) => buildSessionVerifyPrompt(d, { minutes: 45 }, violations),
      () => true,
      "session_verify"
    )
  );
  assert.equal(outcome.verified, null);
  assert.equal(outcome.draft, draft);
});

// ------------------------------------------------- the skip gate's own sources

test("an allergy alone keeps the meal judgement turn alive", () => {
  repo.setProfile({ dietary_restrictions: null, allergies: "peanuts" });
  const pre = mealPlanFloorPrecheck(week());
  assert.deepEqual(pre.violations, []);
  assert.equal(pre.judgment_applies, true, "an allergy is exactly what only a model can read against food");
  assert.ok(pre.judgment_reasons.some((r) => /allerg/i.test(r)));
});

test("an active health directive alone keeps both judgement turns alive", () => {
  repo.setProfile({ dietary_restrictions: null, allergies: null });
  repo.reconcileDirectives("markers", [
    {
      domain: "nutrition",
      marker: "ApoB",
      directive: "Keep saturated fat low.",
      rationale: "ApoB is above the optimal band.",
    },
  ]);
  assert.ok(repo.listActiveDirectives().length, "fixture must actually leave a directive active");

  const meal = mealPlanFloorPrecheck(week());
  assert.equal(meal.judgment_applies, true);
  assert.ok(meal.judgment_reasons.some((r) => /directive/.test(r)));

  const session = sessionFloorPrecheck({ est_minutes: 40, items: [] }, { minutes: 45 });
  assert.deepEqual(session.violations, []);
  assert.equal(session.judgment_applies, true, "the prompt asks about directives, so the gate must too");
  assert.ok(session.judgment_reasons.some((r) => /directive/.test(r)));
});

// ------------------------------------------- the meal prompt carries its inputs

test("the meal verify prompt carries the declarations its judgement needs", () => {
  repo.setProfile({ dietary_restrictions: "pescatarian", allergies: "peanuts" });
  repo.setSettings({ meal_prefs: "breakfast at 6am, trains fasted" });

  const prompt = buildPlanVerifyPrompt(week(), [], { dietary_instruction: "more one-pan dinners" });
  assert.match(prompt, /DECLARED CONSTRAINTS/);
  assert.match(prompt, /pescatarian/);
  assert.match(prompt, /breakfast at 6am/);
  assert.match(prompt, /more one-pan dinners/);
  // Allergies arrive through the DATA projection's profile, not a second read.
  assert.match(prompt, /DATA \(allergies, restrictions, household/);
  assert.match(prompt, /peanuts/);
});
